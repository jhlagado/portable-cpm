export interface InstallCpm22FileOptions {
  name: string;
  bytes: Uint8Array;
  padByte?: number;
}

export function installCpm22File(
  image: Uint8Array,
  options: InstallCpm22FileOptions,
): Uint8Array;
export function readCpm22File(image: Uint8Array, name: string): Uint8Array;

