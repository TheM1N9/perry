# Spreadsheet attachment coordinates

Verified on Windows on 2026-11-27 with the maintained native attachment journey:

```shell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/guest-files/run.mjs node_modules/.cache/sparse-workbook-fixed
```

The journey passed all 26 cases. The sparse workbook goes through the real WhatsApp receive handler, SQLite Runtime, runner claim, attachment preparation and Codex input formatter. Every record and file is synthetic; the network is replaced at the existing fixture boundary and no model is called. The fixture closes its runtime and removes its temporary home on exit.

The original extractor joined only cells present in the XML. A sheet with Name, Country and Price in A1/B1/C1 and values Alice/100 in A4/C4 became `Name\tCountry\tPrice\nAlice\t100`, moving the price under Country and losing the row gap. The fixed output retains `A4: Alice\tC4: 100`. It labels cell positions rather than allocating blank rows or columns.

Coverage includes shared and inline strings, numeric cached values, explicit gaps, omitted cell and row coordinates, a self-closing empty row, an explicit cell row when the row index is omitted, and the far corner XFD1048576. The sparse output stays below 1,500 characters. The normal extracted-text limit still produces an explicit truncation marker. Invalid columns, rows and inconsistent row/cell indices produce unread-attachment notes, retain the originals, and do not block the following valid text file. XML number/date formatting and formula calculation are outside this change; cached values are unchanged.

A process-local module loader restored only the previous `sheets()` function from Git HEAD while leaving the remaining production extraction code and fixture unchanged. That baseline failed the sparse incoming-workbook check and malformed-coordinate check, plus the dense workbook's updated addressed-output expectation. All 26 cases pass with the fixed function. The earlier direct in-memory `officeText()` replay also reproduced the shifted-column output before any edit.

Generated reports live under `node_modules/.cache/sparse-workbook-baseline` and `node_modules/.cache/sparse-workbook-fixed`; the maintained fixture and this verification record are the reproducible evidence.

Automatic approval review rejected removal of those two report directories with `blocked by policy`. Their reports remain; no alternative deletion mechanism was attempted. The native fixture's temporary homes were removed normally, and both test processes exited.

The coordinator repeated all 26 cases with the integrated candidate. Automatic review also blocked removing its `node_modules/.cache/integration-sparse-workbooks` report; the fixture home was removed and its process exited.
