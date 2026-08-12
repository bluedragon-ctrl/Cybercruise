// SFX gallery — a static showcase page (sfx.html) for auditioning every
// audio/soundtypes.js catalogue entry without starting a run, hitting an
// enemy or triggering a mine to hear it. Same spirit as demo.js's asset
// gallery: a page that reflects the catalogue automatically, so a new sound
// added there needs nothing added here.
//
// A DEV TOOL, DELIBERATELY A SEPARATE PAGE rather than a menu entry — see
// the task brief this was built against: tuning nine sounds by starting a
// run and trying to get shot is miserable, and this page exists purely to
// take that friction away from whoever is retuning soundtypes.js next.
//
// AUDIO STILL NEEDS A USER GESTURE, same contract as main.js's own
// music.start() (see audio/context.js's header) — nothing here can call
// createMusic().start() at module load, only from inside the START AUDIO
// button's click handler below.

import { createMusic } from "../audio/synth.js";
import { SOUND_TYPES } from "../audio/soundtypes.js";
import { SUSTAINED_TYPES } from "../audio/sustainedtypes.js";
import { DREAD_RANGE_ON } from "../audio/sustainedfx.js";
import { MIN_SPEED, MAX_SPEED } from "../game/player.js";
import { MUSIC_LISTING_URL } from "../audio/musictypes.js";

const music = createMusic();

const gallery = document.getElementById("gallery");
const sustainedGallery = document.getElementById("sustainedGallery");
const startBtn = document.getElementById("start");
const soundSlider = document.getElementById("sound");
const musicSlider = document.getElementById("music");
const speedSlider = document.getElementById("speed");
const soundLabel = document.getElementById("soundLabel");
const musicLabel = document.getElementById("musicLabel");
const speedLabel = document.getElementById("speedLabel");

function setSoundLevel(v) {
  music.setSfxVolume(v);
  soundLabel.textContent = `${Math.round(v * 100)}%`;
}

function setMusicLevel(v) {
  music.setVolume(v);
  musicLabel.textContent = `${Math.round(v * 100)}%`;
}

// Phase 8 step 4's speed-linked bus filter — driven off the real
// MIN_SPEED..MAX_SPEED band (player.js) rather than the slider's own
// hard-coded HTML attributes, so a future retune of that band can't leave
// this control silently out of range — see the slider.min/max assignment
// below.
function setSpeed(v) {
  music.updateMusicCutoff(v);
  speedLabel.textContent = `${Math.round(v)}`;
}

soundSlider.addEventListener("input", () => setSoundLevel(Number(soundSlider.value)));
musicSlider.addEventListener("input", () => setMusicLevel(Number(musicSlider.value)));
speedSlider.min = MIN_SPEED;
speedSlider.max = MAX_SPEED;
speedSlider.addEventListener("input", () => setSpeed(Number(speedSlider.value)));

// --- Music backend A/B panel -------------------------------------------
//
// "procedural and track can be A/B'd against the same SFX" — the design
// brief's own phrase for why this panel exists. Three pieces:
//   - a radio row forcing synth.js's resolveBackend() choice via
//     setBackendPreference(), instead of leaving it to whichever backend
//     happened to be ready first (see synth.js's own header on that);
//   - a plain listing of whatever tools/serve.js's GET /api/music reports,
//     fetched directly (not through the facade — this is read-only
//     display, not a control, so there's no reason to widen synth.js's own
//     surface for it) so it's visible from this page whether a track was
//     even found before pressing START AUDIO;
//   - a status line ticking the ACTUAL resolved backend + currently
//     playing track name, because "auto" can resolve either way depending
//     on timing, and this page is exactly where that needs to be visible.
const trackListEl = document.getElementById("trackList");
const statusEl = document.getElementById("status");
const disturbTestBtn = document.getElementById("disturbTest");

fetch(MUSIC_LISTING_URL)
  .then((res) => res.json())
  .then((tracks) => {
    trackListEl.textContent = tracks.length === 0
      ? "tracks: none found in assets/music/ (procedural will play if TRACK/AUTO is selected)"
      : `tracks (${tracks.length}): ` + tracks.map((t) => `${t.name} (${(t.size / 1024).toFixed(0)}KB)`).join(", ");
  })
  .catch(() => {
    trackListEl.textContent = "tracks: listing fetch failed (server not running the /api/music endpoint?)";
  });

disturbTestBtn.addEventListener("click", () => music.disturb(1));

// Before start, music.play()/setVolume()/setSfxVolume()/updateMusicCutoff()
// are all silent no-ops (see synth.js/context.js's own contract) — so the
// sliders can be dragged freely before the button is pressed, they just have
// nothing to affect yet. The levels are pushed again the instant audio
// actually starts so the engine picks up wherever the sliders were left.
//
// startContext() + startMusicLoop(), not jackIn() — this page has no menu
// screen and no reason to delay the loop's first downbeat behind a riser;
// see synth.js's own header on why jackIn() is reserved for main.js's START
// GAME confirm specifically. Both calls together are what the old combined
// start() used to do in one step.
//
// AWAITS startContext() here specifically (main.js never does — see that
// function's own header) — this page has no menu screen's worth of idle
// time between "context exists" and "start playing" the way a real run
// does, so without waiting, a TRACK/AUTO preference would almost always
// lose the race and silently fall back to procedural, defeating the whole
// point of this panel.
startBtn.addEventListener("click", async () => {
  if (startBtn.disabled) return;
  startBtn.disabled = true;
  startBtn.textContent = "LOADING…";
  const pref = document.querySelector('input[name="backend"]:checked')?.value ?? "auto";
  music.setBackendPreference(pref);
  for (const radio of document.querySelectorAll('input[name="backend"]')) radio.disabled = true; // the choice is about to freeze — see synth.js's resolveBackend()
  await music.startContext();
  music.startMusicLoop();
  setSoundLevel(Number(soundSlider.value));
  setMusicLevel(Number(musicSlider.value));
  setSpeed(Number(speedSlider.value));
  startBtn.textContent = "AUDIO STARTED";

  setInterval(() => {
    const backend = music.getSelectedBackendName() ?? "?";
    const track = music.currentTrackName();
    statusEl.textContent = track ? `backend: ${backend} — playing: ${track}` : `backend: ${backend}`;
  }, 500);
});

// One key per catalogue entry, in catalogue order — 1-9 then 0, which is
// exactly enough for today's ten entries (disconnect + the nine combat
// sounds) and simply runs out gracefully (no key bound) once the catalogue
// grows past it; click still reaches every entry regardless.
const KEYS = "1234567890";

SOUND_TYPES.forEach((entry, i) => {
  const key = KEYS[i] ?? "";

  const btn = document.createElement("button");
  btn.className = "sound-cell";
  btn.innerHTML = `
    <div class="row1"><span class="id">${entry.id}</span>${key ? `<span class="key">${key}</span>` : ""}</div>
    <div class="stats">gain ${entry.gain} · duck ${entry.duck} · delay ${entry.delaySend} · pri ${entry.priority} · max ${entry.maxConcurrent} · min ${entry.minInterval}s</div>
  `;
  btn.addEventListener("click", () => music.play(entry.id));
  gallery.append(btn);

  if (key) {
    window.addEventListener("keydown", (e) => {
      // Ignore modified presses and repeats from a held key — one press,
      // one sound, same reasoning main.js's own edge-triggered actions use.
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === key) music.play(entry.id);
    });
  }
});

// --- Phase 8 step 3: sustained voices ---------------------------------------
//
// Unlike the one-shots above (click it, hear it, done), a sustained voice
// (audio/sustained.js) has no "play once" — it's acquired, held at a level
// for as long as it's toggled on, and released. Auditioning the interesting
// part of hull_hiss (its dropouts and crackle, which only fire well below
// the hiss's own on/off threshold — see sustainedfx.js) needs it held at a
// LOW hull fraction for several real seconds, not a single click, so each
// card here is a toggle plus (where the voice has one continuous driving
// value worth scrubbing by hand) a slider, ticked by a small setInterval
// loop rather than needing a real "playing" tick from main.js.
//
// PER-ID DRIVING CONFIG, not fully catalogue-generic like the one-shot grid
// above: each sustained voice is driven by a DIFFERENT kind of game state
// (a hull fraction, a countdown of seconds, a boolean), so there's no single
// slider shape that fits all three. A voice with no entry here (a future
// fourth sustained sound, say) just gets a plain toggle — still fully
// auditionable, only without a value to scrub.
const SUSTAINED_DRIVERS = {
  hull_hiss: {
    sliderLabel: "hull %",
    min: 0, max: 100, step: 1, start: 40,
    // `value` is the slider's raw 0-100; drive() is called every tick while
    // toggled on. `glitching` is always false here — there's no sectors.js
    // rescan running on this page, so the crackle-sync nudge (sustainedfx.js's
    // own updateHullHiss) simply never fires; the crackle still fires on its
    // own schedule regardless.
    drive: (value, dt) => music.updateHullHiss(dt, value / 100, false),
    off: () => music.updateHullHiss(1 / 60, 1, false), // force above HULL_HISS_ON so it releases cleanly
  },
  shield_drone: {
    sliderLabel: "shield s",
    min: 0, max: 6, step: 0.1, start: 5,
    // A manual scrub, not an auto-countdown — dragging the slider down
    // through SHIELD_DRONE_FADE_WINDOW is what auditions the fade-out.
    drive: (value) => music.updateShieldDrone(value),
    off: () => music.updateShieldDrone(0),
  },
  wall_scrape: {
    // No continuous value — contact is a plain boolean (player.hitWall).
    drive: () => music.updateWallScrape(true),
    off: () => music.updateWallScrape(false),
  },
  dread_pulse: {
    sliderLabel: "closeness %",
    min: 0, max: 100, step: 1, start: 50,
    // 100 = right on the player's tail (gap 0), 0 = the edge of the threat
    // range (DREAD_RANGE_ON) — the inverse of sustainedfx.js's own
    // dreadProximity(). `closing` is held true throughout so the slider
    // alone drives the rate/level curve by ear, exactly the way the design
    // brief asks for ("a threat-level slider so the rate curve is tunable
    // by ear").
    drive: (value, dt) => music.updateDreadPulse(dt, { gap: DREAD_RANGE_ON * (1 - value / 100), closing: true }),
    off: () => music.updateDreadPulse(1 / 60, null),
  },
};

const TICK_MS = 50;

SUSTAINED_TYPES.forEach((entry) => {
  const driver = SUSTAINED_DRIVERS[entry.id] ?? {};

  const card = document.createElement("div");
  card.className = "sound-cell sustained-cell";

  const sliderRow = driver.min !== undefined
    ? `<div class="sustained-slider">
         <input type="range" min="${driver.min}" max="${driver.max}" step="${driver.step}" value="${driver.start}" />
         <span class="value"></span>
       </div>`
    : "";

  card.innerHTML = `
    <div class="row1"><span class="id">${entry.id}</span><button class="toggle" type="button">OFF</button></div>
    <div class="stats">${entry.label}${driver.sliderLabel ? ` — ${driver.sliderLabel}` : ""}</div>
    ${sliderRow}
  `;
  sustainedGallery.append(card);

  const toggleBtn = card.querySelector(".toggle");
  const slider = card.querySelector("input[type=range]");
  const sliderValue = card.querySelector(".sustained-slider .value");
  if (slider) sliderValue.textContent = slider.value;

  let timer = null;
  toggleBtn.addEventListener("click", () => {
    if (!startBtn.disabled) return; // audio hasn't started (startBtn only disables once it has) — nothing to toggle yet
    const on = toggleBtn.textContent === "OFF";
    toggleBtn.textContent = on ? "ON" : "OFF";
    if (on) {
      timer = setInterval(() => driver.drive?.(slider ? Number(slider.value) : true, TICK_MS / 1000), TICK_MS);
    } else {
      clearInterval(timer);
      driver.off?.();
    }
  });

  if (slider) {
    slider.addEventListener("input", () => {
      sliderValue.textContent = slider.value;
    });
  }
});

// --- Phase 8 step 5: the full sector-transition sequence --------------------
//
// The one-shots grid above already gets a "sector_shift" cell for free (it's
// a plain SOUND_TYPES entry) — clicking it plays the gong alone. What it
// CAN'T audition is the other half of the transition: context.js's musicFilter
// collapse/reopen, which isn't a catalogue entry at all, just a side effect
// of synth.js's triggerSectorTransition(). This button fires the SAME call
// main.js's own sector-crossing edge-detector does, so the gong and the
// filter collapse can be judged together, the way they're actually heard in
// the game — "that one sequence can't be judged from the gong alone" per the
// design brief.
const transitionGallery = document.getElementById("transitionGallery");
if (transitionGallery) {
  const btn = document.createElement("button");
  btn.className = "sound-cell";
  btn.innerHTML = `
    <div class="row1"><span class="id">sector_shift (full sequence)</span></div>
    <div class="stats">gong + musicFilter collapse (300ms) / reopen (1.5s) — the pair main.js fires together on a sector crossing</div>
  `;
  btn.addEventListener("click", () => music.triggerSectorTransition());
  transitionGallery.append(btn);
}
