/**
 * Single source of truth for the version string reported by `--version` and the
 * MCP server. A test asserts it equals package.json.version, so the two cannot
 * drift without CI noticing.
 */
export const PACKAGE_VERSION = "0.1.1";
