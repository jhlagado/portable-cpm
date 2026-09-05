import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assembleProfiledFile,
  targetProfile,
  DEFAULT_PROFILE,
} from "./lib/target-profiles.mjs";

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
  const [packageManifest, lock] = await Promise.all(
    ["package.json", "package-lock.json"].map(async (name) =>
      JSON.parse(await readFile(join(repositoryRoot, name), "utf8")),
    ),
  );
  const revision =
    /^git\+https:\/\/github\.com\/jhlagado\/atom\.git#([0-9a-f]{40})$/.exec(
      packageManifest.devDependencies?.["atom-z80"],
    )?.[1];
  const lockedAtom = lock.packages?.["node_modules/atom-z80"];
  const lockedRevision =
    /^git\+(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)jhlagado\/atom\.git#([0-9a-f]{40})$/.exec(
      lockedAtom?.resolved,
    )?.[1];
  if (
    revision === undefined ||
    revision !== lockedRevision ||
    !lockedAtom?.integrity
  ) {
    throw new Error(
      "assembler package pin and lockfile must agree on an exact ATOM revision and integrity",
    );
  }
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
    version: packageManifest.version,
    targetProfile: profileId,
    atom: {
      repository: "https://github.com/jhlagado/atom",
      revision,
      packageIntegrity: lockedAtom.integrity,
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
