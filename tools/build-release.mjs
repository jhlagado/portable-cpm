import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assembleProfiledFile,
  targetProfile,
  DEFAULT_PROFILE,
} from "./lib/target-profiles.mjs";

const ATOM_REVISION = "802b5c2d320bec777f427755ff2d7338e3b80a05";
const COMPONENTS = [
  {
    id: "ccp",
    source: "src/ccp.asm",
    file: "ccp.bin",
    capacity: 2048,
  },
  {
    id: "bdos",
    source: "src/bdos.asm",
    file: "bdos.bin",
    capacity: 3584,
  },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function buildPortableCpmArtifacts({
  repositoryRoot,
  outputDirectory,
  profileId = DEFAULT_PROFILE,
}) {
  const profile = targetProfile(profileId);
  await mkdir(outputDirectory, { recursive: true });
  const built = [];
  for (const template of COMPONENTS) {
    const origin = profile[template.id];
    const component = {
      ...template,
      origin,
      entry: origin + (template.id === "bdos" ? 6 : 0),
    };
    const sourcePath = join(repositoryRoot, component.source);
    const [source, assembled] = await Promise.all([
      readFile(sourcePath),
      assembleProfiledFile(sourcePath, profileId),
    ]);
    if (assembled.base !== component.origin) {
      throw new Error(
        `${component.id} assembled at $${assembled.base.toString(16)}, expected $${component.origin.toString(16)}`,
      );
    }
    if (assembled.bytes.length !== component.capacity) {
      throw new Error(
        `${component.id} emitted ${assembled.bytes.length} bytes, expected its ${component.capacity}-byte slot`,
      );
    }
    await writeFile(join(outputDirectory, component.file), assembled.bytes);
    built.push({
      ...component,
      bytes: assembled.bytes.length,
      sourceSha256: sha256(source),
      preparedSourceSha256: sha256(assembled.prepared),
      sha256: sha256(assembled.bytes),
    });
  }

  const manifest = {
    schema: "portable-cpm-artifacts-v1",
    version: "0.1.0",
    targetProfile: profileId,
    atom: {
      repository: "https://github.com/jhlagado/atom",
      revision: ATOM_REVISION,
    },
    components: built,
  };
  await writeFile(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
  return manifest;
}

const invokedPath =
  process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputDirectory = resolve(repositoryRoot, process.argv[2] ?? "dist");
  const manifest = await buildPortableCpmArtifacts({
    repositoryRoot,
    outputDirectory,
    profileId: process.argv[3] ?? DEFAULT_PROFILE,
  });
  console.log(JSON.stringify(manifest, undefined, 2));
}
