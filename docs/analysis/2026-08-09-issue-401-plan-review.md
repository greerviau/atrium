# Review: implementation plan for issue #401 (configurable rendered-markdown max width)

**Plan under review:** `docs/analysis/2026-08-09-issue-401-markdown-max-width-plan.md`
**Issue:** greerviau/atrium#401, "Rendered markdown max width configurable in settings" (open, `enhancement`, body empty - the title is the whole specification)
**Reviewed against:** the working tree at `4e57a1e`, confirmed caught up with `origin/main` (`git-freshness-check.sh`: `fresh:HEAD already contains origin/main`)

**Verdict: request changes.** One must-fix regression, three should-fix accuracy/design items. The core approach is sound and close to minimal; the defects are in the range endpoints and in claims the plan makes about the surrounding code, not in the mechanism.

---

## 1. Verification of the plan's factual claims

Every file/line citation in the plan was checked against the real files. **All of them are exact**, with one path note and one off-by-one:

| Plan claim | Actual | Verdict |
|---|---|---|
| `app.css:54` - `--atrium-prose-max-width: 80ch` | `src/styles/app.css:54` | exact |
| `markdown.css:48-53` prose lines | selector at `:48`, declarations `:50-51` | exact (cites the selector line) |
| `markdown.css:135-137` `.cm-table-scroll` | selector `:135`, declarations `:136-137` | exact |
| `markdown.css:562` `.cm-code-block-box` | selector `:562`, declarations `:563-564` | exact |
| `markdown.css:632` `.cm-mermaid-diagram` | selector `:632`, declarations `:634-635` | exact |
| `EditorPane.svelte:741` - the `.editor-pane` div with `style={...font-size...}` | `src/lib/editor/EditorPane.svelte:741` | exact (note: `src/lib/editor/`, not `src/lib/components/`; the plan never states the directory, and its relative import `../stores/markdownMaxWidth` resolves correctly from there) |
| `EditorPane.svelte:130` picks the extension set per `viewMode` | line 130 | exact |
| `livePreviewPlugin.ts:301-317`, `cm-md-rendered` at `:314`, `markdownSourceExtensions` at `:327-329` | all three | exact |
| `settingsRegistry.ts:35-96` / `"default-view"` at `:84-89` | array `35-96`, entry `84-89` | exact |
| `SettingsDialog.svelte:180-201` zoom row, `:421-448` zoom CSS, `:301-313` default-view block | all three | exact (file lives at `src/lib/shell/SettingsDialog.svelte`) |
| `EditorPane.activation.test.ts:37` asserts `.toContain("font-size: 150%")` | line 37, verbatim | exact |
| `SettingsDialog.test.ts:846-871` zoom `describe` | starts at `:847`, ends `:881` | off by one; immaterial |
| `SettingsDialog.test.ts:59-67` store-reset list in `beforeEach` | resets run `:59-68` | off by one; immaterial |

Claims about mechanism that also check out:

- **`.settings-zoom*` rename is safe.** `grep -rn "settings-zoom" src/ tests/` returns hits only in `SettingsDialog.svelte` (`:184, :186, :193, :194, :421, :426, :437, :440, :444`) and nothing in `tests/`. The existing zoom tests key on `getByText("100%")`, `getByLabelText("Zoom in")`, and `getByText("Reset")` - text and ARIA, never class names. The rename is mechanical and safe as described.
- **No second-`Reset` collision.** Every settings section is gated `{#if selectedCategory === "<one category>" && isSectionVisible(...)}`, and `isSectionVisible` (`SettingsDialog.svelte`) only narrows within the selected category (`return !searching || matchingSectionIds.has(id)`). Search never renders two categories at once. Zoom lives in `general`, the new row in `markdown`, so `getByText("Reset")` stays unambiguous in both tests. The plan does not claim this, but it is the obvious way this change could have broken an existing test, and it does not.
- **`EditorPane` is the only rendered-markdown surface.** `App.svelte:1279` -> `EditorPaneSplit.svelte:91` -> `EditorPanel.svelte:221` -> `EditorPane.svelte`. `cm-md-rendered` is added in exactly one place (`livePreviewPlugin.ts:314`). So an inline custom property on `.editor-pane` does reach every consumer; there is no second markdown surface it would miss.
- **`ch` resolution is unchanged.** `--atrium-prose-max-width` is an unregistered custom property, so its value substitutes as a token stream and the `ch` unit resolves against the font of the element where it is *used* (`.cm-content`, monospace), not where it is declared. Moving the declaration from `:root` to `.editor-pane` therefore produces byte-identical layout at `DEFAULT_PROSE_WIDTH = 80`. Confidence: high.
- **No documentation to update.** `grep -rln "Tab Size\|Word Wrap" docs/ README.md` returns nothing; no doc enumerates the settings, so the plan is not missing a docs change.

---

## 2. Must-fix

### 2.1 `MIN_PROSE_WIDTH = 40` breaks a documented invariant in `decorations.ts` and produces horizontal scrollbars on ordinary tables

`src/lib/editor/markdown/decorations.ts:748-760` defines `MAX_NARROW_COLUMNS = 3` and states its sizing rationale explicitly:

> At most this many columns in one table may be treated as narrow. Their combined demand (`NARROW_COLUMN_MAX_CHARS` + ~2ch padding each) has to stay inside the narrowest `--atrium-prose-max-width` anyone is plausibly running, because a narrow column refuses to wrap and therefore can't be squeezed: overshooting would push the table past its cap, forcing `.cm-table-scroll`'s `overflow-x: auto` (markdown.css) to trap the excess as a horizontal scrollbar on an otherwise-ordinary table instead of letting it wrap. **Three columns cost at most 54ch, which clears even the 65ch this variable shipped with.**

That constant is calibrated against a floor the plan is about to remove. `NARROW_COLUMN_MAX_CHARS = 16` plus ~2ch padding, times `MAX_NARROW_COLUMNS = 3`, is 54ch of demand that cannot be squeezed - `findNarrowColumns` applies `text-wrap: nowrap` to those columns precisely so the auto table algorithm must satisfy them outright. Today the cap is hardcoded at 80ch, so 54ch always fits. The plan makes 40ch reachable from the settings UI.

**Concrete failure.** A user sets Max Width to 40ch (or 50ch - anything below ~56ch). They open a rendered markdown file containing a three-column table whose every cell is 16 characters or shorter - e.g. a status/owner/date table:

```markdown
| Status      | Owner        | Updated    |
|-------------|--------------|------------|
| In progress | greerviau    | 2026-08-09 |
| Blocked     | someone-else | 2026-07-31 |
```

All three columns qualify as narrow (`widest <= 16`), the count is `<= MAX_NARROW_COLUMNS`, so all three get `text-wrap: nowrap`. Combined min-content is ~54ch against a 40ch cap. `.cm-table-scroll` (`markdown.css:135`) has `max-width: min(var(--atrium-prose-max-width), 100cqw)` and `overflow-x: auto`, so the overflow becomes a horizontal scrollbar on a table that would have wrapped fine - exactly the outcome the docstring says the constant exists to prevent.

The plan's "Regressions checked" section lists three items and misses this one; `decorations.ts` does not appear anywhere in the plan.

**This needs to be addressed, not necessarily fixed a particular way.** Options, in my order of preference:

1. Set `MIN_PROSE_WIDTH = 60`. Clears the 54ch demand with margin, keeps the change to one constant, and 60ch is still a genuinely narrow reading column. This is the smallest change that fully closes the hole.
2. Derive the narrow-column budget from the live setting rather than a constant. Correct in general, but it drags a Svelte store into a pure CodeMirror decoration module and needs its own tests; disproportionate here.
3. Accept the degradation and rewrite the `MAX_NARROW_COLUMNS` docstring so it no longer asserts an invariant that is false. Only defensible if the requester actively wants sub-56ch widths, and it knowingly ships a visual bug.

Whichever is chosen, `decorations.ts:748-760`'s docstring must be updated - it currently names "the 65ch this variable shipped with" as the binding floor, which stops being true the moment the value is user-controlled.

---

## 3. Should-fix

### 3.1 The consumer inventory of `--atrium-prose-max-width` is incomplete, and one of the omissions falsifies a stated justification

The plan says "Every consumer in `src/styles/markdown.css` reads it via `var(--atrium-prose-max-width)`" and lists four. There are two more references:

- **`markdown.css:595-601`, `.cm-code-block`** reads the variable at `:600` for `margin-inline-start`. It is a **bare one-class selector**, not scoped to `.cm-md-rendered`. This directly contradicts the plan's stated reason for applying the style unconditionally in section 2: "it's inert for code panes and source-view markdown panes, since **nothing in `markdown.css` reads `--atrium-prose-max-width` outside `.cm-md-rendered` rules**." That sentence is false as written.

  The *conclusion* still holds, for a different reason: `.cm-code-block` is a decoration class emitted only by `livePreviewPlugin`, and `markdownSourceExtensions` (`livePreviewPlugin.ts:327-329`) omits that plugin, so the class never appears in source view. And even where it does appear, the inline declaration sets the same value the `:root` rule already provided. So there is no behavioral defect - but the plan should be corrected, because the next person to touch this will trust the reasoning, not re-derive it.

- **`decorations.ts:754`** and the inline styles that module emits. `tests/frontend/decorations.test.ts:2595-2757` asserts that decoration-generated inline styles contain `var(--atrium-prose-max-width)` in six places. Those inline styles sit on elements inside `.cm-content`, so they resolve the overridden value by ordinary inheritance and need no change - but "every consumer is in `markdown.css`" is not accurate, and this is the same module that carries the invariant broken in 2.1.

### 3.2 "200ch is effectively unconstrained" is false in two common configurations, and the plan leans on it to skip designing an Unlimited option

The plan justifies `MAX_PROSE_WIDTH = 200` this way:

> 200ch is wide enough that `min(var(--atrium-prose-max-width), 100cqw)` in `markdown.css:50` falls back to the pane's actual width (`100cqw`) on any realistic window, so the top of the range reads as "effectively unconstrained" without a separate sentinel/"Unlimited" value to design and test.

The cap is expressed in `ch`, and `ch` scales with the zoom setting - that is the whole point of issue #70, and the plan itself says so. So the pixel width of "200ch" is not a fixed quantity:

- The app sets no explicit base font size (`src/styles/app.css` has no `html`/`body` `font-size`), so the editor renders at the ~16px browser default at zoom 1.0. At typical monospace metrics (~0.6em per `ch`, ~9.6px), 200ch is ~1920px. That is genuinely unconstrained on a 1080p display - and still a hard, visible cap on any 1440p or 4K setup, which is a mainstream developer configuration.
- At `MIN_ZOOM = 0.5` the font is ~8px, so 200ch is ~960px. That constrains hard on *every* modern display: a user who zooms out to fit more on screen gets a 960px column with the rest of the pane as empty gutter, at the maximum setting.

Confidence: high on the mechanism, moderate on the exact pixel figures (they depend on the resolved monospace face). The mechanism alone is enough - a `ch`-denominated maximum cannot be "effectively unlimited" across a 4x zoom range.

Either own it ("200ch is a real cap; an unlimited option is out of scope for #401") or reconsider the top of the range. What the plan must not do is use a false claim to retire a design question.

### 3.3 A preset dropdown modeled on `tabSize.ts` is a genuinely smaller option, and the plan dismisses it in one clause

The plan disposes of the alternative with: "`tabSize.ts` is the fixed-option-set variant of the same shape; a continuous width isn't a small fixed set, so the zoom shape fits better." That assumes the requirement is a continuous width, which issue #401 does not say - the issue body is empty and the title asks only that the width be "configurable in settings".

A `markdownMaxWidth.ts` shaped like `tabSize.ts`, with `PROSE_WIDTH_OPTIONS = [60, 80, 100, 120, "full"]` rendered through the existing `Dropdown` component (already imported in `SettingsDialog.svelte`, already used by the sibling `default-view` row eight lines above where the new row goes), is smaller than the plan on every axis that matters:

- No `clamp`/`MIN`/`MAX`/`STEP` machinery, no increment/decrement/reset mutators - `tabSize.ts` is 38 lines against `textSize.ts`'s 60.
- **No CSS class rename at all.** The `.settings-zoom*` -> `.settings-stepper*` refactor in the plan's section 4 exists solely to let a stepper row be reused; a dropdown row needs zero new CSS.
- Fewer tests: no step-and-clamp-at-boundary cases, no "doesn't drift past MIN/MAX".
- It **dissolves both defects above**. A minimum of 60 sidesteps 2.1 by construction; a `"full"` option maps to `max-width: 100cqw` (or `none`) and delivers the genuinely-unconstrained case that 3.2 shows 200ch cannot.

The cost is that a user cannot pick 87ch. That is a real but small loss, and it is the requester's call - which is why this is a should-fix flagged for decision, not a defect. My recommendation is the dropdown: it is the smaller change among the two that fully solve the problem, and the plan's own stated preference for reusing existing conventions points at the `default-view` sibling row it will sit directly beside, not at the zoom row in a different category.

If the stepper is kept, the plan as written is still workable once 2.1 is fixed; the rename is safe and the reuse argument against duplicating ~24 lines of CSS is correct on its own terms.

### 3.4 The proposed `EditorPane` test is tautological, and the plan should say so

The plan proposes asserting that `.editor-pane`'s style attribute "contains `--atrium-prose-max-width: <value>ch`", matching `EditorPane.activation.test.ts:37`'s style. That assertion re-reads the template literal that produced it. It cannot fail for any reason other than the store not being wired, and in particular it proves nothing about the property cascading to `.cm-content` or about the layout actually changing.

The stronger assertion is not available: the suite runs on `jsdom ^25.0.1` (`vitest.config.ts:13`, `package.json:54`), whose `getComputedStyle` does not resolve inherited custom properties through a subtree. So a string assertion is the ceiling in unit tests. That is fine - but the plan should state the limitation and name the manual or end-to-end check that actually verifies the rendered column changes width, rather than presenting the string assertion as coverage of the feature.

One mechanical note in the plan's favor: building the style as a concatenated attribute string (`style={\`font-size: ...; --atrium-prose-max-width: ...\`}`) is the right call over Svelte's `style:--atrium-prose-max-width={...}` directive, which compiles to `element.style.setProperty()` - historically unreliable for custom properties under jsdom's `cssstyle`. The plan does not explain why it chose concatenation, but the choice is correct and worth a one-line comment so nobody "modernizes" it later.

---

## 4. Nice-to-have

- **Naming.** The file is `markdownMaxWidth.ts` and exports zero symbols containing "markdownMaxWidth" - everything is `proseWidth` / `PROSE_WIDTH_*` / `clampProseWidth`. That is three names for one concept (file: markdown max width, API: prose width, CSS: `--atrium-prose-max-width`). The plan cites `textSize.ts`-exports-`zoom` as precedent, and it is the one existing mismatch, but "text size" and "zoom" are at least the same user-facing concept; here the filename shares no token with any export. Every other store matches its exports (`tabSize.ts`/`tabSize`, `markdownDefaultView.ts`/`markdownDefaultView`, `wordWrap.ts`/`wordWrapEnabled`). Name the file `proseWidth.ts` to match its exports and the CSS variable, and keep "Max Width" as the UI label.
- **Step count.** 40 to 200 in steps of 10 is 16 clicks end to end. Moot if 3.3 is adopted; if the stepper is kept, consider a step of 20 above 100.
- **Redundant keyword.** `sectionMatchesQuery` builds its haystack as `` `${section.title} ${section.keywords.join(" ")}` ``, so `"max width"` in the keywords array duplicates the implicit title match. Harmless; drop it.

---

## 5. What the plan gets right

Worth stating plainly, since the above is all criticism:

- The mechanism is correct and minimal. Setting an inherited custom property on the one container that CodeMirror mounts into, and letting the existing `var()` consumers pick it up, is the right shape - no new plumbing, no touch to `markdown.css`, no touch to `livePreviewPlugin.ts`, no backend change. The claim that no `markdown.css` change is needed holds.
- The store shape genuinely matches the codebase (synchronous `localStorage` seed, best-effort try/catch persistence, set-and-persist mutators), so there is no FOUC and no new pattern to learn.
- Placing the section in the existing `markdown` category next to `default-view`, with a `SETTINGS_SECTIONS` entry driving the sidebar and search, is exactly how every other setting in this app is wired.
- `DEFAULT_PROSE_WIDTH = 80` preserving today's `app.css:54` value means an untouched install is byte-identical. Correct and important.
- The `.settings-zoom*` -> `.settings-stepper*` rename is safe as claimed, and the reasoning for generalizing rather than duplicating is sound.
- Updating the `app.css` doc comment to name the new writer of the variable is the kind of thing usually skipped, and it is right to include it. It should also be extended to note the new floor once 2.1 is resolved.

---

## 6. Open Questions

```wingman-questions
{
  "questions": [
    {
      "id": "width-control",
      "type": "choice",
      "question": "Should the Max Width setting be a preset dropdown or a continuous stepper?",
      "options": [
        { "label": "Preset dropdown", "recommended": true,
          "detail": "Fewer lines than the stepper (no clamp/step machinery, no CSS class rename), matches the sibling Default View row, and a \"Full\" option delivers the unconstrained case 200ch cannot. Costs the ability to pick an arbitrary value." },
        { "label": "Continuous stepper",
          "detail": "As the plan is written. Allows any value in range; requires fixing the minimum per finding 2.1 and owning that 200ch is a real cap, not \"unlimited\"." }
      ],
      "free_text": true
    },
    {
      "id": "min-width",
      "type": "choice",
      "question": "If the stepper is kept, how should the sub-56ch table regression (finding 2.1) be resolved?",
      "options": [
        { "label": "Raise minimum to 60ch", "recommended": true,
          "detail": "One-constant change; clears the 54ch narrow-column demand with margin and keeps 60ch as a genuinely narrow reading column." },
        { "label": "Derive narrow-column budget from the setting",
          "detail": "Correct in general, but pulls a Svelte store into a pure CodeMirror decoration module and needs its own tests." },
        { "label": "Accept it and rewrite the docstring",
          "detail": "Only if sub-56ch widths are actively wanted; knowingly ships a horizontal scrollbar on ordinary three-column tables." }
      ],
      "free_text": true
    }
  ]
}
```
