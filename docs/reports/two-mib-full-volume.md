# Two-MiB guest full-volume proof

Date: 2026-09-07. The focused seven-case suite and complete repository check
passed with the released BDOS source unchanged. The test is committed at
`b5341be7b384a580198315c1f59b3eac7072e739`.

The new case in [the sixteen-drive test](../../test/bdos/two-mib-sixteen-drive.test.ts) writes 16,000 records
through BDOS function 21 on drive P. These records occupy all 1,000 available
2,048-byte data blocks: 2,048,000 usable bytes in a 2,097,152-byte image. Each
128-byte record contains its record number and a deterministic payload. The
test compares every physical record after its write and checks each newly
allocated word-sized block number, including blocks 255, 256 and 1,015. The
final physical record is 16,383.

After CLOSE, the allocation vector is full. MAKE and CLOSE of another empty
file still succeed, leaving 897 free directory entries. The count includes
125 populated extents, the empty extent created by the successful final write's
eager rollover, and the separate empty file. Full-volume failure is therefore
distinct from directory exhaustion. Further allocation for either file returns
status 2 with every disk hash, allocation vector, affected FCB and sector-write
count unchanged.

Only the saved image is copied into a fresh CPU and BIOS-double instance. RESET
and OPEN reconstruct the full allocation vector from the directory; the test
does not seed that vector. All 16,000 sequential reads reproduce their exact
payloads, followed by EOF. A renewed allocation attempt fails safely. Deleting
the large file frees all data blocks, and a new file reuses blocks 16 and 17
with verified replacement contents. Other drives and P's reserved records stay
unchanged. The reused harness checks return PC, caller SP, resident code,
stack bounds and memory guards on every BDOS call.

## Identity and measurements

The baseline is Portable CP/M `d28fc52774c967d1422b3b814d51c069247504c1`,
version 0.1.4, with ATOM pinned to
`802b5c2d320bec777f427755ff2d7338e3b80a05`. The test assembles the default
3,584-byte BDOS at EC00 through the existing ATOM helper. No production source,
toolchain lock or release artifact changes are required.

| Item                   | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `src/bdos.asm`         | `ed58617ff3055700d38a112014f5720ae0ac338d098d4cf3d26aab6b33233946` |
| Assembled default BDOS | `52f481e90cf12c4610db1609f7d4247ff3b00eb31705fca06a52701a3723714e` |

The measured focused invocation reported:

| Phase                                       | BDOS calls | Instructions | Sector writes | Data reads | Peak private stack bytes |
| ------------------------------------------- | ---------: | -----------: | ------------: | ---------: | -----------------------: |
| Fill, close and rejection                   |     16,008 |   18,992,019 |        16,252 |          0 |                       14 |
| Fresh reopen, readback, rejection and reuse |     16,026 |   10,949,053 |           145 |     16,000 |                       16 |

The new case took 8,731 ms during that invocation, with another verification
run active. This is elapsed test time on macOS with Node 24.18.0, not an
isolated benchmark or an ESP32 timing result. The full seven-case focused
suite passed. Reproduction:

```sh
npx vitest run test/bdos/two-mib-sixteen-drive.test.ts --reporter=verbose
```

The implementation worktree and captured logs are under
`/tmp/portable-cpm-full-volume.L4Cc9H/`; `focused-measurement.log` contains the
reported counters. Those local paths are temporary evidence locations.

`npm run check` passed the ATOM-only guard, type checking, formatting, all
403 tests in 21 files and the release build. The test phase took 143.71 seconds.
The full-check log SHA-256 is
`d4e63d4d1cccef4d16f641613fc0f12770d90522e2a98e4c454717a28955dd65`;
the focused measurement log SHA-256 is
`11ef0ccd7a6fba08c11642a0e4a0536839775214c8510ab1e5029d1b2107f6c4`.

## Qualification boundary

This proof executes the real ATOM-assembled BDOS through its public call entry,
with an in-memory BIOS double supplying sixteen DPHs and independent media.
It closes the guest full-volume allocation and readback gap for this geometry.
Triptych's machine BIOS, native/WASM persistence, browser backup/recovery and
physical ESP32 storage each require their separate integration evidence.
The test fills P, with fifteen other inserted disks checked for isolation; it
does not fill all sixteen volumes or qualify every resident placement.

The lead and a separate read-only reviewer checked the new test, reused
per-call guards, BDOS allocation and extent paths, and captured counters.
Neither found an unresolved actionable issue in this proof's stated scope.
