# Tandem visual system

All values live in `src/styles/tokens.css`. Components use the tokens, not raw values.

## What changed in the refinement, and why

| Problem in the dusk-glass version | Change |
| --- | --- |
| Blue on many ordinary controls, glowing gradient Run button | Blue is kept for the primary action, focus, selection and the active item. Run is a flat fill with no glow. |
| Wallpaper visible behind code | The editor and results share one near-opaque panel (level 1). The wallpaper shows in the gaps, the toolbar and faintly through the side panels. |
| Four separate floating panels | Three: files, workspace (editor + results with a hairline between them), assistant. |
| Sparkle icons used as decoration | Replaced with icons that name the action: file diff for review, message-plus for "Ask AI", wrench for fixes. |
| Mixed icon sizes (11–18 px) and stroke weights | 16 px in buttons and rows, 18 px in the toolbar, 14 px beside 12 px metadata. One stroke weight (1.75) set in CSS for every Lucide icon. |
| Accept and Reject both in the editor and in the assistant | They live only in the review bar above the code. The assistant card explains the change and shows "Review in editor" or "Reviewing in the editor". |
| Letter "T" in a glass square | A geometric mark: a T with a second, half-tone stem. One colour, readable at 16 px. |
| Pill tabs, glow shadows, tinted chat bubbles | Underlined tabs, quiet neutral fills, one shadow scale. |

Kept: the dark workspace, the layout and panel behaviour, rounded geometry, the wallpaper (default dusk, plain, or the person's own image), and every workflow.

## Materials

| Level | Used for | Token |
| --- | --- | --- |
| 1 Workspace | Editor, results | `--surface-1` (97% opaque) |
| 2 Panels | Files, assistant | `--surface-2` (91%, blur 28px) |
| 3 Floating | Menus, popovers, selection actions, toasts, overlays on narrow screens | `--surface-3` (86%, blur 20px) + `--shadow-menu` |

Dialogs and tooltips use the solid level-3 colour so text is never read over moving content.

## Colour

- Neutrals: `--bg-app #101217`, workspace `#16191F`, panels `#1B1E24`, raised `#242831`.
- Text: primary `#ECEEF2`, secondary `#9CA3AF`, muted `#858B95` (4.8:1 on the workspace).
- Accent: `--accent #7895DB` for text, icons and indicators; `--accent-fill #5672BD` for primary buttons (white text, 4.6:1).
- Status colours are desaturated (`--success`, `--error`, `--warning`) and always appear with an icon or a word.

## Actions

| Level | Look | Examples |
| --- | --- | --- |
| Primary | `.btn-primary`, flat accent fill | Run, Accept, Send, Step |
| Secondary | `.btn-secondary`, neutral fill | Reject, Continue, Review in editor |
| Tertiary | `.btn-ghost` or `.icon-btn` | Back to editing, panel toggles, close, more |

One primary action per area. Panel toggles show their state with a brighter icon, not a filled box.

## Type and space

- Interface 13/18, metadata 12/16, badges 11/14, reading text in the assistant 14/21, dialog titles 15/22. Weights 400, 500 and 600 only.
- Code in JetBrains Mono.
- Spacing steps 4, 8, 12, 16, 24, 32. Controls 26, 28 and 30 px high; rows 28 px; headers 40 px; panel gap 8 px.
- Radii: 5 (small controls), 7 (buttons, rows), 10 (floating surfaces), 12 (panels).

## Motion

Hover 150 ms, press 170 ms, menus and popovers 200 ms, panels 260 ms. Menus fade in with a 3 px rise and a slight scale from their anchor. Nothing loops except the running spinner. With reduced motion, all durations are 0.
