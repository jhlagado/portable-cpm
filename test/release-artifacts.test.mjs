import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildPortableCpmArtifacts } from "../tools/build-release.mjs";
import { targetProfile } from "../tools/lib/target-profiles.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("portable CP/M release artifacts", () => {
  for (const profileId of ["triptych-cpu-v0.1", "test-low-memory-v1"]) {
    it(`builds deterministic CCP and BDOS binaries for ${profileId}`, async () => {
      const profile = targetProfile(profileId);
      const firstDirectory = await mkdtemp(
        join(tmpdir(), "portable-cpm-first-"),
      );
      const secondDirectory = await mkdtemp(
        join(tmpdir(), "portable-cpm-second-"),
      );
      try {
        const first = await buildPortableCpmArtifacts({
          repositoryRoot: resolve(import.meta.dirname, ".."),
          outputDirectory: firstDirectory,
          profileId,
        });
        const second = await buildPortableCpmArtifacts({
          repositoryRoot: resolve(import.meta.dirname, ".."),
          outputDirectory: secondDirectory,
          profileId,
        });

        expect(first).toEqual(second);
        expect(first.schema).toBe("portable-cpm-artifacts-v1");
        expect(first.targetProfile).toBe(profileId);
        expect(first.atom.revision).toBe(
          "802b5c2d320bec777f427755ff2d7338e3b80a05",
        );
        expect(
          first.components.map(({ id, origin, entry, capacity, bytes }) => ({
            id,
            origin,
            entry,
            capacity,
            bytes,
          })),
        ).toEqual([
          {
            id: "ccp",
            origin: profile.ccp,
            entry: profile.ccp,
            capacity: 2048,
            bytes: 2048,
          },
          {
            id: "bdos",
            origin: profile.bdos,
            entry: profile.bdos + 6,
            capacity: 3584,
            bytes: 3584,
          },
        ]);

        for (const component of first.components) {
          const firstBytes = await readFile(
            join(firstDirectory, component.file),
          );
          const secondBytes = await readFile(
            join(secondDirectory, component.file),
          );
          expect(firstBytes).toEqual(secondBytes);
          expect(firstBytes).toHaveLength(component.capacity);
          expect(sha256(firstBytes)).toBe(component.sha256);
        }
        expect(
          await readFile(join(firstDirectory, "manifest.json"), "utf8"),
        ).toBe(await readFile(join(secondDirectory, "manifest.json"), "utf8"));
      } finally {
        await rm(firstDirectory, { recursive: true, force: true });
        await rm(secondDirectory, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
