import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleAtomBinary } from "../../tools/lib/assemble-atom.mjs";
import {
  installCpm22File,
  readCpm22File,
} from "../../tools/lib/cpm22-disk.mjs";
import { retargetCpm22Atom } from "../support/cpm22-atom-target.mjs";
import { PortableCpmMachine } from "../support/portable-cpm-machine.js";

const root = resolve(import.meta.dirname, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let ccp, bdos, bios, disk, source;
beforeAll(async () => {
  [ccp, bdos, bios, disk, source] = await Promise.all([
    assembleAtomBinary(resolve(root, "src/ccp.asm")),
    assembleAtomBinary(resolve(root, "src/bdos.asm")),
    assembleAtomBinary(resolve(root, "test/fixtures/test-bios.asm")),
    readFile(resolve(root, "third_party/cpm22/cpm22.img")),
    readFile(resolve(root, "src/ccp.asm"), "utf8"),
  ]);
});

describe("guest ATOM assembly of the resident CCP", () => {
  it("rejects an unqualified ATOM image", () => {
    const atom = readCpm22File(disk, "ATOM.COM");
    atom[0] ^= 1;
    expect(() =>
      retargetCpm22Atom(atom, { start: 0xe400, capacity: 0x800 }),
    ).toThrow(/provenance/);
  });

  it("retargets without modifying a caller-owned Buffer", () => {
    const atom = Buffer.from(readCpm22File(disk, "ATOM.COM"));
    const before = Buffer.from(atom);
    const derived = retargetCpm22Atom(atom, { start: 0xe400, capacity: 0x800 });
    expect(atom).toEqual(before);
    expect(sha256(derived)).toBe(
      "26cdac36f1cc94a62f8527d3e21125ae0f4de067196669275962196b9bcd2d4f",
    );
  });

  it("builds byte-identical CCP from source and retains it across reboot", () => {
    const atom = retargetCpm22Atom(readCpm22File(disk, "ATOM.COM"), {
      start: 0xe400,
      capacity: 0x800,
    });
    let prepared = installCpm22File(disk, { name: "ATCCP.COM", bytes: atom });
    prepared = installCpm22File(prepared, {
      name: "CCP.ASM",
      bytes: Buffer.from(source.replace(/\r?\n/g, "\r\n") + "\x1a", "ascii"),
      padByte: 0x1a,
    });
    const machine = new PortableCpmMachine({ ccp, bdos, bios, disk: prepared });
    machine.runUntilOutputSuffix("\r\nA>");
    machine.enqueueAscii("atccp ccp.asm ccp.bin\r");
    const transcript = machine.runUntilOutputSuffix(
      "CCP.BIN written\r\n\r\nA>",
      200_000_000,
    );
    expect(transcript).toBe(
      "atccp ccp.asm ccp.bin\r\r\n\r\nCCP.BIN written\r\n\r\nA>",
    );
    const saved = machine.exportDisk();
    expect(readCpm22File(saved, "CCP.BIN")).toEqual(ccp);
    // Boot the generated CCP, not merely the host-built copy, from the saved disk.
    const rebooted = new PortableCpmMachine({
      ccp: readCpm22File(saved, "CCP.BIN"),
      bdos,
      bios,
      disk: saved,
    });
    rebooted.runUntilOutputSuffix("\r\nA>");
    rebooted.enqueueAscii("DIR CCP.BIN\r");
    expect(rebooted.runUntilOutputSuffix("\r\nA>")).toContain(
      "A: CCP      BIN",
    );
    expect(readCpm22File(rebooted.exportDisk(), "CCP.BIN")).toEqual(ccp);
  }, 60_000);
});
