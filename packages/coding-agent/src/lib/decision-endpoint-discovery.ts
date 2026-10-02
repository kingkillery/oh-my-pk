import { $env, logger } from "@pk-nerdsaver-ai/pi-utils";

const DEFAULT_HOSTNAME = "clef-inference";
const DEFAULT_PORT = 8000;
const STATUS_TIMEOUT_MS = 1_000;
const HEALTH_TIMEOUT_MS = 900;
const POSITIVE_CACHE_MS = 15_000;
const NEGATIVE_CACHE_MS = 5_000;

export interface DecisionEndpoint {
	readonly baseUrl: string;
	readonly healthUrl: string;
	readonly identity: string;
	readonly model: string;
	readonly source: "explicit" | "tailscale";
}

export interface DecisionDiscoveryOptions {
	fetch?: typeof fetch;
	now?: () => number;
	readTailscaleStatus?: () => Promise<unknown>;
	signal?: AbortSignal;
}

interface CachedDecisionEndpoint {
	readonly endpoint?: DecisionEndpoint;
	readonly expiresAt: number;
	readonly signature: string;
}

let cachedDecisionEndpoint: CachedDecisionEndpoint | undefined;

function readEnv(name: string): string | undefined {
	const value = $env[name]?.trim();
	return value ? value : undefined;
}

function discoveryEnabled(): boolean {
	const value = readEnv("OMP_DECISION_DISCOVERY")?.toLowerCase();
	return value !== "0" && value !== "false" && value !== "off";
}

function decisionHostname(): string {
	return readEnv("OMP_DECISION_HOSTNAME") ?? DEFAULT_HOSTNAME;
}

function decisionPort(): number {
	const parsed = Number(readEnv("OMP_DECISION_PORT") ?? DEFAULT_PORT);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function normalizeHostName(value: string): string {
	return value.trim().replace(/\.$/, "").toLowerCase();
}

function normalizeDecisionBaseUrl(raw: string): string {
	const parsed = new URL(raw);
	const path = parsed.pathname.replace(/\/+$/g, "");
	parsed.pathname = path.endsWith("/v1") ? path || "/v1" : `${path}/v1`;
	return parsed.toString().replace(/\/$/, "");
}

function healthUrlForBaseUrl(baseUrl: string): string {
	const parsed = new URL(baseUrl);
	const path = parsed.pathname.replace(/\/+$/g, "").replace(/\/v1$/g, "");
	parsed.pathname = `${path}/healthz`;
	return parsed.toString();
}

function cacheSignature(): string {
	return [
		readEnv("OMP_DECISION_ENDPOINT") ?? "",
		readEnv("OMP_DECISION_MODEL") ?? "",
		discoveryEnabled() ? "on" : "off",
		decisionHostname(),
		String(decisionPort()),
	].join("|");
}

export function decisionEndpointIdentityHint(): string {
	const explicit = readEnv("OMP_DECISION_ENDPOINT");
	if (explicit) return `explicit:${explicit}`;
	return discoveryEnabled() ? `tailscale:${decisionHostname()}:${decisionPort()}` : "disabled";
}

function tailscaleExecutables(): readonly string[] {
	const candidates = new Set<string>();
	const configured = readEnv("TAILSCALE_CLI");
	if (configured) candidates.add(configured);
	candidates.add("tailscale");
	if ($env.ProgramFiles) candidates.add(`${$env.ProgramFiles}\\Tailscale\\tailscale.exe`);
	candidates.add("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
	candidates.add("/usr/bin/tailscale");
	candidates.add("/usr/local/bin/tailscale");
	return [...candidates];
}

async function readTailscaleStatus(): Promise<unknown> {
	for (const executable of tailscaleExecutables()) {
		try {
			const child = Bun.spawn([executable, "status", "--json"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const outcome = await Promise.race([
				child.exited.then(code => ({ kind: "exit" as const, code })),
				Bun.sleep(STATUS_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
			]);
			if (outcome.kind === "timeout") {
				child.kill();
				continue;
			}
			if (outcome.code !== 0) continue;
			const stdout = await new Response(child.stdout).text();
			return JSON.parse(stdout) as unknown;
		} catch {
			continue;
		}
	}
	return undefined;
}

function recordsFrom(values: readonly unknown[]): readonly Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	for (const value of values) {
		const record = asRecord(value);
		if (record) records.push(record);
	}
	return records;
}

function statusPeers(status: unknown): readonly Record<string, unknown>[] {
	const root = asRecord(status);
	if (!root) return [];
	const peerValue = root.Peer;
	if (Array.isArray(peerValue)) return recordsFrom(peerValue);
	const peerMap = asRecord(peerValue);
	return peerMap ? recordsFrom(Object.values(peerMap)) : [];
}

function peerMatchesHostname(peer: Record<string, unknown>, expected: string): boolean {
	const normalizedExpected = normalizeHostName(expected);
	for (const key of ["HostName", "DNSName", "ComputedName"] as const) {
		const value = peer[key];
		if (typeof value !== "string") continue;
		const normalized = normalizeHostName(value);
		const leaf = normalized.split(".")[0] ?? "";
		if (normalized === normalizedExpected || leaf === normalizedExpected) return true;
		const suffix = leaf.slice(normalizedExpected.length);
		if (leaf.startsWith(normalizedExpected) && /^-\d+$/.test(suffix)) return true;
	}
	return false;
}

function formatIpHost(ip: string): string {
	return ip.includes(":") ? `[${ip}]` : ip;
}

function candidateOrigins(peer: Record<string, unknown>): readonly string[] {
	const origins = new Set<string>();
	const port = decisionPort();
	const dnsName = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : undefined;
	const hostName = typeof peer.HostName === "string" ? peer.HostName : undefined;
	for (const host of [dnsName, hostName]) {
		if (!host) continue;
		origins.add(`https://${host}`);
		origins.add(`http://${host}:${port}`);
	}
	if (Array.isArray(peer.TailscaleIPs)) {
		for (const ip of peer.TailscaleIPs) {
			if (typeof ip === "string" && ip) origins.add(`http://${formatIpHost(ip)}:${port}`);
		}
	}
	return [...origins];
}

async function probeDecisionEndpoint(
	baseUrl: string,
	source: DecisionEndpoint["source"],
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<DecisionEndpoint | undefined> {
	const normalizedBaseUrl = normalizeDecisionBaseUrl(baseUrl);
	const healthUrl = healthUrlForBaseUrl(normalizedBaseUrl);
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort(signal?.reason);
	if (signal?.aborted) abortFromParent();
	else signal?.addEventListener("abort", abortFromParent, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("decision endpoint health probe timed out")), HEALTH_TIMEOUT_MS);
	try {
		const response = await fetchImpl(healthUrl, { signal: controller.signal });
		if (!response.ok) return undefined;
		const payload = asRecord(await response.json());
		if (!payload || payload.status !== "ok") return undefined;
		const configuredModel = readEnv("OMP_DECISION_MODEL");
		const reportedModel = typeof payload.model === "string" ? payload.model : undefined;
		const model = configuredModel ?? reportedModel;
		if (!model) return undefined;
		return {
			baseUrl: normalizedBaseUrl,
			healthUrl,
			identity: `${source}:${normalizedBaseUrl}:${model}`,
			model,
			source,
		};
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abortFromParent);
	}
}

export async function discoverDecisionEndpoint(
	options: DecisionDiscoveryOptions = {},
): Promise<DecisionEndpoint | undefined> {
	const now = options.now?.() ?? Date.now();
	const signature = cacheSignature();
	if (cachedDecisionEndpoint?.signature === signature && cachedDecisionEndpoint.expiresAt > now) {
		return cachedDecisionEndpoint.endpoint;
	}
	const fetchImpl = options.fetch ?? fetch;
	const explicit = readEnv("OMP_DECISION_ENDPOINT");
	if (explicit) {
		const endpoint = await probeDecisionEndpoint(explicit, "explicit", fetchImpl, options.signal);
		cachedDecisionEndpoint = {
			endpoint,
			expiresAt: now + (endpoint ? POSITIVE_CACHE_MS : NEGATIVE_CACHE_MS),
			signature,
		};
		return endpoint;
	}
	if (!discoveryEnabled()) {
		cachedDecisionEndpoint = { expiresAt: now + NEGATIVE_CACHE_MS, signature };
		return undefined;
	}

	const status = await (options.readTailscaleStatus ?? readTailscaleStatus)();
	const expectedHostname = decisionHostname();
	for (const peer of statusPeers(status)) {
		if (peer.Online === false || !peerMatchesHostname(peer, expectedHostname)) continue;
		for (const origin of candidateOrigins(peer)) {
			const endpoint = await probeDecisionEndpoint(origin, "tailscale", fetchImpl, options.signal);
			if (!endpoint) continue;
			cachedDecisionEndpoint = { endpoint, expiresAt: now + POSITIVE_CACHE_MS, signature };
			logger.debug("[DecisionEndpoint] discovered live tailnet decision service", {
				baseUrl: endpoint.baseUrl,
				model: endpoint.model,
			});
			return endpoint;
		}
	}
	cachedDecisionEndpoint = { expiresAt: now + NEGATIVE_CACHE_MS, signature };
	return undefined;
}

export function invalidateDecisionEndpoint(endpoint?: DecisionEndpoint): void {
	if (!endpoint || cachedDecisionEndpoint?.endpoint?.identity === endpoint.identity) {
		cachedDecisionEndpoint = undefined;
	}
}

/** Test-only cache reset; production callers should use invalidateDecisionEndpoint(). */
export function clearDecisionEndpointCache(): void {
	cachedDecisionEndpoint = undefined;
}
