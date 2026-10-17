import { readSessionMemory, sessionMemoryProject } from "../src/session-memory/project";
import { SessionMemoryStore } from "../src/session-memory/store";

const [action = "status", cwd = process.cwd(), value = "", extra = ""] = Bun.argv.slice(2);
try {
	const project = await sessionMemoryProject(cwd);
	let result: unknown;
	if (action === "build" || action === "restore" || action === "verify") {
		const store = await SessionMemoryStore.open(project.dbPath, project.root, action !== "build");
		try {
			if (action === "verify") {
				const verification = await store.verify();
				result = verification;
				if (verification.faults.length || verification.missingBlobs) process.exitCode = 1;
			} else {
				result =
					action === "restore"
						? await store.restore(value, extra)
						: await store.build({
								...project,
								onProgress: receipt => {
									if ((receipt.indexed + receipt.skipped + receipt.excluded) % 100 === 0)
										process.stderr.write(`${JSON.stringify(receipt)}\n`);
								},
							});
			}
		} finally {
			store.close();
		}
	} else {
		result = await readSessionMemory(project, action, value, Number(extra || 0), action === "source" ? 8192 : 10);
	}
	await Bun.write(Bun.stdout, `${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
	await Bun.write(Bun.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
