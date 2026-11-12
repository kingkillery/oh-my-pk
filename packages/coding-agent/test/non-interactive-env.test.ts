import { describe, expect, it } from "bun:test";
import { buildNonInteractiveEnv } from "@pk-nerdsaver-ai/pi-coding-agent/exec/non-interactive-env";

describe("buildNonInteractiveEnv", () => {
	it("defaults Windows child-process encoding to UTF-8 when inherited env is unset", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "win32");

		expect(env.PYTHONIOENCODING).toBe("utf-8");
		expect(env.PYTHONUTF8).toBe("1");
		expect(env.LANG).toBe("C.UTF-8");
		expect(env.LC_ALL).toBe("C.UTF-8");
	});

	it("preserves inherited Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { PYTHONUTF8: "0", LANG: "de_DE.UTF-8" }, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("preserves per-command Windows encoding groups as user-owned", () => {
		const env = buildNonInteractiveEnv({ PYTHONUTF8: "0", LC_ALL: "en_US.UTF-8" }, {}, "win32");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBe("0");
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBe("en_US.UTF-8");
	});

	it("preserves inherited Windows LC category locales as user-owned", () => {
		const env = buildNonInteractiveEnv(undefined, { LC_CTYPE: "en_US.UTF-8" }, "win32");

		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});

	it("does not force UTF-8 encoding defaults on non-Windows platforms", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env.PYTHONIOENCODING).toBeUndefined();
		expect(env.PYTHONUTF8).toBeUndefined();
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});
	it("does not force Unix pager or editor commands on Windows", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "win32");

		for (const key of [
			"PAGER",
			"GIT_PAGER",
			"MANPAGER",
			"SYSTEMD_PAGER",
			"BAT_PAGER",
			"DELTA_PAGER",
			"GH_PAGER",
			"GLAB_PAGER",
			"PSQL_PAGER",
			"MYSQL_PAGER",
			"HOMEBREW_PAGER",
		]) {
			expect(env[key]).toBe("");
		}
		expect(env.GIT_EDITOR).toBe("cmd /c exit 0");
		expect(env.VISUAL).toBe("cmd /c exit 0");
		expect(env.EDITOR).toBe("cmd /c exit 0");
		expect(env.SSH_ASKPASS).toBe("");
	});

	it("keeps Unix noninteractive commands unchanged on non-Windows platforms", () => {
		const env = buildNonInteractiveEnv(undefined, {}, "linux");

		expect(env.PAGER).toBe("cat");
		expect(env.GIT_EDITOR).toBe("true");
		expect(env.SSH_ASKPASS).toBe("/usr/bin/false");
	});
});
