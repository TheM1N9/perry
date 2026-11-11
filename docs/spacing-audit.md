# Spacing audit

10 November 2026. Uses Emil's design-foundations, UI-polish, UI-review and design-system-docs skills.

## Scope and verification plan

Inventory every maintained UI source outside historical `artifacts/`, dependency folders and generated builds. Cover the dashboard route wrappers, screen components, shared controls, chat workspace, pet renderer and native HTML windows, marketing site, film canvas and the current attention map. Record source review separately from browser execution; do not present unvisited states as verified.

Before writing the browser checks, the spacing failure inventory is:

- Different gutters or title-to-content spacing on equivalent pages.
- Parent gaps stacking with child margins, including tabs and embedded screens.
- Labels, inputs, descriptions and validation changing their gap with child order.
- Action buttons overlapping alert text or dialog titles.
- Long dialogs or confirmations exceeding narrow or short viewports.
- Content, footer links, phone mockups or pet panels overflowing their container.
- Sticky headers or composers hiding the last row or focused control.
- Loading, empty, filled, error and expanded states changing alignment unexpectedly.
- Menus using different item insets for equivalent actions.
- The attention map's controls, sequence, legend or scrolling states drifting from the same scale.

Use a disposable home and synthetic content for browser verification. No connected account, model invocation, recording or real owner data is needed. Existing verification tools remain; temporary fixtures and outputs are removed after the results are recorded here.

## Scope covered

The [coverage ledger](spacing-coverage.md) records 181 maintained UI and template files, including files that delegate rendering and own no spacing. The initial screen inventory was expanded with imperative DOM menus and native templates discovered by repository-wide rendering searches. Every spacing declaration was inventoried by source group; no random sample was used for source coverage. The [design rules](design-spacing.md) document the values actually implemented and the reasons for density differences.

The application still uses Tailwind's native scale. A consistent system means equivalent relationships use equivalent spacing; it does not mean a calendar cell, prose paragraph, marketing hero and compact pet panel all get identical padding.

## Findings and fixes

| Before | After | Why |
| --- | --- | --- |
| Work, Apps and Meetings added different list margins or panel padding to the tab root gap. | All page line tabs use one 24px root gap, with no extra list margin or panel top padding. | Equivalent destinations start their content at the same distance from the tabs. |
| Line-tab padding, fixed height and an indicator below the box were mixed with local overrides. | Shared line tabs have a 44px minimum height, zero list padding and an indicator inside the bottom edge. | Content alignment and the selected underline stay within the tab bar. |
| Field groups used 20px; ordinary field gaps used 16px; helper spacing changed with `nth-last` negative margins. | Standard fields are separated by 16px; labels, controls, helpers and errors keep 8px between them. | Adding validation no longer changes a helper's spacing based on its child position. |
| Handwritten settings and transcription fields used 6px or no mobile label gap. | Their labelled rows use `grid gap-2`; the responsive identity grid has an explicit mobile gap. | Native and shared form controls follow the same relationship. |
| Settings' secondary navigation appeared at 768px, leaving too little space beside the main sidebar. | It appears from 1024px; smaller widths use the section switcher. | The first browser sweep reproduced horizontal overflow in General, Notifications and Desktop pet. |
| A transcription select's long option forced a 374px intrinsic width. | The form cells and native selects can shrink, with `min-w-0` and `w-full`. | The speech settings now fit a 320px viewport. |
| The first settings section kept its divider and top padding because a hidden heading preceded it. | The settings-only reset uses `first-of-type`. | The first section starts once, rather than adding a divider and another 24px inset after the switcher. |
| Alert actions were absolutely positioned, with 72px reserved for an unknown number of buttons. | Actions participate in the grid, wrap below the message on narrow screens and sit alongside it when space allows. | Multiple actions cannot cover the message. |
| General dialogs and confirmations lacked a common height constraint; headers could run behind Close. | They keep 16px viewport clearance, scroll tall content and reserve 32px for Close in ordinary headers. | Long forms remain usable at 390 by 500, including their footer actions. |
| Search explicitly started one-third down the viewport. | It inherits the shared centered dialog placement. | The overlay sweep reproduced Search extending below a 500px-high viewport. |
| The note link popover was 320px wide even on a 320px screen. | Shared popovers use Base UI's `--available-width`, with 8px collision clearance. | The library already calculates the safe available width; there is no custom resize state. |
| The note slash menu used a 10px item inset and clamped to duplicated 256/320px size assumptions. | It matches the 8px/6px menu inset, has explicit viewport limits and clamps using its actual rendered bounds. | A short viewport and changes in result count no longer invalidate its placement assumptions. |
| Dropdown and select items used different insets from command items. | Their main inset is 8px horizontal and 6px vertical, with an 8px icon gap. | Equivalent menu choices have the same density. |
| Popovers and sheets used different default header/body gaps. | Ordinary popovers use 12px padding/gap; sheet headings use an 8px text gap. | Shared primitives establish the pattern instead of each caller guessing it. |
| Input addons used custom 4.8px and 2.4px negative offsets. | They use the existing 4px and 2px scale utilities. | The same control alignment no longer depends on one-off decimal rem values. |
| Detailed rows and approval bodies used 14px vertical spacing while their peers used 16px. | Activity/computer detail rows, memory detail rows, shortcuts and approval bodies use 16px. | Peers with the same information density align. Compact rows retain their separate density. |
| Chat content had 16px mobile gutters while its composer had 12px; its landing height subtracted a guessed 16rem from the viewport. | The edges share 16px gutters; the landing uses native flex space instead of viewport subtraction. | The layout accounts for the actual composer, starters and startup alert rather than assuming their height. |
| Pet header and chat content used different interior edges. | Their shared content edge is 16px; the panel is also bounded by viewport width. | The companion's tabs align without expanding the native window. |
| Marketing Apps used a different desktop section pad, footer links could not wrap, and the Night phone was fixed at 320px. | Main section padding matches its peers, the footer wraps and the phone shrinks within the page gutter. | Narrow layouts fit while preserving the site's larger composition scale. |
| The native meeting and dismissal templates had isolated off-scale spacing values. | Their control gaps and text insets use the same 4px scale, with compact recording as an explicit variant. | Secondary windows are covered by the same review. |
| The attention map mixed 5, 6, 7, 9, 10, 11 and 14px layout values and smaller control targets. | Its surrounding UI uses named 4/8/12/16/24px tokens and 40px controls, rising to 44px for coarse pointers. | This task's own artifact follows the system too; drawing coordinates remain drawing coordinates. |
| The earlier UX audit claimed starter requests were missing. | The rendered review confirmed the existing starter chips; the audit and landing forecast now include them. | Verification corrected the report instead of preserving an inaccurate finding. |

## Verification

The first complete browser sweep produced 372 checks and four overflow failures. After correcting their causes and restarting the isolated backend with the fixtures loaded, the complete rerun passed 371 checks with no browser errors. Check counts can differ with the rendered fields; these are geometry and interaction assertions, not a percentage of user behavior covered.

- Visited 30 dashboard URLs at 320, 390, 768, 1280 and 1920px: new/existing chat, To-dos, meeting list/detail, Brain list/editor, Library list/detail, Work, Needs you, both Apps tabs, a project, all 14 Settings sections, Welcome and a missing page.
- Checked page gutters, displayed field gaps and document overflow. Exercised every Work and meeting-detail tab and measured a 24px list-to-panel gap.
- Walked the public site's top, Day, Night, Setup and footer at the same five widths; reviewed the film/Apps/Promise/Close sources and checked their containing page for overflow.
- Checked native meeting-notice markup at 390px and all six attention-map scenarios, including scrolling the forecast to its final checkpoint.
- A separate interaction run passed 19 checks: all four Work forms and their scroll-reachable footers at 390 by 500, a delete confirmation, the first Settings section, select item insets, mobile workspace bounds, the pet panel and each selected pet tab, and multi-action startup alerts in light/dark reduced-motion conditions.
- After replacing the guessed chat landing height, a focused run passed 30 checks across the five widths and three heights (500, 640 and 900), with and without the startup alert. The composer remained available and the document did not gain horizontal or outer-page overflow.

The overlay-specific rerun passed 16 checks for Search, the mobile sidebar and note-link popover at widths of 320/390/768 and heights of 320/500. The note slash menu then passed 12 checks across those same sizes, including real keyboard selection of Heading 1. These follow-ups cover the imperative menu discovered outside the `.tsx` inventory as well as the shared React overlays.

Final browser result: **448 assertions passed; no browser exceptions** across the successful complete sweep and focused follow-ups (371 + 19 + 30 + 16 + 12). The root and site production builds pass, root/backend TypeScript checks pass, and the pet main script passes Node's syntax check. These counts describe the stated checks, not every possible branch of the product.

The standalone map was also previewed with its actual theme variables at desktop and phone widths; its landing forecast now shows the existing starter prompts. Source hashes in the ledger identify the final reviewed snapshot. Screenshots and machine-readable reports were produced for each run, inspected, then removed with the disposable home and verification scripts as required by the project's agent rules. No unit tests or new dependencies were added.

To repeat the important checks without external accounts:

1. Build and run an isolated installation with a disposable `PERRY_HOME`, a synthetic dashboard key and model loading disabled. Create a project, note, to-dos, a chat with a long answer, a pending approval, a Library file and a completed meeting with transcript segments.
2. Visit the listed routes at each of the five widths. Compare computed page gutters (16px/32px), labelled field gaps (8px), page-tab gaps (24px) and document width. Keep the default, empty and filled states in the same column.
3. At 390 by 500, open each Work creation form and scroll to its footer. Confirm both the popup and the footer controls stay within the viewport. Open a delete confirmation and cancel it.
4. At 320/390/768 by 320/500, open Search, the mobile sidebar where applicable and the note Link control. Their actual rectangles must fit inside the viewport. Type `/` in the note editor, inspect the menu's 12px clearance, then choose Heading 1 with ArrowDown and Enter.
5. Open the chat workspace at mobile/desktop sizes and the pet's three tabs. Verify the selected tab, panel bounds and shared content edges. Repeat a startup alert in light and dark mode; its actions must not overlap its description.
6. Check new chat at 500/640/900px height, with and without a startup alert. When the intrinsic content fits, the landing should not create unnecessary scrolling. Exercise each attention-map activity, route-step control, layer toggle and scroll checkpoint.

## Limits and follow-up

The coverage ledger is exhaustive for maintained source files in the stated categories. Browser execution covers the routes and states above, not every possible dataset or account state. Real provider-connected screens, operating-system display scaling, macOS/Linux native windows, physical touch keyboards and screen-reader use still require their respective environments. Canvas/SVG art, Telegram mock geometry, typography-relative padding and platform window bounds were reviewed as intentional exceptions, not forced onto a page-padding grid.

The later [UI/UX implementation](ui-ux-implementation.md) fixes the pet activation issue found in this pass, adds shared coarse-pointer targets and rechecks the affected routes. The earlier 448 assertions describe the spacing snapshot; later implementation checks are recorded separately.


## Follow-up, 11 November

The current ledger includes 187 sources after adding the alternate-path attention map, vendored control CSS and four Riff sources integrated from main. It refreshes every source hash and spacing inventory after the follow-up changes. The latest 29-assertion browser replay covers new-chat grouping and stable composer position, approval paths and collapsed permission rules, notification review, browser-local privacy settings and editor compatibility. The original 448 assertions and 219-assertion UI pass retain their recorded scope and limits.


## Requested chat and sidebar adjustment

The current ledger covers 186 sources after removing the unused new-chat setup component. The landing greeting and headline are centered; helper/setup text is removed and centered starter prompts follow the composer. The footer uses the same 2px row gap as primary navigation, with 32px desktop rows and 44px touch rows. Pause has no extra wrapper padding or repeated scope sentence; its confirmation keeps the full explanation. Native browser checks cover alignment, wrapping, starter focus/position, footer geometry and pause confirmation/cancel. Requested screenshots are retained in `artifacts/layout-adjustments/`.
