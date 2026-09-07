# Portable CP/M

Portable CP/M is an independently maintained, open-source Z80 operating-system
layer compatible with the documented CP/M 2.2 interfaces. It currently owns
an original CCP and BDOS written for the ATOM assembler.

The project deliberately does not own a production BIOS. A machine supplies
its own BIOS implementation behind the documented call boundary; the tests use
a small in-memory BIOS double. Triptych is the first consumer and keeps its BIOS
and bootstrap in the Triptych repository.

## Target profiles

The first compatibility profile retains the placement required by Triptych:

- CCP: origin `$E400`, capacity 2,048 bytes;
- BDOS: origin `$EC00`, entry `$EC06`, capacity 3,584 bytes;
- BIOS call table: origin `$FA00`, 17 standard jump entries.

These addresses are a target profile, not an ownership claim. The portable
behavior is defined by the contracts in `docs/specifications/`.

The `test-low-memory-v1` profile places CCP at `$C400`, BDOS at `$CC00`
and the test BIOS at `$DA00`. It qualifies an alternate host-model layout,
not a physical board. Both profiles use the same portable sources.

The `triptych-cpu-v0.1-8m-ab` profile places CCP at `$E300`, BDOS at `$EB00`
and the BIOS call table at `$F900`, with the same component capacities. It
provides separately identified OS artifacts for Triptych's A/B integration.
The machine BIOS and application-stack lifetime qualification belong to
Triptych; selecting this profile alone does not establish those results.

The `triptych-cpu-v0.1-2m-n01` through `triptych-cpu-v0.1-2m-n16` family
supplies resident placements for Triptych's configurable two-MiB machine.
The suffix identifies one through sixteen configured drive slots. Odd/even
pairs share OS origins and binary bytes; their manifests retain distinct
profile identities for the corresponding machine BIOS and bootstrap. The
[target-profile contract](docs/specifications/target-profiles.md#two-mib-configured-drive-family)
lists the addresses and qualification boundaries.

## Development

Requires Node.js 20 or newer.

```sh
npm ci
npm run check
```

Build the default artifacts with `npm run build`. To select a different profile:

```sh
npm run build -- dist-low test-low-memory-v1
```

The output directory contains `ccp.bin`, `bdos.bin` and a manifest identifying
the profile, load addresses and source/binary digests. No production BIOS is
published here. Sources require the profile's EQU preamble; do not assemble
`src/ccp.asm` or `src/bdos.asm` without it. The build tool and guest self-assembly
test use the same prepared flat source. See
[target profiles](docs/specifications/target-profiles.md).

CI builds all sixteen two-MiB placements and retains their separate directories
in the `portable-cpm-triptych-2m` artifact. Each directory contains its own
`ccp.bin`, `bdos.bin` and `manifest.json`. This is ordinary CI retention;
permanent release assets and consumer pins require separate publication.

`npm run check` assembles the replacement BDOS with the pinned ATOM revision,
runs the direct-call, randomized filesystem and CCP scenario contracts through
the external Debug80 Z80 runtime, checks formatting and type safety, and rejects
accidental historical-assembler imports. Debug80 Runtime is a development
harness only.

The [8 MiB allocation-bounds report](docs/reports/eight-mib-allocation-bounds.md)
records the large-geometry tests, resident-byte cost and qualification limits.
The [multi-drive report](docs/reports/multiple-drive-bdos.md) records explicit
FCB drive selection, default-drive queries, complete allocation-vector reset,
and two-drive 8 MiB boundary tests.

The retained disk under `third_party/cpm22/` is black-box compatibility
evidence governed by its accompanying provenance and grant. It is not source
for this implementation.

## History

The CCP, BDOS, contracts, tests and reports were extracted from Triptych with
their relevant Git history. Their final authority is this repository once the
first independent release has passed and Triptych consumes that immutable
release.
