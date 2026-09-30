import { claimIngestPidLock } from "../ingest-lock";

const pidPath = process.argv[2];
if (!pidPath) throw new Error("Missing isolated lock path");
const claimed = claimIngestPidLock(pidPath, process.pid);
process.stdout.write(`${JSON.stringify({ claimed, pid: process.pid })}\n`);
// Keep the claimant alive until the parent ends its input stream.
process.stdin.resume();
