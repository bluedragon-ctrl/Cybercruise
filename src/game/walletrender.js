// Everything the wallet PUTS ON SCREEN, kept out of wallet.js itself.
//
// WHY THE SPLIT. wallet.js was doing four unrelated jobs at once — persisting
// credits, running the node-link gameplay rule, talking to the SYS LOG, and
// drawing — and the drawing was both the largest of the four and the only one
// that had no business being a method on a wallet. Nothing else in this
// codebase asks a state object to draw itself; the road, the floor and the
// links all keep their ink in their own render paths.
//
// THE SEAM IS THE PURE/IMPURE ONE wallet.js already drew for itself: hints()
// and linkGeometry() decide WHAT is on screen and where, are checkable under
// plain Node, and stay there. The three functions here take those results and
// turn them into ink, and take nothing else — so they are readable without
// knowing anything about how credits are earned.
import { glowText, neonStroke } from "../engine/neon.js";
import { GREEN_PALE, GREEN_BRIGHT, HAZARD } from "../engine/palette.js";
import { centerXAt } from "./road.js";
import { AWARD_MARK_LIFE, AWARD_MARK_RISE, DISH_MAST, DISH_R } from "./wallet.js";

// The link's dashes: length, gap, and px/sec of travel — brisk enough to read
// as flow at a glance, slow enough not to strobe. They march FROM THE NODE
// TOWARD THE CAR, because that is the direction the data is going and a beam
// running the other way would quietly say the player is uploading something.
const LINK_DASH = 7;
const LINK_GAP = 6;
const LINK_MARCH = 34;

// Both parts brighten as the hold fills, from "connecting" to "about to pay".
// The floor's bar is still the precise reading; this is the glance version, so
// it only has to get louder in the right direction.
const LINK_MIN_ALPHA = 0.3;

// THE PRICE OVER EACH NODE, and the drain meter under it.
//
// Takes the list Wallet.hints() already computed rather than a Wallet: the
// decision of WHICH nodes deserve a marker is a rule about money and reach and
// is tested without a canvas, and everything from here down is ink. Cost is
// bounded by that list, which the range rule holds to "the odd node beside the
// player" — nowhere near the per-frame node walk the floor already pays for.
export function renderNodeHints(ctx, marks) {
  for (const m of marks) {
    ctx.save();
    // A dormant node's price is a hint, not an offer — held well under the
    // live one so the two never compete for the same glance. A node being
    // drained reads as live whatever its ping is doing, because it is: the
    // player is taking it right now.
    const hot = m.live || m.charge > 0;
    ctx.globalAlpha = m.alpha * (hot ? 1 : 0.45);
    // THE PRICE IS THE AFFORDANCE, so it is sized to be read rather than to
    // be tidy. This is the only thing on the floor telling a player who is
    // not collecting that there is money out here at all — it took over that
    // job from a word prompt, and a number nobody notices would do the job
    // worse than the word did. Bold once the node is hot (lit, or being
    // drained), which is the moment it is worth steering at.
    glowText(ctx, `+${m.value}CR`, m.x, m.y + 24, hot ? GREEN_BRIGHT : GREEN_PALE, hot ? 16 : 14, "center", hot ? 12 : 5, hot);

    // THE DRAIN METER: a plain bar under the price, filling as the node
    // empties. No glow and no neonStroke — this is an instrument, like the
    // hull bar, and it has to be readable at a glance while the player is
    // watching traffic rather than watching it.
    //
    // EVERY pickup draws it now, including the ones that finish in a fifth
    // of a second. That is the point of drawing it: the fast take and the
    // slow one are visibly the same act, so nothing the player sees suggests
    // there are two ways to do this.
    if (m.charge > 0) {
      const bw = 44;
      const bx = m.x - bw / 2;
      // Clear of the price above it: the label's ink and glow reach y+34
      // (measured), so the bar starts below that rather than sharing pixels
      // with the number it is reporting on.
      const by = m.y + 38;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(bx - 1, by - 1, bw + 2, 5);
      ctx.fillStyle = GREEN_BRIGHT;
      ctx.fillRect(bx, by, bw * m.charge, 3);
    }
    ctx.restore();
  }
}


// THE RECEIPTS: what each recent payout was worth, hanging over the place it
// came from and drifting up as it fades. Drawn even when the thing that paid is
// gone — a collected node has stopped pinging and a destroyed car has left the
// road entirely, which is the point: these are not labels on objects, they are
// labels on things that HAPPENED.
//
// `marks` is Wallet's own live list (wallet.marks); it is read, never written.
export function renderAwardMarks(ctx, marks, player, distance, W) {
  for (const m of marks) {
    const frac = Math.max(0, m.life / AWARD_MARK_LIFE);
    // Where it sits this frame — see mark() on why the road plane has to be
    // re-projected while the floor plane does not.
    const x = m.kind === "road" ? centerXAt(m.worldY, W) + m.offset : m.x;
    // `player.y` is the screen row the car is drawn at — the same projection
    // every entity on the road plane uses in main.js's render.
    const y = (m.kind === "road" ? player.y - (m.worldY - distance) : m.y) - (1 - frac) * AWARD_MARK_RISE;
    ctx.save();
    ctx.globalAlpha = frac;
    // Red for a fine, in the same HAZARD the HUD's own award uses — the one
    // place money is allowed to borrow a faction colour, because here it IS
    // reporting on a faction: the car under this number was a civilian.
    // Sized ABOVE the price label above, deliberately: the offer is loud, and
    // the money actually landing has to be louder, or taking a node reads as
    // less of an event than being told it was available.
    glowText(ctx, `${m.value >= 0 ? "+" : ""}${m.value}CR`, x, y, m.value >= 0 ? GREEN_BRIGHT : HAZARD, 18, "center", 14, true);
    ctx.restore();
  }
}

// THE DISH AND ITS LINK. Drawn from main.js immediately AFTER the car, so the
// dish sits on the car rather than under it — and drawn in two neonStrokes
// rather than a dozen (see neon.js on why the path is batched): one for the
// link's dashes, one for the dish and its mast.
//
// The only thing in this module that draws in the CAR's layer rather than on
// the city floor, which is exactly the point of it (see wallet.js's THE DISH).
// `link` is Wallet.linkGeometry()'s output, or null when nothing is draining.
export function renderUplink(ctx, clockValue, link) {
  if (!link) return;

  // Faint at the moment the link takes, bright as it comes good.
  const alpha = LINK_MIN_ALPHA + (1 - LINK_MIN_ALPHA) * link.progress;

  // THE LINK: dashes marching node -> car. `clockValue` drives the march, so
  // it keeps step with the same floor clock the nodes' own pings run on and
  // stops dead when the game does.
  const start = DISH_MAST + DISH_R;                       // clear of the dish's mouth
  const span = Math.hypot(link.nx - link.ax, link.ny - link.ay) - start;
  if (span > 0) {
    const period = LINK_DASH + LINK_GAP;
    // Subtracted, not added: the pattern slides back down the beam toward
    // the car, which is the direction the credits are going.
    const phase = (clockValue * LINK_MARCH) % period;
    neonStroke(ctx, (c) => {
      for (let d = span - phase; d > 0; d -= period) {
        const from = Math.max(0, d - LINK_DASH);
        c.moveTo(link.ax + link.ux * (start + from), link.ay + link.uy * (start + from));
        c.lineTo(link.ax + link.ux * (start + d), link.ay + link.uy * (start + d));
      }
    }, GREEN_BRIGHT, 1.5, 3.5, 0.12, alpha * 0.8);
  }

  // THE DISH: a mast off the flank, a half-circle whose OPEN side faces the
  // node (the bulge points back at the car, the way a real dish's does), and
  // a stub feed horn standing in its mouth.
  const theta = Math.atan2(link.uy, link.ux);
  neonStroke(ctx, (c) => {
    c.moveTo(link.ax, link.ay);
    c.lineTo(link.dx, link.dy);
    c.moveTo(link.dx + Math.cos(theta + Math.PI / 2) * DISH_R,
             link.dy + Math.sin(theta + Math.PI / 2) * DISH_R);
    c.arc(link.dx, link.dy, DISH_R, theta + Math.PI / 2, theta + Math.PI * 1.5);
    c.moveTo(link.dx, link.dy);
    c.lineTo(link.dx + link.ux * DISH_R * 0.8, link.dy + link.uy * DISH_R * 0.8);
  }, GREEN_BRIGHT, 1.5, 3.5, 0.14, alpha);
}
