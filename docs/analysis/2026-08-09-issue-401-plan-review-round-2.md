# Review round 2: implementation plan for issue #401 (configurable rendered-markdown max width)

**Plan under review:** `docs/analysis/2026-08-09-issue-401-markdown-max-width-plan.md`, revision 2
**Prior round:** `docs/analysis/2026-08-09-issue-401-plan-review.md` (round 1: request changes; one must-fix, three should-fix, three nice-to-have)
**Reviewed against:** the working tree at `4e57a1e`, confirmed caught up with `origin/main` (`git-freshness-check.sh`: `fresh:HEAD already contains origin/main`, `path-same` for the plan itself)

**Verdict: approve.** Every round-1 item is addressed, and the switch from a continuous stepper to a preset dropdown dissolves the must-fix rather than patching around it. The revision's one refusal to adopt a round-1 claim is correct - I re-derived it independently and round 1 was wrong on that point.

Two implementation-level notes follow (§3). Neither is a design defect and neither blocks the plan; §3.1 in particular is a test that will fail on first run if written exactly as the plan describes it, so it is worth reading before writing that test rather than after.

---

## 1. Verification of revision 2's factual claims

Every citation new or changed in revision 2 was checked against the real files. All are exact:

| Plan claim | Actual | Verdict |
|---|---|---|
| `app.css:54` - `--atrium-prose-max-width: 80ch`; doc comment at `:48-54` | comment `48-53`, declaration `54` | exact |
| `markdown.css:595-601` `.cm-code-block`, bare unscoped selector, `margin-inline-start` only, no `max-width` | selector `595`, `margin-inline-start` at `600`, closing brace `601`; no `max-width` in the rule | exact, including the "margin only" qualifier |
| `markdown.css:48-53` / `:135-137` / `:562-564` / `:632-635` | all four | exact |
| `decorations.ts:743-762` carries `NARROW_COLUMN_MAX_CHARS`/`MAX_NARROW_COLUMNS`; §5 targets `:751-762` | `743-748` docstring, `749` const; `751-761` docstring, `762` const. The stale "65ch" sentence is `759-760` | exact (cites the block) |
| `Dropdown.svelte` props `{options: {id,label}[], value, onSelect, label}` | `src/lib/ui/Dropdown.svelte:12-23`, `DropdownOption = {id, label}` at `:4` | exact |
| `SettingsDialog.svelte:301-313` default-view block; options built at `:35-38` | block `301-313`, `MARKDOWN_VIEW_OPTIONS` `35-38` | exact |
| `settingsRegistry.ts:84-89` `"default-view"` entry, last in the array before `"dock-position"` | `84-89` | exact |
| `SettingsDialog.test.ts:817-845` default-view `describe`; `:59-68` store-reset list | `817-845`, resets `59-68` | exact (round 1's off-by-one is fixed) |
| `EditorPane.svelte:741` - the `.editor-pane` div | `741`, `style={\`font-size: ${$zoom * 100}%\`}` | exact |
| `livePreviewPlugin.ts:314` adds `cm-md-rendered`; `:327-329` omits it | `314` is the only site of the marker anywhere in `src/` | exact |

Mechanism claims that also check out:

- **`100cqw` substitutes correctly into every existing expression.** All six use sites are either `max-width: min(var(--atrium-prose-max-width), 100cqw)` or `margin-inline-start: max(0px, (100cqw - var(--atrium-prose-max-width)) / 2)`. Under `"full"` these become `min(100cqw, 100cqw)` (the pane's width) and `max(0px, 0)` = `0` (flush left, no centering inset). Both are valid CSS and both are the intended behavior. No special case needed, as the plan claims. Confidence: high.
- **`cqw` resolves against the right container.** `container-type: inline-size` sits on `.cm-scroller` (`markdown.css:14-16`), which is inside `.editor-pane` and above every consumer. Because `--atrium-prose-max-width` is an unregistered custom property, its value substitutes as a token stream and `cqw` resolves at the point of *use* - a `.cm-line` inside `.cm-scroller` - not where it is declared. Declaring it on `.editor-pane`, which is itself outside the container, is therefore fine. Confidence: high.
- **The storage key matches convention.** `atrium.markdown.proseWidth` fits the `atrium.<category>.<name>` shape used by every store (`atrium.markdown.defaultView`, `atrium.editor.tabSize`, `atrium.textSize.zoom`, ...).
- **The store is a faithful `tabSize.ts` clone.** Same `STORAGE_KEY` / `OPTIONS as const` / derived type / `DEFAULT` / type guard / `load`/`save` with try-catch / `writable(load())` / set-and-persist mutator, in the same order, with the same docstring wording. The one deviation - dropping `tabSize`'s `typeof value === "number"` pre-check from the guard - is required, since the option set is a mixed `number | "full"` union; `Array.prototype.includes` on the widened tuple is correct on its own.
- **The proposed `EditorPane` assertion works under jsdom.** `EditorPane.activation.test.ts:37` reads `getAttribute("style")`, i.e. the raw attribute string, not a `cssstyle`-parsed declaration. A custom property in a concatenated `style={...}` attribute survives that path intact. The plan's inline comment explaining why the `style:--custom-prop` directive is avoided is correct and worth keeping.
- **The registry array is not sorted.** It is grouped by category in rough display order (`theme`, then the two `general` entries, then five `editor`, then `markdown`, then `terminal`), so inserting `"max-width"` after `"default-view"` is both correct and the only placement that puts the new section below Default View in the pane.
- **`"max width"` really is a redundant keyword.** `sectionMatchesQuery` (`settingsRegistry.ts:99-103`) builds its haystack as `` `${section.title} ${section.keywords.join(" ")}` ``, so the title "Max Width" already matches that query. Dropping it is right.
- **`SettingsDialogSearchSections.test.ts` is unaffected.** It mocks `settingsRegistry` with its own three-entry `SETTINGS_SECTIONS` (`:14-26`), so it cannot break on a real registry addition.

---

## 2. The round-1 claim revision 2 declines to adopt

Revision 2 rejects round 1's assertion (§3.1, second bullet) that `decorations.ts` emits inline styles referencing `var(--atrium-prose-max-width)`, asserted by `decorations.test.ts:2595-2757`. **Revision 2 is right and round 1 was wrong.** Verified independently:

- `grep -rn "atrium-prose-max-width" src/` returns exactly one hit in `decorations.ts`, at `:754`, inside the `MAX_NARROW_COLUMNS` docstring. No inline style in that module references the variable.
- The six assertions at `decorations.test.ts:2595-2757` all run against `body`, produced by `ruleBodyFor` (`:30-47`), which regex-matches a selector's rule body out of `markdownCss` - the result of `readFileSync` on `src/styles/markdown.css` (`:28`). They assert on the stylesheet's own text, not on any decoration output.

The consumer inventory in revision 2's "Problem" section (five entries, with `.cm-code-block` correctly flagged as bare and margin-only) is therefore complete and accurate. The correction to the *justification* for applying the property unconditionally - that `.cm-code-block` is a `livePreviewPlugin`-only decoration class rather than that every consumer is `.cm-md-rendered`-scoped - is the right reasoning and now stated in both places it appears (§Existing state and §2).

---

## 3. Implementation notes

Neither is a defect in the design; both are things the plan asserts or implies that will not survive contact with the code exactly as written.

### 3.1 The new `SettingsDialog` test cannot mirror the default-view block literally - the shared `dropdownTrigger` helper will open the wrong dropdown

The plan says the new `describe("markdown max width", ...)` block should mirror `describe("markdown default view", ...)` (`SettingsDialog.test.ts:817-845`). That block's own helper does:

```ts
await fireEvent.click(dropdownTrigger(container));
```

and `dropdownTrigger` (`SettingsDialog.test.ts:738-740`) is `container.querySelector(".dropdown-trigger")` - **first match in DOM order**. It works today because every category that has a dropdown has exactly one (Appearance: Theme; Editor: Tab Size; Markdown: Default View; Terminal: Dock Position). This change makes Markdown the first category with two.

Written as described, the new test opens the *Default View* dropdown and then fails looking for an option named `"80ch"`.

Fix, in order of preference:

1. Target the trigger by its accessible name: `Dropdown.svelte:127` puts the `label` prop on the trigger as `aria-label`, so `screen.getByLabelText("Max width of rendered markdown")` selects it unambiguously and stays correct if a third dropdown is ever added to the category. This also matches how the existing zoom tests key on ARIA and text rather than structure.
2. Index into `container.querySelectorAll(".dropdown-trigger")[1]` - works, but is positional and silently wrong the moment section order changes.

**Related, and worth one line in "Regressions checked":** the existing default-view test survives *only because* the new section is placed after `"default-view"` in both the markup and the registry. If it were placed before, `dropdownTrigger` would start returning the Max Width trigger and `SettingsDialog.test.ts:817-845` would break. The plan already specifies the correct order; the point is that the ordering is load-bearing for an existing test, not just cosmetic, so it should be recorded as such.

### 3.2 §5 should also correct `NARROW_COLUMN_MAX_CHARS`'s docstring, not only `MAX_NARROW_COLUMNS`'s

§5 replaces the stale "clears even the 65ch this variable shipped with" at `decorations.ts:759-760`. Correct. But the sibling constant's docstring, `decorations.ts:744-747`, closes with:

> Sized so a narrow column's demand - this plus the ~2ch its `0.6em` side padding comes to at the editor's monospace metrics - **stays a small fraction of the reading column.**

18ch against the new 60ch floor is 30% of the reading column, and the three-column aggregate is 54ch of 60ch. "A small fraction" was defensible against a fixed 80ch; it is not against a user-selectable 60ch. This is exactly the reason §5 exists - the plan's own argument is that these docstrings stop being incidentally-true documentation and become claims the feature makes contractual. The same argument reaches six lines up. One sentence, same edit site.

---

## 4. Residual risk, recorded rather than requested

Flagging this for the record, not as a change request. The plan's floor is defensible and I am not asking for it to move.

**The 60ch preset leaves 6ch of headroom, where the constant was originally calibrated with 11ch.** The documented invariant holds: three narrow columns demand at most 54ch, and 54 < 60. But the docstring's own framing ("clears even the 65ch this variable shipped with") describes a design that budgeted 54ch inside 65ch, leaving 11ch for whatever other columns the table has. At the 60ch preset that shrinks to 6ch, so a four-column table with three narrow columns plus one prose column overflows into a horizontal scrollbar as soon as the prose column's longest word exceeds ~4 characters:

```markdown
| Status      | Owner        | Updated    | Notes                                    |
|-------------|--------------|------------|------------------------------------------|
| In progress | greerviau    | 2026-08-09 | Waiting on the upstream implementation.  |
```

Three columns qualify as narrow (`widest <= 16`), the count is `<= 3`, so all three get `text-wrap: nowrap` and cannot be squeezed; the Notes column squeezes down to its longest word ("implementation", ~14ch + 2ch padding). 54 + 16 = 70ch against a 60ch cap, and `.cm-table-scroll`'s `overflow-x: auto` traps the excess.

Why this is not a request for changes:

- It is not the round-1 defect. Round 1's must-fix was a table that *would have wrapped fine* being forced to scroll purely by the nowrap decision. Here the table's genuine min-content already exceeds the cap, and the user explicitly chose the narrowest column offered. Some content overflowing a deliberately narrow reading column is the setting working, not failing.
- The degradation is a horizontal scrollbar on an already-wide table, not lost content, and it is confined to the narrowest of five presets.
- 60ch is what round 1 recommended, and the plan follows that recommendation faithfully.

If the requester would rather not spend the headroom, raising the lowest preset from 60 to 70 restores the original calibration exactly and costs one digit in `PROSE_WIDTH_OPTIONS` plus the matching number in §5's docstring text. That is a taste call about how narrow a reading column should be offered, and it is theirs, not mine.

---

## 5. Round-1 items, dispositions

| Round-1 item | Severity | Disposition | Verified |
|---|---|---|---|
| 2.1 `MIN_PROSE_WIDTH = 40` breaks the `MAX_NARROW_COLUMNS` invariant | must-fix | Dissolved: the preset floor is 60ch, clearing the 54ch demand. `decorations.ts` docstring corrected regardless (§5) | yes - see §4 for the residual headroom note |
| 3.1 Consumer inventory incomplete; the stated justification was false | should-fix | `.cm-code-block` added with the correct "bare, margin-only" qualifier; the justification replaced with the real reason (`livePreviewPlugin`-only class). Round 1's second bullet correctly refused | yes - see §2 |
| 3.2 "200ch is effectively unconstrained" is false across the zoom range | should-fix | Moot: `"full"` maps to `100cqw`, not a `ch` figure, so it does not scale with zoom | yes - substitution verified against all six use sites |
| 3.3 A preset dropdown is genuinely smaller | should-fix (decision) | Adopted. No `MIN`/`MAX`/`STEP`/`clamp`, no `.settings-zoom*` -> `.settings-stepper*` rename, no new CSS | yes - `Dropdown` props and the sibling row's shape match |
| 3.4 The `EditorPane` test is tautological | should-fix | Testing section now states the jsdom limit explicitly and names the manual check that actually verifies the rendered column. The concatenation-over-`style:`-directive choice is now explained in a comment | yes |
| 4.1 Naming: `markdownMaxWidth.ts` vs `proseWidth` exports | nice-to-have | Adopted: `proseWidth.ts` | yes |
| 4.2 Step count | nice-to-have | Moot under the dropdown | - |
| 4.3 Redundant `"max width"` keyword | nice-to-have | Dropped | yes |

---

## 6. What this revision gets right

- **It resolves the must-fix by construction rather than by clamping.** Choosing a design where the failure cannot be expressed beats adding a `MIN` constant that a future edit can lower without re-deriving the table math. The comment above `PROSE_WIDTH_OPTIONS` naming the 54ch constraint is the right guard for the case where someone does want to add a lower preset.
- **`"full"` is `100cqw`, not a big `ch` number.** This is the substantive design improvement over revision 1. A `ch`-denominated maximum cannot be unlimited across a 4x zoom range; a container-relative one is unlimited by definition, and it costs nothing because the existing `min()`/`max()` expressions already speak `cqw`.
- **It pushed back on a round-1 claim with evidence instead of complying.** Round 1 was wrong about `decorations.ts` emitting inline styles, and the revision says so, cites the actual mechanism (`ruleBodyFor` reading the stylesheet off disk), and does not quietly write a fix for a defect that does not exist.
- **The scope is still minimal and unchanged in shape from revision 1's one good idea:** one inherited custom property on the single container CodeMirror mounts into, no `markdown.css` change, no `livePreviewPlugin.ts` change, no backend change, `DEFAULT_PROSE_WIDTH = 80` keeping an untouched install byte-identical.
- **The documentation edits are included rather than deferred.** Both the `app.css` comment naming the new writer of the variable and the `decorations.ts` docstring correction are in scope. §3.2 above asks only that the second one reach six lines further up.

---

## 7. Open questions

None blocking. The one taste call recorded in §4 (lowest preset 60ch vs 70ch) is the requester's, and the plan is implementable as written either way.
