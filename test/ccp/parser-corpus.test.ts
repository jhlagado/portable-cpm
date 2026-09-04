import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { PortableCpmMachine } from "../support/portable-cpm-machine.js";

// Boundary cases and deterministic seed retained from Triptych's parser proof.
// No Triptych checkout, WASM artifact or machine BIOS is required to run them.
const boundaryCases = [
  "",
  " ",
  "       ",
  "  dIr   readme.txt",
  "DIR A:README.TXT",
  "DIR *.*",
  "DIR A*.T*",
  `DIR ${"A".repeat(7)}.TXT`,
  `DIR ${"A".repeat(8)}.TXT`,
  `DIR ${"A".repeat(9)}.TXT`,
  `DIR FILE.${"A".repeat(2)}`,
  `DIR FILE.${"A".repeat(3)}`,
  `DIR FILE.${"A".repeat(4)}`,
  "DIR *.* EXTRA",
  "TYPE",
  "TYPE README.TXT EXTRA",
  "TYPE *.TXT",
  "TYPE .TXT",
  "TYPE A<B.TXT",
  "TYPE A>B.TXT",
  "TYPE A,B.TXT",
  "TYPE A;B.TXT",
  "TYPE AB:CD.TXT",
  "TYPE A[B.TXT",
  "TYPE A]B.TXT",
  "TYPE A%B.TXT",
  "TYPE A|B.TXT",
  "TYPE A(B.TXT",
  "TYPE A)B.TXT",
  "TYPE A/B.TXT",
  "TYPE A\\B.TXT",
  `TYPE ${"T".repeat(8)}.${"C".repeat(3)}`,
  `TYPE ${"T".repeat(9)}.COM`,
  "ERA",
  "ERA README.TXT EXTRA",
  "REN",
  "REN =README.TXT",
  "REN .TXT=README.TXT",
  "REN NEW.TXT=",
  "REN NEW.TXT= ",
  "REN NEW.TXT=.TXT",
  "REN NEW.TXT=*.TXT",
  "REN NEW.TXT README.TXT",
  "REN NEW.TXT=README.TXT EXTRA",
  `REN ${"N".repeat(9)}.TXT=README.TXT`,
  "SAVE",
  "SAVE -1 BAD.COM",
  "SAVE +1 BAD.COM",
  "SAVE 1",
  "SAVE 0 .COM",
  "SAVE 0 *.COM",
  "SAVE 1 BAD.COM EXTRA",
  "SAVE 228 BAD.COM",
  "SAVE 255 BAD.COM",
  "SAVE 256 BAD.COM",
  "SAVE 999999999999999999999 BAD.COM",
  "USER",
  "USER -1",
  "USER +1",
  "USER 00",
  "USER 16",
  "USER 99",
  "USER 999999999999999999999",
  "Q:",
  "Z:",
  "AA:",
  "DIRX",
  "TYP",
  "THISCOMMANDISLONGERTHANEIGHT",
  "SMO*",
  `TYPE ${"X".repeat(122)}`,
];

const requiredTranscriptFragments = new Map([
  ["  dIr   readme.txt", "A: README   TXT"],
  ["DIR A:README.TXT", "A: README   TXT"],
  ["DIR *.*", "A: README   TXT"],
  ["DIR A*.T*", "NO FILE"],
  [`DIR ${"A".repeat(8)}.TXT`, "NO FILE"],
  [`DIR ${"A".repeat(9)}.TXT`, `${"A".repeat(9)}.TXT?`],
  ["TYPE *.TXT", "*.TXT?"],
  ["TYPE .TXT", ".TXT?"],
  ["TYPE A,B.TXT", "A,B.TXT?"],
  ["TYPE AB:CD.TXT", "AB:CD.TXT?"],
  ["TYPE A\\B.TXT", "A\\B.TXT?"],
  ["REN =README.TXT", "=README.TXT?"],
  ["REN .TXT=README.TXT", ".TXT=README.TXT?"],
  ["SAVE 228 BAD.COM", "228?"],
  ["USER 16", "16?"],
  ["Q:", "Q:?"],
  ["SMO*", "SMO*?"],
]);

let randomState = 0x54524950;
function random() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState;
}

const fuzzAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._:-=";
const fuzzCases = Array.from({ length: 64 }, () => {
  const length = 1 + (random() % 122);
  let argument = "";
  for (let index = 0; index < length; index += 1) {
    argument += fuzzAlphabet[random() % fuzzAlphabet.length];
  }
  return `TYPE ${argument}`.slice(0, 127);
});

const root = resolve(import.meta.dirname, "../..");
let ccp: Uint8Array;
let bdos: Uint8Array;
let bios: Uint8Array;
let disk: Uint8Array;
let guard: number;
let guardEnd: number;

beforeAll(async () => {
  const [assembledCcp, assembledBdos, assembledBios, sourceDisk] =
    await Promise.all([
      assembleZ80WithLabelsForTest(resolve(root, "src/ccp.asm")),
      assembleZ80WithLabelsForTest(resolve(root, "src/bdos.asm")),
      assembleZ80WithLabelsForTest(
        resolve(root, "test/fixtures/test-bios.asm"),
      ),
      readFile(resolve(root, "third_party/cpm22/cpm22.img")),
    ]);
  ccp = assembledCcp.bytes;
  bdos = assembledBdos.bytes;
  bios = assembledBios.bytes;
  disk = sourceDisk;
  const start = assembledCcp.labels.STKGUARD;
  const end = assembledCcp.labels.STKGUEND;
  if (start === undefined || end === undefined)
    throw new Error("CCP stack guard labels missing");
  guard = start;
  guardEnd = end;
  expect(guardEnd - guard).toBe(16);
});

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// A malformed token can itself contain a prompt-like suffix. Require 256
// quiet instruction steps before accepting it as the real command prompt.
function interact(machine: PortableCpmMachine, input: string): string {
  const previousLength = machine.outputBytes().length;
  machine.enqueueAscii(input);
  let observedLength = previousLength;
  let quietSteps = 0;
  for (let count = 0; count < 1_000_000; count += 1) {
    machine.step();
    const output = machine.outputBytes();
    if (output.length !== observedLength) {
      observedLength = output.length;
      quietSteps = 0;
    } else if (
      output.length > previousLength &&
      Buffer.from(output).toString("latin1").endsWith("\r\nA>")
    ) {
      quietSteps += 1;
    } else {
      quietSteps = 0;
    }
    if (quietSteps >= 256)
      return Buffer.from(output.slice(previousLength)).toString("latin1");
  }
  throw new Error(
    "CCP failed to return to a stable prompt after " + JSON.stringify(input),
  );
}

describe("CCP parser boundary and seeded generated corpus", () => {
  for (const [index, command] of [...boundaryCases, ...fuzzCases].entries()) {
    it(`case ${index}: ${JSON.stringify(command)}`, () => {
      const machine = new PortableCpmMachine({ ccp, bdos, bios, disk });
      interact(machine, "");
      const before = digest(machine.exportDisk());
      const transcript = interact(machine, command + "\r");
      const fragment = requiredTranscriptFragments.get(command);
      if (fragment !== undefined) expect(transcript).toContain(fragment);
      expect(digest(machine.exportDisk())).toBe(before);
      expect(machine.readRam(guard, guardEnd - guard)).toEqual(
        new Uint8Array(guardEnd - guard).fill(0xa5),
      );
      expect(interact(machine, "DIR README.TXT\r")).toMatch(/A: README\s+TXT/);
      expect(digest(machine.exportDisk())).toBe(before);
      expect(machine.readRam(guard, guardEnd - guard)).toEqual(
        new Uint8Array(guardEnd - guard).fill(0xa5),
      );
    });
  }
});
