import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const instructions = dockerfile.replace(/\\\n/g, '\n').split(/\n(?=[A-Z]+\s)/);
const build = instructions.find((instruction) => instruction.startsWith('RUN ') && instruction.includes('npm run frontend'));
assert.ok(build, 'Missing frontend build instruction');
const script = build.replace(/^RUN\s+/, '');

for (const failure of ['run', 'prune', 'none']) {
  test(`frontend packaging propagates ${failure} failure`, () => {
    const mock = `npm() { printf '%s\\n' "$1"; if [ "$1" = "${failure}" ]; then return 42; fi; };`;
    const result = spawnSync('/bin/sh', ['-c', `${mock}\n${script}`], { encoding: 'utf8' });
    assert.equal(result.status, failure === 'none' ? 0 : 42, result.stderr);
    const expected = failure === 'run' ? ['run'] : failure === 'prune' ? ['run', 'prune'] : ['run', 'prune', 'cache'];
    assert.deepEqual(result.stdout.trim().split('\n'), expected);
  });
}
