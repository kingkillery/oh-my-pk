/**
 * Single source of truth for the advertised connector version.
 *
 * The MCP `initialize` handshake reports `serverInfo.version`; ChatGPT surfaces
 * it in connector diagnostics. Deriving it from `package.json` keeps the
 * handshake, the CLI banner, and the published package in lockstep.
 */

import packageJson from "../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;
