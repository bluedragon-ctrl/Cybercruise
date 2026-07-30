// Keyboard input: tracks held keys and exposes semantic axes/actions.

const held = new Set();

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
  ShiftLeft: "swap",
  KeyQ: "swap",
};

export function initInput(target = window) {
  target.addEventListener("keydown", (e) => {
    const action = CODE_ALIASES[e.code];
    if (action) {
      held.add(action);
      e.preventDefault();
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
  target.addEventListener("blur", () => held.clear());
}

export function isDown(action) {
  return held.has(action);
}

// -1 (left) .. +1 (right)
export function steerAxis() {
  return (isDown("right") ? 1 : 0) - (isDown("left") ? 1 : 0);
}

// -1 (brake/down) .. +1 (accelerate/up)
export function throttleAxis() {
  return (isDown("up") ? 1 : 0) - (isDown("down") ? 1 : 0);
}
