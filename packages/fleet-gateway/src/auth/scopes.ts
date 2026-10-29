/**
 * Access scopes a gateway client may hold.
 *
 * Two shapes, same rule as t3-fleet-gateway: fleet scopes cover every host
 * including ones added later; host scopes cover exactly one. A stored scope
 * string with anything malformed grants nothing — parse failure is deny, not
 * default-allow.
 */

export const FLEET_READ = "fleet:read";
export const FLEET_OPERATE = "fleet:operate";

export type Scope =
	| { kind: "fleet"; level: "read" | "operate" }
	| { kind: "host"; host: string; level: "read" | "operate" };

const HOST_SCOPE = /^host:([a-z0-9][a-z0-9-]{0,31}):(read|operate)$/;

/** Parse one whitespace-separated scope string; null when anything is malformed. */
export function parseScopes(raw: string): Scope[] | null {
	const out: Scope[] = [];
	for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
		if (part === FLEET_READ) out.push({ kind: "fleet", level: "read" });
		else if (part === FLEET_OPERATE) out.push({ kind: "fleet", level: "operate" });
		else {
			const match = HOST_SCOPE.exec(part);
			if (!match) return null;
			out.push({ kind: "host", host: match[1], level: match[2] as "read" | "operate" });
		}
	}
	return out;
}

export function formatScopes(scopes: readonly Scope[]): string {
	return scopes.map(s => (s.kind === "fleet" ? `fleet:${s.level}` : `host:${s.host}:${s.level}`)).join(" ");
}

/** May this caller perform `level` on `host`? Union of all held scopes. */
export function permits(scopes: readonly Scope[], level: "read" | "operate", host: string): boolean {
	return scopes.some(s => {
		if (s.kind === "fleet") return s.level === level || (s.level === "operate" && level === "read");
		if (s.kind === "host")
			return s.host === host && (s.level === level || (s.level === "operate" && level === "read"));
		return false;
	});
}

/** May this caller perform `level` on at least one host? (tool-listing gate) */
export function permitsAny(scopes: readonly Scope[], level: "read" | "operate"): boolean {
	return scopes.some(s => s.level === level || (s.level === "operate" && level === "read"));
}

/** Hosts the caller holds `level` on; null means every host (a fleet scope). */
export function permittedHosts(scopes: readonly Scope[], level: "read" | "operate"): string[] | null {
	if (scopes.some(s => s.kind === "fleet" && (s.level === level || (s.level === "operate" && level === "read"))))
		return null;
	const hosts = new Set<string>();
	for (const s of scopes) {
		if (s.kind === "host" && (s.level === level || (s.level === "operate" && level === "read"))) hosts.add(s.host);
	}
	return [...hosts];
}
