import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { PortableCpmMachine } from "../support/portable-cpm-machine.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
let ccp: Uint8Array;
let bdos: Uint8Array;
let bios: Uint8Array;
let disk: Uint8Array;

beforeAll(async () => {
  [ccp, bdos, bios, disk] = await Promise.all([
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
  ]);
});

describe("portable CCP/BDOS test BIOS", () => {
  it("isolates Buffer input and exported disks from guest writes", () => {
    const input = Buffer.from(disk);
    const original = Buffer.from(input);
    const machine = new PortableCpmMachine({ ccp, bdos, bios, disk: input });
    machine.runUntilOutputSuffix("\r\nA>");
    machine.enqueueAscii("ERA README.TXT\r");
    machine.runUntilOutputSuffix("\r\nA>");
    expect(input).toEqual(original);
    const exported = machine.exportDisk();
    const snapshot = Uint8Array.from(exported);
    exported.fill(0);
    expect(machine.exportDisk()).toEqual(snapshot);
  });

  it("boots without a Triptych BIOS and recovers after a command", () => {
    const machine = new PortableCpmMachine({ ccp, bdos, bios, disk });
    expect(machine.runUntilOutputSuffix("\r\nA>")).toBe("\r\nA>");

    machine.enqueueAscii("DIR README.TXT\r");
    const transcript = machine.runUntilOutputSuffix("\r\nA>");
    expect(transcript).toMatch(/A: README\s+TXT/);

    machine.enqueueAscii("TYPE MISSING.TXT\r");
    expect(machine.runUntilOutputSuffix("\r\nA>")).toContain("NO FILE");
    machine.enqueueAscii("DIR README.TXT\r");
    expect(machine.runUntilOutputSuffix("\r\nA>")).toMatch(/A: README\s+TXT/);
  });

  it("warm-boots and accepts another command after a BIOS write failure", () => {
    const machine = new PortableCpmMachine({
      ccp,
      bdos,
      bios,
      disk,
      writable: false,
    });
    machine.runUntilOutputSuffix("\r\nA>");
    const before = machine.exportDisk();

    machine.enqueueAscii("SAVE 1 NEW.COM\r");
    expect(machine.runUntilOutputSuffix("Bdos Err On A: Bad Sector")).toContain(
      "Bdos Err On A: Bad Sector",
    );
    machine.enqueueAscii("\r");
    machine.runUntilOutputSuffix("\r\nA>");
    machine.enqueueAscii("DIR README.TXT\r");
    expect(machine.runUntilOutputSuffix("\r\nA>")).toMatch(/A: README\s+TXT/);
    expect(machine.exportDisk()).toEqual(before);
  });
});
