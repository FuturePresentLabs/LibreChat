import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFplSkillProvider, resolveManualSkills } = require('@librechat/api');
const skillsRoot = resolve(process.env.FPL_SKILLS_TEST_ROOT || '../fpl-skills');
const { createHttpServer } = await import(pathToFileURL(join(skillsRoot, 'src/mcp.mjs')));
const root = await mkdtemp(join(tmpdir(), 'librechat-fpl-skills-'));
const user = {
  id: '123456789012345678901234',
  provider: 'openid',
  openidId: 'fixture',
  email: 'fixture@fpl.test',
};
let member = true;
const identity = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-identity');
  let body = '';
  for await (const chunk of req) body += chunk;
  const { email } = JSON.parse(body);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ email, sub: user.openidId, companies: member ? [{ id: 'fpl' }] : [] }));
});
identity.listen(0, '127.0.0.1');
await once(identity, 'listening');
const skills = createHttpServer({
  root: skillsRoot,
  statePath: join(root, 'state.sqlite'),
  sharedToken: 'fixture-gateway',
  clientSecret: 'fixture-identity',
  identityUrl: `http://127.0.0.1:${identity.address().port}/identity`,
});
skills.listen(0, '127.0.0.1');
await once(skills, 'listening');
const base = `http://127.0.0.1:${skills.address().port}`;
const provider = () =>
  createFplSkillProvider(user, { FPL_SKILLS_URL: base, FPL_SKILLS_TOKEN: 'fixture-gateway' });
const headers = {
  authorization: 'Bearer fixture-gateway',
  'x-fpl-user-email': user.email,
  'content-type': 'application/json',
};
try {
  const p = provider();
  const ids = await p.ids([]);
  const methods = p.wrap({}, true);
  const catalog = await methods.listSkillsByAccess({ accessibleIds: ids, limit: 100 });
  const selected = catalog.skills.find((skill) => skill.displayTitle === 'brandcast');
  assert(selected);
  const readCount = async () =>
    (await (await fetch(base + '/library', { headers })).json()).skills.find(
      (skill) => skill.id === 'brandcast',
    ).metrics.reads_30d;
  assert.equal(await readCount(), 0);
  const inspected = await p.wrap({}, false).getSkillById(selected._id);
  assert(inspected.body.length > 0);
  await p.wrap({}, false).getSkillFileByPath(selected._id, 'SKILL.md');
  assert.equal(await readCount(), 0);
  const result = await resolveManualSkills({
    names: [selected.name],
    accessibleSkillIds: ids,
    getSkillByName: methods.getSkillByName,
    userId: user.id,
    skillStates: {},
    defaultActiveOnShare: false,
  });
  assert.equal(result.length, 1);
  assert.equal(await readCount(), 1);
  assert.equal(
    (
      await fetch(base + '/preferences', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ id: 'brandcast', enabled: false }),
      })
    ).status,
    200,
  );
  await assert.rejects(methods.getSkillByName(selected.name, ids));
  assert.equal(await readCount(), 1);
  assert(!(await provider().ids([])).some((id) => id.equals(selected._id)));
  member = false;
  assert.deepEqual(await provider().ids([]), []);
  console.log(
    'PASS: native LibreChat manual skill priming -> real FPL MCP; inspection metrics; disabling; fresh membership; no catalog copy',
  );
} finally {
  skills.closeAllConnections();
  identity.closeAllConnections();
  await new Promise((resolve) => skills.close(resolve));
  await new Promise((resolve) => identity.close(resolve));
  await rm(root, { recursive: true, force: true });
}
