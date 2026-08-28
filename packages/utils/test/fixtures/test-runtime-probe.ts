import { isBunTestRuntime } from "@pk-nerdsaver-ai/pi-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
