# Standalone extraction checkpoint

Date: 2026-09-05.

The original CCP and BDOS implementation history has been filtered from the
Triptych repository into this standalone project. `src/ccp.asm` and
`src/bdos.asm` retain their relevant commits while moving out of the misleading
`roms/cpu/` path. Triptych's BIOS and bootstrap were deliberately excluded.

The first independent gate uses the external Debug80 Runtime only as a Z80 test
harness. It assembles the production BDOS with ATOM revision
`802b5c2d320bec777f427755ff2d7338e3b80a05`, runs 99 direct-call, BIOS-double,
failure and randomized filesystem tests, and builds both fixed-size resident
artifacts twice to prove deterministic bytes.

An independent ATOM-built test BIOS now exercises the portable CCP and BDOS on
the Z80 runtime without importing Triptych's BIOS. Fifteen transcript scenarios
cover the command surface, parser and loader boundaries, file mutations and
recovery. Separate tests prove the 48-byte CCP stack boundary and a warm boot
after a rejected BIOS write. A Buffer-isolation regression proves that guest
writes cannot change the caller's source disk or another session. The complete
repository gate contains 120 tests.

The initial `triptych-cpu-v0.1` output is:

| Component | Origin  | Entry   | Bytes | SHA-256                                                            |
| --------- | ------- | ------- | ----: | ------------------------------------------------------------------ |
| CCP       | `$E400` | `$E400` | 2,048 | `d5f90f3c7cac8ad902ab4224e9f09ba344a8d30bee63dc7622d7fd1db65b2476` |
| BDOS      | `$EC00` | `$EC06` | 3,584 | `c5fc4d7dd29bf8914c4735165747e3b35dca3b8999a9f70035d972ff602718fc` |

These are host-model results, not ESP32 measurements. The retained CP/M disk is
black-box compatibility evidence under its recorded grant, not implementation
source. The standalone gate currently checks transcripts and selected output
files; it does not replay the retained terminal snapshots or Triptych disk
digests. Generated parser fuzzing, the full failure corpus, self-assembly and
alternate resident placement still need standalone qualification before the
first OS release. Triptych's existing integration proofs retain that evidence
in the meantime.

Verification command: `npm run check`.
