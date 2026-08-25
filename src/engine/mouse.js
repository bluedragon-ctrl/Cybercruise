import { LOGICAL_W, LOGICAL_H } from "./viewport.js";

// Mouse input, canvas-space. Mirrors input.js's held/edge-triggered pattern
// (see consumePress there) but for the pointer: menu.js needs both a level
// state (is the button down right now, for dragging the MUSIC volume bar)
// and an edge-triggered one (did a click just start, so a drag doesn't
// re-trigger every frame the button stays held).

let x = 0;
let y = 0;
let down = false;
let clicked = false; // fresh mousedown, consumed like input.js's `fresh` set

function toCanvasSpace(canvas, e) {
  // Maps to the game's LOGICAL 600x800 space, which is what every caller reads
  // (menu.js hit-tests against the same coordinates it drew in).
  //
  // Deliberately NOT canvas.width/rect.width: the backing store is device
  // pixels, so that ratio would return device coordinates and every hit-test
  // would drift by the raster scale. The element's CSS box maps straight to the
  // logical box — see engine/viewport.js, which sets both.
  const rect = canvas.getBoundingClientRect();
  x = (e.clientX - rect.left) * (LOGICAL_W / rect.width);
  y = (e.clientY - rect.top) * (LOGICAL_H / rect.height);
}

export function initMouse(canvas) {
  canvas.addEventListener("mousemove", (e) => toCanvasSpace(canvas, e));
  canvas.addEventListener("mousedown", (e) => {
    toCanvasSpace(canvas, e);
    down = true;
    clicked = true;
  });
  // Listened on window, not the canvas: a drag that ends with the mouse
  // outside the canvas (dragged past the bar's edge) must still clear
  // `down`, or the volume bar would keep tracking a button that's no longer
  // pressed — same reasoning as input.js's blur handler clearing `held`.
  window.addEventListener("mouseup", () => {
    down = false;
  });
}

export function mousePos() {
  return { x, y };
}

export function isMouseDown() {
  return down;
}

// True ONCE per press, and consumed by asking — see input.js's consumePress
// for why (the caller that reads `true` is the only one that sees it).
export function consumeMouseClick() {
  if (!clicked) return false;
  clicked = false;
  return true;
}
