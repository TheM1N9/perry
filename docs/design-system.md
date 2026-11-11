# Perry interface rules

Perry uses quiet surfaces and compact controls around a readable conversation. The dashboard, desktop companion and public site share a spacing scale, with different density for their different jobs.

- [Spacing and layout](design-spacing.md): page gutters, sections, forms, menus, reading surfaces and permitted exceptions.
- [Spacing audit](spacing-audit.md): findings and verification for the November 2026 pass.
- [Coverage ledger](spacing-coverage.md): every maintained UI source reviewed in that pass.

Use the existing Tailwind utilities and components. Do not add a second styling system or replace a component's spacing with arbitrary values. Read the relevant component before overriding it; zero padding on a viewer or calendar is often intentional.

## Interaction hierarchy

- Keep Access in the composer; place model and thinking controls under Reply options. Explain immediate versus next-reply effects where each is chosen.
- Keep setup optional and collapsed on a new chat. A first useful text task takes precedence over personalization or enabling the desktop pet.
- Use Needs you for pending decisions, Tasks for executing work and Plan for a task's steps. Keep existing URL values stable.
- Use Allow once for one request, Always allow this rule for persistent permission and Apply change for a reviewed Brain proposal. Keep the request visible until acknowledgement.
- Blocking waits and failures need a complete reason and recovery action. Ordinary progress can stay quiet.
- Group the first task prompt with the composer. Preserve its position when suggestions become irrelevant. Show affected paths before a file approval; persistent permission belongs inside a collapsed explanation.
- Notification failure or uncertainty belongs in Needs you with the attempted text and a review destination. Never imply an unconfirmed external send was safely undone.
- Use global pause only with its scope explained. Local stop names the reply it affects.
- On coarse pointers, shared controls and the site's action buttons have 44px targets. Reserve surrounding space; never let larger targets overlap adjacent actions. Pill-tab lists grow to fit their children. Inputs stay at 16px.
- Panels close with Escape when their content owns the key, and return focus to their launcher. Nested popups and the live browser retain their own keyboard handling.
- Autosaved fields use a stable draft key scoped to the edited item and remount when that identity changes. Navigation uses the same serial drain as blur and explicit save. Failed drafts are recoverable in the current tab until acknowledged.
