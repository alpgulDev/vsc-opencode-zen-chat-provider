import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const gatewayConfig = await import(join(root, 'out', 'gatewayConfig.js'));
const gatewayRoutes = await import(join(root, 'out', 'gatewayRoutes.js'));
const identity = await import(join(root, 'out', 'identity.js'));
const shaping = await import(join(root, 'out', 'cliShaping.js'));
const toolRenames = await import(join(root, 'out', 'toolRenames.js'));
const usage = await import(join(root, 'out', 'usage.js'));

const ID_PATTERN = /^(ses|msg)_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

test('canonical IDs use the CLI descending/ascending layout', () => {
	assert.match(identity.sessionId(), ID_PATTERN);
	assert.match(identity.messageId(), ID_PATTERN);

	const timestamp = 1_765_000_000_000;
	const down = identity.create(true, timestamp);
	const up = identity.create(false, timestamp);
	assert.equal(down.length, 26);
	assert.equal(up.length, 26);
	assert.equal(
		BigInt(`0x${down.slice(0, 12)}`) + BigInt(`0x${up.slice(0, 12)}`),
		2n ** 48n
	);
});

test('static assets match the captured OpenCode 2.x blobs', () => {
	const prompt = readFileSync(join(root, 'out', 'assets', 'opencode-prompt-v2.txt'));
	const tools = readFileSync(join(root, 'out', 'assets', 'opencode-tools-v2.json'));
	const blobHash = (data) => createHash('sha1')
		.update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]))
		.digest('hex');
	assert.equal(blobHash(prompt), 'daff28574b70f656b2aaed8cb29185eed9cfd75b');
	assert.equal(blobHash(tools), 'c1c148209765b7961dab08873455bd92c32f91fb');
	assert.equal(prompt.toString('utf8').startsWith(shaping.CLI_PROMPT_MARKER), true);
});

test('manifest is the byte-stable 13-tool CLI set', () => {
	const manifest = shaping.officialManifest();
	assert.equal(manifest.length, 13);
	assert.deepEqual(manifest.map((tool) => tool.function.name), [...shaping.OFFICIAL_TOOL_ORDER]);
	assert.equal(manifest.every((tool) => tool.function.strict === false), true);
});

test('preamble contains the CLI prompt, env block and skills', () => {
	const environment = {
		workingDirectory: '/workspace',
		workspaceRoot: '/workspace',
		platform: 'linux',
		isGitRepo: true,
	};
	const preamble = shaping.cliPreamble('opencode/claude-sonnet-4-5', '/workspace', new Date('2026-11-25T00:00:00Z'), environment);
	assert.equal(preamble.startsWith(shaping.CLI_PROMPT_MARKER), true);
	assert.match(preamble, /You are powered by the model named claude-sonnet-4-5/);
	assert.match(preamble, /<env>\n {2}Working directory: \/workspace\n {2}Workspace root folder: \/workspace\n {2}Is directory a git repo: yes\n {2}Platform: linux/);
	assert.match(preamble, /Today's date: Wed Nov 25 2026/);
	assert.match(preamble, /<available_skills>/);

	const unknown = shaping.cliPreamble('claude-sonnet-4-5', '/workspace', new Date('2026-11-25T00:00:00Z'), {});
	assert.match(unknown, /Working directory: unknown/);
	assert.match(unknown, /Is directory a git repo: unknown/);
	assert.match(unknown, /Platform: unknown/);
});

test('client tools get opaque stable aliases', () => {
	const first = shaping.clientToolWireName('get_weather');
	assert.match(first, /^mcp_[0-9a-f]{12}$/);
	assert.equal(first, shaping.clientToolWireName('get_weather'));
	assert.notEqual(first, shaping.clientToolWireName('weather_get'));
});

test('project IDs use the CLI derivation rather than fresh random values', () => {
	assert.equal(shaping.projectId('global'), 'global');
	const commit = 'a'.repeat(40);
	assert.equal(shaping.projectId(commit), commit);
	const expected = createHash('sha256').update('opencode-project\0/workspace').digest('hex').slice(0, 40);
	assert.equal(shaping.projectId('/workspace'), expected);
	assert.equal(shaping.projectId('/workspace'), shaping.projectId('/workspace'));
	assert.notEqual(shaping.projectId('/workspace'), shaping.projectId('/other'));
	const workdir = shaping.projectForWorkdir(process.cwd());
	assert.match(workdir, /^(?:global|[0-9a-f]{40})$/);
	assert.equal(workdir, shaping.projectForWorkdir(process.cwd()));
});

test('CLI headers match the v2 set and omit request/org headers', () => {
	const context = {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'claude-sonnet-4-5',
		workdir: '/workspace',
	};
	const headers = shaping.buildCliHeaders(context);
	assert.deepEqual(Object.keys(headers).sort(), [
		'User-Agent',
		'X-Session-Id',
		'x-opencode-client',
		'x-opencode-project',
		'x-opencode-session',
		'x-opencode-session-id',
		'x-session-affinity',
	].sort());
	assert.equal(headers['User-Agent'], 'opencode/latest/2.4.1/cli');
	assert.equal(headers['x-opencode-client'], 'cli');
	assert.equal(headers['x-opencode-project'], context.projectId);
	assert.equal(Object.values(headers).filter((v) => v.startsWith('ses_')).length, 4);
	assert.equal('x-opencode-request' in headers, false);
	assert.equal('x-opencode-org-id' in headers, false);
	assert.deepEqual(shaping.buildCliHeaders({ ...context, modelId: 'gpt-5' }), headers);
});

test('chat body is shaped with manifest, aliases and rewritten history', () => {
	const body = {
		model: 'claude-sonnet-4-5',
		messages: [
			{ role: 'system', content: 'Be brief.' },
			{
				role: 'assistant',
				tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{}' } }],
			},
			{ role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
		],
		tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather now', parameters: {} } }],
		tool_choice: { type: 'function', function: { name: 'get_weather' } },
	};
	const { body: shaped, aliases } = shaping.shapeChatBody(body, {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'claude-sonnet-4-5',
		workdir: '/workspace',
	});
	const alias = shaping.clientToolWireName('get_weather');
	assert.equal(aliases.get(alias), 'get_weather');
	assert.equal(shaped.tools.length, 14);
	assert.equal(shaped.tools[0].function.name, alias);
	assert.equal(shaped.tools[0].function.description.includes('\u00a0'), true);
	assert.deepEqual(shaped.tools.slice(1).map((tool) => tool.function.name), [...shaping.OFFICIAL_TOOL_ORDER]);
	assert.equal(shaped.messages.length, 3);
	assert.equal(shaped.messages[0].content.startsWith(shaping.CLI_PROMPT_MARKER), true);
	assert.match(shaped.messages[0].content, /\n\nBe brief\.$/);
	assert.equal(shaped.messages[1].tool_calls[0].function.name, alias);
	assert.equal(shaped.messages[2].tool_call_id, 'call_1');
	assert.equal(shaped.tool_choice.function.name, alias);
	assert.equal(shaped.stream, true);
	assert.equal(shaped.max_completion_tokens, 32_000);
	assert.equal(shaped.stream_options.include_usage, true);
	assert.equal(body.tools[0].function.name, 'get_weather');
});

test('title requests keep the preamble but skip the manifest', () => {
	const body = {
		model: 'claude-sonnet-4-5',
		messages: [
			{ role: 'system', content: 'You generate a descriptive title for this conversation.' },
			{ role: 'user', content: 'Fix the login bug' },
		],
	};
	assert.equal(shaping.isTitleGenerationRequest(body), true);
	const { body: shaped } = shaping.shapeChatBody(body, {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'claude-sonnet-4-5',
		workdir: '/workspace',
	});
	assert.equal('tools' in shaped, false);
	assert.equal(shaped.messages[0].content.startsWith(shaping.CLI_PROMPT_MARKER), true);
});

test('explicit client_environment is validated, consumed and rendered', () => {
	const body = {
		model: 'claude-sonnet-4-5',
		messages: [{ role: 'user', content: 'hello' }],
		client_environment: {
			working_directory: '/repo',
			workspace_root: '/repo',
			platform: 'Windows',
			is_git_repo: false,
		},
	};
	const { body: shaped } = shaping.shapeChatBody(body, {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'claude-sonnet-4-5',
		workdir: '/workspace',
	});
	assert.equal('client_environment' in shaped, false);
	assert.match(shaped.messages[0].content, /Working directory: \/repo/);
	assert.match(shaped.messages[0].content, /Workspace root folder: \/repo/);
	assert.match(shaped.messages[0].content, /Is directory a git repo: no/);
	assert.match(shaped.messages[0].content, /Platform: win32/);

	const invalid = { ...body, client_environment: { unsupported: true } };
	assert.throws(
		() => shaping.shapeChatBody(invalid, { sessionId: 'ses_x', projectId: 'a'.repeat(40), modelId: 'm', workdir: '/workspace' }),
		/unsupported field/
	);
});

test('native env and Codex environment declarations drive the prompt', () => {
	const context = {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'claude-sonnet-4-5',
		workdir: '/workspace',
	};
	const native = shaping.shapeChatBody({
		model: 'claude-sonnet-4-5',
		messages: [
			{
				role: 'developer',
				content: '<env>\nWorking directory: /native\nWorkspace root folder: /native\nIs directory a git repo: yes\nPlatform: darwin\n</env>',
			},
			{ role: 'user', content: 'hello' },
		],
	}, context).body;
	assert.match(native.messages[0].content, /Working directory: \/native/);
	assert.match(native.messages[0].content, /Is directory a git repo: yes/);
	assert.match(native.messages[0].content, /Platform: darwin/);

	const codex = shaping.shapeChatBody({
		model: 'claude-sonnet-4-5',
		messages: [{
			role: 'user',
			content: '<environment_context><cwd>/codex</cwd><workspace_root>/codex</workspace_root><platform>linux</platform><is_git_repo>false</is_git_repo></environment_context>',
		}],
	}, context).body;
	assert.match(codex.messages[0].content, /Working directory: \/codex/);
	assert.match(codex.messages[0].content, /Is directory a git repo: no/);
	assert.match(codex.messages[0].content, /Platform: linux/);

	const conflicting = shaping.shapeChatBody({
		model: 'claude-sonnet-4-5',
		messages: [
			{ role: 'developer', content: '<env>\nWorking directory: /a\n</env>' },
			{ role: 'developer', content: '<env>\nWorking directory: /b\n</env>' },
			{ role: 'user', content: 'hello' },
		],
	}, context).body;
	assert.match(conflicting.messages[0].content, /Working directory: unknown/);
	assert.equal(conflicting.messages[0].content.includes('/workspace'), false);
});

test('all system and developer instructions fold into one system message', () => {
	const { body: shaped } = shaping.shapeChatBody({
		model: 'claude-sonnet-4-5',
		messages: [
			{ role: 'system', content: 'SYS one' },
			{ role: 'developer', content: 'DEV two' },
			{ role: 'user', content: 'hello' },
		],
	}, {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'claude-sonnet-4-5',
		workdir: '/workspace',
	});
	assert.equal(shaped.messages.length, 2);
	assert.equal(shaped.messages[0].role, 'system');
	assert.match(shaped.messages[0].content, /\n\nSYS one\nDEV two$/);
	assert.equal(shaped.messages[1].role, 'user');
});

test('ToolRenames restores exact, folded and official names without guessing ambiguities', () => {
	const { ToolRenames, foldToolName, officialToolCandidates } = toolRenames;
	assert.equal(foldToolName('ToDo_Write'), 'todowrite');
	assert.deepEqual(officialToolCandidates('question'), ['AskUserQuestion']);

	const renames = new ToolRenames();
	renames.add('TodoWrite', 'mcp_aaa');
	assert.equal(renames.wire('TodoWrite'), 'mcp_aaa');
	assert.equal(renames.client('mcp_aaa'), 'TodoWrite');
	assert.equal(renames.resolve('mcp_aaa'), 'TodoWrite');
	assert.equal(renames.resolve('todowrite'), 'TodoWrite');
	assert.equal(renames.resolve('todo_write'), 'TodoWrite');
	assert.equal(renames.resolve('mcp_unknown'), 'unknown');

	const ambiguous = new ToolRenames();
	ambiguous.add('foo_bar', 'mcp_111');
	ambiguous.add('foo-bar', 'mcp_222');
	assert.equal(ambiguous.resolve('fooBAR'), 'fooBAR');
	assert.equal(ambiguous.resolve('foobar'), 'foobar');
	assert.equal(ambiguous.hasLongerPrefix('mcp_'), true);
	assert.equal(ambiguous.hasPrefix('mcp_11'), true);

	const official = new ToolRenames();
	official.add('read_file', 'mcp_read');
	official.bindOfficial('read', 'read_file');
	assert.equal(official.resolve('read'), 'read_file');
});

test('tool aliases collide into suffixed names within the wire limit', () => {
	const used = new Set();
	const first = shaping.clientToolWireName('collide', used);
	const second = shaping.clientToolWireName('collide', used);
	assert.equal(first, shaping.clientToolWireName('collide'));
	assert.equal(second, `${first}_2`);
	assert.equal(second.length <= 64, true);
	assert.equal(shaping.clientToolWireName('x'.repeat(200), new Set()).length <= 64, true);
});

test('request renames bind official tool aliases', () => {
	const renames = shaping.buildToolRenames(['Read', 'get_weather']);
	assert.equal(renames.resolve(shaping.clientToolWireName('get_weather')), 'get_weather');
	assert.equal(renames.resolve('read'), 'Read');
});

test('official edit resolves to the Copilot inline edit tool with candidate priority', () => {
	const renames = shaping.buildToolRenames(['replace_string_in_file']);
	const alias = shaping.clientToolWireName('replace_string_in_file');
	assert.equal(renames.resolve('edit'), 'replace_string_in_file');
	assert.equal(renames.resolve('Edit'), 'replace_string_in_file');
	assert.equal(renames.resolve(alias), 'replace_string_in_file');

	const multiple = shaping.buildToolRenames(['insert_edit_into_file', 'replace_string_in_file']);
	assert.equal(multiple.resolve('edit'), 'replace_string_in_file');

	const { body } = shaping.shapeChatBody({
		model: 'big-pickle',
		messages: [
			{
				role: 'assistant',
				tool_calls: [{ id: 'call_edit', function: { name: 'edit', arguments: '{}' } }],
			},
			{ role: 'tool', tool_call_id: 'call_edit', content: 'ok' },
		],
		tools: [{
			type: 'function',
			function: { name: 'replace_string_in_file', description: 'Replace', parameters: { type: 'object' } },
		}],
	}, {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'big-pickle',
		workdir: '/workspace',
	});
	assert.equal(body.tools.length, 14);
	assert.equal(body.messages[1].tool_calls[0].function.name, alias);
	assert.equal(body.messages[2].tool_call_id, 'call_edit');
});

test('unknown tool history is dropped with its result and known history is rewritten', () => {
	const { body: shaped, aliases } = shaping.shapeChatBody({
		model: 'claude-sonnet-4-5',
		messages: [
			{ role: 'assistant', tool_calls: [
				{ id: 'keep', function: { name: 'get_weather', arguments: '{}' } },
				{ id: 'drop', function: { name: 'old_vendor_tool', arguments: '{}' } },
			] },
			{ role: 'tool', tool_call_id: 'keep', content: 'sunny' },
			{ role: 'tool', tool_call_id: 'drop', content: 'stale' },
		],
		tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: {} } }],
	}, {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'claude-sonnet-4-5',
		workdir: '/workspace',
	});
	const alias = shaping.clientToolWireName('get_weather');
	assert.equal(aliases.get(alias), 'get_weather');
	assert.equal(shaped.messages.length, 3);
	assert.equal(shaped.messages[0].role, 'system');
	assert.equal(shaped.messages[1].tool_calls.length, 1);
	assert.equal(shaped.messages[1].tool_calls[0].function.name, alias);
	assert.equal(shaped.messages[2].tool_call_id, 'keep');
});

test('chat body keys follow the 2.x client order', () => {
	const { body: shaped } = shaping.shapeChatBody({
		model: 'claude-sonnet-4-5',
		tool_choice: 'auto',
		messages: [{ role: 'user', content: 'hello' }],
	}, {
		sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
		projectId: 'a'.repeat(40),
		modelId: 'claude-sonnet-4-5',
		workdir: '/workspace',
	});
	assert.deepEqual(Object.keys(shaped), [
		'model', 'messages', 'tools', 'stream', 'stream_options', 'max_completion_tokens', 'tool_choice',
	]);
	assert.deepEqual([...shaping.V2_CHAT_KEY_ORDER], [
		'model', 'messages', 'tools', 'stream', 'stream_options', 'max_completion_tokens',
	]);
});

test('fetch wrapper shapes headers and body on the wire', async () => {
	let captured;
	const server = createServer((request, response) => {
		let raw = '';
		request.on('data', (chunk) => { raw += chunk; });
		request.on('end', () => {
			captured = { headers: request.headers, body: JSON.parse(raw) };
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"ok":true}');
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const cliFetch = shaping.createCliFetch({
			sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
			projectId: 'a'.repeat(40),
			modelId: 'claude-sonnet-4-5',
			workdir: '/workspace',
		});
		const response = await cliFetch(`http://127.0.0.1:${server.address().port}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer public' },
			body: JSON.stringify({
				model: 'claude-sonnet-4-5',
				messages: [{ role: 'user', content: 'hello' }],
				tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: {} } }],
			}),
		});
		assert.equal(response.status, 200);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	assert.equal(captured.headers['x-opencode-client'], 'cli');
	assert.equal(captured.headers['user-agent'], shaping.CLI_USER_AGENT);
	assert.equal(captured.headers['authorization'], 'Bearer public');
	assert.equal(captured.headers['x-opencode-request'], undefined);
	assert.equal(captured.body.tools.length, 14);
	assert.equal(captured.body.messages[0].role, 'system');
	assert.match(captured.body.messages[0].content, new RegExp(`^${shaping.CLI_PROMPT_MARKER}`));
});

test('fetch wrapper leaves non-chat provider bodies untouched', async () => {
	let captured;
	const server = createServer((request, response) => {
		let raw = '';
		request.on('data', (chunk) => { raw += chunk; });
		request.on('end', () => {
			captured = JSON.parse(raw);
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"ok":true}');
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const cliFetch = shaping.createCliFetch({
			sessionId: 'ses_0123456789abcABCDEFGHIJKLMN',
			projectId: 'a'.repeat(40),
			modelId: 'claude-sonnet-4-5',
			workdir: '/workspace',
			shapeBody: false,
		});
		const response = await cliFetch(`http://127.0.0.1:${server.address().port}/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer public' },
			body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello' }] }),
		});
		assert.equal(response.status, 200);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	assert.deepEqual(captured, { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello' }] });
});

test('source no longer contains manual API key or random VS Code IDs', () => {
	for (const file of ['provider.ts', 'extension.ts', 'zenClient.ts']) {
		const text = readFileSync(join(root, 'src', file), 'utf8');
		assert.equal(text.includes('randomUUID'), false, `${file} still uses randomUUID`);
		assert.equal(text.includes('setApiKey'), false, `${file} still uses setApiKey`);
	}
	const oauth = readFileSync(join(root, 'src', 'oauth.ts'), 'utf8');
	assert.match(oauth, /https:\/\/opencode\.ai\/console/);
	assert.match(oauth, /urn:ietf:params:oauth:grant-type:device_code/);
	assert.match(oauth, /REFRESH_MARGIN_MS = 300_000/);
	assert.match(oauth, /getJson<\{ id: string; email: string \}>\(/);
	assert.match(oauth, /getJson<Array<\{ id: string; name: string \}>>\(/);
	assert.match(oauth, /'user-agent': CLI_USER_AGENT/);
	assert.match(oauth, /\}, undefined, signal, false\);/);
	assert.match(oauth, /CONSOLE_REQUEST_TIMEOUT_MS = 20_000/);
	assert.match(oauth, /OpenCode Console verification URL/);
	assert.equal(oauth.includes("method: body ? 'POST' : 'GET'"), false);

	const extension = readFileSync(join(root, 'src', 'extension.ts'), 'utf8');
	assert.equal(extension.includes('output.clear()'), false);

	const handler = readFileSync(join(root, 'gateway', 'internal', 'transport', 'handler.go'), 'utf8');
	assert.match(handler, /Header\.Set\("authorization", upstreamAuthorization\)/);
	assert.equal(handler.includes('"Bearer "+upstreamKey'), false);

	const registry = readFileSync(join(root, 'src', 'modelRegistry.ts'), 'utf8');
	assert.match(registry, /model\.cost\?\.input === 0/);
	assert.match(registry, /anonymous\?: boolean/);

	const shapingSource = readFileSync(join(root, 'src', 'cliShaping.ts'), 'utf8');
	assert.equal(shapingSource.includes('x-opencode-request'), false);
	assert.equal(shapingSource.includes('x-opencode-org-id'), false);
	assert.match(shapingSource, /project === 'global'/);
	assert.match(shapingSource, /opencode-project\\0/);
	assert.equal(shapingSource.includes('randomBytes'), false);

	const clientSource = readFileSync(join(root, 'src', 'zenClient.ts'), 'utf8');
	assert.match(clientSource, /QUOTA_ERROR_MARKERS/);
	assert.match(clientSource, /export function isQuotaError/);
	assert.match(clientSource, /retry-after/);
	assert.equal(clientSource.includes('retryRequest'), false);
	assert.match(clientSource, /if \(part\.type === 'reasoning-delta'\) \{\s*continue;\s*\}/);
	assert.match(clientSource, /callbacks\.onUsage\?\.\(usage\)/);
	assert.match(clientSource, /includeUsage: true/);
});

test('AI SDK usage normalizes into the Copilot token payload', () => {
	const normalized = usage.normalizeUsage({
		inputTokens: 128,
		outputTokens: 32,
		totalTokens: 160,
		inputTokenDetails: { cacheReadTokens: 64, cacheWriteTokens: 16 },
		outputTokenDetails: { reasoningTokens: 8 },
		raw: { model: 'big-pickle' },
	});
	assert.deepEqual(normalized, {
		promptTokens: 128,
		completionTokens: 32,
		totalTokens: 160,
		cachedTokens: 64,
		cacheWriteTokens: 16,
		reasoningTokens: 8,
	});
	assert.deepEqual(usage.toCopilotUsage(normalized), {
		prompt_tokens: 128,
		completion_tokens: 32,
		total_tokens: 160,
		prompt_tokens_details: { cached_tokens: 64, cache_creation_input_tokens: 16 },
		completion_tokens_details: { reasoning_tokens: 8 },
	});
	assert.equal(usage.VSCODE_USAGE_MIME_TYPE, 'usage');
});

test('raw provider usage is normalized and negative sentinels are clamped', () => {
	const normalized = usage.normalizeUsage({
		raw: {
			prompt_tokens: -1,
			completion_tokens: 5,
			prompt_tokens_details: { cached_tokens: -8 },
		},
	});
	assert.deepEqual(normalized, {
		promptTokens: 0,
		completionTokens: 5,
		totalTokens: 5,
		cachedTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
	});
	assert.deepEqual(usage.toCopilotUsage(normalized), {
		prompt_tokens: 0,
		completion_tokens: 5,
		total_tokens: 5,
		prompt_tokens_details: { cached_tokens: 0 },
	});
	assert.equal(usage.normalizeUsage(undefined), undefined);
});

test('discovered routes prefer the Go lane and map to official SDK packages', () => {
	const routes = {
		go: { 'model-a': { model_id: 'go-a', protocol: 'chat', base_url: 'https://opencode.ai/inference/go/openai' } },
		zen: { 'model-a': { model_id: 'zen-a', protocol: 'responses', base_url: 'https://opencode.ai/inference/openai' } },
		fetchedAt: Date.now(),
	};
	const resolved = gatewayRoutes.findGatewayRoute(routes, 'model-a-go');
	assert.equal(resolved.plan, 'go');
	assert.equal(resolved.route.model_id, 'go-a');
	assert.equal(gatewayRoutes.providerBaseUrl(resolved.route), 'https://opencode.ai/inference/go/openai/v1');
	assert.equal(gatewayRoutes.sdkPackageForProtocol('chat'), '@ai-sdk/openai-compatible');
	assert.equal(gatewayRoutes.sdkPackageForProtocol('responses'), '@ai-sdk/openai');
	assert.equal(gatewayRoutes.sdkPackageForProtocol('anthropic'), '@ai-sdk/anthropic');
	assert.equal(gatewayRoutes.findGatewayRoute(routes, 'missing'), undefined);
});

test('gateway route resolver fetches console config with OAuth and caches it', async () => {
	const payload = {
		providers: {
			go: {
				package: 'aisdk:@ai-sdk/openai-compatible',
				settings: { baseURL: 'https://opencode.ai/inference/go' },
				models: { 'model-a': { modelID: 'go-a' } },
			},
		},
	};
	const calls = [];
	const storage = new Map();
	const resolver = new gatewayRoutes.GatewayRouteResolver(
		{
			get: (key) => storage.get(key),
			update: async (key, value) => { storage.set(key, value); },
		},
		async () => ({ access: 'access-token', refresh: 'refresh-token', expires: Date.now() + 60_000, server: 'https://opencode.ai/console', orgID: 'org_123' }),
		async (url, init) => {
			calls.push({ url, headers: init.headers });
			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				json: async () => payload,
			};
		}
	);
	const resolved = await resolver.resolve('model-a-go');
	assert.equal(resolved.plan, 'go');
	assert.equal(resolved.route.base_url, 'https://opencode.ai/inference/go/openai');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://opencode.ai/console/api/v2/config');
	assert.equal(calls[0].headers.authorization, 'Bearer access-token');
	assert.equal(calls[0].headers['user-agent'], shaping.CLI_USER_AGENT);
	assert.equal(calls[0].headers['x-org-id'], 'org_123');
	assert.equal((await resolver.refresh()).fetchedAt > 0, true);
	assert.equal(calls.length, 1);
});

test('gateway OAuth route normalization only accepts official plan roots', () => {
	const normalize = gatewayConfig.normalizeBaseForPlan;
	assert.equal(normalize('https://opencode.ai/inference/go', 'chat', 'go'), 'https://opencode.ai/inference/go/openai');
	assert.equal(normalize('https://opencode.ai/inference/go/openai/v1', 'chat', 'go'), 'https://opencode.ai/inference/go/openai');
	assert.equal(normalize('https://opencode.ai/inference/go', 'anthropic', 'go'), 'https://opencode.ai/inference/go/anthropic');
	assert.equal(normalize('https://opencode.ai/inference', 'chat', 'zen'), 'https://opencode.ai/inference/openai');
	assert.equal(normalize('https://opencode.ai/zen/v1', 'responses', 'zen'), 'https://opencode.ai/zen');
	assert.equal(normalize('https://opencode.ai/inference/go', 'chat', 'zen'), undefined);
	assert.equal(normalize('https://evil.example/inference/go', 'chat', 'go'), undefined);
	assert.equal(normalize('https://opencode.ai/inference/go?x=1', 'chat', 'go'), undefined);
});

test('gateway route discovery resolves official remote config and drops ambiguous aliases', () => {
	const payload = {
		providers: {
			first: {
				package: 'aisdk:@ai-sdk/openai-compatible',
				settings: { baseURL: 'https://opencode.ai/inference/go' },
				models: {
					'model-a': { modelID: 'go-a', disabled: false },
					'model-b': { package: 'aisdk:@ai-sdk/anthropic', settings: { baseURL: 'https://opencode.ai/inference/go' } },
					'model-c': { modelID: 'c', package: 'unsupported-provider' },
				},
			},
			second: {
				package: 'aisdk:@ai-sdk/openai-compatible',
				settings: { baseURL: 'https://opencode.ai/inference/go' },
				models: {
					'model-a': { modelID: 'different', disabled: false },
				},
			},
		},
	};
	const routes = gatewayConfig.routesFromRemoteConfig(payload, 'go');
	assert.deepEqual(routes, {
		'model-b': { model_id: 'model-b', protocol: 'anthropic', base_url: 'https://opencode.ai/inference/go/anthropic' },
	});
	const zenRoutes = gatewayConfig.routesFromRemoteConfig({
		providers: {
			zen: {
				package: 'aisdk:@ai-sdk/openai',
				settings: { baseURL: 'https://opencode.ai/zen' },
				models: { 'zen-model': {} },
			},
		},
	}, 'zen');
	assert.deepEqual(zenRoutes, {
		'zen-model': { model_id: 'zen-model', protocol: 'responses', base_url: 'https://opencode.ai/zen' },
	});
});

test('embedded gateway config uses loopback auth and hands OAuth routes to the binary', () => {
	const key = gatewayConfig.localApiKey();
	const routes = { 'go-a': { model_id: 'go-a', protocol: 'chat', base_url: 'https://opencode.ai/inference/go/openai' } };
	const connection = gatewayConfig.buildOAuthConnection({
		access: 'access-token',
		refresh: 'refresh-token',
		expires: Date.UTC(2026, 10, 25),
		accountID: 'usr_1',
		email: 'user@example.com',
		orgID: 'org_1',
		orgName: 'Org',
	}, routes);
	const config = gatewayConfig.buildGatewayConfig({
		listen: '127.0.0.1:43210',
		serverKey: key,
		anonymous: false,
		prefer: 'go',
		connections: { go: connection },
	});
	assert.equal(config.listen, '127.0.0.1:43210');
	assert.deepEqual(config.server_keys, [key]);
	assert.equal(config.anonymous, false);
	assert.equal(config.prefer, 'go');
	assert.equal(config.webui.enabled, false);
	assert.equal(config.upstream.anonymous, 'https://opencode.ai/inference');
	assert.deepEqual(config.go_oauth.routes, routes);
	assert.equal(config.go_oauth.credential.access_token, 'access-token');
	assert.equal(config.go_oauth.credential.organization_id, 'org_1');
	assert.equal('zen_oauth' in config, false);
});

test('transport helper is built from repository Go source, not a downloaded binary', () => {
	const bun = readFileSync(join(root, 'gateway', 'internal', 'transport', 'bun.go'), 'utf8');
	assert.match(bun, /func bunClientHello\(\)/);
	assert.match(bun, /utls\.HelloCustom/);
	assert.match(bun, /X25519MLKEM768/);
	assert.match(bun, /func bunRequestHead\(/);
	assert.match(bun, /Accept-Encoding: gzip, deflate, br, zstd/);
	const handler = readFileSync(join(root, 'gateway', 'internal', 'transport', 'handler.go'), 'utf8');
	assert.match(handler, /x-zen-target/);
	assert.match(handler, /https:\/\/opencode\.ai/);
	const build = readFileSync(join(root, 'scripts', 'build-gateway.mjs'), 'utf8');
	assert.match(build, /execFileSync\('go', \['build'/);
	assert.equal(build.includes('releases/download'), false);
	const manifest = readFileSync(join(root, 'package.json'), 'utf8');
	assert.match(manifest, /"build:gateway"/);
	assert.match(manifest, /"test:parity": "npm run compile && npm run build:gateway && node --test/);
	assert.match(manifest, /opencodeZen\.transport\.enabled/);
	assert.equal(manifest.includes('opencode2api'), false);
	const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
	assert.match(ignore, /^bin$/m);
	const launch = readFileSync(join(root, '.vscode', 'launch.json'), 'utf8');
	assert.equal(launch.includes('"type": "extensionHost"'), true);
	assert.equal(launch.includes('--extensionDevelopmentPath=${workspaceFolder}'), true);
	const tasks = readFileSync(join(root, '.vscode', 'tasks.json'), 'utf8');
	assert.equal(tasks.includes('npm run compile && npm run build:gateway'), true);
});

test('bundled transport binaries are present and executable', () => {
	const targets = [
		['linux-amd64', 'zen-transport'],
		['linux-arm64', 'zen-transport'],
		['darwin-amd64', 'zen-transport'],
		['darwin-arm64', 'zen-transport'],
		['windows-amd64', 'zen-transport.exe'],
		['windows-arm64', 'zen-transport.exe'],
	];
	for (const [directory, executable] of targets) {
		const path = join(root, 'bin', directory, executable);
		const stats = statSync(path);
		assert.equal(stats.isFile(), true, `${path} is missing`);
		assert.equal(stats.size > 1_000_000, true, `${path} is unexpectedly small`);
		if (!directory.startsWith('windows')) {
			assert.equal((stats.mode & 0o111) !== 0, true, `${path} is not executable`);
		}
	}
});

test('provider keeps CLI shaping and routes the shaped fetch through our transport', () => {
	const source = readFileSync(join(root, 'src', 'provider.ts'), 'utf8');
	const clientSource = readFileSync(join(root, 'src', 'zenClient.ts'), 'utf8');
	const manager = readFileSync(join(root, 'src', 'zenTransport.ts'), 'utf8');
	assert.match(source, /this\.transport\?\.getEndpoint\(\)/);
	assert.match(source, /cliContext: CliRequestContext = \{/);
	assert.match(source, /baseFetch: transportEndpoint\?\.fetch/);
	assert.match(source, /route\?\.plan === 'go'/);
	assert.match(source, /projectId\(projectForWorkdir\(requestMeta\.workdir\)\)/);
	assert.match(source, /shapeBody: providerInfo\?\.npm === '@ai-sdk\/openai-compatible'/);
	assert.match(source, /getGatewayCredential/);
	assert.match(source, /new vscode\.LanguageModelDataPart\(/);
	assert.match(source, /VSCODE_USAGE_MIME_TYPE/);
	assert.match(source, /toCopilotUsage\(snapshot\)/);
	assert.match(clientSource, /createCliFetch\(options\.cliContext, options\.baseFetch \?\? fetch\)/);
	assert.match(manager, /spawn\(binary, \['-config', configPath\]/);
	assert.match(manager, /x-zen-target/);
	assert.match(manager, /x-zen-upstream-headers/);
	assert.match(manager, /server\.listen\(0, '127\.0\.0\.1'/);
});

test('models are registered for local Chat and Copilot Agents windows', () => {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const base = pkg.contributes.languageModelChatProviders.find((entry) => entry.vendor === 'opencode');
	assert.equal(base?.displayName, 'OpenCode Zen');
	assert.equal(base.configuration.properties.apiKey.secret, true);
	assert.equal(base.configuration.properties.apiKey.type, 'object');
	assert.equal(base.configuration.required, undefined);
	assert.deepEqual(base.configuration.properties.authMethod.enum, ['oauth', 'apiKey', 'signOut']);
	assert.equal(base.configuration.properties.authMethod.default, 'oauth');
	assert.deepEqual(base.configuration.properties.lane.enum, ['auto', 'zen', 'go']);
	assert.equal(base.configuration.properties.lane.default, 'auto');
	const agent = pkg.contributes.languageModelChatProviders.find((entry) => entry.vendor === 'opencode-agent');
	assert.equal(agent?.displayName, 'OpenCode Zen (Agents)');
	assert.match(agent.when, /showAgentModelsInManagePanel/);
	assert.equal(pkg.capabilities?.agentsWindow?.supported, true);
	assert.equal(pkg.activationEvents.includes('onLanguageModelChatProvider:opencode'), true);
	assert.equal(pkg.activationEvents.includes('onLanguageModelChatProvider:opencode-agent'), true);
	assert.equal(pkg.contributes.configuration.properties['opencodeZen.agentsWindow'].default, true);
	assert.equal(pkg.contributes.configuration.properties['opencodeZen.autoEnableAgentsWindow'].default, true);
	const commands = pkg.contributes.commands.map((command) => command.command);
	assert.equal(commands.includes('opencodeZen.addModels'), true);
	assert.equal(commands.includes('opencodeZen.revertAgentsWindowSupport'), true);
	assert.equal(commands.some((command) => /signIn|signOut|selfTest/.test(command)), false);
	assert.equal(pkg.activationEvents.some((event) => /signIn|signOut|selfTest/.test(event)), false);

	const source = readFileSync(join(root, 'src', 'provider.ts'), 'utf8');
	assert.match(source, /AGENT_VENDOR_ID = 'opencode-agent'/);
	assert.match(source, /targetChatSessionType: AGENT_SESSION_TYPE/);
	assert.match(source, /isBYOK: true/);
	assert.match(source, /hasByokGroupConfigured/);
	assert.match(source, /modelsForLane\(models, configuration\.lane \?\? 'auto'\)/);
	assert.match(source, /ensureGroupAuth\(/);
	assert.doesNotMatch(source, /configuration\.authMethod === undefined && configuration\.apiKey === undefined/);
	assert.match(source, /group resolved: authMethod=/);
	assert.match(source, /freshOAuthSelection/);
	assert.match(source, /OAuth group selected; starting device sign-in/);
	assert.match(source, /let oauthPromptInFlight/);
	assert.match(source, /configuredApiKey\(configuration\) \? 'apiKey' : 'oauth'/);
	assert.match(source, /getOAuthInferenceAuth\(this\.context\.secrets\)/);
	assert.match(source, /OAuth credential already present; skipping device sign-in/);
	assert.match(source, /clearCredential\(this\.context\.secrets\)/);
	assert.match(source, /getByokApiKey\(this\.context\.secrets\)/);
	assert.match(source, /showInputBox\(\{/);
	assert.match(source, /password: true/);
	assert.match(source, /validateInput: \(value\) => \(value\.trim\(\) \? undefined : 'API key cannot be empty\.'\)/);
	assert.match(source, /storeByokApiKey\(this\.context\.secrets, prompted\)/);

	const extension = readFileSync(join(root, 'src', 'extension.ts'), 'utf8');
	assert.match(extension, /registerLanguageModelChatProvider\(AGENT_VENDOR_ID, agentProvider\)/);
	assert.match(extension, /ensureAgentsWindowSupport\(context\)/);
	assert.match(extension, /revertAgentsWindowSupport\(context, true\)/);
	assert.match(extension, /registerCommand\('opencodeZen\.addModels'/);
	assert.match(extension, /workbench\.action\.chat\.manage/);
	assert.match(extension, /chat\.agentHost\.byokModels\.enabled/);
	assert.equal(/selfTest|signIn|signOut/.test(extension), false);

	const agentsWindow = readFileSync(join(root, 'src', 'agentsWindow.ts'), 'utf8');
	assert.match(agentsWindow, /supportAgentsWindow/);
	assert.match(agentsWindow, /byokModels\.enabled/);
	assert.match(agentsWindow, /agentsPickerInAttachContextMenu/);
});
