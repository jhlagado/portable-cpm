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

Verification requires default-profile byte identity, profile validation,
alternate-profile boot and command/file operations, warm-boot recovery, and
loader/SAVE bounds at the alternate resident boundary. This is not a claim of
compatibility with every possible BIOS or memory map.
