// The one point-generator behind every rounded silhouette in the game.
//
// Four modules had grown their own copy of this loop — obstacleshapes.js kept
// both `circle` and `ngon` (the first is the second with rot = 0),
// pickupshapes.js's `ngon` was byte-identical to obstacleshapes.js's and said so
// in a comment, bossshapes.js's `ring` was the same thing centred on the origin,
// and buildingshapes.js's `ngon` was the same thing with independent x/y radii.
// One primitive covers all four.
//
// WHY EVERY CALLER STILL HAS ITS OWN NAME. Each module keeps a one-line wrapper
// in its own vocabulary (`circle`, `ring`, `ngon`) rather than calling this
// directly. The wrappers are free, the shape tables that call them are long and
// read better in domain terms, and the argument orders differ in ways that are
// natural where they are used — a building footprint is stated as a width and a
// depth, a mine core as a radius. This file owns the arithmetic; the names stay
// local.
//
// A polygon, not an arc: everything here goes on to glowPoly/neonStroke, which
// take point lists so a caller can batch many shapes into one path. `n` is
// therefore a resolution knob — around 20 reads as a circle at the sizes drawn
// here, and lower values are the point for a hexagonal plate or a triangle.

// `n` points evenly spaced around the ellipse of radii (rx, ry) centred at
// (cx, cy), starting at angle `rot` (RADIANS, measured from +x) and running
// clockwise in screen space. The list is open — the first point is not repeated
// at the end — since glowPoly closes the path itself.
export function polygon(cx, cy, rx, ry, n, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

// The six tapered spikes of a caltrop, as six separate triangles.
//
// Shared because the pickup crate's MINE glyph is deliberately the road
// hazard's silhouette in miniature (see pickupshapes.js's drawMineGlyph) — the
// two are supposed to be the same shape, so they should not be two hand-kept
// point lists that could drift into merely similar.
//
// Each spike is a triangle rather than a line so it survives the glow at small
// sizes instead of dissolving into a smudge: it runs from a point at radius
// `r + spike` back to a base of width 2 * `halfWidth` straddling radius `r`.
// Only the geometry is shared — colour, stroke width and fill stay with the
// caller, since the hazard and the glyph are drawn at different weights.
export function caltropSpikes(cx, cy, r, spike, halfWidth) {
  const tris = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    tris.push([
      [cx + dx * (r + spike), cy + dy * (r + spike)],
      [cx + dx * r - dy * halfWidth, cy + dy * r + dx * halfWidth],
      [cx + dx * r + dy * halfWidth, cy + dy * r - dx * halfWidth],
    ]);
  }
  return tris;
}
