// Fixed-timestep game loop with a decoupled render.
// update(dt) is called at a constant STEP; render(alpha) draws, with alpha
// being the interpolation fraction between the last two update steps.

export const STEP = 1 / 60; // seconds per logic tick

export function createLoop(update, render) {
  let last = 0;
  let acc = 0;
  let running = false;
  let rafId = 0;

  function frame(now) {
    if (!running) return;
    const t = now / 1000;
    let delta = t - last;
    last = t;

    // Guard against huge jumps (tab was backgrounded, etc.)
    if (delta > 0.25) delta = 0.25;
    acc += delta;

    while (acc >= STEP) {
      update(STEP);
      acc -= STEP;
    }

    render(acc / STEP);
    rafId = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now() / 1000;
      acc = 0;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
  };
}
