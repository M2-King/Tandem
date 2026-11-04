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

## Shell and materials

Everything sits in one application shell: a window inset 10px from the screen edge, radius 22px, a 1px white edge at 7% and one soft shadow. The shell barely tints the wallpaper (13, 16, 22 at 8%) and has no blur of its own, so the panels inside blur the wallpaper directly and it stays visible in the rail column, the gaps and the margin below the panels.

The default wallpaper is a sunset over a mountain lake seen from a wooden deck: warm light behind the mountain on the left, cool sky to the right, glints on the deck below. It is lightly blurred (3px) and slightly desaturated. A person's own image replaces it (⋯ menu → Wallpaper).

| Material | Used for | Tint (RGB) | Balanced opacity |
| --- | --- | --- | --- |
| Editor | Code | 34, 39, 52 (charcoal slate) | 0.86 |
| Panel | Files, results, assistant | 34, 38, 50 | 0.58 |
| Floating | Menus, popovers, dialogs, toasts | 40, 44, 57 | 0.87, blur +8px |

Every glass slab has the same finish:
- **Rim:** a 1px gradient edge, white at 20% along the top fading to 3.5% on the sides and 7% at the bottom, drawn as a masked pseudo-element so it follows the 16px corners.
- **Sheen:** white at 4% across the top 120px.
- **Shadow:** one soft drop (0 12px 32px, black at 20%).
- **Blur:** 28px backdrop blur with low saturation (115%) so warm light glows through without tinting text.

Only backgrounds are translucent; text and icons are never faded.

### Glass setting

One level from 0 (clearest) to 100 (most solid) drives all surfaces (`src/lib/glass.js`). The ⋯ menu offers Clear (15), Balanced (50, default) and Solid (90), plus a slider. The editor is always more opaque than the panels.

| | Clear | Balanced | Solid |
| --- | --- | --- | --- |
| Editor opacity | 0.79 | 0.86 | 0.94 |
| Panel opacity | 0.43 | 0.58 | 0.76 |
| Floating opacity | 0.82 | 0.87 | 0.93 |
| Blur | 32px | 28px | 23px |
| Wallpaper brightness | 1.01 | 0.95 | 0.88 |

Browsers without backdrop blur fall back to near-solid panels.

Inside panels, grouped content sits on inset cards (white at 4%, 1px edge at 7%, radius 12): chart figures and metrics, each Tandem reply, the project summary in Files. A proposed change is the last section of its reply card, not a card inside a card.

## Workspace components

| Component | Rules |
| --- | --- |
| Navigation rail | 52px wide, no container. 19px outline icons, muted grey; hover lifts to white; the selected item gets a soft blue tint. Files toggles the explorer; Charts and Runs open the results on that view (a dot marks new charts). Tooltips on the right. Hidden on phones, where the Files toggle returns to the toolbar. |
| File explorer | 30px rows. Every row has the same columns: disclosure arrow (blank for files), 16px icon, name; each level indents 18px, with a faint guide line inside folders. Selection is a neutral 8% white lift, not blue. "Collapse folders" appears on hover or focus. Arrow keys move between rows, Left/Right close and open folders, Home/End jump. |
| Editor tabs | One strip with a hairline under it, no separators. 28px tabs, radius 8; the open file is a 7.5% white lift. Close appears on the open or hovered tab. A grey dot marks a file edited from the sample. |
| Layout | Rail 52px; files 196px; assistant 380px; results 330px tall (never more than the space that leaves the editor 200px); 16px gaps; 16px right and 24px bottom margins inside the shell. |
| Editor | Charcoal surface; current line is a 2.4% white band with no border; line numbers #6B7282, current #C9CED8; 14px gutter spacing; 8px scrollbars. The debugger's current line is a 9% blue band with a 2px marker at the left. |

## Results

One glass surface with one header row: Output, Variables, Charts and Runs as pill tabs (Charts and Runs show counts), then the chart controls on the right (run number, figure 1/2, compare, Ask AI to modify, expand) and close. The chart sits directly on the panel glass with its title and legend in one line; only the metrics table gets a quiet inset surface beside it. Grid lines are white at 4.5%, the axis at 16%. Linear regression is blue circles (#6F95EC), the decision tree orange squares (#E8A352). The area adapts to its own width: under 620px it drops the counts, run label, compare and metrics so the chart keeps its room.

## Assistant states

| State | Layout |
| --- | --- |
| Empty | Title and one-line explanation; project context (project, open file, last run); three suggested actions as quiet rows; input at the bottom |
| Working | Reply card with live steps and Cancel |
| Review | Reply card with the change summary; "Reviewing in the editor" (Accept and Reject live above the code) |
| Completed | Only after the accepted change has actually run. A 20px "Analysis complete" heading with the run number, then sibling groups on quiet inset surfaces (what ran, metrics, insight) and next steps, open. The panel scrolls the heading into view. No per-message "Tandem" label; replies only get a header row when they show a status. |

## Colour

- Neutrals: backdrop `#0D1017`; glass tints as in Materials; solid fallbacks `#161A22`, `#1F2230`, `#272B37`.
- Text: primary `#ECEEF2`, secondary `#A3AAB7`, muted `#8A91A0`.
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
- Spacing steps 4, 8, 12, 16, 24, 32. Controls 26, 28 and 30 px high; file rows 30 px; headers 44 px; panel gap 16 px; shell inset 10 px, inner margins 16 px right and 24 px bottom (8 px on phones).
- Radii: 6 (badges, small icon buttons), 8 (editor tabs), 10 (buttons, rows, rail items), 12 (cards, floating surfaces), 16 (panels), 22 (the shell); pills for result tabs and Run, a circle for Send.

## Motion

Hover 150 ms, press 170 ms, menus and popovers 200 ms, panels 260 ms. Menus fade in with a 3 px rise and a slight scale from their anchor. Nothing loops except the running spinner. With reduced motion, all durations are 0.
