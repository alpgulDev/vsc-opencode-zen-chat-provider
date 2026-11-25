import { randomBytes } from 'crypto';

export const CONSOLE_CONFIG_URL = 'https://opencode.ai/console/api/v2/config';

export type GatewayPlan = 'go' | 'zen';
export type GatewayProtocol = 'chat' | 'responses' | 'anthropic';

export interface GatewayCredentialInput {
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
	readonly accountID?: string;
	readonly email?: string;
	readonly orgID?: string;
	readonly orgName?: string;
}

interface GatewayCredentialConfig {
	readonly access_token: string;
	readonly refresh_token: string;
	readonly expires_at: string;
	readonly account_id: string;
	readonly email: string;
	readonly organization_id: string;
	readonly organization_name: string;
}

export interface GatewayRoute {
	readonly model_id: string;
	readonly protocol: GatewayProtocol;
	readonly base_url: string;
}

export interface GatewayOAuthConnectionInput {
	readonly credential: GatewayCredentialConfig;
	readonly routes: Readonly<Record<string, GatewayRoute>>;
}

export interface GatewayConfigInput {
	readonly listen: string;
	readonly serverKey: string;
	readonly anonymous: boolean;
	readonly prefer: GatewayPlan;
	readonly connections?: Partial<Record<GatewayPlan, GatewayOAuthConnectionInput>>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function validOpaque(value: unknown, limit = 1024): value is string {
	if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > limit) {
		return false;
	}
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x20 || code > 0x7e) {
			return false;
		}
	}
	return true;
}

function officialUrl(value: string): URL | undefined {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'opencode.ai') {
		return undefined;
	}
	if (parsed.port !== '' && parsed.port !== '443') {
		return undefined;
	}
	if (parsed.username !== '' || parsed.password !== '') {
		return undefined;
	}
	return parsed;
}

export function packageProtocol(name: unknown): GatewayProtocol | undefined {
	if (typeof name !== 'string') {
		return undefined;
	}
	let normalized = name;
	if (normalized.startsWith('aisdk:@ai-sdk/')) {
		normalized = normalized.slice('aisdk:'.length);
	}
	if (normalized.startsWith('@opencode-ai/ai/providers/')) {
		normalized = `@opencode/ai/providers/${normalized.slice('@opencode-ai/ai/providers/'.length)}`;
	}
	switch (normalized) {
		case '@ai-sdk/openai-compatible':
		case '@opencode/ai/providers/openai-compatible':
		case '@opencode/ai/providers/openai/chat':
			return 'chat';
		case '@ai-sdk/openai':
		case '@opencode/ai/providers/openai':
		case '@opencode/ai/providers/openai/responses':
		case '@opencode/ai/providers/openai-compatible/responses':
		case '@opencode/ai/providers/openai-compatible-responses':
			return 'responses';
		case '@ai-sdk/anthropic':
		case '@opencode/ai/providers/anthropic':
		case '@opencode/ai/providers/anthropic-compatible':
			return 'anthropic';
		default:
			return undefined;
	}
}

export function normalizeBaseForPlan(raw: unknown, protocol: GatewayProtocol, plan: GatewayPlan): string | undefined {
	if (typeof raw !== 'string' || raw === '') {
		return undefined;
	}
	const parsed = officialUrl(raw);
	if (!parsed || parsed.search !== '' || parsed.hash !== '' || parsed.pathname.includes('%')) {
		return undefined;
	}
	let path = parsed.pathname.replace(/\/+$/, '');
	const root = plan === 'go' ? '/inference/go' : '/inference';
	if (plan === 'zen' && (path === '/zen' || path === '/zen/v1')) {
		return 'https://opencode.ai/zen';
	}
	if (path === root) {
		path += protocol === 'anthropic' ? '/anthropic' : '/openai';
	}
	switch (path) {
		case `${root}/openai`:
		case `${root}/openai/v1`:
			return protocol === 'anthropic' ? undefined : `https://opencode.ai${root}/openai`;
		case `${root}/anthropic`:
		case `${root}/anthropic/v1`:
			return protocol === 'anthropic' ? `https://opencode.ai${root}/anthropic` : undefined;
		default:
			return undefined;
	}
}

function sameRoute(left: GatewayRoute, right: GatewayRoute): boolean {
	return left.model_id === right.model_id
		&& left.protocol === right.protocol
		&& left.base_url === right.base_url;
}

export function routesFromRemoteConfig(payload: unknown, plan: GatewayPlan): Record<string, GatewayRoute> {
	const providers = record(record(payload)?.providers);
	if (!providers) {
		return {};
	}
	const routes: Record<string, GatewayRoute> = {};
	const ambiguous = new Set<string>();
	for (const providerValue of Object.values(providers)) {
		const provider = record(providerValue);
		if (!provider || provider.disabled === true) {
			continue;
		}
		const models = record(provider.models);
		if (!models) {
			continue;
		}
		for (const [name, modelValue] of Object.entries(models)) {
			if (!validOpaque(name) || ambiguous.has(name)) {
				continue;
			}
			const model = record(modelValue);
			if (!model || model.disabled === true) {
				continue;
			}
			const modelId = typeof model.modelID === 'string' && model.modelID !== '' ? model.modelID : name;
			if (!validOpaque(modelId)) {
				continue;
			}
			const protocol = packageProtocol(model.package ?? provider.package);
			if (!protocol) {
				continue;
			}
			const modelSettings = record(model.settings);
			const providerSettings = record(provider.settings);
			const baseUrl = normalizeBaseForPlan(
				modelSettings?.baseURL ?? providerSettings?.baseURL,
				protocol,
				plan
			);
			if (!baseUrl) {
				continue;
			}
			const route: GatewayRoute = { model_id: modelId, protocol, base_url: baseUrl };
			const existing = routes[name];
			if (existing && !sameRoute(existing, route)) {
				delete routes[name];
				ambiguous.add(name);
				continue;
			}
			routes[name] = route;
		}
	}
	return routes;
}

export function buildOAuthConnection(
	credential: GatewayCredentialInput,
	routes: Readonly<Record<string, GatewayRoute>>
): GatewayOAuthConnectionInput {
	return {
		credential: {
			access_token: credential.access,
			refresh_token: credential.refresh,
			expires_at: new Date(credential.expires).toISOString(),
			account_id: credential.accountID ?? '',
			email: credential.email ?? '',
			organization_id: credential.orgID ?? '',
			organization_name: credential.orgName ?? '',
		},
		routes: { ...routes },
	};
}

export function localApiKey(): string {
	return randomBytes(32).toString('hex');
}

export function buildGatewayConfig(input: GatewayConfigInput): Record<string, unknown> {
	const connections = input.connections ?? {};
	const config: Record<string, unknown> = {
		listen: input.listen,
		server_keys: [input.serverKey],
		zen_keys: [],
		go_keys: [],
		anonymous: input.anonymous,
		prefer: input.prefer,
		proxies: ['direct'],
		proxyfile: '',
		upstream: {
			zen: 'https://opencode.ai/zen',
			go: 'https://opencode.ai/zen/go',
			anonymous: 'https://opencode.ai/inference',
			prompt_environment: {},
		},
		retry: { max_attempts: 3, timeout_seconds: 300 },
		models: {
			refresh_seconds: 300,
			protocols: {},
			free_only: input.anonymous && !connections.go && !connections.zen,
			active_probes: false,
		},
		performance: {
			max_idle_conns: 2048,
			max_idle_conns_per_host: 256,
			max_conns_per_host: 0,
			idle_conn_timeout_seconds: 120,
			connect_timeout_seconds: 5,
			failure_cooldown_seconds: 15,
			attempt_timeout_seconds: 0,
			first_event_timeout_seconds: 0,
			max_anonymous_exits: 8,
			free_tier_block_seconds: 900,
		},
		logging: { level: 'warn', ring_size: 2000, dump_request_bodies: false },
		webui: { enabled: false, listen: '127.0.0.1:0', username: 'admin', password: '', session_ttl_minutes: 720 },
		warp: { enabled: false, pool_size: 2, stack: 'ipv6', source_ipv6: '' },
		reasoning: { effort: 'high', effort_by_model: {} },
		rotation: {
			sota: { alias: 'sota', order: ['deepseek-v4.1-flash', 'glm-5.3', 'grok-4.6', 'kimi-k3', 'qwen3.8-max'] },
			sweet: { alias: 'sweet', order: [] },
			first_output_seconds: 30,
		},
	};
	if (connections.go) {
		config.go_oauth = connections.go;
	}
	if (connections.zen) {
		config.zen_oauth = connections.zen;
	}
	return config;
}
