# Portable CP/M repository guidance

This repository owns the portable CCP and BDOS implementation and their
guest-visible contracts. It must build and test without Triptych or Debug80
source checkouts.

- Use ATOM for every normal assembly, test and release path.
- AZM is historical only and must not be imported by production or test code.
- Keep machine-specific BIOS implementations in their machine repositories.
  This repository owns only the BIOS call contract and a test double.
- Treat retained CP/M material as black-box compatibility evidence under the
  recorded grant. Do not copy or translate historical CCP or BDOS source.
- Keep load addresses and capacities in named target profiles rather than in
  portable behavior.
- Run `npm run check` before handoff.
