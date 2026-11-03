# Tandem visual system

All values live in `src/styles/tokens.css`. Components use the tokens, not raw values.

## What changed in the refinement, and why

| Problem in the dusk-glass version | Change |
| --- | --- |
| Blue on many ordinary controls, glowing gradient Run button | Blue is kept for the primary action, focus, selection and the active item. Run is a flat fill with no glow. |
| Wallpaper competing with the interface | The wallpaper is blurred, darkened and desaturated; panels are near-black glass, and the editor is the most solid. |
| Separate panels with no clear order | Four floating glass panels with one hierarchy: the editor is the most solid, files, results and assistant are lighter. |
| Sparkle icons used as decoration | Replaced with icons that name the action: file diff for review, message-plus for "Ask AI", wrench for fixes. |
| Mixed icon sizes (11–18 px) and stroke weights | 16 px in buttons and rows, 18 px in the toolbar, 14 px beside 12 px metadata. One stroke weight (1.75) set in CSS for every Lucide icon. |
| Accept and Reject both in the editor and in the assistant | They live only in the review bar above the code. The assistant card explains the change and shows "Review in editor" or "Reviewing in the editor". |
| Letter "T" in a glass square | A geometric mark: a T with a second, half-tone stem. One colour, readable at 16 px. |
| Pill tabs, glow shadows, tinted chat bubbles | Underlined tabs, quiet neutral fills, one shadow scale. |

Kept: the dark workspace, the layout and panel behaviour, rounded geometry, the wallpaper (default dusk, plain, or the person's own image), and every workflow.

## Materials

The wallpaper sits behind everything, blurred (10px), darkened (74% brightness, plus a soft vignette) and desaturated (70%). Panels are near-black glass over it.

Four controls in `tokens.css` tune every panel at once:

| Control | Default | What it does |
| --- | --- | --- |
| `--glass-tint` | `14, 16, 21` | Panel colour (near-black, slightly cool) |
| `--glass-opacity-work` / `--glass-opacity` / `--glass-opacity-float` | 0.74 / 0.60 / 0.74 | How much of the wallpaper shows through |
| `--glass-blur` | 24px | Backdrop blur |
| `--glass-border-opacity` | 0.09 | 1px white edge; `--glass-highlight-opacity` (0.07) sets the inner top highlight |

| Level | Used for | Opacity |
| --- | --- | --- |
| 1 Workspace | Editor | 0.74, the most solid, for readability |
| 2 Panels | Files, results, assistant | 0.60 |
| 3 Floating | Menus, popovers, dialogs, toasts | 0.74 of a lighter tint |

The ⋯ menu has a **Glass** setting (Clear, Balanced, Solid) that swaps these values. Browsers without backdrop blur fall back to near-solid panels.

Inside panels, grouped content sits on inset cards (`rgba(255,255,255,.03)`, 1px edge at 6%, radius 10): chart figures and metrics in the results, the starter list and each Tandem reply in the assistant. A proposed change is the last section of its reply card, not a card inside a card.

## Colour

- Neutrals: backdrop `#0B0C10`; glass tint `rgb(14,16,21)`, raised tint `rgb(30,33,41)`; solid fallbacks `#16191F`, `#1B1E24`, `#242831`.
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

- Interface 13/18, metadata 12/16, badges 11/14, assistant replies 13/20, dialog titles 15/22. Weights 400, 500 and 600 only.
- Code in JetBrains Mono.
- Spacing steps 4, 8, 12, 16, 24, 32. Controls 26, 28 and 30 px high; rows 28 px; headers 40 px; panel gap 8 px.
- Radii: 5 (small controls), 7 (buttons, rows), 10 (cards), 12 (floating surfaces), 14 (panels).

## Motion

Hover 150 ms, press 170 ms, menus and popovers 200 ms, panels 260 ms. Menus fade in with a 3 px rise and a slight scale from their anchor. Nothing loops except the running spinner. With reduced motion, all durations are 0.
