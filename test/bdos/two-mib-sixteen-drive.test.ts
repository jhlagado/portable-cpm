import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { beforeAll, describe, it } from "vitest";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { createDebug80TestHarness } from "../support/debug80-runtime.js";
import { BdosBiosDiskDouble } from "../support/bdos-bios-double.js";

const SIZE = 2 * 1024 * 1024;
const DIRECTORY = 16384;
const DATA = 49152;
const DMA = 0x800;
const SP = 0xd000;
const ALVS = Array.from({ length: 16 }, (_, i) => 0x7000 + i * 128);
const first = (drive: number) => 0x200 + drive * 64;
const second = (drive: number) => 0x1000 + drive * 64;
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const word = (bytes: Uint8Array, offset: number) =>
  bytes[offset]! + bytes[offset + 1]! * 256;
function fcb(drive: number, name: string) {
  const bytes = new Uint8Array(36);
  bytes[0] = drive + 1;
  bytes.set(Buffer.from(`${name.padEnd(8)}DAT`), 1);
  return bytes;
}
const emptyVector = () => {
  const bytes = new Uint8Array(127);
  bytes[0] = bytes[1] = 255;
  return bytes;
};

// This qualifies portable BDOS against sixteen separate BIOS-owned DPHs and
// ALVs, not a Triptych resident layout. Tables deliberately live in the test
// transient area. The existing BIOS double supplies selection/table semantics;
// bounded streaming image I/O avoids copying cumulative traces per guest call.
describe("two MiB / two KiB / 1024-entry portable sixteen-drive boundary", () => {
  let built: Awaited<ReturnType<typeof assembleZ80WithLabelsForTest>>;
  beforeAll(async () => {
    built = await assembleZ80WithLabelsForTest(resolve("src/bdos.asm"));
    assert.equal(built.base, 0xec00);
    assert.equal(built.bytes.length, 3584);
  });

  function machine() {
    const runtime = createDebug80TestHarness().createRuntime({});
    const memory = runtime.hardware.memory;
    memory.set(built.bytes, built.base);
    memory.set([0xc3, 3, 0xfa], 0);
    memory.set([0xc3, 6, 0xec], 5);
    memory.set([0xcd, 5, 0, 0x76], 0x100);
    for (let entry = 0; entry < 17; entry++) {
      memory.set([0xc3, entry, 0xfb], 0xfa00 + entry * 3);
      memory[0xfb00 + entry] = 0xc9;
    }
    const tables = new BdosBiosDiskDouble(
      {
        drives: ALVS.map((allocationVectorAddress, number) => ({
          number,
          dphAddress: 0x6000 + number * 16,
          dpbAddress: 0x6100,
          directoryBufferAddress: 0x6200,
          checkVectorAddress: 0x6280,
          allocationVectorAddress,
          firstSector: 1,
          dpb: {
            sectorsPerTrack: 128,
            blockShift: 4,
            blockMask: 15,
            extentMask: 0,
            maximumBlock: 1015,
            maximumDirectoryEntry: 1023,
            directoryAllocation0: 255,
            directoryAllocation1: 255,
            checkVectorBytes: 0,
            reservedTracks: 1,
          },
        })),
      },
      memory,
    );
    const images = ALVS.map((_, drive) => {
      const image = new Uint8Array(SIZE).fill(0x30 + drive);
      image.fill(0xe5, DIRECTORY, DATA);
      return image;
    });
    const guards = [
      0x6fff,
      SP - 3,
      SP,
      ...ALVS.map((address) => address + 127),
      ...ALVS.flatMap((_, drive) => [
        first(drive) - 1,
        first(drive) + 36,
        second(drive) - 1,
        second(drive) + 36,
      ]),
    ];
    for (const address of guards) memory[address] = 0x59;
    let selected = 0,
      track = 0,
      sector = 1,
      dma = 0x80,
      calls = 0,
      instructions = 0,
      writes = 0,
      dataReads = 0,
      maxInstructions = 0,
      minSp = built.labels.STKTOP!;
    const consoleBytes: number[] = [];
    function call(fn: number, de = first(0), fatal = false) {
      calls++;
      runtime.restoreCpuState({
        ...runtime.captureCpuState(),
        pc: 0x100,
        sp: SP,
        c: fn,
        d: de >>> 8,
        e: de & 255,
        halted: false,
      });
      let count = 0;
      let warmBoot = false;
      while (!runtime.isHalted() && count++ < 1_000_000) {
        const state = runtime.captureCpuState();
        if (state.sp >= built.base && state.sp < 0xfa00)
          minSp = Math.min(minSp, state.sp);
        if (state.pc >= 0xfb00 && state.pc < 0xfb11) {
          const entry = state.pc - 0xfb00;
          if (entry === 1) {
            warmBoot = true;
            break;
          }
          if (entry === 8) track = 0;
          if (entry === 9) selected = state.c;
          if (entry === 10) track = state.b * 256 + state.c;
          if (entry === 11) sector = state.b * 256 + state.c;
          if (entry === 12) dma = state.b * 256 + state.c;
          if (entry === 13 || entry === 14) {
            assert(selected >= 0 && selected < 16);
            assert(track >= 0 && track < 128 && sector >= 1 && sector <= 128);
            assert(dma + 128 <= 65536);
            const record = track * 128 + sector - 1;
            const image = images[selected]!;
            if (entry === 13) {
              memory.set(image.subarray(record * 128, record * 128 + 128), dma);
              if (record >= DATA / 128) dataReads++;
            } else {
              assert(
                record >= 128,
                "BDOS must not write reserved system records",
              );
              image.set(memory.subarray(dma, dma + 128), record * 128);
              writes++;
            }
            state.a = 0;
          } else if (entry === 2) state.a = 0;
          else if (entry === 3)
            state.a = 3; // Ctrl-C accepts a fatal error exit.
          else if (entry === 4) consoleBytes.push(state.c);
          else tables.handle(entry, state);
          runtime.restoreCpuState(state);
        }
        runtime.step();
      }
      instructions += count;
      maxInstructions = Math.max(maxInstructions, count);
      assert.equal(warmBoot, fatal, `function ${fn} fatal exit`);
      const state = runtime.captureCpuState();
      if (!fatal) {
        assert(runtime.isHalted(), `function ${fn} exceeded instruction limit`);
        assert.equal(state.pc, 0x104);
        assert.equal(state.sp, SP);
        assert.equal(state.a, state.l);
      }
      assert(minSp >= built.labels.STKBASE!);
      for (const address of guards) assert.equal(memory[address], 0x59);
      assert.deepEqual(
        memory.subarray(built.base, built.labels.OLDSP!),
        built.bytes.subarray(0, built.labels.OLDSP! - built.base),
        "BDOS code and immutable data remain intact",
      );
      return { a: state.a, hl: state.h * 256 + state.l };
    }
    return {
      memory,
      images,
      call,
      vector: (drive: number) => memory.slice(ALVS[drive]!, ALVS[drive]! + 127),
      stats: () => ({
        calls,
        instructions,
        maxInstructions,
        writes,
        dataReads,
        peakStackBytes: built.labels.STKTOP! - minSp,
      }),
      console: () => Buffer.from(consoleBytes).toString("ascii"),
    };
  }

  it("writes P's complete data volume through BDOS, reconstructs it on reopen and safely reuses deleted blocks", () => {
    const started = performance.now();
    const m = machine();
    const address = first(15);
    const records = 16_000;
    const payload = (record: number) => {
      const bytes = Uint8Array.from(
        { length: 128 },
        (_, offset) => (record * 13 + (record >>> 8) * 7 + offset * 19) & 255,
      );
      bytes.set([15, record & 255, record >>> 8]);
      return bytes;
    };
    const expected = new Uint8Array(records * 128);
    const untouched = m.images.slice(0, 15).map(sha);
    const reserved = sha(m.images[15]!.subarray(0, DIRECTORY));
    const fullVector = new Uint8Array(127).fill(255);
    assert.equal(m.call(13, 0).a, 0);
    assert.equal(m.call(26, DMA).a, 0);
    m.memory.set(fcb(15, "FULL"), address);
    assert(m.call(22, address).a < 4);
    for (let record = 0; record < records; record++) {
      const bytes = payload(record);
      expected.set(bytes, record * 128);
      m.memory.set(bytes, DMA);
      assert.equal(m.call(21, address).a, 0, `write record ${record}`);
      assert.deepEqual(
        m.images[15]!.subarray(DATA + record * 128, DATA + (record + 1) * 128),
        bytes,
        `physical record ${DATA / 128 + record}`,
      );
      if ((record & 15) === 0) {
        const cell = ((record & 127) >>> 4) * 2;
        assert.equal(word(m.memory, address + 16 + cell), 16 + record / 16);
      }
    }
    assert(m.call(16, address).a < 4);
    assert.deepEqual(m.images[15]!.subarray(DATA), expected);
    assert.equal(DATA / 128 + records - 1, 16_383);
    assert.deepEqual(m.vector(15), fullVector);
    assert.deepEqual(m.images.slice(0, 15).map(sha), untouched);
    assert.equal(sha(m.images[15]!.subarray(0, DIRECTORY)), reserved);

    // Directory capacity is independent of data capacity: MAKE and CLOSE of
    // another empty file succeed after every data block was genuinely written.
    const extra = second(15);
    m.memory.set(fcb(15, "EMPTY"), extra);
    assert(m.call(22, extra).a < 4);
    assert(m.call(16, extra).a < 4);
    const freeEntries = Array.from({ length: 1024 }, (_, index) =>
      m.images[15]![DIRECTORY + index * 32] === 0xe5 ? 1 : 0,
    ).reduce<number>((sum, free) => sum + free, 0);
    assert(freeEntries > 0, "disk-full is not directory-full");

    function rejectAllocation(
      target: ReturnType<typeof machine>,
      fcbAddress: number,
    ) {
      const before = {
        images: target.images.map(sha),
        vectors: ALVS.map((_, drive) => target.vector(drive)),
        fcb: target.memory.slice(fcbAddress, fcbAddress + 36),
        writes: target.stats().writes,
      };
      target.memory.set(payload(records), DMA);
      assert.equal(target.call(21, fcbAddress).a, 2);
      assert.deepEqual(target.images.map(sha), before.images);
      assert.deepEqual(
        ALVS.map((_, drive) => target.vector(drive)),
        before.vectors,
      );
      assert.deepEqual(
        target.memory.slice(fcbAddress, fcbAddress + 36),
        before.fcb,
      );
      assert.equal(target.stats().writes, before.writes);
    }
    rejectAllocation(m, address);
    rejectAllocation(m, extra);

    // Only persisted bytes cross this boundary. Fresh CPU/table/vector memory
    // prevents a cached full ALV from concealing failed login reconstruction.
    const reopened = machine();
    reopened.images[15]!.set(m.images[15]!);
    assert.equal(reopened.call(13, 0).a, 0);
    assert.equal(reopened.call(26, DMA).a, 0);
    reopened.memory.set(fcb(15, "FULL"), address);
    assert(reopened.call(15, address).a < 4);
    assert.deepEqual(reopened.vector(15), fullVector);
    const saved = reopened.images.map(sha);
    for (let record = 0; record < records; record++) {
      reopened.memory.fill(0, DMA, DMA + 128);
      assert.equal(reopened.call(20, address).a, 0, `read record ${record}`);
      assert.deepEqual(reopened.memory.slice(DMA, DMA + 128), payload(record));
    }
    assert.equal(reopened.call(20, address).a, 1, "EOF after final record");
    assert.equal(reopened.stats().dataReads, records);
    assert.deepEqual(reopened.images.map(sha), saved);
    reopened.memory.set(fcb(15, "EMPTY"), extra);
    assert(reopened.call(15, extra).a < 4);
    rejectAllocation(reopened, extra);

    reopened.memory.set(fcb(15, "FULL"), address);
    assert(reopened.call(19, address).a < 4);
    assert.deepEqual(reopened.vector(15), emptyVector());
    reopened.memory.set(fcb(15, "REUSE"), address);
    assert(reopened.call(22, address).a < 4);
    for (let record = 0; record < 17; record++) {
      reopened.memory.set(payload(records + record), DMA);
      assert.equal(reopened.call(21, address).a, 0);
    }
    assert(reopened.call(16, address).a < 4);
    assert.equal(word(reopened.memory, address + 16), 16);
    assert.equal(word(reopened.memory, address + 18), 17);
    for (let record = 0; record < 17; record++)
      assert.deepEqual(
        reopened.images[15]!.subarray(
          DATA + record * 128,
          DATA + (record + 1) * 128,
        ),
        payload(records + record),
      );
    assert.deepEqual(reopened.images.slice(0, 15).map(sha), untouched);
    assert.equal(sha(reopened.images[15]!.subarray(0, DIRECTORY)), reserved);
    console.log(
      JSON.stringify({
        boundary: "portable-bdos-two-mib-full-volume-double",
        records,
        dataBlocks: 1000,
        finalPhysicalRecord: 16_383,
        freeDirectoryEntriesAfterFill: freeEntries,
        bdosSha256: sha(built.bytes),
        fill: m.stats(),
        reopen: reopened.stats(),
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  }, 180_000);

  it("keeps unclosed allocations distinct on all sixteen drives and handles mask bits 7, 8 and 15 with default P", () => {
    const m = machine();
    m.call(13, 0);
    assert.equal(m.call(14, 15).a, 0);
    assert.equal(m.call(27, 0).hl, ALVS[15]);
    m.call(26, DMA);
    for (let drive = 0; drive < 16; drive++) {
      m.memory.set(fcb(drive, "FIRST"), first(drive));
      assert(m.call(22, first(drive)).a < 4);
      m.memory.fill(0x40 + drive, DMA, DMA + 128);
      assert.equal(m.call(21, first(drive)).a, 0);
      assert.equal(word(m.memory, first(drive) + 16), 16);
      assert.equal(m.call(25, 0).a, 15);
    }
    assert.equal(m.call(24, 0).hl, 0xffff);
    // Creating another FCB after visiting every other drive must retain the
    // first file's still-unclosed block reservation rather than reallocate it.
    for (let drive = 15; drive >= 0; drive--) {
      m.memory.set(fcb(drive, "SECOND"), second(drive));
      assert(m.call(22, second(drive)).a < 4);
      m.memory.fill(0x80 + drive, DMA, DMA + 128);
      assert.equal(m.call(21, second(drive)).a, 0);
      assert.equal(word(m.memory, second(drive) + 16), 17);
      assert(m.call(16, second(drive)).a < 4);
      assert(m.call(16, first(drive)).a < 4);
      const vector = emptyVector();
      vector[2] = 0xc0;
      assert.deepEqual(m.vector(drive), vector);
      assert.deepEqual(
        m.images[drive]!.subarray(DATA, DATA + 128),
        new Uint8Array(128).fill(0x40 + drive),
      );
      assert.deepEqual(
        m.images[drive]!.subarray(DATA + 2048, DATA + 2176),
        new Uint8Array(128).fill(0x80 + drive),
      );
    }
    for (const drive of [7, 8, 15]) {
      m.call(14, drive);
      m.call(28, 0);
    }
    assert.equal(m.call(29, 0).hl, 0x8180);
    assert.equal(m.call(37, 0x180).a, 0);
    assert.equal(m.call(24, 0).hl, 0xfe7f);
    assert.equal(m.call(29, 0).hl, 0x8000);
    assert.equal(m.call(25, 0).a, 15);
    const before = m.images.map(sha);
    m.call(13, 0);
    assert.equal(m.call(29, 0).hl, 0);
    for (let drive = 0; drive < 16; drive++) {
      m.memory.set(fcb(drive, "FIRST"), first(drive));
      assert(m.call(15, first(drive)).a < 4);
      m.memory.fill(0, DMA, DMA + 128);
      m.call(26, DMA);
      assert.equal(m.call(20, first(drive)).a, 0);
      assert.deepEqual(
        m.memory.slice(DMA, DMA + 128),
        new Uint8Array(128).fill(0x40 + drive),
      );
    }
    assert.deepEqual(m.images.map(sha), before);
  }, 30_000);

  it.each([255, 256, 1015])(
    "allocates word block %i on P and fails full allocation without touching another drive",
    (block) => {
      const m = machine();
      m.call(13, 0);
      m.call(26, DMA);
      for (const address of [first(15), second(15)]) {
        m.memory.set(
          fcb(15, address === first(15) ? "FIRST" : "SECOND"),
          address,
        );
        assert(m.call(22, address).a < 4);
      }
      // Deliberate ALV-only boundary injection: this is not a full-volume proof.
      const vector = new Uint8Array(127).fill(255);
      vector[block >>> 3] = 255 ^ (128 >>> (block & 7));
      m.memory.set(vector, ALVS[15]!);
      m.memory.fill(0x64, DMA, DMA + 128);
      assert.equal(m.call(21, first(15)).a, 0);
      assert.equal(word(m.memory, first(15) + 16), block);
      const physical = 128 + block * 16;
      assert.deepEqual(
        m.images[15]!.subarray(physical * 128, physical * 128 + 128),
        new Uint8Array(128).fill(0x64),
      );
      const before = m.images.map(sha);
      const vectors = ALVS.map((_, drive) => m.vector(drive));
      const writes = m.stats().writes;
      const unchangedFcb = m.memory.slice(second(15), second(15) + 36);
      assert.equal(m.call(21, second(15)).a, 2);
      assert.deepEqual(m.images.map(sha), before);
      assert.deepEqual(
        ALVS.map((_, drive) => m.vector(drive)),
        vectors,
      );
      assert.deepEqual(
        m.memory.slice(second(15), second(15) + 36),
        unchangedFcb,
      );
      assert.equal(m.stats().writes, writes);
    },
  );

  it("reads P's last physical record but rejects block 1016 before data I/O or allocation-vector overflow", () => {
    const m = machine();
    const directory = fcb(-1, "LAST");
    directory[15] = 16;
    directory[16] = 1015 & 255;
    directory[17] = 1015 >>> 8;
    m.images[15]!.set(directory.subarray(0, 32), DIRECTORY);
    m.images[15]!.fill(0xc1, SIZE - 256, SIZE - 128);
    m.images[15]!.fill(0xd3, SIZE - 128);
    m.call(13, 0);
    m.call(26, DMA);
    m.memory.set(fcb(15, "LAST"), first(15));
    assert(m.call(15, first(15)).a < 4);
    m.memory[first(15) + 32] = 15;
    assert.equal(m.call(20, first(15)).a, 0);
    assert.deepEqual(
      m.memory.slice(DMA, DMA + 128),
      new Uint8Array(128).fill(0xd3),
    );
    m.memory[first(15) + 16] = 1016 & 255;
    m.memory[first(15) + 17] = 1016 >>> 8;
    m.memory[first(15) + 32] = 0;
    const before = m.images.map(sha);
    const vectors = ALVS.map((_, drive) => m.vector(drive));
    const stats = m.stats();
    m.call(20, first(15), true);
    assert.match(m.console(), /Bdos Err On P: Bad Sector/);
    assert.equal(m.stats().writes, stats.writes);
    assert.equal(m.stats().dataReads, stats.dataReads);
    assert.deepEqual(m.images.map(sha), before);
    assert.deepEqual(
      ALVS.map((_, drive) => m.vector(drive)),
      vectors,
    );
  });

  it("fills P's 1024-entry directory with data free, safely rejects entry 1025 and reuses only slot 1023", () => {
    const m = machine();
    m.call(13, 0);
    const name = (file: number) => `F${file.toString().padStart(7, "0")}`;
    const untouched = m.images.slice(0, 15).map(sha);
    const nonDirectory = [
      sha(m.images[15]!.subarray(0, DIRECTORY)),
      sha(m.images[15]!.subarray(DATA)),
    ];
    for (let file = 0; file < 1024; file++) {
      m.memory.set(fcb(15, name(file)), first(15));
      assert(m.call(22, first(15)).a < 4, `make ${file}`);
      assert(m.call(16, first(15)).a < 4, `close ${file}`);
    }
    for (let file = 0; file < 1024; file++) {
      const entry = m.images[15]!.subarray(
        DIRECTORY + file * 32,
        DIRECTORY + (file + 1) * 32,
      );
      const expected = fcb(-1, name(file)).subarray(0, 32);
      assert.deepEqual(entry, expected);
    }
    function reject(file: number) {
      m.memory.set(fcb(15, name(file)), first(15));
      const before = m.images.map(sha);
      const writes = m.stats().writes;
      assert.equal(m.call(22, first(15)).a, 0xff);
      assert.deepEqual(m.images.map(sha), before);
      assert.equal(m.stats().writes, writes);
      assert.deepEqual(m.vector(15), emptyVector());
    }
    reject(1024);
    const expected = m.images[15]!.slice();
    expected[DIRECTORY + 1023 * 32] = 0xe5;
    m.memory.set(fcb(15, name(1023)), first(15));
    assert(m.call(19, first(15)).a < 4);
    assert.deepEqual(m.images[15], expected);
    m.memory.set(fcb(15, name(1024)), first(15));
    assert(m.call(22, first(15)).a < 4);
    assert(m.call(16, first(15)).a < 4);
    expected.set(fcb(-1, name(1024)).subarray(0, 32), DIRECTORY + 1023 * 32);
    assert.deepEqual(m.images[15], expected);
    reject(1025);
    m.memory.fill(0xa5, ALVS[15]!, ALVS[15]! + 127);
    m.call(13, 0);
    for (const file of [0, 255, 256, 511, 512, 1022, 1024]) {
      m.memory.set(fcb(15, name(file)), first(15));
      assert(m.call(15, first(15)).a < 4, `reopen ${file}`);
    }
    m.memory.set(fcb(15, name(1023)), first(15));
    assert.equal(m.call(15, first(15)).a, 0xff);
    assert.deepEqual(m.vector(15), emptyVector());
    assert.deepEqual(m.images.slice(0, 15).map(sha), untouched);
    assert.deepEqual(
      [
        sha(m.images[15]!.subarray(0, DIRECTORY)),
        sha(m.images[15]!.subarray(DATA)),
      ],
      nonDirectory,
    );
    console.log(
      JSON.stringify({
        boundary: "portable-bdos-sixteen-drive-double",
        directoryEntries: 1024,
        freeDataBlocks: 1000,
        bdosSha256: sha(built.bytes),
        ...m.stats(),
      }),
    );
  }, 180_000);
});
