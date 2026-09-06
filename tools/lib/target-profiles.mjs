import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleAtomFile } from "./assemble-atom.mjs";

export const DEFAULT_PROFILE = "triptych-cpu-v0.1";
const ORIGINS = Object.freeze({
  "triptych-cpu-v0.1": 0xe400,
  "test-low-memory-v1": 0xc400,
  "test-multi-drive-workspace-v1": 0xe300,
});

export function targetProfile(id = DEFAULT_PROFILE) {
  if (!Object.hasOwn(ORIGINS, id))
    throw new Error(`unknown target profile ${id}`);
  const ccp = ORIGINS[id];
  // Diagnostic room for the complete multi-drive implementation. This is not
  // a production machine layout or permission to adapt an existing disk.
  const bdosBytes = id === "test-multi-drive-workspace-v1" ? 0xf00 : 0xe00;
  if (
    !Number.isInteger(ccp) ||
    ccp < 0x200 ||
    ccp % 256 !== 0 ||
    ccp + 0xc00 + bdosBytes > 0x10000
  ) {
    throw new Error(`invalid resident layout for ${id}`);
  }
  return Object.freeze({
    id,
    ccp,
    bdos: ccp + 0x800,
    bios: ccp + 0x800 + bdosBytes,
    end: ccp + 0xc00 + bdosBytes,
  });
}

export async function prepareProfiledSource(source, id = DEFAULT_PROFILE) {
  const profile = targetProfile(id);
  const original = await readFile(source, "utf8");
  const constants = {
    CCPBAS: profile.ccp,
    BDOSBAS: profile.bdos,
    BIOSBAS: profile.bios,
    BIOSEND: profile.end,
  };
  const preamble = Object.entries(constants)
    .map(([name, value]) => `${name} EQU $${value.toString(16).toUpperCase()}`)
    .join("\n");
  return { profile, original, prepared: `${preamble}\n${original}` };
}

/** Assemble flat ATOM source with an explicit named resident layout. */
export async function assembleProfiledFile(source, id = DEFAULT_PROFILE) {
  const input = await prepareProfiledSource(source, id);
  const temporary = await mkdtemp(join(tmpdir(), "portable-cpm-profile-"));
  try {
    const entry = join(temporary, "INPUT.ASM");
    await writeFile(entry, input.prepared);
    return { ...(await assembleAtomFile(entry)), ...input };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function assembleProfiledBinary(source, id = DEFAULT_PROFILE) {
  return (await assembleProfiledFile(source, id)).bytes;
}
