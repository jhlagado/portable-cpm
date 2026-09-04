import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/bdos/bios-double.test.ts",
      "test/bdos/direct-call.test.ts",
      "test/bdos/directory-write-failure.test.ts",
      "test/bdos/randomized-filesystem.test.ts",
      "test/release-artifacts.test.mjs",
    ],
  },
});
