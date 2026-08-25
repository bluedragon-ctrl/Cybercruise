// Offscreen sprite cache: render an expensive drawing ONCE into its own little
// canvas, then blit it with drawImage on every frame after that.
//
// This is the biggest render win available to us. Every neon primitive carries a
// ctx.shadowBlur, and blur cost is paid per draw call, per frame — so an asset
// built from ~19 glowing strokes costs the same every single frame even though
// it looks identical. Measured on a 600x800 canvas: a car is ~226us drawn live
// and ~8us blitted from cache (~27x); a building is ~6-9x.
//
// The trade is memory and cache-key discipline: the key must cover everything
// that changes the asset's pixels, and callers must keep the number of distinct
// keys bounded (quantise continuous parameters — see sprites.js).

import { renderScale, createSurface } from "./viewport.js";

const cache = new Map();

// The raster scale every live entry was built at. Sprites are rasterised at the
// SAME device resolution as the main canvas (see engine/viewport.js), so a
// window move that changes that scale makes every cached bitmap the wrong
// resolution at once — blitting them would resample and undo the sharpness the
// rescale was for. Checked here rather than folded into each caller's key
// because the whole cache turns over together anyway, and a full clear costs
// nothing next to keeping five stale generations of the car catalogue alive.
let cacheScale = 1;

// Blends a "#rrggbb" colour toward white by `amount` (0 = unchanged, 1 =
// white) — used to derive the entry-wipe scanline's colour from a sprite's
// OWN edge colour (see blitSpriteMaterialising below) rather than a fixed
// tint, so the scan reads as "this building's own outline, lit up" instead
// of a generic system overlay that happens to sit on top of it. Plain
// component-wise lerp toward 255, not an HSL brighten — cheap, and every
// colour this is ever called with (BUILDING_EDGE/NODE_BRACKET, across every
// sector) is already a saturated neon hue where the two look the same.
function lighten(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `rgb(${lr}, ${lg}, ${lb})`;
}

// How far toward white the leading-edge scanline sits above the sprite's own
// edge colour — bright enough to read as "lit up", not so far that every
// sector's own hue washes out to the same near-white.
const SCAN_LIGHTEN = 0.55;

// Fetch (or build) the sprite for `key`.
//
// `draw(ctx, originX, originY)` renders the asset into a fresh transparent
// canvas of `width` x `height`, anchored at (originX, originY). The anchor is
// whatever point the caller wants to position by — the centre of a car, the
// base-centre of a building — and it need not be the canvas centre, which lets
// asymmetric assets (a building extruding upward) keep a tight bounding box.
//
// The anchor is SNAPPED TO A WHOLE PIXEL, and the snapped value is what gets
// handed to `draw`. Otherwise a fractional anchor would rasterise the asset at a
// sub-pixel offset inside its own sprite and then blit it at another fractional
// offset, resampling twice and visibly softening the artwork. Callers get the
// integer back via the returned sprite, so placement stays consistent.
export function getSprite(key, width, height, originX, originY, draw) {
  const scale = renderScale();
  if (scale !== cacheScale) {
    cache.clear();
    cacheScale = scale;
  }

  const hit = cache.get(key);
  if (hit) return hit;

  const ox = Math.round(originX);
  const oy = Math.round(originY);
  // +1 absorbs the rounding so snapping the anchor can never clip the artwork.
  // These are LOGICAL dimensions; the surface's own backing store is `scale`
  // times larger, and its context is pre-transformed so `draw` never finds out.
  const w = Math.ceil(width) + 1;
  const h = Math.ceil(height) + 1;
  const canvas = createSurface(w, h);
  draw(canvas.getContext("2d"), ox, oy);

  // `w`/`h` are carried on the sprite because every blit below positions and
  // clips in logical space, where canvas.width/height are the wrong numbers by
  // exactly `scale`.
  const sprite = { canvas, w, h, originX: ox, originY: oy };
  cache.set(key, sprite);
  return sprite;
}

// Blit a cached sprite so its anchor point lands exactly on (cx, cy).
// Subpixel positions are kept (not rounded) so motion stays smooth; the bilinear
// resample that costs is negligible next to re-rendering the glow.
export function blitSprite(ctx, sprite, cx, cy) {
  // The explicit destination size is not optional: without it the sprite would
  // be drawn at its DEVICE dimensions read as logical ones. With it, source and
  // destination cover the same device pixels and the copy stays 1:1.
  ctx.drawImage(sprite.canvas, cx - sprite.originX, cy - sprite.originY, sprite.w, sprite.h);
}

// Blit a cached sprite showing only the bottom `progress` fraction of it
// (Phase 7g's entry-wipe materialisation) — save(), clip() to a rect over
// that slice of the blit's DESTINATION rectangle, draw, restore(). Anchor
// convention matches blitSprite exactly (a building/node is anchored at its
// own base centre — see sprites.js), so the slice grows UPWARD from the
// sprite's bottom edge as `progress` climbs toward 1, which is what reads as
// the building resolving from the ground up.
//
// Deliberately a SEPARATE function from blitSprite, not a progress<1 branch
// inside it: the common case (progress >= 1, ~70 of ~70-odd buildings a
// typical frame) has to take the plain, no-clip path with zero save/restore
// overhead, and callers (sprites.js's drawBuildingVariant/drawNodeVariant)
// branch on that themselves before ever reaching here — this function only
// runs for the one or two lot rows currently crossing the screen's top edge.
//
// A LEADING-EDGE SCANLINE rides the clip boundary, drawn AFTER restore() so
// it sits outside the clip and is never itself cut off. A plain clip alone
// reads as "the bottom of this building happens to be a bit brighter"; a
// line that visibly SWEEPS up the silhouette as progress climbs is what
// actually sells "being scanned in" rather than just quietly popping in a
// bit early. Coloured off the sprite's OWN edge colour (`color`, lightened —
// see `lighten` above), not a fixed system tint: it reads as this building's
// own outline lighting up, which fits a per-sector palette without a new
// colour entry needing to exist for every sector.
//
// BROKEN INTO STATIC, not one clean bar — a solid line reads as drawn UI, not as
// a signal. Short random-width segments along the boundary plus a few loose
// flecks just above it read as the image resolving out of noise rather than a
// hard-edged cutoff. Genuinely random EVERY FRAME (Math.random(), not seeded
// from progress or position): a flicker that repeated identically frame to frame
// would read as a texture, not as noise. Purely cosmetic — nothing here feeds
// back into `progress`.
//
// BATCHED, not one fillRect per segment/fleck: multiple ctx.rect() calls between
// one beginPath()/fill() are one fill, not one each, and per-piece fillRect plus
// globalAlpha toggling costs ~15-20 draw calls per materialising sprite against
// this version's two. Isolated per-call cost (rAF-saturation, warmed cache): a
// fully-materialised drawBuildingVariant is ~13us, the same call mid-wipe ~39us
// — that ~26us difference is this whole function, clip included.
//
// `margin` trims the segments in from each side of the sprite canvas — every
// cached sprite here reserves GLOW_PAD px of empty margin around its own
// artwork so a shape's glow isn't clipped by the offscreen canvas edge (see
// sprites.js's own GLOW_PAD), and segments drawn across the sprite's full
// width would span that empty margin too, reading as "wider than the
// building" rather than hugging its silhouette. Callers pass their own
// GLOW_PAD; this module has no opinion on what it is, only that some of the
// canvas edge is margin.
const STATIC_FLECKS_MAX = 6;
const STATIC_FLECK_SPREAD = 10; // px above the scan boundary a fleck can land

export function blitSpriteMaterialising(ctx, sprite, cx, cy, progress, color, margin = 0) {
  const x = cx - sprite.originX;
  const y = cy - sprite.originY;
  const h = sprite.h;
  const clipTop = y + h * (1 - progress);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, clipTop, sprite.w, y + h - clipTop);
  ctx.clip();
  ctx.drawImage(sprite.canvas, x, y, sprite.w, h);
  ctx.restore();

  const scanColor = lighten(color, SCAN_LIGHTEN);
  const barX = x + margin;
  const width = sprite.w - margin * 2;

  // The boundary itself: broken segments, not one continuous bar — but ONE
  // path, ONE fill, ONE shadowBlur setup for however many segments land.
  ctx.save();
  ctx.shadowColor = scanColor;
  ctx.shadowBlur = 6;
  ctx.fillStyle = scanColor;
  ctx.beginPath();
  for (let sx = 0; sx < width; ) {
    const segW = 3 + Math.random() * 8;
    if (Math.random() < 0.7) {
      ctx.rect(barX + sx, clipTop - 1, Math.min(segW, width - sx), 2);
    }
    sx += segW + Math.random() * 4;
  }
  ctx.fill();

  // Loose static above the line, fading out as the row nears full reveal —
  // the "not yet resolved" band getting sparser rather than snapping clean.
  // No shadowBlur (a stray pixel doesn't need its own glow pass) and ONE
  // shared alpha for the whole batch rather than a per-fleck random one —
  // the fade still reads, and it keeps this a single fill() too.
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.45 * (1 - progress) + 0.1;
  ctx.beginPath();
  const flecks = Math.round(STATIC_FLECKS_MAX * (1 - progress));
  for (let i = 0; i < flecks; i++) {
    ctx.rect(
      barX + Math.random() * width,
      clipTop - 2 - Math.random() * STATIC_FLECK_SPREAD,
      1, 1,
    );
  }
  ctx.fill();
  ctx.restore();
}

// Below this many radians (~0.06°) a rotation is invisible, so it is skipped
// entirely: the sprite goes through the plain axis-aligned blit above and keeps
// its pixels UNRESAMPLED. Worth the branch — a road is straight-ish a fair
// fraction of the time, and that is exactly when the crispest artwork shows.
const ANGLE_EPSILON = 0.001;

// Blit a cached sprite ROTATED by `angle` radians (clockwise on screen, matching
// canvas convention) about its anchor, so the anchor still lands on (cx, cy).
//
// Rotation happens HERE, at blit time, and deliberately never reaches the cache
// key. Baking angle into the key instead would multiply every entry by however
// many angle steps were sampled — the car catalogue alone (160 sprites, ~7MB)
// would become thousands of entries and ~100MB, to buy a look that still stepped
// visibly on a slow bend. Rotating the blit costs one transform and a resample of
// the same pixels drawImage was already touching, and the cache stays exactly the
// size it was.
export function blitSpriteRotated(ctx, sprite, cx, cy, angle) {
  if (Math.abs(angle) < ANGLE_EPSILON) {
    blitSprite(ctx, sprite, cx, cy);
    return;
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  // Anchor is now the origin, so the sprite hangs off it by the same vector the
  // unrotated blit subtracts — the rotation carries it round for free.
  ctx.drawImage(sprite.canvas, -sprite.originX, -sprite.originY, sprite.w, sprite.h);
  ctx.restore();
}
