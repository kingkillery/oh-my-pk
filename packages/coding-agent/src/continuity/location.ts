import * as path from "node:path";
import { type ParsedVaultUrl, parseVaultUrl, VaultProtocolHandler } from "../internal-urls/vault-protocol";
import { assertWorkstreamId, resolveWithinRoot } from "./store";
import type { ContinuityStore, RegisterRequest, WorkstreamEntry } from "./types";

export interface RecordLocation {
	store: ContinuityStore;
	/** Portable pointer, never the machine-specific resolved path for a vault. */
	canonical: string;
	path: string;
	root: string;
	vault?: string;
}

export class ContinuityLocationError extends Error {
	constructor(
		readonly reason: string,
		message: string,
	) {
		super(message);
		this.name = "ContinuityLocationError";
	}
}

const vaultProtocol = new VaultProtocolHandler();

/** No scanning or mirroring: resolve just the explicitly registered note. */
export async function resolveRecord(
	root: string,
	entry: Pick<WorkstreamEntry, "canonical" | "store" | "vault">,
): Promise<RecordLocation> {
	const isVault = entry.canonical.startsWith("vault://");
	const store = entry.store ?? (isVault ? "vault" : "repo");
	if (store === "vault") {
		if (!isVault)
			throw new ContinuityLocationError("invalid-vault-pointer", "Vault records require a named vault:// file URL.");
		let parsed: ParsedVaultUrl;
		try {
			parsed = parseVaultUrl(entry.canonical);
		} catch (error) {
			throw new ContinuityLocationError(
				"invalid-vault-pointer",
				error instanceof Error ? error.message : String(error),
			);
		}
		if (
			parsed.kind !== "fs-file" ||
			parsed.ref.active ||
			!parsed.ref.vault ||
			Object.keys(parsed.params).length > 0
		) {
			throw new ContinuityLocationError(
				"invalid-vault-pointer",
				"Use a named vault:// file URL without queries; the active vault is not a portable identity.",
			);
		}
		if (entry.vault && entry.vault !== parsed.ref.vault) {
			throw new ContinuityLocationError(
				"invalid-vault-pointer",
				"The registered vault name disagrees with its pointer.",
			);
		}
		try {
			const resolved = await vaultProtocol.resolveFilePath(entry.canonical);
			const target = await resolveWithinRoot(resolved.root, resolved.targetPath);
			return { store, canonical: entry.canonical, path: target, root: resolved.root, vault: parsed.ref.vault };
		} catch (error) {
			throw new ContinuityLocationError(
				"vault-unavailable",
				`${entry.canonical}: ${error instanceof Error ? error.message : String(error)} No repository fallback was created.`,
			);
		}
	}
	try {
		if (isVault || /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.canonical))
			throw new Error("Repository records require a filesystem path.");
		if (!path.isAbsolute(entry.canonical) && path.win32.isAbsolute(entry.canonical))
			throw new Error("Legacy absolute paths from another machine must be explicitly re-registered.");
		const target = path.resolve(root, entry.canonical);
		const resolved = await resolveWithinRoot(root, target);
		return {
			store,
			canonical: path.relative(path.resolve(root), target).split(path.sep).join("/"),
			path: resolved,
			root: path.resolve(root),
		};
	} catch (error) {
		throw new ContinuityLocationError(
			"canonical-outside-root",
			error instanceof Error ? error.message : String(error),
		);
	}
}

/** New records are repo-local unless the caller explicitly selects vault storage. */
export function registrationPointer(request: RegisterRequest): Pick<WorkstreamEntry, "canonical" | "store" | "vault"> {
	assertWorkstreamId(request.workstreamId);
	const store = request.store ?? (request.canonical?.startsWith("vault://") ? "vault" : "repo");
	if (request.canonical)
		return { canonical: request.canonical, store, ...(request.vault ? { vault: request.vault } : {}) };
	if (store === "repo") return { canonical: `.agents/continuity/notes/${request.workstreamId}.md`, store };
	const vault = request.vault?.trim();
	if (!vault || vault === "_")
		throw new ContinuityLocationError(
			"vault-required",
			"Select a named Obsidian vault, or supply an explicit named vault:// note URL.",
		);
	const project = encodeURIComponent(path.basename(path.resolve(request.root)));
	return {
		canonical: `vault://${encodeURIComponent(vault)}/Continuity/${project}/${request.workstreamId}.md`,
		store,
		vault,
	};
}
