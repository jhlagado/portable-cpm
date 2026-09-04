import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/bdos/bios-double.test.ts",
      "test/bdos/direct-call.test.ts",
      "test/bdos/directory-write-failure.test.ts",
      "test/bdos/randomized-filesystem.test.ts",
      "test/ccp/portable-machine.test.ts",
      "test/ccp/feature-matrix.test.ts",
      "test/ccp/scenario-matrix.test.ts",
      "test/ccp/resident-stack.test.ts",
      "test/ccp/parser-corpus.test.ts",
      "test/ccp/disk-failures.test.mjs",
      "test/release-artifacts.test.mjs",
    ],
  },
});
