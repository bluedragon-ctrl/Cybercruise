// Telemetry — what the gutter log actually SAYS, and the deck's status readout
// beside it. The wording lives here, in the game layer, for the same reason
// main.js composes the AUDIO FEED line rather than trackmusic.js doing it: the
// fiction belongs with the modules that know what a sector, a conduit and a
// hull are, not with the presentation layer that paints text.
//
// So this file is DOM-FREE, top to bottom, and imports nothing from engine/.
// engine/gutter.js knows how to put a row on screen and nothing about what a
// row means; this knows what a row means and nothing about how it gets there.
// main.js joins the two, the same way it already joins console.js to the audio
// engine. The practical payoff is that the whole of this file loads under plain
// Node and is covered by the invariant suite (see test/README-invariants.md on
// why everything it imports has to be DOM-free at module scope).
//
// THE PROBLEM THIS FILE IS SOLVING is not "fill the gutter with text". Filling
// a gutter with text is trivial and reads as a screensaver inside thirty
// seconds, because nothing on screen answers to anything the player did. What
// makes a log read as a LIVE SYSTEM is CORRELATION: the numbers in it are the
// numbers actually driving the game, and the moment something happens to the
// player the log's own behaviour changes. Three things enforce that here:
//
//   1. Every filler line is built from real state — the odometer, the speed,
//      the sector index, the credit balance — not from a random number.
//   2. The EMISSION RATE is a function of speed (see interval()). Drive faster
//      and the deck chatters faster. This is the single cheapest trick in the
//      file and by far the most convincing one, because the player feels it
//      before they can read a word of it.
//   3. A hull under pressure re-weights the pool toward the fault templates, so
//      taking damage visibly upsets the log a beat before the real WARN line
//      from player.js arrives.
//
// Everything is a pure function of (sequence number, snapshot). Same seq and
// same state in, same line out, forever — the same determinism contract
// citygrid.js's lots and links.js's callsigns hold, and for the same reason:
// it is what makes any of this testable without a screen.

// Same three-line hash every hash-seeded catalogue on this floor keeps its own
// copy of — see sectors.js's own comment on why they are not shared out into a
// utility module.
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// This file's own seed space, offset clear of citygrid's plot/node rolls,
// links.js's conduit/ping/callsign ones and sectors.js's name rolls. Nothing
// here is allowed to correlate with a roll the WORLD made: a filler line that
// happened to move in lockstep with the buildings would look like a bug.
const SEED = 610_007;

// Bounds on how often a filler line lands, in seconds, and the speed band they
// are mapped across.
//
// SLOW is the idle rate — the menu, the shop, a stopped car. FAST is the rate at
// a fully upgraded car flat out. The band's endpoints are the game's own: 260 is
// Player's starting speed and 740 is what a maxed engine tops out at (see
// upgrades.js's STATS entry for "engine"), so this tracks the real speed range
// rather than a pair of numbers that would quietly stop meaning anything the
// next time the engine tiers are retuned.
const SLOW = 1.1;
const FAST = 0.35;
const SPEED_LO = 260;
const SPEED_HI = 740;

// How often a filler line lands when the car is NOT driving, in seconds.
//
// IDLE is the menu, the shop, a paused run, the boot sequence — the deck is up
// and has nothing much to report. DOWN is after the hull hits zero, and is
// deliberately the slowest thing in the file: a dead link that kept chattering
// at the same rate as a live one is exactly the tell that the log is scenery.
// The screen going quiet is the point.
const IDLE_RATE = 1.4;
const DOWN_RATE = 2.4;

// Below this fraction of max hull the fault templates start crowding out the
// routine ones. Matches nothing in particular in the damage model on purpose —
// it is a PRESENTATION threshold, and picking the same number player.js uses for
// an actual mechanic would invite someone to wire the two together later.
const STRESS_FRAC = 0.35;

// Roughly a third of the lines go fault-flavoured once the hull is under
// STRESS_FRAC. Not all of them: a log that switches wholesale to errors reads as
// a different screen rather than as the same screen in trouble.
const STRESS_MIX = 0.34;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Fixed-width hex, because a column of addresses that changes width every line
// reads as noise rather than as a memory map.
const hex = (n, width) => Math.floor(Math.abs(n)).toString(16).toUpperCase().padStart(width, "0").slice(-width);

// The routine pool: what the deck says when nothing is wrong.
//
// Every one of these names a module that genuinely exists and a job it genuinely
// does — road.js really does blit 128px strips, citygrid.js really does resolve
// lots, links.js really does hold conduits open. That is the point. A player who
// never reads a single line still absorbs that the words are consistent, and a
// player who does read one finds it describing the thing on screen.
const ROUTINE = [
  (s, h) => `road.strip[${s.strip}] cache hit`,
  (s, h) => `grid.lot(${Math.floor(h(1) * 64)},${s.strip & 0xff}) resolved`,
  (s, h) => `links.conduit ${hex(h(2) * 0xffff, 4)} rssi -${34 + Math.floor(h(3) * 40)}`,
  (s, h) => `sec.${s.sector} scan ok  drift ${(h(4) * 0.9).toFixed(2)}`,
  (s, h) => `nav.vec dx=${(h(5) * 2 - 1).toFixed(3)} v=${s.speed}`,
  (s, h) => `traffic.band lo=${SPEED_LO} hi=${s.speed + 60}`,
  (s, h) => `wallet.poll  bal=${s.credits}CR  d=${s.dist}`,
  (s, h) => `0x${hex(s.strip * 4096 + h(6) * 4096, 6)}  mov r${Math.floor(h(7) * 8)}, [feed]`,
  (s, h) => `citygrid.arterial +${512 - (s.strip % 512)}`,
  (s, h) => `hull.integrity ${s.hullPct}%  shield nominal`,
  // --- The measured ones ---------------------------------------------------
  //
  // These five are NOT dressed-up random numbers, and that is the whole reason
  // they are worth their slots: they are the actual frame rate, the actual frame
  // cost, the actual heap and the actual entity count, read from engine/loop.js
  // and the live world (see main.js's deckSnapshot). The fiction and the
  // instrumentation happen to want exactly the same numbers — a link's quality,
  // its throughput, its buffer occupancy — so the panel can be in character and
  // be a profiler at the same time, and neither has to compromise.
  //
  // What that buys during a playtest: a frame cost drifting up as the road fills
  // shows up in the log while the game is being PLAYED, without a devtools
  // window over the top of the thing being judged. The README's budget is ~1ms
  // of 16.7, so `deck.frame` reading 3.4ms is a real signal, not flavour.
  (s, h) => `link.qos  ${s.fps}fps  loss ${s.loss}%`,
  (s, h) => `deck.frame  ${s.frameMs}ms of 16.7  peak ${s.peakMs}`,
  (s, h) => `feed.rate  ${s.kbps} kb/s  ${s.entities} nodes live`,
  (s, h) => `buffer.resident  ${s.heap}`,
  (s, h) => `sched.tick  ${s.fps}Hz  drift ${(h(8) * 2).toFixed(2)}ms`,
];

// The idle pool: the deck is up, and nothing is being driven.
//
// A SEPARATE POOL, not the routine one at a slower rate, and the reason is the
// bug this pool was written to fix: the routine templates all describe a car
// moving through a city — strips being blitted, lots resolving, a nav vector.
// Printing those over the menu, the shop or a paused run says the world is
// running when it visibly is not, and a log that describes something other than
// what is on screen is worse than no log. These describe a deck at rest.
const IDLE = [
  (s, h) => `deck.idle  awaiting handshake`,
  (s, h) => `net.scan  ${Math.floor(h(1) * 5)} hosts  0 routes`,
  (s, h) => `cache.warm  ${Math.floor(h(2) * 90 + 8)} entries resident`,
  (s, h) => `wallet.ledger  bal=${s.credits}CR  sealed`,
  (s, h) => `grid.map  ${s.sector} cached`,
  (s, h) => `buffer.resident  ${s.heap}`,
  (s, h) => `sched.tick  ${s.fps}Hz  idle`,
  (s, h) => `0x${hex(h(4) * 0xffffff, 6)}  nop`,
];

// The down pool: what is left after the hull hits zero.
//
// Sparse, cold, and about a link that is no longer there. Reached only after the
// TEARDOWN burst below has finished, so by the time these start the player has
// already been told what happened — these are the deck failing to get it back.
const DOWN = [
  (s, h) => `no carrier`,
  (s, h) => `retry ${1 + Math.floor(h(1) * 3)}/3  timeout`,
  (s, h) => `deck.sync  no signal`,
  (s, h) => `session 0x${hex(h(2) * 0xffffff, 6)}  closed`,
  (s, h) => `hull.integrity 0%  unrecoverable`,
  (s, h) => `link.probe  ${Math.floor(h(3) * 900 + 100)}ms  no route`,
  (s, h) => `-- END OF LINE --`,
];

// THE TEARDOWN. game/jackin.js's BEATS at the other end of a run, and written to
// answer it line for line — "NEURAL LINK // OPEN" opens every run, and this is
// what closes one. The deck comes up with a scripted sequence, so it should go
// down with one: a random draw from a pool at the moment the player just died is
// the one place in this file where "whatever the pool happens to hand us" is not
// good enough.
//
// Built from the snapshot at the instant of death rather than sampled later,
// which is what lets it read out the run's FINAL figures — the balance and score
// the player actually finished with, sealed as the link closes.
const TEARDOWN = [
  (s) => ({ text: `!! CARRIER LOST`, tone: "critical" }),
  (s) => ({ text: `!! hull.integrity 0%  CATASTROPHIC`, tone: "critical" }),
  (s) => ({ text: `link.teardown  flushing buffers`, tone: "warn" }),
  (s) => ({ text: `feed.desync  raster dropped`, tone: "warn" }),
  (s) => ({ text: `wallet.commit  bal=${s.credits}CR  sealed`, tone: "warn" }),
  (s) => ({ text: `score.commit  ${s.points}  sealed`, tone: "warn" }),
  (s) => ({ text: `deck.dump  ${s.dist} units  ${s.sector}`, tone: "warn" }),
  (s) => ({ text: `NEURAL LINK // CLOSED`, tone: "critical" }),
];

// How fast the teardown reads out, in seconds per line, and how long the log
// holds its breath afterwards before the DOWN pool starts up.
//
// Fast enough to land as one event rather than eight, which is what it is.
const SCRIPT_GAP = 0.16;
const QUIET_AFTER = 1.6;

// The fault pool: same voice, bad news. Used when the hull is under pressure,
// and rendered in the WARN tone so the column visibly changes temperature
// without anything having to animate.
const FAULTS = [
  (s, h) => `!! hull.integrity ${s.hullPct}%  DEGRADED`,
  (s, h) => `!! plate ${Math.floor(h(1) * 8)} breach  seal failed`,
  (s, h) => `!! bus 0x${hex(h(2) * 0xffffff, 6)}  checksum mismatch`,
  // Measured, like the routine pool's own five: the real dropped-frame figure,
  // which is worth more here than anywhere else — if the frame rate IS falling
  // apart, the moment the player is taking damage is exactly when it matters and
  // exactly when a playtester is least able to go looking for it.
  (s, h) => `!! deck.sync  ${s.loss}% loss  ${s.frameMs}ms/frame`,
  (s, h) => `!! coolant ${(h(4) * 40 + 60).toFixed(0)}C  over limit`,
  (s, h) => `!! links.conduit  packet loss ${Math.floor(h(5) * 30 + 8)}%`,
];

// Uptime, in seconds, of the current run. Advanced only by update(), so it is
// the deck's clock rather than the page's — a restart starts it over, which is
// what a "t+" prefix has to mean to be worth printing.
let clock = 0;
// Which voice the deck is currently speaking in: "live" (driving), "idle" (the
// menu, the shop, a paused run, the boot) or "down" (the hull hit zero). An
// EDGE-DETECTED value — the transition into "down" is what fires the teardown,
// so this has to be remembered rather than merely read, the same "an edge needs
// memory" shape links.js and sectors.js both call out.
let mode = "idle";
// The teardown burst, once it has been built from the snapshot at the moment of
// death. Drains one line at a time and is empty the rest of the time.
let script = [];
let scriptDue = 0;
// Time owed to the next filler line. Counts DOWN, and is reset from interval()
// at the moment of emission rather than on a fixed schedule, so a change of
// speed takes effect on the very next line instead of at the end of some
// pre-committed window.
let due = 0;
// Monotonic line counter, and the only thing seeding the templates. Never reset
// mid-run: two identical states a minute apart must still produce different
// lines, or the log visibly loops whenever the car holds a steady speed.
let seq = 0;

export function reset() {
  clock = 0;
  due = 0;
  seq = 0;
  mode = "idle";
  script = [];
  scriptDue = 0;
}

// Seconds between filler lines at a given speed. Linear across the game's own
// speed band, clamped at both ends so a stopped car still ticks over and an
// impossibly fast one cannot flood the panel.
export function interval(speed) {
  const t = clamp((speed - SPEED_LO) / (SPEED_HI - SPEED_LO), 0, 1);
  return SLOW + (FAST - SLOW) * t;
}

// The rate for a whole snapshot, which is the speed-driven one ONLY while the
// car is actually being driven.
//
// The distinction is load-bearing rather than tidy. The world FREEZES on death —
// the player's `speed` is left exactly where it was when the hull hit zero (see
// main.js's "dying" branch) — so pacing off speed alone would leave the log
// chattering away at 140mph over a wreck, which is precisely the tell that none
// of it was ever connected to anything.
export function rate(snap) {
  if (snap.mode === "down") return DOWN_RATE;
  if (snap.mode !== "live") return IDLE_RATE;
  return interval(snap.speed);
}

// Which pool a snapshot draws from. One place, so the "what is the deck talking
// about" question has a single answer that fillerLine and the tests both read.
export function poolFor(snap, stressed) {
  if (snap.mode === "down") return DOWN;
  if (snap.mode !== "live") return IDLE;
  return stressed ? FAULTS : ROUTINE;
}

// mm:ss for the row prefix. Minutes are not padded past two digits because a
// run that goes over 99 minutes has bigger problems than a ragged column.
export function stamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, "0");
  return `t+${String(m).padStart(2, "0")}:${ss}`;
}

// One filler line. Pure: (seq, snapshot) in, { text, tone } out.
//
// The template is chosen by the seq's own hash rather than by seq % length,
// which would march through the pool in a fixed order — visible as a repeating
// pattern within about two cycles, and the one giveaway that a log is scripted.
export function fillerLine(n, snap) {
  const h = (k) => hash(SEED + n * 17 + k);
  const stressed = snap.mode === "live" && snap.hullPct <= STRESS_FRAC * 100 && h(0) < STRESS_MIX;
  const pool = poolFor(snap, stressed);
  const template = pool[Math.floor(h(11) * pool.length) % pool.length];
  // A "down" line is not an alarm — the alarm was the teardown, minutes of game
  // time ago in log terms. These are a dead link failing to come back, and they
  // read in the dimmest tone the panel has, which is what makes the column go
  // visibly cold after a death instead of merely quieter.
  const tone = stressed ? "warn" : "sys";
  return { text: `${stamp(clock)}  ${template(snap, h)}`, tone };
}

// A line the GAME actually pushed, on its way to the gutter — the SYS LOG's real
// traffic (pickup hints, hull call-outs, sector names, node pings), reworded only
// enough to sit in this column.
//
// The ">>" marker is doing real work: it is the one thing separating a line the
// player caused from the deck's own idle chatter, and without it the events that
// matter are invisible in the stream. Severity comes straight through as the
// tone so console.js stays the single authority on how urgent a line is.
export function eventLine(text, severity) {
  return { text: `${stamp(clock)}  >> ${text}`, tone: severity };
}

// Advance the clock and emit however many filler lines are owed.
//
// `emit` is injected rather than imported, the same shape links.js and wallet.js
// already use for their own `push` parameter — it is what keeps this file
// DOM-free and testable, and it defaults to a no-op so calling update() without
// a sink is harmless rather than a crash.
//
// The while loop, not an if: a long frame (a tab regaining focus, a stall) can
// owe more than one line, and dropping the surplus would leave the log visibly
// behind the game. It is bounded by MAX_CATCHUP because "owed 400 lines" is not
// a backlog worth honouring — it is a hitch, and replaying it would spend a
// hundred DOM writes in one frame to show the player nothing.
const MAX_CATCHUP = 3;

export function update(dt, snap, emit = () => {}) {
  clock += dt;

  // The edge. Entering "down" arms the teardown; every other transition just
  // changes which pool the next line comes from.
  const next = snap.mode ?? "idle";
  if (next !== mode) {
    const wasLive = mode === "live";
    mode = next;
    if (mode === "down" && wasLive) {
      // Built HERE, from the snapshot of the frame the player died on, so the
      // figures it reads out are the run's final ones rather than whatever the
      // world has been left holding by the time the burst gets to that line.
      script = TEARDOWN.map((line) => line(snap));
      scriptDue = 0;
    } else {
      script = [];
    }
    // The new voice speaks on its own schedule rather than finishing the old
    // one's silence — a deck that stayed quiet for another second after the
    // player died would look like it had missed it.
    due = 0;
  }

  if (script.length > 0) {
    scriptDue -= dt;
    let n = 0;
    while (script.length > 0 && scriptDue <= 0 && n < MAX_CATCHUP) {
      const line = script.shift();
      emit(`${stamp(clock)}  ${line.text}`, line.tone);
      scriptDue += SCRIPT_GAP;
      n++;
    }
    // The burst OWNS the log while it runs — no filler interleaved into it, and
    // a held beat afterwards before the pool starts up again. A death is the one
    // moment in a run where the deck should be saying one thing.
    due = QUIET_AFTER;
    return;
  }

  due -= dt;
  let emitted = 0;
  while (due <= 0 && emitted < MAX_CATCHUP) {
    const line = fillerLine(seq++, snap);
    emit(line.text, line.tone);
    due += rate(snap);
    emitted++;
  }
  // A backlog past the cap is discarded rather than carried: without this the
  // `due` deficit from a stall would keep firing lines at MAX_CATCHUP a frame
  // for however long it took to work through, long after the stall was over.
  if (due <= 0) due = rate(snap);
}

// The rig panel's readouts, in the order they appear.
//
// A DELIBERATE SUPERSET OF THE IN-CANVAS HUD, not a replacement for it. Every
// number the player must read in the half-second a hazard gives them — hull,
// ammo, score — stays on the canvas where their eyes already are. What is here
// is the stuff worth a glance BETWEEN hazards: what the sector is called, what
// is on the deck's audio feed, what the balance is. Anything urgent duplicated
// here is duplicated on purpose, so a glance sideways is never a glance at
// something stale.
export function statusRows(snap) {
  const hullTone = snap.hullPct <= 15 ? "critical" : snap.hullPct <= STRESS_FRAC * 100 ? "warn" : "hint";
  const linkTone = snap.mode === "down" ? "critical" : snap.mode === "live" ? "hint" : "sys";
  return [
    { label: "LINK", value: snap.link, tone: linkTone },
    { label: "SECTOR", value: snap.sector, tone: "hint" },
    { label: "DIST", value: snap.dist, tone: "sys" },
    { label: "SPD", value: snap.speed, tone: "sys" },
    { label: "HULL", value: `${snap.hullPct}%`, tone: hullTone },
    { label: "CREDITS", value: `${snap.credits}CR`, tone: "sys" },
    { label: "SCORE", value: snap.points, tone: "sys" },
    { label: "WEAPON", value: snap.weapon, tone: "sys" },
    { label: "FEED", value: snap.feed, tone: "sys" },
    // --- The measured half ---------------------------------------------------
    //
    // Real instrumentation wearing the panel's own vocabulary. SIGNAL is the
    // frame rate as a link quality, and its TONE is the useful part: it goes
    // amber below 55fps and red below 40, so a playtester who never reads a
    // number still sees the right-hand column change colour the moment the game
    // stops holding 60. That is the cheapest performance regression report this
    // project has, and it is on screen during play rather than behind a devtools
    // panel covering the thing being judged.
    //
    // FRAME is the budget the README argues about — mean cost of update+render,
    // against 16.7ms — and it is separated from SIGNAL on purpose: a rate that
    // has dropped while the cost stayed flat is a compositor or a display
    // problem, not this game's, and the two rows together say which.
    { label: "SIGNAL", value: signalText(snap), tone: signalTone(snap) },
    { label: "FRAME", value: frameText(snap), tone: snap.frameMs >= 8 ? "warn" : "sys" },
    { label: "BUFFER", value: snap.heap, tone: "sys" },
    { label: "TRAFFIC", value: `${snap.entities} nodes`, tone: "sys" },
    { label: "UPTIME", value: stamp(clock), tone: "sys" },
  ];
}

// Frame rate, as a link quality. "--" for the first second of a page's life,
// when engine/loop.js has not closed a measurement window yet — printing a
// confident "0fps" there would be a lie, and an alarming one.
function signalText(snap) {
  if (!snap.fps) return "--";
  return `${snap.fps}fps  ${snap.loss}% loss`;
}

function signalTone(snap) {
  if (!snap.fps) return "sys";
  if (snap.fps < 40) return "critical";
  if (snap.fps < 55) return "warn";
  return "hint";
}

function frameText(snap) {
  if (!snap.fps) return "--";
  return `${snap.frameMs}/${snap.peakMs}ms`;
}
