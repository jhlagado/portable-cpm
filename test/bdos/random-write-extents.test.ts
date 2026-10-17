import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type BdosDirectCallSequenceFixture,
  type BdosDirectCallSequenceResult,
  type BdosMemoryPatch,
  runBdosDirectCallSequence,
} from "../support/bdos-direct-call.js";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";

// Random writes that cross extents, checked against the documented CP/M 2.2
// interface (functions 33-36 and 40) and against the frozen DRI BDOS oracle.

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const referenceBdos = readFileSync(
  resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img"),
).subarray(0x0800, 0x1600);
let replacementBdos: Uint8Array;

const FCB = 512;
const SIZE_FCB = 1024;
const DMA = 768;
const NAME = [...Buffer.from("RANDEXT DAT", "ascii")];
const DIRECTORY_FIRST_RECORD = 52;
const DIRECTORY_RECORDS = 16;

const evidence = [
  {
    kind: "published-interface" as const,
    source: "Digital Research CP/M 2.2 Interface Guide, 1979",
    section:
      "Functions 33-36 and 40; random record field r0-r2 is not changed by random access",
  },
];

type Step = BdosDirectCallSequenceFixture["steps"][number];

function step(
  id: string,
  fn: number,
  de: number,
  initialMemory?: BdosMemoryPatch[],
): Step {
  return {
    id,
    evidence,
    call: { function: fn, de, stackPointer: 53248 },
    ...(initialMemory === undefined ? {} : { initialMemory }),
    biosResponses: [],
    expected: {},
  };
}

function freshFcb(address: number): BdosMemoryPatch {
  return {
    address,
    length: 36,
    fill: 0,
    patches: [{ offset: 1, bytes: NAME }],
  };
}

function randomRecord(record: number): BdosMemoryPatch {
  return {
    address: FCB + 33,
    bytes: [record & 0xff, (record >> 8) & 0xff, (record >> 16) & 0xff],
  };
}

function pattern(record: number): number {
  return (record * 7 + 1) & 0xff;
}

function baseDisk(): NonNullable<BdosDirectCallSequenceFixture["biosDisk"]> {
  const fixture = JSON.parse(
    readFileSync(
      resolve(
        repositoryRoot,
        "test",
        "bdos",
        "fixtures",
        "sequences",
        "file-mutation-roundtrip.json",
      ),
      "utf8",
    ),
  ) as BdosDirectCallSequenceFixture;
  if (fixture.biosDisk === undefined) throw new Error("fixture has no disk");
  return fixture.biosDisk;
}

function prologue(): Step[] {
  return [
    step("reset", 13, 0),
    step("set-dma", 26, DMA),
    step("make", 22, FCB, [freshFcb(FCB)]),
  ];
}

interface DirectoryExtent {
  ex: number;
  s2: number;
  rc: number;
}

function directoryExtents(
  result: BdosDirectCallSequenceResult,
): DirectoryExtent[] {
  const disk = result.steps.at(-1)!.result.biosDisk!;
  const extents: DirectoryExtent[] = [];
  for (let index = 0; index < DIRECTORY_RECORDS; index += 1) {
    const record = disk.records.find(
      (candidate) =>
        candidate.drive === 0 &&
        candidate.record === DIRECTORY_FIRST_RECORD + index,
    );
    if (record === undefined) continue;
    for (let slot = 0; slot < 4; slot += 1) {
      const entry = record.bytes.slice(slot * 32, slot * 32 + 32);
      if (entry[0] !== 0) continue;
      if (entry.slice(1, 12).some((byte, i) => (byte & 0x7f) !== NAME[i])) {
        continue;
      }
      extents.push({ ex: entry[12]!, s2: entry[14]!, rc: entry[15]! });
    }
  }
  return extents.sort((left, right) => left.ex - right.ex);
}

function stepResult(result: BdosDirectCallSequenceResult, id: string) {
  const found = result.steps.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found.result;
}

const written = [300, 5, 200];
const probes = [
  0, 4, 5, 6, 7, 8, 100, 127, 128, 199, 200, 201, 255, 256, 299, 300, 301, 383,
  384, 600,
];

function outOfOrderFixture(): BdosDirectCallSequenceFixture {
  return {
    schema: "portable-cpm-bdos-direct-sequence-v1",
    id: "random-write-out-of-order-extents",
    description:
      "Write records 300, 5 and 200 of a fresh file at random, close, reopen and read back",
    biosDisk: baseDisk(),
    steps: [
      ...prologue(),
      ...written.map((record) =>
        step(`write-${record}`, 34, FCB, [
          randomRecord(record),
          { address: DMA, length: 128, fill: pattern(record) },
        ]),
      ),
      step("close", 16, FCB),
      step("open", 15, FCB, [freshFcb(FCB)]),
      ...probes.map((record) =>
        step(`read-${record}`, 33, FCB, [
          randomRecord(record),
          { address: DMA, length: 128, fill: 0xaa },
        ]),
      ),
      step("size", 35, SIZE_FCB, [freshFcb(SIZE_FCB)]),
    ],
  };
}

function lastRecordFixture(): BdosDirectCallSequenceFixture {
  return {
    schema: "portable-cpm-bdos-direct-sequence-v1",
    id: "random-write-last-record-of-extent",
    description:
      "Random write of record 127 keeps r0-r2 and the current extent, then write 126",
    biosDisk: baseDisk(),
    steps: [
      ...prologue(),
      step("write-127", 34, FCB, [
        randomRecord(127),
        { address: DMA, length: 128, fill: pattern(127) },
      ]),
      step("write-zero-fill-126", 40, FCB, [
        randomRecord(126),
        { address: DMA, length: 128, fill: pattern(126) },
      ]),
      step("close", 16, FCB),
    ],
  };
}

describe("random writes across extents", () => {
  beforeAll(async () => {
    replacementBdos = (
      await assembleZ80WithLabelsForTest(
        resolve(repositoryRoot, "src", "bdos.asm"),
      )
    ).bytes;
  });

  it("makes, closes and reads back extents written out of order", () => {
    const result = runBdosDirectCallSequence(
      replacementBdos,
      outOfOrderFixture(),
    );
    for (const record of written) {
      expect(
        stepResult(result, `write-${record}`).registers.a,
        `write ${record}`,
      ).toBe(0);
    }
    expect(stepResult(result, "close").registers.a).not.toBe(0xff);
    expect(stepResult(result, "open").registers.a).not.toBe(0xff);

    for (const record of written) {
      const read = stepResult(result, `read-${record}`);
      expect(read.registers.a, `read ${record}`).toBe(0);
      expect([...read.memory.slice(DMA, DMA + 128)], `data ${record}`).toEqual(
        Array(128).fill(pattern(record)),
      );
      expect(
        [...read.memory.slice(FCB + 33, FCB + 36)],
        `r0-r2 ${record}`,
      ).toEqual([record & 0xff, record >> 8, 0]);
    }
    // Past the record count of an extent that exists: reading unwritten data.
    for (const record of [6, 7, 8, 100, 127, 201, 255, 301, 383]) {
      expect(
        stepResult(result, `read-${record}`).registers.a,
        `read ${record}`,
      ).toBe(1);
    }
    // Inside the record count, but in an allocation block never written.
    expect(stepResult(result, "read-199").registers.a).toBe(1);
    expect(stepResult(result, "read-128").registers.a).toBe(1);
    expect(stepResult(result, "read-256").registers.a).toBe(1);
    // An extent that was never made: seek to unwritten extent.
    expect(stepResult(result, "read-384").registers.a).toBe(4);
    expect(stepResult(result, "read-600").registers.a).toBe(4);

    expect(directoryExtents(result)).toEqual([
      { ex: 0, s2: 0, rc: 6 },
      { ex: 1, s2: 0, rc: 73 },
      { ex: 2, s2: 0, rc: 45 },
    ]);
    const size = stepResult(result, "size");
    expect([...size.memory.slice(SIZE_FCB + 33, SIZE_FCB + 36)]).toEqual([
      301 & 0xff,
      301 >> 8,
      0,
    ]);
  });

  it("matches the DRI oracle for out-of-order extents", () => {
    const fixture = outOfOrderFixture();
    const oracle = runBdosDirectCallSequence(referenceBdos, fixture);
    const replacement = runBdosDirectCallSequence(replacementBdos, fixture);
    replacement.steps.forEach((current, index) => {
      const expected = oracle.steps[index]!.result;
      expect(current.result.registers.a, current.id).toBe(expected.registers.a);
      expect(
        [...current.result.memory.slice(DMA, DMA + 128)],
        `${current.id} data`,
      ).toEqual([...expected.memory.slice(DMA, DMA + 128)]);
    });
    expect(directoryExtents(replacement)).toEqual(directoryExtents(oracle));
    expect([
      ...stepResult(replacement, "size").memory.slice(
        SIZE_FCB + 33,
        SIZE_FCB + 36,
      ),
    ]).toEqual([
      ...stepResult(oracle, "size").memory.slice(SIZE_FCB + 33, SIZE_FCB + 36),
    ]);
  });

  it("keeps r0-r2 and the extent after writing an extent's last record", () => {
    for (const bdos of [replacementBdos, referenceBdos]) {
      const result = runBdosDirectCallSequence(bdos, lastRecordFixture());
      const write = stepResult(result, "write-127");
      expect(write.registers.a).toBe(0);
      const fcb = [...write.memory.slice(FCB, FCB + 36)];
      expect(fcb.slice(33, 36), "r0-r2").toEqual([127, 0, 0]);
      expect(fcb[12], "extent").toBe(0);
      expect(fcb[15], "record count").toBe(128);
      expect(fcb[32], "current record").toBe(127);
      const zeroFill = stepResult(result, "write-zero-fill-126");
      expect(zeroFill.registers.a).toBe(0);
      expect([...zeroFill.memory.slice(FCB + 33, FCB + 36)]).toEqual([
        126, 0, 0,
      ]);
      expect(directoryExtents(result)).toEqual([{ ex: 0, s2: 0, rc: 128 }]);
    }
  });

  it("keeps r0-r2 when a sequential write makes the next extent", () => {
    const fixture: BdosDirectCallSequenceFixture = {
      schema: "portable-cpm-bdos-direct-sequence-v1",
      id: "sequential-rollover-keeps-random-record",
      description: "Write 129 records sequentially with r0-r2 set beforehand",
      biosDisk: baseDisk(),
      steps: [
        ...prologue(),
        ...Array.from({ length: 129 }, (_, index) =>
          step(
            `write-${index}`,
            21,
            FCB,
            index === 0 ? [randomRecord(0x012345)] : undefined,
          ),
        ),
      ],
    };
    for (const bdos of [replacementBdos, referenceBdos]) {
      const result = runBdosDirectCallSequence(bdos, fixture);
      const rollover = stepResult(result, "write-127");
      expect(rollover.registers.a).toBe(0);
      expect([...rollover.memory.slice(FCB + 33, FCB + 36)]).toEqual([
        0x45, 0x23, 0x01,
      ]);
      const last = stepResult(result, "write-128");
      expect(last.memory[FCB + 12], "extent").toBe(1);
      expect([...last.memory.slice(FCB + 32, FCB + 36)]).toEqual([
        1, 0x45, 0x23, 0x01,
      ]);
    }
  });
});
