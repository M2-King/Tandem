# Tandem visual system

All values live in `src/styles/tokens.css`. Components use the tokens, not raw values.

## What changed in the refinement, and why

| Problem in the dusk-glass version | Change |
| --- | --- |
| Blue on many ordinary controls, glowing gradient Run button | Blue is kept for the primary action, focus, selection and the active item. Run is a flat fill with no glow. |
| Wallpaper competing with the interface | (Superseded) The wallpaper is now shown untouched; the glass adapts to it instead. |
| Separate panels with no clear order | Four floating glass panels with one hierarchy: the editor is the most solid, files, results and assistant are lighter. |
| Sparkle icons used as decoration | Replaced with icons that name the action: file diff for review, message-plus for "Ask AI", wrench for fixes. |
| Mixed icon sizes (11–18 px) and stroke weights | 16 px in buttons and rows, 18 px in the toolbar, 14 px beside 12 px metadata. One stroke weight (1.75) set in CSS for every Lucide icon. |
| Accept and Reject both in the editor and in the assistant | They live only in the review bar above the code. The assistant card explains the change and shows "Review in editor" or "Reviewing in the editor". |
| Letter "T" in a glass square | A geometric mark: a T with a second, half-tone stem. One colour, readable at 16 px. |
| Pill tabs, glow shadows, tinted chat bubbles | Underlined tabs, quiet neutral fills, one shadow scale. |

Kept: the dark workspace, the layout and panel behaviour, rounded geometry, the wallpaper (default dusk, plain, or the person's own image), and every workflow.

## Wallpaper and materials

**The wallpaper is never altered.** It is drawn exactly as chosen: no blur, tint, dimming or desaturation, and no full-window overlay. Everything that makes the interface readable is part of the glass. The default sunset image is only an example; it is painted soft in the SVG file itself, not by the app.

Panels float directly over the wallpaper with no window frame. Nothing sits on the bare wallpaper: the toolbar and the rail are small glass capsules of the panel material, so the chrome reads on any image.

### The material

Every glass surface uses the same recipe, at three densities:

| Layer | What it does |
| --- | --- |
| Frost | Backdrop blur (default 29px) with 135% saturation, so colour behind the glass glows through softly |
| Transmission | How much light passes through (backdrop brightness). 1.0 over dark wallpapers, down to 0.55 over very bright ones |
| Tint | Near-black, slightly cool |
| Grain | Fine noise at a few percent alpha: real frosted glass is never perfectly smooth, and grain stops blurred gradients banding |
| Reflection | A soft radial highlight from the top-left, where light enters, plus a faint top fade |
| Rim | A 1px gradient edge, white at 20% along the top fading to 3.5% on the sides, following the corners |
| Shadow | A tight contact shadow plus a soft ambient lift underneath |

| Material | Used for | Tint (RGB) | Balanced opacity |
| --- | --- | --- | --- |
| Editor | Code | 20, 24, 34 | 0.80 |
| Panel | Files, results, assistant, toolbar capsules, rail | 24, 28, 39 | 0.61 |
| Floating | Menus, popovers, toasts (dialogs 0.92) | 29, 32, 43 | 0.90, frost +10px |

Capsules draw their glass on a `::before` layer: an element with a backdrop filter traps the backdrop of anything inside it, which would leave menus opening from the toolbar unfrosted and stacked under the panels.

### Adapting to the wallpaper

When a wallpaper is chosen, Tandem measures its brightness once (a 32×32 sample, blending the mean with the 80th percentile so bright patches count). Over a bright image the glass gets denser and passes less light, and the faintest text steps up toward the secondary grey. Over a dark image nothing changes. Measured worst case (text over the brightest 10% of the glass behind it) on four test wallpapers (bright sky, near-white, saturated colour, near-black): secondary text 4.5:1 or better everywhere, code 11:1, comments about 4:1.

### Glass settings (⋯ menu → Glass)

Three presets and two sliders, all on the same variables (`src/lib/glass.js`):

- **Clear / Balanced / Solid** set Opacity to 15, 50 or 90.
- **Opacity** (Clear to Solid): how dense the glass is. The editor always stays denser than the panels.
- **Frost** (Light to Heavy): how strongly the glass diffuses what's behind it, 14px to 44px.

| At Balanced, dark wallpaper | Clear | Balanced | Solid |
| --- | --- | --- | --- |
| Editor opacity | 0.70 | 0.80 | 0.91 |
| Panel opacity | 0.45 | 0.61 | 0.79 |
| Floating opacity | 0.86 | 0.90 | 0.95 |

Browsers without backdrop blur fall back to near-solid panels.

## Workspace components

| Component | Rules |
| --- | --- |
| Navigation rail | A vertical glass capsule in a 62px column, aligned with the toolbar capsule. 19px outline icons, muted grey; hover lifts to white; the selected item gets a soft blue tint. Files toggles the explorer; Charts and Runs open the results on that view (a dot marks new charts). Tooltips on the right. Hidden on phones, where the Files toggle returns to the toolbar. |
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
