# Portable CP/M

Portable CP/M is an independently maintained, open-source Z80 operating-system
layer compatible with the documented CP/M 2.2 interfaces. It currently owns
an original CCP and BDOS written for the ATOM assembler.

The project deliberately does not own a production BIOS. A machine supplies
its own BIOS implementation behind the documented call boundary; the tests use
a small in-memory BIOS double. Triptych is the first consumer and keeps its BIOS
and bootstrap in the Triptych repository.

## Current target profile

The first compatibility profile retains the placement required by Triptych:

- CCP: origin `$E400`, capacity 2,048 bytes;
- BDOS: origin `$EC00`, entry `$EC06`, capacity 3,584 bytes;
- BIOS call table: origin `$FA00`, 17 standard jump entries.

These addresses are a target profile, not an ownership claim. The portable
behavior is defined by the contracts in `docs/specifications/`.

## Development

Requires Node.js 20 or newer.

```sh
npm ci
npm run check
```

`npm run check` assembles the replacement BDOS with the pinned ATOM revision,
runs the direct-call, randomized filesystem and CCP scenario contracts through
the external Debug80 Z80 runtime, checks formatting and type safety, and rejects
accidental historical-assembler imports. Debug80 Runtime is a development
harness only.

The retained disk under `third_party/cpm22/` is black-box compatibility
evidence governed by its accompanying provenance and grant. It is not source
for this implementation.

## History

The CCP, BDOS, contracts, tests and reports were extracted from Triptych with
their relevant Git history. Their final authority is this repository once the
first independent release has passed and Triptych consumes that immutable
release.
