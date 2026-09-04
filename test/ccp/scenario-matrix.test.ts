import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  installCpm22File,
  readCpm22File,
} from "../../tools/lib/cpm22-disk.mjs";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { PortableCpmMachine } from "../support/portable-cpm-machine.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const scenarioDirectory = resolve(repositoryRoot, "test", "ccp", "scenarios");
const scenarioNames = [
  "portable-absent-drive.json",
  "portable-builtin-errors.json",
  "portable-dir-type.json",
  "portable-drive-prefix-boundaries.json",
  "portable-era-all-cancel.json",
  "portable-era-all-confirm.json",
  "portable-extra-operands.json",
  "portable-filename-boundaries.json",
  "portable-loader-boundaries.json",
  "portable-loader-oversized.json",
  "portable-mutation-builtins.json",
  "portable-page-zero.json",
  "portable-save-overflow.json",
  "portable-transient-smoke.json",
  "portable-user.json",
];

interface ScenarioInteraction {
  inputAscii: string;
  stopAfterAscii: string;
}

interface Scenario {
  schema: "portable-cpm-headless-scenario-v1";
  id: string;
  initialPrograms?: Array<{
    kind: "assemble-atom";
    name: string;
    path: string;
    bytes: number;
    sha256: string;
  }>;
  initialFiles?: Array<{
    name: string;
    encoding: "generated-bytes";
    bytes: number;
    fillByte: number;
    patches?: Array<{ offset: number; bytes: number[] }>;
  }>;
  expectedFinalFiles?: Array<{
    name: string;
    bytes: number;
    sha256: string;
  }>;
  sessions: Array<{
    interactions: ScenarioInteraction[];
    expectedTranscript: string;
  }>;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

let ccp: Uint8Array;
let bdos: Uint8Array;
let bios: Uint8Array;
let sourceDisk: Uint8Array;
let scenarios: Scenario[];

beforeAll(async () => {
  [ccp, bdos, bios, sourceDisk, scenarios] = await Promise.all([
    assembleZ80WithLabelsForTest(
      resolve(repositoryRoot, "src", "ccp.asm"),
    ).then(({ bytes }) => bytes),
    assembleZ80WithLabelsForTest(
      resolve(repositoryRoot, "src", "bdos.asm"),
    ).then(({ bytes }) => bytes),
    assembleZ80WithLabelsForTest(
      resolve(repositoryRoot, "test", "fixtures", "test-bios.asm"),
    ).then(({ bytes }) => bytes),
    readFile(resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img")),
    Promise.all(
      scenarioNames.map(async (name) =>
        JSON.parse(await readFile(resolve(scenarioDirectory, name), "utf8")),
      ),
    ) as Promise<Scenario[]>,
  ]);
});

describe("portable CCP scenario matrix", () => {
  for (const [index, name] of scenarioNames.entries()) {
    it(name, async () => {
      const scenario = scenarios[index];
      if (scenario === undefined) throw new Error(`missing scenario ${name}`);
      expect(scenario.schema, name).toBe("portable-cpm-headless-scenario-v1");
      let disk: Uint8Array<ArrayBufferLike> = Uint8Array.from(sourceDisk);
      for (const initial of scenario.initialFiles ?? []) {
        const bytes = new Uint8Array(initial.bytes).fill(initial.fillByte);
        for (const patch of initial.patches ?? []) {
          bytes.set(patch.bytes, patch.offset);
        }
        disk = installCpm22File(disk, { name: initial.name, bytes });
      }
      for (const program of scenario.initialPrograms ?? []) {
        const { bytes } = await assembleZ80WithLabelsForTest(
          resolve(repositoryRoot, program.path),
        );
        expect(bytes, `${scenario.id} ${program.name}`).toHaveLength(
          program.bytes,
        );
        expect(sha256(bytes), `${scenario.id} ${program.name}`).toBe(
          program.sha256,
        );
        disk = installCpm22File(disk, { name: program.name, bytes });
      }

      for (const session of scenario.sessions) {
        const machine = new PortableCpmMachine({ ccp, bdos, bios, disk });
        let transcript = "";
        for (const interaction of session.interactions) {
          machine.enqueueAscii(interaction.inputAscii);
          transcript += machine.runUntilOutputSuffix(
            interaction.stopAfterAscii,
            20_000_000,
          );
        }
        expect(transcript, scenario.id).toBe(session.expectedTranscript);
        disk = machine.exportDisk();
      }

      for (const expectedFile of scenario.expectedFinalFiles ?? []) {
        const bytes = readCpm22File(disk, expectedFile.name).subarray(
          0,
          expectedFile.bytes,
        );
        expect(bytes, `${scenario.id} ${expectedFile.name}`).toHaveLength(
          expectedFile.bytes,
        );
        expect(sha256(bytes), `${scenario.id} ${expectedFile.name}`).toBe(
          expectedFile.sha256,
        );
      }
    });
  }
});
