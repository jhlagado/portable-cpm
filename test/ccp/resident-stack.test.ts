import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { PortableCpmMachine } from "../support/portable-cpm-machine.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const sentinel = 0xa5;

describe("CCP resident memory", () => {
  it("keeps its guard intact and stays within its 48-byte stack", async () => {
    const [ccp, bdos, bios, disk] = await Promise.all([
      assembleZ80WithLabelsForTest(resolve(repositoryRoot, "src", "ccp.asm")),
      assembleZ80WithLabelsForTest(resolve(repositoryRoot, "src", "bdos.asm")),
      assembleZ80WithLabelsForTest(
        resolve(repositoryRoot, "test", "fixtures", "test-bios.asm"),
      ),
      readFile(resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img")),
    ]);
    const guard = requiredLabel(ccp.labels, "STKGUARD");
    const guardEnd = requiredLabel(ccp.labels, "STKGUEND");
    const stackBase = requiredLabel(ccp.labels, "STKBASE");
    const stackTop = requiredLabel(ccp.labels, "STKTOP");
    expect(guardEnd - guard).toBe(16);
    expect(stackBase).toBe(guardEnd);
    expect(stackTop - stackBase).toBe(48);

    const cases = [
      ["DIR\r", "\r\nA>"],
      ["TYPE README.TXT\r", "\r\nA>"],
      ["DIR EXTRA\r", "\r\nA>"],
      ["ERA *.*\r", "ALL (Y/N)?"],
      ["N\r", "\r\nA>"],
      ["SAVE 1280 BIG.COM\r", "\r\nA>"],
      ["USER 16\r", "\r\nA>"],
      ["Q:\r", "\r\nA>"],
      ["ZZZ\r", "\r\nA>"],
    ] as const;
    const machine = new PortableCpmMachine({
      ccp: ccp.bytes,
      bdos: bdos.bytes,
      bios: bios.bytes,
      disk,
    });
    machine.runUntilOutputSuffix("\r\nA>");
    let minimumStackPointer = stackTop;
    for (const [input, suffix] of cases) {
      const previousLength = machine.outputBytes().length;
      machine.enqueueAscii(input);
      for (let count = 0; count < 2_000_000; count += 1) {
        machine.step();
        const stackPointer = machine.cpuState().sp;
        if (stackPointer >= guard && stackPointer <= stackTop) {
          minimumStackPointer = Math.min(minimumStackPointer, stackPointer);
        }
        const output = machine.outputBytes();
        if (
          output.length > previousLength &&
          Buffer.from(output).toString("latin1").endsWith(suffix)
        ) {
          break;
        }
        if (count === 1_999_999) {
          throw new Error(`step limit reached after ${JSON.stringify(input)}`);
        }
      }
      expect(machine.readRam(guard, guardEnd - guard)).toEqual(
        new Uint8Array(guardEnd - guard).fill(sentinel),
      );
    }
    expect(stackTop - minimumStackPointer).toBe(10);
  }, 15_000);
});

function requiredLabel(
  labels: Readonly<Record<string, number>>,
  name: string,
): number {
  const value = labels[name];
  if (value === undefined) throw new Error(`missing ATOM label ${name}`);
  return value;
}
