import type { CpuStateSnapshot } from "@jhlagado/debug80-runtime/z80/runtime";

import { createDebug80TestHarness } from "./debug80-runtime.js";

const MEMORY_BYTES = 0x10000;
const CCP_BASE = 0xe400;
const CCP_BYTES = 0x0800;
const BDOS_BASE = 0xec00;
const BDOS_BYTES = 0x0e00;
const BIOS_BASE = 0xfa00;
const BIOS_BYTES = 0x0400;
const RECORD_BYTES = 128;

const SERDATA = 0xe0;
const SERSTAT = 0xe1;
const DSKSTAT = 0xe8;
const DSKDRIVE = 0xe9;
const DSKREC0 = 0xea;
const DSKDATA = 0xee;
const CMDREAD = 1;
const CMDWRITE = 2;
const CMDFLUSH = 3;
const DSKREADY = 2;
const DSKERROR = 4;

export interface PortableCpmMachineOptions {
  ccp: Uint8Array;
  bdos: Uint8Array;
  bios: Uint8Array;
  disk: Uint8Array;
  writable?: boolean;
}

/** Runs CCP and BDOS through an ATOM-built test BIOS and byte-level host I/O. */
export class PortableCpmMachine {
  readonly #disk: Uint8Array;
  readonly #runtime;
  readonly #memory: Uint8Array;
  readonly #input: number[] = [];
  readonly #output: number[] = [];
  readonly #writable: boolean;
  readonly #diskAddress = new Uint8Array(4);
  #diskDrive = 0;
  #diskStatus = 0;
  #diskMode: "idle" | "read" | "write" = "idle";
  #diskBuffer = new Uint8Array(RECORD_BYTES);
  #diskCursor = 0;
  #diskOffset = 0;

  constructor({
    ccp,
    bdos,
    bios,
    disk,
    writable = true,
  }: PortableCpmMachineOptions) {
    assertLength(ccp, CCP_BYTES, "CCP");
    assertLength(bdos, BDOS_BYTES, "BDOS");
    assertLength(bios, BIOS_BYTES, "test BIOS");
    if (disk.length === 0 || disk.length % RECORD_BYTES !== 0) {
      throw new Error("disk must contain whole 128-byte records");
    }
    this.#disk = Uint8Array.from(disk);
    this.#disk.set(ccp, 0x0000);
    this.#disk.set(bdos, 0x0800);
    this.#disk.set(bios, 0x1600);
    this.#writable = writable;

    const harness = createDebug80TestHarness();
    this.#runtime = harness.createRuntime({
      read: (port) => this.#readPort(port & 0xff),
      write: (port, value) => this.#writePort(port & 0xff, value & 0xff),
    });
    this.#memory = this.#runtime.hardware.memory;
    this.#memory.fill(0);
    this.#memory.set(ccp, CCP_BASE);
    this.#memory.set(bdos, BDOS_BASE);
    this.#memory.set(bios, BIOS_BASE);
    const state = this.#runtime.captureCpuState();
    state.pc = BIOS_BASE;
    state.sp = 0xffff;
    state.halted = false;
    this.#runtime.restoreCpuState(state);
  }

  enqueueAscii(text: string): void {
    for (const byte of Buffer.from(text, "ascii"))
      this.#input.push(byte & 0x7f);
  }

  outputBytes(): Uint8Array {
    return Uint8Array.from(this.#output);
  }

  exportDisk(): Uint8Array {
    return this.#disk.slice();
  }

  readRam(address: number, length: number): Uint8Array {
    if (
      !Number.isInteger(address) ||
      !Number.isInteger(length) ||
      address < 0 ||
      length < 0 ||
      address + length > MEMORY_BYTES
    ) {
      throw new Error("RAM range is outside Z80 memory");
    }
    return this.#memory.slice(address, address + length);
  }

  cpuState(): CpuStateSnapshot {
    return this.#runtime.captureCpuState();
  }

  step(): number {
    return this.#runtime.step().cycles ?? 0;
  }

  runUntilOutputSuffix(suffix: string, maximumSteps = 1_000_000): string {
    const previousLength = this.#output.length;
    const expected = Buffer.from(suffix, "latin1");
    for (let count = 0; count < maximumSteps; count += 1) {
      this.step();
      if (
        this.#output.length > previousLength &&
        endsWith(this.#output, expected)
      ) {
        return Buffer.from(this.#output.slice(previousLength)).toString(
          "latin1",
        );
      }
    }
    const tail = Buffer.from(this.#output).toString("latin1").slice(-240);
    throw new Error(
      `step limit reached waiting for ${JSON.stringify(suffix)}: ${JSON.stringify(tail)}`,
    );
  }

  #readPort(port: number): number {
    if (port === SERSTAT) return this.#input.length === 0 ? 0 : 1;
    if (port === SERDATA) return this.#input.shift() ?? 0;
    if (port === DSKSTAT) return this.#diskStatus;
    if (port === DSKDATA) return this.#readDiskByte();
    return 0;
  }

  #writePort(port: number, value: number): void {
    if (port === SERDATA) {
      this.#output.push(value);
      return;
    }
    if (port === DSKDRIVE) {
      this.#diskDrive = value;
      return;
    }
    if (port >= DSKREC0 && port < DSKREC0 + 4) {
      this.#diskAddress[port - DSKREC0] = value;
      return;
    }
    if (port === DSKSTAT) {
      this.#startDiskCommand(value);
      return;
    }
    if (port === DSKDATA) this.#writeDiskByte(value);
  }

  #startDiskCommand(command: number): void {
    if (command === CMDFLUSH) {
      this.#diskMode = "idle";
      this.#diskStatus = 0;
      return;
    }
    if (command !== CMDREAD && command !== CMDWRITE) {
      this.#diskStatus = DSKERROR;
      return;
    }
    const record =
      (this.#diskAddress[0] ?? 0) +
      (this.#diskAddress[1] ?? 0) * 0x100 +
      (this.#diskAddress[2] ?? 0) * 0x10000 +
      (this.#diskAddress[3] ?? 0) * 0x1000000;
    const offset = record * RECORD_BYTES;
    if (
      this.#diskDrive !== 0 ||
      offset < 0 ||
      offset + RECORD_BYTES > this.#disk.length ||
      (command === CMDWRITE && !this.#writable)
    ) {
      this.#diskMode = "idle";
      this.#diskStatus = DSKERROR;
      return;
    }
    this.#diskOffset = offset;
    this.#diskCursor = 0;
    this.#diskMode = command === CMDREAD ? "read" : "write";
    this.#diskBuffer =
      command === CMDREAD
        ? this.#disk.slice(offset, offset + RECORD_BYTES)
        : new Uint8Array(RECORD_BYTES);
    this.#diskStatus = DSKREADY;
  }

  #readDiskByte(): number {
    if (this.#diskMode !== "read" || this.#diskStatus !== DSKREADY) return 0;
    const value = this.#diskBuffer[this.#diskCursor] ?? 0;
    this.#diskCursor += 1;
    if (this.#diskCursor === RECORD_BYTES) {
      this.#diskMode = "idle";
      this.#diskStatus = 0;
    }
    return value;
  }

  #writeDiskByte(value: number): void {
    if (this.#diskMode !== "write" || this.#diskStatus !== DSKREADY) return;
    this.#diskBuffer[this.#diskCursor] = value;
    this.#diskCursor += 1;
    if (this.#diskCursor === RECORD_BYTES) {
      this.#disk.set(this.#diskBuffer, this.#diskOffset);
      this.#diskMode = "idle";
      this.#diskStatus = 0;
    }
  }
}

function assertLength(
  bytes: Uint8Array,
  expected: number,
  label: string,
): void {
  if (bytes.length !== expected) {
    throw new Error(`${label} must contain exactly ${expected} bytes`);
  }
}

function endsWith(output: number[], suffix: Uint8Array): boolean {
  if (suffix.length > output.length) return false;
  const start = output.length - suffix.length;
  return suffix.every((byte, index) => output[start + index] === byte);
}
