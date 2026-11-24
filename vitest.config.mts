import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

/**
 * The tests sit in `test/`, beside `nodes/` and `credentials/` rather than inside them, because
 * n8n's scanner lints those two folders and would flag a test file there as part of the node.
 *
 * `n8n-workflow` resolves to its CommonJS build, the one n8n itself loads the nodes against: its ESM
 * build has extensionless imports Node cannot load. `.mts` because this package is CommonJS.
 */
export default defineConfig({
  resolve: { alias: { "n8n-workflow": createRequire(import.meta.url).resolve("n8n-workflow") } },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    restoreMocks: true,
  },
});
