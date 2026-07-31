'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../shared/backend-core.cjs');
const {
 CARRIED_FIELDS,
 INTENT_FIELDS,
 normalizeAgentTemplate,
 agentToTemplateDraft,
} = require('../shared/agentTemplates.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migrationName = '20260731150000_agent_resource_classification.sql';

test('agent purpose and resource facets exist in every required schema location', () => {
 const runtime = read('server/index.cjs');
 const canonical = read('database/neon-schema.sql');
 const migration = read(`supabase/migrations/${migrationName}`);

 assert.ok(Number(migrationName.slice(0, 14)) > 20260731130000);
 for (const [place, source] of Object.entries({ runtime, canonical, migration })) {
  assert.match(source, /workspace_agents[\s\S]*purpose text NOT NULL DEFAULT 'collaborator'/, `${place} agent purpose`);
  assert.match(source, /workspace_agents[\s\S]*resource_facets jsonb NOT NULL DEFAULT '\[\]'/, `${place} agent facets`);
  assert.match(source, /workspace_agent_templates[\s\S]*purpose text NOT NULL DEFAULT 'collaborator'/, `${place} template purpose`);
  assert.match(source, /workspace_agent_templates[\s\S]*resource_facets jsonb NOT NULL DEFAULT '\[\]'/, `${place} template facets`);
 }
});

test('resource facets use the shared jsonb bind path in both backends', () => {
 assert.equal(core.JSON_COLUMNS_BY_TABLE.workspace_agents.has('resource_facets'), true);
 assert.equal(core.JSON_COLUMNS_BY_TABLE.workspace_agent_templates.has('resource_facets'), true);
});

test('new resources default out of ambient replies without affecting explicit choices', () => {
 const resource = core.applyAgentPurposeInsertDefaults('workspace_agents', {
  purpose: 'resource',
  resource_facets: ['code'],
 });
 assert.equal(resource.ambient_replies, false);
 assert.equal(core.applyAgentPurposeInsertDefaults('workspace_agents', {
  purpose: 'resource',
  ambient_replies: true,
 }).ambient_replies, true);
 assert.deepEqual(
  core.applyAgentPurposeInsertDefaults('workspace_agents', { purpose: 'collaborator' }),
  { purpose: 'collaborator' },
 );

 const fly = read('server/index.cjs');
 const netlify = read('netlify/functions/backend.mjs');
 assert.match(fly, /app\.post\('\/backend\/db\/insert'[\s\S]*applyAgentPurposeInsertDefaults\(table, next\)/);
 assert.match(netlify, /pathname === '\/backend\/db\/insert'[\s\S]*applyAgentPurposeInsertDefaults\(table, next\)/);
});

test('template intent is carried but remains closed and non-authoritative', () => {
 assert.deepEqual(INTENT_FIELDS, ['purpose', 'resourceFacets']);
 assert.equal(CARRIED_FIELDS.includes('purpose'), true);
 assert.equal(CARRIED_FIELDS.includes('resourceFacets'), true);

 const resource = normalizeAgentTemplate({
  name: 'Code Handler',
  purpose: 'resource',
  resourceFacets: ['code', 'tooling', 'code'],
 });
 assert.equal(resource.ok, true, resource.errors.join('; '));
 assert.deepEqual(resource.template.resourceFacets, ['tooling', 'code']);
 assert.equal('permission_mode' in resource.template, false);
 assert.equal('metadata' in resource.template, false);

 assert.equal(normalizeAgentTemplate({
  name: 'Empty Resource', purpose: 'resource', resourceFacets: [],
 }).ok, false);
 assert.equal(normalizeAgentTemplate({
  name: 'Misclassified', purpose: 'collaborator', resourceFacets: ['code'],
 }).ok, false);
 assert.equal(normalizeAgentTemplate({
  name: 'Unknown Facet', purpose: 'resource', resourceFacets: ['network'],
 }).ok, false);
});

test('saving an existing resource as a template preserves intent and no authority', () => {
 const draft = agentToTemplateDraft({
  name: 'Code Handler',
  handle: 'code-handler',
  purpose: 'resource',
  resource_facets: ['code', 'tooling'],
  permission_mode: 'yolo',
  metadata: { host_folders: ['/'] },
 });
 assert.equal(draft.purpose, 'resource');
 assert.deepEqual(draft.resourceFacets, ['tooling', 'code']);
 assert.equal('permission_mode' in draft, false);
 assert.equal('metadata' in draft, false);
});
