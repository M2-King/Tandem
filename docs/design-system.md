# Tandem visual system

All values live in `src/styles/tokens.css`. Components use the tokens, not raw values.

## What changed, and why

| Phase | Problem | Change |
| --- | --- | --- |
| 1 · Foundation | Muddy, soft glass with no hierarchy; the wallpaper was filtered | One smoked-glass window that does all the frosting; lighter tool panes and charcoal content panes inside it; crisp hairline edges; the wallpaper is never altered and the glass adapts to its brightness |
| 1 · Foundation | Black editor between two glass panels | Editor and results are charcoal glass with a light frost of their own, one step denser than the tool panes |
| 2 · AI interaction | Cards inside cards, a growing checklist, duplicated review buttons and metrics | Replies on the pane; one live status line; the change block links to the editor; Accept and Reject only above the code; metrics only in Results; change navigation and review shortcuts |
| 3 · Results | IDE-style output band, loud errors, metrics without meaning, no path back to code | Quiet run line linking to the file; only the final traceback line in red; better values marked by weight; R² in the runs list; "Show code" for each chart |
| 4 · Consistency | Stray type sizes, uppercase badge, faded disabled text, measured contrast below 4.5:1 | One type scale; sentence case; colour-based disabled states; tool panes carry a little charcoal so text greys reach 4.5:1 at Balanced and Solid; menus fade out |
| 5 · Validation | Leftover CSS and tokens from earlier passes | Dead rules and 15 unused tokens removed; repeated colours named as shared tokens (pixel-identical before and after); every state rendered and checked |

Kept throughout: the layout and panel behaviour, the person's wallpaper and its settings, and every workflow.

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

One glass surface with one header row: Output, Variables, Charts and Runs as pill tabs (Charts and Runs show counts), then the chart controls on the right (run number, figure 1/2, compare, show code, Ask AI to modify, expand) and close. The area adapts to its own width: under 620px it drops the counts, run label, compare and metrics so the chart keeps its room.

### Output, variables, errors

- The run is one quiet line above its output (no band): "Run #2 · main.py", status, duration. The file name is a link to the code; if the file has changed since the run, the line says "edited since this run", because the output belongs to the earlier version.
- Errors: a quiet callout (7% tint and a 2px left rule in the error colour), with Ask AI to fix and Go to line. In the traceback only the final line (the error itself) is red; the rest is secondary text.

### Charts

- The chart sits directly on the pane: title and legend on one line, aligned with the plot area. Grid lines white at 4.5%, axis at 16%, no chart backgrounds or shadows. Linear regression is blue circles (#6F95EC), the decision tree orange squares (#E8A352); every chart, table and run list uses the same marks.
- **Show code** highlights the block of code that draws the chart (each figure is the unbroken block ending at its `plt.show()`). If the file has changed since the run, a toast says the current code is shown.
- The expanded view uses the same language: charts on the glass, a hairline between figures, no boxed cards.

### Metrics, in one place

- The Results pane is the authoritative place for metrics; the assistant links to it instead of repeating them.
- Compact table: right-aligned tabular numbers; model columns headed by their chart marks. The better value in each row (lower MAE and RMSE, higher R²) is set in the primary colour and semibold, with "(better)" for screen readers. No other colour.
- The Runs list shows each run's R² for both models with their marks, so runs compare at a glance; the run comparison table marks the better run per row the same way.

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

## Shared tokens for grouped content

Grouped content inside a pane (the assistant's context and suggestions, a proposed change, run-summary groups, the results link) uses one recipe:

| Token | Value | Use |
| --- | --- | --- |
| `--group-fill` | white 4.5% | the group's surface |
| `--group-edge` | 1px white 5% inside, 1px `--hairline` top | its edge |
| `--hairline` | white 6% | every thin separator |
| `--divider` | 1px `--hairline` top | between rows inside a group |
| `--accent-tint` / `--on-accent-tint` | blue 14% / #C3D0F0 | the selected rail item, suggestion icon tiles |

## Colour

- Text: primary #EDF0F4, secondary #AAB0BD, muted #9EA5B2. Over bright wallpapers the muted grey steps up automatically.
- Contrast is measured over the real glass, with text hidden, at the brightest 10% of the background where small text sits (assistant groups, file list footer, results header, editor gutter). At Balanced and Solid every text grey reaches 4.5:1 or better. Clear trades some contrast for transparency (secondary text 4.1 to 4.4:1); choose Balanced or Solid for maximum legibility.
- Tool panes carry a little charcoal under their white lift (pane density 0.08 to 0.40 with Opacity, more over bright wallpapers), which is what keeps that contrast without darkening the look.
- Accent #809BDC for text, icons and indicators; #5672BD as the fill behind white text (4.6:1). Blue only for the primary action, focus, selection and the active item.
- Status colours are desaturated: success #6FBF8E, error #E5776F, warning #D9B25C. Chart series: linear regression #6F95EC circles, decision tree #E8A352 squares.

## Actions

| Level | Look | Examples |
| --- | --- | --- |
| Primary | `.btn-primary`: flat accent fill, white text, no glow or gradient | Run, Accept, Send, Step, Ask AI to fix |
| Secondary | `.btn-secondary`: quiet neutral fill | Reject, Continue, Restart, Compare |
| Tertiary | `.btn-ghost`, `.icon-btn`, `.link-btn`: text or icon only, a fill on hover | Back to editing, Cancel, panel toggles, close, more |

- One primary per local context: the toolbar has Run; the review bar has Accept; the session bar has Next/Step; an error callout has Ask AI to fix.
- Disabled is shown with colour (muted text on a faint fill), never opacity.
- No press scaling. Hover and press only change fill and colour.

## Icons

- One family (Lucide outline) with one stroke weight (1.75, set in CSS).
- Sizes by role: 19px rail, 18px toolbar, 16px in buttons, rows and menus, 14px beside 12px text, 12px for filled glyphs (play, stop).
- Icons name actions (file diff, message plus, wrench, code); no sparkles. Containers only where an icon is the identity of a row (the suggested-action tiles).

## Type and space

- Interface 13/18, metadata 12/16, badges and tags 11/14, reading text in the assistant 13/20, dialog titles 15/22, section title 16/22 (assistant start), display 20/26 (one per view: "Analysis complete"). Code in the interface (file names, values) is JetBrains Mono at 12px; the editor uses its own size setting.
- Weights 400, 500 and 600 only. Sentence case everywhere: no uppercase labels (the Demo badge is now the same tag as Simulated).
- Numbers in tables use tabular figures and right alignment.
- Spacing steps 4, 8, 12, 16, 24, 32. Controls 26, 28 and 30px high; file rows 30px; pane headers 44px; 10px between panes; 12px window padding (8px on phones).
- Radii: 6 (badges, small icon buttons), 8 (editor tabs), 10 (buttons, rows, rail items), 12 (cards, floating surfaces), 14 (panes), 24 (the window); pills for result tabs and Run, a circle for Send.

## Motion

One language, all from tokens: hover 150ms, press 170ms, menus and popovers 200ms, panels 260ms, with a soft ease-out.

- Panels open and close by animating their width or height; the transitions are interruptible and switch off while resizing by hand.
- Tabs (editor and results) change colour and fill on the same 170ms.
- Menus fade in with a 3px rise from their anchor and fade out in 150ms; reopening during the fade cancels it. Tooltips fade in.
- Messages fade in with a 4px rise; status rows and the working step fade.
- Nothing bounces, glows, floats or loops except the running spinner.
- With reduced motion every duration is 0 and menus close at once.
