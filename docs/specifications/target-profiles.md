# Resident target profiles

Build callers select a named profile; OS behavior remains in `src/ccp.asm` and
`src/bdos.asm`. The profile supplies a page-aligned CCP origin. The initial
format retains fixed, contiguous capacities: CCP 2,048 bytes, BDOS 3,584 bytes,
and a machine-owned BIOS reservation of 1,024 bytes. BDOS entry is six bytes
after its origin. BIOS calls use the standard three-byte jump-table offsets.

`triptych-cpu-v0.1` starts CCP at `$E400`; `test-low-memory-v1` starts it at
`$C400`. The latter is a host-test profile, not a new hardware claim. Neither
profile changes page zero, the `$0100` transient entry, disk geometry, or BDOS
function semantics. SAVE and transient loader bounds derive from the selected
CCP origin. The reserved regions must fit within the Z80 address space.

`triptych-cpu-v0.1-8m-ab` places CCP at `$E300`, BDOS at `$EB00` and the BIOS
call table at `$F900`, retaining the 2,048/3,584/1,024-byte component capacities.
Its COM load ceiling is `$E300` exclusive. The machine owns BIOS workspace and
any runtime lifetime overlap; this OS placement does not itself qualify two
drives, a physical board, or arbitrary transient-program stacks. Build artifacts
and manifests for this profile are distinct from the unchanged default profile.

The build prepends ordinary ATOM EQU statements to the portable source and
assembles that flat text. The same text can be installed on a guest disk for
self-assembly. This keeps guest assembly independent of host preprocessing.
Manifests identify the profile and record both original and prepared source
digests. Production BIOS ownership remains with the machine repository; the
local test BIOS alone consumes these constants in qualification tests.

Rejected alternatives: duplicated source trees would let behavior diverge;
binary relocation would need instruction-aware fixups and could miss address
constants; ad hoc text replacement of numeric literals would hide the contract.
Named constants make every placement dependency visible in assembly source.

`test-multi-drive-workspace-v1` is an unpublished diagnostic profile: CCP at
`$E300`, BDOS at `$EB00` with 3,840 bytes, and the test BIOS boundary still at
`$FA00`. It exists to execute the complete multi-drive candidate while its
production resident-size decision is open. It is not the default profile,
a qualified machine layout, or a format for rewriting existing system tracks.
The direct-call harness accepts it only when explicitly selected; frozen
oracle fixtures retain their original `$EC00` placement.

Verification requires default-profile byte identity, profile validation,
alternate-profile boot and command/file operations, warm-boot recovery, and
loader/SAVE bounds at the alternate resident boundary. This is not a claim of
compatibility with every possible BIOS or memory map.

## Two-MiB configured-drive family

`triptych-cpu-v0.1-2m-n01` through `triptych-cpu-v0.1-2m-n16` identify the
sixteen supported resident placements for Triptych's configured-drive design.
The two-digit suffix is required; aliases such as `n1`, `n001` and `n17` are
invalid. Existing profile identifiers and their assembled bytes are unchanged.

For configured count N, Triptych reserves `256 * ceil(N / 2)` bytes at the top
of RAM for allocation slots and alignment. Immediately below that reservation
are the 1,024-byte BIOS, 3,584-byte BDOS and 2,048-byte CCP. Portable CP/M's
`targetProfile()` derives all OS origins from that reservation; it returns the
same `{id, ccp, bdos, bios, end}` shape as older profiles. `end` is the end of
the BIOS reservation, not the end of guest RAM or of machine allocation state.
`TWO_MIB_PROFILE_IDS` is the frozen ordered inventory of this family.

| Suffix pair | CCP  | BDOS | BIOS | BIOS end, exclusive | COM load bytes |
| ----------- | ---- | ---- | ---- | ------------------- | -------------: |
| n01–n02     | E500 | ED00 | FB00 | FF00                |         58,368 |
| n03–n04     | E400 | EC00 | FA00 | FE00                |         58,112 |
| n05–n06     | E300 | EB00 | F900 | FD00                |         57,856 |
| n07–n08     | E200 | EA00 | F800 | FC00                |         57,600 |
| n09–n10     | E100 | E900 | F700 | FB00                |         57,344 |
| n11–n12     | E000 | E800 | F600 | FA00                |         57,088 |
| n13–n14     | DF00 | E700 | F500 | F900                |         56,832 |
| n15–n16     | DE00 | E600 | F400 | F800                |         56,576 |

The COM interval starts at 0100 and ends immediately before CCP. BDOS entry
remains its origin plus six. The 48-byte CCP stack and 64-byte BDOS stack stay
inside their respective artifacts. Each pair produces identical CCP/BDOS
binary bytes, because configured count affects machine tables rather than OS
behavior. The manifests retain different profile IDs; a machine must still
select the matching configured-count BIOS and bootstrap.

For example, this command builds the four-slot OS artifacts in a separate
output directory:

```sh
npm run build -- dist-2m-n04 triptych-cpu-v0.1-2m-n04
```

This operation generates CCP, BDOS and their manifest only. It neither builds
a machine BIOS nor opens or migrates a saved disk.

Qualification has two separate boundaries:

- `test/ccp/two-mib-target-profiles.test.mjs` assembles all sixteen placements,
  checks artifact and stack bounds, runs the exact COM load ceiling, observes
  entry SP and the saved return word, executes RET to 0000, checks command
  re-entry, and rejects a COM one 128-byte record too large. Its test BIOS
  retains the one-drive IBM 3740 geometry; these are OS-placement tests. The
  RET-only program leaves residents intact, so this case does not independently
  prove restoration of damaged resident bytes.
- `test/bdos/two-mib-sixteen-drive.test.ts` runs the existing BDOS at EC00
  through sixteen distinct DPHs/127-byte ALVs supplied by a BIOS double. It
  covers unclosed allocations across all drives, high mask bits, default P,
  allocation/address boundaries, a full 1,024-entry directory on P and
  [guest full-volume allocation/readback](../reports/two-mib-full-volume.md)
  through all 1,000 data blocks. It does not substitute for executing Triptych's
  new BIOS or for native/WASM storage qualification.

Release-artifact tests independently rebuild every named profile twice and
compare the emitted files and manifests. Triptych owns the full disk geometry,
configured-slot lifecycle, application workspace/stack compatibility, saved
media preservation and machine-specific tests. None of these OS target names
alone establishes a physical ESP32 result.
