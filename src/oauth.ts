import * as vscode from 'vscode';
import { CLI_USER_AGENT } from './cliShaping';
import { getOutputChannel } from './output';

const CONSOLE_SERVER = 'https://opencode.ai/console';
const CLIENT_ID = 'opencode-cli';
const SECRET_KEY = 'opencodeZen.oauthCredential';
const REFRESH_MARGIN_MS = 300_000;
const CONSOLE_REQUEST_TIMEOUT_MS = 20_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export interface OAuthCredential {
	readonly access: string;
	readonly refresh: string;
	readonly expires: number;
	readonly server: string;
	readonly accountID?: string;
	readonly email?: string;
	readonly orgID?: string;
	readonly orgName?: string;
}

export interface InferenceAuth {
	readonly apiKey: string;
}

type DeviceCode = {
	device_code: string;
	user_code: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
};

type DeviceToken = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	org_id?: string | null;
	error?: string;
};

let refreshInFlight: Promise<OAuthCredential | undefined> | undefined;

export async function readCredential(secrets: vscode.SecretStorage): Promise<OAuthCredential | undefined> {
	const raw = await secrets.get(SECRET_KEY);
	if (!raw) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as OAuthCredential;
		if (typeof parsed.access !== 'string' || typeof parsed.refresh !== 'string' || typeof parsed.expires !== 'number') {
			await clearCredential(secrets);
			return undefined;
		}
		return parsed;
	} catch {
		await clearCredential(secrets);
		return undefined;
	}
}

export async function clearCredential(secrets: vscode.SecretStorage): Promise<void> {
	await secrets.delete(SECRET_KEY);
}

export async function getInferenceAuth(secrets: vscode.SecretStorage): Promise<InferenceAuth> {
	const credential = await readCredential(secrets);
	if (!credential) {
		return { apiKey: 'public' };
	}
	if (credential.expires > Date.now() + REFRESH_MARGIN_MS) {
		return { apiKey: credential.access };
	}

	if (!refreshInFlight) {
		refreshInFlight = refresh(secrets, credential).finally(() => {
			refreshInFlight = undefined;
		});
	}
	const refreshed = await refreshInFlight;
	if (!refreshed) {
		return { apiKey: 'public' };
	}
	return { apiKey: refreshed.access };
}

export async function getGatewayCredential(secrets: vscode.SecretStorage): Promise<OAuthCredential | undefined> {
	await getInferenceAuth(secrets);
	return readCredential(secrets);
}

export async function signIn(secrets: vscode.SecretStorage, signal?: AbortSignal): Promise<OAuthCredential> {
	const output = getOutputChannel();
	output.info('OpenCode Console sign-in: requesting device code...');
	const device = await postJson<DeviceCode>(`${CONSOLE_SERVER}/auth/device/code`, {
		client_id: CLIENT_ID,
		supports_org_scope: true,
	}, undefined, signal);

	const verification = deviceVerificationUrl(device);
	output.info(`OpenCode Console device code: ${device.user_code}`);
	output.info(`OpenCode Console verification URL: ${verification}`);
	await vscode.env.clipboard.writeText(device.user_code);
	try {
		await vscode.env.openExternal(vscode.Uri.parse(verification));
		output.info('OpenCode Console verification page opened in the browser.');
	} catch (err) {
		output.warn(`Could not open the verification page automatically: ${err instanceof Error ? err.message : String(err)}`);
	}
	void showDevicePrompt(verification, device.user_code);

	let intervalSeconds = Math.max(1, device.interval);
	const deadline = Date.now() + device.expires_in * 1000;
	let waitingLogged = false;
	while (Date.now() < deadline) {
		await wait(intervalSeconds * 1000, signal);
		if (!waitingLogged) {
			output.info('Waiting for OpenCode Console authorization...');
			waitingLogged = true;
		}
		const token = await postJson<DeviceToken>(`${CONSOLE_SERVER}/auth/device/token`, {
			grant_type: DEVICE_GRANT,
			device_code: device.device_code,
			client_id: CLIENT_ID,
		}, undefined, signal, false);

		if (token.access_token) {
			output.info('OpenCode Console authorization received.');
			const credential = await buildCredential(token, signal);
			await secrets.store(SECRET_KEY, JSON.stringify(credential));
			const label = credential.email?.trim() || credential.accountID || 'account';
			output.info(`OpenCode Console sign-in complete: ${label}.`);
			return credential;
		}
		if (token.error === 'authorization_pending') {
			continue;
		}
		if (token.error === 'slow_down') {
			intervalSeconds += 5;
			continue;
		}
		throw new Error(`OpenCode sign-in failed: ${token.error ?? 'unknown error'}`);
	}
	throw new Error('OpenCode sign-in timed out. Run "OpenCode Zen: Sign In" to try again.');
}

function deviceVerificationUrl(device: DeviceCode): string {
	try {
		const parsed = new URL(device.verification_uri_complete, `${CONSOLE_SERVER}/`);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(`unexpected protocol ${parsed.protocol}`);
		}
		return parsed.href;
	} catch (err) {
		throw new Error(`Invalid device verification URL: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function showDevicePrompt(verification: string, userCode: string): Promise<void> {
	const action = await vscode.window.showInformationMessage(
		`OpenCode Console code: ${userCode}. Complete sign-in in the browser.`,
		'Open Browser',
		'Copy Code'
	);
	if (action === 'Open Browser') {
		await vscode.env.openExternal(vscode.Uri.parse(verification));
	} else if (action === 'Copy Code') {
		await vscode.env.clipboard.writeText(userCode);
	}
}

async function refresh(secrets: vscode.SecretStorage, credential: OAuthCredential): Promise<OAuthCredential | undefined> {
	try {
		const token = await postJson<DeviceToken>(`${CONSOLE_SERVER}/auth/device/token`, {
			grant_type: 'refresh_token',
			refresh_token: credential.refresh,
			client_id: CLIENT_ID,
		});
		const refreshed: OAuthCredential = {
			...credential,
			access: token.access_token,
			refresh: token.refresh_token,
			expires: Date.now() + token.expires_in * 1000,
			...(token.org_id ? { orgID: token.org_id } : {}),
		};
		await secrets.store(SECRET_KEY, JSON.stringify(refreshed));
		return refreshed;
	} catch (err) {
		const status = err instanceof Error && 'status' in err ? err.status : undefined;
		if (status === 400 || status === 401) {
			await clearCredential(secrets);
		}
		return undefined;
	}
}

async function buildCredential(token: DeviceToken, signal?: AbortSignal): Promise<OAuthCredential> {
	const [user, orgs] = await Promise.all([
		getJson<{ id: string; email: string }>(`${CONSOLE_SERVER}/api/user`, token.access_token, signal),
		getJson<Array<{ id: string; name: string }>>(`${CONSOLE_SERVER}/api/orgs`, token.access_token, signal),
	]);
	const sorted = [...orgs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	const org = token.org_id == null ? sorted[0] : sorted.find((item) => item.id === token.org_id);
	if (token.org_id != null && !org) {
		throw new Error(`OpenCode organization not found: ${token.org_id}`);
	}
	return {
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000,
		server: CONSOLE_SERVER,
		accountID: user.id,
		email: user.email,
		...(org ? { orgID: org.id, orgName: org.name } : {}),
	};
}

async function postJson<T>(
	url: string,
	body: Record<string, string | boolean>,
	accessToken?: string,
	signal?: AbortSignal,
	statusOk = true
): Promise<T> {
	return requestJson<T>(url, 'POST', body, accessToken, signal, statusOk);
}

async function getJson<T>(url: string, accessToken: string, signal?: AbortSignal): Promise<T> {
	return requestJson<T>(url, 'GET', undefined, accessToken, signal);
}

async function requestJson<T>(
	url: string,
	method: 'GET' | 'POST',
	body: Record<string, string | boolean> | undefined,
	accessToken?: string,
	signal?: AbortSignal,
	statusOk = true
): Promise<T> {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), CONSOLE_REQUEST_TIMEOUT_MS);
	const onAbort = () => timeout.abort();
	if (signal?.aborted) {
		timeout.abort();
	} else {
		signal?.addEventListener('abort', onAbort, { once: true });
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method,
			headers: {
				accept: 'application/json',
				'user-agent': CLI_USER_AGENT,
				...(body ? { 'content-type': 'application/json' } : {}),
				...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: timeout.signal,
		});
	} catch (err) {
		if (signal?.aborted) {
			throw new Error('OpenCode sign-in cancelled.');
		}
		if (timeout.signal.aborted) {
			throw new Error(`OpenCode Console request timed out (${method} ${url}).`);
		}
		throw new Error(`Cannot reach OpenCode Console (${method} ${url}): ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
	}

	const text = await response.text();
	if (!response.ok && statusOk) {
		const error = new Error(
			`OpenCode Console request failed (${method} ${url}): ${response.status} ${response.statusText}.`
		) as Error & { status?: number };
		error.status = response.status;
		throw error;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`OpenCode Console returned an invalid response (${method} ${url}).`);
	}
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('OpenCode sign-in cancelled.'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(new Error('OpenCode sign-in cancelled.'));
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}
