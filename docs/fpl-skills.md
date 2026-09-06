# FPL Skills in LibreChat

The native Skills catalog and `$` picker include enabled FPL skills when the
server is configured with the FPL provider. Nothing is imported into MongoDB or
copied into saved prompts. Existing native, deployment, and GitHub-synced skills
continue through their existing implementations.

## Configuration

Set these on the LibreChat backend, never the frontend:

```dotenv
FPL_SKILLS_URL=http://fpl-skills:8793
FPL_SKILLS_TOKEN=<existing Skills MCP gateway service token>
```

The connection requires an authenticated OpenID user with an email and subject.
Identity comes from `req.user`, not browser headers or submitted company IDs.
FPL Skills resolves current company membership through SSO on every upstream
request. Keep this service on the private application network.

Preserve the normal LibreChat gates: Skills USE permission, the `skills` agent
capability, and the agent/conversation skills toggle. Persistent agents may still
narrow the catalog using their skill allowlist. Selecting a skill in a temporary
chat uses the existing composer behavior to enable skills for that turn.

Build/deploy the updated FPL Skills service before LibreChat. The service update
adds authenticated `/library/file` inspection and file lists/counts. Preserve
its existing SQLite state volume and SSO identity credentials. Then build the
LibreChat data-provider, API, and frontend using the normal image pipeline and
configure the two backend environment variables above. No SSO release is needed.

## Behavior

- Catalog metadata is shared only within one authenticated request, not cached
  across users. The picker refreshes on mounting, focus, and reconnect.
- Stable synthetic IDs include the FPL owner type, owner ID, and skill ID.
  Machine names have an FPL namespace and ID suffix; the picker shows the normal
  skill title. This keeps native and remote name collisions distinguishable.
- FPL enables/disables are authoritative. Managed skills are read-only even to
  LibreChat admins, and their detail view links to SSO for management.
- Manual priming and model-invoked reads use the existing FPL MCP tools, so
  authorization and enabled state are rechecked at read time. New skill content
  is fetched on the next load without a LibreChat rebuild or sync job.
- Browser body/file inspection does not increment agent-read metrics. Actual
  successful MCP reads do; they do not prove execution or successful outcomes.
- FPL skills are not forced into every message. Existing native skill discovery
  and per-agent activation rules remain in effect.
- The current FPL file API is text-only. This adapter does not introduce binary
  asset transport, automatic script execution, remote authoring, or installation.

## Verification

From the repository root after building `@librechat/api`:

```sh
node scripts/fpl-skills-check.mjs
```

This runs the actual FPL Skills HTTP/MCP implementation with temporary state and
a fixture identity endpoint, then exercises LibreChat's native manual resolver.
It checks inspection versus agent-read counts, disabling after selection, and
fresh membership revocation. It does not contact production or an LLM.

Focused suites cover the provider, native catalog pagination, Express routes
with real MongoDB, agent initialization, and composer/permission behavior.
The Edgerunner JSON type and React prop errors found during validation were fixed
in a separate release commit. The repository-wide client typecheck now passes.

Rollback: remove both FPL provider environment variables and restore the prior
LibreChat image. Retain the FPL state volume. Native LibreChat skills remain
available; stale FPL selections cannot load remote instructions without the
provider.
