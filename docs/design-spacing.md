# Spacing and layout

The dashboard and site use Tailwind 4's existing spacing scale, where one step is 4 CSS pixels. Use named scale utilities already in the project. The attention map uses the equivalent `--space-1`, `--space-2`, `--space-3`, `--space-4` and `--space-6` variables because it is standalone HTML. Native meeting and dismissal windows use CSS pixel values from that same scale.

## Choose by relationship

| Relationship | Spacing | Existing implementation |
| --- | --- | --- |
| Icon/text micro alignment | 2–6px | `gap-0.5`, `gap-1`, `gap-1.5`; metadata and icons |
| Label to input; input to helper/error | 8px | `Field` in `components/ui/field.tsx` |
| Related actions | 8px | dialog footer, approval decisions, inline button groups |
| Standard field to field | 16px | `FieldGroup`; a compact settings row may use 12px |
| Compact panel interior | 12px | `PopoverContent`, chat workspace and pet composer |
| Dialog, approval body and ordinary panel interior | 16px | `DialogContent`, `ApprovalCard`, chat Details |
| Menu item interior | 8px horizontally, 6px vertically | dropdown and select items; 32px trailing space holds the indicator |
| Page tab bar to content | 24px | Work, Apps & skills and meeting details use `Tabs className="gap-6"` |
| Settings section separation | 24px above and below the divider | `Section` inside `PageInPage variant="settings"`; the first section has no divider or top padding |
| Page title to body | 32px | `Page` header's `mb-8` |
| Standalone section separation | 40px | `Section` outside settings |
| Dashboard page gutters | 16px; 32px from `sm` | `Page`; note and Library detail wrappers use the same values |
| Chat content/composer gutters | 16px; 24px from `sm` | chat uses its own narrower reading column; both edges match |
| Marketing content gutters | 24px | all site sections, navigation and footer |
| Marketing section padding | 112px; 144px from `md` | main standalone sections; Hero, film and scrolling Day scenes have dedicated composition spacing |

Use the same relationship in loading, empty, filled and error states. Use `gap` for a flex/grid stack; do not combine a parent gap with a child margin for the same boundary. Prose margins and list separators are different relationships from control gaps.

## Use the component that owns the spacing

- A normal dashboard screen uses `Page`, with titled groups in `Section`. Embedded settings and app tabs use `PageInPage` so page gutters and titles are not added twice.
- Forms use `FieldGroup` → `Field` → label/input/description. A labelled native select or custom row uses `grid gap-2` and a shrinkable control (`min-w-0`); do not let its longest option set the page width.
- Dialogs use `DialogHeader` and `DialogFooter`. The default 16px padding and footer's matching negative margins belong together. An intentional full-bleed viewer may override them together. Headers reserve space for Close. Tall content scrolls inside a viewport with a 16px outer clearance.
- Search inherits the centered dialog placement. Ordinary popovers use Base UI's available-width constraint and 8px collision clearance. The note slash menu is an imperative DOM menu: it keeps 12px viewport clearance and clamps using its measured size, not a second hardcoded width/height.
- Alerts use `AlertAction` in layout flow. Actions wrap below the message on narrow screens. Do not position them absolutely and guess how much text padding they need.
- Page line tabs use a 24px root gap, without list bottom margins or panel top padding. Compact pill tabs, such as the pet's three tabs, keep their own smaller gap.
- Settings shows its secondary navigation from `lg`, when there is room beside the main sidebar. Smaller widths use the section switcher.

Current correct example, from Work:

```tsx
<Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-6">
  <TabsList variant="line" className="w-full justify-start overflow-x-auto border-b [&>button]:flex-none [&>button]:px-0">
```

The removed pattern below is incorrect: its margin adds to the root gap and makes this page's content start at a different distance.

```tsx
<Tabs>
  <TabsList variant="line" className="mb-5 ...">
```

## Keep these exceptions intentional

- Inline code padding uses `em`; checkbox baseline alignment uses `em` or small optical offsets. They must follow the text size, not the page grid.
- Chat, notes and the prompt editor have separate prose density rules in `app/globals.css`. Their paragraph/list/heading rhythm is deliberate, rather than a form's 8px gap. Do not apply interface stack spacing inside a document indiscriminately.
- Button variants, calendar cells, code blocks, bubble metadata, nested tree indents and compact work logs have their own internal geometry. Match peers of the same variant instead of making every control 16px padded.
- The site's Telegram phone/bubbles reproduce a different product's visual geometry. Their device bezel, timestamp clearance and bubble tail are not Perry page gutters.
- Film canvas coordinates, mascot SVG paths, force-graph positions, chart geometry and the attention map's reconstructed screen coordinates are drawing coordinates. Quantizing them as CSS padding would distort the illustration or data.
- Window positions, drag anchors, screenshot bounds and resize calculations are platform geometry. Native Electron menus use platform spacing.
- Safe-area insets, scrollbar clearance and viewport bounds are constraints. The chat composer keeps at least 16px below it and expands that clearance for a device's bottom inset.

Document a new exception by role and reason. A one-off number without a relationship is not an exception.

## Touch density

`app/globals.css` and `site/app/globals.css` provide coarse-pointer targets. Shared buttons, menu/select items and tab triggers reach 44px; compact checkbox/switch visuals use expanded hit areas. Reserve at least the expanded area between independent actions. Sidebars reserve separate columns for project actions, pill lists grow to fit their triggers, calendar cells use 44px and inline input-group addons remove vertical padding around their enlarged controls. Keep text inputs at 16px on touch devices, including tablets. Do not add a fixed parent height that clips these targets.
