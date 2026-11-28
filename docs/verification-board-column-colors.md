# Board column colors

Needs you is amber, Working blue, Queued violet, Waiting slate, Failed red and Done green. A solid top edge, colored heading/count and quiet surface tint identify each column. Cards retain the normal reading surface. Existing labels, icons, focus indicators and native high-contrast behavior remain available, so color is an additional cue.

## Color declaration audit

All changes are scoped to Board data attributes in `app/globals.css`. Existing semantic colors and Tailwind's installed OKLCH palette are reused; the app palette is unchanged.

| Selector / declaration | Previous | Replacement | Purpose |
| --- | --- | --- | --- |
| Column `--board-accent` fallback | absent | `var(--muted-foreground)` | Safe neutral fallback within the existing theme |
| Column `background-color` | `bg-muted/35` | `color-mix(in oklab, var(--board-accent) 6%, var(--background))` | Distinct, restrained surfaces rather than identical gray lanes |
| Column `border` | `1px solid var(--border)` | `1px solid color-mix(in oklab, var(--board-accent) 25%, var(--border))` | Carry the column identity around its edge |
| Column `border-block-start` | `1px solid var(--border)` | `3px solid var(--board-accent)` | A clear scan marker independent of card density |
| Heading group `color` | normal heading ink; muted/warning/error icons | `var(--board-accent)` | Consistent state color across the heading and icon |
| Count `color` | `var(--muted-foreground)` | `var(--board-accent)` | Connect the count with its column |
| Count `background-color` | `var(--background)` | `color-mix(in oklab, var(--board-accent) 12%, var(--background))` | Separate the count while retaining text contrast |

Each state-specific `--board-accent` declaration was previously absent:

| Column | Light theme | Dark theme |
| --- | --- | --- |
| Needs you (`waiting`) | `var(--warning)` | Same semantic token, using its existing dark value |
| Working | `var(--color-blue-700)` | `var(--color-blue-300)` |
| Queued | `var(--color-violet-700)` | `var(--color-violet-300)` |
| Waiting (`blocked`) | `var(--color-slate-600)` | `var(--color-slate-300)` |
| Failed | `var(--destructive)` | Same semantic token, using its existing dark value |
| Done | `var(--success)` | Same semantic token, using its existing dark value |

`board.tsx` removes the superseded neutral background/border and icon/count color utilities, and marks the heading group with `data-column-heading`. No work-state or interaction logic changes.

## Verification

The existing native production replay passed all 15 journeys on build `632d3101-dfed-45ea-a211-fd55276f65f8`. It now measures actual browser-computed colors against the opaque surfaces they paint on, verifies six distinct accents/tints, and checks heading and count contrast in each theme. It uses Chrome's canvas color conversion before applying WCAG 2 luminance calculations.

| Column | Light heading | Light count | Dark heading | Dark count |
| --- | ---: | ---: | ---: | ---: |
| Needs you | 5.37:1 | 4.95:1 | 9.89:1 | 9.03:1 |
| Working | 6.25:1 | 5.70:1 | 10.08:1 | 9.24:1 |
| Queued | 6.65:1 | 6.05:1 | 9.88:1 | 9.07:1 |
| Waiting | 6.89:1 | 6.23:1 | 12.26:1 | 11.09:1 |
| Failed | 5.38:1 | 4.92:1 | 7.29:1 | 6.78:1 |
| Done | 4.98:1 | 4.58:1 | 9.99:1 | 9.14:1 |

All 24 measured text/surface pairs exceed 4.5:1. Desktop and phone screenshots were visually inspected after transitions settled. The replay reported no browser errors, no engine process, and successful disposal of its synthetic Perry home/profile/server. `pnpm build` and artifact TypeScript checks pass.
