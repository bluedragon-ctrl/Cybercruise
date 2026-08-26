// Fixed-timestep game loop with a decoupled render.
// update(dt) is called at a constant STEP; render(alpha) draws, with alpha
// being the interpolation fraction between the last two update steps.

export const STEP = 1 / 60; // seconds per logic tick

// The window the frame counters are averaged over, in ms. One second, because
// that is what makes the number the deck prints an FPS rather than a reading
// that needs a unit explained.
const STATS_WINDOW = 1000;

export function createLoop(update, render) {
  let last = 0;
  let acc = 0;
  let running = false;
  let rafId = 0;

  // Frame instrumentation, for the deck's own readouts (see game/telemetry.js).
  //
  // MEASURED HERE BECAUSE THIS IS THE ONLY PLACE THE REAL NUMBERS EXIST. The
  // timestep is FIXED, so the `dt` every other module sees is the constant STEP
  // and says nothing at all about how the frame actually went — a game running
  // at 12fps and one running at 60 are indistinguishable from inside update().
  // What is real is up here: the wall-clock gap between rAF callbacks (which is
  // the frame RATE) and the time update+render actually took (which is the frame
  // COST, and the thing the README's ~1ms budget is about). They are different
  // questions and the panel reports both, because a rate that has dropped while
  // the cost stayed flat means something entirely different from both moving.
  //
  // Costs one performance.now() per frame on top of the timestamp rAF already
  // hands us. Accumulated into a one-second window rather than smoothed per
  // frame, so the readout is a stable number to read rather than a flicker.
  let frames = 0;
  let workSum = 0;
  let workWorst = 0;
  let windowStart = 0;
  let stats = { fps: 0, workMs: 0, worstMs: 0 };

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

    const work = performance.now() - now;
    frames++;
    workSum += work;
    if (work > workWorst) workWorst = work;
    if (now - windowStart >= STATS_WINDOW) {
      const elapsed = now - windowStart;
      stats = {
        fps: (frames * 1000) / elapsed,
        workMs: workSum / frames,
        worstMs: workWorst,
      };
      frames = 0;
      workSum = 0;
      workWorst = 0;
      windowStart = now;
    }

    rafId = requestAnimationFrame(frame);
  }

  return {
    // The last COMPLETED window's figures. Returns zeroes for the first second
    // of a page's life, which callers must treat as "not measured yet" rather
    // than as a stalled game — see telemetry.js's own handling.
    stats() {
      return stats;
    },
    start() {
      if (running) return;
      running = true;
      last = performance.now() / 1000;
      windowStart = performance.now();
      acc = 0;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
  };
}
