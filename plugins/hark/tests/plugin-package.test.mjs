import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const portableRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codexRoot = path.resolve(portableRoot, '..');

async function readPortableJson(name) {
  return JSON.parse(await readFile(path.join(portableRoot, name), 'utf8'));
}

async function readCodexJson(name) {
  return JSON.parse(await readFile(path.join(codexRoot, name), 'utf8'));
}

test('portable package targets one exact Agent Plugins v1 contract', async () => {
  const plugin = await readPortableJson('plugin.json');
  const codex = await readCodexJson('.codex-plugin/plugin.json');
  const mcp = await readPortableJson('mcp.json');
  assert.equal(
    plugin.$schema,
    'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  );
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.equal(plugin.name, 'hark');
  assert.equal(plugin.version, '0.1.5');
  assert.equal(codex.version, '0.1.5');
  assert.equal(plugin.repository, 'https://github.com/Dexter-DAO/hark-plugin');
  assert.equal(codex.repository, 'https://github.com/Dexter-DAO/hark-plugin');
  assert.match(plugin.description, /Requires a certified host adapter/);
  assert.equal(plugin.extensions, undefined);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['hark']);
});

test('Hark 0.1.5 keeps the independently versioned Hermes adapter at 0.1.0', async () => {
  const repositoryRoot = path.resolve(codexRoot, '..');
  const [pluginYaml, pyproject, packageInit] = await Promise.all([
    readFile(path.join(repositoryRoot, 'packages/hermes-hark/plugin.yaml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'packages/hermes-hark/pyproject.toml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'packages/hermes-hark/hark_hermes/__init__.py'), 'utf8'),
  ]);
  assert.match(pluginYaml, /^version: 0\.1\.0$/mu);
  assert.match(pyproject, /^version = "0\.1\.0"$/mu);
  assert.match(packageInit, /^__version__ = "0\.1\.0"$/mu);
});

test('portable MCP resolves bundled code through the plugin root', async () => {
  const mcp = await readPortableJson('mcp.json');
  assert.deepEqual(mcp.mcpServers.hark, {
    type: 'stdio',
    command: 'node',
    args: ['${PLUGIN_ROOT}/mcp/server.mjs'],
    cwd: '${PLUGIN_ROOT}',
  });
  await readFile(path.join(portableRoot, 'mcp', 'server.mjs'), 'utf8');
});

test('Codex wrapper points into one bundled portable Hark implementation', async () => {
  const codex = await readCodexJson('.codex-plugin/plugin.json');
  const mcp = await readCodexJson('.mcp.json');
  const hooks = await readCodexJson('hooks/hooks.json');
  assert.equal(codex.skills, './hark/skills/');
  assert.equal(codex.mcpServers, './.mcp.json');
  assert.equal(codex.hooks, './hooks/hooks.json');
  assert.match(codex.interface.shortDescription, /continue the same Codex task/);
  assert.match(codex.interface.longDescription, /same originating Codex turn/);
  assert.doesNotMatch(codex.interface.longDescription, /supervisor resume/i);
  assert.doesNotMatch(codex.interface.defaultPrompt.join('\n'), /pause this task/i);
  for (const relative of [codex.skills, codex.mcpServers, codex.hooks]) {
    assert.equal(path.resolve(codexRoot, relative).startsWith(`${codexRoot}${path.sep}`), true);
  }
  assert.deepEqual(mcp.mcpServers.hark.args, ['./hark/mcp/server.mjs']);
  assert.equal(mcp.mcpServers.hark.required, true);
  assert.equal(mcp.mcpServers.hark.supports_parallel_tool_calls, false);
  assert.deepEqual(mcp.mcpServers.hark.enabled_tools, ['hark_await']);
  assert.equal(mcp.mcpServers.hark.default_tools_approval_mode, 'approve');
  assert.equal(mcp.mcpServers.hark.tool_timeout_sec, 31536000);
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'mcp__hark__hark_await');
  assert.equal(hooks.hooks.PostToolUse[0].matcher, 'mcp__hark__hark_await');
  await readFile(path.join(codexRoot, 'hark', 'mcp', 'server.mjs'), 'utf8');
});

test('portable root stays Agent Plugins v1 and cannot shadow Codex native hooks', async () => {
  await assert.rejects(readFile(path.join(portableRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  await assert.rejects(readFile(path.join(portableRoot, '.mcp.json'), 'utf8'));
});

test('portable instructions expose one held-call product instead of a prepare-and-resume ritual', async () => {
  const [readme, skill] = await Promise.all([
    readFile(path.join(portableRoot, 'README.md'), 'utf8'),
    readFile(path.join(portableRoot, 'skills', 'hark-await', 'SKILL.md'), 'utf8'),
  ]);
  for (const document of [readme, skill]) {
    assert.match(document, /hark_await/);
    assert.doesNotMatch(document, /hark_await_prepare/);
    assert.doesNotMatch(document, /End the turn cleanly after preparing/i);
  }
  assert.match(readme, /same tool call in the same Codex\s+turn/);
  assert.match(readme, /## Install once/);
  assert.match(readme, /Cursor support is discovery-only/);
  assert.doesNotMatch(readme, /\.cursor\/plugins\/local/);
  assert.match(skill, /The tool call itself waits/);
  assert.match(skill, /portable-core-only installation cannot bind a trustworthy Await/);
  assert.match(skill, /hark\.await-satisfied\.v1/);
});
