import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimSpaces = (text: string): string => text.replace(/^ +| +$/g, '');

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { oldPath: string; newPath: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

interface FileLines {
  lines: string[];
  break: string;
  final: boolean;
}

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noBreak?: boolean;
}

function fileLines(text: string): FileLines {
  const firstLF = text.indexOf('\n');
  const lineBreak = firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(lineBreak);
  const final = text !== '' && text.endsWith(lineBreak);
  if (final) lines.pop();
  return { lines, break: lineBreak, final };
}

function fileText(file: FileLines): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.break) + (file.final ? file.break : '');
}

function checkPaths(paths: (string | null)[]): void {
  for (const path of paths) {
    if (path !== null && !safe(path)) throw new Fail('unsafe', path);
  }
}

function requireFile(tree: Tree, path: string): string {
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  return text;
}

function normalizeLine(line: string, tier: number): string {
  if (tier === 0) return line;
  const trimmed = line.replace(/[ \t]+$/g, '');
  return tier === 1 ? trimmed : trimmed.replace(/^[ \t]+/g, '');
}

function occurrences(lines: string[], oldLines: string[], strict: boolean, cursor = 0, eof = false): { positions: number[]; tier: number } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const wanted = oldLines.map((line) => normalizeLine(line, tier));
    const positions: number[] = [];
    const last = lines.length - oldLines.length;
    const start = eof ? Math.max(cursor, last) : cursor;
    for (let position = start; position <= last; position += 1) {
      if (wanted.every((line, offset) => normalizeLine(lines[position + offset]!, tier) === line)) positions.push(position);
    }
    if (positions.length > 0) return { positions, tier };
  }
  return { positions: [], tier: 0 };
}

function oldLinesOf(body: BodyLine[]): string[] {
  return body.filter((line) => line.kind !== '+').map((line) => line.text);
}

function replacement(body: BodyLine[], matched: string[], oldLines: string[], tier: number): string[] {
  const fileIndent = matched[0]?.match(/^[ \t]*/)?.[0] ?? '';
  const patchIndent = oldLines[0]?.match(/^[ \t]*/)?.[0] ?? '';
  const output: string[] = [];
  let oldOffset = 0;
  for (const line of body) {
    if (line.kind === ' ') output.push(matched[oldOffset]!);
    else if (line.kind === '+') {
      output.push(tier === 2 && !blank(line.text) && line.text.startsWith(patchIndent)
        ? fileIndent + line.text.slice(patchIndent.length)
        : line.text);
    }
    if (line.kind !== '+') oldOffset += 1;
  }
  return output;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath: string | null = null;
  for (let search = 0; search < lines.length; search += 1) {
    if (lines[search]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path = previousPath;
    for (let position = search - 1; position > previousEnd; position -= 1) {
      const candidate = lines[position]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    if (path === null) throw new Exit2(`error: parse ${search + 1}`);
    let separator = search + 1;
    while (separator < lines.length && lines[separator]!.trimEnd() !== '=======') separator += 1;
    let end = separator + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (separator >= lines.length || end >= lines.length) throw new Exit2(`error: parse ${search + 1}`);
    const oldLines = lines.slice(search + 1, separator);
    const newLines = lines.slice(separator + 1, end);
    const editPath = path;
    edits.push((tree) => {
      checkPaths([editPath]);
      if (oldLines.length === 0) {
        if (tree.get(editPath) !== null) throw new Fail('exists', editPath);
        tree.now.set(editPath, fileText({ lines: newLines, break: '\n', final: true }));
        return;
      }
      const file = fileLines(requireFile(tree, editPath));
      const match = occurrences(file.lines, oldLines, strict);
      if (match.positions.length === 0) throw new Fail('no-match', editPath);
      if (match.positions.length > 1) throw new Fail('ambiguous', editPath);
      const position = match.positions[0]!;
      const body: BodyLine[] = newLines.map((text) => ({ kind: '+', text }));
      const newText = replacement(body, file.lines.slice(position, position + oldLines.length), oldLines, match.tier);
      file.lines.splice(position, oldLines.length, ...newText);
      tree.now.set(editPath, fileText(file));
    });
    previousPath = path;
    previousEnd = end;
    search = end;
  }
  return edits;
}

interface UnifiedHunk {
  start: number;
  body: BodyLine[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  renameOld?: string;
  renameNew?: string;
  hasPair: boolean;
  create: boolean;
  delete: boolean;
  hunks: UnifiedHunk[];
}

function unifiedPath(text: string): string | null {
  const path = trimSpaces(text.split('\t')[0]!);
  if (path === '/dev/null') return null;
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const oldPath = !section.hasPair && section.renameOld !== undefined ? section.renameOld : section.oldPath;
  const newPath = !section.hasPair && section.renameNew !== undefined ? section.renameNew : section.newPath;
  return (tree) => {
    checkPaths([oldPath, newPath]);
    if (section.create || oldPath === null) {
      const path = newPath ?? '';
      checkPaths([path]);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const added = section.hunks.flatMap((hunk) => hunk.body.filter((line) => line.kind === '+'));
      tree.now.set(path, fileText({ lines: added.map((line) => line.text), break: '\n', final: !added.at(-1)?.noBreak }));
      return;
    }
    const before = requireFile(tree, oldPath);
    if (section.delete || newPath === null) {
      tree.now.set(oldPath, null);
      return;
    }
    if (newPath !== oldPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const file = fileLines(before);
    let delta = 0;
    for (const hunk of section.hunks) {
      const oldLines = oldLinesOf(hunk.body);
      let position: number;
      let tier = 0;
      if (oldLines.length === 0) position = Math.max(0, Math.min(file.lines.length, hunk.start + delta));
      else {
        const match = occurrences(file.lines, oldLines, strict);
        if (match.positions.length === 0) throw new Fail('no-match', oldPath);
        tier = match.tier;
        const target = hunk.start - 1 + delta;
        position = match.positions.reduce((best, candidate) => Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best);
      }
      const reachesEnd = position + oldLines.length === file.lines.length;
      const newLines = replacement(hunk.body, file.lines.slice(position, position + oldLines.length), oldLines, tier);
      if (reachesEnd) file.final = !hunk.body.filter((line) => line.kind !== '-').at(-1)?.noBreak;
      file.lines.splice(position, oldLines.length, ...newLines);
      delta += newLines.length - oldLines.length;
    }
    tree.now.set(newPath, fileText(file));
    if (newPath !== oldPath) {
      tree.now.set(oldPath, null);
      tree.moves.push({ oldPath, newPath });
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  const pairAt = (position: number): boolean => (lines[position] ?? '').startsWith('--- ') && (lines[position + 1] ?? '').startsWith('+++ ');
  const startSection = (oldPath: string | null, newPath: string | null): UnifiedSection => {
    const next: UnifiedSection = { oldPath, newPath, hasPair: false, create: false, delete: false, hunks: [] };
    sections.push(next);
    return next;
  };
  for (let position = 0; position < lines.length; position += 1) {
    const line = lines[position]!;
    if (/^diff --git(?:\s|$)/.test(line)) {
      const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (paths === null) throw new Exit2(`error: parse ${position + 1}`);
      section = startSection(paths[1]!, paths[2]!);
    } else if (pairAt(position)) {
      if (section === null || section.hasPair || section.hunks.length > 0) section = startSection(null, null);
      section.oldPath = unifiedPath(line.slice(4));
      section.newPath = unifiedPath(lines[position + 1]!.slice(4));
      section.hasPair = true;
      position += 1;
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(line);
      if (section === null || header === null) throw new Exit2(`error: parse ${position + 1}`);
      const rawBody: string[] = [];
      let next = position + 1;
      while (next < lines.length && !lines[next]!.startsWith('diff --git ') && !pairAt(next)
        && (lines[next] === '' || /^[ +\-\\]/.test(lines[next]!))) {
        rawBody.push(lines[next]!);
        next += 1;
      }
      while (rawBody.at(-1) === '') rawBody.pop();
      const body: BodyLine[] = [];
      for (const raw of rawBody) {
        if (raw.startsWith('\\')) {
          if (body.length > 0) body[body.length - 1]!.noBreak = true;
        } else body.push({ kind: raw === '' ? ' ' : raw[0] as BodyLine['kind'], text: raw === '' ? '' : raw.slice(1) });
      }
      section.hunks.push({ start: Number(header[1]), body });
      position = next - 1;
    } else if (section !== null && section.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${position + 2}`);
      if (line.startsWith('rename from ')) section.renameOld = trimSpaces(line.slice(12));
      else if (line.startsWith('rename to ')) section.renameNew = trimSpaces(line.slice(10));
      else if (line.startsWith('new file mode')) section.create = true;
      else if (line.startsWith('deleted file mode')) section.delete = true;
    }
  }
  return sections.map((entry) => unifiedEdit(entry, strict));
}

interface V4AChunk {
  anchor: string;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const sectionHeader = /^\*\*\* (Add|Delete|Update) File: /;
  for (let position = first + 1; position < last; position += 1) {
    if (blank(lines[position]!)) continue;
    const header = sectionHeader.exec(lines[position]!);
    if (header === null) throw new Exit2(`error: parse ${position + 1}`);
    const sectionLine = position;
    const path = trimSpaces(lines[position]!.slice(header[0].length));
    let end = position + 1;
    while (end < last && !sectionHeader.test(lines[end]!)) end += 1;
    let bodyEnd = end;
    while (bodyEnd > position + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    if (header[1] === 'Add') {
      const added: string[] = [];
      for (let bodyPosition = position + 1; bodyPosition < bodyEnd; bodyPosition += 1) {
        const line = lines[bodyPosition]!;
        if (line !== '' && !line.startsWith('+')) throw new Exit2(`error: parse ${bodyPosition + 1}`);
        added.push(line === '' ? '' : line.slice(1));
      }
      edits.push((tree) => {
        checkPaths([path]);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileText({ lines: added, break: '\n', final: true }));
      });
    } else if (header[1] === 'Delete') {
      if (bodyEnd > position + 1) throw new Exit2(`error: parse ${position + 2}`);
      edits.push((tree) => {
        checkPaths([path]);
        requireFile(tree, path);
        tree.now.set(path, null);
      });
    } else {
      let bodyPosition = position + 1;
      let newPath: string | null = null;
      if (bodyPosition < bodyEnd && lines[bodyPosition]!.startsWith('*** Move to: ')) {
        newPath = trimSpaces(lines[bodyPosition]!.slice(13));
        bodyPosition += 1;
      }
      const chunks: V4AChunk[] = [];
      let chunk: V4AChunk | null = null;
      for (; bodyPosition < bodyEnd; bodyPosition += 1) {
        const line = lines[bodyPosition]!;
        if (line.startsWith('@@')) {
          chunk = { anchor: trimSpaces(line.slice(2)), eof: false, body: [] };
          chunks.push(chunk);
        } else if (line === '*** End of File' && chunk !== null) {
          chunk.eof = true;
          chunk = null;
        } else if (line === '' || /^[ +\-]/.test(line)) {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${bodyPosition + 1}`);
            chunk = { anchor: '', eof: false, body: [] };
            chunks.push(chunk);
          }
          chunk.body.push({ kind: line === '' ? ' ' : line[0] as BodyLine['kind'], text: line === '' ? '' : line.slice(1) });
        } else throw new Exit2(`error: parse ${bodyPosition + 1}`);
      }
      if (chunks.length === 0 && newPath === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
      const destination = newPath;
      edits.push((tree) => {
        checkPaths([path, destination]);
        const file = fileLines(requireFile(tree, path));
        if (destination !== null && tree.get(destination) !== null) throw new Fail('exists', destination);
        let cursor = 0;
        for (const entry of chunks) {
          if (entry.anchor !== '') {
            const anchorMatch = occurrences(file.lines, [entry.anchor], strict, cursor);
            if (anchorMatch.positions.length === 0) throw new Fail('no-match', path);
            cursor = anchorMatch.positions[0]! + 1;
          }
          const oldLines = oldLinesOf(entry.body);
          let at = entry.eof ? file.lines.length : cursor;
          let tier = 0;
          if (oldLines.length > 0) {
            const match = occurrences(file.lines, oldLines, strict, cursor, entry.eof);
            if (match.positions.length === 0) throw new Fail('no-match', path);
            at = match.positions[0]!;
            tier = match.tier;
          }
          const newLines = replacement(entry.body, file.lines.slice(at, at + oldLines.length), oldLines, tier);
          file.lines.splice(at, oldLines.length, ...newLines);
          cursor = at + newLines.length;
        }
        tree.now.set(destination ?? path, fileText(file));
        if (destination !== null) {
          tree.now.set(path, null);
          tree.moves.push({ oldPath: path, newPath: destination });
        }
      });
    }
    position = end - 1;
  }
  return edits;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const file = fileLines(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.now.set(p, fileText(file));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, string>();
  const changed = [...tree.now.keys()].filter((path) => tree.original(path) !== tree.now.get(path));
  for (const path of changed) {
    rows.set(path, `${tree.original(path) === null ? 'A' : tree.now.get(path) === null ? 'D' : 'M'} ${path}`);
  }
  const renamed = new Set<string>();
  for (const move of tree.moves) {
    if (renamed.has(move.oldPath) || renamed.has(move.newPath)) continue;
    if (tree.original(move.oldPath) !== null && tree.get(move.oldPath) === null
      && tree.original(move.newPath) === null && tree.get(move.newPath) !== null) {
      rows.delete(move.oldPath);
      rows.set(move.newPath, `R ${move.oldPath} -> ${move.newPath}`);
      renamed.add(move.oldPath);
      renamed.add(move.newPath);
    }
  }
  if (!check) {
    for (const path of changed) {
      if (tree.now.get(path) === null) rmSync(path, { force: true });
    }
    for (const path of changed) {
      const now = tree.now.get(path)!;
      if (now !== null) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, now);
      }
    }
  }
  const output = [...rows.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map((path) => rows.get(path)!);
  return { code: 0, out: [...output, `ok: ${rows.size} ${rows.size === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
