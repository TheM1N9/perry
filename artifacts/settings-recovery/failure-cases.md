# Daily settings recovery

Inventory before extending verification:

- A quiet-hours save response overwrites a newer value being typed in another segment.
- Saving quiet hours races a daily-limit update and restores the old limit, or vice versa.
- Rapid toggle changes commit out of order or erase unrelated notification settings.
- A failed save loses the draft, shows false success, or offers no usable retry.
- Invalid/same start and end times return a generic internal error instead of repair guidance.
- A pristine second tab does not follow confirmed changes; a dirty control is overwritten by an unrelated query refresh.
- Navigation during save or unmount leaves late updates, timers or subscriptions behind.

Use the production build and real HTTP/SQLite handlers in a fresh home/browser profile. Embeddings are deterministic in the test process; no runner, account, model download or paid service is started. Each run emits a result JSON and failure screenshot. Stop all owned processes and remove disposable homes after recording evidence.
