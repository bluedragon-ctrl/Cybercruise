# Enemy car editor — design

Date: 2026-08-03

> **SUPERSEDED — kept as the record of what was designed, not of what shipped.**
> This spec scopes the tool to five enemy car types and their driving profiles.
> The tool that exists is a TUNING EDITOR FOR THE WHOLE GAME: five tabs — Cars
> (civilian and hostile alike), Hazards & pickups, Weapons, Shop, and World —
> covering essentially every balance number in the source. The reasoning below
> about patching by text surgery, gating the push on the test suite, and
> finishing the PR on GitHub's compare page all still describes the shipped
> tool; the SCOPE does not. For what the tool actually does today, see the
> README's "Tuning editor" section.

## Purpose

A local, browser-based tool for tuning enemy car parameters — hull, speed, and
driving behavior — without hand-editing `cartypes.js`/`driving.js` and without
memorizing what each behavior knob does. On confirmation it opens a pull
request with the change, so a tuning session ends the same way a normal
contribution would.

## Scope

- **Editable cars**: the 5 `ENEMY_FACTION` types only — `interceptor`,
  `stocker`, `cycle`, `bruiser`, `rival`. Civilian types are out of scope.
- **Editable fields**, per car:
  - **Hull** — `health` (`cartypes.js`)
  - **Speed** — `speedMin`, `speedMax` (`cartypes.js`)
  - **Behavior** — every field of that car's own driving profile
    (`driving.js`): `followGap`, `followReaction`, `laneDiscipline`,
    `laneHome`, `patience`, `passTrigger`, `passMargin`, `passTimeout`,
    `passSpeedMargin`, `passClearance`, `passLookBehind`, `passLookAhead`,
    `passEffort`, `hazardClearance`, `nerve`, `contact`.
- **Not editable**: the tactic (`behaviour` key — pursue/ram/weave/...), mass,
  steerSpeed, blastRadius/Damage, value, weight, minDistance, anything about
  civilian types.
- **Not in scope**: authentication/multi-user concerns — this is a
  single-developer local tool, run on the machine that already has push
  access to the repo.
- **Known limitation**: each of the 5 enemy types currently owns its driving
  profile 1:1 (`pursuer`, `roadracer`, `darter`, `batterer`, `duelist` are each
  driven by exactly one type), which is what makes "edit this car's behavior"
  safe today. If a future car type is added that names one of these same
  profiles, editing "that car's behavior" would silently retune every type
  sharing it. The editor does not defend against this now; if it becomes
  possible, the read step should warn when a profile has more than one driver
  (`typesDriving` in `driving.js` already computes this).

## Architecture

```
tools/car-editor/
  server.js     Node HTTP server (no dependencies), serves the UI and exposes
                the read/apply API, runs the git workflow
  editor.html   Static page: car selector + grouped field forms
  editor.css    Styling, consistent with the project's neon theme where cheap
  editor.js     Fetches state, renders forms + descriptions, builds the diff
                preview, posts changes, displays git-flow progress/results
  edit.bat      Launcher: starts server.js, opens the browser to it
  patcher.js    Pure function(s) that patch cartypes.js/driving.js source text
                given a list of field changes — the one part worth unit
                testing in isolation from git/network
```

No new npm dependencies. `"type": "module"` already applies to the whole
project, so `server.js` can `import` `CAR_TYPES`, `DRIVING_PROFILES`, and
`drivingFor` directly from `src/game/`, exactly as `tools/drivesim.js` already
does — reads always reflect the real, current values (including inherited
profile defaults), never a stale snapshot.

## Data flow

**Read (GET `/api/state`)**
1. Server imports `cartypes.js` and `driving.js` fresh (Node's ESM cache means
   the server must be restarted to pick up manual source edits made while it's
   running — acceptable for a local dev tool).
2. For each of the 5 enemy types, resolve hull/speed from `CAR_TYPES` and the
   effective driving profile via `drivingFor(type)`.
3. Return one JSON object per car: current values for every editable field,
   plus which behavior fields are inherited from `commuter` vs explicitly
   overridden by this car's own profile (drives the "(new override)" label
   later).
4. Field descriptions are **not** derived from source comments (too fragile to
   parse reliably) — they're a small hand-authored metadata table in
   `editor.js`, written from the same understanding captured in the source
   comments, one line per field.

**Edit (client-side only)**
- Selecting a car renders its form, grouped as: Hull, Speed, Following, Lane
  discipline, Overtaking, Hazards, Nerve — mirroring `driving.js`'s own
  section headers.
- Each field: label, current value, input (`number` for numeric fields,
  `select` for `laneHome`'s "any"/"inner"/"outer"), and its description
  underneath.
- Edits accumulate in browser memory across cars in the session (switching
  car and back preserves unsaved edits for both).
- "Review changes" renders a table: car, field, old → new, and an
  "(new override)" tag for behavior fields not previously present in that
  car's profile object. Nothing is written to disk yet.

**Apply (POST `/api/apply`)**
1. Body: the accumulated `{carId: {field: newValue}}` diff.
2. **Preflight**: `git status --porcelain -- src/game/cartypes.js
   src/game/driving.js` must be empty, and `src/game/behaviours.js`/anything
   else is irrelevant to this check. If not empty, abort with an error naming
   the dirty file(s) — never touch files with unrelated in-progress edits.
3. Record the current branch name (`git rev-parse --abbrev-ref HEAD`) to
   restore it later.
4. `git checkout -b car-editor-<YYYYMMDD-HHMMSS>`.
5. For each affected file, load its current text and run it through
   `patcher.js`, which:
   - For `cartypes.js`: finds the object whose `id: "<carId>"` matches, scoped
     to that object's `{ ... }` span (brace-depth scan from the `id:` line),
     and replaces the `health:`/`speedMin:`/`speedMax:` value tokens in place.
   - For `driving.js`: finds `<profileName>: profile({ ... })` for the car's
     `driving` key, scoped to that call's argument object span, and either
     replaces an existing `key: value` token or inserts a new `key: value,`
     line just after the opening `{` if the field wasn't previously
     overridden.
   - Only lines whose value actually changes are touched — this is a minimal,
     reviewable diff, not a reformat.
6. Write the patched text back to both files (only the ones actually
   changed).
7. `git add src/game/cartypes.js src/game/driving.js` (never `-A`).
8. `git commit -m` with an auto-generated message: a summary line plus one
   bullet per changed field (`interceptor: speedMax 470 → 500`, etc).
9. Run `node --test test/` on the new commit.
   - **Pass** → continue.
   - **Fail** → stop here, surface the test output to the UI, and offer two
     choices: **Cancel** (hard-reset the branch to before the commit, checkout
     back to the original branch, delete the temp branch) or **Push anyway**
     (proceeds to step 10, acknowledging the risk).
10. `git push -u origin car-editor-<timestamp>`.
    - On failure (auth/network/rejected): report the error, stay on the new
      branch (don't discard the commit), so the user can retry the push
      manually.
11. `git checkout <original-branch>` — restores the working tree exactly as
    it was before the tool ran; the tuning now lives only on the pushed
    branch.
12. Respond to the UI with the compare URL:
    `https://github.com/bluedragon-ctrl/Cybercruise/compare/<original-branch>...car-editor-<timestamp>?expand=1`.
13. `editor.js` opens that URL in a new tab and shows it as a link too, so the
    user finishes creating the PR (title/description/reviewers) on GitHub
    itself — this tool does not call the GitHub API or need a token.

## Error handling

- Missing `git` on PATH: server checks on startup, fails fast with an install
  hint.
- Dirty working tree on the two target files: aborts before any git command
  runs (step 2 above).
- Branch name collision: timestamp includes seconds, effectively won't
  collide in normal use; if `checkout -b` still fails, surface the raw git
  error.
- Test failures: surfaced verbatim, decision left to the user (cancel or
  push anyway) rather than silently blocking or silently pushing.
- Push failures: branch/commit preserved, error surfaced, no automatic
  retry.
- Any exception in `patcher.js` (e.g. a field/car id not found in the source
  text — should be impossible given the state came from importing the same
  file, but the file could have changed on disk since the server started):
  abort before writing anything, report which field/car could not be
  located.

## Testing

- Unit tests for `patcher.js` (`tools/car-editor/patcher.test.js`, run via the
  existing `node --test`): given small sample source snippets shaped like the
  real files, assert that patching a field changes only that token, adding an
  unset field inserts it correctly, and unrelated lines/comments are
  byte-for-byte unchanged.
- No automated test for the git/network/browser flow — it's a thin
  orchestration layer over `git` and `node --test`, exercised manually.
- Manual verification: run the editor, tune a value, confirm a PR opens with
  exactly the expected diff, and that `npm test` still passes on the new
  branch.
