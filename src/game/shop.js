// THE UPGRADE SHOP — A MOCKUP. Deliberately, and this header is the contract.
//
// The pickup/return sequence (game/hauler.js) and the state machine that hangs
// off it (main.js's "lifting"/"shopping"/"lowering") are the finished work; this
// screen is the placeholder standing in the middle of them so that transition
// can be built and felt end to end before there is anything to buy. It draws a
// dock frame, reports the bank, lists the upgrade CATEGORIES README's Phase 11
// names, and waits for a keypress to undock.
//
// WHAT PHASE 11 REPLACES, AND WHAT IT DOESN'T. Everything below the render()
// signature is throwaway. The signature itself is not: main.js drives this
// through exactly two calls — update() returning whether the player wants out,
// and render() — and a real shop with a moving cursor, a catalogue and
// Wallet.spend() wired in still only owes main.js those two. So the surgery
// when the catalogue arrives is inside this file, not across the state machine.
//
// IT SPENDS NOTHING. Wallet.spend() exists and works (wallet.js) but nothing
// here calls it: a mockup that could take the player's credits would be a
// mockup that can lose them. The wallet is READ and printed, never touched.
//
// AND THE MONEY IT PRINTS DIES WITH THE RUN — see main.js's CREDIT_STORE for
// why the persisted bank is switched off until the game has player records.
// That is why this screen quotes `credits` (what this run has) rather than
// `banked` (what earlier runs left), and says as much on the screen itself: a
// storefront is exactly where a player decides whether saving up is worth it,
// so it is the one place that must not imply a balance the game will not keep.
//
// NOT menu.js. The pause/game-over menu is a general row-and-slider widget with
// its own persisted volume state, and bending it into a storefront would mean
// teaching it about money for the sake of a placeholder. This is a few glowText
// calls that will be thrown away; it borrows menu.js's LOOK and none of its
// machinery.

import { glowText } from "../engine/neon.js";
import { GREEN, GREEN_BRIGHT, GREEN_PALE, GREEN_DIM, PLAYER } from "../engine/palette.js";
import { consumePress } from "../engine/input.js";

// The categories README's Phase 11 lists, shown greyed as a statement of intent
// rather than as anything selectable. When they become real they become a
// catalogue in the data-file style of cartypes.js, imported here — not a list
// of strings living in the screen that draws them.
const PLANNED = [
  "ENGINE — top speed",
  "CHASSIS — hull capacity",
  "TARGETING — multi-weapon fire",
  "DEFLECTOR — shield duration",
];

// Drawn straight over the frozen world (main.js returns before any world layer
// when this state is live), so this fill is the whole background. Matching
// neon.js's own clear() colour rather than pure black, at an alpha that lets a
// little of nothing through — see menu.js, which covers the world the same way.
const BACKDROP = "rgba(5, 6, 10, 0.96)";

export function createShop() {
  return {
    // One keypress out. Returns true on the tick the player asks to undock,
    // which is main.js's cue to rebuild the road and start the return trip.
    // Both "fire" and "pause" are accepted so neither SPACE nor ESC leaves the
    // player stuck in a screen with nothing in it — and both are CONSUMED
    // either way, so a press made here can never leak into the gameplay tick
    // on the far side of the lowering sequence (the leak jackin.js and
    // disconnect.js each drain their own inputs to prevent).
    update() {
      const fire = consumePress("fire");
      const pause = consumePress("pause");
      return fire || pause;
    },

    // `wallet` is read-only here — see the header on why this screen cannot
    // spend. `visit` is which shop stop this is (hauler.js's milestone count),
    // printed purely so the placeholder proves the milestone edge detector is
    // firing once per interval rather than repeatedly.
    render(ctx, W, H, wallet, visit) {
      ctx.save();
      ctx.fillStyle = BACKDROP;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // The dock frame — two nested rectangles in the road's own green, so the
      // screen reads as more deck chrome rather than as a different game.
      ctx.save();
      ctx.strokeStyle = GREEN_DIM;
      ctx.lineWidth = 1;
      ctx.strokeRect(28.5, 68.5, W - 57, H - 190);
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 2;
      ctx.strokeRect(24.5, 64.5, W - 49, H - 182);
      ctx.restore();

      glowText(ctx, "CARGO DOCK", W / 2, 92, GREEN_BRIGHT, 24, "center", 14, true);
      glowText(ctx, `STOP ${visit}`, W / 2, 122, GREEN_PALE, 12, "center", 6);

      // The one live number on the screen: what this run has to spend, right
      // now. `credits`, not `banked` — credits do not survive a run at all at
      // the moment (see main.js's CREDIT_STORE), so a "BANK" figure here would
      // be promising the player a balance that dies with their next crash.
      // The subtitle says so out loud rather than letting them find out.
      glowText(ctx, "CREDITS", W / 2, 168, GREEN_PALE, 12, "center", 6);
      glowText(ctx, `${wallet.credits} CR`, W / 2, 196, PLAYER, 30, "center", 16, true);
      glowText(ctx, "THIS RUN ONLY — NOT CARRIED OVER", W / 2, 226, GREEN_DIM, 11, "center", 0);

      glowText(ctx, "STOCK — PENDING", W / 2, 286, GREEN_PALE, 13, "center", 8);
      PLANNED.forEach((label, i) => {
        glowText(ctx, label, W / 2, 316 + i * 26, GREEN_DIM, 13, "center", 0);
      });

      glowText(ctx, "NOTHING FOR SALE YET", W / 2, 316 + PLANNED.length * 26 + 22,
        GREEN_DIM, 11, "center", 0);

      glowText(ctx, "SPACE / ESC — UNDOCK", W / 2, H - 96, GREEN_BRIGHT, 15, "center", 10);
    },
  };
}
