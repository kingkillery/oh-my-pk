import { describe, expect, it } from "bun:test";
import { androidRemembered, isAndroidShell } from "../src/lib/shell";

describe("android shell query", () => {
	it("recognizes only the android shell", () => {
		expect(isAndroidShell({ search: "?shell=android" })).toBe(true);
		expect(isAndroidShell({ search: "?shell=android&remembered=1" })).toBe(true);
		expect(isAndroidShell({ search: "" })).toBe(false);
		expect(isAndroidShell({ search: "?preview=live" })).toBe(false);
		expect(isAndroidShell({ search: "?shell=browser" })).toBe(false);
	});

	it("reads the remembered flag only inside the shell", () => {
		expect(androidRemembered({ search: "?shell=android&remembered=1" })).toBe(true);
		expect(androidRemembered({ search: "?shell=android&remembered=0" })).toBe(false);
		expect(androidRemembered({ search: "?shell=android" })).toBe(false);
		expect(androidRemembered({ search: "?remembered=1" })).toBe(false);
	});
});
