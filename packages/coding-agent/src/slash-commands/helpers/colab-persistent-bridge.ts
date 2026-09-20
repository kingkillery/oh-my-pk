import bridgeSource from "./colab-warm-bridge.py" with { type: "text" };

export interface PersistentColabBridge {
	apiBaseUrl: string;
	reused: boolean;
	/** Stops only a child created by this handle; never a reused listener or kernel. */
	stop(): Promise<void>;
}

export interface PersistentColabBridgeOptions {
	sessionName: string;
	modelId: string;
	remotePort: number;
	localPort?: number;
}

async function verifyBridge(apiBaseUrl: string, modelId: string): Promise<boolean> {
	// Observed on this machine: a freshly bound WSL listener can be refused from
	// Windows for a short window before localhost forwarding reflects it. Retry
	// connect failures only; HTTP responses are definitive and never retried.
	let health: Response | undefined;
	for (let attempt = 0; attempt < 8 && !health; attempt++) {
		try {
			health = await fetch(new URL("/health", apiBaseUrl), { signal: AbortSignal.timeout(5_000) });
		} catch (error) {
			if (attempt === 7) throw error;
			await Bun.sleep(1_500);
		}
	}
	if (!health) throw new Error("Colab bridge health probe did not complete.");
	await health.arrayBuffer();
	if (!health.ok) throw new Error(`Existing Colab bridge is not ready (HTTP ${health.status}); it was not replaced.`);
	const response = await fetch(`${apiBaseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
	const payload: unknown = await response.json();
	if (
		!response.ok ||
		!payload ||
		typeof payload !== "object" ||
		!("data" in payload) ||
		!Array.isArray(payload.data)
	) {
		throw new Error("Existing listener did not provide an OpenAI model list; it was not replaced.");
	}
	return payload.data.some(
		(entry: unknown) => entry !== null && typeof entry === "object" && "id" in entry && entry.id === modelId,
	);
}

/** No provisioning, runtime restart, generation retry, or idle polling. */
export async function startPersistentColabBridge(
	options: PersistentColabBridgeOptions,
): Promise<PersistentColabBridge> {
	const localPort = options.localPort ?? 18082;
	if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535)
		throw new Error("Invalid local bridge port");
	const apiBaseUrl = `http://127.0.0.1:${localPort}/v1`;
	let listenerExists = false;
	try {
		const connection = await Bun.connect({
			hostname: "127.0.0.1",
			port: localPort,
			socket: {
				data() {},
				open(socket) {
					socket.end();
				},
				error() {},
				close() {},
			},
		});
		connection.end();
		listenerExists = true;
	} catch {
		// No listener: bind in the child before connecting to the remote kernel.
	}
	if (listenerExists) {
		if (!(await verifyBridge(apiBaseUrl, options.modelId)))
			throw new Error("Existing bridge serves a different model; it was not replaced.");
		return { apiBaseUrl, reused: true, async stop() {} };
	}
	const python =
		Bun.env.OMPK_COLAB_PYTHON?.trim() || (process.platform === "win32" ? "/opt/colab-cli/bin/python" : "python3");
	const sourceBytes = new TextEncoder().encode(bridgeSource);
	// Keep stdin open after sending the length-delimited source. EOF is an
	// ownership lease: parent exit/stop closes ONLY this Python bridge process.
	const bootstrap =
		"import sys,threading,os\nsource=sys.stdin.buffer.read(int(sys.argv.pop(1)))\ndef owner_closed():\n os.read(sys.stdin.fileno(),1)\n os._exit(0)\nthreading.Thread(target=owner_closed,daemon=True).start()\nexec(compile(source,'ompk-colab-warm-bridge.py','exec'))";
	const args = [
		python,
		"-u",
		"-c",
		bootstrap,
		String(sourceBytes.length),
		"--session",
		options.sessionName,
		"--port",
		String(localPort),
		"--remote-port",
		String(options.remotePort),
	];
	const child = Bun.spawn(process.platform === "win32" ? ["wsl.exe", "-d", "Ubuntu", "-e", ...args] : args, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	child.stdin.write(sourceBytes);
	await child.stdin.flush();
	// Drain stderr without retaining it; startup failures surface via the
	// structured "startup_error" event on stdout plus the child exit code.
	void (async () => {
		for await (const _chunk of child.stderr) {
			/* discard */
		}
	})().catch(() => {});
	const reader = child.stdout.getReader();
	const ready = (async () => {
		let pending = "";
		const decoder = new TextDecoder();
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Colab bridge exited before readiness");
			pending += decoder.decode(chunk.value, { stream: true });
			if (pending.length > 32_768) throw new Error("Colab bridge readiness metadata too large");
			const newline = pending.indexOf("\n");
			if (newline < 0) continue;
			const metadata: unknown = JSON.parse(pending.slice(0, newline));
			if (metadata && typeof metadata === "object" && "event" in metadata && metadata.event === "startup_error") {
				throw new Error(
					"Cannot attach the existing Colab kernel. Refresh existing-session credentials and restart the bridge; no runtime was provisioned.",
				);
			}
			if (!metadata || typeof metadata !== "object" || !("event" in metadata) || metadata.event !== "ready")
				throw new Error("Invalid bridge readiness");
			break;
		}
	})();
	const stop = async () => {
		child.stdin.end();
		const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
		if (!exited) child.kill();
	};
	const deadline = Promise.withResolvers<never>();
	const startupTimer = setTimeout(() => deadline.reject(new Error("Colab bridge startup timed out")), 20_000);
	try {
		await Promise.race([ready, deadline.promise]);
		void (async () => {
			while (!(await reader.read()).done) {
				/* discard redacted diagnostics */
			}
		})().catch(() => {});
		if (!(await verifyBridge(apiBaseUrl, options.modelId))) throw new Error("Colab bridge model identity mismatch");
		return { apiBaseUrl, reused: false, stop };
	} catch (error) {
		const exitCode = await Promise.race([child.exited, Bun.sleep(2_000).then(() => null)]);
		await stop();
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}${exitCode !== null ? ` (child exited ${exitCode})` : ""}`,
		);
	} finally {
		clearTimeout(startupTimer);
	}
}
