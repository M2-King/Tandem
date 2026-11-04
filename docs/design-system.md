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
| Content panes | Editor and Results: charcoal glass for the document and what it produces, a step denser than the tool panes. | A light frost of their own (11px, on a `::before` layer so the editor's pop-ups keep their position), neutral charcoal 22,26,36 at 0.40, white at 4.5% fading to 2.5%, the same hairline edges. The extra frost evens out the background behind code, which is what lets the tint stay light. |
| Floating | Menus, popovers, dialogs, toasts. | Their own frosted glass: blur 28px, tint 29,32,43 at 0.90, crisp border. |

Why this works:
- **Clean colour, no mud:** the window darkens what's behind it through transmission instead of laying grey over it, so warm light stays warm and doesn't turn brown.
- **Crisp, not soft:** the window does the main frosting. Tool panes add none; content panes add only a light frost so code sits on an even background.
- **One family:** tools and document use the same edges, radius and shadow; the document is only a step denser (measured on the sample wallpaper: editor 40,39,47 vs assistant 46,45,53), never a black box.

Menus inside the window keep their own frost because the window's glass is drawn on a `::before` layer: an element with a backdrop filter would trap the backdrop of everything inside it.

### Adapting to the wallpaper

When a wallpaper is chosen, Tandem measures its brightness once (a 32×32 sample, blending the mean with the 80th percentile so bright patches count). Over a bright image the window passes less light and gets denser, the document panes darken, and the faintest text steps up. Over a dark image nothing changes. Toolbar text, the only text sitting on the window glass alone, uses a brighter grey.

Measured worst case (text over the brightest 10% of what's behind it) on the sample and four test wallpapers (bright sky, near-white, saturated colour, near-black): secondary text 4.7:1 or better, code 10.5:1 or better, comments 4.7:1 or better.

### Glass settings (⋯ menu → Glass)

- **Clear / Balanced / Solid** set Opacity to 15, 50 or 90.
- **Opacity:** window tint 0.12 to 0.76 and document panes 0.14 to 0.66.
- **Frost:** window blur 8px to 36px, document panes 4px to 18px.

Browsers without backdrop blur fall back to near-solid surfaces.

## Workspace components

| Component | Rules |
| --- | --- |
| Navigation rail | 56px column on the window glass, no container. 19px outline icons, muted grey; hover lifts to white; the selected item gets a soft blue tint. Files toggles the explorer; Charts and Runs open the results on that view (a dot marks new charts). Tooltips on the right. Hidden on phones, where the Files toggle returns to the toolbar. |
| File explorer | 30px rows. Every row has the same columns: disclosure arrow (blank for files), 16px icon, name; each level indents 18px, with a faint guide line inside folders. Selection is a neutral 8% white lift, not blue. "Collapse folders" appears on hover or focus. Arrow keys move between rows, Left/Right close and open folders, Home/End jump. |
| Editor tabs | One 44px header with a hairline under it, no separators; file type and length on the right ("Python · 64 lines"). 28px tabs, radius 8; the open file is a 7.5% white lift. Close appears on the open or hovered tab. A grey dot marks a file edited from the sample. |
| Layout | Window inset 10px from the screen; 52px toolbar; 56px rail; files 196px; assistant 380px; results 330px tall (never squeezing the editor below 200px); 10px between panes; 12px window padding. Every pane header is 44px, so headers line up across the window. |
| Editor | The darker document pane. The current line is marked only by its brighter line number (#C9CED8), with no band across the code; other line numbers #858C9A; comments #939AA7 italic; 18px gutter spacing; 14px top and bottom padding; 8px scrollbars. The debugger's current line is a 9% blue band with a 2px marker at the left. |

## Results

One glass surface with one header row: Output, Variables, Charts and Runs as pill tabs (Charts and Runs show counts), then the chart controls on the right (run number, figure 1/2, compare, Ask AI to modify, expand) and close. The chart sits directly on the panel glass with its title and legend in one line; only the metrics table gets a quiet inset surface beside it. Grid lines are white at 4.5%, the axis at 16%. Linear regression is blue circles (#6F95EC), the decision tree orange squares (#E8A352). The area adapts to its own width: under 620px it drops the counts, run label, compare and metrics so the chart keeps its room.

## AI interaction

### Assistant states

| State | What it shows |
| --- | --- |
| Empty | A header naming the project; Context (open file and line count, dataset rows and columns, last run, all read from the project); Suggested actions as one grouped card; a three-step "How changes work". The input asks about the open file. |
| Working | One live line: spinner, the current step (fades in as it changes), Cancel. No growing checklist. |
| Review | The reply text (why), then the change: a file row (path, +/−, "Review ›" or "In the editor"), then what changed. While it's being reviewed, the change has a blue outline. Accept and Reject exist only in the review bar above the code. |
| Applied | The file row says "Open ›" and jumps to the file with the changed lines highlighted; a status row with Undo. Rejected, discarded and undone changes name their state in the file row and mute the summary colour (never opacity). |
| Completed | Only after the accepted change has actually run: "Analysis complete" with the run number, what ran, a link to the metrics and chart in Results (metrics live in one place, not repeated here), an insight computed from the run, next steps. |

### Messages

- Replies sit directly on the pane with no card; only a proposed change gets a grouped surface. User turns are right-aligned bubbles with extra space above them, so each exchange reads as a unit.
- When a reply is done its steps fold into a quiet "Done in N steps" line that can be opened.
- A code reference sent with a question (for example "main.py · Line 18") is a link: it opens that file and highlights those lines.
- Sending always scrolls to the newest message. A finished-run summary scrolls its heading into view.
- New messages fade in with a 4px rise (260ms); status rows fade in. Reduced motion turns all of it off.

### Code review

- One review bar above the diff: "Review proposed change" with +/−, the reason in one line underneath, then previous/next change with "2 of 4", Back to editing, Reject, Accept.
- The diff opens on the first change. F7 / Shift+F7 move between changes, Ctrl/⌘ Enter accepts, Esc (with focus in the editor) goes back to editing. Shortcuts never fire while typing in the assistant or a menu.
- Restrained colour: changed lines get a 7–8% green or red tint, changed characters a little more, and the gutter strip carries the clearest marker. Both line-number columns stay visible in the inline view.
- The bar grows and wraps on narrow editors (it no longer inherits Monaco's own fixed-height `.editor-banner` rule).
- Closing and reopening a review no longer throws: diff models are disposed only once no open review uses them.

### Selection actions

- A small frosted bar under a selection: Ask AI (with its shortcut, Ctrl/⌘ L), Explain, Fix. Three actions, no more.
- It disappears when the selection collapses (Esc or a click), the file changes, the editor loses focus, or the code changes under it.

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
