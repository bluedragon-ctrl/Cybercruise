// Keyboard input: tracks held keys and exposes semantic axes/actions.

const held = new Set();

// Actions pressed since anyone last asked. Separate from `held` because some
// actions are STATES (steering: true for as long as the key is down) and some
// are EVENTS (swapping weapons: one swap per press, however long the key is
// held). Auto-repeat is filtered out here too — a held key fires keydown over
// and over, which would cycle the whole loadout in half a second.
const fresh = new Set();

const CODE_ALIASES = {
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  Space: "fire",
  // Enter doubles as "fire" so the start screen's confirm key (game/menu.js)
  // is the same key that shoots in play — one action, two contexts, rather
  // than a separate "confirm" action nothing else would ever use.
  Enter: "fire",
  Tab: "swap",
  ShiftLeft: "swap",
  KeyQ: "swap",
  // Numpad 0 mirrors TAB — for a player steering with the ARROW keys, whose
  // left hand is free to rest on the numpad instead of stretching to Q or
  // Shift. Same action, same edge-triggered cycle, nothing about swap() cares
  // which key asked for it.
  Numpad0: "swap",
  // Deployables get their own key rather than living in the TAB cycle above:
  // laying one is a snap decision made while a gun is still selected, not a
  // reason to tab away from it and back. See weapons.js's Loadout.next().
  ControlLeft: "mine",
  ControlRight: "mine",
  // THERE IS NO SELECTOR FOR THEM, and E and Numpad . are free again because of
  // it. The player carries one deployable; what it drops is changed by an
  // upgrade bought at the dock (upgrades.js's SPIKE MINES), not by a key held
  // over from when there were two. See weapons.js's Loadout — the second
  // cursor is still there, nothing cycles it.
  Escape: "pause",
};

export function initInput(target = window) {
  target.addEventListener("keydown", (e) => {
    const action = CODE_ALIASES[e.code];
    if (action) {
      // e.repeat marks the OS auto-repeat that follows a held key. The key is
      // already in `held`, so this only guards the one-shot channel.
      if (!e.repeat) fresh.add(action);
      held.add(action);
      e.preventDefault(); // Tab would otherwise walk the browser's focus ring
    }
  });
  target.addEventListener("keyup", (e) => {
    const action = CODE_ALIASES[e.code];
    if (action) {
      held.delete(action);
      e.preventDefault();
    }
  });
  // Drop all keys if focus is lost so the car doesn't "stick".
  target.addEventListener("blur", () => {
    held.clear();
    fresh.clear();
  });
}

export function isDown(action) {
  return held.has(action);
}

// True ONCE per press, and consumed by asking: the caller that gets the `true`
// is the only one that sees it. Written this way rather than as a per-frame
// "clear the edge flags" step so nothing has to remember to call it — a game
// loop that forgot would either drop presses or repeat them forever.
export function consumePress(action) {
  if (!fresh.has(action)) return false;
  fresh.delete(action);
  return true;
}

// -1 (left) .. +1 (right)
export function steerAxis() {
  return (isDown("right") ? 1 : 0) - (isDown("left") ? 1 : 0);
}

// -1 (brake/down) .. +1 (accelerate/up)
export function throttleAxis() {
  return (isDown("up") ? 1 : 0) - (isDown("down") ? 1 : 0);
}
