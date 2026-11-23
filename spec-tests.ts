import { writeSync } from 'node:fs';

interface SpecCheck {
  key: string;
  family: string;
  argv: string[];
  stdin: string;
  files: Record<string, string>;
  expect: { exit: number; stdout: string; changes: Record<string, string | null> };
}

const checks: SpecCheck[] = [];

function test(key: string, stdin: string, files: Record<string, string>, stdout: string,
  changes: Record<string, string | null> = {}, argv: string[] = [], exit = 0): void {
  checks.push({ key, family: 'spec', argv, stdin, files, expect: { exit, stdout, changes } });
}

const unified = (body: string, start = 1, path = 'file'): string => `--- a/${path}\n+++ b/${path}\n@@ -${start},999 +777,0 @@ wrong counts\n${body}`;
const search = (oldText: string, newText: string, path = 'file'): string => `${path}\n<<<<<<< SEARCH\n${oldText}=======\n${newText}>>>>>>> REPLACE\n`;
const v4a = (body: string, path = 'file'): string => `*** Begin Patch\n*** Update File: ${path}\n${body}*** End Patch\n`;
const json = (command: string, fields: Record<string, unknown> = {}, path = 'file'): string => JSON.stringify({ command, path, ...fields });

const formats = [
  { name: 'unified', replace: (oldText: string, newText: string) => unified(`-${oldText}\n+${newText}\n`) },
  { name: 'search-replace', replace: (oldText: string, newText: string) => search(`${oldText}\n`, `${newText}\n`) },
  { name: 'v4a', replace: (oldText: string, newText: string) => v4a(`-${oldText}\n+${newText}\n`) },
];

for (const format of formats) {
  test(`${format.name}-exact-beats-drift`, format.replace('  old', '  new'), { file: '    old\n  old\n' },
    'M file\nok: 1 file\n', { file: '    old\n  new\n' });
  test(`${format.name}-tier1-beats-tier2`, format.replace('  old', '  new'), { file: '    old\n  old \t\n' },
    'M file\nok: 1 file\n', { file: '    old\n  new\n' });
  test(`${format.name}-tabs-reindent`, format.replace('  old', '  new'), { file: '\told\n' },
    'M file\nok: 1 file\n', { file: '\tnew\n' });
  test(`${format.name}-strict`, format.replace('  old', '  new'), { file: '\told\n' },
    'error: no-match file\nfailed: 1 of 1 edits\n', {}, ['--strict'], 1);
  test(`${format.name}-bom-preserved`, format.replace('old', 'new'), { file: '\uFEFFheader\nold\n' },
    'M file\nok: 1 file\n', { file: '\uFEFFheader\nnew\n' });
  test(`${format.name}-bom-is-content`, format.replace('header', 'new'), { file: '\uFEFFheader\n' },
    'error: no-match file\nfailed: 1 of 1 edits\n', {}, [], 1);
  test(`${format.name}-literal-delimiters`, format.replace('<<<<<<< SEARCH', '*** End Patch'), { file: '<<<<<<< SEARCH\n' },
    'M file\nok: 1 file\n', { file: '*** End Patch\n' }, [`--format=${format.name}`]);
  for (const lineBreak of ['\n', '\r\n']) {
    for (const final of ['', lineBreak]) {
      const file = `old${lineBreak}tail${final}`;
      test(`${format.name}-break-${JSON.stringify(lineBreak)}-${final.length}`, format.replace('old', 'new'), { file },
        'M file\nok: 1 file\n', { file: `new${lineBreak}tail${final}` });
    }
  }
}

for (const path of ['', '/absolute', '../escape', 'dir/../escape', './file', 'dir/./file', 'dir//file', 'dir/', 'back\\slash']) {
  test(`json-unsafe-${path}`, json('create', { file_text: 'new' }, path), {},
    `error: unsafe ${path}\nfailed: 1 of 1 edits\n`, {}, [], 1);
  test(`search-unsafe-${path}`, search('old\n', 'new\n', path || '```'), {},
    path === '' ? 'error: parse 2\n' : `error: unsafe ${path}\nfailed: 1 of 1 edits\n`, {}, [], path === '' ? 2 : 1);
  test(`v4a-unsafe-${path}`, `*** Begin Patch\n*** Add File: ${path}\n+new\n*** End Patch\n`, {},
    `error: unsafe ${path}\nfailed: 1 of 1 edits\n`, {}, [], 1);
  test(`unified-unsafe-${path}`, `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+new\n`, {},
    `error: unsafe ${path}\nfailed: 1 of 1 edits\n`, {}, [], 1);
}

test('safe-unicode-byte-order', JSON.stringify([
  { command: 'create', path: '\u{10000}', file_text: '' },
  { command: 'create', path: '\uE000', file_text: '' },
  { command: 'create', path: 'z', file_text: '' },
]), {}, 'A z\nA \uE000\nA \u{10000}\nok: 3 files\n', { z: '', '\uE000': '', '\u{10000}': '' });
test('safe-no-unrequested-normalization', json('create', { file_text: 'text' }, 'a/ spaced name '), {},
  'A a/ spaced name \nok: 1 file\n', { 'a/ spaced name ': 'text' });
test('usage-before-no-patch', '', {}, 'error: usage\n', {}, ['absent', '--unknown'], 2);
test('usage-before-parse', '[invalid', {}, 'error: usage\n', {}, ['--strict', '--strict'], 2);
test('duplicate-format', '', {}, 'error: usage\n', {}, ['--format=auto', '--format=json'], 2);
test('duplicate-check', '', {}, 'error: usage\n', {}, ['--check', '--check'], 2);
test('invalid-format', '', {}, 'error: usage\n', {}, ['--format=JSON'], 2);
test('multiple-positionals', '', {}, 'error: usage\n', {}, ['-', '-'], 2);
test('option-terminator', '', { '--strict': json('create', { file_text: '' }) }, 'A file\nok: 1 file\n', { file: '' }, ['--', '--strict']);
test('options-after-patch', '', { patch: json('create', { file_text: '' }) }, 'A file\nok: 1 file\n', {}, ['patch', '--check', '--strict', '--format=json']);
test('no-patch-before-format', '', {}, 'error: no-patch\n', {}, ['--format=unified', 'absent'], 2);
test('auto-empty', ' \n\t\n', {}, 'error: format\n', {}, [], 2);
test('auto-json-before-search', '[invalid\n<<<<<<< SEARCH\n', {}, 'error: parse 1\n', {}, [], 2);
test('auto-v4a-before-json', ' \n *** Begin Patch \n[invalid\n *** End Patch \n', {}, 'error: parse 3\n', {}, [], 2);
test('auto-search-before-unified', '--- a/file\n+++ b/file\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n', {},
  'error: missing +++ b/file\nfailed: 1 of 1 edits\n', {}, [], 1);
for (const format of ['json', 'unified', 'search-replace', 'v4a']) {
  const patch = format === 'json' ? '[]\n' : format === 'v4a' ? '*** Begin Patch\n*** End Patch\n' : 'ignored prose\n';
  test(`${format}-no-edits`, patch, {}, 'error: parse 1\n', {}, [`--format=${format}`], 2);
}

test('unified-nearest-tie-earlier', unified('-old\n+new\n', 2), { file: 'old\nmiddle\nold\n' },
  'M file\nok: 1 file\n', { file: 'new\nmiddle\nold\n' });
test('unified-overlapping-nearest', unified('-same\n-same\n+new\n', 2), { file: 'same\nsame\nsame\n' },
  'M file\nok: 1 file\n', { file: 'same\nnew\n' });
test('unified-delta-chaining', unified('-old\n+first\n+extra\n', 1) + '@@ -2,99 +100,99 @@\n-old\n+second\n',
  { file: 'old\nold\nold\n' }, 'M file\nok: 1 file\n', { file: 'first\nextra\nsecond\nold\n' });
test('unified-empty-insertion-delta', unified('+new\n', 1) + '@@ -2,0 +3,999 @@\n+last\n',
  { file: 'first\nsecond' }, 'M file\nok: 1 file\n', { file: 'first\nnew\nsecond\nlast\n' });
test('unified-empty-file-insert', unified('+new\n', 99), { file: '' }, 'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-empty-file-noeol', unified('+new\n\\ anything\n', 99), { file: '' }, 'M file\nok: 1 file\n', { file: 'new' });
test('unified-eof-adds-final-break', unified('-old\n+new\n'), { file: 'old' }, 'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-non-eof-marker-ignored', unified('-old\n+new\n\\ No newline at end of file\n'), { file: 'old\ntail\n' },
  'M file\nok: 1 file\n', { file: 'new\ntail\n' });
test('unified-old-only-marker', unified('-old\n\\ old marker\n+new\n'), { file: 'old' },
  'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-last-context-marker', unified('-old\n+new\n tail\n\\ marker\n'), { file: 'old\ntail\n' },
  'M file\nok: 1 file\n', { file: 'new\ntail' });
test('unified-blank-body-trailing-trim', unified('-old\n+new\n\n\n'), { file: 'old\n' },
  'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-explicit-empty-context', unified('-old\n+new\n \n'), { file: 'old\n\n' },
  'M file\nok: 1 file\n', { file: 'new\n\n' });
test('unified-blank-interior-context', unified('-old\n+new\n\n tail\n'), { file: 'old\n\ntail\n' },
  'M file\nok: 1 file\n', { file: 'new\n\ntail\n' });
test('unified-context-preserves-tier1', unified(' head\n-old\n+new\n'), { file: 'head\t \nold\n' },
  'M file\nok: 1 file\n', { file: 'head\t \nnew\n' });
test('unified-context-and-selective-indent', unified('   head\n-  old\n+    deeper\n+no-prefix\n+  \n+\n'),
  { file: '\thead \t\n\told\n' }, 'M file\nok: 1 file\n', { file: '\thead \t\n\t  deeper\nno-prefix\n  \n\n' });
test('unified-unicode-whitespace-not-reindented', unified('-old\n+new\n+\u00A0\n+\t\n'),
  { file: '  old\n' }, 'M file\nok: 1 file\n', { file: '  new\n\u00A0\n\t\n' });
test('unified-replacement-empty', unified('-old\n'), { file: 'old\n' }, 'M file\nok: 1 file\n', { file: '' });
test('unified-create-noeol', '--- /dev/null\n+++ b/file\n@@ -0 +1 @@\n+new\n\\ marker\n', {},
  'A file\nok: 1 file\n', { file: 'new' });
test('unified-create-only-plus-lines', '--- /dev/null\n+++ b/file\n@@ -0 +1 @@\n ignored context\n-ignored old\n+first\n@@ -100 +999 @@\n+last\n', {},
  'A file\nok: 1 file\n', { file: 'first\nlast\n' });
test('unified-new-file-mode', 'diff --git a/file b/file\nnew file mode 100644\n@@ -0 +1 @@\n+new\n', {},
  'A file\nok: 1 file\n', { file: 'new\n' });
test('unified-delete-ignores-match', '--- a/file\n+++ /dev/null\n@@ -900 +1 @@\n-not in file\n', { file: 'actual' },
  'D file\nok: 1 file\n', { file: null });
test('unified-delete-mode', 'diff --git a/file b/file\ndeleted file mode 100644\n', { file: '' },
  'D file\nok: 1 file\n', { file: null });
test('unified-header-paths-timestamps', '---  b/file \told timestamp\n+++  a/file \tnew timestamp\n@@ -1 +1 @@\n-old\n+new\n',
  { file: 'old\n' }, 'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-pair-overrides-rename', 'diff --git a/missing b/unused\nrename from absent\nrename to destination\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n',
  { file: 'old\n' }, 'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-rename-only', 'diff --git a/unused b/ignored\nrename from file\nrename to nested/new\n', { file: '\uFEFFold\r\n' },
  'R file -> nested/new\nok: 1 file\n', { file: null, 'nested/new': '\uFEFFold\r\n' });
test('unified-header-noop', 'diff --git a/file b/file\nIndex: ignored\nold mode 100644\nnew mode 100755\n',
  { file: 'same' }, 'ok: 0 files\n');
test('unified-header-other-lines-ignored', 'diff --git a/file b/file\ndiff --github is prose\n@@ -1 +1 @@\n-old\n+new\n',
  { file: 'old\n' }, 'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-malformed-git', 'diff --git invalid\n', {}, 'error: parse 1\n', {}, ['--format=unified'], 2);
test('unified-orphan-hunk', '\n@@ -1 +1 @@\n-old\n+new\n', {}, 'error: parse 2\n', {}, ['--format=unified'], 2);
test('unified-missing-new-header', 'diff --git a/file b/file\n--- a/file\n', {}, 'error: parse 3\n', {}, [], 2);
test('unified-parse-before-unsafe', '--- a/../bad\n+++ b/../bad\n@@ broken\n', {}, 'error: parse 3\n', {}, [], 2);
test('unified-failed-section-rollback', unified('-old\n+new\n') + '@@ -2 +2 @@\n-missing\n+bad\n' + unified('-new\n+last\n'),
  { file: 'old\n' }, 'error: no-match file\nerror: no-match file\nfailed: 2 of 2 edits\n', {}, [], 1);
test('unified-later-section-sees-earlier', unified('-old\n+new\n') + unified('-new\n+last\n'),
  { file: 'old\n' }, 'M file\nok: 1 file\n', { file: 'last\n' });
test('unified-unsafe-target-before-missing-source', 'diff --git a/missing b/../bad\n', {},
  'error: unsafe ../bad\nfailed: 1 of 1 edits\n', {}, [], 1);
test('unified-missing-source-before-existing-target', 'diff --git a/missing b/target\n', { target: 'exists' },
  'error: missing missing\nfailed: 1 of 1 edits\n', {}, [], 1);
test('unified-existing-target-before-no-match', 'diff --git a/file b/target\n@@ -1 +1 @@\n-absent\n+new\n',
  { file: 'old', target: 'exists' }, 'error: exists target\nfailed: 1 of 1 edits\n', {}, [], 1);

test('search-overlapping-ambiguity', search('same\nsame\n', 'new\n'), { file: 'same\nsame\nsame\n' },
  'error: ambiguous file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('search-tier1-ambiguity', search('old\n', 'new\n'), { file: 'old \nold\t\n' },
  'error: ambiguous file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('search-inherited-path-and-crlf-patch', (search('old\n', 'new\n') + '```\n\n<<<<<<< SEARCH\nnew\n=======\nlast\n>>>>>>> REPLACE\n').replaceAll('\n', '\r\n'),
  { file: 'old\r\n' }, 'M file\nok: 1 file\n', { file: 'last\r\n' });
test('search-trailing-marker-whitespace', ' file \n<<<<<<< SEARCH \t\nold\n=======\t \nnew\n>>>>>>> REPLACE \t\n',
  { file: 'old' }, 'M file\nok: 1 file\n', { file: 'new' });
test('search-leading-marker-not-marker', 'file\n <<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n', {},
  'error: parse 1\n', {}, ['--format=search-replace'], 2);
test('search-create-empty', search('', ''), {}, 'A file\nok: 1 file\n', { file: '' });
test('search-create-blank-line', search('', '\n'), {}, 'A file\nok: 1 file\n', { file: '\n' });
test('search-create-then-replace', search('', 'old\n') + search('old\n', 'new\n'), {},
  'A file\nok: 1 file\n', { file: 'new\n' });
test('search-create-existing-empty', search('', 'new\n'), { file: '' }, 'error: exists file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('search-replace-empty-file', search('old\n', 'new\n'), { file: '' }, 'error: no-match file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('search-blank-old-is-not-create', search('\n', 'new\n'), { file: '\n' }, 'M file\nok: 1 file\n', { file: 'new\n' });
test('search-delete-all-lines', search('old\n', ''), { file: 'old\r\n' }, 'M file\nok: 1 file\n', { file: '' });
test('search-rollback-and-continue', search('missing\n', 'new\n') + search('new\n', 'last\n') + search('old\n', 'done\n'),
  { file: 'old\n' }, 'error: no-match file\nerror: no-match file\nfailed: 2 of 3 edits\n', {}, [], 1);
test('search-nested-search-is-content', search('<<<<<<< SEARCH\n', '=======\n'), { file: '<<<<<<< SEARCH\n' },
  'M file\nok: 1 file\n', { file: '=======\n' });
test('search-parse-before-file-lookups', search('old\n', 'new\n', '../bad') + 'file\n<<<<<<< SEARCH\nold\n', {},
  'error: parse 8\n', {}, [], 2);

test('v4a-cursor-skips-exact-before-cursor', v4a('@@ anchor\n-old\n+new\n'), { file: 'old\nanchor\nold \n' },
  'M file\nok: 1 file\n', { file: 'old\nanchor\nnew\n' });
test('v4a-anchor-exact-beats-drift', v4a('@@ anchor\n-old\n+new\n'), { file: 'anchor \nold\nanchor\nold\n' },
  'M file\nok: 1 file\n', { file: 'anchor \nold\nanchor\nnew\n' });
test('v4a-anchor-tier2-does-not-reindent-body', v4a('@@ anchor\n-old\n+new\n'), { file: '  anchor\nold\n' },
  'M file\nok: 1 file\n', { file: '  anchor\nnew\n' });
test('v4a-anchor-line-is-not-old', v4a('@@ old\n-old\n+new\n'), { file: 'old\n' },
  'error: no-match file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('v4a-cursor-after-insertion', v4a('@@\n+inserted\n@@\n-old\n+new\n'), { file: 'old\n' },
  'M file\nok: 1 file\n', { file: 'inserted\nnew\n' });
test('v4a-cursor-after-deletion', v4a('-first\n@@\n-second\n+new\n'), { file: 'first\nsecond\n' },
  'M file\nok: 1 file\n', { file: 'new\n' });
test('v4a-eof-tier-filter-before-matching', v4a('-old\n+new\n*** End of File\n'), { file: 'old\nold \n' },
  'M file\nok: 1 file\n', { file: 'old\nnew\n' });
test('v4a-eof-does-not-fallback', v4a('-old\n+new\n*** End of File\n'), { file: 'old\ntail\n' },
  'error: no-match file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('v4a-eof-empty-insertion', v4a('@@\n+new\n*** End of File\n'), { file: 'old' },
  'M file\nok: 1 file\n', { file: 'old\nnew' });
test('v4a-empty-file-insertion', v4a('+new\n'), { file: '' }, 'M file\nok: 1 file\n', { file: 'new' });
test('v4a-empty-chunk-noop', v4a('@@\n'), { file: 'same' }, 'ok: 0 files\n');
test('v4a-no-chunk-parse', v4a(''), {}, 'error: parse 2\n', {}, [], 2);
test('v4a-move-only', v4a('*** Move to: nested/new\n'), { file: 'same\r\n' },
  'R file -> nested/new\nok: 1 file\n', { file: null, 'nested/new': 'same\r\n' });
test('v4a-move-same-path-exists', v4a('*** Move to: file\n'), { file: 'same' },
  'error: exists file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('v4a-move-unsafe-before-missing', v4a('*** Move to: ../bad\n'), {},
  'error: unsafe ../bad\nfailed: 1 of 1 edits\n', {}, [], 1);
test('v4a-missing-before-existing-target', v4a('*** Move to: target\n'), { target: 'exists' },
  'error: missing file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('v4a-failed-move-chunk-no-rename', v4a('*** Move to: target\n-old\n+new\n@@\n-absent\n+bad\n'),
  { file: 'old\n' }, 'error: no-match file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('v4a-add-trailing-blank-exclusion', '*** Begin Patch\n*** Add File: file\n+first\n\n+last\n\n \t\n*** End Patch\n', {},
  'A file\nok: 1 file\n', { file: 'first\n\nlast\n' });
test('v4a-add-explicit-final-blank', '*** Begin Patch\n*** Add File: file\n+first\n+\n*** End Patch\n', {},
  'A file\nok: 1 file\n', { file: 'first\n\n' });
test('v4a-add-empty', '*** Begin Patch\n*** Add File: file\n*** End Patch\n', {}, 'A file\nok: 1 file\n', { file: '' });
test('v4a-wrapper-whitespace-bom', '\uFEFF *** Begin Patch \t\r\n*** Add File: file\r\n+new\r\n *** End Patch \t\r\n\r\n', {},
  'A file\nok: 1 file\n', { file: 'new\n' });
test('v4a-missing-end-priority', '*** Begin Patch\ninvalid\n', {}, 'error: parse 3\n', {}, [], 2);
test('v4a-first-line-priority', ' \ninvalid\n', {}, 'error: parse 2\n', {}, ['--format=v4a'], 2);
test('v4a-invalid-delete-body', '*** Begin Patch\n*** Delete File: file\n+invalid\n*** End Patch\n', {},
  'error: parse 3\n', {}, [], 2);
test('v4a-invalid-add-body', '*** Begin Patch\n*** Add File: file\ninvalid\n*** End Patch\n', {},
  'error: parse 3\n', {}, [], 2);
test('v4a-invalid-body-after-eof', v4a('-old\n+new\n*** End of File\n+bad\n'), {},
  'error: parse 6\n', {}, [], 2);
test('v4a-create-update-delete-noop', '*** Begin Patch\n*** Add File: file\n+old\n*** Update File: file\n-old\n+new\n*** Delete File: file\n*** End Patch\n', {},
  'ok: 0 files\n');
test('v4a-move-chain-not-original-pair', '*** Begin Patch\n*** Update File: file\n*** Move to: middle\n*** Update File: middle\n*** Move to: final\n*** End Patch\n',
  { file: 'same' }, 'D file\nA final\nok: 2 files\n', { file: null, final: 'same' });
test('v4a-move-roundtrip-noop', '*** Begin Patch\n*** Update File: file\n*** Move to: middle\n*** Update File: middle\n*** Move to: file\n*** End Patch\n',
  { file: 'same' }, 'ok: 0 files\n');
test('v4a-rename-output-sorts-by-destination', '*** Begin Patch\n*** Update File: a\n*** Move to: z\n*** Add File: middle\n+new\n*** End Patch\n',
  { a: 'same' }, 'A middle\nR a -> z\nok: 2 files\n', { a: null, z: 'same', middle: 'new\n' });
test('v4a-check-move-and-create', '*** Begin Patch\n*** Update File: a\n*** Move to: z\n*** Add File: middle\n+new\n*** End Patch\n',
  { a: 'same' }, 'A middle\nR a -> z\nok: 2 files\n', {}, ['--check']);

test('json-create-exact-bytes', json('create', { file_text: '\uFEFFfirst\r\nlast' }), {},
  'A file\nok: 1 file\n', { file: '\uFEFFfirst\r\nlast' });
test('json-array-parse-line', '\n  [\n' + json('create', { file_text: 'new' }, '../bad') + ',\n{"command":"wrong","path":"file"}\n]\n', {},
  'error: parse 2\n', {}, [], 2);
test('json-lines-parse-before-unsafe', json('create', { file_text: '' }, '../bad') + '\n\ninvalid\n', {},
  'error: parse 3\n', {}, [], 2);
test('json-single-multiline-object-is-invalid', '{\n"command":"create","path":"file","file_text":""\n}\n', {},
  'error: parse 1\n', {}, [], 2);
test('json-null-new-string-invalid', json('str_replace', { old_str: 'old', new_str: null }), {}, 'error: parse 1\n', {}, [], 2);
test('json-empty-old-invalid', json('str_replace', { old_str: '', new_str: '' }), {}, 'error: parse 1\n', {}, [], 2);
test('json-fractional-insert-invalid', json('insert', { insert_line: 0.5, new_str: '' }), {}, 'error: parse 1\n', {}, [], 2);
test('json-extra-keys-ignored', json('create', { file_text: '', old_str: 123, ignored: { bad: true } }), {}, 'A file\nok: 1 file\n', { file: '' });
test('json-overlapping-text-ambiguity', json('str_replace', { old_str: 'aa', new_str: 'b' }), { file: 'aaa' },
  'error: ambiguous file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('json-no-whitespace-tiers', json('str_replace', { old_str: 'old\n', new_str: 'new\n' }), { file: 'old \n' },
  'error: no-match file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('json-absent-new-string', json('str_replace', { old_str: 'old' }), { file: 'old\n' },
  'M file\nok: 1 file\n', { file: '\n' });
test('json-crlf-normalizes-both-strings', json('str_replace', { old_str: 'old\r\ntail', new_str: 'new\nend\r\n' }),
  { file: 'old\r\ntail' }, 'M file\nok: 1 file\n', { file: 'new\r\nend\r\n' });
test('json-crlf-normalizes-all-file-lfs', json('str_replace', { old_str: 'tail', new_str: 'end' }),
  { file: 'head\r\nmiddle\ntail' }, 'M file\nok: 1 file\n', { file: 'head\r\nmiddle\r\nend' });
test('json-lf-does-not-normalize-crlf', json('str_replace', { old_str: 'head\r\n', new_str: 'new\n' }),
  { file: 'head\ntail\r\n' }, 'error: no-match file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('json-insert-empty-noop', json('insert', { insert_line: 0, new_str: '' }), { file: '' }, 'ok: 0 files\n');
test('json-insert-into-empty-no-final', json('insert', { insert_line: 0, new_str: 'first\nlast\n' }), { file: '' },
  'M file\nok: 1 file\n', { file: 'first\nlast' });
test('json-insert-blank-line', json('insert', { insert_line: 1, new_str: '\n' }), { file: 'old\n' },
  'M file\nok: 1 file\n', { file: 'old\n\n' });
test('json-insert-removes-one-cr-only', json('insert', { insert_line: 1, new_str: 'new\r\r\n' }), { file: 'old\r\n' },
  'M file\nok: 1 file\n', { file: 'old\r\nnew\r\r\n' });
test('json-insert-no-final-preserved', json('insert', { insert_line: 1, new_str: 'new\r\n' }), { file: 'old' },
  'M file\nok: 1 file\n', { file: 'old\nnew' });
for (const insertLine of [-1, 2]) {
  test(`json-insert-out-of-range-${insertLine}`, json('insert', { insert_line: insertLine, new_str: '' }), { file: 'old\n' },
    'error: no-match file\nfailed: 1 of 1 edits\n', {}, [], 1);
}
test('json-array-staged-chaining', JSON.stringify([
  { command: 'create', path: 'file', file_text: 'old' },
  { command: 'str_replace', path: 'file', old_str: 'old', new_str: 'new' },
  { command: 'insert', path: 'file', insert_line: 1, new_str: 'last\n' },
]), {}, 'A file\nok: 1 file\n', { file: 'new\nlast' });
test('json-success-failure-continued-and-atomic', [
  json('create', { file_text: 'old' }),
  json('str_replace', { old_str: 'missing', new_str: 'bad' }),
  json('str_replace', { old_str: 'old', new_str: 'new' }),
  json('create', { file_text: '' }),
  json('insert', { insert_line: 2, new_str: '' }, 'missing'),
].join('\n'), {}, 'error: no-match file\nerror: exists file\nerror: missing missing\nfailed: 3 of 5 edits\n', {}, [], 1);
test('json-change-revert-noop', [json('str_replace', { old_str: 'old', new_str: 'new' }), json('str_replace', { old_str: 'new', new_str: 'old' })].join('\n'),
  { file: 'old' }, 'ok: 0 files\n');

test('unified-rename-single-fallback-path', 'diff --git a/ignored b/target\nrename from file\n', { file: 'same' },
  'R file -> target\nok: 1 file\n', { file: null, target: 'same' });
test('unified-create-header-with-no-hunks', 'diff --git a/file b/file\nnew file mode 100644\n', {},
  'A file\nok: 1 file\n', { file: '' });
test('unified-create-unsafe-old-path', 'diff --git a/../unsafe b/file\nnew file mode 100644\n', {},
  'error: unsafe ../unsafe\nfailed: 1 of 1 edits\n', {}, [], 1);
test('unified-fenced-prose-and-hunk-end', 'prose\n```diff\n' + unified('-old\n+new\n\n') + '```\n prose\n+ignored outside body\n',
  { file: 'old\n' }, 'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-bom-old-line-exact', unified('-\uFEFFold\n+\uFEFFnew\n'), { file: '\uFEFFold\n' },
  'M file\nok: 1 file\n', { file: '\uFEFFnew\n' });
test('unified-delete-create-same-path', '--- a/file\n+++ /dev/null\n' + '--- /dev/null\n+++ b/file\n@@ -0 +1 @@\n+new\n',
  { file: 'old' }, 'M file\nok: 1 file\n', { file: 'new\n' });
test('unified-failed-move-restores-source', 'diff --git a/file b/target\n@@ -1 +1 @@\n-absent\n+new\n' + unified('-new\n+last\n', 1, 'target'),
  { file: 'old\n' }, 'error: no-match file\nerror: missing target\nfailed: 2 of 2 edits\n', {}, [], 1);
test('search-nearest-non-fence-line-is-path', search('old\n', 'new\n', 'file\nprose is a path\n```diff'),
  { file: 'old\n' }, 'error: missing prose is a path\nfailed: 1 of 1 edits\n', {}, [], 1);
test('search-same-tier2-is-ambiguous', search('  old\n', '  new\n'), { file: '\told\n    old\n' },
  'error: ambiguous file\nfailed: 1 of 1 edits\n', {}, [], 1);
test('v4a-plain-first-occurrence-on-tie', v4a('-old\n+new\n'), { file: 'old\nold\n' },
  'M file\nok: 1 file\n', { file: 'new\nold\n' });
test('v4a-strict-anchor', v4a('@@ anchor\n-old\n+new\n'), { file: 'anchor \nold\n' },
  'error: no-match file\nfailed: 1 of 1 edits\n', {}, ['--strict'], 1);
test('v4a-ends-chunk-then-explicit-next-chunk', v4a('-old\n+new\n*** End of File\n@@\n+last\n'), { file: 'old' },
  'M file\nok: 1 file\n', { file: 'new\nlast' });
test('v4a-failed-section-rolls-back-cursor-and-lines', '*** Begin Patch\n*** Update File: file\n-old\n+new\n@@ absent anchor\n+bad\n*** Update File: file\n-new\n+last\n*** End Patch\n',
  { file: 'old\n' }, 'error: no-match file\nerror: no-match file\nfailed: 2 of 2 edits\n', {}, [], 1);
test('v4a-move-before-body-only', v4a('@@\n*** Move to: target\n'), {}, 'error: parse 4\n', {}, [], 2);
test('v4a-created-file-then-moved-is-addition', '*** Begin Patch\n*** Add File: file\n+new\n*** Update File: file\n*** Move to: target\n*** End Patch\n', {},
  'A target\nok: 1 file\n', { target: 'new\n' });
test('v4a-move-destination-later-deleted', '*** Begin Patch\n*** Update File: file\n*** Move to: target\n*** Delete File: target\n*** End Patch\n',
  { file: 'old' }, 'D file\nok: 1 file\n', { file: null });
test('json-first-lf-determines-line-break', json('insert', { insert_line: 1, new_str: 'new\n' }), { file: 'first\nsecond\r\n' },
  'M file\nok: 1 file\n', { file: 'first\nnew\nsecond\r\n' });
test('json-lone-cr-is-line-content', json('insert', { insert_line: 1, new_str: 'new\n' }), { file: 'old\r' },
  'M file\nok: 1 file\n', { file: 'old\r\nnew' });
test('json-empty-line-count-is-one', json('insert', { insert_line: 1, new_str: 'new\n' }), { file: '\n' },
  'M file\nok: 1 file\n', { file: '\nnew\n' });
test('json-crlf-insert-preserves-no-final-break', json('insert', { insert_line: 2, new_str: 'new\n' }), { file: 'head\r\ntail' },
  'M file\nok: 1 file\n', { file: 'head\r\ntail\r\nnew' });
test('json-check-failures-still-continue', [json('create', { file_text: 'old' }), json('create', { file_text: 'new' }), json('str_replace', { old_str: 'missing' })].join('\n'), {},
  'error: exists file\nerror: no-match file\nfailed: 2 of 3 edits\n', {}, ['--check'], 1);

writeSync(1, JSON.stringify({ checks }) + '\n');
