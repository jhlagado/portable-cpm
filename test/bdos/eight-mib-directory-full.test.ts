import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { it } from "vitest";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { createDebug80TestHarness } from "../support/debug80-runtime.js";
import { BdosBiosDiskDouble } from "../support/bdos-bios-double.js";

const PROFILE = "triptych-cpu-v0.1-8m-ab";
// Retained v0.1.3, source c2b64f013f0a96d015f7aaa7a2c35183579a9559.
// This is a release-byte qualification, not a regenerated expected hash.
const RELEASE_BDOS_SHA256 =
  "817b0e03552db6a2b369471402524e6c1bebf54163f0d95b75b911c06642fce5";
const SIZE = 8 * 1024 * 1024;
const DIRECTORY = 16 * 1024;
const DATA = 32 * 1024;
const FCB = 0x200;
const OTHER_FCB = 0x240;
const SP = 0xd000;
const ALVS = [0xfc00, 0xfe00];
const GUARDS = [0xfbff, 0xfdff, 0xffff, FCB - 1, FCB + 36, SP - 3, SP];
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function fcb(drive: number, file: number) {
  const bytes = new Uint8Array(36);
  bytes[0] = drive + 1;
  bytes.set(Buffer.from(`F${file.toString().padStart(7, "0")}DAT`), 1);
  return bytes;
}

// Streaming direct CALL 0005 execution, using the existing BIOS table double.
// Neither directory entries nor allocation bits are seeded with files. Fixed
// arrays avoid cloning all previous I/O after every one of 1,024 guest makes.
it("rejects the 513th empty file on each 8 MiB drive with data free, then reuses the deleted final slot", async () => {
  const started = performance.now();
  const built = await assembleZ80WithLabelsForTest(
    resolve("src/bdos.asm"),
    PROFILE,
  );
  assert.equal(built.base, 0xeb00);
  assert.equal(built.bytes.length, 3584);
  assert.equal(sha(built.bytes), RELEASE_BDOS_SHA256);
  const runtime = createDebug80TestHarness().createRuntime({});
  const memory = runtime.hardware.memory;
  memory.set(built.bytes, built.base);
  memory.set([0xc3, 6, 0xeb], 5);
  memory.set([0xcd, 5, 0, 0x76], 0x100);
  for (let entry = 0; entry < 17; entry++) {
    memory.set([0xc3, entry, 0xfb], 0xf900 + entry * 3);
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
  const images = [0x31, 0xa7].map((fill) => {
    const image = new Uint8Array(SIZE).fill(fill);
    image.fill(0xe5, DIRECTORY, DATA);
    return image;
  });
  const originalNonDirectory = images.map((image) => [
    sha(image.subarray(0, DIRECTORY)),
    sha(image.subarray(DATA)),
  ]);
  const otherFcb = Uint8Array.from({ length: 36 }, (_, i) => 0x60 + i);
  memory.set(otherFcb, OTHER_FCB);
  for (const address of GUARDS) memory[address] = 0x59;
  let selected = 0,
    track = 0,
    sector = 1,
    dma = 0x80,
    calls = 0,
    instructions = 0,
    writes = 0,
    maximumCallInstructions = 0;
  let minSp = built.labels.STKTOP!;
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
      if (state.sp >= built.base && state.sp < 0xf900)
        minSp = Math.min(minSp, state.sp);
      if (state.pc >= 0xfb00 && state.pc < 0xfb11) {
        const entry = state.pc - 0xfb00;
        assert.notEqual(entry, 1, `unexpected warm boot in function ${fn}`);
        if (entry === 8) track = 0;
        if (entry === 9) selected = state.c;
        if (entry === 10) track = state.b * 256 + state.c;
        if (entry === 11) sector = state.b * 256 + state.c;
        if (entry === 12) dma = state.b * 256 + state.c;
        if (entry === 13 || entry === 14) {
          assert(selected === 0 || selected === 1);
          assert(track >= 0 && track < 512 && sector >= 1 && sector <= 128);
          assert(dma + 128 <= 65536);
          const record = track * 128 + sector - 1;
          const image = images[selected]!;
          if (entry === 13)
            memory.set(image.subarray(record * 128, record * 128 + 128), dma);
          else {
            assert(record >= 128 && record < 256, "only directory writes");
            image.set(memory.subarray(dma, dma + 128), record * 128);
            writes++;
          }
          state.a = 0;
        } else if (entry === 2) state.a = 0;
        else tables.handle(entry, state);
        runtime.restoreCpuState(state);
      }
      runtime.step();
    }
    instructions += count;
    maximumCallInstructions = Math.max(maximumCallInstructions, count);
    assert(runtime.isHalted(), `function ${fn} exceeded bounded step count`);
    const state = runtime.captureCpuState();
    assert.equal(state.pc, 0x104);
    assert.equal(state.sp, SP);
    assert.equal(state.a, state.l, "8-bit BDOS results agree in A and L");
    assert(minSp >= built.labels.STKBASE!);
    for (const address of GUARDS) assert.equal(memory[address], 0x59);
    assert.deepEqual(memory.slice(OTHER_FCB, OTHER_FCB + 36), otherFcb);
    return state.a;
  }
  const freeDataVector = new Uint8Array(511);
  freeDataVector[0] = 255; // Eight directory blocks, all 4,080 data blocks free.
  function checkFreeData() {
    for (const address of ALVS)
      assert.deepEqual(memory.slice(address, address + 511), freeDataVector);
    assert.deepEqual(
      images.map((image) => [
        sha(image.subarray(0, DIRECTORY)),
        sha(image.subarray(DATA)),
      ]),
      originalNonDirectory,
    );
  }
  function reject(drive: number, file: number) {
    memory.set(fcb(drive, file), FCB);
    const before = {
      media: images.map((image) => image.slice()),
      vectors: ALVS.map((address) => memory.slice(address, address + 511)),
      writes,
    };
    assert.equal(call(22), 0xff, `directory-full make ${drive}:${file}`);
    assert.deepEqual(images, before.media);
    assert.deepEqual(
      ALVS.map((address) => memory.slice(address, address + 511)),
      before.vectors,
    );
    assert.equal(writes, before.writes);
    // The interface protects unrelated FCBs, not arbitrary scratch fields in
    // the failed make's own FCB; call() checks the unrelated sentinel each time.
    assert.equal(
      call(25, 0),
      0,
      "explicit B never changes the default A drive",
    );
    checkFreeData();
  }
  assert.equal(call(13, 0), 0);
  assert.equal(call(14, 1), 0);
  assert.equal(call(14, 0), 0);
  checkFreeData();
  for (let drive = 0; drive < 2; drive++) {
    const otherBefore = images[1 - drive]!.slice();
    for (let file = 0; file < 512; file++) {
      memory.set(fcb(drive, file), FCB);
      assert(call(22) < 4, `make ${drive}:${file}`);
      assert(call(16) < 4, `close ${drive}:${file}`);
    }
    const directory = images[drive]!.subarray(DIRECTORY, DATA);
    for (let slot = 0; slot < 512; slot++) {
      const entry = directory.subarray(slot * 32, slot * 32 + 32);
      assert.equal(entry[0], 0);
      assert.deepEqual(entry.subarray(1, 12), fcb(drive, slot).subarray(1, 12));
      assert.equal(entry[15], 0, "empty file has zero records");
      assert.deepEqual(entry.subarray(16), new Uint8Array(16));
    }
    assert.deepEqual(images[1 - drive], otherBefore);
    reject(drive, 512);

    // Free the very last slot, not a low-byte directory-index alias. Apart
    // from its deletion marker, every byte of both media must be preserved.
    const expectedAfterDelete = images[drive]!.slice();
    expectedAfterDelete[DIRECTORY + 511 * 32] = 0xe5;
    memory.set(fcb(drive, 511), FCB);
    assert(call(19) < 4);
    assert.deepEqual(images[drive], expectedAfterDelete);
    assert.deepEqual(images[1 - drive], otherBefore);
    checkFreeData();
    memory.set(fcb(drive, 512), FCB);
    assert(call(22) < 4, "deleted final slot can be reused");
    assert(call(16) < 4);
    const expectedAfterReuse = expectedAfterDelete.slice();
    expectedAfterReuse[DIRECTORY + 511 * 32] = 0;
    expectedAfterReuse.set(
      fcb(drive, 512).subarray(1, 12),
      DIRECTORY + 511 * 32 + 1,
    );
    assert.deepEqual(images[drive], expectedAfterReuse);
    assert.deepEqual(images[1 - drive], otherBefore);
    reject(drive, 513);
  }
  // Discard cached login state; boundary names and the reused slot must exist
  // in the actual media directory, not merely in a live FCB/search cache.
  for (const address of ALVS) memory.fill(0xa5, address, address + 511);
  assert.equal(call(13, 0), 0);
  for (let drive = 0; drive < 2; drive++) {
    for (const file of [0, 255, 256, 510, 512]) {
      memory.set(fcb(drive, file), FCB);
      assert(call(15) < 4, `reopen ${drive}:${file}`);
      assert.equal(memory[FCB + 15], 0);
      assert.deepEqual(memory.slice(FCB + 16, FCB + 32), new Uint8Array(16));
      assert(call(16) < 4);
    }
    memory.set(fcb(drive, 511), FCB);
    assert.equal(call(15), 0xff, "deleted name must not reappear");
  }
  checkFreeData();
  assert.equal(call(25, 0), 0);
  console.log(
    JSON.stringify({
      profile: PROFILE,
      bdosSha256: sha(built.bytes),
      directoryEntriesPerDrive: 512,
      freeDataBlocksPerDrive: 4080,
      rejectedMakes: 4,
      reusedSlot: 511,
      calls,
      instructions,
      maximumCallInstructions,
      writes,
      peakStackBytes: built.labels.STKTOP! - minSp,
      images: images.map(sha),
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
}, 180_000);
