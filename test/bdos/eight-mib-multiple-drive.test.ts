import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import {
  runBdosDirectCallSequence,
  unexpectedDirectCallWrites,
  type BdosDirectCallStep,
  type BdosDirectCallResult,
} from "../support/bdos-direct-call.js";
import type { BdosBiosDiskFixture } from "../support/bdos-bios-double.js";

const FIRST = 0x200;
const SECOND = 0x240;
const DMA = 0x800;
const SP = 0xd000;
const ALVS = [0xfc00, 0xfe00];
const ALV_BYTES = 511;
const GUARDS = [0xfbff, 0xfdff, 0xffff, SP - 3, SP];
const evidence = [
  {
    kind: "published-interface" as const,
    source: "Portable CP/M BDOS v0.1 contract",
    section:
      "Disk and file state; per-drive BIOS DPH/DPB and FCB drive selection",
  },
];

function fcb(name = "LARGE", drive = 0, block = 0, records = 0): number[] {
  const bytes = new Array<number>(36).fill(0);
  bytes[0] = drive;
  bytes.splice(1, 11, ...Buffer.from(`${name.padEnd(8)}DAT`, "ascii"));
  bytes[15] = records;
  bytes[16] = block & 255;
  bytes[17] = block >>> 8;
  return bytes;
}

// Two exact 65,536-record geometries; storage is the existing sparse BIOS
// double, not a machine BIOS or native/WASM image provider. The directory
// buffer is deliberately shared, while all 511 ALV bytes belong to one drive.
function disks(withLastBlockFile = false): BdosBiosDiskFixture {
  return {
    drives: [0, 1].map((number) => {
      const directory = new Array<number>(128).fill(0xe5);
      if (withLastBlockFile)
        directory.splice(0, 32, ...fcb("LARGE", 0, 4087, 16).slice(0, 32));
      return {
        number,
        dphAddress: 0xfb20 + number * 0x20,
        dpbAddress: 0xfb30 + number * 0x20,
        directoryBufferAddress: 0xfa80,
        checkVectorAddress: 0xfb80,
        allocationVectorAddress: ALVS[number]!,
        firstSector: 1,
        defaultRecordByte: 0xe5,
        dpb: {
          sectorsPerTrack: 128,
          blockShift: 4,
          blockMask: 15,
          extentMask: 0,
          maximumBlock: 4087,
          maximumDirectoryEntry: 511,
          directoryAllocation0: 255,
          directoryAllocation1: 0,
          checkVectorBytes: 0,
          reservedTracks: 1,
        },
        records: [
          { record: 128, bytes: directory },
          { record: 65534, fill: number ? 0xb0 : 0xa0 },
          { record: 65535, fill: number ? 0xb2 : 0xa1 },
        ],
      };
    }),
  };
}

function step(
  id: string,
  fn: number,
  de = FIRST,
  initialMemory: BdosDirectCallStep["initialMemory"] = [],
): BdosDirectCallStep {
  return {
    id,
    evidence,
    call: { function: fn, de, stackPointer: SP },
    initialMemory,
    biosResponses: [],
    expected: {},
  };
}
const reset = () =>
  step(
    "reset",
    13,
    0,
    GUARDS.map((address) => ({ address, bytes: [0x59] })),
  );
const payload = (fill: number) => ({ address: DMA, length: 128, fill });
const vector = (result: BdosDirectCallResult, drive: number) =>
  result.memory.slice(ALVS[drive], ALVS[drive]! + ALV_BYTES);
const recordsOn = (result: BdosDirectCallResult, drive: number) =>
  result.biosDisk!.records.filter((record) => record.drive === drive);
const recordAt = (
  result: BdosDirectCallResult,
  drive: number,
  address: number,
) =>
  recordsOn(result, drive).find((record) => record.record === address)?.bytes;

describe("two 8 MiB drives through the portable BDOS BIOS interface", () => {
  let bdos: Uint8Array;
  let stackBase: number;
  beforeAll(async () => {
    const assembled = await assembleZ80WithLabelsForTest(
      resolve("src/bdos.asm"),
    );
    bdos = assembled.bytes;
    stackBase = assembled.labels.STKBASE!;
    expect(bdos.length, "production BDOS slot").toBe(3584);
  });

  function run(biosDisk: BdosBiosDiskFixture, steps: BdosDirectCallStep[]) {
    const results = runBdosDirectCallSequence(bdos, {
      schema: "portable-cpm-bdos-direct-sequence-v1",
      id: "eight-mib-multiple-drive",
      description:
        "Two independent 8 MiB geometries and adjacent guarded 511-byte allocation vectors",
      biosDisk,
      steps,
    }).steps.map(({ result }) => result);
    const allowed = new Set([
      ...[FIRST, SECOND].flatMap((address) =>
        Array.from({ length: 36 }, (_, index) => address + index),
      ),
      ...Array.from({ length: 128 }, (_, index) => DMA + index),
    ]);
    for (const result of results) {
      expect(result.stop).toBe("normal-return");
      expect(result.registers.sp).toBe(SP);
      expect(result.registers.pc).toBe(0x104);
      expect(result.minimumResidentStackPointer).toBeGreaterThanOrEqual(
        stackBase,
      );
      for (const address of GUARDS) expect(result.memory[address]).toBe(0x59);
      expect(unexpectedDirectCallWrites(result, SP, allowed)).toEqual([]);
    }
    return results;
  }

  it.each([false, true])(
    "clears and rebuilds all 511 bytes independently (final block occupied: %s)",
    (occupied) => {
      const results = run(disks(occupied), [
        reset(),
        step("initialize-b", 14, 1),
        step("default-a", 14, 0),
        step(
          "dirty-both-vectors",
          26,
          DMA,
          ALVS.map((address) => ({ address, length: ALV_BYTES, fill: 255 })),
        ),
        step("reset-a", 37, 1),
        step("relogin-a", 14, 0),
        step("reset-b", 37, 2),
        step("relogin-b", 14, 1),
      ]);
      const expected = new Uint8Array(ALV_BYTES);
      expected[0] = 255;
      // Empty media must clear the final bit too; populated media reconstructs it.
      expected[510] = occupied ? 1 : 0;
      expect(vector(results[5]!, 0)).toEqual(expected);
      expect(vector(results[5]!, 1)).toEqual(
        new Uint8Array(ALV_BYTES).fill(255),
      );
      expect(vector(results[7]!, 0)).toEqual(expected);
      expect(vector(results[7]!, 1)).toEqual(expected);
      expect(results[7]!.biosDisk!.records).toEqual(
        results[0]!.biosDisk!.records,
      );
      expect(results[7]!.biosDisk!.writes).toEqual([]);
    },
  );

  it("reads and updates B's final record 65535 while A's same-address record and both neighbors survive", () => {
    const results = run(disks(true), [
      reset(),
      step("dma", 26, DMA),
      step("open-explicit-b", 15, FIRST, [
        { address: FIRST, bytes: fcb("LARGE", 2) },
      ]),
      step("read-final-b", 20, FIRST, [
        { address: FIRST + 32, bytes: [15] },
        payload(0),
      ]),
      step("write-final-b", 34, FIRST, [
        { address: FIRST + 33, bytes: [15, 0, 0] },
        payload(0xc3),
      ]),
      step("close-b", 16, FIRST),
      step("open-default-a", 15, SECOND, [{ address: SECOND, bytes: fcb() }]),
      step("read-final-a", 20, SECOND, [
        { address: SECOND + 32, bytes: [15] },
        payload(0),
      ]),
      step("reread-final-b", 33, FIRST, [payload(0)]),
      step("default-still-a", 25, 0),
    ]);
    for (const index of [2, 5, 6])
      expect(results[index]!.registers.a).toBeLessThan(4);
    for (const index of [3, 4, 7, 8, 9])
      expect(results[index]!.registers.a).toBe(0);
    expect([...results[2]!.memory.slice(FIRST + 16, FIRST + 18)]).toEqual([
      0xf7, 0x0f,
    ]);
    expect([...results[3]!.memory.slice(DMA, DMA + 128)]).toEqual(
      new Array(128).fill(0xb2),
    );
    expect(results[3]!.biosDisk!.track).toBe(511);
    expect(results[3]!.biosDisk!.sector).toBe(128);
    expect(results[4]!.biosDisk!.writes.at(-1)).toEqual({
      drive: 1,
      record: 65535,
      bytes: new Array(128).fill(0xc3),
    });
    expect([...results[7]!.memory.slice(DMA, DMA + 128)]).toEqual(
      new Array(128).fill(0xa1),
    );
    expect([...results[8]!.memory.slice(DMA, DMA + 128)]).toEqual(
      new Array(128).fill(0xc3),
    );
    const final = results.at(-1)!;
    expect(recordsOn(final, 0)).toEqual(recordsOn(results[0]!, 0));
    expect(recordAt(final, 1, 65534)).toEqual(new Array(128).fill(0xb0));
    expect(final.biosDisk!.writes.every((record) => record.drive === 1)).toBe(
      true,
    );
    expect(vector(final, 0)).toEqual(vector(results[0]!, 0));
    expect(vector(final, 1)[510]).toBe(1);
  });

  it.each([255, 256, 4087])(
    "allocates B word block %i, then reports disk-full without losing either file or touching A",
    (block) => {
      const media = disks();
      const physical = 128 + block * 16;
      media.drives[0]!.records!.push({ record: physical, fill: 0x91 });
      const onlyFree = new Array<number>(ALV_BYTES).fill(255);
      onlyFree[block >>> 3] = 255 ^ (128 >>> (block & 7));
      const results = run(media, [
        reset(),
        step("dma", 26, DMA),
        step("make-first-b", 22, FIRST, [
          { address: FIRST, bytes: fcb("FIRST", 2) },
        ]),
        step("make-second-b", 22, SECOND, [
          { address: SECOND, bytes: fcb("SECOND", 2) },
        ]),
        step("allocate-only-free-block", 21, FIRST, [
          { address: ALVS[1]!, bytes: onlyFree },
          payload(0x37),
        ]),
        step("reject-second-file-full", 21, SECOND, [payload(0x6b)]),
        step("reread-first-b", 33, FIRST, [payload(0)]),
        step("default-a", 25, 0),
      ]);
      const allocated = results[4]!;
      const full = results[5]!;
      expect(results[2]!.registers.a).toBeLessThan(4);
      expect(results[3]!.registers.a).toBeLessThan(4);
      expect(allocated.registers.a).toBe(0);
      expect([...allocated.memory.slice(FIRST + 16, FIRST + 18)]).toEqual([
        block & 255,
        block >>> 8,
      ]);
      expect(allocated.biosDisk!.writes.at(-1)).toEqual({
        drive: 1,
        record: physical,
        bytes: new Array(128).fill(0x37),
      });
      expect(vector(allocated, 1)).toEqual(new Uint8Array(ALV_BYTES).fill(255));
      expect(full.registers.a).toBe(2);
      expect(full.biosDisk!.records).toEqual(allocated.biosDisk!.records);
      expect(full.biosDisk!.writes).toEqual(allocated.biosDisk!.writes);
      expect(full.memory.slice(SECOND, SECOND + 36)).toEqual(
        allocated.memory.slice(SECOND, SECOND + 36),
      );
      expect(full.memory.slice(FIRST, FIRST + 36)).toEqual(
        allocated.memory.slice(FIRST, FIRST + 36),
      );
      expect(vector(full, 1)).toEqual(vector(allocated, 1));
      expect(vector(full, 0)).toEqual(vector(results[0]!, 0));
      expect(recordsOn(full, 0)).toEqual(recordsOn(results[0]!, 0));
      expect(results[6]!.registers.a).toBe(0);
      expect([...results[6]!.memory.slice(DMA, DMA + 128)]).toEqual(
        new Array(128).fill(0x37),
      );
      expect(results[7]!.registers.a).toBe(0);
    },
  );
});
