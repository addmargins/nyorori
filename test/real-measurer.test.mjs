import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { measureSnapshot } from '../dist/measurer.js';
const binary = process.env.NYORORI_REAL_CCCC;
const cases = [
  ['if.ts', 'function f(a){if(a)return 1; return 0}', 1, 2],
  ['nested.ts', 'function f(a){if(a){if(a.x)return 1;}return 0}', 3, 3],
  ['logical.ts', 'function f(a,b,c){return a&&b&&c}', 1, 3],
  ['mixed.ts', 'function f(a,b,c){return a&&b||c}', 2, 3],
  ['optional.ts', 'function f(a){return a?.b?.c}', 0, 3],
  ['assignment.ts', 'function f(a){a.x ||= compute();return a}', 0, 1],
  ['switch.ts', 'function f(a){switch(a){case 1:return 1;case 2:return 2;default:return 0}}', 1, 3],
  ['ternary.ts', 'function f(a){return a ? 1 : 0}', 1, 2],
  ['recursion.ts', 'function f(a){return f(a)}', 1, 1],
  ['parent.ts', 'function outer(a){return function inner(){if(a)return 1;return 0}}', 1, 3],
  ['module.ts', 'if (a) { b(); }', 1, 1],
  ['declare.ts', 'declare function f(a: string): void;', 0, 1],
  ['boundary15.ts', `function f(a){${'if(a) { a(); }'.repeat(15)}}`, 15, 16],
  ['boundary16.ts', `function f(a){${'if(a) { a(); }'.repeat(16)}}`, 16, 17],
  ['foo.js', 'function C(){return <div/>}', 0, 1],
  ['foo.jsx', 'function D(){return <span/>}', 0, 1],
];
test(
  'actual pinned cccc contract and representative JS/TS metric fixtures',
  { skip: !binary },
  async (t) => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'nyorori-real-measurer-'));
    t.after(() => rm(out, { recursive: true, force: true }));
    const hash = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex');
    const policy = {
      revision: 'real-fixtures',
      measurement: {
        binary,
        sha256: hash,
        version: 'cccc 1.8.5',
        jobs: 4,
        timeout_ms: 120000,
        max_file_bytes: 2 * 1024 * 1024,
        jsx_in_js: true,
      },
    };
    const files = cases.map(([name, content]) => ({
      status: 'A',
      newPath: name,
      after: {
        path: name,
        content,
        mode: '100644',
        classification: 'source',
        blob_sha: 'b'.repeat(40),
      },
      hunks: [],
      lineMap: new Map(),
    }));
    const result = await measureSnapshot(
      { base_sha: 'a'.repeat(40), candidate_sha: 'b'.repeat(40), files, manifest: [], issues: [] },
      policy,
      out,
      'fixtures',
    );
    assert.deepEqual(result.issues, []);
    for (const [name, , cognitive, cyclomatic] of cases) {
      assert.equal(result.candidate[name]?.cognitive, cognitive, name + ' cognitive');
      assert.equal(result.candidate[name]?.cyclomatic, cyclomatic, name + ' cyclomatic');
    }
    assert.equal(result.candidate['parent.ts'].functions[0].cognitive, 0);
    assert.equal(result.candidate['parent.ts'].functions[0].children[0].cognitive, 1);
    assert.equal(result.candidate['module.ts'].functions.length, 0);
    const raw = JSON.parse(await readFile(path.join(out, 'raw.C.json'), 'utf8'));
    assert.ok(raw.files.some((f) => f.path === 'foo.js.jsx'));
    assert.ok(raw.files.some((f) => f.path === 'foo.jsx'));
  },
);
