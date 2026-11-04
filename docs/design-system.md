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

## Structure and materials

**The wallpaper is never altered.** It is drawn exactly as chosen. Everything that makes the interface readable is part of the app's own glass. The default sunset is only an example (painted soft in its SVG file, not by the app).

The interface has three layers, each with one job:

| Layer | What it is | How it's made |
| --- | --- | --- |
| Window | One smoked-glass sheet holding the toolbar, rail and every pane. The only surface that frosts the wallpaper. | Backdrop blur 22px, saturation 165%, transmission (backdrop brightness) 0.88 over dark images down to 0.42 over bright ones, tint 13,15,21 at 0.49. Radius 24px. A dark 1px outer line, a light 1px inner line, a brighter top edge and one deep soft shadow. |
| Tool panes | Files and Assistant: lighter, raised glass for tools. | No blur of their own. White at 8.5% fading to 5%, a 1px inner hairline (7.5%) with a brighter top edge (11%), a small contact shadow. Radius 14px. |
| Content panes | Editor and Results: darker smoked glass for the document and what it produces. | No blur of their own. Near-black 8,10,15 at 0.55 with a faint top fade, the same hairline edges. |
| Floating | Menus, popovers, dialogs, toasts. | Their own frosted glass: blur 28px, tint 29,32,43 at 0.90, crisp border. |

Why this works:
- **Clean colour, no mud:** the window darkens what's behind it through transmission instead of laying grey over it, so warm light stays warm and doesn't turn brown.
- **Crisp, not soft:** only one layer blurs. Panes are plain translucent sheets, so there's never blur on top of blur.
- **Clear hierarchy:** tools are lighter and the document is darker, all inside one window. Edges are hairlines, not glows.

Menus inside the window keep their own frost because the window's glass is drawn on a `::before` layer: an element with a backdrop filter would trap the backdrop of everything inside it.

### Adapting to the wallpaper

When a wallpaper is chosen, Tandem measures its brightness once (a 32×32 sample, blending the mean with the 80th percentile so bright patches count). Over a bright image the window passes less light and gets denser, the document panes darken, and the faintest text steps up. Over a dark image nothing changes. Toolbar text, the only text sitting on the window glass alone, uses a brighter grey.

Measured worst case (text over the brightest 10% of what's behind it) on four test wallpapers (bright sky, near-white, saturated colour, near-black): secondary text 4.7:1 or better everywhere, code comments 5.3:1 or better.

### Glass settings (⋯ menu → Glass)

- **Clear / Balanced / Solid** set Opacity to 15, 50 or 90.
- **Opacity:** window tint 0.18 to 0.80 and document pane 0.34 to 0.82.
- **Frost:** window blur 8px to 36px.

Browsers without backdrop blur fall back to near-solid surfaces.

## Workspace components

| Component | Rules |
| --- | --- |
| Navigation rail | 56px column on the window glass, no container. 19px outline icons, muted grey; hover lifts to white; the selected item gets a soft blue tint. Files toggles the explorer; Charts and Runs open the results on that view (a dot marks new charts). Tooltips on the right. Hidden on phones, where the Files toggle returns to the toolbar. |
| File explorer | 30px rows. Every row has the same columns: disclosure arrow (blank for files), 16px icon, name; each level indents 18px, with a faint guide line inside folders. Selection is a neutral 8% white lift, not blue. "Collapse folders" appears on hover or focus. Arrow keys move between rows, Left/Right close and open folders, Home/End jump. |
| Editor tabs | One 44px header with a hairline under it, no separators; file type and length on the right ("Python · 64 lines"). 28px tabs, radius 8; the open file is a 7.5% white lift. Close appears on the open or hovered tab. A grey dot marks a file edited from the sample. |
| Layout | Window inset 10px from the screen; 52px toolbar; 56px rail; files 196px; assistant 380px; results 330px tall (never squeezing the editor below 200px); 10px between panes; 12px window padding. Every pane header is 44px, so headers line up across the window. |
| Editor | The darker document pane. The current line is marked only by its brighter line number (#C9CED8), with no band across the code; other line numbers #7A8190; comments #868D9A italic; 18px gutter spacing; 14px top and bottom padding; 8px scrollbars. The debugger's current line is a 9% blue band with a 2px marker at the left. |

## Results

One glass surface with one header row: Output, Variables, Charts and Runs as pill tabs (Charts and Runs show counts), then the chart controls on the right (run number, figure 1/2, compare, Ask AI to modify, expand) and close. The chart sits directly on the panel glass with its title and legend in one line; only the metrics table gets a quiet inset surface beside it. Grid lines are white at 4.5%, the axis at 16%. Linear regression is blue circles (#6F95EC), the decision tree orange squares (#E8A352). The area adapts to its own width: under 620px it drops the counts, run label, compare and metrics so the chart keeps its room.

## Assistant states

| State | Layout |
| --- | --- |
| Empty | A header naming the project with the Tandem mark; a Context group (open file and line count, dataset rows and columns, last run, all read from the project); Suggested actions as one grouped card with icon tiles; a three-step "How changes work" (ask, review, run); the input asks about the open file. |
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
