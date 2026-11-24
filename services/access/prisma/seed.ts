import { PrismaPg } from '@prisma/adapter-pg';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../src/generated/prisma/client.js';

config({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith('<')) {
    throw new Error(`Set ${name} in the repository-root .env`);
  }
  return value;
}

const issuer = required('OIDC_ISSUER');
const sidhSubject = required('SEED_SIDH_SUB');
const mayaSubject = required('SEED_MAYA_SUB');

if (sidhSubject === mayaSubject) {
  throw new Error('The two Keycloak user IDs must be different');
}

const ids = {
  organization: '00000000-0000-4000-8000-000000000101',
  sidh: '00000000-0000-4000-8000-000000000102',
  maya: '00000000-0000-4000-8000-000000000103',
  alpha: '00000000-0000-4000-8000-000000000104',
  beta: '00000000-0000-4000-8000-000000000105',
} as const;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: required('DATABASE_URL') }),
});

async function seed(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      for (const person of [
        { id: ids.sidh, subject: sidhSubject, name: 'sidh.dev' },
        { id: ids.maya, subject: mayaSubject, name: 'mayaa.dev' },
      ]) {
        const data = {
          idpIssuer: issuer,
          idpSubject: person.subject,
          displayName: person.name,
          status: 'ACTIVE' as const,
        };

        await tx.principal.upsert({
          where: { id: person.id },
          update: data,
          create: { id: person.id, ...data },
        });
      }

      await tx.organization.upsert({
        where: { id: ids.organization },
        update: { name: 'Capitalflow Demo', status: 'ACTIVE' },
        create: {
          id: ids.organization,
          name: 'Capitalflow Demo',
          status: 'ACTIVE',
        },
      });

      for (const principalId of [ids.sidh, ids.maya]) {
        await tx.organizationMembership.upsert({
          where: {
            organizationId_principalId: {
              organizationId: ids.organization,
              principalId,
            },
          },
          update: { status: 'ACTIVE' },
          create: {
            organizationId: ids.organization,
            principalId,
            status: 'ACTIVE',
          },
        });
      }

      for (const project of [
        { id: ids.alpha, name: 'Project Alpha' },
        { id: ids.beta, name: 'Project Beta' },
      ]) {
        await tx.projectScope.upsert({
          where: { projectId: project.id },
          update: {
            organizationId: ids.organization,
            displayName: project.name,
            status: 'ACTIVE',
          },
          create: {
            projectId: project.id,
            organizationId: ids.organization,
            displayName: project.name,
            status: 'ACTIVE',
          },
        });
      }

      const roleIds = new Map<string, string>();

      for (const definition of [
        {
          key: 'manager',
          description: 'Manages members in a project',
          actions: ['project.read', 'diligence.view', 'member.manage'],
        },
        {
          key: 'executive',
          description: 'Views project and diligence information',
          actions: ['project.read', 'diligence.view'],
        },
        {
          key: 'viewer',
          description: 'Views a project',
          actions: ['project.read'],
        },
      ]) {
        const role = await tx.projectRole.upsert({
          where: { key: definition.key },
          update: { description: definition.description },
          create: {
            key: definition.key,
            description: definition.description,
          },
        });

        roleIds.set(definition.key, role.id);

        for (const actionKey of definition.actions) {
          await tx.rolePermission.upsert({
            where: {
              roleId_actionKey: { roleId: role.id, actionKey },
            },
            update: {},
            create: { roleId: role.id, actionKey },
          });
        }
      }

      for (const fixture of [
        { projectId: ids.alpha, principalId: ids.sidh, role: 'manager' },
        { projectId: ids.beta, principalId: ids.sidh, role: 'executive' },
        { projectId: ids.alpha, principalId: ids.maya, role: 'viewer' },
      ]) {
        const membership = await tx.projectMembership.upsert({
          where: {
            projectId_principalId: {
              projectId: fixture.projectId,
              principalId: fixture.principalId,
            },
          },
          update: { status: 'ACTIVE' },
          create: {
            projectId: fixture.projectId,
            principalId: fixture.principalId,
            status: 'ACTIVE',
          },
        });

        const roleId = roleIds.get(fixture.role);
        if (!roleId) throw new Error(`Missing role: ${fixture.role}`);

        await tx.projectRoleAssignment.upsert({
          where: {
            membershipId_roleId: { membershipId: membership.id, roleId },
          },
          update: {},
          create: { membershipId: membership.id, roleId },
        });
      }
    },
    { timeout: 30_000 },
  );

  console.log('Seed complete: 2 people, 1 organization, 2 projects, 3 project memberships');
}

try {
  await seed();
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}