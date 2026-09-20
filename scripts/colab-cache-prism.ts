import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root = Bun.env.OMPK_COLAB_CACHE_DIR ?? join(homedir(), ".cache", "ompk", "colab");
const artifacts = [
	{
		kind: "runtime",
		name: "llama-prism-b10709-9a9394a-bin-linux-cuda-12.4-x64.tar.gz",
		revision: "9a9394a895b96003ca842a6041cb28ac49a108f7",
		sha256: "f542fdcc818562359e947db65e0b11c4658dd5ca3bd240490448252e817d8e7a",
		url: "https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/llama-prism-b10709-9a9394a-bin-linux-cuda-12.4-x64.tar.gz",
	},
	{
		kind: "model",
		name: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
		revision: "6ed5e12bf84b7a63069882c91dd9e9218647d17b",
		sha256: "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1",
		url: "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-PQ2_0.gguf",
	},
];
for (const artifact of artifacts) {
	const directory = join(root, artifact.kind, artifact.revision);
	await mkdir(directory, { recursive: true });
	const destination = join(directory, artifact.name);
	const file = Bun.file(destination);
	const hasher = new Bun.CryptoHasher("sha256");
	let size = 0;
	if (await file.exists()) {
		for await (const chunk of file.stream()) {
			hasher.update(chunk);
			size += chunk.length;
		}
	} else {
		const response = await fetch(artifact.url, { signal: AbortSignal.timeout(900_000) });
		if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${artifact.name}`);
		const writer = Bun.file(`${destination}.part`).writer();
		let reported = 0;
		try {
			for await (const chunk of response.body) {
				hasher.update(chunk);
				size += chunk.length;
				writer.write(chunk);
				if (size - reported > 268_435_456) {
					await writer.flush();
					process.stdout.write(`${artifact.name}: ${Math.round(size / 1_000_000)} MB\n`);
					reported = size;
				}
			}
		} finally {
			await writer.end();
		}
	}
	const digest = hasher.digest("hex");
	if (digest !== artifact.sha256) throw new Error(`Checksum mismatch: ${artifact.name}`);
	if (!(await file.exists())) await rename(`${destination}.part`, destination);
	await Bun.write(
		join(directory, "manifest.json"),
		JSON.stringify({ ...artifact, path: destination, size, verifiedAt: new Date().toISOString() }, null, 2),
	);
	process.stdout.write(`VERIFIED ${artifact.name} ${size} bytes ${digest}\n`);
}
