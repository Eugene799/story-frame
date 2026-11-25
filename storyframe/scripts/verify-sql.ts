import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/**
 * Applies every migration to a real PostgreSQL engine (PGlite: PostgreSQL
 * compiled to WebAssembly) and asserts the ownership behaviour the server and
 * its tests rely on: the revision trigger, row-level security, write grants,
 * optimistic-concurrency filters, and the cascades.
 *
 * No Supabase project, network, or credentials are involved. This proves the
 * SQL itself; PostgREST behaviour is covered separately by the test fakes.
 */
const MIGRATIONS = [
  "20261124090000_create_ai_usage.sql",
  "20261124100000_add_ai_usage_idempotency.sql",
  "20261124120000_create_projects.sql",
  "20261124140000_create_project_children.sql",
  "20261124150000_create_profiles.sql",
  "20261124160000_create_media_storage.sql",
  "20261125120000_create_planning.sql",
];
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "44444444-4444-4444-8444-444444444444";
const PROJECT_B = "55555555-5555-4555-8555-555555555555";

const DOCUMENT = {
  schemaVersion: 1,
  summary: "A courier finds a letter that was never meant to arrive.",
  scenes: [{ id: "scene-1", heading: "INT. TRAIN CAR - NIGHT", body: "The letter waits under a seat." }],
};
const REVISED_DOCUMENT = { ...DOCUMENT, summary: "The letter was meant for the courier." };

/** One row per child table, keyed to a project. `key` keeps object names unique. */
const CHILD_ROWS = [
  {
    table: "scenes",
    sql: `insert into public.scenes (project_id, owner_id, scene_key, position, heading)
          values ($1, $2, 'scene-1', 0, 'INT. TRAIN CAR - NIGHT')`,
    params: (_key: string) => [],
  },
  {
    table: "media_metadata",
    sql: `insert into public.media_metadata (project_id, owner_id, kind, object_key, content_type, byte_size)
          values ($1, $2, 'image', $3, 'image/png', 1024)`,
    params: (key: string) => [key],
  },
  {
    table: "sources",
    sql: `insert into public.sources (project_id, owner_id, kind, title, url)
          values ($1, $2, 'web', 'A source', 'https://example.com/source')`,
    params: (_key: string) => [],
  },
  {
    table: "claims",
    sql: `insert into public.claims (project_id, owner_id, statement)
          values ($1, $2, 'A claim worth checking')`,
    params: (_key: string) => [],
  },
  {
    table: "generation_proposals",
    sql: `insert into public.generation_proposals (project_id, owner_id, model_id, prompt, proposal)
          values ($1, $2, 'gemma4:31b', 'Write the opening scene', '{"scenes":[]}'::jsonb)`,
    params: (_key: string) => [],
  },
  {
    table: "provider_jobs",
    sql: `insert into public.provider_jobs (project_id, owner_id, provider)
          values ($1, $2, 'json2video')`,
    params: (_key: string) => [],
  },
  {
    table: "render_snapshots",
    sql: `insert into public.render_snapshots (project_id, owner_id, project_revision, output_key)
          values ($1, $2, 1, $3)`,
    params: (key: string) => [key],
  },
];

const results: { name: string; ok: boolean }[] = [];

function check(name: string, condition: unknown, detail = ""): void {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${detail}`}`);
}

/** `jsonb` reorders keys, so compare documents by content, not by key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const db = new PGlite();

async function as<T extends Record<string, unknown>>(
  role: string,
  sub: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.exec(`set role ${role}`);
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub ?? ""]);
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

async function count(
  table: string,
  where: string,
  params: unknown[],
  role = "service_role",
  sub: string | null = null,
): Promise<number> {
  const rows = await as<{ n: number }>(role, sub, `select count(*)::int as n from public.${table} where ${where}`, params);
  return rows[0].n;
}

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "NO_ERROR";
  } catch (error) {
    return String((error as { code?: string }).code ?? (error as Error).message);
  }
}

console.log((await db.query<{ version: string }>("select version()")).rows[0].version);

// A Supabase-shaped environment: roles, auth schema, auth.users, auth.uid().
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  insert into auth.users (id) values ('${USER_A}'), ('${USER_B}');
`);

for (const name of MIGRATIONS) {
  await db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  console.log(`applied ${name}`);
}

// 1. Inserting a project writes revision 1 through the trigger.
await as("service_role", null,
  `insert into public.projects (id, owner_id, project_type, title, schema_version, document, version)
   values ($1, $2, 'story', 'The Late Letter', 1, $3::jsonb, 1)`,
  [PROJECT_A, USER_A, JSON.stringify(DOCUMENT)]);
let revisions = await as<Record<string, unknown>>("service_role", null,
  `select owner_id, revision, schema_version, title, document
     from public.project_revisions where project_id = $1`,
  [PROJECT_A]);
check("trigger wrote exactly one revision on insert", revisions.length === 1, JSON.stringify(revisions));
check("revision 1 carries the owner, version and document of the row",
  revisions[0]?.revision === 1 &&
    revisions[0]?.owner_id === USER_A &&
    revisions[0]?.schema_version === 1 &&
    revisions[0]?.title === "The Late Letter" &&
    canonical(revisions[0]?.document) === canonical(DOCUMENT),
  JSON.stringify(revisions[0]));

// 2. RLS: each account reads only its own rows.
check("owner reads their own project row",
  (await as("authenticated", USER_A, "select id from public.projects")).length === 1);
check("another account reads no projects",
  (await as("authenticated", USER_B, "select id from public.projects")).length === 0);
check("another account reads no revisions",
  (await as("authenticated", USER_B, "select id from public.project_revisions")).length === 0);

// 3. RLS plus grants: browsers cannot write, even their own rows.
check("authenticated insert is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    `insert into public.projects (owner_id, project_type, title, schema_version, document)
     values ($1, 'story', 'x', 1, '{}'::jsonb)`, [USER_A]))) === "42501");
check("authenticated update is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    "update public.projects set title = 'hijacked' where id = $1", [PROJECT_A]))) === "42501");
check("authenticated delete is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    "delete from public.projects where id = $1", [PROJECT_A]))) === "42501");
check("anon select is refused (42501)",
  (await errorCode(() => as("anon", "", "select count(*) from public.projects"))) === "42501");

// 4. Conditional update appends revision 2 and leaves revision 1 alone.
const updated = await as<{ version: number }>("service_role", null,
  `update public.projects set title = $2, document = $3::jsonb, schema_version = 1, version = version + 1
   where id = $1 and owner_id = $4 and version = 1 returning version`,
  [PROJECT_A, "The Late Letter (revised)", JSON.stringify(REVISED_DOCUMENT), USER_A]);
check("conditional update matched the row and bumped the version",
  updated.length === 1 && updated[0].version === 2, JSON.stringify(updated));
revisions = await as<Record<string, unknown>>("service_role", null,
  `select revision, title, document from public.project_revisions where project_id = $1 order by revision`,
  [PROJECT_A]);
check("update appended revision 2", revisions.length === 2 && revisions[1]?.revision === 2, JSON.stringify(revisions));
check("revision 1 keeps the original document",
  canonical(revisions[0]?.document) === canonical(DOCUMENT), JSON.stringify(revisions[0]));
check("revision 2 holds the revised document",
  revisions[1]?.title === "The Late Letter (revised)" &&
    canonical(revisions[1]?.document) === canonical(REVISED_DOCUMENT), JSON.stringify(revisions[1]));

// 5. A stale version writes nothing (the store's conflict path).
const stale = await as("service_role", null,
  `update public.projects set title = 'stale', version = version + 1
   where id = $1 and owner_id = $2 and version = 1 returning id`, [PROJECT_A, USER_A]);
check("stale version updates zero rows", stale.length === 0);
check("stale version appended no revision",
  (await count("project_revisions", "project_id = $1", [PROJECT_A])) === 2);

// 6. Owner filters protect rows the caller does not own.
const foreignDelete = await as("service_role", null,
  "delete from public.projects where id = $1 and owner_id = $2 returning id", [PROJECT_A, USER_B]);
check("delete filtered by the wrong owner removes nothing", foreignDelete.length === 0);

// 7. Constraints.
check("unknown project_type is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.projects (owner_id, project_type, title, schema_version, document)
     values ($1, 'novel', 'x', 1, '{}'::jsonb)`, [USER_A]))) === "23514");
check("non-object document is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.projects (owner_id, project_type, title, schema_version, document)
     values ($1, 'story', 'x', 1, '"scalar"'::jsonb)`, [USER_A]))) === "23514");
check("duplicate (project_id, revision) is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.project_revisions (project_id, owner_id, revision, schema_version, title, document)
     values ($1, $2, 1, 1, 'dup', '{}'::jsonb)`, [PROJECT_A, USER_A]))) === "23505");

// 8. Every child table follows the same ownership pattern.
for (const child of CHILD_ROWS) {
  const key = `objects/${PROJECT_A}/${child.table}`;
  const params = [PROJECT_A, USER_A, ...child.params(key)];
  await as("service_role", null, child.sql, params);

  check(`${child.table}: owner reads their row`,
    (await count(child.table, "project_id = $1", [PROJECT_A], "authenticated", USER_A)) === 1);
  check(`${child.table}: another account reads nothing`,
    (await count(child.table, "project_id = $1", [PROJECT_A], "authenticated", USER_B)) === 0);
  check(`${child.table}: authenticated write is refused (42501)`,
    (await errorCode(() => as("authenticated", USER_A, child.sql,
      [PROJECT_A, USER_A, ...child.params(`${key}-denied`)]))) === "42501");
}

// 8b. Phase 3: media references follow the same pattern and cascade.
const mediaRows = await as<{ id: string }>("service_role", null,
  "select id from public.media_metadata where project_id = $1 limit 1", [PROJECT_A]);
await as("service_role", null,
  `insert into public.media_references (media_id, project_id, owner_id, ref_kind, ref_id)
   values ($1, $2, $3, 'scene', 'scene-1')`, [mediaRows[0].id, PROJECT_A, USER_A]);
check("media_references: owner reads their reference",
  (await count("media_references", "project_id = $1", [PROJECT_A], "authenticated", USER_A)) === 1);
check("media_references: another account reads nothing",
  (await count("media_references", "project_id = $1", [PROJECT_A], "authenticated", USER_B)) === 0);
check("media_references: authenticated write is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    `insert into public.media_references (media_id, project_id, owner_id, ref_kind, ref_id)
     values ($1, $2, $3, 'scene', 'scene-2')`, [mediaRows[0].id, PROJECT_A, USER_A]))) === "42501");
check("media_references: duplicate reference is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.media_references (media_id, project_id, owner_id, ref_kind, ref_id)
     values ($1, $2, $3, 'scene', 'scene-1')`, [mediaRows[0].id, PROJECT_A, USER_A]))) === "23505");
check("media_metadata: upload timestamps default to null",
  (await as<{ ok: boolean }>("service_role", null,
    `select (upload_expires_at is null and ready_at is null and deleted_at is null) as ok
       from public.media_metadata where project_id = $1`, [PROJECT_A]))[0].ok === true);

// 8c. Phase 5: planning evidence columns, proposal routing metadata, model health.
check("sources: an excerpt is optional and bounded",
  (await as<{ ok: boolean }>("service_role", null,
    `select (excerpt is null) as ok from public.sources where project_id = $1`, [PROJECT_A]))[0].ok === true);
check("claims: a supporting quote is optional",
  (await as<{ ok: boolean }>("service_role", null,
    `select (supporting_quote is null) as ok from public.claims where project_id = $1`, [PROJECT_A]))[0].ok === true);
check("generation_proposals: existing rows default to the legacy route and version 1",
  (await as<{ route: string; base_version: number }>("service_role", null,
    `select route, base_version from public.generation_proposals where project_id = $1`, [PROJECT_A]))
    .every((row) => row.route === "legacy" && row.base_version === 1));
check("generation_proposals: an unknown route is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.generation_proposals (project_id, owner_id, model_id, prompt, proposal, route)
     values ($1, $2, 'gemma4:31b', 'x', '{}'::jsonb, 'ranking')`, [PROJECT_A, USER_A]))) === "23514");
check("generation_proposals: a base version below 1 is rejected (23514)",
  (await errorCode(() => as("service_role", null,
    `insert into public.generation_proposals (project_id, owner_id, model_id, prompt, proposal, base_version)
     values ($1, $2, 'gemma4:31b', 'x', '{}'::jsonb, 0)`, [PROJECT_A, USER_A]))) === "23514");

await as("service_role", null,
  `insert into public.model_health (model_id, last_success_at, success_count)
   values ('gemma', now(), 1)`);
check("model_health: the service role reads the registry",
  (await count("model_health", "model_id = 'gemma'", [])) === 1);
check("model_health: an authenticated read is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A, "select count(*) from public.model_health"))) === "42501");
check("model_health: a duplicate model id is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.model_health (model_id) values ('gemma')`))) === "23505");

check("render_snapshots rejects a revision that does not exist (23503)",
  (await errorCode(() => as("service_role", null,
    `insert into public.render_snapshots (project_id, owner_id, project_revision)
     values ($1, $2, 99)`, [PROJECT_A, USER_A]))) === "23503");

// 9. Profiles are one workspace per user, with the same owner pattern.
await as("service_role", null,
  `insert into public.profiles (owner_id, display_name, workspace_name)
   values ($1, 'User A', 'A workspace')`, [USER_A]);
check("owner reads their own profile",
  (await count("profiles", "owner_id = $1", [USER_A], "authenticated", USER_A)) === 1);
check("another account reads no profile",
  (await count("profiles", "owner_id = $1", [USER_A], "authenticated", USER_B)) === 0);
check("authenticated write to profiles is refused (42501)",
  (await errorCode(() => as("authenticated", USER_A,
    `insert into public.profiles (owner_id, workspace_name) values ($1, 'hijacked')`, [USER_B]))) === "42501");
check("a second profile for the same user is rejected (23505)",
  (await errorCode(() => as("service_role", null,
    `insert into public.profiles (owner_id, workspace_name) values ($1, 'second')`, [USER_A]))) === "23505");

// 10. Deleting a project cascades revisions and every child row.
await as("service_role", null, "delete from public.projects where id = $1 and owner_id = $2", [PROJECT_A, USER_A]);
check("deleting the project removed its revisions",
  (await count("project_revisions", "project_id = $1", [PROJECT_A])) === 0);
for (const child of CHILD_ROWS) {
  check(`deleting the project removed its ${child.table} rows`,
    (await count(child.table, "project_id = $1", [PROJECT_A])) === 0);
}
check("deleting the project removed its media references",
  (await count("media_references", "project_id = $1", [PROJECT_A])) === 0);

// 11. Deleting the auth user cascades projects, revisions, child rows and the profile.
await as("service_role", null,
  `insert into public.projects (id, owner_id, project_type, title, schema_version, document)
   values ($1, $2, 'repurpose', 'Owned By B', 1, $3::jsonb)`,
  [PROJECT_B, USER_B, JSON.stringify(DOCUMENT)]);
for (const child of CHILD_ROWS) {
  const key = `objects/${PROJECT_B}/${child.table}`;
  await as("service_role", null, child.sql, [PROJECT_B, USER_B, ...child.params(key)]);
}
await as("service_role", null,
  `insert into public.profiles (owner_id, workspace_name) values ($1, 'B workspace')`, [USER_B]);
await db.exec(`delete from auth.users where id = '${USER_B}'`);
check("deleting the auth user removed their projects",
  (await count("projects", "owner_id = $1", [USER_B])) === 0);
check("deleting the auth user removed their revisions",
  (await count("project_revisions", "owner_id = $1", [USER_B])) === 0);
for (const child of CHILD_ROWS) {
  check(`deleting the auth user removed their ${child.table} rows`,
    (await count(child.table, "owner_id = $1", [USER_B])) === 0);
}
check("deleting the auth user removed their profile",
  (await count("profiles", "owner_id = $1", [USER_B])) === 0);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
