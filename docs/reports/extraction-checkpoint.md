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
artifacts twice to prove deterministic bytes. One additional artifact test
brings the repository total to 100 tests.

The initial `triptych-cpu-v0.1` output is:

| Component | Origin  | Entry   | Bytes | SHA-256                                                            |
| --------- | ------- | ------- | ----: | ------------------------------------------------------------------ |
| CCP       | `$E400` | `$E400` | 2,048 | `d5f90f3c7cac8ad902ab4224e9f09ba344a8d30bee63dc7622d7fd1db65b2476` |
| BDOS      | `$EC00` | `$EC06` | 3,584 | `c5fc4d7dd29bf8914c4735165747e3b35dca3b8999a9f70035d972ff602718fc` |

These are host-model results, not ESP32 measurements. The retained CP/M disk is
black-box compatibility evidence under its recorded grant, not implementation
source. CCP whole-system scenarios remain to be adapted to an OS-local test BIOS
before the first immutable release and Triptych consumer migration.

Verification command: `npm run check`.
