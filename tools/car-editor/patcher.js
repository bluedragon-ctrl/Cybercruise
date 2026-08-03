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
  const re = new RegExp(`(\\b${field}:\\s*)[0-9.]+`);
  if (!re.test(block)) return null;
  return block.replace(re, `$1${value}`);
}

// Patches health/speedMin/speedMax on the CAR_TYPES entry whose `id` matches
// carId. Every field named in `changes` must already exist in the entry —
// cartypes.js always sets health/speedMin/speedMax on every type, so a
// missing field means the source has drifted from what the editor read, and
// this throws rather than silently doing nothing.
export function patchCarType(sourceText, carId, changes) {
  const idMarker = `id: "${carId}"`;
  const idIndex = sourceText.indexOf(idMarker);
  if (idIndex === -1) {
    throw new Error(`patchCarType: no entry with id "${carId}" found`);
  }

  const objStart = sourceText.lastIndexOf("{", idIndex);
  if (objStart === -1) {
    throw new Error(`patchCarType: no opening '{' found before id "${carId}"`);
  }
  const objEnd = findMatchingBrace(sourceText, objStart);

  let block = sourceText.slice(objStart, objEnd + 1);
  for (const [field, value] of Object.entries(changes)) {
    const patched = replaceNumericField(block, field, value);
    if (patched === null) {
      throw new Error(
        `patchCarType: field "${field}" not found on entry "${carId}"`
      );
    }
    block = patched;
  }

  return sourceText.slice(0, objStart) + block + sourceText.slice(objEnd + 1);
}
