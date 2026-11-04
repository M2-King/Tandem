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

Everything sits in one application shell: a window inset 10px from the screen edge, radius 22px, a 1px white edge at 8%, a faint top highlight and one soft shadow. The shell only tints the wallpaper (13, 16, 22 at 16%) and has no blur of its own, so the panels inside still blur the wallpaper directly. On phones the shell fills the screen with no edge.

The wallpaper is a secondary layer: gently blurred (4px), slightly darkened and desaturated, under a neutral cool shade. No vignette or other decorative lighting.

| Material | Used for | Tint (RGB) | Balanced opacity |
| --- | --- | --- | --- |
| Editor | Code | 30, 35, 47 (charcoal, cool undertone) | 0.93 |
| Panel | Files, results, assistant | 38, 42, 54 | 0.74 |
| Floating | Menus, popovers, dialogs, toasts | 44, 48, 61 | 0.88, blur +8px |

The brief's starting values (17, 20, 28 / 29, 33, 43 / 36, 40, 52) rendered about a third as bright as the golden reference, so the tints were raised part-way toward it while staying charcoal.

Every panel has a 1px white edge (`--glass-border-opacity` 0.08), an inner top highlight (`--glass-highlight-strength` 0.07) and one small shadow; only the shell casts a large one. Backdrop saturation is kept low (115%) so warm light doesn't tint the glass. Only backgrounds are translucent; text and icons are never faded.

### Glass setting

One level from 0 (clearest) to 100 (most solid) drives all surfaces (`src/lib/glass.js`). The ⋯ menu offers Clear (15), Balanced (50, default) and Solid (90), plus a slider. The editor is always more opaque than the panels.

| | Clear | Balanced | Solid |
| --- | --- | --- | --- |
| Editor opacity | 0.88 | 0.93 | 0.99 |
| Panel opacity | 0.61 | 0.74 | 0.88 |
| Floating opacity | 0.82 | 0.88 | 0.94 |
| Blur | 25px | 22px | 19px |
| Wallpaper brightness | 0.99 | 0.92 | 0.84 |

Browsers without backdrop blur fall back to near-solid panels.

Inside panels, grouped content sits on inset cards (white at 4%, 1px edge at 7%, radius 12): chart figures and metrics, each Tandem reply, the project summary in Files. A proposed change is the last section of its reply card, not a card inside a card.

## Workspace components

| Component | Rules |
| --- | --- |
| Navigation rail | 44px wide, no container. 19px outline icons, muted grey; hover lifts to white; the selected item gets a soft blue tint. Files toggles the explorer; Charts and Runs open the results on that view (a dot marks new charts). Tooltips on the right. Hidden on phones, where the Files toggle returns to the toolbar. |
| File explorer | 30px rows. Every row has the same columns: disclosure arrow (blank for files), 16px icon, name; each level indents 18px, with a faint guide line inside folders. Selection is a neutral 8% white lift, not blue. "Collapse folders" appears on hover or focus. Arrow keys move between rows, Left/Right close and open folders, Home/End jump. |
| Editor tabs | One strip with a hairline under it, no separators. 28px tabs, radius 8; the open file is a 7.5% white lift. Close appears on the open or hovered tab. A grey dot marks a file edited from the sample. |
| Editor | Charcoal surface; current line is a 2.4% white band with no border; line numbers #6B7282, current #C9CED8; 14px gutter spacing; 8px scrollbars. The debugger's current line is a 9% blue band with a 2px marker at the left. |

## Assistant states

| State | Layout |
| --- | --- |
| Empty | Title and one-line explanation; project context (project, open file, last run); three suggested actions as quiet rows; input at the bottom |
| Working | Reply card with live steps and Cancel |
| Review | Reply card with the change summary; "Reviewing in the editor" (Accept and Reject live above the code) |
| Completed | Only after the accepted change has actually run: what ran, metrics from the run, an insight computed from those metrics, next steps |

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
- Spacing steps 4, 8, 12, 16, 24, 32. Controls 26, 28 and 30 px high; file rows 30 px; headers 44 px; panel gap 12 px; shell inset 10 px and inner margin 12 px (8 px on phones).
- Radii: 6 (badges, small icon buttons), 8 (editor tabs), 10 (buttons, rows, rail items), 12 (cards, floating surfaces), 16 (panels), 22 (the shell); pills for result tabs and Run, a circle for Send.

## Motion

Hover 150 ms, press 170 ms, menus and popovers 200 ms, panels 260 ms. Menus fade in with a 3 px rise and a slight scale from their anchor. Nothing loops except the running spinner. With reduced motion, all durations are 0.
