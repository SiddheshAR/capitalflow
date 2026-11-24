# Day 3: Access database and project roles

This is the working setup guide for Capitalflow's Day 3 Access work. It records the steps completed so far and the checks still needed. For realm, client, browser login, BFF session, and the audience mapper in Keycloak, see [Keycloak and BFF setup](keycloak-setup.md).

## Where we are

- **Done:** Access is configured with an issuer and API audience; Prisma 7 is installed; the Access schema, initial migration, and generated client have been created. The user ran the seed, inspected its rows in Prisma Studio, reran it, and confirmed the counts stayed the same.
- **Still to build:** JWT verification, protected Access routes, BFF proxy routes, and authorization tests are later Day 3 steps.

The Keycloak user called `mayaa.dev` in this environment is the guide's second fictional test user; the local variable remains named `SEED_MAYA_SUB`.

## The ownership boundary

| Component | Responsibility |
| --- | --- |
| Keycloak | Authenticates users and issues signed access tokens. It does not store Capitalflow's project roles. |
| BFF | Holds the browser session and access token on the server side. It will forward the access token to Access. |
| Access | Will verify the token, map its issuer and subject to a local principal, and decide project capabilities. |
| Access PostgreSQL | Stores principals, organization and project memberships, role definitions, permissions, and assignments. |
| Future Deals service | Will own authoritative project records. `project_scopes` in Access are local policy references, not a Projects CRUD system. |

An authenticated Keycloak user is not automatically an enrolled Access user. Access will require a matching active principal and active organization membership before granting project capabilities.

## The Prisma setup in one picture

```text
schema.prisma ── prisma migrate dev ──> migration.sql ──> PostgreSQL tables
       │
       └──────── prisma generate ────> generated TypeScript client
                                              │
root .env ──> prisma7.config.ts ──> CLI       ├──> seed.ts ──> fixture rows
           (database URL, paths, seed)         └──> future Access queries
```

There are two separate outputs from one schema. **Migrate** changes the database structure: tables, columns, foreign keys, and indexes. **Generate** makes TypeScript code that knows how to query that structure. **Seed** runs the generated client to insert example rows. A schema definition alone does not put any data in PostgreSQL, and a generated TypeScript type alone does not create a database table.

## 1. Audience setup and environment

Inside the `investment-dev` realm, the `investment-bff` client's dedicated scope has an **Audience** mapper named `access-api-audience`. Its Included Custom Audience is `investment-access-api`; Included Client Audience is blank; **Add to access token** is on; **Add to ID token** is off. The [Keycloak guide](keycloak-setup.md#7-add-the-access-api-audience-mapper) has the click-by-click instructions.

Access reads its settings from the repository-root `.env`, as configured in [`AppModule`](../services/access/src/app.module.ts). The relevant keys are:

```dotenv
PORT=3001
DATABASE_URL=postgresql://access:<local-password>@127.0.0.1:5433/access
OIDC_ISSUER=http://localhost:8080/realms/investment-dev
OIDC_AUDIENCE=investment-access-api
SEED_SIDH_SUB=<Keycloak user ID for sidh.dev>
SEED_MAYA_SUB=<Keycloak user ID for mayaa.dev>
```

The `SEED_*_SUB` values are Keycloak-generated **user IDs**, not usernames or email addresses. The first identity is `sidh.dev`; the second is `mayaa.dev` with email `mayaa@gmail.com`. Never use the email as proof of identity. Keep actual database passwords and user IDs in the ignored local `.env`, not in this document or Git.

After changing the mapper, start a fresh Keycloak login before testing Access. An existing BFF session may still hold an access token issued before the mapper was added. The later Access API must receive an **access token**, not an ID token.

## 2. Install and initialize Prisma 7

Prisma is the tool used here to define Access tables, generate SQL migrations, and generate a typed TypeScript client. These commands were run from the repository root:

```powershell
cd services/access
pnpm add @prisma/client@7 @prisma/adapter-pg@7
pnpm add -D prisma@7 tsx dotenv
pnpm exec prisma init --datasource-provider postgresql --output ../src/generated/prisma
cd ../..
```

The installed Prisma packages resolve to version 7.10.1 in this checkout. [`schema.prisma`](../services/access/prisma/schema.prisma) is the source of truth for Access's database model. [`prisma7.config.ts`](../services/access/prisma7.config.ts) points Prisma's CLI at the schema, migration directory, seed command, and `DATABASE_URL` in the root `.env`. Its relative `.env` path is `../../.env` because the config file is directly inside `services/access`.

What the packages and files are for:

| Item | Purpose |
| --- | --- |
| `prisma` | Development CLI for `validate`, `migrate dev`, `generate`, and `db seed`. |
| `@prisma/client` | Prisma's runtime library used by the generated client. |
| `@prisma/adapter-pg` and `pg` | Bridge Prisma Client to the PostgreSQL driver at runtime. Prisma 7 requires a driver adapter here. |
| `tsx` | Runs the TypeScript seed file without a manual compile step. |
| `dotenv` | Loads values from the root `.env` into the Prisma config and seed process. |
| `prisma7.config.ts` | CLI instructions: schema location, migration location, seed command, database URL. |
| `schema.prisma` | Models, fields, relations, enums, and database constraints. |
| `prisma/migrations/.../migration.sql` | Versioned SQL that recreates the database structure. |
| `src/generated/prisma` | Generated query methods and TypeScript types; recreated locally and ignored by Git. |

The Nest `ConfigModule` and the Prisma CLI config are separate entry points. Nest loads the root `.env` when Access starts; `prisma7.config.ts` loads it when you run Prisma commands. The seed script loads it again because it runs as a separate process. The `DATABASE_URL` must point to the **Access** database on port `5433`, not Keycloak's database.

`pnpm-workspace.yaml` has build approvals for `@prisma/engines`, `esbuild`, and `prisma`. Prisma's optional AI assistant skill directories were removed; they are not needed for this application.

## 3. Understand the schema

| Prisma model | PostgreSQL table | Meaning and important constraint |
| --- | --- | --- |
| `Principal` | `principals` | Local identity, unique by `(idp_issuer, idp_subject)`. Email is not a key. |
| `Organization` | `organizations` | A company or organization in the local fixture. |
| `OrganizationMembership` | `organization_memberships` | Connects a principal to an organization; unique by `(organization_id, principal_id)`. |
| `ProjectScope` | `project_scopes` | Local policy reference to a future Deals-owned project; `project_id` is its ID. |
| `ProjectMembership` | `project_memberships` | Connects a principal to a project; unique by `(project_id, principal_id)`. |
| `ProjectRole` | `roles` | Defines a reusable role key such as `manager`. |
| `RolePermission` | `role_permissions` | Connects a role to an explicit action key; unique by `(role_id, action_key)`. |
| `ProjectRoleAssignment` | `project_role_assignments` | Attaches a role to a **project membership**, making the role project scoped. Unique by `(membership_id, role_id)`. |

These models use UUID IDs, PostgreSQL foreign keys, status fields, and UTC-capable `timestamptz` fields. The `@map` and `@@map` annotations keep TypeScript names readable while the database uses snake_case. `@relation` links models; `@@unique` prevents duplicate logical records. Prisma validation checks the model structure but does not create tables.

### What “defining types” means here

Prisma's schema language is a blueprint, separate from TypeScript source files. A `model` describes a database entity and later becomes a generated TypeScript model and query API. An `enum` restricts a field to named values. For example, `MembershipStatus` allows `ACTIVE` or `INACTIVE`, so our code does not have to guess whether a stored membership is active.

Consider these fields from the principal model:

```prisma
id          String          @id @default(uuid()) @db.Uuid
idpSubject  String          @map("idp_subject")
displayName String?         @map("display_name")
status      PrincipalStatus @default(ACTIVE)
```

- `String` and `DateTime` are Prisma field types; `String?` means the value may be absent.
- `@id` makes the field the primary key. `@default(uuid())` generates a local ID, while `@db.Uuid` stores it as PostgreSQL's UUID type.
- `idpSubject` is a readable TypeScript field name; `@map("idp_subject")` gives its database column a snake_case name.
- `PrincipalStatus` is an enum, with `ACTIVE` as the default. Later Access logic still has to **check** that status; the type does not grant access by itself.
- `ProjectMembership[]` is a relation field: it lets Prisma navigate from a principal to related memberships. The foreign key is the `principalId` field on `ProjectMembership`, not this array.

The `Principal.id` is a Capitalflow database ID. `Principal.idpSubject` is the Keycloak user ID from the token's `sub` claim. We keep both because they belong to different systems. The `(idpIssuer, idpSubject)` unique constraint lets Access find exactly one local principal for a verified Keycloak identity. Usernames and email addresses are mutable labels, so they are not identity keys.

TypeScript catches mistakes in queries at development time, such as a misspelled field or an invalid enum value. It does **not** prove that an incoming JWT is genuine; signature and claim verification is a later Access step.

For example, after Access verifies a token, the generated client will make a lookup shaped like this possible:

```ts
const principal = await prisma.principal.findUnique({
  where: {
    idpIssuer_idpSubject: {
      idpIssuer: verifiedIssuer,
      idpSubject: verifiedSubject,
    },
  },
});
```

`prisma.principal` and the compound `idpIssuer_idpSubject` selector are generated from the `Principal` model and its `@@unique` rule. They are not handwritten API methods. The lookup alone is not authorization: Access must also check the principal's status and the relevant memberships.

The key relationship is:

```text
Keycloak issuer + subject → Principal
Principal → OrganizationMembership → Organization
Principal → ProjectMembership → ProjectScope
ProjectMembership → ProjectRoleAssignment → ProjectRole → RolePermission action keys
```

For example, a Manager assignment on Sidh's Alpha membership says nothing about his Beta membership. Later, an Access request for Beta must query Beta's membership and assignments specifically.

## 4. Migration and generated client

The schema was validated, then the first migration was created and run from `services/access`:

```powershell
pnpm exec prisma validate
pnpm exec prisma migrate dev --name access_roles
pnpm exec prisma generate
```

The SQL lives under [`prisma/migrations`](../services/access/prisma/migrations). It defines eight tables, uniqueness indexes, and foreign keys. Keep this SQL and the schema in Git: a migration records **how the database changes**, while the schema describes **what it should look like**.

`prisma generate` created TypeScript client files under `services/access/src/generated/prisma`. [`services/access/.gitignore`](../services/access/.gitignore) excludes that generated folder; regenerate it after installing dependencies or changing the schema. Prisma 7 does not automatically generate or seed when `migrate dev` runs.

The migration and generated client solve different problems. If you only migrate, PostgreSQL changes but TypeScript may still use an outdated client. If you only generate, your code knows about fields that might not exist in PostgreSQL yet. After a schema change in this project, review and apply a migration, then generate the client. Commit `schema.prisma` and the migration SQL; the generated client can be rebuilt from them.

`pnpm exec prisma validate` checks schema syntax and relations. `pnpm exec prisma migrate dev --name access_roles` created this first migration and applied it to the local development database. The SQL includes rules such as unique `(project_id, principal_id)` so even buggy code cannot insert a duplicate project membership. Foreign keys prevent membership rows from pointing to nonexistent local principals or scopes.

## 5. Why and how we seed fixtures

The migration creates **empty tables**. A seed adds known example rows so we can test whether project permissions work. Without seed data, a valid Keycloak login would still have no Access principal, organization membership, project membership, or role assignment. That would make every authorization test fail without telling us whether the policy logic works.

The seed command is registered in `prisma7.config.ts` as `tsx prisma/seed.ts`. [`seed.ts`](../services/access/prisma/seed.ts) loads the root `.env`, connects through the Prisma PostgreSQL driver adapter, and writes the fixture inside a transaction. The first run reported `Seed complete: 2 people, 1 organization, 2 projects, 3 project memberships`. The user then checked the rows in Prisma Studio and confirmed a second run did not increase the counts.

| Person | Alpha | Beta |
| --- | --- | --- |
| `sidh.dev` | Manager | Executive |
| `mayaa.dev` | Viewer | No project membership |

| Role key | Action keys |
| --- | --- |
| `manager` | `project.read`, `diligence.view`, `member.manage` |
| `executive` | `project.read`, `diligence.view` |
| `viewer` | `project.read` |

The non-secret fixture IDs in the seed script are:

| Fixture | UUID |
| --- | --- |
| Organization | `00000000-0000-4000-8000-000000000101` |
| Sidh principal | `00000000-0000-4000-8000-000000000102` |
| Mayaa principal | `00000000-0000-4000-8000-000000000103` |
| Project Alpha | `00000000-0000-4000-8000-000000000104` |
| Project Beta | `00000000-0000-4000-8000-000000000105` |

What happens when `pnpm exec prisma db seed` runs:

1. Prisma reads `prisma7.config.ts` and launches `tsx prisma/seed.ts`.
2. The seed loads `DATABASE_URL`, `OIDC_ISSUER`, `SEED_SIDH_SUB`, and `SEED_MAYA_SUB` from the ignored root `.env`. It stops if a required value is missing or both Keycloak IDs are the same.
3. It creates a Prisma Client with the PostgreSQL driver adapter and starts a database transaction. All intended inserts/updates succeed together, or the transaction rolls back.
4. It **upserts** two principals, one organization, and two organization memberships. `upsert` means “update the matching row if it exists; otherwise create it.” Stable fixture IDs and unique constraints make ordinary reruns repeatable.
5. It upserts two project scopes. Their fixed UUIDs stand in for future Deals project IDs; Access does not create an authoritative project here.
6. It upserts three role definitions and six role-to-action mappings. These are application permissions in Access PostgreSQL, not Keycloak realm roles or token claims.
7. It upserts three project memberships and attaches one role to each membership. The assignment is attached to the membership, so Sidh's Manager role in Alpha cannot automatically apply to Beta.
8. It commits the transaction, prints the completion message, and disconnects the client.

The Keycloak subject IDs are local environment values because each developer's Keycloak instance may generate different user IDs. The fixture UUIDs in the script are stable and non-secret so the same project memberships can be queried during development and tests. The current seed is **local demo data**, not an account provisioning or production onboarding process.

**Expected and verified fixture counts:** two principals, one organization, two organization memberships, two project scopes, three project memberships, three roles, six role permissions, and three role assignments. Re-running the seed should leave those counts unchanged.

## Remaining Day 3 work

1. Verify Keycloak Bearer access tokens in Access using remote JWKS. Require valid signature, algorithm, exact issuer, audience `investment-access-api`, time claims, and nonempty subject.
2. Resolve the verified `(issuer, subject)` to an **active** local principal. Deny a valid but unenrolled user; do not create principals automatically from tokens.
3. Add protected Access routes for `/v1/me` and `/v1/projects/:id/capabilities`. Project capability checks must include the requested project ID, principal ID, active memberships, and organization association.
4. Add BFF routes that forward only the server-held access token to Access, then return safe JSON to the browser.
5. Test Alpha/Beta role isolation, nonmembership, missing browser session, and invalid or wrong-audience tokens. Build both services and document the results before pushing the Day 3 branch for review.

See the [Prisma 7 seeding guide](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/seeding) for the `migrations.seed` setting and explicit `db seed` command.
