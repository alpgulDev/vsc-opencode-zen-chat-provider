import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CLIENT_TOOL_PREFIX, officialToolCandidates, ToolRenames, TOOL_WIRE_NAME_LIMIT } from './toolRenames';

export const CLI_USER_AGENT = 'opencode/latest/2.4.1/cli';
export const CLI_PROMPT_MARKER = 'You are opencode, an interactive CLI tool';
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const projectCache = new Map<string, string>();

export function projectId(project: string): string {
	if (project === 'global' || GIT_COMMIT_PATTERN.test(project)) {
		return project;
	}
	return createHash('sha256').update(`opencode-project\0${project}`).digest('hex').slice(0, 40);
}

export function projectForWorkdir(workdir: string): string {
	const cached = projectCache.get(workdir);
	if (cached !== undefined) {
		return cached;
	}
	const resolved = resolveProject(workdir);
	projectCache.set(workdir, resolved);
	return resolved;
}

function resolveProject(workdir: string): string {
	try {
		const output = execFileSync('git', ['-C', workdir, 'rev-list', '--max-parents=0', 'HEAD'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 1500,
			windowsHide: true,
		});
		const commit = output.trim().split(/\r?\n/, 1)[0] ?? '';
		if (GIT_COMMIT_PATTERN.test(commit)) {
			return commit;
		}
		return workdir.replace(/\\/g, '/');
	} catch {
		return workdir.replace(/\\/g, '/');
	}
}
export { CLIENT_TOOL_PREFIX } from './toolRenames';
export const OFFICIAL_TOOL_ORDER = [
	'edit', 'execute', 'glob', 'grep', 'question', 'read', 'shell',
	'skill', 'subagent', 'webfetch', 'websearch', 'write', 'patch',
] as const;

export const V2_CHAT_KEY_ORDER = ['model', 'messages', 'tools', 'stream', 'stream_options', 'max_completion_tokens'] as const;

export type CliLane = 'inference' | 'go';

export type CliRequestContext = {
	readonly sessionId: string;
	readonly projectId: string;
	readonly modelId: string;
	readonly workdir: string;
	readonly modelHeaders?: Record<string, string>;
	readonly toolAliases?: ReadonlyMap<string, string>;
	readonly shapeBody?: boolean;
	readonly now?: Date;
};

type ToolDefinition = { readonly description: string; readonly parameters: unknown };
type Assets = { readonly prompt: string; readonly tools: Record<string, ToolDefinition> };

const SKILLS = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`;

const TITLE_PROMPTS = [
	'you name conversations so the user can find them later in a list of past sessions',
	'you generate a descriptive title for this conversation',
	'you decide whether the session title still matches the conversation',
	'reply with a title and nothing else',
	'reply with a title for it and nothing else',
];
const TITLE_V1_PROMPT = 'generate a title for this conversation';
const TITLE_MAX_MESSAGES = 3;
const MAX_ENV_VALUE_LENGTH = 4096;

export type ClientEnvironment = {
	readonly workingDirectory?: string;
	readonly workspaceRoot?: string;
	readonly platform?: string;
	readonly isGitRepo?: boolean;
};

type MutableEnvironment = {
	workingDirectory?: string;
	workspaceRoot?: string;
	platform?: string;
	isGitRepo?: boolean;
};

type EnvironmentParse = {
	readonly found: boolean;
	readonly valid: boolean;
	readonly environment: ClientEnvironment;
};

const STRING_ENV_FIELDS = ['workingDirectory', 'workspaceRoot', 'platform'] as const;

function invalidEnvValue(value: string): boolean {
	if (Buffer.byteLength(value, 'utf8') > MAX_ENV_VALUE_LENGTH) {
		return true;
	}
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || character === '<' || character === '>') {
			return true;
		}
	}
	return false;
}

function normalizePlatform(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim().toLowerCase();
	const platform = trimmed === 'windows' ? 'win32' : trimmed;
	if (platform === '' || platform === 'linux' || platform === 'darwin' || platform === 'win32') {
		return platform === '' ? undefined : platform;
	}
	return undefined;
}

function normalizeEnvironment(environment: MutableEnvironment): ClientEnvironment | undefined {
	for (const value of [environment.workingDirectory, environment.workspaceRoot, environment.platform]) {
		if (value !== undefined && invalidEnvValue(value)) {
			return undefined;
		}
	}
	const platform = normalizePlatform(environment.platform);
	if (environment.platform !== undefined && platform === undefined) {
		return undefined;
	}
	return {
		...(environment.workingDirectory !== undefined ? { workingDirectory: environment.workingDirectory.trim() } : {}),
		...(environment.workspaceRoot !== undefined ? { workspaceRoot: environment.workspaceRoot.trim() } : {}),
		...(platform !== undefined ? { platform } : {}),
		...(environment.isGitRepo !== undefined ? { isGitRepo: environment.isGitRepo } : {}),
	};
}

function mergeEnvironment(target: MutableEnvironment, candidate: ClientEnvironment): boolean {
	for (const field of STRING_ENV_FIELDS) {
		const current = target[field];
		const incoming = candidate[field];
		if (current && incoming && current !== incoming) {
			return false;
		}
		if (incoming) {
			target[field] = incoming;
		}
	}
	if (candidate.isGitRepo !== undefined) {
		if (target.isGitRepo !== undefined && target.isGitRepo !== candidate.isGitRepo) {
			return false;
		}
		target.isGitRepo = candidate.isGitRepo;
	}
	return true;
}

function addNativeEnvironmentValue(environment: MutableEnvironment, field: string, value: string): boolean {
	if (value.trim() === '' || value.trim().toLowerCase() === 'unknown') {
		return true;
	}
	if (invalidEnvValue(value)) {
		return false;
	}
	const candidate: MutableEnvironment = {};
	if (field === 'is_git_repo') {
		const normalized = value.trim().toLowerCase();
		if (normalized !== 'yes' && normalized !== 'true' && normalized !== 'no' && normalized !== 'false') {
			return false;
		}
		candidate.isGitRepo = normalized === 'yes' || normalized === 'true';
	} else if (field === 'platform') {
		const platform = normalizePlatform(value);
		if (platform === undefined) {
			return false;
		}
		candidate.platform = platform;
	} else if (field === 'working_directory' || field === 'workspace_root') {
		candidate[field === 'working_directory' ? 'workingDirectory' : 'workspaceRoot'] = value.trim();
	} else {
		return true;
	}
	const normalized = normalizeEnvironment(candidate);
	return normalized !== undefined && mergeEnvironment(environment, normalized);
}

function decodeClientEnvironment(raw: unknown): ClientEnvironment {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('client_environment must be an object');
	}
	const record = raw as Record<string, unknown>;
	const allowed = ['working_directory', 'workspace_root', 'platform', 'is_git_repo'];
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw new Error('client_environment contains an unsupported field');
		}
	}
	const readString = (key: string): string | undefined => {
		const value = record[key];
		if (value === undefined) {
			return undefined;
		}
		if (typeof value !== 'string') {
			throw new Error(`client_environment.${key} must be a string`);
		}
		return value;
	};
	const environment: MutableEnvironment = {};
	const workingDirectory = readString('working_directory');
	if (workingDirectory !== undefined) {
		environment.workingDirectory = workingDirectory;
	}
	const workspaceRoot = readString('workspace_root');
	if (workspaceRoot !== undefined) {
		environment.workspaceRoot = workspaceRoot;
	}
	const platform = readString('platform');
	if (platform !== undefined) {
		environment.platform = platform;
	}
	if (record.is_git_repo !== undefined) {
		if (typeof record.is_git_repo !== 'boolean') {
			throw new Error('client_environment.is_git_repo must be a boolean');
		}
		environment.isGitRepo = record.is_git_repo;
	}
	const normalized = normalizeEnvironment(environment);
	if (!normalized) {
		throw new Error('client_environment contains an invalid value');
	}
	return normalized;
}

function clientEnvironmentTexts(content: unknown): string[] {
	if (typeof content === 'string') {
		return content.trim() === '' ? [] : [content];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const texts: string[] = [];
	for (const part of content) {
		if (typeof part === 'string') {
			texts.push(part);
			continue;
		}
		if (part && typeof part === 'object') {
			const record = part as Record<string, unknown>;
			if ((record.type === 'text' || record.type === 'input_text') && typeof record.text === 'string') {
				texts.push(record.text);
			}
		}
	}
	return texts;
}

function parseEnvironmentBlocks(text: string): EnvironmentParse {
	const environment: MutableEnvironment = {};
	let found = false;
	let inside = false;
	let valid = true;
	let fence = '';
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!inside && line.length >= 3 && (line[0] === '`' || line[0] === '~')) {
			let length = 1;
			while (length < line.length && line[length] === line[0]) {
				length++;
			}
			if (fence === '' && length >= 3) {
				fence = line[0].repeat(length);
				continue;
			}
			if (fence !== '' && line.startsWith(fence) && line.slice(fence.length).trim() === '') {
				fence = '';
				continue;
			}
		}
		if (fence !== '') {
			continue;
		}
		if (line === '<env>') {
			if (inside) {
				valid = false;
			}
			found = true;
			inside = true;
			continue;
		}
		if (line === '</env>') {
			if (!inside) {
				valid = false;
			}
			found = true;
			inside = false;
			continue;
		}
		if (!inside) {
			continue;
		}
		const separator = line.indexOf(':');
		if (separator < 0) {
			continue;
		}
		const label = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		const field = label === 'Working directory' ? 'working_directory'
			: label === 'Workspace root folder' ? 'workspace_root'
				: label === 'Is directory a git repo' ? 'is_git_repo'
					: label === 'Platform' ? 'platform' : undefined;
		if (field !== undefined && !addNativeEnvironmentValue(environment, field, value)) {
			valid = false;
		}
	}
	return { found, valid: valid && !inside, environment };
}

function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/g, '&');
}

function parseCodexEnvironment(text: string): EnvironmentParse {
	const trimmed = text.trim();
	const open = '<environment_context>';
	const close = '</environment_context>';
	if (!trimmed.startsWith(open)) {
		return { found: false, valid: true, environment: {} };
	}
	if (!trimmed.endsWith(close)) {
		return { found: true, valid: false, environment: {} };
	}
	const inner = trimmed.slice(open.length, -close.length);
	const environment: MutableEnvironment = {};
	let valid = true;
	let cursor = 0;
	const pattern = /<([A-Za-z_][A-Za-z0-9_.:-]*)([^>]*)>([\s\S]*?)<\/\1>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(inner)) !== null) {
		if (inner.slice(cursor, match.index).trim() !== '') {
			valid = false;
		}
		cursor = pattern.lastIndex;
		const rawName = match[1];
		const attributes = match[2].trim();
		const name = rawName === 'cwd' ? 'working_directory' : rawName;
		if (name.includes(':')) {
			continue;
		}
		if (name === 'working_directory' || name === 'workspace_root' || name === 'platform' || name === 'is_git_repo') {
			if (attributes !== '' || !addNativeEnvironmentValue(environment, name, decodeXmlEntities(match[3]))) {
				valid = false;
			}
		}
	}
	if (inner.slice(cursor).trim() !== '') {
		valid = false;
	}
	return { found: true, valid, environment };
}

function nativeClientEnvironment(messages: readonly any[]): EnvironmentParse {
	const environment: MutableEnvironment = {};
	let found = false;
	let valid = true;
	let latest: EnvironmentParse | undefined;

	for (const message of messages) {
		if (!message || typeof message !== 'object') {
			continue;
		}
		const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
		if (role === 'system' || role === 'developer') {
			for (const text of clientEnvironmentTexts(message.content)) {
				const parsed = parseEnvironmentBlocks(text);
				if (!parsed.found) {
					continue;
				}
				found = true;
				if (!parsed.valid || !mergeEnvironment(environment, parsed.environment)) {
					valid = false;
				}
			}
		} else if (role === 'user') {
			const texts = clientEnvironmentTexts(message.content);
			if (Array.isArray(message.content) && message.content.length !== texts.length) {
				continue;
			}
			const parsed = parseCodexEnvironment(texts.join('\n'));
			if (parsed.found) {
				latest = parsed.valid ? parsed : { found: true, valid: false, environment: {} };
			}
		}
	}

	if (latest) {
		return latest;
	}
	if (!valid) {
		return { found: true, valid: false, environment: {} };
	}
	return { found, valid: true, environment };
}

export function configClientEnvironment(workdir: string): ClientEnvironment {
	const platform = normalizePlatform(process.platform);
	return {
		workingDirectory: workdir,
		workspaceRoot: workdir,
		...(platform !== undefined ? { platform } : {}),
	};
}

export function resolveClientEnvironment(body: Record<string, any>, workdir?: string): ClientEnvironment {
	if ('client_environment' in body) {
		const raw = body.client_environment;
		delete body.client_environment;
		return decodeClientEnvironment(raw);
	}
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const native = nativeClientEnvironment(messages);
	if (native.found) {
		return native.valid ? native.environment : {};
	}
	return workdir !== undefined ? configClientEnvironment(workdir) : {};
}

let cachedAssets: Assets | undefined;

function getAssets(): Assets {
	if (!cachedAssets) {
		cachedAssets = {
			prompt: readFileSync(join(__dirname, 'assets', 'opencode-prompt-v2.txt'), 'utf8'),
			tools: JSON.parse(
				readFileSync(join(__dirname, 'assets', 'opencode-tools-v2.json'), 'utf8')
			) as Record<string, ToolDefinition>,
		};
	}
	return cachedAssets;
}

export function officialManifest(): Record<string, any>[] {
	const tools = getAssets().tools;
	return OFFICIAL_TOOL_ORDER.filter((name) => Boolean(tools[name])).map((name) => ({
		type: 'function',
		function: {
			name,
			description: tools[name].description,
			parameters: tools[name].parameters,
			strict: false,
		},
	}));
}

export function officialToolParameters(): Record<string, unknown> {
	const tools = getAssets().tools;
	const parameters: Record<string, unknown> = {};
	for (const name of OFFICIAL_TOOL_ORDER) {
		if (tools[name] !== undefined) {
			parameters[name] = tools[name].parameters;
		}
	}
	return parameters;
}

export function officialToolDefinitions(): Readonly<Record<string, ToolDefinition>> {
	const tools = getAssets().tools;
	const definitions: Record<string, ToolDefinition> = {};
	for (const name of OFFICIAL_TOOL_ORDER) {
		if (tools[name] !== undefined) {
			definitions[name] = tools[name];
		}
	}
	return definitions;
}

export function clientToolWireName(name: string, used?: Set<string>): string {
	const digest = createHash('sha256').update(name).digest('hex').slice(0, 12);
	const base = `${CLIENT_TOOL_PREFIX}${digest}`;
	if (!used) {
		return base;
	}
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	for (let suffix = 2; ; suffix++) {
		const tag = `_${suffix}`;
		const candidate = `${base.slice(0, Math.min(base.length, TOOL_WIRE_NAME_LIMIT - tag.length))}${tag}`;
		if (!used.has(candidate)) {
			used.add(candidate);
			return candidate;
		}
	}
}

export function bindOfficialAliases(
	renames: ToolRenames,
	declaredNames: readonly string[],
	officialNames: readonly string[]
): void {
	const declared = new Set(declaredNames);
	for (const official of officialNames) {
		if (renames.officialClient(official) !== undefined) {
			continue;
		}
		for (const candidate of officialToolCandidates(official)) {
			const client = renames.resolve(candidate);
			if (!declared.has(client)) {
				continue;
			}
			renames.bindOfficial(official, client);
			break;
		}
	}
}

export function buildToolRenames(declaredNames: readonly string[]): ToolRenames {
	const renames = new ToolRenames();
	const used = new Set<string>();
	for (const name of declaredNames) {
		renames.add(name, clientToolWireName(name, used));
	}
	bindOfficialAliases(renames, declaredNames, OFFICIAL_TOOL_ORDER);
	return renames;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(date: Date): string {
	return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${date.getUTCFullYear()}`;
}

export function cliPreamble(
	modelId: string,
	workdir: string,
	now = new Date(),
	environment: ClientEnvironment = configClientEnvironment(workdir)
): string {
	const apiModel = modelId.startsWith('opencode/') ? modelId.slice('opencode/'.length) : modelId;
	const model = apiModel.trim() === '' ? 'unknown' : apiModel.trim();
	const directory = environment.workingDirectory || 'unknown';
	const workspace = environment.workspaceRoot || 'unknown';
	const platform = environment.platform || 'unknown';
	const gitRepo = environment.isGitRepo === undefined ? 'unknown' : environment.isGitRepo ? 'yes' : 'no';
	const environmentBlock = [
		`You are powered by the model named ${model}. The exact model ID is opencode/${model}`,
		'Here is some useful information about the environment you are running in:',
		'<env>',
		`  Working directory: ${directory}`,
		`  Workspace root folder: ${workspace}`,
		`  Is directory a git repo: ${gitRepo}`,
		`  Platform: ${platform}`,
		`  Today's date: ${formatDate(now)}`,
		'</env>',
	].join('\n');
	return getAssets().prompt + environmentBlock + '\n' + SKILLS;
}

function messageText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.map((part) => {
			if (typeof part === 'string') {
				return part;
			}
			if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
				return (part as { text: string }).text;
			}
			return '';
		})
		.filter((text) => text.length > 0)
		.join('\n\n');
}

function textFragments(content: unknown): string[] {
	if (typeof content === 'string') {
		return content.trim() === '' ? [] : [content];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === 'string') {
			parts.push(...textFragments(item));
			continue;
		}
		if (item && typeof item === 'object') {
			const record = item as Record<string, unknown>;
			if (typeof record.text === 'string') {
				parts.push(...textFragments(record.text));
			} else if (record.content !== undefined) {
				parts.push(...textFragments(record.content));
			}
		}
	}
	return parts;
}

function carriesCliPrompt(content: unknown): boolean {
	return textFragments(content).some((part) => part.includes(CLI_PROMPT_MARKER));
}

function injectPreamble(body: Record<string, any>, preamble: string): void {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const instructions: string[] = [];
	const kept: any[] = [];
	for (const message of messages) {
		if (!message || typeof message !== 'object') {
			kept.push(message);
			continue;
		}
		const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
		if (role === 'system' || role === 'developer') {
			if (carriesCliPrompt(message.content)) {
				return;
			}
			for (const part of textFragments(message.content)) {
				const trimmed = part.trim();
				if (trimmed !== '') {
					instructions.push(trimmed);
				}
			}
			continue;
		}
		kept.push(message);
	}
	const systemContent = instructions.length > 0 ? `${preamble}\n\n${instructions.join('\n')}` : preamble;
	body.messages = [{ role: 'system', content: systemContent }, ...kept];
}

export function isTitleGenerationRequest(body: Record<string, any>): boolean {
	if (Array.isArray(body.tools) && body.tools.length > 0) {
		return false;
	}
	if (Array.isArray(body.functions) && body.functions.length > 0) {
		return false;
	}
	const messages = Array.isArray(body.messages) ? body.messages : [];
	if (messages.length === 0 || messages.length > TITLE_MAX_MESSAGES) {
		return false;
	}
	let matched = false;
	for (const message of messages) {
		if (!message || typeof message !== 'object') {
			continue;
		}
		const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
		if (role === 'assistant' || role === 'tool' || role === 'function') {
			return false;
		}
		const text = messageText(message.content).trim().toLowerCase();
		if (text.length === 0) {
			continue;
		}
		if (role === 'system' || role === 'developer') {
			if (TITLE_PROMPTS.some((prompt) => text.includes(prompt))) {
				matched = true;
			}
		} else if (role === 'user' && text.startsWith(TITLE_V1_PROMPT)) {
			matched = true;
		}
	}
	return matched;
}

function historyWireName(
	name: string,
	declared: ReadonlyMap<string, string>,
	renames: ToolRenames,
	official: ReadonlySet<string>
): string | undefined {
	const direct = declared.get(name);
	if (direct !== undefined) {
		return direct;
	}
	if (renames.client(name) !== undefined) {
		return name;
	}
	if (official.has(name)) {
		const client = renames.officialClient(name) ?? renames.resolve(name);
		return declared.get(client) ?? renames.wire(client);
	}
	const client = renames.resolve(name);
	return declared.get(client);
}

function chatMessageHasContent(message: any): boolean {
	if (!message || typeof message !== 'object') {
		return false;
	}
	for (const key of ['content', 'reasoning_content', 'reasoning']) {
		const value = message[key];
		if (typeof value === 'string' ? value !== '' : value !== undefined && value !== null) {
			return true;
		}
	}
	return false;
}

function sanitizeChatHistory(
	body: Record<string, any>,
	declared: ReadonlyMap<string, string>,
	renames: ToolRenames,
	official: ReadonlySet<string>
): void {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const dropped = new Set<string>();
	const dropEmpty = new Set<number>();

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message || typeof message !== 'object' || !Array.isArray(message.tool_calls)) {
			continue;
		}
		const calls = message.tool_calls as any[];
		const kept = calls.filter((call) => {
			const fn = call?.function;
			const name = typeof fn?.name === 'string' ? fn.name : '';
			const wireName = historyWireName(name, declared, renames, official);
			if (wireName === undefined) {
				if (typeof call?.id === 'string' && call.id !== '') {
					dropped.add(call.id);
				}
				return false;
			}
			fn.name = wireName;
			return true;
		});
		if (kept.length === 0) {
			delete message.tool_calls;
			if (calls.length > 0) {
				dropEmpty.add(index);
			}
		} else {
			message.tool_calls = kept;
		}
	}

	body.messages = messages.filter((message, index) => {
		if (message?.role === 'tool' && dropped.has(message.tool_call_id)) {
			return false;
		}
		if (dropEmpty.has(index) && !chatMessageHasContent(message)) {
			return false;
		}
		return true;
	});
}

function sanitizeAnthropicHistory(
	body: Record<string, any>,
	declared: ReadonlyMap<string, string>,
	renames: ToolRenames,
	official: ReadonlySet<string>
): void {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const dropped = new Set<string>();
	for (const message of messages) {
		const content = message?.content;
		if (!Array.isArray(content)) {
			continue;
		}
		for (const block of content) {
			if (block?.type !== 'tool_use') {
				continue;
			}
			const wireName = historyWireName(block.name ?? '', declared, renames, official);
			if (wireName === undefined) {
				if (typeof block.id === 'string' && block.id !== '') {
					dropped.add(block.id);
				}
			} else {
				block.name = wireName;
			}
		}
	}
	const keptMessages: any[] = [];
	for (const message of messages) {
		const content = message?.content;
		if (!Array.isArray(content)) {
			keptMessages.push(message);
			continue;
		}
		const kept = content.filter((block: any) => {
			if (block?.type === 'tool_use') {
				return historyWireName(block.name ?? '', declared, renames, official) !== undefined;
			}
			if (block?.type === 'tool_result') {
				return !dropped.has(block.tool_use_id);
			}
			return true;
		});
		if (kept.length === 0) {
			continue;
		}
		message.content = kept;
		keptMessages.push(message);
	}
	body.messages = keptMessages;
}

function sanitizeResponsesHistory(
	body: Record<string, any>,
	declared: ReadonlyMap<string, string>,
	renames: ToolRenames,
	official: ReadonlySet<string>
): void {
	const items = Array.isArray(body.input) ? body.input : [];
	const dropped = new Set<string>();
	for (const item of items) {
		const kind = item?.type;
		if (kind !== 'function_call' && kind !== 'custom_tool_call') {
			continue;
		}
		const wireName = historyWireName(item.name ?? '', declared, renames, official);
		if (wireName === undefined) {
			const id = item.call_id ?? item.id;
			if (typeof id === 'string' && id !== '') {
				dropped.add(id);
			}
		} else {
			item.name = wireName;
		}
	}
	body.input = items.filter((item: any) => {
		if (item?.type === 'function_call_output') {
			return !dropped.has(item.call_id);
		}
		if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
			return historyWireName(item.name ?? '', declared, renames, official) !== undefined;
		}
		return true;
	});
}

function rewriteToolChoice(body: Record<string, any>, declared: ReadonlyMap<string, string>): void {
	const choice = body.tool_choice;
	if (typeof choice === 'string') {
		const wireName = declared.get(choice);
		if (wireName !== undefined) {
			body.tool_choice = wireName;
		}
		return;
	}
	if (!choice || typeof choice !== 'object') {
		return;
	}
	const updated = { ...choice };
	const fn = updated.function ?? updated;
	if (fn && typeof fn.name === 'string') {
		const wireName = declared.get(fn.name);
		if (wireName !== undefined) {
			fn.name = wireName;
		}
	}
	body.tool_choice = updated;
}

function sanitizeToolHistory(
	body: Record<string, any>,
	declared: ReadonlyMap<string, string>,
	renames: ToolRenames,
	official: ReadonlySet<string>
): void {
	rewriteToolChoice(body, declared);
	if (Array.isArray(body.input)) {
		sanitizeResponsesHistory(body, declared, renames, official);
	}
	if (Array.isArray(body.messages)) {
		if (body.messages.some((message: any) => Array.isArray(message?.content)
			&& message.content.some((block: any) => block?.type === 'tool_use' || block?.type === 'tool_result'))) {
			sanitizeAnthropicHistory(body, declared, renames, official);
		} else {
			sanitizeChatHistory(body, declared, renames, official);
		}
	}
}

function orderV2ChatBody(body: Record<string, any>): Record<string, any> {
	const ordered: Record<string, any> = {};
	for (const key of V2_CHAT_KEY_ORDER) {
		if (key in body) {
			ordered[key] = body[key];
		}
	}
	for (const key of Object.keys(body).sort()) {
		if (!(key in ordered)) {
			ordered[key] = body[key];
		}
	}
	return ordered;
}

export function shapeChatBody(
	input: Record<string, any>,
	context: CliRequestContext
): { body: Record<string, any>; aliases: Map<string, string>; renames: ToolRenames } {
	const body: Record<string, any> = { ...input };
	body.messages = Array.isArray(body.messages)
		? body.messages.map((message) => (message && typeof message === 'object' ? { ...message } : message))
		: [];

	const environment = resolveClientEnvironment(body, context.workdir);
	const aliases = new Map<string, string>();
	const declared = new Map<string, string>();
	const renames = new ToolRenames();
	if (!isTitleGenerationRequest(body)) {
		const used = new Set(context.toolAliases?.values() ?? []);
		const callerTools = Array.isArray(body.tools)
			? body.tools.filter((tool: any) => !OFFICIAL_TOOL_ORDER.includes(tool?.function?.name))
			: [];
		const renamed = callerTools.map((tool: any) => {
			const copy = tool && typeof tool === 'object' ? { ...tool } : tool;
			const fn = copy?.function && typeof copy.function === 'object' ? { ...copy.function } : undefined;
			if (fn && typeof fn.name === 'string' && fn.name.length > 0 && !fn.name.startsWith(CLIENT_TOOL_PREFIX)) {
				const alias = context.toolAliases?.get(fn.name) ?? clientToolWireName(fn.name, used);
				renames.add(fn.name, alias);
				aliases.set(alias, fn.name);
				declared.set(fn.name, alias);
				fn.name = alias;
				if (typeof fn.description === 'string') {
					fn.description = fn.description.replace(/ /g, '\u00a0');
				}
				copy.function = fn;
			}
			return copy;
		});
		const renamedNames = new Set<string>(
			renamed
				.map((tool: any) => tool?.function?.name)
				.filter((name: unknown): name is string => typeof name === 'string')
		);
		body.tools = [
			...renamed,
			...officialManifest().filter((tool) => !renamedNames.has(tool.function.name)),
		];
		bindOfficialAliases(renames, [...declared.keys()], OFFICIAL_TOOL_ORDER);
	}

	injectPreamble(body, cliPreamble(context.modelId, context.workdir, context.now, environment));
	body.stream = true;
	if (!('max_completion_tokens' in body) && !('max_tokens' in body)) {
		body.max_completion_tokens = 32_000;
	}
	body.stream_options = {
		...(body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : {}),
		include_usage: true,
	};
	sanitizeToolHistory(body, declared, renames, new Set<string>(OFFICIAL_TOOL_ORDER));
	return { body: orderV2ChatBody(body), aliases, renames };
}

export function createCliFetch(context: CliRequestContext, baseFetch: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		const headers = new Headers(init?.headers);
		for (const [name, value] of Object.entries(buildCliHeaders(context))) {
			headers.set(name, value);
		}

		let body = init?.body;
		if (context.shapeBody !== false && typeof body === 'string') {
			try {
				const parsed = JSON.parse(body) as Record<string, any>;
				if (parsed && typeof parsed === 'object') {
					body = JSON.stringify(shapeChatBody(parsed, context).body);
				}
			} catch {
				body = init?.body;
			}
		}

		return baseFetch(input, { ...init, headers, body });
	};
}

export function buildCliHeaders(context: CliRequestContext): Record<string, string> {
	return {
		...(context.modelHeaders ?? {}),
		'x-opencode-session-id': context.sessionId,
		'x-session-affinity': context.sessionId,
		'X-Session-Id': context.sessionId,
		'x-opencode-session': context.sessionId,
		'x-opencode-client': 'cli',
		'x-opencode-project': context.projectId,
		'User-Agent': CLI_USER_AGENT,
	};
}
