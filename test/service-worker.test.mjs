import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysisWorker, AnalysisWorkerError } from '../dist/worker.js';
const options = {
  repo: '/nonexistent/nyorori-fixture',
  base: 'a'.repeat(40),
  candidate: 'b'.repeat(40),
  policyPath: '/nonexistent/policy.json',
  out: '/nonexistent/out',
};

test('isolated worker enforces bounded wall time and sanitized failures', async () => {
  await assert.rejects(
    runAnalysisWorker(options, 1),
    (error) => error instanceof AnalysisWorkerError && error.code === 'WALL_TIMEOUT',
  );
  await assert.rejects(
    runAnalysisWorker({ ...options, base: 'main' }, 10000),
    (error) =>
      error instanceof AnalysisWorkerError &&
      error.code === 'PROCESS_EXIT' &&
      !error.message.includes('/nonexistent'),
  );
});
test('isolated worker rejects excessive request and invalid timeout before spawning', async () => {
  await assert.rejects(
    runAnalysisWorker({ ...options, repository: 'x'.repeat(70000) }),
    (error) => error.code === 'REQUEST_LIMIT',
  );
  await assert.rejects(runAnalysisWorker(options, 0), (error) => error.code === 'INVALID_TIMEOUT');
});
