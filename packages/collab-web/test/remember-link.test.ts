import { describe, expect, it } from "bun:test";
import {
	forgetLink,
	type KeyValueStore,
	publicConnectError,
	REMEMBER_FLAG_KEY,
	REMEMBER_LINK_KEY,
	readRememberedLink,
	rememberLink,
} from "../src/lib/remember-link";

const LINK = "test-room.test-secret";

function memoryStore(seed?: Record<string, string>): KeyValueStore & { dump(): Record<string, string> } {
	const map = new Map(Object.entries(seed ?? {}));
	return {
		getItem: key => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
		removeItem: key => {
			map.delete(key);
		},
		dump: () => Object.fromEntries(map),
	};
}

describe("remember link storage", () => {
	it("is off until remember is called, then returns only that link", () => {
		const store = memoryStore();
		expect(readRememberedLink(store)).toBeNull();

		expect(rememberLink(store, `  ${LINK}  `)).toBe(true);
		expect(store.dump()).toEqual({ [REMEMBER_FLAG_KEY]: "1", [REMEMBER_LINK_KEY]: LINK });
		expect(readRememberedLink(store)).toBe(LINK);
	});

	it("ignores a leftover link when the flag is off", () => {
		const store = memoryStore({ [REMEMBER_LINK_KEY]: LINK });
		expect(readRememberedLink(store)).toBeNull();
	});

	it("forget removes the flag and the link", () => {
		const store = memoryStore();
		rememberLink(store, LINK);
		forgetLink(store);
		expect(readRememberedLink(store)).toBeNull();
		expect(store.dump()).toEqual({});
	});

	it("rejects an empty link and a store that does not keep the write", () => {
		const store = memoryStore();
		expect(rememberLink(store, "   ")).toBe(false);
		expect(store.dump()).toEqual({});

		const dropped: KeyValueStore = {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		};
		expect(rememberLink(dropped, LINK)).toBe(false);
	});

	it("returns null and does not throw when storage fails", () => {
		const broken: KeyValueStore = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		expect(readRememberedLink(broken)).toBeNull();
		expect(rememberLink(broken, LINK)).toBe(false);
		expect(() => forgetLink(broken)).not.toThrow();
	});

	it("strips the link out of a connect error", () => {
		expect(publicConnectError(new Error(`Invalid collab link: ${LINK}`), LINK)).toBe("Could not open that session");
		expect(publicConnectError(new Error("Collab link is missing the <key> part"), LINK)).toBe(
			"Collab link is missing the <key> part",
		);
	});
});
