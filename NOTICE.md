# Provenance

The original CCP and BDOS implementations, their contracts and their tests
were authored in the Triptych repository and extracted here with relevant Git
history. Project-owned code is distributed under GPL-3.0-or-later.

`third_party/cpm22/cpm22.img` is retained only as black-box compatibility
evidence under the CP/M grant and provenance recorded beside it. No historical
CCP or BDOS source was copied, translated or used as implementation input.

ATOM is the required assembler and remains a separately maintained GPL-3.0-only
project. `@jhlagado/debug80-runtime` is an optional development test harness;
production binaries do not depend on it.
