// Pure text-surgery helpers for the car editor. Given the raw source text of
// cartypes.js or driving.js, replace (or, for driving profiles, insert) the
// specific field values a tuning session changed, leaving every comment,
// every untouched field, and all surrounding formatting exactly as it was.
// There is no AST here — these files are simple, flat object literals, and
// brace-depth matching plus a per-field regex is enough to touch exactly one
// token per change.

export function findMatchingBrace(text, openBraceIndex) {
  if (text[openBraceIndex] !== "{") {
    throw new Error(
      `findMatchingBrace: character at index ${openBraceIndex} is not '{'`
    );
  }
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(
    `findMatchingBrace: no matching '}' for '{' at index ${openBraceIndex}`
  );
}

// Matches either a numeric literal or a bare identifier as the field's
// current value — several CAR_TYPES entries (e.g. interceptor's
// `minDistance: ENEMY_MIN_DISTANCE`) share a constant instead of spelling out
// a literal, and patching one entry should decouple just that entry into its
// own literal rather than failing to find a "numeric" value to replace.
function replaceNumericField(block, field, value) {
  const re = new RegExp(`(\\b${field}:\\s*)(?:-?[0-9.]+|[A-Za-z_$][A-Za-z0-9_$]*)`);
  if (!re.test(block)) return null;
  return block.replace(re, `$1${value}`);
}

// Patches numeric fields on the entry whose `id` matches `id` inside a
// flat catalogue array (CAR_TYPES, OBSTACLE_TYPES — anything shaped like
// them). Every field named in `changes` must already exist in the entry —
// both catalogues set their numeric fields on every type, so a missing
// field means the source has drifted from what the editor read, and this
// throws rather than silently doing nothing. `fnName` is only for error
// messages, so callers below read as themselves rather than as this shared
// helper.
function patchTypeEntry(sourceText, id, changes, fnName) {
  const idMarker = `id: "${id}"`;
  const idIndex = sourceText.indexOf(idMarker);
  if (idIndex === -1) {
    throw new Error(`${fnName}: no entry with id "${id}" found`);
  }

  const objStart = sourceText.lastIndexOf("{", idIndex);
  if (objStart === -1) {
    throw new Error(`${fnName}: no opening '{' found before id "${id}"`);
  }
  // Guard against silently patching the wrong object: lastIndexOf only finds
  // the entry's real opening brace if `id` is the first key. If a `}` sits
  // between that brace and the `id:` line, what we found must actually be the
  // closing brace of some earlier, already-closed object — meaning `id` is
  // NOT the first key here and objStart points at the wrong block entirely.
  if (sourceText.slice(objStart, idIndex).includes("}")) {
    throw new Error(
      `${fnName}: "id" is not the first key in the entry for "${id}" — cannot safely locate its block`
    );
  }
  const objEnd = findMatchingBrace(sourceText, objStart);

  let block = sourceText.slice(objStart, objEnd + 1);
  for (const [field, value] of Object.entries(changes)) {
    const patched = replaceNumericField(block, field, value);
    if (patched === null) {
      throw new Error(`${fnName}: field "${field}" not found on entry "${id}"`);
    }
    block = patched;
  }

  return sourceText.slice(0, objStart) + block + sourceText.slice(objEnd + 1);
}

// Patches health/speedMin/speedMax/minDistance on the CAR_TYPES entry whose
// `id` matches carId.
export function patchCarType(sourceText, carId, changes) {
  return patchTypeEntry(sourceText, carId, changes, "patchCarType");
}

// Patches weight/minDistance on the OBSTACLE_TYPES entry whose `id` matches
// obstacleId. Same catalogue shape as CAR_TYPES (a flat array of objects
// with `id` as the first key), so the same text-surgery applies unchanged.
export function patchObstacleType(sourceText, obstacleId, changes) {
  return patchTypeEntry(sourceText, obstacleId, changes, "patchObstacleType");
}

// Patches weight/minDistance on the PICKUP_TYPES entry whose `id` matches
// pickupId. Same catalogue shape as CAR_TYPES/OBSTACLE_TYPES, so the same
// text-surgery applies unchanged.
export function patchPickupType(sourceText, pickupId, changes) {
  return patchTypeEntry(sourceText, pickupId, changes, "patchPickupType");
}

// Patches price/amount/duration on a CONSUMABLES entry, or price/step on a
// STATS entry, in game/upgrades.js — whichever `id` matches. Both arrays are
// flat objects with `id` first, exactly like CAR_TYPES/OBSTACLE_TYPES/
// PICKUP_TYPES above, so the same brace-matching text-surgery applies
// unchanged; the two shelves share one function here for the same reason they
// share one file in the game source.
export function patchUpgradeEntry(sourceText, id, changes) {
  return patchTypeEntry(sourceText, id, changes, "patchUpgradeEntry");
}

function replaceStringField(block, field, value) {
  const re = new RegExp(`(\\b${field}:\\s*)"[^"]*"`);
  if (!re.test(block)) return null;
  return block.replace(re, `$1"${value}"`);
}

const STRING_FIELDS = new Set(["laneHome"]);
const INSERT_INDENT = "    ";

// Patches (or adds — see Task 4) fields on the driving profile named
// `profileName` — the argument object of `<profileName>: profile({ ... })`
// in driving.js.
export function patchDrivingProfile(sourceText, profileName, changes) {
  const marker = `${profileName}: profile({`;
  let markerIndex = sourceText.indexOf(marker);
  if (markerIndex === -1) {
    // A profile that takes the defaults wholesale is written `profile()`, with
    // no argument object at all — the commuter reference is exactly that, and
    // it's the profile the sedan (and every unnamed car) drives. There is no
    // `{` there to patch into, so give it an empty one and fall through to the
    // ordinary insertion path below, which then adds the field as it would to
    // any other profile that doesn't override it yet.
    const bare = `${profileName}: profile()`;
    const bareIndex = sourceText.indexOf(bare);
    if (bareIndex === -1) {
      throw new Error(`patchDrivingProfile: no "${profileName}: profile({" found`);
    }
    sourceText =
      sourceText.slice(0, bareIndex) +
      `${profileName}: profile({
  })` +
      sourceText.slice(bareIndex + bare.length);
    markerIndex = sourceText.indexOf(marker);
  }

  const objStart = markerIndex + marker.length - 1; // index of the '{'
  const objEnd = findMatchingBrace(sourceText, objStart);

  let inner = sourceText.slice(objStart + 1, objEnd);
  for (const [field, value] of Object.entries(changes)) {
    const isString = STRING_FIELDS.has(field);
    const patched = isString
      ? replaceStringField(inner, field, value)
      : replaceNumericField(inner, field, value);

    if (patched !== null) {
      inner = patched;
    } else {
      // Not overridden yet — append a new line just before the closing
      // brace instead of touching whatever line happens to be last, so the
      // diff reads as a pure addition. Single-line profiles like
      // `profile({ nerve: 12 })` have no trailing comma on their last field
      // (multi-line ones always do), so one has to be added here or the
      // insertion produces invalid JS.
      const literal = isString ? `"${value}"` : `${value}`;
      let trimmed = inner.replace(/\s+$/, "");
      if (trimmed.length > 0 && !trimmed.endsWith(",")) trimmed += ",";
      inner = trimmed + `\n${INSERT_INDENT}${field}: ${literal},\n  `;
    }
  }

  return sourceText.slice(0, objStart + 1) + inner + sourceText.slice(objEnd);
}

// Patches numeric fields on a WEAPON_TYPES or ENEMY_WEAPON_TYPES entry in
// game/weapons.js. Both arrays live in one file and both are flat objects with
// `id` first, exactly like the four catalogues above, so one function covers
// the player's kit and the hostiles' alike — the same reasoning that lets the
// shop's two shelves share patchUpgradeEntry.
export function patchWeaponType(sourceText, weaponId, changes) {
  return patchTypeEntry(sourceText, weaponId, changes, "patchWeaponType");
}

// --- Bare module constants --------------------------------------------------
//
// Not everything worth tuning lives in a catalogue array. The player's own
// figures (player.js), how busy the road is (traffic.js), the road's shape
// (tuning.js) and the run's pacing (hauler.js, score.js) are all plain
// `const NAME = <number>;` declarations, and the entity patchers above cannot
// reach them — there is no `id: "..."` to anchor on.
//
// Anchored to the start of a line, which is where a declaration always sits;
// that is also what keeps this from matching the same name mentioned inside
// one of these files' (very long) explanatory comments. `export` is optional
// because several of the most useful figures — traffic.js's MAX_CARS and
// SPAWN_INTERVAL, player.js's STEER_SPEED — are module-private, read only by
// the file that declares them.
export function patchConstant(sourceText, name, value) {
  // String.raw so the backslashes below reach the RegExp constructor intact —
  // a plain template literal eats `\[` down to `[`, which silently turns the
  // pattern into something that matches nothing.
  const re = new RegExp(
    String.raw`^([ 	]*(?:export[ 	]+)?const[ 	]+${name}(?![A-Za-z0-9_$])[ 	]*=[ 	]*)` +
      String.raw`(?:-?[0-9.]+(?:[eE]-?[0-9]+)?|[A-Za-z_$][A-Za-z0-9_$]*)`,
    "m"
  );
  if (!re.test(sourceText)) {
    throw new Error(`patchConstant: no "const ${name} = <number>" declaration found`);
  }
  return sourceText.replace(re, `$1${value}`);
}

// One element of a `const NAME = [a, b, c];` array literal, by index. Only
// upgrades.js's TIER_PRICES needs this today — the shop's price ladder is an
// array rather than three separate constants, and tiers 2 and 3 are the two
// numbers in it that are actually a balance decision.
export function patchArrayConstantElement(sourceText, name, index, value) {
  const re = new RegExp(
    String.raw`^([ 	]*(?:export[ 	]+)?const[ 	]+${name}(?![A-Za-z0-9_$])[ 	]*=[ 	]*\[)([^\]]*)(\])`,
    "m"
  );
  const match = sourceText.match(re);
  if (!match) {
    throw new Error(`patchArrayConstantElement: no "const ${name} = [...]" declaration found`);
  }
  const elements = match[2].split(",");
  if (index < 0 || index >= elements.length) {
    throw new Error(
      `patchArrayConstantElement: ${name} has ${elements.length} elements, no index ${index}`
    );
  }
  // Rewrite only the one element, preserving whatever spacing the others use.
  const rewritten = elements[index].replace(
    /(^\s*)(?:-?[0-9.]+(?:[eE]-?[0-9]+)?|[A-Za-z_$][A-Za-z0-9_$]*)(\s*$)/,
    `$1${value}$2`
  );
  if (rewritten === elements[index]) {
    throw new Error(`patchArrayConstantElement: ${name}[${index}] is not a plain value`);
  }
  elements[index] = rewritten;
  return (
    sourceText.slice(0, match.index) +
    match[1] + elements.join(",") + match[3] +
    sourceText.slice(match.index + match[0].length)
  );
}

