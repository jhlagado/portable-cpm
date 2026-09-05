import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { installCpm22File } from "../../tools/lib/cpm22-disk.mjs";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { PortableCpmMachine } from "../support/portable-cpm-machine.js";

const root = resolve(import.meta.dirname, "../..");
type Assembly = Awaited<ReturnType<typeof assembleZ80WithLabelsForTest>>;
let ccp: Assembly;
let probe: Assembly;
let bdos: Assembly;
let bios: Assembly;
let disk: Uint8Array;

beforeAll(async () => {
  [ccp, probe, bdos, bios, disk] = await Promise.all([
    assembleZ80WithLabelsForTest(resolve(root, "src/ccp.asm")),
    assembleZ80WithLabelsForTest(
      resolve(root, "test/ccp/programs/dma-return.asm"),
    ),
    assembleZ80WithLabelsForTest(resolve(root, "src/bdos.asm")),
    assembleZ80WithLabelsForTest(resolve(root, "test/fixtures/test-bios.asm")),
    readFile(resolve(root, "third_party/cpm22/cpm22.img")),
  ]);
});

describe("transient return after default-DMA reads", () => {
  for (const [operation, functionNumber] of [
    ["sequential", 20],
    ["random", 33],
  ] as const) {
    for (const privateStack of [true, false]) {
      it(`${operation} read with ${privateStack ? "saved" : "retained"} entry stack`, () => {
        const program = Uint8Array.from(probe.bytes);
        program[label(probe, "READFN") - 0x100] = functionNumber;
        program[label(probe, "PRIVATE") - 0x100] = Number(privateStack);
        const payload = Uint8Array.from({ length: 128 }, (_, i) => i ^ 0x3c);
        payload.set([0x5a, 0xa5], 126);
        let image = installCpm22File(disk, {
          name: "DMARET.COM",
          bytes: program,
        });
        image = installCpm22File(image, { name: "DATA.BIN", bytes: payload });
        const machine = new PortableCpmMachine({
          ccp: ccp.bytes,
          bdos: bdos.bytes,
          bios: bios.bytes,
          disk: image,
        });
        machine.runUntilOutputSuffix("\r\nA>");
        const originalDisk = machine.exportDisk();
        machine.enqueueAscii("DMARET DATA.BIN\r");
        advance(machine, 0x100);
        const entrySp = machine.cpuState().sp;
        expect(word(machine, entrySp)).toBe(0);
        let minimumSp = entrySp;
        advance(machine, label(probe, "RETURN"), () => {
          const sp = machine.cpuState().sp;
          // BDOS and the test BIOS switch to their own stacks.
          if (sp >= label(ccp, "STKGUARD") && sp <= label(ccp, "STKTOP")) {
            minimumSp = Math.min(minimumSp, sp);
          }
        });
        expect(machine.readRam(label(probe, "OPENRES"), 1)[0]).toBeLessThan(4);
        expect(machine.readRam(label(probe, "READRES"), 1)[0]).toBe(0);
        expect(machine.readRam(0x80, 128)).toEqual(payload);
        expect(
          word(machine, entrySp),
          "DMA must preserve the caller return word",
        ).toBe(0);
        expect(entrySp).toBeGreaterThanOrEqual(label(ccp, "STKBASE"));
        expect(entrySp + 2).toBe(label(ccp, "STKTOP"));
        expect(machine.cpuState().sp).toBe(entrySp);
        expect(word(machine, label(probe, "ENTRYSP"))).toBe(entrySp);
        expect(machine.readRam(label(ccp, "STKGUARD"), 16)).toEqual(
          new Uint8Array(16).fill(0xa5),
        );
        expect(label(ccp, "STKTOP") - minimumSp).toBe(privateStack ? 2 : 48);
        machine.step();
        expect(machine.cpuState().pc).toBe(0);
        expect(machine.cpuState().sp).toBe(entrySp + 2);
        machine.runUntilOutputSuffix("\r\nA>");
        machine.enqueueAscii("DIR DATA.BIN\r");
        expect(machine.runUntilOutputSuffix("\r\nA>")).toMatch(/A: DATA\s+BIN/);
        expect(machine.exportDisk()).toEqual(originalDisk);
        expect(machine.readRam(label(ccp, "STKGUARD"), 16)).toEqual(
          new Uint8Array(16).fill(0xa5),
        );
      });
    }
  }
});

function label(assembly: Assembly, name: string): number {
  const address = assembly.labels[name];
  if (address === undefined) throw new Error(`missing ATOM label ${name}`);
  return address;
}

function word(machine: PortableCpmMachine, address: number): number {
  const bytes = machine.readRam(address, 2);
  return bytes[0]! | (bytes[1]! << 8);
}

function advance(
  machine: PortableCpmMachine,
  pc: number,
  observe = () => {},
): void {
  for (let steps = 0; steps < 1_000_000; steps += 1) {
    if (machine.cpuState().pc === pc) return;
    machine.step();
    observe();
  }
  throw new Error(
    `did not reach PC ${pc.toString(16)}; stopped at ${machine.cpuState().pc.toString(16)}`,
  );
}
