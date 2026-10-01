import { describe, expect, it } from "bun:test";
import { AgentParsingError, parseAgent } from "@pk-nerdsaver-ai/pi-coding-agent/task/agents";

/**
 * A malformed agent file used to embed its entire body in the thrown error.
 * Agent discovery logs that error on every startup, so a multi-thousand-line
 * prompt produced a ~70 KB log line carrying the whole file in `message`,
 * `stack`, and `cause`. The error must stay proportional to the failure, not to
 * the size of the file that failed.
 */
function malformedAgentContent(bodyLines: number): string {
	// Parses as frontmatter, but has no valid `name`/`description` field.
	return [
		"---",
		"not-a-real-field: true",
		"---",
		...Array.from({ length: bodyLines }, (_, i) => `body line ${i}`),
	].join("\n");
}

describe("agent parsing error size", () => {
	it("does not embed the agent file body in the thrown error", () => {
		const content = malformedAgentContent(5_000);
		let thrown: unknown;
		try {
			parseAgent("/tmp/huge-agent.md", content, "project", "warn");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AgentParsingError);
		const error = thrown as AgentParsingError;

		// The error must name the file and say what was wrong...
		expect(error.message).toContain("/tmp/huge-agent.md");
		expect(error.message).toContain("Invalid agent field");

		// ...without reproducing the file that failed. Generous bound: far below
		// the 5,000-line body, but well above any legitimate diagnostic text.
		expect(error.message.length).toBeLessThan(2_000);
		const serialized = JSON.stringify({ message: error.message, stack: error.stack, cause: String(error.cause) });
		expect(serialized.length).toBeLessThan(8_000);
		expect(serialized).not.toContain("body line 4999");
	});

	it("still reports a valid agent without error", () => {
		const agent = parseAgent(
			"/tmp/valid.md",
			["---", "name: valid-agent", "description: A valid agent.", "---", "Do the thing."].join("\n"),
			"project",
		);
		expect(agent.name).toBe("valid-agent");
		expect(agent.systemPrompt).toContain("Do the thing.");
	});
});
