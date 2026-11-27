# Markdown image loading

## Failure inventory before implementation

- Opening the latest 50 messages eagerly requests every historical Markdown image, even far outside the viewport. Native lazy loading must defer at least some distant images without relying on an exact browser-specific preload distance.
- A deferred image never loads after scrolling into view, loses its alt text, or fails native decoding.
- Registered local images lose their authenticated media URL, original path title, alt text or lazy/async attributes. An unregistered local path must remain inert text, never a filesystem URL request.
- Unsafe image schemes become active image URLs or execute script. The existing Markdown URL transformation must remain intact.
- Browser auto-scroll and zero intrinsic image size make all images appear near the viewport, creating a false deferral result. Fixture messages therefore contain substantial text spacing, and the test checks actual network requests as well as DOM attributes.
- Programmatic scrolling without reader input leaves Perry in follow-latest mode; an image's newly decoded height can then legitimately move the viewport back to the end. The history journey must first issue a native wheel gesture, as a person scrolling away from the latest reply would.
- A test uses the owner's home, credentials, microphone, model account or port. The journey must use a fresh synthetic SQLite home, independent loopback image/server ports and a disposable Chrome profile, then close and remove those resources.
- Startup, navigation or assertion failure loses the report or leaves a fixture child, HTTP server, database or profile behind. Every run writes a repeatable `result.json`; a completed browser journey also saves a screenshot. Temporary homes are removed in `finally`.

Run after a production build:

```shell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/markdown-images/run.mjs <output-directory>
```

The maintained journey seeds actual Perry chat messages and a registered local image, opens the production dashboard in native Chrome, counts requests to its loopback PNG destination, scrolls every historical image into view, and verifies local-path and URL safety behavior. No paid model or installed Perry data is used.

## Verification

Verified on Windows on 2026-11-27. The previous production build requested all 48 historical remote images at startup and failed exactly four loading-policy assertions. Local path registration, actual image loads, URL safety and browser-error checks passed in that baseline.

Production build `1480049f-7a13-4cce-b6c8-a1b7a343c462` passed all 11 checks. It initially requested 3 of the 48 remote images; scrolling through the history loaded all 48. The registered local image retained its authenticated media URL, original path title and alt text and loaded when visible. Unknown local paths and unsafe schemes stayed inert. There were no uncaught browser errors. Fixture servers, database, Chrome profile and temporary home were closed and removed.

The first fixed attempt correctly deferred image requests but used only programmatic scrolling. It stopped at image 13 when a decoded image changed layout and Perry's still-active follow-latest intent moved the reader back to the end. The completed journey issues a native wheel gesture before traversing history, matching a person leaving the latest reply. The initial-request measurement is taken before that gesture.

Automatic approval review rejected removal of the four task-owned `node_modules/.cache/markdown-images-*` report directories with `blocked by policy`. Their synthetic JSON, screenshots and bounded server logs remain. Temporary homes, the registered PNG files, browser profiles and fixture processes were removed normally; no alternate report-removal mechanism was attempted.
