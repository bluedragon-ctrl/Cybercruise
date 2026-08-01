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

const cache = new Map();

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
  const hit = cache.get(key);
  if (hit) return hit;

  const ox = Math.round(originX);
  const oy = Math.round(originY);
  const canvas = document.createElement("canvas");
  // +1 absorbs the rounding so snapping the anchor can never clip the artwork.
  canvas.width = Math.ceil(width) + 1;
  canvas.height = Math.ceil(height) + 1;
  draw(canvas.getContext("2d"), ox, oy);

  const sprite = { canvas, originX: ox, originY: oy };
  cache.set(key, sprite);
  return sprite;
}

// Blit a cached sprite so its anchor point lands exactly on (cx, cy).
// Subpixel positions are kept (not rounded) so motion stays smooth; the bilinear
// resample that costs is negligible next to re-rendering the glow.
export function blitSprite(ctx, sprite, cx, cy) {
  ctx.drawImage(sprite.canvas, cx - sprite.originX, cy - sprite.originY);
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
  ctx.drawImage(sprite.canvas, -sprite.originX, -sprite.originY);
  ctx.restore();
}

// Number of distinct sprites currently held — handy for asserting in dev that a
// cache key hasn't accidentally become unbounded.
export function spriteCacheSize() {
  return cache.size;
}
