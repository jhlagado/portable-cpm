import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

describe("CCP publication ledger", () => {
  it("has proved rows backed by repository evidence", async () => {
    const matrix = JSON.parse(
      await readFile(
        resolve(
          repositoryRoot,
          "test",
          "ccp",
          "fixtures",
          "feature-matrix.json",
        ),
        "utf8",
      ),
    ) as {
      schema: string;
      publicationReady: boolean;
      hardwareQualified: boolean;
      features: Array<{ id: string; status: string; evidence: string[] }>;
    };
    expect(matrix.schema).toBe("portable-cpm-ccp-feature-matrix-v1");
    expect(matrix.publicationReady).toBe(true);
    expect(matrix.hardwareQualified).toBe(false);
    expect(matrix.features.length).toBeGreaterThan(0);
    for (const feature of matrix.features) {
      expect(feature.status, feature.id).toBe("proved");
      expect(feature.evidence.length, feature.id).toBeGreaterThan(0);
      await Promise.all(
        feature.evidence.map((path) => access(resolve(repositoryRoot, path))),
      );
    }
  });
});
