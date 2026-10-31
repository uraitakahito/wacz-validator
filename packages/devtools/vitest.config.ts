import { defineConfig } from "vitest/config";

// Shared so `pnpm -r test` sees the same vocabulary the root config does —
// it never loads the root, and strictTags would stop the run without this.
import { TEST_TAGS } from "../../test-tags.js";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["../../test/no-dns.ts"],
    clearMocks: true,
    tags: TEST_TAGS,
  },
});
