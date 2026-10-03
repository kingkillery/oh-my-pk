#!/usr/bin/env bun

import { createUnavailableMeshCliApi, runMeshCli } from "../src/index";

const exitCode = await runMeshCli(process.argv.slice(2), createUnavailableMeshCliApi(), {
	write(line: string): void {
		process.stdout.write(line);
	},
});

process.exitCode = exitCode;
