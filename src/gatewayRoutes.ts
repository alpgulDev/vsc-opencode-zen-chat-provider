import { CLI_USER_AGENT } from './cliShaping';
import { CONSOLE_CONFIG_URL, routesFromRemoteConfig, type GatewayPlan, type GatewayProtocol, type GatewayRoute } from './gatewayConfig';
import type { OAuthCredential } from './oauth';

const CACHE_KEY = 'opencodeZen.gatewayRoutes';
const CACHE_TTL_MS = 15 * 60_000;

export interface GatewayRouteStorage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export interface DiscoveredRoutes {
	readonly go: Readonly<Record<string, GatewayRoute>>;
	readonly zen: Readonly<Record<string, GatewayRoute>>;
	readonly fetchedAt: number;
}

export interface ResolvedGatewayRoute {
	readonly plan: GatewayPlan;
	readonly route: GatewayRoute;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function protocol(value: unknown): value is GatewayProtocol {
	return value === 'chat' || value === 'responses' || value === 'anthropic';
}

function parseRoutes(value: unknown): Record<string, GatewayRoute> | undefined {
	const source = record(value);
	if (!source) {
		return undefined;
	}
	const routes: Record<string, GatewayRoute> = {};
	for (const [name, candidate] of Object.entries(source)) {
		const item = record(candidate);
		if (!item || typeof item.model_id !== 'string' || !protocol(item.protocol) || typeof item.base_url !== 'string') {
			continue;
		}
		routes[name] = { model_id: item.model_id, protocol: item.protocol, base_url: item.base_url };
	}
	return routes;
}

function parseDiscovered(value: unknown): DiscoveredRoutes | undefined {
	const source = record(value);
	if (!source || typeof source.fetchedAt !== 'number' || Date.now() - source.fetchedAt > CACHE_TTL_MS) {
		return undefined;
	}
	const go = parseRoutes(source.go);
	const zen = parseRoutes(source.zen);
	if (!go && !zen) {
		return undefined;
	}
	return { go: go ?? {}, zen: zen ?? {}, fetchedAt: source.fetchedAt };
}

export function routeKey(value: string): string {
	return value.trim().toLowerCase().replace(/-go$/, '');
}

export function findGatewayRoute(routes: DiscoveredRoutes, modelId: string): ResolvedGatewayRoute | undefined {
	const key = routeKey(modelId);
	for (const plan of ['go', 'zen'] as const) {
		const source = routes[plan];
		for (const [name, route] of Object.entries(source)) {
			if (routeKey(name) === key || routeKey(route.model_id) === key) {
				return { plan, route };
			}
		}
	}
	return undefined;
}

export function sdkPackageForProtocol(protocolName: GatewayProtocol): string {
	switch (protocolName) {
		case 'anthropic':
			return '@ai-sdk/anthropic';
		case 'responses':
			return '@ai-sdk/openai';
		default:
			return '@ai-sdk/openai-compatible';
	}
}

export function providerBaseUrl(route: GatewayRoute): string {
	return `${route.base_url.replace(/\/+$/, '')}/v1`;
}

export class GatewayRouteResolver {
	private cached: DiscoveredRoutes | undefined;
	private inFlight: Promise<DiscoveredRoutes | undefined> | undefined;

	constructor(
		private readonly storage: GatewayRouteStorage,
		private readonly credential: () => Promise<OAuthCredential | undefined>,
		private readonly fetchImpl: typeof fetch = fetch
	) {}

	async refresh(force = false): Promise<DiscoveredRoutes | undefined> {
		if (!force && this.cached) {
			return this.cached;
		}
		if (!force && !this.cached) {
			this.cached = parseDiscovered(this.storage.get<unknown>(CACHE_KEY));
		}
		if (!force && this.cached) {
			return this.cached;
		}
		if (this.inFlight) {
			return this.inFlight;
		}
		this.inFlight = this.load().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	async resolve(modelId: string): Promise<ResolvedGatewayRoute | undefined> {
		const routes = await this.refresh();
		return routes ? findGatewayRoute(routes, modelId) : undefined;
	}

	private async load(): Promise<DiscoveredRoutes | undefined> {
		const credential = await this.credential();
		if (!credential) {
			return undefined;
		}
		const response = await this.fetchImpl(CONSOLE_CONFIG_URL, {
			headers: {
				accept: 'application/json',
				'user-agent': CLI_USER_AGENT,
				authorization: `Bearer ${credential.access}`,
				...(credential.orgID ? { 'x-org-id': credential.orgID } : {}),
			},
		});
		if (!response.ok) {
			throw new Error(`OpenCode Console config failed (${response.status} ${response.statusText}).`);
		}
		const payload: unknown = await response.json();
		const discovered: DiscoveredRoutes = {
			go: routesFromRemoteConfig(payload, 'go'),
			zen: routesFromRemoteConfig(payload, 'zen'),
			fetchedAt: Date.now(),
		};
		await this.storage.update(CACHE_KEY, discovered);
		this.cached = discovered;
		return discovered;
	}
}
