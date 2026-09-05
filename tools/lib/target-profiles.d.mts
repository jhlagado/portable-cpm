export const DEFAULT_PROFILE: string;
export interface TargetProfile {
  readonly id: string;
  readonly ccp: number;
  readonly bdos: number;
  readonly bios: number;
  readonly end: number;
}
export interface PreparedSource {
  profile: TargetProfile;
  original: string;
  prepared: string;
}
export function targetProfile(id?: string): TargetProfile;
export function prepareProfiledSource(
  source: string,
  id?: string,
): Promise<PreparedSource>;
export function assembleProfiledFile(
  source: string,
  id?: string,
): Promise<
  PreparedSource & {
    bytes: Uint8Array;
    labels: Readonly<Record<string, number>>;
    base: number;
  }
>;
export function assembleProfiledBinary(
  source: string,
  id?: string,
): Promise<Uint8Array>;
