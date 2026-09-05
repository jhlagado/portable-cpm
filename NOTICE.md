# Provenance

The original CCP and BDOS implementations, their contracts and their tests
were authored in the Triptych repository and extracted here with relevant Git
history. Project-owned code is distributed under GPL-3.0-or-later.

The historical CP/M components in `third_party/cpm22/cpm22.img` are retained
as black-box compatibility evidence under the CP/M grant and provenance recorded
beside it. No historical
CCP or BDOS source was copied, translated or used as implementation input.

ATOM is the required assembler and remains a separately maintained GPL-3.0-only
project. `@jhlagado/debug80-runtime` is an optional development test harness;
production binaries do not depend on it.

Guest self-assembly uses the separately authored ATOM.COM carried on that disk,
not a historical CP/M assembler. The test-only retargeting helper is extracted
from Triptych and checks the 15,029-byte artifact's SHA-256 before changing its
output-address descriptor and adapter immediates. Its pinned input digest is
`cdd5d05e3131b23288914b354929cfb5c2e1639d71c35f337e8fcec8c2bdfcbb`.
This is a compatibility test tool, not the host build's ATOM release.

The assembly test BIOS adapts Triptych's GPL-3.0-or-later BIOS to test-only
ports. It is a test fixture; Triptych retains its production BIOS. The test
fixture therefore exercises a different host adapter, but is not evidence of
an independently designed second production BIOS.
