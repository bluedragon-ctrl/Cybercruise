// Part of the cross-file invariant suite — see test/README-invariants.md for
// what these assert and why they are not unit tests of behaviour.
//
// The gutter deck: game/telemetry.js's line composition and emission pacing, and
// engine/console.js's divert mode.
//
// engine/gutter.js itself is absent on purpose — it is the DOM half, and the one
// rule this suite holds is that everything it imports loads under plain Node.
// The split between the two files is exactly what makes that possible: gutter.js
// knows how to put a row on screen and nothing about what a row means,
// telemetry.js the reverse, and it is the meaning that has invariants worth
// pinning.

import test from "node:test";
import assert from "node:assert/strict";
import {
  reset as telemetryReset,
  interval,
  rate,
  stamp,
  fillerLine,
  eventLine,
  update as telemetryUpdate,
  statusRows,
} from "../src/game/telemetry.js";
import {
  HINT as CONSOLE_HINT,
  WARN as CONSOLE_WARN,
  CRITICAL as CONSOLE_CRITICAL,
  push as consolePush,
  update as consoleUpdate,
  render,
  reset as consoleReset,
  onPush as consoleOnPush,
  setDivert,
  isBusy,
} from "../src/engine/console.js";

// A snapshot in the shape main.js's deckSnapshot() builds. Every field the
// templates read has to be here, or a template that reaches for a missing one
// prints "undefined" and nothing fails.
function snap(over = {}) {
  return {
    mode: "live",
    link: "ACTIVE",
    sector: "SEC 04-K",
    dist: 12,
    strip: 940,
    speed: 300,
    hullPct: 100,
    credits: 250,
    points: 1800,
    weapon: "PULSE",
    feed: "NIGHT DRIVE",
    fps: 60,
    loss: 0,
    frameMs: "0.9",
    peakMs: "2.1",
    heap: "24.0 MB",
    entities: 14,
    kbps: 210,
    ...over,
  };
}

// Every word the deck can say about a snapshot, with the clock prefix stripped.
// Enough draws that a template with a low hash weight still turns up.
function vocabulary(over = {}, draws = 400) {
  const s = snap(over);
  const out = [];
  for (let n = 0; n < draws; n++) out.push(fillerLine(n, s).text.replace(/^t\+\d+:\d+\s+/, ""));
  return out;
}

test("a faster car makes the deck chatter faster, monotonically and with both ends clamped", () => {
  // The single most load-bearing behaviour in the file: the player feels the
  // log's rate change before they can read a word of it, and that is what sells
  // the panel as live rather than as a screensaver.
  const speeds = [0, 100, 260, 400, 600, 740, 2000];
  const intervals = speeds.map(interval);
  for (let i = 1; i < intervals.length; i++) {
    assert.ok(
      intervals[i] <= intervals[i - 1],
      `interval must never RISE with speed (${speeds[i - 1]} -> ${speeds[i]})`,
    );
  }
  assert.equal(interval(0), interval(260), "below the band, the idle rate is held rather than extrapolated");
  assert.equal(interval(2000), interval(740), "above the band, the fast rate is held — the panel cannot be flooded");
  assert.ok(interval(740) < interval(260), "the band must actually do something");
});

test("filler lines are a pure function of sequence number and state — same input, same line, forever", () => {
  // The same determinism contract citygrid.js's lots and links.js's callsigns
  // hold. Without it none of this is testable without a screen, and a log that
  // rerolled its own history would be visibly wrong the moment two runs of the
  // same length disagreed.
  telemetryReset();
  const a = [0, 1, 2, 7, 40].map((n) => fillerLine(n, snap()));
  telemetryReset();
  const b = [0, 1, 2, 7, 40].map((n) => fillerLine(n, snap()));
  assert.deepEqual(a, b);
});

test("the template pool is picked by hash, not by cycling — no visible repeat over a long run", () => {
  // seq % length would march through the pool in a fixed order, which reads as a
  // pattern within about two cycles and is the one giveaway that a log is
  // scripted. This asserts the sequence does not simply repeat with the pool's
  // period, and that it still reaches most of the pool.
  telemetryReset();
  // A snapshot that MOVES, because the real one does — the odometer, the strip
  // and the speed all change every frame of a run. Holding them still would
  // measure something the game never does, and would count the measured
  // templates (link.qos, deck.frame, buffer.resident) as repeats when in fact
  // they are correctly reporting a number that has not changed.
  const lines = [];
  for (let n = 0; n < 120; n++) {
    const s = snap({ strip: 900 + n, dist: 10 + n, speed: 300 + (n % 40) });
    lines.push(fillerLine(n, s).text.replace(/^t\+\d+:\d+\s+/, ""));
  }
  const unique = new Set(lines);
  // Not 120: the measured templates (link.qos, deck.frame, buffer.resident)
  // print the frame rate, the frame cost and the heap, and those legitimately
  // read the same from one second to the next — repeating there is the readout
  // being HONEST, not the picker cycling. The stride check below is what
  // actually guards against a pattern.
  assert.ok(unique.size > 70, `expected the pool plus its varying fields to give plenty of distinct lines, got ${unique.size}`);
  // A cycling picker would make line n and line n+poolSize share a template.
  // Nothing here knows the pool's length, so check the property that matters:
  // no fixed stride under 20 reproduces the same first token every time.
  const head = (l) => l.split(" ")[0];
  for (let stride = 1; stride < 20; stride++) {
    let same = 0;
    for (let n = 0; n + stride < 60; n++) if (head(lines[n]) === head(lines[n + stride])) same++;
    assert.ok(same < 55, `stride ${stride} reproduces the same template almost every time — the picker is cycling`);
  }
});

test("a hull under pressure re-weights the log toward faults, but never wholesale", () => {
  // A log that switched entirely to errors would read as a DIFFERENT screen
  // rather than as the same screen in trouble, which is the whole point of the
  // mix. Counted over enough lines that the roll's variance cannot swing it.
  const healthy = [];
  const hurt = [];
  for (let n = 0; n < 400; n++) {
    healthy.push(fillerLine(n, snap({ hullPct: 100 })).tone);
    hurt.push(fillerLine(n, snap({ hullPct: 20 })).tone);
  }
  const warns = (a) => a.filter((t) => t === "warn").length;
  assert.equal(warns(healthy), 0, "an undamaged hull must produce no fault lines at all");
  assert.ok(warns(hurt) > 60, `a hull at 20% must visibly upset the log, got ${warns(hurt)} fault lines of 400`);
  assert.ok(warns(hurt) < 240, `...but must not become a wall of errors, got ${warns(hurt)} of 400`);
});

test("a dead run's hull does not upset the log — stress is a live-car reading", () => {
  // hullPct is 0 through the whole gameover screen and the menu that follows.
  // Without the mode gate the deck would sit screaming at a player who is
  // reading a menu.
  const tones = [];
  for (let n = 0; n < 200; n++) tones.push(fillerLine(n, snap({ hullPct: 0, mode: "down" })).tone);
  assert.equal(tones.filter((t) => t === "warn").length, 0);
});

// --- Voices -----------------------------------------------------------------

test("the deck stops narrating traffic once the car is not driving", () => {
  // THE BUG THIS SPLIT FIXES. The routine pool is all road strips, lot lookups
  // and nav vectors — a description of a car moving through a city. Printing
  // those over a wreck or a menu describes something that is demonstrably not
  // happening, and a log that disagrees with the screen is worse than no log.
  const driving = ["road.strip", "grid.lot", "nav.vec", "traffic.band", "citygrid.arterial"];
  for (const mode of ["down", "idle"]) {
    const said = vocabulary({ mode, hullPct: mode === "down" ? 0 : 100 });
    for (const word of driving) {
      assert.ok(
        !said.some((l) => l.includes(word)),
        `the deck must not report "${word}" while mode is "${mode}" — the world is not running`,
      );
    }
  }
});

test("a dead link never claims the hull is nominal", () => {
  // The specific line that gave the bug away: "hull.integrity 0%  shield
  // nominal", printed over the wreck it was describing.
  const said = vocabulary({ mode: "down", hullPct: 0 });
  assert.ok(!said.some((l) => l.includes("nominal")), "nothing is nominal after the hull hits zero");
  assert.ok(
    said.some((l) => l.includes("no carrier") || l.includes("unrecoverable") || l.includes("END OF LINE")),
    "a dead link should sound like one",
  );
});

test("the deck goes quiet when the link does, and quietest of all when it is dead", () => {
  // A dead link chattering at the same rate as a live one is the tell that none
  // of it was ever connected to anything. Note this cannot be a speed test: the
  // world FREEZES on death with the player's speed left where it was, so the
  // rate has to key off the mode rather than off the number.
  const fast = snap({ mode: "live", speed: 700 });
  assert.ok(rate(snap({ mode: "idle", speed: 700 })) > rate(fast), "an idle deck must be slower than a driving one");
  assert.ok(
    rate(snap({ mode: "down", speed: 700 })) > rate(snap({ mode: "idle", speed: 700 })),
    "a dead link must be the slowest of the three",
  );
  assert.equal(
    rate(snap({ mode: "down", speed: 700 })),
    rate(snap({ mode: "down", speed: 0 })),
    "once the link is down, the frozen speed reading must stop driving anything",
  );
});

// --- The teardown -----------------------------------------------------------

test("dying fires the teardown burst, in order, ahead of any filler", () => {
  // game/jackin.js's BEATS at the other end of a run. A death is the one moment
  // where "whatever the pool happens to hand us" is not good enough, and the one
  // moment the deck should be saying exactly one thing.
  telemetryReset();
  const out = [];
  const sink = (text, tone) => out.push({ text, tone });
  for (let i = 0; i < 20; i++) telemetryUpdate(0.05, snap({ mode: "live" }), sink);
  out.length = 0;

  for (let i = 0; i < 40; i++) telemetryUpdate(0.05, snap({ mode: "down", hullPct: 0 }), sink);

  const texts = out.map((l) => l.text);
  assert.ok(texts[0].includes("CARRIER LOST"), `the burst must open with the carrier loss, got "${texts[0]}"`);
  assert.ok(
    texts.some((t) => t.includes("NEURAL LINK // CLOSED")),
    "…and close the link it opened with, answering jackin.js's own boot line",
  );
  const closed = texts.findIndex((t) => t.includes("NEURAL LINK // CLOSED"));
  assert.equal(closed, texts.length - 1, "nothing may be interleaved after the closing line inside the burst");
  assert.equal(out[0].tone, "critical", "a death must not arrive in the dim filler tone");
});

test("the teardown reads out the run's FINAL figures, not whatever the world holds later", () => {
  telemetryReset();
  const out = [];
  const sink = (text) => out.push(text);
  telemetryUpdate(0.05, snap({ mode: "live" }), sink);
  out.length = 0;
  // Death, then the world sits on the gameover screen for a while. The wallet
  // and score rows must still be the ones from the moment of death.
  telemetryUpdate(0.05, snap({ mode: "down", credits: 4210, points: 99500 }), sink);
  for (let i = 0; i < 40; i++) telemetryUpdate(0.05, snap({ mode: "down", credits: 0, points: 0 }), sink);

  assert.ok(out.some((t) => t.includes("bal=4210CR")), "the balance sealed must be the one the run ended on");
  assert.ok(out.some((t) => t.includes("99500")), "…and likewise the score");
});

test("the teardown fires once per death, not once per frame spent dead", () => {
  telemetryReset();
  const out = [];
  const sink = (text) => out.push(text);
  telemetryUpdate(0.05, snap({ mode: "live" }), sink);
  for (let i = 0; i < 600; i++) telemetryUpdate(0.05, snap({ mode: "down", hullPct: 0 }), sink);
  const carriers = out.filter((t) => t.includes("CARRIER LOST")).length;
  assert.equal(carriers, 1, `the burst must be edge-triggered, got ${carriers} of them`);
});

test("arriving at 'down' without having been driving does not fake a death", () => {
  // reset() leaves the deck idle. A restart that went straight to the gameover
  // screen — or any future state wiring that reaches "down" from a menu — must
  // not announce a carrier loss for a link that was never up.
  telemetryReset();
  const out = [];
  telemetryUpdate(0.05, snap({ mode: "idle" }), (text) => out.push(text));
  for (let i = 0; i < 60; i++) telemetryUpdate(0.05, snap({ mode: "down" }), (text) => out.push(text));
  assert.equal(out.filter((t) => t.includes("CARRIER LOST")).length, 0);
});

test("the burst holds the log alone, then hands back to the pool", () => {
  telemetryReset();
  const out = [];
  const sink = (text) => out.push(text);
  telemetryUpdate(0.05, snap({ mode: "live" }), sink);
  out.length = 0;
  // Just long enough for the eight-line burst at its own gap, and no longer.
  for (let i = 0; i < 30; i++) telemetryUpdate(0.05, snap({ mode: "down", hullPct: 0 }), sink);
  assert.ok(
    out.every((t) => !t.includes("no carrier") && !t.includes("retry")),
    "no pool filler may be interleaved into the burst",
  );
  // …and then the pool does start, once the held beat has passed.
  for (let i = 0; i < 200; i++) telemetryUpdate(0.05, snap({ mode: "down", hullPct: 0 }), sink);
  assert.ok(
    out.some((t) => t.includes("no carrier") || t.includes("retry") || t.includes("closed")),
    "the dead-link pool must eventually take over from the burst",
  );
});

// --- The measured readouts --------------------------------------------------

test("the panel reports the frame figures it was handed, not decorated versions of them", () => {
  // The whole value of these rows is that they are REAL. A prettified or
  // smoothed number would make the panel useless as the thing it is quietly
  // also for: watching the frame budget during an actual playtest.
  const rows = statusRows(snap({ fps: 47, loss: 22, frameMs: "3.4", peakMs: "9.8", heap: "31.2 MB", entities: 22 }));
  const by = (label) => rows.find((r) => r.label === label);
  assert.ok(by("SIGNAL").value.includes("47fps"), "the frame rate must be printed as measured");
  assert.ok(by("SIGNAL").value.includes("22%"), "…and so must the shortfall against 60");
  assert.ok(by("FRAME").value.includes("3.4") && by("FRAME").value.includes("9.8"), "mean AND peak, they answer different questions");
  assert.equal(by("BUFFER").value, "31.2 MB");
  assert.equal(by("TRAFFIC").value, "22 nodes");
});

test("SIGNAL changes colour before a playtester has to read it", () => {
  // The cheapest performance regression report this project has: the right-hand
  // column goes amber the moment the game stops holding 60, and red when it is
  // properly in trouble.
  const tone = (fps) => statusRows(snap({ fps })).find((r) => r.label === "SIGNAL").tone;
  assert.equal(tone(60), "hint");
  assert.equal(tone(50), "warn");
  assert.equal(tone(30), "critical");
});

test("before the first measurement window closes, the panel says so rather than reporting zero", () => {
  // engine/loop.js returns zeroes for the first second of a page's life. A
  // confident "0fps  100% loss" there would be a lie, and an alarming one.
  const rows = statusRows(snap({ fps: 0, loss: 0 }));
  const by = (label) => rows.find((r) => r.label === label);
  assert.equal(by("SIGNAL").value, "--");
  assert.equal(by("FRAME").value, "--");
  assert.equal(by("SIGNAL").tone, "sys", "an unmeasured link must not be painted as a failing one");
});

test("the measured figures reach the log itself, not just the status column", () => {
  const said = vocabulary({ fps: 47, loss: 22, frameMs: "3.4", heap: "31.2 MB", entities: 22 });
  assert.ok(said.some((l) => l.includes("47fps")), "the log should be able to report the real frame rate");
  assert.ok(said.some((l) => l.includes("3.4ms")), "…and the real frame cost, against the budget");
  assert.ok(said.some((l) => l.includes("31.2 MB")), "…and the real heap");
});

test("a real game event is marked apart from the deck's own chatter, and keeps its severity", () => {
  // The ">>" marker is the only thing separating a line the player CAUSED from
  // idle filler. Without it the events that matter are invisible in the stream,
  // which would make the whole panel decoration.
  telemetryReset();
  const line = eventLine("HULL BREACH", CONSOLE_CRITICAL);
  assert.ok(line.text.includes(">>"), "an event line must carry the marker that distinguishes it from filler");
  assert.ok(line.text.includes("HULL BREACH"), "the game's own wording must come through verbatim");
  assert.equal(line.tone, CONSOLE_CRITICAL, "console.js stays the single authority on how urgent a line is");
  assert.ok(!fillerLine(0, snap()).text.includes(">>"), "filler must not wear the event marker");
});

test("update() emits at the paced rate and discards a backlog rather than replaying it", () => {
  // A stalled tab (or a long frame) can owe hundreds of lines. Honouring that
  // backlog would spend a hundred DOM writes in one frame to show the player
  // nothing, so it is capped — and the leftover deficit must be DROPPED, or the
  // cap just spreads the same flood over the following frames.
  telemetryReset();
  const emitted = [];
  const s = snap({ speed: 260 });
  const step = 0.05;
  for (let t = 0; t < 3; t += step) telemetryUpdate(step, s, (text) => emitted.push(text));
  const expected = 3 / interval(260);
  assert.ok(
    Math.abs(emitted.length - expected) <= 2,
    `expected about ${expected.toFixed(1)} lines in 3s at idle speed, got ${emitted.length}`,
  );

  telemetryReset();
  const burst = [];
  telemetryUpdate(30, s, (text) => burst.push(text)); // a 30-second frame
  assert.ok(burst.length <= 3, `a stall must not replay its backlog, got ${burst.length} lines`);
  const after = [];
  for (let t = 0; t < 1; t += step) telemetryUpdate(step, s, (text) => after.push(text));
  assert.ok(
    after.length <= Math.ceil(1 / interval(260)) + 1,
    `the frame after a stall must be back to the normal rate, got ${after.length} lines`,
  );
});

test("update() runs without a sink — the panels being hidden is not an error path", () => {
  telemetryReset();
  assert.doesNotThrow(() => telemetryUpdate(1, snap()));
});

test("reset() restarts the uptime clock — t+ has to mean uptime or it is not worth printing", () => {
  telemetryReset();
  telemetryUpdate(90, snap(), () => {});
  assert.ok(stamp(90).startsWith("t+01:30") || statusRows(snap()).some((r) => r.label === "UPTIME"));
  const before = statusRows(snap()).find((r) => r.label === "UPTIME").value;
  telemetryReset();
  const after = statusRows(snap()).find((r) => r.label === "UPTIME").value;
  assert.notEqual(before, after, "a restart must not carry the previous run's uptime");
  assert.equal(after, "t+00:00");
});

test("the rig panel's hull tone escalates with the same reading the HUD's bar shows", () => {
  const toneAt = (pct) => statusRows(snap({ hullPct: pct })).find((r) => r.label === "HULL").tone;
  assert.equal(toneAt(100), "hint");
  assert.equal(toneAt(30), "warn");
  assert.equal(toneAt(10), "critical");
  assert.equal(
    statusRows(snap({ hullPct: 42 })).find((r) => r.label === "HULL").value,
    "42%",
    "the rig reports hull as a percentage — the same reading, not a second scale",
  );
});

// --- The divert -------------------------------------------------------------

// A recording stand-in for a 2D context. engine/neon.js's glowText only ever
// assigns properties and calls save/restore/fillText, and console.js's plate is
// one fillRect, so the whole render path runs under Node against this — which is
// what lets the divert's actual OUTPUT be asserted rather than just its
// bookkeeping. No canvas, no DOM, same code path the game runs.
function stubCtx() {
  const texts = [];
  const rects = [];
  return {
    texts,
    rects,
    save() {},
    restore() {},
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h });
    },
    fillText(text) {
      texts.push(text);
    },
  };
}

// Settle the ease so rows are at their targets and alphas are fully in, the way
// they would be a fraction of a second after a push.
function settle(steps = 40) {
  for (let i = 0; i < steps; i++) consoleUpdate(0.016);
}

test("diverted, the playfield panel keeps CRITICAL and hands everything else to the gutter", () => {
  // The whole design in one assertion. A hull call-out has to land where the
  // player's eyes already are, because the half-second it warns about is a
  // half-second they cannot spend looking sideways; everything else is read
  // BETWEEN hazards, where a glance sideways is free.
  consoleReset();
  setDivert(() => true);
  consolePush("CRATE AHEAD", CONSOLE_HINT);
  consolePush("HULL BREACH", CONSOLE_CRITICAL);
  consolePush("SEC 04-K", CONSOLE_HINT);
  settle();

  const ctx = stubCtx();
  render(ctx, 600, 800);
  assert.ok(ctx.texts.includes("HULL BREACH"), "a CRITICAL line must stay on the playfield");
  assert.ok(!ctx.texts.includes("CRATE AHEAD"), "a hint must not be painted twice while the gutter has it");
  assert.ok(!ctx.texts.includes("SEC 04-K"), "...nor a sector name");
  assert.ok(ctx.texts.includes("ALERT"), "the shrunken plate must say what it now is, or it reads as a broken log");
  assert.ok(!ctx.texts.includes("SYS LOG"), "it is no longer the system log — the gutter is");

  setDivert(null);
  consoleReset();
});

test("undiverted, the playfield panel is exactly what it always was", () => {
  // The narrow-window path, which is still most phones and any portrait window.
  // Nothing about the feature is allowed to change the game there.
  consoleReset();
  setDivert(() => false);
  consolePush("CRATE AHEAD", CONSOLE_HINT);
  consolePush("HULL BREACH", CONSOLE_CRITICAL);
  settle();

  const ctx = stubCtx();
  render(ctx, 600, 800);
  assert.ok(ctx.texts.includes("CRATE AHEAD"));
  assert.ok(ctx.texts.includes("HULL BREACH"));
  assert.ok(ctx.texts.includes("SYS LOG"));
  consoleReset();
});

test("the diverted plate shrinks to the alerts actually up — the point is to give playfield back", () => {
  // A five-row plate standing with one line in it would return none of the
  // 160x100-odd pixels the divert exists to free.
  consoleReset();
  setDivert(() => false);
  consolePush("a", CONSOLE_HINT);
  consolePush("b", CONSOLE_HINT);
  consolePush("HULL BREACH", CONSOLE_CRITICAL);
  settle();
  const full = stubCtx();
  render(full, 600, 800);

  setDivert(() => true);
  const alert = stubCtx();
  render(alert, 600, 800);

  assert.ok(alert.rects.length === 1 && full.rects.length === 1, "one plate either way");
  assert.ok(
    alert.rects[0].h < full.rects[0].h,
    `the alert plate must be shorter than the full log's (${alert.rects[0].h} vs ${full.rects[0].h})`,
  );
  assert.equal(alert.rects[0].w, full.rects[0].w, "the plate's WIDTH is set by the road's barrier, and does not move");

  setDivert(null);
  consoleReset();
});

test("diverted with nothing critical up, the panel paints nothing at all", () => {
  consoleReset();
  setDivert(() => true);
  consolePush("CRATE AHEAD", CONSOLE_HINT);
  settle();
  const ctx = stubCtx();
  render(ctx, 600, 800);
  assert.equal(ctx.texts.length, 0, "no header, no plate, no rows — the gutter has the whole log");
  assert.equal(ctx.rects.length, 0);
  setDivert(null);
  consoleReset();
});

// Where a named row was painted, and the plate it was painted on.
function probeRow(label) {
  let y = null;
  const rects = [];
  render(
    {
      save() {},
      restore() {},
      fillRect(rx, ry, rw, rh) {
        rects.push({ y: ry, h: rh });
      },
      fillText(text, tx, ty) {
        if (text === label) y = ty;
      },
    },
    600,
    800,
  );
  return { y, plate: rects[0] ?? null };
}

test("an alert stays ON the alert plate however many hints are newer than it", () => {
  // THE BUG `dslot` EXISTS TO PREVENT, and it is a placement bug rather than a
  // motion one. A row's normal `slot` is its age rank among ALL messages, so a
  // critical with four hints pushed after it sits at slot 4 — four rows up from
  // the bottom. That is correct on the five-row SYS LOG plate and nonsense on
  // the one-row ALERT plate, where it lands well above the plate's own top edge:
  // a hull warning floating unanchored over the road. Packing the criticals
  // separately is what keeps the only line the player must not miss inside the
  // box drawn for it.
  consoleReset();
  setDivert(() => true);
  consolePush("HULL BREACH", CONSOLE_CRITICAL);
  consolePush("a", CONSOLE_HINT);
  consolePush("b", CONSOLE_HINT);
  consolePush("c", CONSOLE_HINT);
  consolePush("d", CONSOLE_HINT);
  settle();

  const { y, plate } = probeRow("HULL BREACH");
  assert.ok(y !== null, "the alert must still be painted");
  assert.ok(
    y >= plate.y && y <= plate.y + plate.h,
    `the alert row (y=${y}) must sit inside its plate (${plate.y}..${plate.y + plate.h})`,
  );

  setDivert(null);
  consoleReset();
});

test("a stacking alert eases into its new row rather than teleporting", () => {
  // The other half of what easing a SECOND slot buys: when a second alert
  // arrives the first has to travel a row, and it has to travel it the way every
  // other row in this log moves. A packed index computed at render time would
  // snap it a full row-height in one frame — on the one line the player cannot
  // afford to lose track of.
  consoleReset();
  setDivert(() => true);
  consolePush("HULL BREACH", CONSOLE_CRITICAL);
  settle();
  const start = probeRow("HULL BREACH").y;

  consolePush("SHIELD DOWN", CONSOLE_CRITICAL);
  const ys = [];
  // Well inside LIFETIME, so nothing is retiring — this measures the stack
  // shuffle alone, not the slide-off-the-top that ends every row's life.
  for (let i = 0; i < 60; i++) {
    consoleUpdate(0.016);
    ys.push(probeRow("HULL BREACH").y);
  }

  let biggestStep = 0;
  for (let i = 1; i < ys.length; i++) biggestStep = Math.max(biggestStep, Math.abs(ys[i] - ys[i - 1]));
  assert.ok(
    Math.abs(ys[ys.length - 1] - start) > 8,
    "the first alert must actually have moved up a row to make room for the second",
  );
  assert.ok(
    biggestStep < 4,
    `...and must have eased there — biggest single-frame move was ${biggestStep}px`,
  );

  setDivert(null);
  consoleReset();
});

test("divert changes only what the in-canvas panel PAINTS — never what the log holds", () => {
  // The one invariant the whole feature rests on. isBusy() is the budget
  // links.js and wallet.js pace the city's chatter against; a divert that
  // emptied the log would read as "never busy" to them and roughly double both
  // the chatter rate and the console beep per push — on the strength of somebody
  // having a wide browser window.
  consoleReset();
  setDivert(() => true);
  consolePush("a hint", CONSOLE_HINT);
  assert.ok(isBusy(), "a hint pushed while diverted must still occupy the log's budget");
  consoleUpdate(0.016);
  assert.ok(isBusy(), "...and must still be there a tick later");
  setDivert(null);
  consoleReset();
});

test("every severity still reaches the subscriber while diverted — audio is not a function of window width", () => {
  consoleReset();
  setDivert(() => true);
  const heard = [];
  consoleOnPush((text, severity) => heard.push(severity));
  consolePush("x", CONSOLE_HINT);
  consolePush("y", CONSOLE_WARN);
  consolePush("z", CONSOLE_CRITICAL);
  assert.deepEqual(heard, [CONSOLE_HINT, CONSOLE_WARN, CONSOLE_CRITICAL]);
  setDivert(null);
  consoleReset();
});

test("reset() clears the subscriber but leaves the divert standing", () => {
  // They look alike and are not: a subscriber is per-run wiring newGame()
  // re-registers, while divert answers "is there a second display on this page",
  // which outlives any number of runs. Clearing it here would put the full log
  // back on the playfield for the rest of the session on the first restart, and
  // the gutter would then show every line twice.
  consoleReset();
  setDivert(() => true);
  consoleReset(); // the restart

  consolePush("CRATE AHEAD", CONSOLE_HINT);
  settle();
  const ctx = stubCtx();
  render(ctx, 600, 800);
  assert.equal(
    ctx.texts.length,
    0,
    "a hint after a restart must still be the gutter's — the divert did not survive reset()",
  );

  setDivert(null);
  consoleReset();
});

test("setDivert(null) puts the full log back — the narrow-window path is always reachable", () => {
  consoleReset();
  setDivert(() => true);
  setDivert(null);
  consolePush("CRATE AHEAD", CONSOLE_HINT);
  settle();
  const ctx = stubCtx();
  render(ctx, 600, 800);
  assert.ok(ctx.texts.includes("CRATE AHEAD"));
  consoleReset();
});
