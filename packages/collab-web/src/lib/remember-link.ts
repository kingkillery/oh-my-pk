/**
 * Optional "remember this session on this device".
 *
 * Stores the last collab link in local storage only. The link is a secret
 * (room id + room key): callers must not log it, put it in errors, or send it
 * anywhere except the existing in-browser relay connection.
 *
 * Off unless {@link rememberLink} is called. {@link forgetLink} removes both keys.
 */

export const REMEMBER_FLAG_KEY = "omp.collab.remember";
export const REMEMBER_LINK_KEY = "omp.collab.link";

export interface KeyValueStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** localStorage, or a no-op store when storage is blocked. Never throws. */
export function localRememberStore(): KeyValueStore {
	try {
		const storage = globalThis.localStorage;
		return {
			getItem: key => {
				try {
					return storage.getItem(key);
				} catch {
					return null;
				}
			},
			setItem: (key, value) => {
				try {
					storage.setItem(key, value);
				} catch {
					// private mode or quota — rememberLink verifies the write
				}
			},
			removeItem: key => {
				try {
					storage.removeItem(key);
				} catch {
					// already inaccessible
				}
			},
		};
	} catch {
		return {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		};
	}
}

/** The saved link, or null when remember is off, empty, or storage fails. */
export function readRememberedLink(store: KeyValueStore): string | null {
	try {
		if (store.getItem(REMEMBER_FLAG_KEY) !== "1") return null;
		const link = store.getItem(REMEMBER_LINK_KEY);
		if (typeof link !== "string") return null;
		const trimmed = link.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Save `link` and turn remember on.
 * Returns false when the link is empty or storage does not keep the value.
 */
export function rememberLink(store: KeyValueStore, link: string): boolean {
	const trimmed = link.trim();
	if (trimmed.length === 0) return false;
	try {
		store.setItem(REMEMBER_FLAG_KEY, "1");
		store.setItem(REMEMBER_LINK_KEY, trimmed);
		return store.getItem(REMEMBER_FLAG_KEY) === "1" && store.getItem(REMEMBER_LINK_KEY) === trimmed;
	} catch {
		return false;
	}
}

/**
 * Parser errors echo the raw link. Replace those with a fixed sentence so the
 * secret cannot land in the connect screen or a log the UI surfaces.
 */
export function publicConnectError(err: unknown, link: string): string {
	const raw = err instanceof Error ? err.message : String(err);
	if (link.length > 0 && raw.includes(link)) return "Could not open that session";
	return raw;
}

/** Remove the flag and the link. Safe when storage throws. */
export function forgetLink(store: KeyValueStore): void {
	try {
		store.removeItem(REMEMBER_FLAG_KEY);
		store.removeItem(REMEMBER_LINK_KEY);
	} catch {
		// already gone
	}
}
