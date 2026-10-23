import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { changedRanges } from './diff.js';
function git(cwd, args) {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
export function gitRoot(cwd) {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}
export function mergeBase(cwd, base) {
    return git(cwd, ['merge-base', base, 'HEAD']).trim();
}
/**
 * The files changed since `base`, keyed by absolute path, and how.
 * Compares against the working tree, so uncommitted edits count as changes.
 */
export function diffFiles(cwd, base) {
    const root = gitRoot(cwd);
    // Explicit prefixes: `diff.noprefix` or `diff.mnemonicPrefix` in the user's config would change the headers.
    const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', base, '--']);
    return parseDiff(diff, root);
}
/** What changed in `file`, whose new version is `code` (see changedRanges). */
export function fileChanges(cwd, file, diff, code) {
    let before;
    if (diff.blob) {
        try {
            before = git(cwd, ['cat-file', 'blob', diff.blob]);
        }
        catch {
            // Then every token of the changed lines counts as new, as when only lines were compared.
        }
    }
    return { lines: diff.lines, ranges: changedRanges(before, code, diff.hunks, file) };
}
export function parseDiff(diff, root) {
    const result = new Map();
    let current;
    let blob;
    // The lines of the hunk being read: its text can look like a header (`--- a` removed as `---- a`).
    let removed = 0;
    let added = 0;
    for (const line of diff.split('\n')) {
        if (removed > 0 && line.startsWith('-')) {
            removed--;
            continue;
        }
        if (added > 0 && line.startsWith('+')) {
            added--;
            continue;
        }
        if (line.startsWith('\\'))
            continue; // \ No newline at end of file
        removed = added = 0;
        if (line.startsWith('diff ')) {
            current = undefined;
            blob = undefined;
            continue;
        }
        const index = /^index ([0-9a-f]+)\.\./.exec(line);
        if (index) {
            blob = /^0+$/.test(index[1]) ? undefined : index[1];
            continue;
        }
        if (line.startsWith('+++ ')) {
            const target = unquote(line.slice(4));
            if (target === '/dev/null') {
                current = undefined;
                continue;
            }
            current = { lines: new Set(), hunks: [], blob };
            result.set(path.resolve(root, target.replace(/^b\//, '')), current);
            continue;
        }
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && current) {
            const count = (value) => (value === undefined ? 1 : Number(value));
            const oldCount = count(hunk[2]);
            const newStart = Number(hunk[3]);
            const newCount = count(hunk[4]);
            current.hunks.push({ oldStart: Number(hunk[1]), oldCount, newStart, newCount });
            for (let i = 0; i < newCount; i++)
                current.lines.add(newStart + i);
            removed = oldCount;
            added = newCount;
        }
    }
    // A file whose hunks only delete lines stays: the deletion can still change an expression around it.
    for (const [file, { hunks }] of result)
        if (hunks.length === 0)
            result.delete(file);
    return result;
}
/** A path as git writes it in a header: C-quoted when it has special characters, and followed by a tab when it has a space. */
function unquote(name) {
    name = name.replace(/\t$/, '');
    if (!name.startsWith('"') || !name.endsWith('"'))
        return name;
    const escapes = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    return name.slice(1, -1).replace(/\\([0-7]{3}|.)/g, (_, escape) => escape.length === 3 ? String.fromCharCode(Number.parseInt(escape, 8)) : (escapes[escape] ?? escape));
}
