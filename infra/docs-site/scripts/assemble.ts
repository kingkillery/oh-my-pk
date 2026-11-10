import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const siteRoot = resolve(import.meta.dir, "..");
const output = join(siteRoot, "dist/site");
const assets = join(siteRoot, "dist/assets");
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await cp(output, join(assets, "docs"), { recursive: true });
await cp(join(output, "llms.txt"), join(assets, "llms.txt"));
console.log(`Assembled Worker assets in ${assets}`);
