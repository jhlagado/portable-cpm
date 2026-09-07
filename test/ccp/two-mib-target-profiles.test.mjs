import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assembleProfiledFile,
  targetProfile,
  TWO_MIB_PROFILE_IDS,
} from "../../tools/lib/target-profiles.mjs";
import { installCpm22File } from "../../tools/lib/cpm22-disk.mjs";
import { PortableCpmMachine } from "../support/portable-cpm-machine.js";

const root = resolve(import.meta.dirname, "../..");
// Independent table transcribed from the selected machine contract. A test
// computed with the production arithmetic would not distinguish a bad formula.
const CCP_BASES = [
  0xe500, 0xe400, 0xe300, 0xe200, 0xe100, 0xe000, 0xdf00, 0xde00,
];
let disk;
beforeAll(async () => {
  disk = await readFile(resolve(root, "third_party/cpm22/cpm22.img"));
});

describe("named two-MiB resident placements", () => {
  it("enumerates exactly the canonical n01 through n16 identities", () => {
    expect(TWO_MIB_PROFILE_IDS).toEqual(
      Array.from(
        { length: 16 },
        (_, i) => `triptych-cpu-v0.1-2m-n${String(i + 1).padStart(2, "0")}`,
      ),
    );
    expect(Object.isFrozen(TWO_MIB_PROFILE_IDS)).toBe(true);
    for (const suffix of ["00", "17", "1", "001", "-1", "1.0", "16 ", "16\n"]) {
      expect(() => targetProfile(`triptych-cpu-v0.1-2m-n${suffix}`)).toThrow(
        /unknown target profile/,
      );
    }
  });

  for (let index = 0; index < 16; index++) {
    const id = `triptych-cpu-v0.1-2m-n${String(index + 1).padStart(2, "0")}`;
    it(`builds, enters, returns and enforces the COM ceiling for ${id}`, async () => {
      const expectedBase = CCP_BASES[Math.floor(index / 2)];
      const target = targetProfile(id);
      expect(target).toEqual({
        id,
        ccp: expectedBase,
        bdos: expectedBase + 0x800,
        bios: expectedBase + 0x1600,
        end: expectedBase + 0x1a00,
      });
      expect(Object.isFrozen(target)).toBe(true);
      const [ccp, bdos, bios] = await Promise.all([
        assembleProfiledFile(resolve(root, "src/ccp.asm"), id),
        assembleProfiledFile(resolve(root, "src/bdos.asm"), id),
        assembleProfiledFile(resolve(root, "test/fixtures/test-bios.asm"), id),
      ]);
      expect([ccp.base, bdos.base, bios.base]).toEqual([
        target.ccp,
        target.bdos,
        target.bios,
      ]);
      expect([ccp.bytes.length, bdos.bytes.length, bios.bytes.length]).toEqual([
        2048, 3584, 1024,
      ]);
      expect(ccp.labels.CCPENT).toBe(target.ccp);
      expect(ccp.labels.STKTOP - ccp.labels.STKBASE).toBe(48);
      expect(bdos.labels.STKTOP - bdos.labels.STKBASE).toBe(64);
      expect(ccp.labels.STKTOP).toBeLessThanOrEqual(target.bdos);
      expect(bdos.labels.STKTOP).toBeLessThanOrEqual(target.bios);
      expect(ccp.labels.STKTOP - 2).toBeGreaterThan(0xe400);
      expect(target.bdos).toBeGreaterThan(0xe400);

      // The fixture BIOS deliberately retains its one-drive IBM 3740 geometry.
      // These executions qualify resident placement and the CCP ABI; sixteen
      // drives/two-MiB geometry are separately exercised through the BIOS double.
      for (const extra of [0, 128]) {
        const program = new Uint8Array(target.ccp - 0x100 + extra).fill(0x5a);
        program[0] = 0xc9; // RET through the CCP's incoming 0000 return word.
        const machine = new PortableCpmMachine({
          ccp: ccp.bytes,
          bdos: bdos.bytes,
          bios: bios.bytes,
          disk: installCpm22File(disk, { name: "LIMIT.COM", bytes: program }),
          profileId: id,
        });
        machine.runUntilOutputSuffix("\r\nA>");
        expect([...machine.readRam(6, 2)]).toEqual([
          (target.bdos + 6) & 255,
          (target.bdos + 6) >>> 8,
        ]);
        const before = machine.exportDisk();
        machine.enqueueAscii("LIMIT\r");
        if (extra === 0) {
          let entered = false;
          for (let steps = 0; steps < 20_000_000; steps++) {
            if (machine.cpuState().pc === 0x100) {
              entered = true;
              break;
            }
            machine.step();
          }
          expect(entered).toBe(true);
          expect(machine.cpuState().sp).toBe(ccp.labels.STKTOP - 2);
          expect(machine.readRam(machine.cpuState().sp, 2)).toEqual(
            new Uint8Array(2),
          );
          expect(machine.readRam(0x100, program.length)).toEqual(program);
          machine.step();
          expect(machine.cpuState().pc).toBe(0);
          expect(machine.cpuState().sp).toBe(ccp.labels.STKTOP);
          machine.runUntilOutputSuffix("\r\nA>", 20_000_000);
        } else {
          expect(machine.runUntilOutputSuffix("\r\nA>", 20_000_000)).toContain(
            "LIMIT?",
          );
        }
        expect(machine.exportDisk()).toEqual(before);
        machine.enqueueAscii("DIR README.TXT\r");
        expect(machine.runUntilOutputSuffix("\r\nA>")).toContain(
          "README   TXT",
        );
        expect(machine.readRam(ccp.labels.STKGUARD, 16)).toEqual(
          new Uint8Array(16).fill(0xa5),
        );
      }
    }, 30_000);
  }
});
