import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assembleProfiledFile,
  targetProfile,
} from "../../tools/lib/target-profiles.mjs";
import {
  installCpm22File,
  readCpm22File,
} from "../../tools/lib/cpm22-disk.mjs";
import { PortableCpmMachine } from "../support/portable-cpm-machine.js";

const root = resolve(import.meta.dirname, "../..");
const profileId = "test-low-memory-v1";
const profile = targetProfile(profileId);
let ccp, bdos, bios, disk, labels;
beforeAll(async () => {
  const [c, b, bi, d] = await Promise.all([
    assembleProfiledFile(resolve(root, "src/ccp.asm"), profileId),
    assembleProfiledFile(resolve(root, "src/bdos.asm"), profileId),
    assembleProfiledFile(
      resolve(root, "test/fixtures/test-bios.asm"),
      profileId,
    ),
    readFile(resolve(root, "third_party/cpm22/cpm22.img")),
  ]);
  ccp = c.bytes;
  bdos = b.bytes;
  bios = bi.bytes;
  disk = d;
  labels = c.labels;
  expect([c.base, b.base, bi.base]).toEqual([0xc400, 0xcc00, 0xda00]);
});

function boot(image = disk, writable = true) {
  const machine = new PortableCpmMachine({
    ccp,
    bdos,
    bios,
    disk: image,
    profileId,
    writable,
  });
  machine.runUntilOutputSuffix("\r\nA>");
  return machine;
}
function command(machine, input, suffix = "\r\nA>") {
  machine.enqueueAscii(input + "\r");
  return machine.runUntilOutputSuffix(suffix, 20_000_000);
}

describe("named resident profiles", () => {
  it("rejects unknown profiles instead of silently using the default", () => {
    expect(() => targetProfile("missing")).toThrow(/unknown target/);
    expect(() => targetProfile("constructor")).toThrow(/unknown target/);
  });

  it("preserves the qualified default binary bytes", async () => {
    for (const [component, expected] of [
      [
        "ccp",
        "e74d61f096f6c9de01d77cd990a3255c4f0d46d771992a5e54b7993ed51fe18b",
      ],
      [
        "bdos",
        "02956431e3af849d99eecbffbb89a0c7a29487f91301575d1dd511127ab4d43b",
      ],
    ]) {
      const built = await assembleProfiledFile(
        resolve(root, `src/${component}.asm`),
      );
      expect(createHash("sha256").update(built.bytes).digest("hex")).toBe(
        expected,
      );
    }
  }, 15_000);

  it("runs file operations and reopens the saved disk at the lower placement", () => {
    const machine = boot();
    expect(command(machine, "SMOKE")).toContain("Wrote RESULT.TXT");
    expect(command(machine, "REN RENAMED.TXT=RESULT.TXT")).not.toContain("?");
    const saved = machine.exportDisk();
    const result = readCpm22File(saved, "RENAMED.TXT");
    expect(result.length).toBe(128);
    const reopened = boot(saved);
    expect(command(reopened, "DIR RENAMED.TXT")).toContain("RENAMED  TXT");
    expect(readCpm22File(reopened.exportDisk(), "RENAMED.TXT")).toEqual(result);
    expect(command(reopened, "ERA RENAMED.TXT")).not.toContain("?");
    expect(command(reopened, "DIR RENAMED.TXT")).toContain("NO FILE");
  });

  it("recovers from a failed BIOS write through the relocated warm boot", () => {
    const machine = boot(disk, false);
    const before = machine.exportDisk();
    expect(
      command(machine, "SAVE 1 BAD.COM", "Bdos Err On A: Bad Sector"),
    ).toContain("Bad Sector");
    command(machine, "");
    expect(command(machine, "DIR README.TXT")).toContain("README   TXT");
    expect(machine.exportDisk()).toEqual(before);
    expect([...machine.readRam(6, 2)]).toEqual([6, 0xcc]);
  });

  it("rejects SAVE at the first resident page and accepts the last transient page", () => {
    const machine = boot();
    const firstInvalid = profile.ccp / 256;
    const before = machine.exportDisk();
    expect(command(machine, `SAVE ${firstInvalid} BAD.COM`)).toContain(
      `${firstInvalid}?`,
    );
    expect(machine.exportDisk()).toEqual(before);
    expect(command(machine, `SAVE ${firstInvalid - 1} GOOD.COM`)).not.toContain(
      "?",
    );
    expect(readCpm22File(machine.exportDisk(), "GOOD.COM")).toHaveLength(
      profile.ccp - 0x100,
    );
  });

  for (const extra of [-128, 0, 128]) {
    it(`checks the relocated loader limit at ${extra} bytes from capacity`, () => {
      const program = new Uint8Array(profile.ccp - 0x100 + extra);
      program.set([0xc3, 0, 0]); // JP 0: exercise warm reload after a successful load.
      const machine = boot(
        installCpm22File(disk, { name: "LIMIT.COM", bytes: program }),
      );
      const output = command(machine, "LIMIT");
      if (extra > 0) expect(output).toContain("LIMIT?");
      else expect(output).not.toContain("?");
      expect(command(machine, "DIR README.TXT")).toContain("README   TXT");
      expect(
        machine.readRam(labels.STKGUARD, labels.STKGUEND - labels.STKGUARD),
      ).toEqual(new Uint8Array(16).fill(0xa5));
    });
  }
});
