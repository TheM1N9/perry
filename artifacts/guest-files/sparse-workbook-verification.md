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

## XML attribute review follow-up

The extended native journey passes 28 cases. Before the follow-up, both added cases failed: JavaScript numeric conversion accepted exponent/hexadecimal row syntax, and valid single-quoted or spaced coordinate attributes were treated as omitted. Extraction now validates decimal row syntax before conversion and reads complete XML attribute tokens, preserving either quote style, XML character references, omitted-row inference and mixed formatting. Coordinate-like text inside another attribute and namespaced lookalikes cannot replace the unqualified coordinate.

Valid leading-zero and positive-sign row forms remain supported, following the [W3C unsignedInt lexical representation](https://www.w3.org/TR/xmlschema11-2/#unsignedInt). The [XML attribute-value syntax](https://www.w3.org/TR/xml/#NT-AttValue) permits both quote styles. The checks also exercise quoted workbook names, relationship targets and inline-string type attributes. Existing row/column bounds and honest failed-attachment handling remain unchanged.

```shell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/guest-files/run.mjs node_modules/.cache/sheet-xml-tokenized-final
```

Automatic approval review rejected cleanup of the new `node_modules/.cache/sheet-xml-*` reports with `blocked by policy`. Their fixture homes and processes were removed normally; no alternative removal mechanism was attempted.
