# Native file download replay

This replay starts Perry's production Next.js app with a new SQLite home and synthetic credentials. It uses the authenticated dashboard/backend routes, actual Chrome downloads, and Perry's Browser API against a local fixture website. No owner files, real accounts, phone messages or model turns are used.

Build the checkout, then run from the repository root with installed dependencies and Chrome available:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/file-downloads/run.mjs node_modules/.cache/file-downloads/current
```

The output directory is disposable. Each run writes incremental `result.json`, a bounded server log, a dashboard PDF-preview screenshot and native downloaded files under `downloads/`. The report records actual filenames, file sizes and SHA-256 hashes compared with the original synthetic files. The process exits nonzero for failed checks or failed cleanup.

The replay covers stored chat attachments, PDF previews, Library and workspace download names, Unicode and punctuation, long names, binary/large streamed files, range/HEAD responses, and missing/removed/unauthorized/other-runner controls. It also starts Perry's own headless browser, clicks a local PDF download, waits for its GUID file to be registered in the Library and downloads that file through Chrome. A legacy GUID image and stale workspace kind are seeded before the cold server starts, to verify existing data repair.

The first PDF download uses the actual chat attachment preview's Download link. Other downloads use Chrome anchors against the production route URLs. Completion waits for newly saved bytes matching the original hash, so an unrelated Chrome component download cannot be mistaken for the requested file; altered or missing bytes time out and fail the run. Filenames are asserted independently. PDF, XLSX, DOCX and ZIP fixture bodies use valid container structures. The replay verifies delivery and metadata, not Word/Excel desktop rendering or behavior on a physical phone.

Windows is the verified platform. `PERRY_E2E_BROWSER` can select a Chrome executable on another platform. All synthetic homes and owned processes are removed in `finally`; inspect the output evidence, then remove the disposable output folder. Keep the maintained replay and failure inventory.
