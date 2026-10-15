import { expect, test } from "bun:test";
import { buildRemoteSetupScript, resolveColabServingOptions } from "../src/slash-commands/helpers/colab-model";

test("serving options reject unsupported slots, cache types, and microbatches", () => {
	expect(resolveColabServingOptions()).toEqual({ parallelSlots: 1 });
	for (const input of [
		{ parallelSlots: 0 },
		{ parallelSlots: 64 },
		{ kvCacheType: "fp8" },
		{ physicalMicrobatch: 1024, batchSize: 512 },
		{ unknown: true },
		{ disableHostPromptCache: "yes" },
	]) {
		expect(() => resolveColabServingOptions(input as never)).toThrow("Invalid Colab serving settings");
	}
});

test("parallel launch preserves per-request context and emits the selected GPU settings", async () => {
	const setup = buildRemoteSetupScript({
		accelerator: "A100",
		reference: { repoId: "prism-ml/Ternary-Bonsai-2-27B-gguf", revision: "6ed5e12bf84b7a63069882c91dd9e9218647d17b" },
		artifact: {
			primaryFile: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
			files: ["Ternary-Bonsai-2-27B-PQ2_0.gguf"],
			quantization: "PQ2_0",
			totalSize: 7206168928,
		},
		contextWindow: 8192,
		remotePort: 8081,
		serving: {
			parallelSlots: 8,
			kvCacheType: "q8_0",
			physicalMicrobatch: 512,
			batchSize: 2048,
			disableHostPromptCache: true,
		},
	});
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python required");
	const fixture = `import pathlib,sys,tempfile,types
ns={"__name__":"serving_contract"}
exec(compile(sys.stdin.read(),"<setup>","exec"),ns)
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder)
 class Process:
  pid=12345
  def poll(self):return None
 calls=[]
 def popen(args,**kwargs):calls.append(args);return Process()
 ns["subprocess"].Popen=popen
 ns["library_env"]=lambda server:{}
 ns["progress"]=lambda message:None
 ns["adapter_argv"]=lambda model:[]
 ns["adapter_echo"]=lambda:{"adapters":[]}
 ns["request_json"]=lambda *args,**kwargs:{"status":"ok"}
 for name in ["LOG_FILE","PID_FILE","ADAPTER_STATE_FILE"]:ns[name]=root/name
 ns["start_server"](types.SimpleNamespace(server=root/"llama-server",source="prebuilt"),root/"model.gguf","model.gguf","http://127.0.0.1:8081")
 argv=calls[0]
 for flag,value in [("--cache-ram","0"),("--parallel","8"),("--ctx-size","65536"),("--cache-type-k","q8_0"),("--cache-type-v","q8_0"),("--ubatch-size","512"),("--batch-size","2048"),("--flash-attn","on"),("--n-gpu-layers","99")]:assert argv[argv.index(flag)+1]==value,(flag,argv)
 assert "--cont-batching" in argv
 assert ns["CONFIG"]["contextWindow"]==8192
 ns["CONFIG"]["serving"]["disableHostPromptCache"]=False
 calls.clear()
 ns["start_server"](types.SimpleNamespace(server=root/"llama-server",source="prebuilt"),root/"model.gguf","model.gguf","http://127.0.0.1:8081")
 argv=calls[0]
 assert "--cache-ram" not in argv
 for flag,value in [("--parallel","8"),("--cache-type-k","q8_0"),("--cache-type-v","q8_0"),("--ubatch-size","512"),("--batch-size","2048")]:assert argv[argv.index(flag)+1]==value,(flag,argv)
 print("SERVING_CONTRACT_OK")
`;
	const process = Bun.spawn([python, "-E", "-c", fixture], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	process.stdin.write(setup);
	process.stdin.end();
	const [exit, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	expect(exit, stderr).toBe(0);
	expect(stdout).toContain("SERVING_CONTRACT_OK");
}, 15000);
