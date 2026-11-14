/**
 * Hooks for the Android wrapper. Absent in a normal browser.
 *
 * The wrapper passes `?shell=android`. Remember then goes to the native
 * keystore instead of localStorage, which would keep the link in plaintext.
 */

interface OmpkNativeBridge {
	remember(link: string): void;
	forget(): void;
	leave(): void;
}

interface ShellWindow {
	OmpkNative?: OmpkNativeBridge;
}

export function isAndroidShell(loc: { search: string }): boolean {
	return new URLSearchParams(loc.search).get("shell") === "android";
}

/** True only when the native shell says this open was from an encrypted save. */
export function androidRemembered(loc: { search: string }): boolean {
	if (!isAndroidShell(loc)) return false;
	return new URLSearchParams(loc.search).get("remembered") === "1";
}

export function nativeShell(): OmpkNativeBridge | null {
	if (typeof window === "undefined") return null;
	const bridge = (window as Window & ShellWindow).OmpkNative;
	if (!bridge) return null;
	if (typeof bridge.remember !== "function") return null;
	if (typeof bridge.forget !== "function") return null;
	if (typeof bridge.leave !== "function") return null;
	return bridge;
}
