// Neon drawing helpers: glowing strokes/shapes on a dark background.
// All helpers save/restore context state so callers stay clean.

import { renderScale } from "./viewport.js";
import { GLYPHS, advance, textWidth } from "./vectorfont.js";

export function clear(ctx, color = "#05060a") {
  ctx.fillStyle = color;
  // The canvas's own width/height are DEVICE pixels while this context draws in
  // logical units (engine/viewport.js), so the rect is derived by dividing the
  // backing store back down rather than read off it — otherwise the clear would
  // cover `scale` times the screen and pay fill-rate for the excess.
  //
  // renderScale(), NOT ctx.getTransform(): getTransform ALLOCATES a DOMMatrix,
  // and this runs once per frame on the hot path. Reading the module's own
  // number is free and gives the identical value. The division also keeps this
  // correct for offscreen surfaces, whose backing store is likewise `scale`
  // times their logical size, and for the untransformed canvases the asset
  // gallery builds (scale is 1 there, so it reduces to the raw size).
  const s = renderScale();
  ctx.fillRect(0, 0, ctx.canvas.width / s, ctx.canvas.height / s);
}

// The HUD layer's own clear (Phase 15c, main.js's `#hud` canvas). Transparent,
// unlike clear() above: the HUD sits over the bloomed world canvas and has to
// let it show through everywhere it isn't drawing a readout, where the world
// canvas is the opaque bottom of the stack and paints over whatever was there
// last frame instead.
export function clearHud(ctx) {
  const s = renderScale();
  ctx.clearRect(0, 0, ctx.canvas.width / s, ctx.canvas.height / s);
}

// A single glowing line segment.
//
// THROUGH PHASE 15D-I THIS CARRIED ITS OWN ctx.shadowBlur — a small, bounded
// bounding box (a panel line, a building strip), so unlike neonStroke's
// canvas-spanning paths the shadow was never expensive; carshapes.js's header
// and sprites.js's GLOW_PAD both used to cite "max shadowBlur used here is 13"
// against exactly this. 15d-ii drops it anyway: this draw is almost always
// baked into a CACHED sprite (spritecache.js), and bloom now runs over the
// WHOLE finished frame regardless of how a pixel got bright — a shadow baked
// into the sprite bitmap and bloom's own halo over the same bright pixels
// double up, the identical "doubled halo" trap present.js's header already
// warns about for neonStroke plus bloom. One glow, from one place, is what
// keeps that provable rather than merely tuned to look right today.
export function glowLine(ctx, x1, y1, x2, y2, color, width = 2) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

// A glowing closed polygon from an array of [x, y] points. See glowLine's
// header for why this no longer carries its own shadowBlur either.
export function glowPoly(ctx, points, color, width = 2, fill = null) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.stroke();
  ctx.restore();
}

// A glowing OPEN polyline, drawn WITHOUT ctx.shadowBlur.
//
// THROUGH PHASE 15D-I, THIS STROKED THE PATH THREE TIMES — wide and faint,
// narrower and brighter, then the bright core — because a real blur filter's
// cost scales with the shadow's BOUNDING-BOX AREA, not the shape: one
// canvas-spanning path (a road barrier) was brutally expensive under
// `shadowBlur` (~865us on a 600x800 canvas, net of the clear, against ~90us
// unshadowed), and the three overdraw passes bought a halo for ~215us instead
// — 4x cheaper, and closer to real neon than a Gaussian blur reads anyway.
// `spread` and `halo` were the two knobs that shaped that overdraw: how much
// wider the faint outer pass ran, and how faint it was.
//
// PHASE 15D-II RETIRES THE OVERDRAW. Bloom (`engine/present.js`) now supplies
// the halo, PER PIXEL, over the whole finished frame — so a second, hand-tuned
// halo baked into the 2D layer would double up with it (see present.js's
// header on why the two were kept apart through 15b/15d-i). What is left is
// exactly the old bright-core pass: one stroke, full width, full alpha, colour
// bright enough that bloom's threshold catches it. `spread` and `halo` are
// GONE from the signature — there is no longer an overdraw for them to shape —
// and moved into what bloom itself owns: `present.js`'s BLOOM_THRESHOLD/
// BLOOM_EXPOSURE and the half/quarter blur mix, tuned once for the whole frame
// rather than once per call site. See README's Phase 15d-ii entry for the
// before/after cost.
//
// `build(ctx)` issues the moveTo/lineTo calls and must NOT call beginPath, so a
// caller can batch many disjoint segments (e.g. all the centre dashes) into one
// path and pay for the one stroke only once.
// `alpha` scales the stroke, which is what lets a transient effect (an
// explosion fragment) fade out.
export function neonStroke(ctx, build, color, width = 2, alpha = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  build(ctx);
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

// Glowing text. `bold` only changes the font weight — every other knob
// (color, blur) still does the actual glow, so a bold call reads as "this
// number matters more" rather than as a different style of text.
export function glowText(ctx, text, x, y, color, size = 16, align = "left", blur = 10, bold = false) {
  ctx.save();
  ctx.font = `${bold ? "bold " : ""}${size}px "Courier New", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// THE GAME'S DISPLAY TYPE, stroked from engine/vectorfont.js's alphabet rather
// than filled from a system font — see that module's header for why the title
// stopped being `Courier New` and what it bought.
//
// NO ctx.shadowBlur, and unlike glowText below that is not an oversight to be
// corrected later: this draws on the BLOOMED canvas (main.js's render() owns
// the split), so bloom already supplies a per-pixel halo over exactly these
// pixels. A baked shadow underneath it is the doubled glow 15d-ii removed from
// every other stroke in the game — see glowLine's header — and on text
// specifically it is what made the old title's halo blotchy: two letters'
// shadow skirts summing over BLOOM_THRESHOLD wherever the glyphs crowded, then
// the composite's knee saturating that sum into an opaque patch.
//
// `align` matches glowText's: "left" | "center" | "right", measured off the
// same `x`. `y` is the cap's TOP, matching `textBaseline = "top"` everywhere
// else, so a vector string drops into a glowText call site without moving.
//
// `track` is EXTRA space between cells, in cap-height units — the knob that
// turns a word from a tight banner into the wide, airy lettering an arcade
// marquee used. It is the caller's, not the font's, because the same alphabet
// wants to be tight at 54px and open at 11px.
export function vectorText(ctx, text, x, y, color, capHeight, align = "left", width = 2, track = 0.12) {
  const trackPx = track * capHeight;
  const total = textWidth(text, capHeight, trackPx);
  let cx = align === "center" ? x - total / 2 : align === "right" ? x - total : x;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // ONE PATH FOR THE WHOLE STRING, not one stroke per glyph: a stroke is a
  // pipeline flush and the reason the road's barriers needed a cache at all
  // (game/road.js's strip cache). Batching a title into a single stroke keeps
  // an eleven-letter banner at the cost of one.
  ctx.beginPath();
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (const poly of glyph) {
        for (let i = 0; i < poly.length; i++) {
          const px = cx + poly[i][0] * capHeight;
          const py = y + poly[i][1] * capHeight;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
      }
    }
    cx += advance(capHeight, trackPx);
  }
  ctx.stroke();
  ctx.restore();
}

// A SEGMENTED METER, the instrument that replaced "SOUND: 50%" on the menu.
//
// `steps` is the number of segments AND the number of keypresses that cross
// the whole range (menu.js asserts that against its own VOLUME_STEP), so the
// meter is not an approximation of the value — it IS the value, counted. That
// is the same reason the HUD shows a hull BAR rather than a percentage: an
// instrument is read at a glance, a number has to be parsed.
export function segmentMeter(ctx, x, y, w, h, level, steps, color, dim) {
  const gap = 2;
  const seg = (w - gap * (steps - 1)) / steps;
  const lit = Math.round(level * steps);
  ctx.save();
  for (let i = 0; i < steps; i++) {
    const sx = x + i * (seg + gap);
    if (i < lit) {
      ctx.fillStyle = color;
      ctx.fillRect(sx, y, seg, h);
    } else {
      ctx.strokeStyle = dim;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, y + 0.5, seg - 1, h - 1);
    }
  }
  ctx.restore();
}
