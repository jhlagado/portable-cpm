import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import {
  bdosBiosConsoleOutput,
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
const ALVS = [0xfd20, 0xfd60];
const ALV_BYTES = 31;
const evidence = [
  {
    kind: "published-interface" as const,
    source: "Digital Research CP/M Operating System Manual, July 1982",
    section:
      "5.2 FCB drive field and disk/file services; 6.9 SELDSK login flag",
  },
];

function fcb(name: string, drive = 0): number[] {
  const bytes = new Array<number>(36).fill(0);
  bytes[0] = drive;
  bytes.splice(1, 11, ...Buffer.from(`${name.padEnd(8)}DAT`, "ascii"));
  return bytes;
}

function disks(withFile = false): BdosBiosDiskFixture {
  return {
    drives: [0, 1].map((number) => {
      const directory = new Array<number>(128).fill(0xe5);
      if (withFile) {
        const entry = fcb("SHARED");
        entry[15] = 1;
        // Different maps distinguish wrong-drive OPEN from wrong-drive READ.
        entry[16] = 2 + number;
        directory.splice(0, 32, ...entry.slice(0, 32));
      }
      return {
        number,
        dphAddress: 0xfc00 + number * 0x20,
        dpbAddress: 0xfc10 + number * 0x20,
        directoryBufferAddress: number ? 0xfd80 : 0xfc80,
        checkVectorAddress: 0xfd00,
        allocationVectorAddress: ALVS[number]!,
        firstSector: 1,
        defaultRecordByte: 0xe5,
        dpb: {
          sectorsPerTrack: 26,
          blockShift: 3,
          blockMask: 7,
          extentMask: 0,
          maximumBlock: 242,
          maximumDirectoryEntry: 63,
          directoryAllocation0: 0xc0,
          directoryAllocation1: 0,
          checkVectorBytes: 0,
          reservedTracks: 2,
        },
        records: [
          { record: 52, bytes: directory },
          { record: 68, fill: number ? (withFile ? 0xb4 : 0xb2) : 0xa1 },
          ...(withFile && number === 1 ? [{ record: 76, fill: 0xb2 }] : []),
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

const guards = [
  ...ALVS.flatMap((address) => [address - 1, address + ALV_BYTES]),
  SP - 3,
  SP,
];
const reset = () =>
  step(
    "reset",
    13,
    0,
    guards.map((address) => ({ address, bytes: [0x59] })),
  );
const payload = (value: number) => ({ address: DMA, length: 128, fill: value });
const record = (result: BdosDirectCallResult, drive: number, address: number) =>
  result.biosDisk!.records.find(
    (entry) => entry.drive === drive && entry.record === address,
  )!.bytes;

describe.each(["triptych-cpu-v0.1", "test-multi-drive-workspace-v1"])(
  "BDOS two-drive file isolation (%s)",
  (PROFILE) => {
    let bdos: Uint8Array;
    let stackBase: number;
    beforeAll(async () => {
      const assembled = await assembleZ80WithLabelsForTest(
        resolve("src/bdos.asm"),
        PROFILE,
      );
      bdos = assembled.bytes;
      stackBase = assembled.labels.STKBASE!;
    });

    function run(
      biosDisk: BdosBiosDiskFixture,
      steps: BdosDirectCallStep[],
      fatalLast = false,
      dmaAddresses = [DMA],
    ) {
      const results = runBdosDirectCallSequence(
        bdos,
        {
          schema: "portable-cpm-bdos-direct-sequence-v1",
          id: "multiple-drive",
          description:
            "Independent BIOS tables, media and allocation vectors for A and B",
          biosDisk,
          steps,
        },
        PROFILE,
      ).steps.map(({ result }) => result);
      const allowed = new Set([
        ...[FIRST, SECOND].flatMap((address) =>
          Array.from({ length: 36 }, (_, i) => address + i),
        ),
        ...dmaAddresses.flatMap((base) =>
          Array.from({ length: 128 }, (_, i) => base + i),
        ),
      ]);
      for (const [index, result] of results.entries()) {
        if (fatalLast && index === results.length - 1) {
          expect(result.stop).toBe("bios-transfer");
          expect(result.biosTransferEntry).toBe(1);
        } else {
          expect(result.stop).toBe("normal-return");
          expect(result.registers.sp).toBe(SP);
          expect(result.registers.pc).toBe(0x104);
        }
        expect(result.minimumResidentStackPointer).toBeGreaterThanOrEqual(
          stackBase,
        );
        for (const address of guards) expect(result.memory[address]).toBe(0x59);
        expect(
          unexpectedDirectCallWrites(result, SP, allowed, PROFILE),
        ).toEqual([]);
      }
      return results;
    }

    function fatalStep(
      id: string,
      fn: number,
      de: number,
      initialMemory: BdosDirectCallStep["initialMemory"] = [],
    ) {
      const result = step(id, fn, de, initialMemory);
      result.biosResponses = [
        { entry: 3, occurrence: "all", return: { a: 13 } },
        { entry: 1, occurrence: 0, action: "stop" },
      ];
      return result;
    }

    it("raw '?' search uses default A and includes all users and the final free directory slot", () => {
      const media = disks(true);
      const directory = media.drives[0]!.records![0]!.bytes!;
      directory[0] = 7;
      for (const [index, user, name] of [
        [1, 0, "ZERO"],
        [2, 15, "FIFTEEN"],
      ] as const) {
        const entry = fcb(name);
        entry[0] = user;
        directory.splice(index * 32, 32, ...entry.slice(0, 32));
      }
      media.drives[1]!.records![0]!.bytes![0] = 7;
      const steps = [
        reset(),
        step("dma", 26, DMA),
        step("user-seven", 32, 7),
        step("bind-explicit-b", 15, SECOND, [
          { address: SECOND, bytes: fcb("SHARED", 2) },
        ]),
        step("raw-first-default-a", 17, FIRST, [
          { address: FIRST, bytes: fcb("NOMATCH", 0x3f) },
        ]),
        ...defaultQueries(),
        ...Array.from({ length: 63 }, (_, i) =>
          step(`raw-next-${i + 1}`, 18, SECOND),
        ),
        step("raw-end", 18, SECOND),
        ...defaultQueries(),
      ];
      const results = run(media, steps);
      const indexes = [4, ...Array.from({ length: 63 }, (_, i) => 8 + i)];
      for (const [slot, index] of indexes.entries()) {
        const result = results[index]!;
        expect(result.registers.a, `raw directory slot ${slot}`).toBe(slot % 4);
        const offset = DMA + (slot % 4) * 32;
        const expected =
          slot < 4
            ? directory.slice(slot * 32, slot * 32 + 32)
            : new Array(32).fill(0xe5);
        expect(
          [...result.memory.slice(offset, offset + 32)],
          `full bytes of raw slot ${slot}`,
        ).toEqual(expected);
      }
      expect(results[71]!.registers.a).toBe(0xff);
      expect(results.at(-1)!.memory[FIRST]).toBe(0x3f);
      expect(results.at(-1)!.biosDisk!.records).toEqual(
        results[0]!.biosDisk!.records,
      );
      expect(results.at(-1)!.biosDisk!.writes).toEqual([]);
      checkDefaultA(results);
    });

    it("retains default B and avoids repeated disk selection on its cached fast path", () => {
      const results = run(disks(true), [
        reset(),
        step("dma", 26, DMA),
        step("select-default-b", 14, 1),
        step("open-default-b", 15, FIRST, [
          { address: FIRST, bytes: fcb("SHARED") },
        ]),
        step("read-default-b", 20, FIRST, [payload(0)]),
        step("select-same-default-b", 14, 1),
        step("reopen-default-b", 15, SECOND, [
          { address: SECOND, bytes: fcb("SHARED") },
        ]),
        step("reread-default-b", 20, SECOND, [payload(0)]),
        ...defaultQueries(),
      ]);
      for (const index of [4, 7]) {
        expect(results[index]!.registers.a).toBe(0);
        expect([...results[index]!.memory.slice(DMA, DMA + 128)]).toEqual(
          new Array(128).fill(0xb2),
        );
      }
      expect(results[5]!.biosCalls).toEqual([]);
      expect(
        results
          .slice(3)
          .flatMap((result) =>
            result.biosCalls.filter((call) => call.entry === 9),
          ),
      ).toEqual([]);
      expect(results[8]!.registers.a).toBe(1);
      expect((results[9]!.registers.h << 8) | results[9]!.registers.l).toBe(
        ALVS[1],
      );
      expect((results[10]!.registers.h << 8) | results[10]!.registers.l).toBe(
        0xfc30,
      );
      expect(results.at(-1)!.biosDisk!.writes).toEqual([]);
    });

    it("write-protecting default A still allows explicit B writes and rejects a later A write", () => {
      const results = run(
        disks(),
        [
          reset(),
          step("dma", 26, DMA),
          step("protect-default-a", 28, 0),
          step("make-writable-b", 22, FIRST, [
            { address: FIRST, bytes: fcb("BWRITE", 2) },
          ]),
          step("write-writable-b", 21, FIRST, [payload(0x73)]),
          step("query-read-only-vector", 29, 0),
          step("query-default", 25, 0),
          fatalStep("reject-protected-a", 22, SECOND, [
            { address: SECOND, bytes: fcb("AFAIL") },
          ]),
        ],
        true,
      );
      expect(results[3]!.registers.a).toBeLessThan(4);
      expect(results[4]!.registers.a).toBe(0);
      expect(record(results[4]!, 1, 68)).toEqual(new Array(128).fill(0x73));
      expect(results[5]!.registers.l).toBe(1);
      expect(results[6]!.registers.a).toBe(0);
      const failed = results[7]!;
      expect(
        Buffer.from(bdosBiosConsoleOutput(failed.biosCalls)).toString("ascii"),
      ).toBe("\r\nBdos Err On A: R/O");
      expect(failed.biosDisk!.records).toEqual(results[6]!.biosDisk!.records);
      expect(failed.biosDisk!.writes).toEqual(results[6]!.biosDisk!.writes);
      expect(failed.memory.slice(SECOND, SECOND + 36)).toEqual(
        Uint8Array.from(fcb("AFAIL")),
      );
    });

    it.each([3, 17, 0x3f, 0xff])(
      "rejects FCB drive byte %i without aliasing an installed disk",
      (drive) => {
        const bytes = fcb("SHARED", drive);
        const results = run(
          disks(true),
          [
            reset(),
            step("dma", 26, DMA),
            fatalStep("reject-unavailable-drive", 15, FIRST, [
              { address: FIRST, bytes },
            ]),
          ],
          true,
        );
        const failed = results[2]!;
        const diagnostic = Buffer.from(
          bdosBiosConsoleOutput(failed.biosCalls),
        ).toString("ascii");
        if (drive === 3) expect(diagnostic).toBe("\r\nBdos Err On C: Select");
        else expect(diagnostic).toMatch(/^\r\nBdos Err On .: Select$/);
        expect(
          failed.biosCalls
            .filter((call) => call.entry === 9)
            .map((call) => call.registers.c),
        ).toEqual(drive === 3 ? [2] : []);
        expect(
          failed.biosCalls.some(
            (call) => call.entry === 13 || call.entry === 14,
          ),
        ).toBe(false);
        expect(failed.biosDisk!.records).toEqual(results[1]!.biosDisk!.records);
        expect(failed.biosDisk!.writes).toEqual([]);
        expect(failed.memory.slice(FIRST, FIRST + 36)).toEqual(
          Uint8Array.from(bytes),
        );
        for (const address of ALVS)
          expect(failed.memory.slice(address, address + ALV_BYTES)).toEqual(
            results[1]!.memory.slice(address, address + ALV_BYTES),
          );
      },
    );

    const defaultQueries = () => [
      step("default-drive", 25, 0),
      step("default-allocation-vector", 27, 0),
      step("default-dpb", 31, 0),
    ];

    it.each([13, 37])(
      "function %i rebuilds every allocation-vector byte including its tail",
      (fn) => {
        const results = run(disks(), [
          reset(),
          step("dirty-complete-vectors", 26, DMA, [
            { address: ALVS[0]!, length: ALV_BYTES, fill: 0xff },
            { address: ALVS[1]!, length: ALV_BYTES, fill: 0xa6 },
          ]),
          step("reset-a", fn, fn === 37 ? 1 : 0),
          step("select-reset-a", 14, 0),
        ]);
        const expected = new Uint8Array(ALV_BYTES);
        expected[0] = 0xc0;
        expect(results[3]!.memory.slice(ALVS[0], ALVS[0]! + ALV_BYTES)).toEqual(
          expected,
        );
        expect(results[3]!.memory.slice(ALVS[1], ALVS[1]! + ALV_BYTES)).toEqual(
          new Uint8Array(ALV_BYTES).fill(0xa6),
        );
        expect(results[3]!.biosDisk!.records).toEqual(
          results[0]!.biosDisk!.records,
        );
        expect(results[3]!.biosDisk!.writes).toEqual([]);
      },
    );
    function checkDefaultA(results: BdosDirectCallResult[]) {
      const [drive, allocation, dpb] = results.slice(-3);
      for (const query of [drive, allocation, dpb])
        expect(query!.biosCalls).toEqual([]);
      expect.soft(drive!.registers.a, "the default drive remains A").toBe(0);
      expect
        .soft(
          (allocation!.registers.h << 8) | allocation!.registers.l,
          "allocation query refers to default A",
        )
        .toBe(ALVS[0]);
      expect
        .soft(
          (dpb!.registers.h << 8) | dpb!.registers.l,
          "DPB query refers to default A",
        )
        .toBe(0xfc10);
      for (const result of results) expect(result.memory[4]).toBe(0);
    }

    it.each([
      ["make", 22],
      ["delete", 19],
      ["rename", 23],
      ["attributes", 30],
    ] as const)(
      "routes explicit B %s and its directory publication only to B",
      (operation, fn) => {
        const media = disks(operation !== "make");
        const bytes = fcb(operation === "make" ? "NEW" : "SHARED", 2);
        const expectedDirectory = [...media.drives[1]!.records![0]!.bytes!];
        if (operation === "make") {
          expectedDirectory.splice(0, 32, ...fcb("NEW").slice(0, 32));
        } else if (operation === "delete") {
          expectedDirectory[0] = 0xe5;
        } else if (operation === "rename") {
          bytes.splice(17, 11, ...fcb("RENAMED").slice(1, 12));
          expectedDirectory.splice(1, 11, ...fcb("RENAMED").slice(1, 12));
        } else {
          bytes[10] = bytes[10]! | 0x80;
          expectedDirectory[10] = expectedDirectory[10]! | 0x80;
        }
        const results = run(media, [
          reset(),
          step("dma", 26, DMA),
          step(`${operation}-b`, fn, FIRST, [{ address: FIRST, bytes }]),
          ...defaultQueries(),
        ]);
        const changed = results[2]!;
        expect(changed.registers.a).toBeLessThan(4);
        expect
          .soft(
            record(changed, 1, 52),
            "B directory receives the requested mutation",
          )
          .toEqual(expectedDirectory);
        expect
          .soft(
            changed.biosDisk!.records.filter((entry) => entry.drive === 0),
            "A's complete stored records are preserved",
          )
          .toEqual(
            results[0]!.biosDisk!.records.filter((entry) => entry.drive === 0),
          );
        expect(changed.biosDisk!.writes.length).toBeGreaterThan(0);
        expect
          .soft(changed.biosDisk!.writes.every((write) => write.drive === 1))
          .toBe(true);
        expect
          .soft(changed.memory.slice(ALVS[0], ALVS[0]! + ALV_BYTES))
          .toEqual(results[0]!.memory.slice(ALVS[0], ALVS[0]! + ALV_BYTES));
        expect(record(changed, 1, 68)).toEqual(record(results[0]!, 1, 68));
        expect(changed.memory[FIRST]).toBe(2);
        checkDefaultA(results);
      },
    );

    it("converts an FCB position without selecting its invalid drive byte", () => {
      const input = fcb("POSITION", 255);
      input[12] = 1;
      input[32] = 3;
      const results = run(disks(), [
        reset(),
        step("convert-only", 36, FIRST, [{ address: FIRST, bytes: input }]),
      ]);
      expect(results[1]!.biosCalls).toEqual([]);
      expect([...results[1]!.memory.slice(FIRST + 33, FIRST + 36)]).toEqual([
        131, 0, 0,
      ]);
      expect(results[1]!.memory[FIRST]).toBe(255);
      expect(results[1]!.biosDisk!.records).toEqual(
        results[0]!.biosDisk!.records,
      );
    });

    it.each([1, 4])(
      "retains B search slot %i with a shared directory buffer and a changed DMA",
      (slot) => {
        const media = disks(true);
        media.drives[1]!.directoryBufferAddress =
          media.drives[0]!.directoryBufferAddress;
        const second = fcb("SECOND");
        second[16] = 4;
        if (slot === 1)
          media.drives[1]!.records![0]!.bytes!.splice(
            32,
            32,
            ...second.slice(0, 32),
          );
        else {
          const directory = new Array<number>(128).fill(0xe5);
          directory.splice(0, 32, ...second.slice(0, 32));
          media.drives[1]!.records!.push({ record: 53, bytes: directory });
        }
        const input = fcb("S???????", 2);
        input[14] = 0x37;
        const nextDma = 0x900;
        const results = run(
          media,
          [
            reset(),
            step("dma", 26, DMA),
            step("first-b", 17, FIRST, [{ address: FIRST, bytes: input }]),
            ...defaultQueries(),
            step("new-dma", 26, nextDma),
            step("next-b", 18, SECOND, [
              { address: SECOND, bytes: fcb("POISON", 255) },
            ]),
            ...defaultQueries(),
          ],
          false,
          [DMA, nextDma],
        );
        expect(results[2]!.registers.a).toBe(0);
        expect(results[2]!.memory[FIRST + 14]).toBe(0);
        expect(results[7]!.registers.a).toBe(slot % 4);
        const offset = nextDma + (slot % 4) * 32;
        expect([...results[7]!.memory.slice(offset + 1, offset + 12)]).toEqual(
          fcb("SECOND").slice(1, 12),
        );
        expect(results[7]!.memory[offset + 16]).toBe(4);
        expect(results[7]!.memory.slice(DMA, DMA + 128)).toEqual(
          results[2]!.memory.slice(DMA, DMA + 128),
        );
        expect(results.at(-1)!.biosDisk!.writes).toEqual([]);
        checkDefaultA(results.slice(0, 6));
        checkDefaultA(results);
      },
    );

    it("continues a B wildcard search across default-drive queries without using NEXT's DE", () => {
      const media = disks(true);
      for (const drive of media.drives) {
        const second = fcb(drive.number ? "SECOND" : "OTHER");
        second[15] = 1;
        second[16] = 4;
        drive.records![0]!.bytes!.splice(32, 32, ...second.slice(0, 32));
      }
      const results = run(media, [
        reset(),
        step("dma", 26, DMA),
        step("search-first-b", 17, FIRST, [
          { address: FIRST, bytes: fcb("S???????", 2) },
        ]),
        ...defaultQueries(),
        step("search-next-b", 18, SECOND, [
          { address: SECOND, bytes: fcb("OTHER", 1) },
          payload(0),
        ]),
        ...defaultQueries(),
        step("search-end-b", 18, SECOND),
        ...defaultQueries(),
      ]);
      for (const [index, name, block] of [
        [2, "SHARED", 3],
        [6, "SECOND", 4],
      ] as const) {
        const result = results[index]!;
        expect
          .soft(result.registers.a, `B search returns ${name}`)
          .toBeLessThan(4);
        if (result.registers.a < 4) {
          const offset = DMA + result.registers.a * 32;
          expect
            .soft([...result.memory.slice(offset + 1, offset + 12)])
            .toEqual(fcb(name).slice(1, 12));
          expect.soft(result.memory[offset + 16]).toBe(block);
        }
      }
      expect(results[10]!.registers.a).toBe(0xff);
      expect(results.at(-1)!.biosDisk!.records).toEqual(
        results[0]!.biosDisk!.records,
      );
      expect(results.at(-1)!.biosDisk!.writes).toEqual([]);
      for (const end of [6, 10, 14]) checkDefaultA(results.slice(0, end));
    });

    it.each([34, 40])(
      "routes random write function %i and random read to an explicit B FCB",
      (fn) => {
        const results = run(disks(), [
          reset(),
          step("dma", 26, DMA),
          step("make-random-b", 22, FIRST, [
            { address: FIRST, bytes: fcb("RANDOM", 2) },
          ]),
          ...defaultQueries(),
          step("write-random-b", fn, FIRST, [
            { address: FIRST + 33, bytes: [1, 0, 0] },
            payload(0x79),
          ]),
          ...defaultQueries(),
          step("read-random-b", 33, FIRST, [payload(0)]),
          ...defaultQueries(),
          step("set-random-from-current", 36, FIRST, [
            { address: FIRST + 32, bytes: [1] },
            { address: FIRST + 33, bytes: [0xee, 0xee, 0xee] },
          ]),
          step("close-random-b", 16, FIRST),
          step("size-random-b", 35, SECOND, [
            { address: SECOND, bytes: fcb("RANDOM", 2) },
          ]),
          ...defaultQueries(),
        ]);
        const written = results[6]!;
        for (const index of [6, 10, 14])
          expect(results[index]!.registers.a).toBe(0);
        expect(results[15]!.registers.a).toBeLessThan(4);
        expect([...results[10]!.memory.slice(DMA, DMA + 128)]).toEqual(
          new Array(128).fill(0x79),
        );
        expect([...results[14]!.memory.slice(FIRST + 33, FIRST + 36)]).toEqual([
          1, 0, 0,
        ]);
        expect
          .soft([...results[16]!.memory.slice(SECOND + 33, SECOND + 36)])
          .toEqual([2, 0, 0]);
        expect
          .soft(
            written.biosDisk!.records.find(
              (entry) => entry.drive === 1 && entry.record === 69,
            )?.bytes,
            "random record one is written to B",
          )
          .toEqual(new Array(128).fill(0x79));
        expect
          .soft(
            results
              .at(-1)!
              .biosDisk!.records.filter((entry) => entry.drive === 0),
          )
          .toEqual(
            results[0]!.biosDisk!.records.filter((entry) => entry.drive === 0),
          );
        expect
          .soft(
            results
              .at(-1)!
              .biosDisk!.writes.every((write) => write.drive === 1),
          )
          .toBe(true);
        if (fn === 40) {
          expect
            .soft(
              record(written, 1, 68),
              "zero fill clears the preceding record of B's new block",
            )
            .toEqual(new Array(128).fill(0));
        }
        for (const end of [6, 10, 14, 20]) checkDefaultA(results.slice(0, end));
      },
    );

    it("implicitly logs in a reset current drive before a default-FCB operation", () => {
      const results = run(disks(true), [
        reset(),
        step("dma", 26, DMA),
        step("reset-current-a", 37, 1),
        step("open-default-a-after-reset", 15, FIRST, [
          { address: FIRST, bytes: fcb("SHARED") },
        ]),
        step("read-default-a-after-reset", 20, FIRST, [payload(0)]),
        step("login-vector-after-open", 24, 0),
        ...defaultQueries(),
      ]);
      expect(results[3]!.registers.a).toBeLessThan(4);
      expect(results[4]!.registers.a).toBe(0);
      expect([...results[4]!.memory.slice(DMA, DMA + 128)]).toEqual(
        new Array(128).fill(0xa1),
      );
      expect
        .soft(
          results[3]!.biosCalls
            .filter((call) => call.entry === 9)
            .map((call) => [call.registers.c, call.registers.e & 1]),
          "default FCB access performs fresh login after resetting the current disk",
        )
        .toEqual([[0, 0]]);
      expect.soft(results[5]!.registers.l).toBe(1);
      checkDefaultA(results);
    });

    it("preserves unclosed A allocations across B/A selection so a second file cannot reuse them", () => {
      const results = run(disks(), [
        reset(),
        step("dma", 26, DMA),
        step("make-first-a", 22, FIRST, [
          { address: FIRST, bytes: fcb("FIRST") },
        ]),
        step("write-first-a-without-close", 21, FIRST, [payload(0x37)]),
        step("select-b", 14, 1),
        step("select-a", 14, 0),
        step("make-second-a", 22, SECOND, [
          { address: SECOND, bytes: fcb("SECOND") },
        ]),
        step("write-second-a", 21, SECOND, [payload(0x6b)]),
        step("reread-first-a", 20, FIRST, [
          { address: FIRST + 32, bytes: [0] },
          payload(0),
        ]),
        step("reread-second-a", 20, SECOND, [
          { address: SECOND + 32, bytes: [0] },
          payload(0),
        ]),
      ]);
      const first = results[3]!;
      const selectedA = results[5]!;
      const second = results[7]!;
      const block = first.memory[FIRST + 16]!;
      expect(block).toBeGreaterThanOrEqual(2);
      expect(first.registers.a).toBe(0);
      expect(second.registers.a).toBe(0);
      expect(
        first.memory[ALVS[0]! + (block >>> 3)]! & (128 >>> (block & 7)),
      ).not.toBe(0);
      expect
        .soft(
          selectedA.memory.slice(ALVS[0], ALVS[0]! + ALV_BYTES),
          "reselecting A must retain blocks held only in an open FCB",
        )
        .toEqual(first.memory.slice(ALVS[0], ALVS[0]! + ALV_BYTES));
      expect
        .soft(
          second.memory[SECOND + 16],
          "second A file must allocate another block",
        )
        .not.toBe(block);
      expect
        .soft(
          record(second, 0, 52 + block * 8),
          "first A record must survive the second file write",
        )
        .toEqual(new Array(128).fill(0x37));
      expect
        .soft([...results[8]!.memory.slice(DMA, DMA + 128)])
        .toEqual(new Array(128).fill(0x37));
      expect([...results[9]!.memory.slice(DMA, DMA + 128)]).toEqual(
        new Array(128).fill(0x6b),
      );
      expect(results[8]!.registers.a).toBe(0);
      expect(results[9]!.registers.a).toBe(0);
      expect(record(second, 1, 68)).toEqual(new Array(128).fill(0xb2));
      expect(second.biosDisk!.writes.every((write) => write.drive === 0)).toBe(
        true,
      );
      expect(second.memory.slice(ALVS[1], ALVS[1]! + ALV_BYTES)).toEqual(
        selectedA.memory.slice(ALVS[1], ALVS[1]! + ALV_BYTES),
      );
    });

    it("honors explicit B FCBs for open/read/write/close while the default drive remains A", () => {
      const results = run(disks(true), [
        reset(),
        step("dma", 26, DMA),
        step("open-explicit-b", 15, FIRST, [
          { address: FIRST, bytes: fcb("SHARED", 2) },
        ]),
        step("read-explicit-b", 20, FIRST, [payload(0)]),
        step("current-after-b-read", 25, 0),
        step("write-explicit-b", 21, FIRST, [
          { address: FIRST + 32, bytes: [0] },
          payload(0xc3),
        ]),
        step("close-explicit-b", 16, FIRST),
        step("current-after-b-close", 25, 0),
        step("open-default-a", 15, SECOND, [
          { address: SECOND, bytes: fcb("SHARED") },
        ]),
        step("read-default-a", 20, SECOND, [payload(0)]),
        step("reread-explicit-b", 20, FIRST, [
          { address: FIRST + 32, bytes: [0] },
          payload(0),
        ]),
        step("current-after-reread", 25, 0),
      ]);
      for (const index of [2, 6, 8])
        expect(results[index]!.registers.a).toBeLessThan(4);
      for (const index of [3, 4, 5, 7, 9, 10, 11])
        expect(results[index]!.registers.a).toBe(0);
      expect
        .soft(
          [...results[3]!.memory.slice(DMA, DMA + 128)],
          "explicit B reads B's same-named file",
        )
        .toEqual(new Array(128).fill(0xb2));
      expect
        .soft(
          [...results[9]!.memory.slice(DMA, DMA + 128)],
          "default A remains unchanged after explicit B write",
        )
        .toEqual(new Array(128).fill(0xa1));
      expect([...results[10]!.memory.slice(DMA, DMA + 128)]).toEqual(
        new Array(128).fill(0xc3),
      );
      const final = results.at(-1)!;
      expect
        .soft(record(final, 0, 68), "A's backing record must remain intact")
        .toEqual(new Array(128).fill(0xa1));
      expect
        .soft(
          record(final, 1, 76),
          "the new payload must reach B's backing record",
        )
        .toEqual(new Array(128).fill(0xc3));
      expect
        .soft(
          results[2]!.memory[FIRST + 16],
          "OPEN imports B's distinct allocation map",
        )
        .toBe(3);
      expect(record(final, 1, 68)).toEqual(new Array(128).fill(0xb4));
      expect(final.biosDisk!.writes.length).toBeGreaterThanOrEqual(2);
      expect
        .soft(
          final.biosDisk!.writes.every((write) => write.drive === 1),
          "all explicit B writes belong to B",
        )
        .toBe(true);
      expect(final.memory[FIRST]).toBe(2);
      for (const result of results) expect(result.memory[4]).toBe(0);
    });

    it("passes first-login hints and rebuilds only the reset drive on same-drive reselection", () => {
      const results = run(disks(), [
        reset(),
        step("dma", 26, DMA),
        step("make-a", 22, FIRST, [{ address: FIRST, bytes: fcb("FIRST") }]),
        step("allocate-a", 21, FIRST, [payload(0x37)]),
        step("first-select-b", 14, 1),
        step("make-b", 22, SECOND, [{ address: SECOND, bytes: fcb("SECOND") }]),
        step("allocate-b", 21, SECOND, [payload(0x6b)]),
        step("reselect-a", 14, 0),
        step("reset-a-only", 37, 1),
        step("select-reset-a", 14, 0),
        step("login-vector", 24, 0),
      ]);
      const selections = results.flatMap((result) =>
        result.biosCalls
          .filter((call) => call.entry === 9)
          .map((call) => [call.registers.c, call.registers.e & 1]),
      );
      expect
        .soft(
          selections,
          "SELDSK distinguishes first login from retained drive state",
        )
        .toEqual([
          [0, 0],
          [1, 0],
          [0, 1],
          [0, 0],
        ]);
      const beforeReset = results[7]!;
      const afterReset = results[9]!;
      expect(afterReset.memory[ALVS[0]!]).toBe(0xc0);
      expect(afterReset.memory.slice(ALVS[1], ALVS[1]! + ALV_BYTES)).toEqual(
        results[6]!.memory.slice(ALVS[1], ALVS[1]! + ALV_BYTES),
      );
      expect(afterReset.biosDisk!.records).toEqual(
        beforeReset.biosDisk!.records,
      );
      expect(afterReset.biosDisk!.writes).toEqual(beforeReset.biosDisk!.writes);
      expect
        .soft(results[10]!.registers.l, "reselected A must be logged in again")
        .toBe(3);
    });
  },
);
