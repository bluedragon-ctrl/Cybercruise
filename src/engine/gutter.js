// The gutters — the two DOM panels that fill the dead screen either side of the
// cabinet on a window wider than 3:4, and the ONLY part of this game that is
// drawn by the browser rather than by us.
//
// WHY THIS IS NOT ON THE CANVAS. The playfield is 600x800 forever (see
// engine/viewport.js's header on why widening it would retune the whole game),
// so the gutters are by definition outside the canvas element. The two ways to
// put pixels there are a second canvas or DOM, and DOM wins on the only axis
// that matters here: COST PER FRAME.
//
// A second canvas would be a full-height surface repainted on the game's clock,
// which is exactly the shape README's rule 3 exists to prevent — and it would
// need its own raster rebuild on every scale change, doubling the work
// viewport.js's settle timer is there to collapse. These panels instead repaint
// only when their TEXT CHANGES: roughly one row a second on the log, a handful
// of value writes a second on the rig. Between those they cost the compositor a
// layer it already has and the game loop literally nothing, because the game
// loop never touches them.
//
// That "never per frame" is a contract, not an observation, and everything below
// is arranged to keep it:
//
//   - The log's rows are a POOL, rotated (one appendChild) rather than created
//     and destroyed, so a push is O(1) in DOM work and never allocates. The pool
//     grows only when the WINDOW does — see ensurePool.
//   - The age fade is a static CSS mask on the CONTAINER, not per-row opacity.
//     Fading a column of rows by hand would be one style write per row per push
//     to achieve something the compositor does for free.
//   - The rig panel diffs before it writes: a value that reads the same as last
//     sample does not touch the DOM at all, so a parked car costs nothing.
//   - Nothing here animates on a JS timer. The type-on reveal is a CSS
//     animation on ONE row, self-cancelling, and disabled outright under
//     prefers-reduced-motion.
//
// WHY IT IS OUT OF FLOW, WHICH IS LOAD-BEARING. viewport.js computes the
// cabinet's fit from `window.innerWidth` DIRECTLY, not from a container's
// content box (see currentFit there). A panel added as an ordinary sibling of
// #frame would therefore not be subtracted from the width the canvas sizes
// itself against — the cabinet would lay itself out as though the panel were not
// there and the two would collide. `position: fixed` plus the measured
// placement below is what makes these panels incapable of stealing space from
// the playfield: they are told where the cabinet ended up, they never get a
// vote in it. Same discipline as the bezel padding being mirrored in main.js.

// A gutter narrower than this gets no panel at all.
//
// Not a taste call: below roughly this width the log's lines wrap, and a wrapped
// row breaks the fixed row pitch the whole panel is built on. It also happens to
// be about where the panel stops reading as "the room the cabinet sits in" and
// starts reading as a column competing with the game. On the windows this
// feature is for there is far more than this going spare — a 1920x1080 window
// leaves ~570px a side, a 1366x768 one ~410 — and on a portrait or narrow
// window, where the playfield is width-bound and the gutters vanish, both panels
// simply switch off.
const MIN_GUTTER = 260;

// Breathing room between a panel and the cabinet's bezel, and the panel's own
// ceiling. The cap matters more than it looks: given a 2560px-wide window the
// uncapped panel would be 800px of monospace text either side of the game,
// which is a wall, not an ambience.
const GAP = 18;
const MAX_W = 380;

// The log's row pool, sized to the panel it has to fill.
//
// GROWN FROM A MEASUREMENT, not fixed at a guess, and the reason is that the
// row pitch does not scale with the panel. Type size is clamped at 15px
// (see the stylesheet) while the cabinet's height keeps going, so a taller
// window needs strictly MORE rows to fill its column, not the same rows drawn
// bigger — a pool sized for 900px leaves the top half of a 4K column
// permanently blank, which reads as the log having stalled rather than as a log.
//
// It only ever grows, and only when a window grows, so the "constant node count
// per push" property the rotation depends on is untouched: pushing a line never
// allocates. New rows go in at the TOP, because the pool is ordered oldest-first
// and a row that has never held anything is the oldest thing there is.
//
// SLACK is one row of overfill so the topmost visible row is always a real row
// mid-clip rather than the end of the pool, and MAX_ROWS is a sanity stop — at
// the 15px pitch it covers a column about 4600px tall, past any display this
// runs on and cheap enough not to think about if one appears.
const SLACK = 2;
const MAX_ROWS = 200;

let logEl = null;
let logRowsEl = null;
let rigEl = null;
let rigRowsEl = null;
let frame = null;

// The pool, oldest first — rows[0] is the row that gets recycled next, and it is
// also the topmost row in the DOM. Rotating the array and moving that one node
// to the end keeps those two facts true together.
let rows = [];

// Label -> { valueEl, last, lastTone } for the rig panel. Built on first sight
// of a label rather than declared up front, so main.js can change which readouts
// it sends without a matching edit here.
const rigRows = new Map();

let logShowing = false;

// Whether the log panel is actually on screen right now.
//
// Exported because engine/console.js's in-canvas log asks it whether it still
// has to carry the game's whole chatter or can hand the quiet half over — see
// setDivert() there. It is a QUESTION, asked per frame, rather than a flag this
// module pushes: the answer changes on window resizes, which arrive on their own
// schedule and have no business reaching into the renderer.
export function logVisible() {
  return logShowing;
}

function place(el, show, left, top, width, height) {
  if (!show) {
    el.style.display = "none";
    return;
  }
  // "flex", NOT "" — the stylesheet's own rule for .gutter is `display: none`,
  // so clearing the inline value hands the element straight back to it and the
  // panel can never appear. The panel starts hidden in CSS on purpose (it must
  // not flash in the top-left corner between parse and the first layout()), and
  // that is exactly what makes the inline value have to be explicit here.
  el.style.display = "flex";
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.width = `${Math.round(width)}px`;
  el.style.height = `${Math.round(height)}px`;
}

function makeRow() {
  const el = document.createElement("div");
  el.className = "gutter-row";
  // Cleared as soon as the reveal finishes so the NEXT push onto this same
  // recycled row can re-add the class and get a fresh animation out of it.
  el.addEventListener("animationend", () => el.classList.remove("typing"));
  return el;
}

// Top the pool up to whatever the panel can now show.
//
// The pitch is READ, not recomputed from the font size and a line-height factor
// copied out of the stylesheet — that copy would be a second definition of the
// same number, free to drift the moment either is tuned. The computed
// `line-height` is the browser's own answer to the question actually being
// asked, and an empty row contributes no line box, so it is also the only way to
// get the pitch out of a pool that has not been filled yet.
function ensurePool(height) {
  if (!logRowsEl) return;
  const pitch = parseFloat(getComputedStyle(logRowsEl).lineHeight);
  if (!Number.isFinite(pitch) || pitch <= 0) return;
  const want = Math.min(MAX_ROWS, Math.ceil(height / pitch) + SLACK);
  while (rows.length < want) {
    const el = makeRow();
    // Prepended: the pool is ordered oldest-first and pushLog() recycles from
    // the front, so a fresh row has to enter as the oldest or the next push
    // would overwrite a line the player is still reading.
    logRowsEl.insertBefore(el, logRowsEl.firstChild);
    rows.unshift(el);
  }
}

// Measure the cabinet and hang both panels off its edges.
//
// The panels track the CABINET's box, not the window's: matching its top and
// height is what makes the three read as one instrument rather than as a game
// with two unrelated columns near it.
function layout() {
  if (!frame) return;
  const rect = frame.getBoundingClientRect();

  const leftAvail = rect.left;
  const rightAvail = window.innerWidth - rect.right;

  logShowing = leftAvail >= MIN_GUTTER;
  const logW = Math.min(leftAvail - GAP * 2, MAX_W);
  place(logEl, logShowing, rect.left - GAP - logW, rect.top, logW, rect.height);
  // After place(), so the pitch is read at the size the panel is about to be —
  // the type scales with --fit, which viewport.js has already republished by the
  // time any resize reaches us.
  if (logShowing) ensurePool(rect.height);

  const rigShowing = rightAvail >= MIN_GUTTER;
  const rigW = Math.min(rightAvail - GAP * 2, MAX_W);
  place(rigEl, rigShowing, rect.right + GAP, rect.top, rigW, rect.height);
}

// Append a line to the log.
//
// `tone` is a class suffix, not a colour: the stylesheet owns what a "warn" row
// looks like, the same way engine/palette.js owns what one looks like on the
// canvas. Keeping the mapping there rather than here means the two logs can be
// tuned to agree without this file knowing either palette.
export function pushLog(text, tone = "sys") {
  if (rows.length === 0) return;

  // The rotation. rows[0] is both the oldest entry and the topmost node, so
  // moving it to the end of the container makes it the newest row without
  // touching any of the other 33 — no re-parenting of the rest, and the node
  // count never moves.
  const el = rows.shift();
  rows.push(el);
  logRowsEl.appendChild(el);

  el.textContent = text;
  el.className = `gutter-row tone-${tone}`;

  // Restart the type-on. Removing the class and re-adding it a frame later is
  // what makes a RECYCLED row animate again; setting it directly would be a
  // no-op on a row whose animation never got a chance to finish and clear it.
  // The rAF also keeps this off the synchronous layout path — the alternative
  // idiom (read offsetWidth to force a reflow) would flush layout on every push.
  el.classList.remove("typing");
  requestAnimationFrame(() => el.classList.add("typing"));
}

// Publish the rig panel's readouts. `entries` is [{ label, value, tone }].
//
// DIFFED, NOT REWRITTEN. This is called several times a second forever, and the
// overwhelming majority of those calls change one or two numbers — writing all
// nine every time would turn an idle screen into a steady repaint for no visible
// difference. Comparing the string first is cheaper than the write it avoids.
export function setStatus(entries) {
  if (!rigRowsEl) return;
  for (const entry of entries) {
    let row = rigRows.get(entry.label);
    if (!row) {
      const wrap = document.createElement("div");
      wrap.className = "rig-row";
      const label = document.createElement("span");
      label.className = "rig-label";
      label.textContent = entry.label;
      const value = document.createElement("span");
      value.className = "rig-value";
      wrap.appendChild(label);
      wrap.appendChild(value);
      rigRowsEl.appendChild(wrap);
      row = { valueEl: value, last: null, lastTone: null };
      rigRows.set(entry.label, row);
    }
    const text = String(entry.value);
    if (text !== row.last) {
      row.valueEl.textContent = text;
      row.last = text;
    }
    const tone = entry.tone ?? "sys";
    if (tone !== row.lastTone) {
      row.valueEl.className = `rig-value tone-${tone}`;
      row.lastTone = tone;
    }
  }
}

// Blank every row without dropping the pool.
//
// A restart should not leave the previous run's death rattle sitting in the
// gutter, but it also must not rebuild the column to say so — the pool is only
// ever grown by a window resize (see ensurePool), and honouring that here is
// what keeps a restart free.
export function resetLog() {
  for (const el of rows) {
    el.textContent = "";
    el.className = "gutter-row";
  }
}

export function initGutter(frameEl) {
  frame = frameEl;
  logEl = document.getElementById("gutter-log");
  rigEl = document.getElementById("gutter-rig");
  if (!logEl || !rigEl) return;
  logRowsEl = logEl.querySelector(".gutter-rows");
  rigRowsEl = rigEl.querySelector(".rig-rows");

  // The pool starts empty and is filled by the first layout() below, which is
  // the only place that knows how tall the panel actually is.
  rows = [];

  // Both, and they catch different things. The observer fires when the cabinet
  // changes SIZE — including viewport.js's deferred second pass, which lands
  // long after the resize event that triggered it. The window listener catches
  // the case the observer cannot see: a window widened on its long axis leaves
  // the cabinet exactly the same size and merely re-centres it, moving the
  // gutters without resizing anything the observer is watching.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(layout).observe(frameEl);
  }
  window.addEventListener("resize", layout);
  layout();
}
