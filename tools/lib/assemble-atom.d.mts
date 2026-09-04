export interface AtomAssemblyResult {
  bytes: Uint8Array;
  labels: Readonly<Record<string, number>>;
  base: number;
}

export function assembleAtomFile(source: string): Promise<AtomAssemblyResult>;
export function assembleAtomBinary(source: string): Promise<Uint8Array>;

