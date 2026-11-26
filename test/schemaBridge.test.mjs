import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const bridgeModule = await import(join(root, 'out', 'toolSchemaBridge.js'));
const shaping = await import(join(root, 'out', 'cliShaping.js'));

const { ToolSchemaBridge, normalizeLegacyQuestionArgs, canonicalizeToolResult } = bridgeModule;

const readTarget = {
	name: 'read_file',
	inputSchema: {
		type: 'object',
		properties: { filePath: { type: 'string' } },
		required: ['filePath'],
		additionalProperties: false,
	},
};

const viewTarget = {
	name: 'view',
	inputSchema: {
		type: 'object',
		properties: { path: { type: 'string' } },
		required: ['path'],
		additionalProperties: false,
	},
};

const editTarget = {
	name: 'edit',
	inputSchema: {
		type: 'object',
		properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } },
		required: ['path', 'old_str', 'new_str'],
		additionalProperties: false,
	},
};

const createTarget = {
	name: 'create',
	inputSchema: {
		type: 'object',
		properties: { path: { type: 'string' }, file_text: { type: 'string' } },
		required: ['path', 'file_text'],
		additionalProperties: false,
	},
};

const webFetchTarget = {
	name: 'web_fetch',
	inputSchema: {
		type: 'object',
		properties: { url: { type: 'string' }, max_length: { type: 'integer' } },
		required: ['url'],
		additionalProperties: false,
	},
};

const bashTarget = {
	name: 'bash',
	inputSchema: {
		type: 'object',
		properties: { command: { type: 'string' }, description: { type: 'string' } },
		required: ['command'],
		additionalProperties: false,
	},
};

const askUserTarget = {
	name: 'ask_user',
	inputSchema: {
		type: 'object',
		properties: {
			message: { type: 'string' },
			requestedSchema: { type: 'object' },
		},
		required: ['message', 'requestedSchema'],
		additionalProperties: false,
	},
};

const questionTarget = {
	name: 'AskUserQuestion',
	inputSchema: {
		type: 'object',
		properties: {
			questions: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						question: { type: 'string' },
						header: { type: 'string' },
						options: {
							type: 'array',
							items: {
								type: 'object',
								properties: { label: { type: 'string' }, description: { type: 'string' } },
								required: ['label', 'description'],
							},
						},
					},
					required: ['question', 'header', 'options'],
				},
			},
		},
		required: ['questions'],
		additionalProperties: false,
	},
};

test('legacy question args become V2 questions without reading a string schema', () => {
	const normalized = normalizeLegacyQuestionArgs({
		message: 'Pick a purpose',
		requestedSchema: '{"properties":{"purpose":{"type":"string","enum":["security","debug"],"enumNames":["Security","Debug"]}}}',
	});
	assert.equal(normalized.questions.length, 1);
	assert.equal(normalized.questions[0].question, 'Pick a purpose');
	assert.deepEqual(normalized.questions[0].options, [
		{ label: 'Security', description: 'security' },
		{ label: 'Debug', description: 'debug' },
	]);
});

test('malformed legacy schema still yields a usable free-form question', () => {
	const normalized = normalizeLegacyQuestionArgs({
		message: 'Which target?',
		requestedSchema: '{"properties":{"target":{"enum":[\'a\', \'b\']}}}',
	});
	assert.deepEqual(normalized, {
		questions: [{ question: 'Which target?', header: 'Which target?', options: [] }],
	});
});

test('bridge projects canonical read args onto the Copilot schema and back', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [readTarget]);
	const canonical = bridge.canonicalize('read', { path: '/workspace/src' });
	assert.deepEqual(canonical, { name: 'read', input: { path: '/workspace/src' } });

	const target = bridge.findTarget(canonical.name);
	assert.equal(target?.name, 'read_file');
	assert.deepEqual(bridge.toTarget(canonical.name, canonical.input, target), {
		name: 'read_file',
		input: { filePath: '/workspace/src' },
	});
	assert.deepEqual(bridge.toCanonical('read_file', { filePath: '/workspace/src' }), {
		name: 'read',
		input: { path: '/workspace/src' },
	});
});

test('bridge normalizes legacy question calls and projects them onto AskUserQuestion', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [questionTarget]);
	const canonical = bridge.canonicalize('question', {
		message: 'What is the goal?',
		requestedSchema: JSON.stringify({
			properties: {
				purpose: {
					type: 'string',
					enum: ['research', 'debug'],
					enumNames: ['Research', 'Debug'],
				},
			},
		}),
	});
	assert.equal(canonical.name, 'question');
	assert.equal(canonical.input.message, 'What is the goal?');

	const target = bridge.findTarget(canonical.name);
	assert.equal(target?.name, 'AskUserQuestion');
	const projected = bridge.toTarget(canonical.name, canonical.input, target);
	assert.equal(projected.input.questions.length, 1);
	assert.deepEqual(projected.input.questions[0].options, [
		{ label: 'Research', description: 'research' },
		{ label: 'Debug', description: 'debug' },
	]);
});

test('canonical read resolves to the real Copilot view tool', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [viewTarget]);
	const canonical = bridge.canonicalize('read', { path: '/workspace/src' });
	assert.equal(canonical.name, 'read');
	const target = bridge.findTarget(canonical.name);
	assert.equal(target?.name, 'view');
	assert.deepEqual(bridge.toTarget(canonical.name, canonical.input, target), {
		name: 'view',
		input: { path: '/workspace/src' },
	});
});

test('ask_user receives requestedSchema as an object, not a JSON string', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [askUserTarget]);
	const canonical = bridge.canonicalize('ask_user', {
		message: 'Tamam, önce temel amacı netleştirelim',
		requestedSchema: '{"properties":{"purpose":{"type":"string"}}}',
	});
	assert.equal(canonical.name, 'question');
	assert.deepEqual(canonical.input.requestedSchema, {
		properties: { purpose: { type: 'string' } },
	});
	const target = bridge.findTarget(canonical.name);
	assert.equal(target?.name, 'ask_user');
	const projected = bridge.toTarget(canonical.name, canonical.input, target);
	assert.deepEqual(projected, {
		name: 'ask_user',
		input: {
			message: 'Tamam, önce temel amacı netleştirelim',
			requestedSchema: { properties: { purpose: { type: 'string' } } },
		},
	});
});

test('canonical execute resolves to bash and maps code to command', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [bashTarget]);
	const canonical = bridge.canonicalize('execute', { code: 'const a = 1;' });
	assert.deepEqual(canonical, { name: 'execute', input: { code: 'const a = 1;' } });
	const target = bridge.findTarget(canonical.name);
	assert.equal(target?.name, 'bash');
	assert.deepEqual(bridge.toTarget(canonical.name, canonical.input, target), {
		name: 'bash',
		input: { command: 'const a = 1;' },
	});
	assert.deepEqual(bridge.toCanonical('bash', { command: 'const a = 1;' }), {
		name: 'shell',
		input: { command: 'const a = 1;' },
	});
});

test('canonical write resolves to create and maps content to file_text', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [createTarget]);
	const canonical = bridge.canonicalize('write', { path: '/workspace/a.txt', content: 'hello' });
	assert.deepEqual(canonical, { name: 'write', input: { path: '/workspace/a.txt', content: 'hello' } });
	const target = bridge.findTarget(canonical.name);
	assert.equal(target?.name, 'create');
	assert.deepEqual(bridge.toTarget(canonical.name, canonical.input, target), {
		name: 'create',
		input: { path: '/workspace/a.txt', file_text: 'hello' },
	});
	assert.deepEqual(bridge.toCanonical('create', { path: '/workspace/a.txt', file_text: 'hello' }), {
		name: 'write',
		input: { path: '/workspace/a.txt', content: 'hello' },
	});
});

test('canonical patch maps an update to the declared edit tool', () => {
	const patchText = [
		'*** Begin Patch',
		'*** Update File: src/a.ts',
		'@@',
		'-const a = 1;',
		'+const a = 2;',
		'*** End Patch',
	].join('\n');
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [editTarget]);
	const canonical = bridge.canonicalize('patch', { patchText });
	assert.equal(canonical.name, 'patch');
	const target = bridge.findTarget(canonical.name, undefined, canonical.input);
	assert.equal(target?.name, 'edit');
	assert.deepEqual(bridge.toTarget(canonical.name, canonical.input, target), {
		name: 'edit',
		input: { path: 'src/a.ts', old_str: 'const a = 1;', new_str: 'const a = 2;' },
	});
});

test('canonical patch maps an add to create and a delete to bash', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [createTarget, bashTarget]);
	const addText = ['*** Begin Patch', '*** Add File: notes.txt', '+hello', '*** End Patch'].join('\n');
	const add = bridge.canonicalize('patch', { patchText: addText });
	const create = bridge.findTarget(add.name, undefined, add.input);
	assert.equal(create?.name, 'create');
	assert.deepEqual(bridge.toTarget(add.name, add.input, create), {
		name: 'create',
		input: { path: 'notes.txt', file_text: 'hello' },
	});

	const deleteText = ['*** Begin Patch', '*** Delete File: notes.txt', '*** End Patch'].join('\n');
	const del = bridge.canonicalize('patch', { patchText: deleteText });
	const bash = bridge.findTarget(del.name, undefined, del.input);
	assert.equal(bash?.name, 'bash');
	assert.deepEqual(bridge.toTarget(del.name, del.input, bash), {
		name: 'bash',
		input: { command: 'rm -- "notes.txt"' },
	});
});

test('patch operation type overrides the bound edit client', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [editTarget, createTarget]);
	const patchText = ['*** Begin Patch', '*** Add File: notes.txt', '+hello', '*** End Patch'].join('\n');
	const canonical = bridge.canonicalize('patch', { patchText });
	const target = bridge.findTarget(canonical.name, 'edit', canonical.input);
	assert.equal(target?.name, 'create');
	assert.deepEqual(bridge.toTarget(canonical.name, canonical.input, target), {
		name: 'create',
		input: { path: 'notes.txt', file_text: 'hello' },
	});
});

test('canonical websearch falls back to web_fetch with a search URL', () => {
	const bridge = new ToolSchemaBridge(shaping.officialToolParameters(), [webFetchTarget]);
	const canonical = bridge.canonicalize('websearch', { query: 'vscode copilot tools' });
	assert.deepEqual(canonical, { name: 'websearch', input: { query: 'vscode copilot tools' } });
	const target = bridge.findTarget(canonical.name);
	assert.equal(target?.name, 'web_fetch');
	assert.deepEqual(bridge.toTarget(canonical.name, canonical.input, target), {
		name: 'web_fetch',
		input: { url: 'https://html.duckduckgo.com/html/?q=vscode%20copilot%20tools' },
	});
});

test('tool result outputs are normalized to canonical text results', () => {
	assert.deepEqual(canonicalizeToolResult({ type: 'json', value: { ok: true } }), {
		type: 'text',
		value: '{\n  "ok": true\n}',
	});
	assert.deepEqual(
		canonicalizeToolResult({ type: 'content', value: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }),
		{ type: 'text', value: 'one\ntwo' }
	);
});
