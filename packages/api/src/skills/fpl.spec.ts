import http from 'http';
import { once } from 'events';
import { Types } from 'mongoose';
import type { AddressInfo } from 'net';
import { createFplSkillProvider, fplSkillId } from './fpl';

describe('FPL request-scoped skill provider', () => {
  const user = {
    id: '123456789012345678901234',
    provider: 'openid',
    openidId: 'subject-a',
    email: 'a@fpl.test',
  };
  const skill = {
    id: 'campaign',
    name: 'Campaign',
    description: 'Plan a campaign',
    owner_type: 'user' as const,
    owner_id: 'subject-a',
    status: 'active',
    valid: true,
    enabled: true,
  };
  let server: http.Server;
  let url: string;
  let enabled = true;
  let reads = 0;
  let inspectionReads = 0;
  let requests = 0;
  let outage = false;
  let revoked = false;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      requests++;
      if (outage || req.headers.authorization !== 'Bearer fixture') {
        res.writeHead(503).end();
        return;
      }
      const visible = req.headers['x-fpl-user-email'] === user.email && !revoked;
      const path = new URL(req.url!, 'http://fixture');
      res.setHeader('content-type', 'application/json');
      if (path.pathname === '/library') {
        res.end(
          JSON.stringify({ schema_version: 1, skills: visible ? [{ ...skill, enabled }] : [] }),
        );
        return;
      }
      if (!visible) {
        res.writeHead(404).end('{}');
        return;
      }
      if (path.pathname === '/library/skill') {
        inspectionReads++;
        res.end(
          JSON.stringify({
            skill,
            body: '# Instructions',
            files: ['SKILL.md', 'references/plan.md'],
          }),
        );
        return;
      }
      if (path.pathname === '/library/file') {
        inspectionReads++;
        res.end(JSON.stringify({ content: 'Reference content' }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (!enabled) {
        res.end(JSON.stringify({ error: { message: 'denied' } }));
        return;
      }
      reads++;
      const result =
        request.params.name === 'skills_get'
          ? { skill, body: '# Instructions', files: ['SKILL.md', 'references/plan.md'] }
          : { content: 'Reference content' };
      res.end(
        JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    enabled = true;
    revoked = false;
    outage = false;
    reads = 0;
    inspectionReads = 0;
    requests = 0;
  });
  const provider = () =>
    createFplSkillProvider(user, { FPL_SKILLS_URL: url, FPL_SKILLS_TOKEN: 'fixture' })!;

  it('requires complete configuration and an authenticated OIDC identity', () => {
    expect(createFplSkillProvider(user, {})).toBeUndefined();
    expect(() => createFplSkillProvider(user, { FPL_SKILLS_URL: url })).toThrow();
    expect(() =>
      createFplSkillProvider(user, {
        FPL_SKILLS_URL: 'https://user:secret@example.com',
        FPL_SKILLS_TOKEN: 'fixture',
      }),
    ).toThrow();
    expect(
      createFplSkillProvider(
        { ...user, provider: 'local' },
        { FPL_SKILLS_URL: url, FPL_SKILLS_TOKEN: 'fixture' },
      ),
    ).toBeUndefined();
    expect(requests).toBe(0);
  });

  it('isolates concurrent accounts and binds stable IDs to ownership', async () => {
    const a = provider();
    const b = createFplSkillProvider(
      { ...user, email: 'b@fpl.test', openidId: 'subject-b' },
      { FPL_SKILLS_URL: url, FPL_SKILLS_TOKEN: 'fixture' },
    )!;
    const [first, second] = await Promise.all([a.ids([]), b.ids([])]);
    expect(first.map(String)).toEqual([fplSkillId(skill).toString()]);
    expect(second).toEqual([]);
    expect(fplSkillId({ ...skill, owner_id: 'new-owner' })).not.toEqual(fplSkillId(skill));
    expect(await b.wrap({}).getSkillById!(first[0])).toBeNull();
  });

  it('paginates native and remote skills without skipping or repeating either', async () => {
    const p = provider();
    const nativeId = new Types.ObjectId('123456789012345678901235');
    const native = {
      _id: nativeId,
      name: 'native',
      description: '',
      author: nativeId,
      updatedAt: new Date(1000),
    };
    const methods = p.wrap({
      listSkillsByAccess: async ({
        cursor,
        search,
      }: {
        cursor?: string | null;
        search?: string;
      }) => ({ skills: cursor || search ? [] : [native], has_more: false }),
    });
    const ids = await p.ids([nativeId]);
    const first = await methods.listSkillsByAccess!({ accessibleIds: ids, limit: 1 });
    expect(first.skills[0].name).toBe('native');
    expect(first.has_more).toBe(true);
    const second = await methods.listSkillsByAccess!({
      accessibleIds: ids,
      limit: 1,
      cursor: first.after,
    });
    expect(second.skills[0].source).toBe('fpl');
    expect(second.has_more).toBe(false);
    expect(
      await methods.listSkillsByAccess!({ accessibleIds: ids, limit: 10, search: 'Campaign' }),
    ).toMatchObject({ skills: [{ displayTitle: 'Campaign' }] });
  });

  it('does not count browsing as agent reads and keeps files request scoped', async () => {
    const p = provider();
    const [id] = await p.ids([]);
    const methods = p.wrap({}, false);
    expect((await methods.getSkillById!(id))?.body).toBe('# Instructions');
    expect((await methods.getSkillFileByPath!(id, 'references/plan.md'))?.content).toBe(
      'Reference content',
    );
    expect(reads).toBe(0);
    expect(inspectionReads).toBe(2);
    await expect(methods.getSkillFileByPath!(id, '../secret')).rejects.toThrow('Invalid');
  });

  it('primes manually selected skills through MCP and rechecks disable/revocation', async () => {
    const p = provider();
    const ids = await p.ids([]);
    const methods = p.wrap({}, true);
    const catalog = await methods.listSkillsByAccess!({ accessibleIds: ids, limit: 10 });
    const name = catalog.skills[0].name;
    expect((await methods.getSkillByName!(name, ids))?.body).toBe('# Instructions');
    expect(reads).toBe(1);
    expect(await methods.getSkillByName!(name, [])).toBeNull();
    enabled = false;
    await expect(methods.getSkillByName!(name, ids)).rejects.toThrow('no longer enabled');
    await expect(methods.getSkillFileByPath!(ids[0], 'references/plan.md')).rejects.toThrow();
    expect(reads).toBe(1);
    expect(await provider().ids([])).toEqual([]);
    enabled = true;
    revoked = true;
    await expect(methods.getSkillByName!(name, ids)).rejects.toThrow();
  });

  it('fails visibly during upstream outages and never exposes credentials in errors', async () => {
    outage = true;
    await expect(provider().ids([])).rejects.toThrow('FPL Skills is unavailable');
    await expect(provider().ids([])).rejects.not.toThrow('fixture');
  });
});
