import { describe, expect, test } from "bun:test";
import {
	carriedSection,
	launch,
	createTokeneconomizerExtension,
} from "../src/tokeneconomizer/extension";

describe("carriedSection", () => {
	test("empty entries -> empty string", () => {
		expect(carriedSection([])).toBe("");
	});

	test("compaction with tokeneconomizer systemMessage section", () => {
		const entries = [
			{ type: "compaction", systemMessage: { sections: { tokeneconomizer: "hello" } } },
		];
		expect(carriedSection(entries)).toBe("hello");
	});

	test("message with system role and sections wrapper is unwrapped", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "system",
					sections: { tokeneconomizer: "<tokeneconomizer>\nhello\n</tokeneconomizer>" },
				},
			},
		];
		expect(carriedSection(entries)).toBe("hello");
	});

	test("second compaction overrides first", () => {
		const entries = [
			{ type: "compaction", systemMessage: { sections: { tokeneconomizer: "first" } } },
			{ type: "compaction", systemMessage: { sections: { tokeneconomizer: "second" } } },
		];
		expect(carriedSection(entries)).toBe("second");
	});

	test("ignores entries without type", () => {
		const entries = [{ foo: "bar" }, { type: "message", message: { role: "assistant" } }];
		expect(carriedSection(entries)).toBe("");
	});
});

describe("launch", () => {
	test("posix returns launcher path and args", () => {
		const [prog, argv] = launch("te-hook", ["--host", "ompk"], "linux");
		expect(prog).toContain("te-hook");
		expect(argv).toEqual(["--host", "ompk"]);
	});

	test("win32 routes through te_bootstrap.py with hook mode", () => {
		const [prog, argv] = launch("te-hook", ["--host", "ompk"], "win32");
		expect(prog).toBe("python");
		expect(argv[0]).toContain("te_bootstrap.py");
		expect(argv[1]).toBe("hook");
		expect(argv.slice(2)).toEqual(["--host", "ompk"]);
	});

	test("win32 respects TE_PYTHON env", () => {
		const orig = process.env.TE_PYTHON;
		process.env.TE_PYTHON = "py -3.12";
		try {
			const [prog] = launch("te-hook", ["--host", "ompk"], "win32");
			expect(prog).toBe("py -3.12");
		} finally {
			if (orig === undefined) delete process.env.TE_PYTHON;
			else process.env.TE_PYTHON = orig;
		}
	});
});

describe("createTokeneconomizerExtension", () => {
	test("registers all expected handlers and the te command", () => {
		const events: string[] = [];
		const commands: string[] = [];
		const mockApi = {
			on: (name: string, _handler: unknown) => {
				events.push(name);
			},
			registerCommand: (name: string, _opts: unknown) => {
				commands.push(name);
			},
		};
		const factory = createTokeneconomizerExtension();
		factory(mockApi as unknown as Parameters<typeof factory>[0]);
		expect(events).toContain("session_start");
		expect(events).toContain("before_agent_start");
		expect(events).toContain("tool_result");
		expect(events).toContain("session_shutdown");
		expect(events).toContain("agent_end");
		expect(events).toContain("session_stop");
		expect(events).toContain("turn_end");
		expect(commands).toContain("te");
	});
});
