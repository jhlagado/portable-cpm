# Multi-drive BDOS qualification

Date: 2026-09-06. Status: release candidate 0.1.3; not yet published.
The explicit-FCB-drive regression is fixed. The portable interface tests cover
two full-size drives; machine integration remains a separate gate.

## Login correction

The new interface tests use independently addressed BIOS tables, allocation
vectors and media for A and B. Before the correction, A/B/A selection cleared
the reservation for an open, unclosed A file. A second A file reused block 2
and replaced the first file's 37 payload with 6B. Both values are hexadecimal.

LOGIN now retains an already logged-in allocation vector while rescanning the
selected directory's counters. First login and an explicit drive reset rebuild
the vector. BIOS selection receives the normalized login hint, and reselection
after function 37 works even when that drive is already current. Selecting an
already logged-in current drive retains the existing no-I/O fast path.

The first login-only correction added 32 live bytes, no static workspace, and
preserved the 64-byte resident stack. That intermediate ATOM artifact occupied
the same 3,584-byte extent with 62 bytes of padding. Its SHA-256 was:
`05c751a600eff16e92a1413d9a6f2bcf4dc484b155f1a316cda6fb91a48a4112`.

Independent tests and review passed allocation preservation and reset/login
hints. Memory guards and actual return PC/SP are checked after every call;
the new populated-directory sequences used at most 12 resident stack bytes.
This is a measured workload, not a universal stack-depth bound.

The initial function-14 call in the disk-state fixture precedes its first reset.
The frozen oracle performs no BIOS calls there; the replacement now initializes
the drive with 98 calls. The original oracle fixture remains unchanged, and the
replacement-only test checks its separate complete trace. Subsequent reset
retains the existing 99-call trace.

## Explicit file-drive correction

Before this correction, an explicit B FCB opened A's same-named file and wrote
A. Independent tests then reproduced the same selection error in creation,
deletion, rename, attributes, search and random I/O. The fixtures distinguish
both directory allocation maps and data payloads on the two disks.

`DEFDRV` now stores the logical default, while `CURDRV` identifies the physical
drive and cached tables used by file operations. Dispatch-table entries are
resident-relative addresses with a high-bit FCB-selection marker. Selection
runs before each marked service, including its write-protection check. Search
Next and pure random-record conversion have no marker and do not interpret DE
as a new disk selection.

Two cached pointers identify the default drive's DPB and allocation vector.
Functions 27 and 31 therefore return default-drive addresses without changing
the active search buffer. Function 28 protects the logical default; subsequent
file writes test the target drive's protection bit. Reset invalidates login
state, and the next disk access rebuilds the selected vector. The supported
BIOS supplies stable resident tables and independent allocation vectors.

Restoring the default through LOGIN on every return was rejected: its directory
scan would replace the buffer needed by the next B search result. Caching the
default pointers also avoids extra BIOS selections for address queries.
Raw `?` searches now include all users and free entries through the final
directory slot; ordinary Search First clears S2.

## Allocation-vector reset correction

Independent reset tests exposed a separate flag error in the old clearing loop.
It computed the remaining-byte condition, then restored the earlier AF value
before branching. The restored zero flag ended the loop after one byte.
Directory reservation writes subsequently replaced the first two bytes, leaving
later allocation bits uncleared.

The corrected loop writes zero directly and branches on the remaining count.
Both full reset and selective reset/relogin tests first failed with bytes 2
through 30 still set to FF, then passed after the correction. They check the
entire vector, its guards and the other drive's unchanged vector.

## Resident accounting and verification

The complete semantics-first candidate occupied 3,620 live bytes, 36 beyond the
original slot. Correcting the clearing loop reduced that to 3,617. Independent
review then checked shared return and directory-initialization tails, equivalent
pointer/flag operations, and three unconditional tail calls. These changes
reduced the result to 3,581 live bytes within the original 3,584-byte extent.
The resident stack remains 64 bytes; padding is three bytes.

Relative to released 0.1.2, the result adds 91 live bytes: five bytes of static
state and 86 bytes of code. The dispatch table remains 82 bytes. No workspace
was moved into the caller, CCP, BIOS or host. Cycle differences have not been
benchmarked; file calls now perform a drive/login check before dispatch.

Current default-profile BDOS SHA-256:
`52f481e90cf12c4610db1609f7d4247ff3b00eb31705fca06a52701a3723714e`.

The final `npm run check` passes the ATOM-only guard, TypeScript, formatting,
all 359 tests in 17 files and the artifact build. This includes
23 adversarial drive cases at each of
two explicit placements: the production-size slot and the larger diagnostic
slot used during development. Each call checks the actual return or fatal
transfer, caller stack, resident stack floor, memory guards and disk effects.
The frozen compatibility fixtures remain unchanged.

The tests cover B-targeted file operations, same-record and cross-record search
continuation, raw scans, default-pointer queries, default-drive protection,
invalid/absent FCB drives, and reset/login behavior. Existing one-drive 8 MiB,
CCP, self-assembly and failure suites also pass. These are host-model results;
they do not qualify a dual-drive machine BIOS or physical ESP32 storage.

Six additional tests execute the production-size BDOS with two 8 MiB DPBs,
independent 511-byte allocation vectors and a shared directory buffer. They
check complete reset/reconstruction of both vectors, B's final record 65,535
against A's different payload, neighboring-record preservation, and word-sized
allocation at blocks 255, 256 and 4,087. For each allocation boundary, a seeded
near-full B vector leaves only the tested block free. A second file's write
then returns disk-full with both FCBs, both vectors and all disk records
unchanged. This is a boundary-state proof, not a sequential fill of two disks.
The measured peak stack use for these six cases is 16 of 64 bytes.
An independent reviewer reran all 52 new drive tests and checked fixture
address separation, deep-copy snapshots, failure comparisons and the combined
source changes; no actionable findings remained in this slice.

The subsequent named `triptych-cpu-v0.1-8m-ab` profile places CCP/BDOS at
E300/EB00 and its BIOS call boundary at F900. Two additional tests qualify
deterministic profiled artifacts, cold boot, exact COM load bounds and warm
reload through the independent test BIOS. The resulting complete gate passes
361 tests. This profile retains the original component capacities; it is
distinct from the larger diagnostic workspace used earlier.

## Remaining integration

The machine memory profile, dual-drive BIOS, A/B browser
selection, persistence/recovery and exact ATOM/NUC/Edit workflows still require
end-to-end tests. No new Portable CP/M release or Triptych deployment has been
published from this work.
