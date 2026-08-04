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

function replaceNumericField(block, field, value) {
  const re = new RegExp(`(\\b${field}:\\s*)-?[0-9.]+`);
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
  const markerIndex = sourceText.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`patchDrivingProfile: no "${profileName}: profile({" found`);
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
