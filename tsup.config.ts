import { defineConfig } from "tsup";

/**
 * Two builds on purpose:
 *  - `dist/cli.js` is the `bin`, with a shebang, bundling nothing beyond deps.
 *  - `dist/index.js` + `dist/mcp/index.js` are importable libraries with types,
 *    so the MCP server can be run as `node ./dist/mcp/index.js`.
 */
export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { index: "src/index.ts", "mcp/index": "src/mcp/index.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    dts: true,
    sourcemap: true,
  },
]);
