import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import {
  bdosBiosConsoleOutput,
  runBdosDirectCallSequence,
  unexpectedDirectCallWrites,
  type BdosDirectCallStep,
  type BdosDirectCallSequenceFixture,
  type BdosDirectCallResult,
} from "../support/bdos-direct-call.js";
import type { BdosBiosDiskFixture } from "../support/bdos-bios-double.js";

const FCB = 0x200,
  DMA = 0x800,
  SP = 0xd000,
  ALV = 0xfe00;
const evidence = [
  {
    kind: "published-interface" as const,
    source: "Portable CP/M BDOS v0.1 contract",
    section: "Disk and file state; BIOS DPB boundary",
  },
];
function entry(block: number, extent = 0, records = 128): number[] {
  const bytes = new Array<number>(36).fill(0);
  bytes.splice(1, 11, ...Buffer.from("LARGE   DAT"));
  bytes[12] = extent;
  bytes[15] = records;
  bytes[16] = block & 255;
  bytes[17] = block >>> 8;
  return bytes;
}
function disk(entries: number[][] = []): BdosBiosDiskFixture {
  const directory = new Array<number>(128).fill(0xe5);
  entries.forEach((bytes, index) =>
    directory.splice(index * 32, 32, ...bytes.slice(0, 32)),
  );
  return {
    drives: [
      {
        number: 0,
        dphAddress: 0xfc00,
        dpbAddress: 0xfc10,
        directoryBufferAddress: 0xfc80,
        checkVectorAddress: 0xfd00,
        allocationVectorAddress: ALV,
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
        records: [{ record: 128, bytes: directory }],
      },
    ],
  };
}
function step(
  id: string,
  fn: number,
  de = FCB,
  initialMemory: BdosDirectCallStep["initialMemory"] = [],
  fatal = false,
): BdosDirectCallStep {
  return {
    id,
    evidence,
    call: { function: fn, de, stackPointer: SP },
    initialMemory,
    biosResponses: fatal ? [{ entry: 1, occurrence: 0, action: "stop" }] : [],
    expected: {},
  };
}
const guards = [
  { address: ALV - 1, bytes: [0x41] },
  { address: 0xffff, bytes: [0x41] },
];
const reset = () => step("reset", 13, 0, guards);

describe("8 MiB EXM=0 BDOS geometry", () => {
  let bdos: Uint8Array, stackBase: number;
  beforeAll(async () => {
    const assembled = await assembleZ80WithLabelsForTest(
      resolve("src/bdos.asm"),
    );
    bdos = assembled.bytes;
    stackBase = assembled.labels.STKBASE!;
  });
  function run(biosDisk: BdosBiosDiskFixture, steps: BdosDirectCallStep[]) {
    const fixture: BdosDirectCallSequenceFixture = {
      schema: "portable-cpm-bdos-direct-sequence-v1",
      id: "eight-mib",
      description: "Exact 8 MiB image with a 511-byte allocation vector",
      biosDisk,
      steps,
    };
    const results = runBdosDirectCallSequence(bdos, fixture).steps.map(
      (s) => s.result,
    );
    for (const result of results) {
      expect(result.memory[ALV - 1]).toBe(0x41);
      expect(result.memory[0xffff]).toBe(0x41);
      expect(result.minimumResidentStackPointer).toBeGreaterThanOrEqual(
        stackBase,
      );
      const allowed = new Set([
        ...Array.from({ length: 36 }, (_, i) => FCB + i),
        ...Array.from({ length: 128 }, (_, i) => DMA + i),
      ]);
      expect(unexpectedDirectCallWrites(result, SP, allowed)).toEqual([]);
      if (result.stop === "normal-return") {
        expect(result.registers.sp).toBe(SP);
        expect(result.registers.pc).toBe(0x104);
      }
    }
    return results;
  }
  function fatal(result: BdosDirectCallResult) {
    expect(result.stop).toBe("bios-transfer");
    expect(result.biosTransferEntry).toBe(1);
    expect(
      Buffer.from(bdosBiosConsoleOutput(result.biosCalls)).toString(),
    ).toBe("\r\nBdos Err On A: Bad Sector");
    expect(result.biosDisk?.writes).toEqual([]);
  }

  it.each([255, 256, 4087])(
    "reads and writes actual block %i including its final record",
    (block) => {
      const media = disk([entry(block, 0, 16)]);
      media.drives[0]!.records!.push({
        record: 128 + block * 16 + 15,
        fill: 0xa5,
      });
      const results = run(media, [
        reset(),
        step("dma", 26, DMA),
        step("open", 15, FCB, [{ address: FCB, bytes: entry(0) }]),
        step("read-final", 20, FCB, [{ address: FCB + 32, bytes: [15] }]),
        step("write-random", 34, FCB, [
          { address: FCB + 33, bytes: [15, 0, 0] },
          { address: DMA, length: 128, fill: 0x5a },
        ]),
        step("read-random", 33, FCB, [{ address: DMA, length: 128, fill: 0 }]),
      ]);
      expect(
        results[0]!.memory[ALV + (block >>> 3)]! & (128 >>> (block & 7)),
      ).not.toBe(0);
      expect([...results[3]!.memory.slice(DMA, DMA + 128)]).toEqual(
        new Array(128).fill(0xa5),
      );
      expect(results[3]!.biosDisk?.track).toBe(
        Math.floor((128 + block * 16 + 15) / 128),
      );
      expect(results[3]!.biosDisk?.sector).toBe(((block * 16 + 15) % 128) + 1);
      expect(results[4]!.biosDisk?.writes.at(-1)?.record).toBe(
        128 + block * 16 + 15,
      );
      expect([...results[5]!.memory.slice(DMA, DMA + 128)]).toEqual(
        new Array(128).fill(0x5a),
      );
      for (const result of results) expect(result.registers.a).toBe(0);
    },
  );

  it.each([4088, 4095, 4096, 65535])(
    "rejects corrupt directory block %i before vector mutation",
    (block) => {
      const result = run(disk([entry(block)]), [
        step("bad-login", 13, 0, guards, true),
      ])[0]!;
      fatal(result);
    },
  );

  for (const fn of [20, 21, 33, 34]) {
    it.each([4088, 4095, 4096, 65535])(
      `rejects forged FCB block %i on function ${fn} before I/O`,
      (block) => {
        const results = run(disk(), [
          reset(),
          step("dma", 26, DMA),
          step(
            "bad-fcb",
            fn,
            FCB,
            [{ address: FCB, bytes: entry(block, 0, 16) }],
            true,
          ),
        ]);
        const last = results.at(-1)!;
        fatal(last);
        expect(
          last.biosCalls.some((call) => [10, 11, 13, 14].includes(call.entry)),
        ).toBe(false);
        expect(last.memory.slice(FCB, FCB + 36)).toEqual(
          Uint8Array.from(entry(block, 0, 16)),
        );
      },
    );
  }

  it("reads the last record of an extent then crosses into the next word-mapped extent", () => {
    const first = entry(0);
    first[30] = 255;
    first[31] = 0;
    const media = disk([first, entry(256, 1, 1)]);
    media.drives[0]!.records!.push(
      { record: 128 + 255 * 16 + 15, fill: 0xa1 },
      { record: 128 + 256 * 16, fill: 0xb2 },
    );
    const results = run(media, [
      reset(),
      step("dma", 26, DMA),
      step("open", 15, FCB, [{ address: FCB, bytes: entry(0) }]),
      step("last", 20, FCB, [{ address: FCB + 32, bytes: [127] }]),
      step("next", 20),
    ]);
    expect(results[3]!.memory[DMA]).toBe(0xa1);
    expect(results[4]!.memory[DMA]).toBe(0xb2);
    expect(results[4]!.memory[FCB + 12]).toBe(1);
    expect(results[4]!.memory[FCB + 32]).toBe(1);
  });

  it.each([255, 256, 4087])(
    "allocates the only free block %i, then rejects disk-full without writes",
    (block) => {
      const onlyFree = new Array<number>(511).fill(255);
      onlyFree[block >>> 3] = 255 ^ (128 >>> (block & 7));
      const results = run(disk(), [
        reset(),
        step("dma", 26, DMA),
        step("make", 22, FCB, [{ address: FCB, bytes: entry(0, 0, 0) }]),
        step("allocate", 21, FCB, [
          { address: ALV, bytes: onlyFree },
          { address: DMA, length: 128, fill: 0x37 },
        ]),
        step("full", 21, FCB, [{ address: FCB, bytes: entry(0, 0, 0) }]),
      ]);
      const allocated = results[3]!,
        full = results[4]!;
      expect(allocated.registers.a).toBe(0);
      expect(allocated.memory[FCB + 16]).toBe(block & 255);
      expect(allocated.memory[FCB + 17]).toBe(block >>> 8);
      expect(allocated.memory.slice(ALV, 0xffff)).toEqual(
        new Uint8Array(511).fill(255),
      );
      expect(allocated.biosDisk?.writes.at(-1)?.record).toBe(128 + block * 16);
      expect(full.registers.a).toBe(2);
      expect(full.biosDisk?.records).toEqual(allocated.biosDisk?.records);
      expect(full.biosDisk?.writes).toEqual(allocated.biosDisk?.writes);
      expect(full.memory.slice(FCB, FCB + 36)).toEqual(
        Uint8Array.from(entry(0, 0, 0)),
      );
    },
  );

  it("zero-fills all sixteen records of a newly allocated word block", () => {
    const onlyFree = new Array<number>(511).fill(255);
    onlyFree[32] = 0x7f; // Block 256 is the only free block.
    const results = run(disk(), [
      reset(),
      step("dma", 26, DMA),
      step("make", 22, FCB, [{ address: FCB, bytes: entry(0, 0, 0) }]),
      step("zero-fill", 40, FCB, [
        { address: ALV, bytes: onlyFree },
        { address: FCB + 33, bytes: [15, 0, 0] },
        { address: DMA, length: 128, fill: 0x63 },
      ]),
    ]);
    const last = results[3]!;
    expect(last.registers.a).toBe(0);
    const writes = last.biosDisk!.writes.slice(
      results[2]!.biosDisk!.writes.length,
    );
    expect(writes.map((write) => write.record)).toEqual([
      ...Array.from({ length: 16 }, (_, i) => 128 + 256 * 16 + i),
      128 + 256 * 16 + 15,
    ]);
    for (const write of writes.slice(0, 16))
      expect(write.bytes).toEqual(new Array(128).fill(0));
    expect(writes[16]!.bytes).toEqual(new Array(128).fill(0x63));
  });

  it("resolves random record 65535 through EX/S2 and the final allocation cell", () => {
    const high = entry(0, 31, 128);
    high[14] = 15;
    high[30] = 4087 & 255;
    high[31] = 4087 >>> 8;
    const media = disk([high]);
    media.drives[0]!.records!.push({ record: 65535, fill: 0x79 });
    const results = run(media, [
      reset(),
      step("dma", 26, DMA),
      step("random-high", 33, FCB, [
        { address: FCB, bytes: entry(0, 0, 0) },
        { address: FCB + 33, bytes: [255, 255, 0] },
      ]),
    ]);
    const last = results[2]!;
    expect(last.registers.a).toBe(0);
    expect(last.memory.slice(DMA, DMA + 128)).toEqual(
      new Uint8Array(128).fill(0x79),
    );
    expect(last.memory[FCB + 12]).toBe(31);
    expect(last.memory[FCB + 14]! & 0x3f).toBe(15);
    expect(last.memory[FCB + 32]).toBe(127);
    expect(last.biosDisk?.track).toBe(511);
    expect(last.biosDisk?.sector).toBe(128);
  });
});
