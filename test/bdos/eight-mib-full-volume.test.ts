import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { it } from "vitest";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { createDebug80TestHarness } from "../support/debug80-runtime.js";
import { BdosBiosDiskDouble } from "../support/bdos-bios-double.js";

const SIZE = 8 * 1024 * 1024;
const FCB = 0x200,
  DMA = 0x800,
  SP = 0xd000;
const ALVS = [0xfc00, 0xfe00];
const GUARDS = [0xfbff, 0xfdff, 0xffff, SP - 3, SP];
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fcb(drive: number, file: number) {
  const bytes = new Uint8Array(36);
  bytes[0] = drive + 1;
  bytes.set(Buffer.from(`F${file.toString().padStart(7, "0")}DAT`), 1);
  return bytes;
}
function pattern(drive: number, file: number, record: number) {
  const bytes = Uint8Array.from(
    { length: 128 },
    (_, offset) =>
      (drive * 113 +
        file * 37 +
        (record & 255) +
        (record >>> 8) * 19 +
        offset * 7) &
      255,
  );
  bytes.set([drive, file, record & 255, record >>> 8]);
  return bytes;
}

// A streaming version of the direct-call harness: use the existing BIOS table
// double, but retain media in fixed arrays instead of cloning every previous
// record and write after each of 130,560 writes. No directory/ALV is prefilled.
it("allocates every data record on two empty 8 MiB drives through BDOS and preserves full-volume failure", async () => {
  const started = performance.now();
  const built = await assembleZ80WithLabelsForTest(resolve("src/bdos.asm"));
  const harness = createDebug80TestHarness();
  const runtime = harness.createRuntime({});
  const memory = runtime.hardware.memory;
  memory.set(built.bytes, built.base);
  memory.set([0xc3, 6, 0xec], 5);
  memory.set([0xcd, 5, 0, 0x76], 0x100);
  for (let entry = 0; entry < 17; entry++) {
    memory.set([0xc3, entry, 0xfb], 0xfa00 + entry * 3);
    memory[0xfb00 + entry] = 0xc9;
  }
  const tables = new BdosBiosDiskDouble(
    {
      drives: [0, 1].map((number) => ({
        number,
        dphAddress: 0xfb20 + number * 0x20,
        dpbAddress: 0xfb30 + number * 0x20,
        directoryBufferAddress: 0xfa80,
        checkVectorAddress: 0xfb80,
        allocationVectorAddress: ALVS[number]!,
        firstSector: 1,
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
      })),
    },
    memory,
  );
  const images = [new Uint8Array(SIZE), new Uint8Array(SIZE)];
  for (const image of images) image.fill(0xe5, 128 * 128, 256 * 128);
  for (const address of GUARDS) memory[address] = 0x59;
  const seen = [new Uint8Array(65536), new Uint8Array(65536)];
  let selected = 0,
    track = 0,
    sector = 1,
    dma = 0x80;
  let calls = 0,
    instructions = 0,
    cycles = 0,
    writes = 0;
  let maximumCallInstructions = 0;
  let minSp = built.labels.STKTOP!;
  let expectedWrite:
    { drive: number; record: number; bytes: Uint8Array } | undefined;
  let lastDataRecord = -1;
  function call(fn: number, de = FCB) {
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
    while (!runtime.isHalted() && count++ < 1_000_000) {
      const state = runtime.captureCpuState();
      if (state.sp >= built.base && state.sp < 0xfa00)
        minSp = Math.min(minSp, state.sp);
      if (state.pc >= 0xfb00 && state.pc < 0xfb11) {
        const entry = state.pc - 0xfb00;
        if (entry === 1)
          throw new Error(`unexpected warm boot during function ${fn}`);
        if (entry === 8) track = 0;
        if (entry === 9) selected = state.c;
        if (entry === 10) track = state.b * 256 + state.c;
        if (entry === 11) sector = state.b * 256 + state.c;
        if (entry === 12) dma = state.b * 256 + state.c;
        if (entry === 13 || entry === 14) {
          const record = track * 128 + sector - 1;
          assert(selected === 0 || selected === 1);
          assert(track >= 0 && track < 512 && sector >= 1 && sector <= 128);
          assert(dma + 128 <= 65536);
          const image = images[selected]!;
          if (entry === 13)
            memory.set(image.subarray(record * 128, record * 128 + 128), dma);
          else {
            assert(
              record >= 128,
              "BDOS must not overwrite reserved system records",
            );
            const bytes = memory.slice(dma, dma + 128);
            if (record >= 256) {
              assert(
                expectedWrite,
                `unrequested data write at ${selected}:${record}`,
              );
              assert.equal(selected, expectedWrite.drive);
              assert.equal(record, expectedWrite.record);
              assert.deepEqual(bytes, expectedWrite.bytes);
              assert.equal(
                seen[selected]![record],
                0,
                "data record allocated twice",
              );
              seen[selected]![record] = 1;
              lastDataRecord = record;
              expectedWrite = undefined;
            }
            image.set(bytes, record * 128);
            writes++;
          }
          state.a = 0;
        } else if (entry === 2) state.a = 0;
        else tables.handle(entry, state);
        runtime.restoreCpuState(state);
      }
      cycles += runtime.step().cycles ?? 0;
    }
    instructions += count;
    maximumCallInstructions = Math.max(maximumCallInstructions, count);
    assert(runtime.isHalted(), `function ${fn} exceeded bounded step count`);
    const state = runtime.captureCpuState();
    assert.equal(state.pc, 0x104);
    assert.equal(state.sp, SP);
    assert(minSp >= built.labels.STKBASE!);
    for (const address of GUARDS) assert.equal(memory[address], 0x59);
    return state.a;
  }
  assert.equal(call(13, 0), 0);
  assert.equal(call(26, DMA), 0);
  // Sequential writes eagerly create a following empty extent. Two files
  // consume 510 populated extents plus two empty ones, exactly 512 entries.
  const files = [32768, 32512];
  for (let drive = 0; drive < 2; drive++) {
    let physical = 256;
    const otherBefore = sha(images[1 - drive]!);
    for (const [file, count] of files.entries()) {
      memory.set(fcb(drive, file), FCB);
      assert(call(22) < 4, `make ${drive}:${file}`);
      for (let record = 0; record < count; record++) {
        const bytes = pattern(drive, file, record);
        memory.set(bytes, DMA);
        expectedWrite = { drive, record: physical++, bytes };
        assert.equal(call(21), 0, `write ${drive}:${file}:${record}`);
        assert.equal(
          expectedWrite,
          undefined,
          "successful call must write its actual record",
        );
        if ((record & 15) === 0) {
          const slot = ((record & 127) >>> 4) * 2;
          const block =
            memory[FCB + 16 + slot]! | (memory[FCB + 17 + slot]! << 8);
          assert.equal(block, (physical - 1 - 128) / 16);
        }
      }
      assert(call(16) < 4, `close ${drive}:${file}`);
    }
    assert.equal(physical, 65536);
    assert.equal(lastDataRecord, 65535);
    assert.deepEqual(seen[drive]!.subarray(256), new Uint8Array(65280).fill(1));
    assert.deepEqual(
      memory.slice(ALVS[drive], ALVS[drive]! + 511),
      new Uint8Array(511).fill(255),
    );
    assert.equal(
      sha(images[1 - drive]!),
      otherBefore,
      "other drive unchanged by complete fill",
    );
    // The final file's next empty extent already exists, with CR=0. Its first
    // allocation must report disk-full (2), not directory/per-file exhaustion.
    // Snapshot only at this atomicity boundary.
    assert.equal(memory[FCB + 32], 0);
    assert.equal(memory[FCB + 15], 0);
    const before = {
      media: images.map(sha),
      fcb: memory.slice(FCB, FCB + 36),
      alvs: memory.slice(0xfc00),
      writes,
    };
    memory.set(pattern(drive, 1, files[1]!), DMA);
    assert.equal(call(21), 2);
    assert.deepEqual(images.map(sha), before.media);
    assert.deepEqual(memory.slice(FCB, FCB + 36), before.fcb);
    assert.deepEqual(memory.slice(0xfc00), before.alvs);
    assert.equal(writes, before.writes);
    assert(call(16) < 4);
    console.log(
      JSON.stringify({
        phase: "filled",
        drive,
        records: 65280,
        dataBlocks: 4080,
        finalRecord: lastDataRecord,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  }
  // After the genuine fill, poison the cached vectors with an all-free map.
  // Reopen must reconstruct all-full vectors from the real saved directory;
  // leaving the pre-reset full maps here would not distinguish a skipped login.
  for (const address of ALVS) memory.fill(0, address, address + 511);
  assert.equal(call(13, 0), 0);
  assert.equal(call(26, DMA), 0);
  for (let drive = 0; drive < 2; drive++) {
    for (const [file, count] of files.entries()) {
      memory.set(fcb(drive, file), FCB);
      assert(call(15) < 4);
      for (const record of new Set(
        [0, 15, 16, 127, 128, 3952, 3968, 4095, 4096, count - 1].filter(
          (r) => r < count,
        ),
      )) {
        memory.set([record & 255, record >>> 8, 0], FCB + 33);
        memory.fill(0, DMA, DMA + 128);
        assert.equal(call(33), 0, `reopen read ${drive}:${file}:${record}`);
        assert.deepEqual(
          memory.slice(DMA, DMA + 128),
          pattern(drive, file, record),
        );
      }
      assert(call(16) < 4);
    }
    assert.deepEqual(
      memory.slice(ALVS[drive], ALVS[drive]! + 511),
      new Uint8Array(511).fill(255),
    );
  }
  console.log(
    JSON.stringify({
      phase: "complete",
      calls,
      instructions,
      cycles,
      maximumCallInstructions,
      writes,
      peakStackBytes: built.labels.STKTOP! - minSp,
      images: images.map(sha),
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
}, 180_000);
