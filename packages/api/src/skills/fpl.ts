import { z } from 'zod';
import crypto from 'crypto';
import { Readable } from 'stream';
import { Types } from 'mongoose';
import type {
  DeploymentSkillBaseMethods,
  SkillSummaryRow,
  SkillId,
  SkillFileRow,
} from './deployment';
import {
  decodeCursor,
  isAfterCursor,
  mergeSkillPage,
  getDbPageBoundary,
  limitRowsToDbPageBoundary,
} from './deployment';

const prefix = 'f910';
const summarySchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1),
  description: z.string(),
  owner_type: z.enum(['user', 'company', 'global']),
  owner_id: z.string().nullable(),
  status: z.string(),
  valid: z.boolean(),
  enabled: z.boolean(),
  file_count: z.number().int().nonnegative().optional(),
});
const librarySchema = z.object({ schema_version: z.literal(1), skills: z.array(summarySchema) });
const detailSchema = z.object({
  skill: summarySchema.pick({ id: true, owner_type: true, owner_id: true }),
  body: z.string(),
  files: z.array(z.string()).optional(),
});
type Summary = z.infer<typeof summarySchema>;
type Identity = { id: string; email?: string; provider?: string; openidId?: string };
export interface FplSkillProvider {
  wrap<T extends DeploymentSkillBaseMethods>(
    methods: T,
    runtime?: boolean,
  ): T & DeploymentSkillBaseMethods;
  ids(ids: Types.ObjectId[]): Promise<Types.ObjectId[]>;
  getDownloadStream(filepath: string, runtime?: boolean): Promise<Readable>;
}

export function isFplSkillId(id: SkillId): boolean {
  return /^f910[0-9a-f]{20}$/.test(id.toString());
}

export function fplSkillId(skill: {
  id: string;
  owner_type: string;
  owner_id: string | null;
}): Types.ObjectId {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify([skill.owner_type, skill.owner_id, skill.id]))
    .digest('hex');
  return new Types.ObjectId(prefix + digest.slice(0, 20));
}

/** A provider belongs to one authenticated request, never a process-wide identity cache. */
export function createFplSkillProvider(
  user: Identity | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FplSkillProvider | undefined {
  const raw = env.FPL_SKILLS_URL;
  const token = env.FPL_SKILLS_TOKEN;
  if (!raw && !token) return undefined;
  if (!raw || !token) throw new Error('FPL Skills requires URL and service token');
  const base = new URL(raw);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('Invalid FPL Skills URL');
  }
  if (!user?.email || user.provider !== 'openid' || !user.openidId) return undefined;
  const author = new Types.ObjectId(user.id);
  const email = user.email;
  const subject = user.openidId;
  const epoch = new Date(0);
  let catalog: Promise<Summary[]> | undefined;

  async function request(path: string, body?: object) {
    try {
      const response = await fetch(new URL(path, base), {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'x-fpl-user-email': email,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as object;
    } catch {
      throw new Error('FPL Skills is unavailable or access was denied');
    }
  }

  async function rpc(name: string, args: object) {
    const response = z
      .object({
        result: z.object({
          content: z.array(z.object({ type: z.literal('text'), text: z.string() })).length(1),
        }),
      })
      .safeParse(
        await request('/mcp', {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      );
    if (!response.success) throw new Error('FPL skill is unavailable or no longer enabled');
    return JSON.parse(response.data.result.content[0].text) as object;
  }

  function list() {
    catalog ??= request('/library').then((value) =>
      librarySchema
        .parse(value)
        .skills.filter((skill) => skill.enabled && skill.valid && skill.status === 'active'),
    );
    return catalog;
  }

  async function find(id: SkillId) {
    return (await list()).find((skill) => fplSkillId(skill).equals(id.toString()));
  }

  function row(skill: Summary): SkillSummaryRow {
    const id = fplSkillId(skill);
    return {
      _id: id,
      name: `fpl-${skill.id}-${id.toString().slice(-8)}`,
      displayTitle: skill.name,
      description: skill.description,
      author:
        skill.owner_type === 'user' && [subject, email].includes(skill.owner_id ?? '')
          ? author
          : new Types.ObjectId(prefix.padEnd(24, '0')),
      authorName: 'FPL Skills',
      version: 1,
      source: 'fpl',
      sourceMetadata: { managed: true, skillId: skill.id },
      fileCount: skill.file_count ?? 0,
      alwaysApply: false,
      isPublic: false,
      createdAt: epoch,
      updatedAt: epoch,
    };
  }

  async function detail(skill: Summary, runtime: boolean) {
    const result = detailSchema.parse(
      runtime
        ? await rpc('skills_get', { id: skill.id, include_files: true })
        : await request(`/library/skill?id=${encodeURIComponent(skill.id)}`),
    );
    if (!fplSkillId(result.skill).equals(fplSkillId(skill))) {
      throw new Error('FPL skill ownership changed; refresh the catalog');
    }
    return {
      ...row(skill),
      body: result.body,
      version: 1,
      fileCount: result.files?.filter((path) => path !== 'SKILL.md').length ?? 0,
    };
  }

  async function file(skill: Summary, relativePath: string, runtime: boolean) {
    if (
      !relativePath ||
      relativePath.includes('\\') ||
      relativePath.split('/').some((part) => !part || part === '..' || part === '.')
    ) {
      throw new Error('Invalid FPL skill file path');
    }
    const result = z
      .object({ content: z.string() })
      .parse(
        runtime
          ? await rpc('skills_read_file', { id: skill.id, path: relativePath })
          : await request(
              `/library/file?id=${encodeURIComponent(skill.id)}&path=${encodeURIComponent(relativePath)}`,
            ),
      );
    return result.content;
  }

  function fileRow(skill: Summary, relativePath: string): SkillFileRow {
    const id = fplSkillId(skill);
    return {
      _id: new Types.ObjectId(
        crypto.createHash('sha256').update(`${id}/${relativePath}`).digest('hex').slice(0, 24),
      ),
      skillId: id,
      relativePath,
      file_id: `${id}/${relativePath}`,
      filename: relativePath.split('/').pop()!,
      filepath: JSON.stringify([id.toString(), relativePath]),
      source: 'fpl',
      mimeType: 'text/plain',
      bytes: 0,
      category: 'reference',
      isExecutable: false,
      author,
      createdAt: epoch,
      updatedAt: epoch,
    };
  }

  function wrap<T extends DeploymentSkillBaseMethods>(methods: T, runtime = false) {
    const wrapped: DeploymentSkillBaseMethods = {
      ...methods,
      getSkillById: async (id) => {
        if (!isFplSkillId(id)) return methods.getSkillById?.(id) ?? null;
        const skill = await find(id);
        return skill ? detail(skill, runtime) : null;
      },
      getSkillByName: async (name, ids, options) => {
        const skill = (await list()).find((candidate) => row(candidate).name === name);
        if (!skill)
          return (
            methods.getSkillByName?.(
              name,
              ids.filter((id) => !isFplSkillId(id)),
              options,
            ) ?? null
          );
        return ids.some((id) => id.equals(fplSkillId(skill))) ? detail(skill, true) : null;
      },
      listSkillsByAccess: async (params) => {
        const result = (await methods.listSkillsByAccess?.({
          ...params,
          accessibleIds: params.accessibleIds.filter((id) => !isFplSkillId(id)),
        })) ?? { skills: [], has_more: false };
        const ids = new Set(params.accessibleIds.map(String));
        const rows = (await list())
          .map(row)
          .filter(
            (item) =>
              ids.has(item._id.toString()) &&
              (!params.category || item.category === params.category) &&
              (!params.search ||
                `${item.name} ${item.displayTitle} ${item.description}`
                  .toLowerCase()
                  .includes(params.search.toLowerCase())) &&
              isAfterCursor(item, decodeCursor(params.cursor)),
          );
        const boundary = getDbPageBoundary(result);
        return mergeSkillPage({
          dbResult: result,
          dbPageBoundary: boundary,
          deploymentRows: limitRowsToDbPageBoundary(rows, boundary),
          limit: params.limit,
        });
      },
      listAlwaysApplySkills: (params) =>
        methods.listAlwaysApplySkills?.({
          ...params,
          accessibleIds: params.accessibleIds.filter((id) => !isFplSkillId(id)),
        }) ?? Promise.resolve({ skills: [], has_more: false }),
      listSkillFiles: async (id) => {
        if (!isFplSkillId(id)) return methods.listSkillFiles?.(id) ?? [];
        const skill = await find(id);
        if (!skill) return [];
        const result = detailSchema.parse(
          await request(`/library/skill?id=${encodeURIComponent(skill.id)}`),
        );
        return (result.files ?? [])
          .filter((path) => path !== 'SKILL.md')
          .map((path) => fileRow(skill, path));
      },
      getSkillFileByPath: async (id, path) => {
        if (!isFplSkillId(id)) return methods.getSkillFileByPath?.(id, path) ?? null;
        const skill = await find(id);
        if (!skill) return null;
        const content = await file(skill, path, runtime);
        return {
          ...fileRow(skill, path),
          content,
          bytes: Buffer.byteLength(content),
          isBinary: false,
        };
      },
      updateSkillFileContent: async (id, path, update) => {
        if (isFplSkillId(id)) return;
        return methods.updateSkillFileContent?.(id, path, update);
      },
      updateSkillFileCodeEnvIds: (updates) =>
        methods.updateSkillFileCodeEnvIds?.(
          updates.filter((update) => !isFplSkillId(update.skillId)),
        ) ?? Promise.resolve(),
    };
    return { ...methods, ...wrapped };
  }

  return {
    wrap,
    ids: async (ids: Types.ObjectId[]) => [...ids, ...(await list()).map(fplSkillId)],
    getDownloadStream: async (filepath: string, runtime = false) => {
      const [id, path] = z.tuple([z.string(), z.string()]).parse(JSON.parse(filepath));
      const skill = await find(id);
      if (!skill) throw new Error('FPL skill is unavailable');
      return Readable.from([await file(skill, path, runtime)]);
    },
  };
}
