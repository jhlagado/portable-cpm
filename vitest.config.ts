import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/bdos/bios-double.test.ts",
      "test/bdos/direct-call.test.ts",
      "test/bdos/directory-write-failure.test.ts",
      "test/bdos/eight-mib.test.ts",
      "test/bdos/eight-mib-multiple-drive.test.ts",
      "test/bdos/eight-mib-full-volume.test.ts",
      "test/bdos/eight-mib-directory-full.test.ts",
      "test/bdos/two-mib-sixteen-drive.test.ts",
      "test/bdos/multiple-drive.test.ts",
      "test/bdos/randomized-filesystem.test.ts",
      "test/ccp/portable-machine.test.ts",
      "test/ccp/feature-matrix.test.ts",
      "test/ccp/scenario-matrix.test.ts",
      "test/ccp/resident-stack.test.ts",
      "test/ccp/transient-dma-stack.test.ts",
      "test/ccp/parser-corpus.test.ts",
      "test/ccp/disk-failures.test.mjs",
      "test/ccp/self-assembly.test.mjs",
      "test/ccp/target-profile.test.mjs",
      "test/ccp/two-mib-target-profiles.test.mjs",
      "test/release-artifacts.test.mjs",
    ],
  },
});
