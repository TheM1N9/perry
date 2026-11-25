# Audio-player browser lifecycle inventory

Record before adding the integration fixture. Use the production AudioPlayer,
React, Chromium's media element and AudioContext, and an isolated loopback HTTP
server. Instrument only resource boundaries and serve synthetic WAV data.

- Two mounted players sharing one URL download/decode twice.
- Removing one player cancels the waveform still needed by the other.
- Removing the final pending player keeps the fetch, decode context or timer
  alive; remounting reuses aborted work instead of retrying.
- A chunked response without Content-Length exceeds 25 MB and is decoded.
- An oversized declared response is downloaded/decoded rather than rejected.
- A failed HTTP response or malformed audio leaves a poisoned cache entry;
  remounting cannot recover after the server is corrected.
- Finished cached waveforms are decoded again on back navigation.
- A source change shows the previous file's waveform or allows a late response
  from the previous source to overwrite the current player.
- Decode completion and abort paths leave AudioContext instances open.
- Temporary server/browser/bundler outputs survive the run or a failure omits
  a machine-readable result.
