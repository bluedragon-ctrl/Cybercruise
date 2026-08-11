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

const music = createMusic();

const gallery = document.getElementById("gallery");
const startBtn = document.getElementById("start");
const soundSlider = document.getElementById("sound");
const musicSlider = document.getElementById("music");
const soundLabel = document.getElementById("soundLabel");
const musicLabel = document.getElementById("musicLabel");

function setSoundLevel(v) {
  music.setSfxVolume(v);
  soundLabel.textContent = `${Math.round(v * 100)}%`;
}

function setMusicLevel(v) {
  music.setVolume(v);
  musicLabel.textContent = `${Math.round(v * 100)}%`;
}

soundSlider.addEventListener("input", () => setSoundLevel(Number(soundSlider.value)));
musicSlider.addEventListener("input", () => setMusicLevel(Number(musicSlider.value)));

// Before start(), music.play()/setVolume()/setSfxVolume() are all silent
// no-ops (see synth.js/context.js's own contract) — so the sliders can be
// dragged freely before the button is pressed, they just have nothing to
// affect yet. The levels are pushed again the instant audio actually starts
// so the engine picks up wherever the sliders were left.
startBtn.addEventListener("click", () => {
  if (startBtn.disabled) return;
  music.start();
  setSoundLevel(Number(soundSlider.value));
  setMusicLevel(Number(musicSlider.value));
  startBtn.textContent = "AUDIO STARTED";
  startBtn.disabled = true;
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
