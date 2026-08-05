// Neon drawing helpers: glowing strokes/shapes on a dark background.
// All helpers save/restore context state so callers stay clean.

export function clear(ctx, color = "#05060a") {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

// A single glowing line segment.
export function glowLine(ctx, x1, y1, x2, y2, color, width = 2, blur = 12) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

// A glowing closed polygon from an array of [x, y] points.
export function glowPoly(ctx, points, color, width = 2, blur = 12, fill = null) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
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

// A glowing OPEN polyline, drawn WITHOUT ctx.shadowBlur: the path is built once
// and then stroked a few times — wide and faint, then narrower and brighter — so
// the halo comes from overdraw instead of a blur filter.
//
// Why not shadowBlur: its cost scales with the shadow's BOUNDING-BOX AREA, not
// with the shape, so one canvas-spanning path (a road barrier) is brutally
// expensive. Measured on a 600x800 canvas, net of the frame clear: ~865us for a
// single full-height shadowed barrier vs ~90us for the same stroke unshadowed.
// The three overdraw passes below come to ~215us — 4x cheaper than the shadow,
// and they read closer to real neon anyway.
//
// `build(ctx)` issues the moveTo/lineTo calls and must NOT call beginPath, so a
// caller can batch many disjoint segments (e.g. all the centre dashes) into one
// path and pay for the three strokes only once.
// `alpha` scales all three passes together, which is what lets a transient effect
// (an explosion fragment) fade out without losing the halo's relative weighting.
export function neonStroke(ctx, build, color, width = 2, spread = 4, halo = 0.13, alpha = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  build(ctx);

  // Outer halo: widest and faintest.
  ctx.globalAlpha = halo * alpha;
  ctx.lineWidth = width * spread;
  ctx.stroke();

  // Inner halo.
  ctx.globalAlpha = halo * 2.1 * alpha;
  ctx.lineWidth = width * (1 + (spread - 1) * 0.45);
  ctx.stroke();

  // The bright core line itself.
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

// A glowing ring made of dashes, genuinely rotating via an animated dash
// offset rather than a squashed ellipse faking it — the shield buff
// (game/player.js) draws two of these, spinning opposite ways, around the car.
export function glowDashedRing(ctx, cx, cy, r, color, dashOffset, width = 2, blur = 11, dash = [8, 10]) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.setLineDash(dash);
  ctx.lineDashOffset = dashOffset;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Glowing text.
export function glowText(ctx, text, x, y, color, size = 16, align = "left", blur = 10) {
  ctx.save();
  ctx.font = `${size}px "Courier New", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillText(text, x, y);
  ctx.restore();
}
