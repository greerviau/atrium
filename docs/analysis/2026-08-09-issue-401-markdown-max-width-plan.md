# Plan: configurable rendered-markdown max width (issue #401)

**Approved** (`docs/analysis/2026-08-09-issue-401-plan-review-round-2.md`,
round 2: approve). This is the final plan revision; §1, §3, and §4 below fold
in round 2's two implementation notes (neither changed the design — see
"Changes from revision 2" at the bottom).

**Revision 2** — incorporates round-1 findings
(`docs/analysis/2026-08-09-issue-401-plan-review.md`). The stepper design is
replaced with a preset dropdown (§4 of the review, adopted per its
recommendation): it is smaller than the stepper on every axis, and it
dissolves the round's must-fix (a sub-56ch minimum breaking a table-layout
invariant) and its "200ch isn't really unlimited" finding by construction,
rather than by patching around them. See "Changes from revision 1" at the
bottom, including one round-1 claim this revision does *not* adopt, and why
(round 2 independently re-derived and confirmed the refusal was correct).

## Problem

The reading-column width for rendered markdown is a single hardcoded value:
`--atrium-prose-max-width: 80ch` in `src/styles/app.css:54`. It was introduced
by issue #199 to give prose, code blocks, tables, and Mermaid diagrams one
consistent column width and left edge, and is deliberately `ch`-based so it
scales with the zoom setting (issue #70). Every consumer reads it via
`var(--atrium-prose-max-width)`:

- prose lines — `markdown.css:48-53` (`.cm-line`, scoped to `.cm-md-rendered`)
- tables — `markdown.css:135-137` (`.cm-table-scroll`, scoped)
- fenced code blocks — `markdown.css:562-564` (`.cm-code-block-box`, scoped)
- Mermaid diagrams — `markdown.css:632-635` (`.cm-mermaid-diagram`, scoped)
- the unwrapped-code-block fallback — `markdown.css:595-601`
  (`.cm-code-block`, a **bare, unscoped** selector — margin only, no
  `max-width` of its own; see "Existing state" below for why applying the
  setting unconditionally is still correct)

There is no way to change this value short of editing the stylesheet. Issue
#401 asks for it to be a user setting, the same way zoom and tab size are.

## Existing state to build on

- **Rendered vs. source markdown** is a CodeMirror decoration mode, not a
  separate HTML renderer: `markdownExtensions()`
  (`src/lib/editor/markdown/livePreviewPlugin.ts:301-317`) tags `.cm-content`
  with `cm-md-rendered` (line 314); `markdownSourceExtensions()`
  (`livePreviewPlugin.ts:327-329`) doesn't. `EditorPane.svelte:130` picks
  between them per-tab based on `viewMode`. There is exactly one DOM
  container per pane either way: `<div class="editor-pane" bind:this=
  {container} ...>` (`src/lib/editor/EditorPane.svelte:741`), which
  CodeMirror mounts `.cm-editor`/`.cm-content` into. `--atrium-prose-max-
  width` is a CSS custom property, so setting it on `.editor-pane` cascades
  to `.cm-content` underneath by ordinary inheritance — no new plumbing
  needed to reach every rule in `markdown.css` that reads it, scoped or not:
  `.cm-code-block` (the one bare-selector consumer, `markdown.css:595-601`)
  is a decoration class emitted only by `livePreviewPlugin`, which
  `markdownSourceExtensions` omits, so it never appears outside rendered
  view regardless of scoping — applying the property unconditionally on
  `.editor-pane` is correct for the actual reason above, not because every
  consumer happens to be `.cm-md-rendered`-scoped (it isn't).
- **Preset settings already have a component and a sibling row.**
  `src/lib/ui/Dropdown.svelte` (`props: { options: {id,label}[], value:
  string, onSelect: (id) => void, label: string }`) is already imported in
  `SettingsDialog.svelte` and used for theme, tab size, terminal dock
  position, and — immediately relevant — the markdown category's other
  setting, default view (`SettingsDialog.svelte:301-313`, options built at
  `:35-38`). `tabSize.ts` is this shape's store precedent: a fixed
  `OPTIONS` tuple (`as const`), a derived option type, a `DEFAULT`, a type
  guard, `load`/`save` against `localStorage` (try/catch, best-effort), a
  `writable` seeded synchronously from `load()`, and a single `set*`
  mutator that sets-and-persists in one call. This plan's store follows that
  shape, not zoom's stepper shape (`MIN`/`MAX`/`STEP`/`clamp`/increment-
  decrement mutators) — issue #401's title asks only that the width be
  "configurable" (its body is empty), and a discrete preset set fully
  satisfies that with less code, no new CSS, and no boundary-clamping logic
  to get wrong.
- **A discrete "narrowest allowed value" is load-bearing elsewhere.**
  `src/lib/editor/markdown/decorations.ts:743-762` defines
  `NARROW_COLUMN_MAX_CHARS = 16` and `MAX_NARROW_COLUMNS = 3`, whose
  docstring states the invariant directly: three `text-wrap: nowrap` narrow
  columns can demand up to 54ch that cannot be squeezed, and that has to
  stay under whatever the reading column's floor is, or `.cm-table-scroll`'s
  `overflow-x: auto` (`markdown.css:135-137`) traps it as a horizontal
  scrollbar on an ordinary table instead of letting the table wrap. The
  docstring currently cites "65ch" as that floor, which is already stale
  (today's actual floor is the hardcoded 80ch) and would become actively
  wrong the moment any user-reachable value could go lower — a continuous
  stepper down to 40ch (this plan's revision 1) would have made that
  concretely reproducible: a 3-column status/owner/date table under a
  40ch cap gets a real horizontal scrollbar. This plan's lowest preset,
  60ch, clears the 54ch demand with margin, so the invariant holds — but the
  docstring's stale "65ch" citation still needs correcting to name the real
  current floor (§5 below), since it stops being incidentally-true
  documentation and starts being a claim this feature makes contractual.
- **`app.css`'s `:root` values** are pre-JS-paint defaults that theme's
  `applyThemeToDocument` (`src/lib/theme/cssVars.ts:19-26`) overwrites at
  startup by writing `--atrium-*` custom properties onto
  `document.documentElement`. That mechanism doesn't fit here: it's for
  values that apply globally and uniformly (theme tokens), whereas this is a
  single per-pane numeric setting, and the codebase's actual convention for
  that (zoom) is a Svelte-reactive inline style on `.editor-pane` itself,
  which this plan follows instead. No FOUC concern either way, since the new
  store is seeded synchronously from `localStorage` before the first
  render, exactly like `zoom`.
- **CSS custom properties substitute as token streams at the point of use,
  not the point of declaration.** This is what makes an inline override on
  `.editor-pane` byte-identical to today's `:root` default when the value is
  unchanged, and it's also what makes the "Full" preset (below) work
  correctly: `ch` in `markdown.css`'s `min(var(--atrium-prose-max-width),
  100cqw)` resolves against `.cm-content`'s own font wherever the variable
  is *used*, and the same is true of any unit substituted through it —
  including `cqw`.

## Approach

### 1. New store: `src/lib/stores/proseWidth.ts`

Named to match its own exports and the CSS variable it drives
(`--atrium-prose-max-width`) — round-1 flagged `markdownMaxWidth.ts`
exporting only `proseWidth`-prefixed symbols as an avoidable mismatch every
other store in this codebase doesn't have.

```ts
import { writable } from "svelte/store";

const STORAGE_KEY = "atrium.markdown.proseWidth";

// The narrowest preset (60) must stay above the 54ch a 3-column narrow table
// can demand without wrapping — see MAX_NARROW_COLUMNS's docstring in
// editor/markdown/decorations.ts. Don't add a preset below 60 without
// re-checking that invariant.
export const PROSE_WIDTH_OPTIONS = [60, 80, 100, 120, "full"] as const;
export type ProseWidth = (typeof PROSE_WIDTH_OPTIONS)[number];
export const DEFAULT_PROSE_WIDTH: ProseWidth = 80;

function isProseWidth(value: unknown): value is ProseWidth {
  return (PROSE_WIDTH_OPTIONS as readonly unknown[]).includes(value);
}

/** Reads the persisted max-width preset. Falls back to the default on any missing/malformed/out-of-set data. */
export function loadProseWidth(): ProseWidth {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROSE_WIDTH;
    const parsed = JSON.parse(raw);
    return isProseWidth(parsed) ? parsed : DEFAULT_PROSE_WIDTH;
  } catch {
    return DEFAULT_PROSE_WIDTH;
  }
}

/** Persists the max-width preset. Swallows quota/availability errors since this is best-effort. */
export function saveProseWidth(width: ProseWidth): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(width));
  } catch {
    // localStorage unavailable or quota exceeded; the setting simply won't persist.
  }
}

export const proseWidth = writable<ProseWidth>(loadProseWidth());

export function setProseWidth(width: ProseWidth): void {
  proseWidth.set(width);
  saveProseWidth(width);
}

/** The `--atrium-prose-max-width` value for a preset. "full" maps to `100cqw`, not a large `ch` number, so it stays genuinely uncapped across the full zoom range (a `ch` figure does not: it scales with zoom, so no fixed `ch` ceiling is "unlimited" at every zoom level). */
export function proseWidthCssValue(width: ProseWidth): string {
  return width === "full" ? "100cqw" : `${width}ch`;
}
```

`DEFAULT_PROSE_WIDTH = 80` matches today's hardcoded `app.css:54` value, so a
user who never opens Settings sees no change.

### 2. Apply it in `EditorPane.svelte`

```ts
import { proseWidth, proseWidthCssValue } from "../stores/proseWidth";
```

```svelte
<!-- Concatenated into the style attribute, not Svelte's `style:--custom-prop`
     directive: that directive compiles to `element.style.setProperty()`,
     which is unreliable for custom properties under jsdom's `cssstyle` in
     tests — see EditorPane.activation.test.ts's existing font-size
     assertion for the same reason zoom is done this way. -->
<div
  class="editor-pane"
  bind:this={container}
  style={`font-size: ${$zoom * 100}%; --atrium-prose-max-width: ${proseWidthCssValue($proseWidth)};`}
  oncontextmenu={onContextMenu}
></div>
```

Set unconditionally (not gated on `mode === "markdown"` or `viewMode ===
"rendered"`): inert for code panes and source-view markdown panes for the
reason in "Existing state" above (no consumer of the variable — scoped or
not — renders outside rendered-markdown view), not because every consumer
happens to be `.cm-md-rendered`-scoped.

### 3. Registry entry: `src/lib/settings/settingsRegistry.ts`

Add to `SETTINGS_SECTIONS`, immediately after the existing `"default-view"`
entry (`settingsRegistry.ts:84-89`):

```ts
{
  id: "max-width",
  categoryId: "markdown",
  title: "Max Width",
  keywords: ["markdown", "width", "reading width", "line length", "column", "prose"],
},
```

(No `"max width"` keyword: `sectionMatchesQuery`'s haystack already includes
`section.title`, so it would just duplicate the implicit title match.)

### 4. Settings UI: `SettingsDialog.svelte`

```ts
import { proseWidth, setProseWidth, PROSE_WIDTH_OPTIONS, type ProseWidth } from "../stores/proseWidth";
```

```ts
const PROSE_WIDTH_DROPDOWN_OPTIONS: { id: string; label: string }[] = PROSE_WIDTH_OPTIONS.map((w) => ({
  id: String(w),
  label: w === "full" ? "Full" : `${w}ch`,
}));
```

New section, directly after the `"default-view"` block
(`SettingsDialog.svelte:301-313`), following that block's own shape exactly:

```svelte
{#if selectedCategory === "markdown" && isSectionVisible("max-width")}
  <SettingsSection title="Max Width" id={sectionAnchorId("max-width")}>
    <div class="settings-row">
      <span class="settings-label">Max width of rendered markdown</span>
      <Dropdown
        options={PROSE_WIDTH_DROPDOWN_OPTIONS}
        value={String($proseWidth)}
        onSelect={(id) => setProseWidth((id === "full" ? "full" : Number(id)) as ProseWidth)}
        label="Max width of rendered markdown"
      />
    </div>
  </SettingsSection>
{/if}
```

No CSS changes: `Dropdown.svelte` and `.settings-row`/`.settings-label` are
already styled and already used by the sibling row.

### 5. `decorations.ts` docstring correction

Update **both** docstrings this constant pair carries, not only
`MAX_NARROW_COLUMNS`'s — round 2 caught that `NARROW_COLUMN_MAX_CHARS`'s own
docstring (`decorations.ts:744-747`) makes the same now-stale claim
("stays a small fraction of the reading column": 18ch of a 60ch floor is
30%, not small, and the three-column aggregate is 54 of 60):

`NARROW_COLUMN_MAX_CHARS` (`decorations.ts:744-747`) — reword the closing
clause to drop the "small fraction" framing in favor of the concrete floor:

```
 * this plus the ~2ch its `0.6em` side padding comes to at the editor's
 * monospace metrics — fits inside the narrowest width the Max Width setting
 * offers (60ch — `PROSE_WIDTH_OPTIONS`, `stores/proseWidth.ts`).
```

`MAX_NARROW_COLUMNS` (`decorations.ts:751-762`) — replace the stale "65ch"
sentence (`:759-760`) the same way:

```
 * Three columns cost at most 54ch, which clears the narrowest width the Max
 * Width setting offers (60ch — `PROSE_WIDTH_OPTIONS`, `stores/proseWidth.ts`).
```

### 6. `app.css` comment

Update the doc comment above `--atrium-prose-max-width` (`app.css:48-54`) to
note it's now overridden per-pane by the Max Width setting:

```css
  /* Shared reading-column width for rendered markdown: prose, code blocks,
     tables, and Mermaid diagrams all cap to this same value (markdown.css),
     so the whole document reads as one consistent column with a single left
     edge (issue #199) instead of prose centering narrower than code/tables.
     `ch` (not `px`) so the column scales with the user's font size/zoom
     (#70) rather than staying visually fixed as text size changes. This is
     the pre-JS-paint default only — `EditorPane.svelte` overrides it per
     pane from the Max Width setting (`stores/proseWidth.ts`, #401) once
     Svelte mounts. */
  --atrium-prose-max-width: 80ch;
```

No change needed to `markdown.css` itself — every consumer already reads
the custom property, not the literal value, and `100cqw` substitutes into
the existing `min(var(...), 100cqw)`/`max(0px, (100cqw - var(...)) / 2)`
expressions without needing a special case for "Full".

## Testing

- **`tests/frontend/proseWidth.test.ts`** (new), mirroring `tabSize.test.ts`
  structure: `loadProseWidth`/`saveProseWidth` round-trip each preset
  including `"full"`, default-when-unset, default-on-malformed-JSON,
  default-on-value-outside-the-option-set, swallows-write-error;
  `setProseWidth` sets-and-persists; `proseWidthCssValue` maps every numeric
  preset to `"<n>ch"` and `"full"` to `"100cqw"`.
- **`EditorPane.proseWidth.test.ts`** (new, alongside the existing
  `EditorPane.tabSize.test.ts`): asserts the `.editor-pane` element's style
  attribute contains `--atrium-prose-max-width: <value>` for the default and
  for a changed preset (including `"full"` → `100cqw`), and that it updates
  live (no remount) when the store changes after mount. Noted as a
  string-attribute check, not layout coverage: the suite runs on jsdom
  (`vitest.config.ts`), whose `getComputedStyle` does not resolve inherited
  custom properties through a subtree, so a computed-style assertion isn't
  available here. Actually seeing the rendered column change width — the
  property cascading to `.cm-content` and the `min()`/`max()` expressions
  picking it up — is verified manually against the running app (`npm run
  dev`/`tauri dev`) as part of this change's validation, not by this test.
- **`tests/frontend/SettingsDialog.test.ts`**: add a `describe("markdown max
  width", ...)` block near the existing `describe("markdown default view",
  ...)` block (`SettingsDialog.test.ts:817-845`) — shows the current preset
  selected in the dropdown, and selecting an option (including `"Full"`)
  updates the shared `proseWidth` store and closes the dropdown. It cannot
  reuse that block's `dropdownTrigger(container)` helper as-is: `dropdownTrigger`
  (`SettingsDialog.test.ts:738-740`) is `container.querySelector(".dropdown-
  trigger")`, the *first* match in DOM order, which is safe today only
  because every category with a dropdown has exactly one — this change makes
  Markdown the first category with two. Open the new row's dropdown via
  `screen.getByLabelText("Max width of rendered markdown")` instead (`Dropdown
  .svelte:127` puts the `label` prop on the trigger as `aria-label`), which
  selects it unambiguously regardless of DOM position. Add
  `proseWidth.set(DEFAULT_PROSE_WIDTH)` to the top-level `beforeEach` reset
  list (`SettingsDialog.test.ts:59-68`) alongside the other settings stores.

## Regressions checked

- `decorations.test.ts`'s existing assertions against `markdown.css`'s rule
  bodies (e.g. `.cm-code-block-box` at `:2593-2602`, `.cm-code-block` at
  `:2612-2625`) are unaffected — no change to `markdown.css` itself.
- Existing `EditorPane.activation.test.ts:37` (`.toContain("font-size:
  150%")`) — unaffected, since the assertion only checks for a substring of
  the (now longer) style string.
- Existing `SettingsDialog.test.ts` markdown-category tests — unaffected;
  the new row is a sibling addition, not a change to `"default-view"`. This
  is order-dependent, not just structural: the existing default-view test's
  `dropdownTrigger(container)` helper selects the *first* `.dropdown-trigger`
  in DOM order, which stays Default View's own trigger only because the new
  Max Width section is placed **after** `"default-view"` in both the
  registry (§3) and the markup (§4). Placing it before would silently break
  that existing test.
- No change to `livePreviewPlugin.ts` or any Rust/backend code.

## Changes from revision 1

Round-1 review (`docs/analysis/2026-08-09-issue-401-plan-review.md`) found
one must-fix and three should-fix items. All are addressed by switching from
a continuous stepper to a preset dropdown, which the review itself
identified as resolving the must-fix and two of the three should-fix items
"by construction":

1. *Must-fix: `MIN_PROSE_WIDTH = 40` breaks the `MAX_NARROW_COLUMNS`
   invariant in `decorations.ts`* — the preset set's floor is 60ch, which
   the review's own math confirms clears the 54ch narrow-column demand with
   margin; the stale docstring is corrected regardless (§5).
2. *Should-fix: consumer inventory was incomplete/inaccurate* — corrected in
   "Problem" and "Existing state" above: `markdown.css:595-601`
   (`.cm-code-block`) is a real additional consumer, and the plan's
   original justification for applying the property unconditionally
   ("nothing outside `.cm-md-rendered` reads it") was wrong even though its
   conclusion wasn't; the actual reason (the class is only ever emitted in
   rendered view) is now what's stated. **Not adopted:** the review's other
   claim in this item — that `decorations.ts` itself emits inline styles
   reading `var(--atrium-prose-max-width)`, asserted by
   `decorations.test.ts:2595-2757` — doesn't hold up: those tests
   (`ruleBodyFor`, `decorations.test.ts:28-47`) read and assert against
   `markdown.css`'s own rule bodies via `readFileSync`, not against any
   inline style `decorations.ts` constructs; grepping `decorations.ts`
   directly turns up only the one docstring comment. `decorations.ts` does
   not emit any inline style referencing this variable.
3. *Should-fix: "200ch is effectively unconstrained" is false across the
   zoom range* — moot: the dropdown's "Full" option maps to `100cqw`, a
   container-relative unit that isn't `ch`-denominated and so doesn't scale
   with zoom, giving a genuinely unconstrained option instead of a
   large-but-still-capped `ch` number.
4. *Should-fix: a preset dropdown is smaller and dissolves both defects
   above* — adopted as recommended; no `MIN`/`MAX`/`STEP`/`clamp` machinery,
   no CSS class rename (the stepper's `.settings-zoom*` →
   `.settings-stepper*` generalization is no longer needed — the new row
   reuses the already-styled `Dropdown` component instead).
5. *Should-fix: the proposed `EditorPane` test is tautological given jsdom's
   custom-property limits* — the Testing section now states that limit
   explicitly and names the manual check that actually verifies the
   rendered column's width, rather than presenting the string assertion as
   full coverage.

Nice-to-haves also folded in: the store is named `proseWidth.ts` (matching
its exports and the CSS variable), and the registry entry drops the
redundant `"max width"` keyword.

## Changes from revision 2

Round-2 review (`docs/analysis/2026-08-09-issue-401-plan-review-round-2.md`)
approved the plan outright and verified every claim in revision 2, including
independently re-deriving that revision 2's refusal to adopt round 1's
"`decorations.ts` emits inline styles" claim was correct. It raised two
implementation-level notes, neither a design defect, both folded in above:

1. The new `SettingsDialog` test can't reuse the default-view block's
   `dropdownTrigger` helper as written — Markdown becomes the first category
   with two dropdowns, and that helper selects the first match in DOM order.
   Fixed by targeting the new row via `getByLabelText` instead (§Testing),
   and the section-ordering dependency this implies for the *existing* test
   is now recorded in "Regressions checked".
2. §5's docstring fix needs to cover `NARROW_COLUMN_MAX_CHARS` as well as
   `MAX_NARROW_COLUMNS` — both docstrings assert something that stops being
   true once the floor is user-selectable, not just the one revision 2
   already caught.

The review also recorded a residual-risk note, explicitly not a change
request: at the 60ch floor, a four-column table (three narrow columns plus
one prose column) can still hit a horizontal scrollbar, versus the 11ch of
headroom the constant was originally calibrated with. This is accepted as-is
— it's a graceful degradation (a scrollbar, not lost content) confined to
the narrowest of five presets, on content the user would need to construct
deliberately, and 60ch is round 1's own recommendation. Bumping the floor to
70ch remains a one-digit change (`PROSE_WIDTH_OPTIONS` plus the matching
figure in §5) if this judgment call is later revisited.
