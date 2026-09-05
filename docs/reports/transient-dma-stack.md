# Transient stack and default DMA correction

Baseline: `579657f9177b31e1fccf0c05f72ba2ee76f3d052`.
Assembler: ATOM revision `802b5c2d320bec777f427755ff2d7338e3b80a05`.
Target: Z80, `triptych-cpu-v0.1` resident profile.

The baseline CCP supplied transient programs with SP `$00FE` and a zero return
word at `$00FE..$00FF`. A valid default-DMA read writes all of `$0080..$00FF`,
including that return word. A program could restore its incoming SP correctly
and still return to disk data rather than warm boot.

The correction changes only the operand of `LD SP,TPA` to `STKTOP` immediately
before the warm-boot word is pushed. No live CCP call frame remains there:
`LOADCOM` and `PREPPAGE` have returned, and execution next jumps to the transient.
The existing 48-byte CCP stack can therefore supply the transient entry context.
Programs needing more than its 46 remaining bytes must establish a private stack.
Moving this context into the transient load area would remain unsafe for a
maximum-size program or application workspace.

## Failing-before and passing-after evidence

`test/ccp/transient-dma-stack.test.ts` assembles the independent
`test/ccp/programs/dma-return.asm` probe with ATOM. Four cases combine sequential
BDOS read (20) and random read (33) with either a saved/private stack or the
unchanged incoming stack. The data record ends with `$5A,$A5`.

Against the unchanged baseline, both private-stack cases read the complete
record successfully and reached the final `RET`, but the saved return word was
`$A55A` instead of zero. Both retained-stack cases failed to reach that `RET`
within one million instructions because the read also overwrote active call
state. These failures were recorded before the production edit.

After the correction all four cases pass. Each checks the successful open/read,
all 128 DMA bytes, original and restored SP, unchanged zero return word, the
actual `RET` transfer to PC zero, the next prompt, a subsequent `DIR DATA.BIN`,
and an unchanged disk. The 16-byte `$A5` guard is checked before warm boot can
reload it and again after the later command.

The retained-stack cases push 22 words (44 bytes), then call BDOS while those
words remain live. Together with the two-byte warm-boot word and two-byte call
return address this consumes all 48 bytes, with the guard intact. BDOS switches
to its own stack before making internal calls. The private-stack cases leave
only the two-byte warm-boot word in the CCP stack. These are measured paths,
not a guarantee for programs exceeding the documented allocation.

`npm run check` passes: the ATOM-only guard, TypeScript and formatting checks,
278 tests in 14 files, and the artifact build. This includes existing built-in
stack, lower-resident-profile, loader-limit, and guest ATOM self-assembly tests.

## Binary and workspace account

The resident image remains 2,048 bytes. Code-size delta, workspace delta,
generated-program delta and runtime-storage delta are all zero. Both operands
use the same three-byte `LD SP,nn` instruction, so this correction adds no
instructions or instruction timing cost to launch.

The guard remains `$EBAD..$EBBC`, stack storage `$EBBD..$EBEC`, and stack top
`$EBED`. Transient entry SP is now `$EBEB`. The corrected CCP SHA-256 is
`e74d61f096f6c9de01d77cd990a3255c4f0d46d771992a5e54b7993ed51fe18b`;
the baseline was
`d5f90f3c7cac8ad902ab4224e9f09ba344a8d30bee63dc7622d7fd1db65b2476`.
Earlier reports and retained scenarios describe their original checkpoints.

## Consumer qualification and release state

On 2026-09-06, the Triptych lead replayed the actual Edit-produced invalid
`GAME.NU` through released NUC 0.3.1. The disposable disk differed only in its
CCP bytes. The retained WASM and macOS native hosts both produced the exact
error 86 diagnostic followed by `A>`, ran the preserved game, quit to CP/M,
and executed a subsequent `TYPE` command. Five raw-transcript checkpoints
and the complete final disk matched between hosts.

The preserved `GAME.COM` SHA-256 was
`f9afbab3da0ce918cce2f8d17ef9b77a00e1216a8634f62295a884ba1875ca1a`.
The final disk SHA-256 was
`aeebef7e99ca9b1ee29d739d8ca517b0b6946d629b7975a50bbf762ddba45694`.
The local reproduction script is
`/tmp/triptych-browser-plan.nlKRrH/nuc-error-diagnosis/fixed-replay.mjs`.
This consumer test uses the actual Triptych BIOS; the permanent upstream
regressions use the portable test BIOS.

Two fresh independent reviewers examined the correction, contracts and
regressions and reported no actionable findings. These software gates are now
recorded as satisfied. The correction has not been released or consumed by
Triptych's pinned distribution. Release publication, pin/provenance updates
and a permanent full Edit/failed-compile consumer scenario remain next steps.
No Nucleus source change or ESP32 hardware result is included.
