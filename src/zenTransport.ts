import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import * as vscode from 'vscode';
import { getOutputChannel } from './output';

export interface TransportEndpoint {
	readonly fetch: typeof fetch;
	readonly baseURL: string;
}

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 250;

export class ZenTransportManager implements vscode.Disposable {
	private endpoint: TransportEndpoint | undefined;
	private child: ChildProcess | undefined;
	private startPromise: Promise<TransportEndpoint> | undefined;
	private stopping = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	get isEnabled(): boolean {
		return vscode.workspace.getConfiguration('opencodeZen').get<boolean>('transport.enabled', true);
	}

	async getEndpoint(): Promise<TransportEndpoint | undefined> {
		if (!this.isEnabled) {
			return undefined;
		}
		if (this.endpoint && this.isRunning()) {
			return this.endpoint;
		}
		if (!this.startPromise) {
			this.startPromise = this.start().finally(() => {
				this.startPromise = undefined;
			});
		}
		return this.startPromise;
	}

	async restart(): Promise<TransportEndpoint | undefined> {
		await this.stop();
		return this.getEndpoint();
	}

	async start(): Promise<TransportEndpoint> {
		if (this.endpoint && this.isRunning()) {
			return this.endpoint;
		}
		if (!this.isEnabled) {
			throw new Error('The Bun-compatible transport is disabled in settings.');
		}

		const output = getOutputChannel();
		const binary = this.resolveBinary();
		if (!binary) {
			throw new Error(
				'The extension-owned transport binary is missing. Set opencodeZen.transport.binaryPath to a valid executable.'
			);
		}

		const port = await allocatePort();
		const listen = `127.0.0.1:${port}`;
		const key = randomBytes(32).toString('hex');
		const directory = join(this.context.globalStorageUri.fsPath, 'zen-transport');
		mkdirSync(directory, { recursive: true });
		const configPath = join(directory, 'config.json');
		writeFileSync(configPath, `${JSON.stringify({ listen, key }, null, 2)}\n`, { mode: 0o600 });

		output.info(`Starting Bun-compatible transport on ${listen} (${binary}).`);
		const child = spawn(binary, ['-config', configPath], {
			cwd: directory,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		this.child = child;
		child.stdout?.on('data', (chunk: Buffer) => logChunk(output, chunk));
		child.stderr?.on('data', (chunk: Buffer) => logChunk(output, chunk));
		child.once('exit', (code, signal) => {
			if (this.child === child) {
				this.child = undefined;
				this.endpoint = undefined;
			}
			if (!this.stopping) {
				output.error(`Bun-compatible transport exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
			}
		});
		child.once('error', (err) => {
			output.error(`Bun-compatible transport failed to start: ${err.message}`);
		});

		const baseURL = `http://${listen}`;
		try {
			await waitForHealth(baseURL, child);
		} catch (err) {
			await this.stop();
			throw err;
		}

		this.endpoint = { fetch: createForwardFetch(`${baseURL}/forward`, key), baseURL };
		output.info(`Bun-compatible transport is ready at ${baseURL}.`);
		return this.endpoint;
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.endpoint = undefined;
		this.stopping = true;
		try {
			if (!child || child.exitCode !== null) {
				return;
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
				timer.unref();
				child.once('exit', () => {
					clearTimeout(timer);
					resolve();
				});
				child.kill('SIGTERM');
			});
		} finally {
			this.stopping = false;
		}
	}

	dispose(): void {
		void this.stop();
	}

	private isRunning(): boolean {
		return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
	}

	private resolveBinary(): string | undefined {
		const configured = vscode.workspace.getConfiguration('opencodeZen').get<string>('transport.binaryPath', '');
		if (configured && existsSync(configured)) {
			return configured;
		}
		const platform = process.platform === 'win32' ? 'windows' : process.platform;
		const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
		const executable = process.platform === 'win32' ? 'zen-transport.exe' : 'zen-transport';
		const bundled = join(this.context.extensionPath, 'bin', `${platform}-${architecture}`, executable);
		return existsSync(bundled) ? bundled : undefined;
	}
}

function createForwardFetch(endpoint: string, key: string): typeof fetch {
	return async (input, init) => {
		const source = new Request(input, init);
		const target = source.url;
		const upstreamAuthorization = source.headers.get('authorization') ?? '';
		const upstreamHeaders: Record<string, string> = {};
		source.headers.forEach((value, name) => {
			if (name.toLowerCase() !== 'authorization') {
				upstreamHeaders[name] = value;
			}
		});

		const headers = new Headers({
			'authorization': `Bearer ${key}`,
			'content-type': 'application/json',
			'x-zen-target': target,
			'x-zen-upstream-authorization': upstreamAuthorization,
			'x-zen-upstream-headers': JSON.stringify(upstreamHeaders),
		});
		const body = source.method === 'GET' || source.method === 'HEAD'
			? undefined
			: await source.arrayBuffer();

		return fetch(endpoint, {
			method: source.method,
			headers,
			body,
			signal: init?.signal,
		});
	};
}

function allocatePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Could not allocate a loopback port.')));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

async function waitForHealth(baseURL: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`Bun-compatible transport exited during startup (code=${child.exitCode}).`);
		}
		try {
			const response = await fetch(`${baseURL}/healthz`, { signal: AbortSignal.timeout(2_000) });
			if (response.ok) {
				return;
			}
		} catch {
			// The listener may not be up yet.
		}
		await delay(HEALTH_POLL_MS);
	}
	throw new Error('Bun-compatible transport did not become healthy within 30 seconds. Check the OpenCode Zen output channel.');
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function logChunk(output: vscode.LogOutputChannel, chunk: Buffer): void {
	for (const line of chunk.toString('utf8').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed !== '') {
			output.info(`[transport] ${trimmed}`);
		}
	}
}
