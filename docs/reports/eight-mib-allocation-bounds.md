# 8 MiB allocation bounds

Date: 2026-09-06. Release preparation for 0.1.2; publication is pending.

The BDOS correction in [src/bdos.asm](../../src/bdos.asm) checks allocation
references against the selected DPB's DSM before allocation-vector indexing or
block-to-record conversion. An out-of-range reference produces `Bad Sector`
and transfers through BIOS warm boot. Previously, directory references could
write beyond the allocation vector, and block 4096 could wrap the 16-bit record
calculation into the directory area.

## Qualified geometry and cost

The new tests use an exact 8,388,608-byte image geometry: SPT=128, OFF=1,
BSH=4, BLM=15, EXM=0, DSM=4087, DRM=511, AL0=FF, AL1=00 and CKS=0.
The 4,088 allocation blocks require a 511-byte allocation vector. System and
directory areas consume 16,384 bytes each, leaving 8,355,840 bytes for files.
Block 4087 ends at physical record 65535.

Compared with the 0.1.1 source at
`b07dad632e7ef3be6528289a5a35308983964b05`, the correction adds 22 resident
code bytes and no mutable workspace. The 64-byte private stack and 3,584-byte
BDOS slot are unchanged; padding falls from 116 to 94 bytes. Normal-return
tests check caller SP/PC restoration and resident-stack bounds. Cycle costs
were not measured in this qualification.

## Verification

The first focused run, before the source correction, had 20 failures and four
passes. The failures included missing fatal rejection and BIOS I/O issued for
invalid block references. The completed
[29-test suite](../../test/bdos/eight-mib.test.ts) passes. It covers actual
blocks 255, 256 and 4087; malformed references 4088, 4095, 4096 and 65535;
allocation-vector canaries; sequential and random I/O; extent transitions;
allocation at the last free block; disk-full rejection; function 40 zero-fill;
and random record 65535.

`npm run check` passes all 307 tests in 15 files, the ATOM-only source guard,
TypeScript checks, formatting and artifact generation. The default-profile
BDOS digest assertion was updated for the intentional code change. The CCP
binary remains unchanged.

An independent reviewer reran `npx vitest run test/bdos/eight-mib.test.ts
test/ccp/target-profile.test.mjs`: 37 tests passed in two files. These comprise
the 29 large-geometry tests and eight target-profile tests, including relocated
file operations, fatal-write recovery and loader boundaries. They overlap the
full suite and are not added to its 307-test total.

These are Z80 execution tests against a semantic BIOS double. They qualify the
named EXM=0 geometry and the checked corruption paths, not arbitrary DPBs,
nonzero EXM, every malformed-directory condition, a machine BIOS, browser
migration, multiple drives or ESP32 hardware. Consumers still require their
own image, BIOS and persistence qualification.
