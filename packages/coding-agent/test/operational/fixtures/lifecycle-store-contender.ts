import { access } from "node:fs/promises";
import { LifecycleStore } from "../../../src/operational/lifecycle-store";
import { createStoreRequest } from "./launch-authority-input";

const [directory, contender, mode] = Bun.argv.slice(2);
if (!directory || !contender) throw new Error("contender arguments are required");
const store = await LifecycleStore.open({ dbPath: `${directory}/lifecycle.db`, durability: "normal" });
try {
	const request = createStoreRequest(mode === "same" ? "same" : contender, { maxChildren: 1 });
	await Bun.write(`${directory}/ready-${contender}`, "ready");
	const gatePath = `${directory}/start`;
	const deadline = Date.now() + 15_000;
	while (
		!(await access(gatePath).then(
			() => true,
			() => false,
		))
	) {
		if (Date.now() >= deadline) throw new Error("contender readiness timed out");
		await Bun.sleep(10);
	}
	await Bun.write(Bun.stdout, JSON.stringify(await store.admitLaunchAuthority(request)));
} finally {
	store.close();
}
