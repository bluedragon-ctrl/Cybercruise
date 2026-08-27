// THE UPGRADE SHOP — the storefront the cargo drone delivers the car to.
//
// The pickup/return sequence (game/hauler.js) and the state machine that hangs
// off it (main.js's "lifting"/"shopping"/"lowering") carry the car here; this
// screen is what the player does while they are up there. It draws a dock
// frame, reports the bank, and runs a cursor down two shelves — consumables and
// car systems — taking money for what it sells.
//
// IT OWNS NO NUMBERS. Every price, quantity, tier and effect lives in
// game/upgrades.js, in the data-file style cartypes.js and pickuptypes.js use;
// this file is a cursor, a layout and a colour scheme. Adding a thing to sell is
// a catalogue edit and nothing here changes. That split is what the mockup this
// replaced promised ("when they become real they become a catalogue... not a
// list of strings living in the screen that draws them").
//
// MAIN.JS STILL DRIVES IT THROUGH EXACTLY TWO CALLS — update() and render() —
// which is the contract the mockup was built to protect, and it survived the
// surgery intact. What CHANGED is the shape of update()'s answer: a bool
// ("does the player want out?") is no longer enough now that a keypress can
// also buy something, so it returns a short action string instead. See update().
//
// IT NEVER TOUCHES AUDIO, and that is the same rule game/menu.js follows for the
// same reason: main.js reads the action string and decides which menu tone to
// play. A game module that imported the synth would be a game module that could
// not be tested headless.
//
// NOT menu.js. The pause/game-over menu is a row-and-slider widget with its own
// persisted volume state; bending it into a storefront would mean teaching it
// about money, tiers and affordability. This borrows menu.js's LOOK and its
// consumePress cursor idiom, and none of its machinery.
//
// THE MONEY IT SPENDS DIES WITH THE RUN, and so does everything it sells — see
// main.js's CREDIT_STORE for why the persisted bank is switched off until the
// game has player records, and upgrades.js's header for why the tier ladder is
// deliberately scoped the same way. That is why this screen quotes `credits`
// (what this run has) rather than `banked` (what earlier runs left), and says as
// much on the screen itself: a storefront is exactly where a player decides
// whether saving up is worth it, so it is the one place that must not imply a
// balance the game will not keep.

import { glowText } from "../engine/neon.js";
import { GREEN, GREEN_BRIGHT, GREEN_PALE, GREEN_DIM, PLAYER, HAZARD } from "../engine/palette.js";
import { consumePress } from "../engine/input.js";
import {
  CONSUMABLES,
  STATS,
  TIER_COUNT,
  priceOf,
  purchase,
  statValue,
} from "./upgrades.js";
import { AMMO, HEAL, SHIELD } from "./pickuptypes.js";

// Drawn straight over the frozen world (main.js returns before any world layer
// when this state is live), so this fill is the whole background. Matching
// neon.js's own clear() colour rather than pure black, at an alpha that lets a
// little of nothing through — see menu.js, which covers the world the same way.
const BACKDROP = "rgba(5, 6, 10, 0.96)";

// THE SHELF, as one flat list of rows the cursor walks. Headings are not rows —
// they are drawn from the same structure but skipped by the cursor, because a
// caption you can land on is a caption the player has to press past.
//
// The last row is the way out. It is a ROW rather than "press SPACE anywhere"
// so that the fire key means exactly one thing on this screen — buy the thing
// under the cursor — and undocking is something the player aims at. ESC still
// leaves from anywhere, for the player who has finished shopping and does not
// want to scroll.
const UNDOCK = { id: "undock", label: "UNDOCK", undock: true };

const SHELVES = [
  { heading: "CONSUMABLES", entries: CONSUMABLES },
  { heading: "CAR SYSTEMS", entries: STATS },
  { heading: null, entries: [UNDOCK] },
];

// Every buyable row, in cursor order. Flattened ONCE at module load rather than
// rebuilt per frame: the catalogue cannot change at runtime, and this screen is
// drawn every frame the player stands in it.
const ROWS = SHELVES.flatMap((shelf) => shelf.entries);

// --- Layout ------------------------------------------------------------------
//
// Fixed pixel positions against the 600x800 canvas, exactly as menu.js and the
// mockup before this both do. The frame is the mockup's own, unchanged — the
// screen the player already knows, with contents in it.
const ROW_PITCH = 26;
const SHELF_GAP = 34;    // extra space above a shelf heading
const HEADING_DROP = 22; // heading baseline to its first row

const LEFT = 62;      // labels
const RIGHT = 538;    // prices, right-aligned
const CURSOR_X = 44;  // the "»" gutter
const MARK_X = 176;   // the "bought this visit" receipt, just past the label
const DETAIL_X = 322; // what one purchase gives you (centred)
const VALUE_X = 440;  // a stat's current -> next reading (centred)

const SHELF_TOP = 196; // first heading's own baseline

// Tier pips — three small boxes per stat row, filled for each tier owned.
// DRAWN rather than written as text: a "2/3" reads as a fraction to be parsed,
// three boxes read as progress at a glance, and neither Courier New nor the
// monospace fallback can be trusted to have a filled-square glyph.
const PIP_X = 236;
const PIP_W = 11;
const PIP_H = 9;
const PIP_GAP = 4;

export function createShop() {
  // Which row the cursor is on. KEPT BETWEEN VISITS on purpose: a player
  // topping up rocket ammo at every stop should find the cursor where they left
  // it rather than at the top of the list each time. reset() puts it back for a
  // fresh run — see main.js's newGame().
  let selected = 0;

  // What was bought at THIS stop, by row index, so the shelf can mark it. Cleared
  // on undock rather than on arrival: the marks are feedback about the visit in
  // progress, and there is no moment between arriving and the first frame being
  // drawn at which to clear them otherwise.
  const boughtHere = new Set();

  return {
    // Between runs, alongside every other per-run reset in main.js's newGame().
    reset() {
      selected = 0;
      boughtHere.clear();
    },

    // ONE ACTION PER TICK, named as a string so main.js can pick a tone for it
    // without this file knowing what a tone is (see the header):
    //
    //   "undock"  the player is done — main.js's cue to rebuild the road and
    //             fly them back. The ONE case that changes main.js's state.
    //   "buy"     something was sold; the wallet and the car have both moved
    //   "deny"    the player tried to buy something they cannot afford, or a
    //             stat already at its last tier. Nothing moved
    //   "move"    the cursor moved
    //   null      nothing happened this tick, which is nearly every tick
    //
    // Both "fire" and "pause" are CONSUMED whatever they do, so a press made
    // here can never leak into the gameplay tick on the far side of the
    // lowering sequence — the leak jackin.js and disconnect.js each drain their
    // own inputs to prevent.
    update(wallet, player, loadout, garage) {
      let moved = false;
      if (consumePress("up")) {
        selected = (selected + ROWS.length - 1) % ROWS.length;
        moved = true;
      }
      if (consumePress("down")) {
        selected = (selected + 1) % ROWS.length;
        moved = true;
      }

      // ESC leaves from anywhere. Read BEFORE fire so that a tick carrying both
      // resolves as "leave" rather than as a purchase the player is walking out
      // on — the two keys are never pressed together in practice, but the order
      // is the answer to "which did they mean" and it costs nothing to state it.
      if (consumePress("pause")) {
        boughtHere.clear();
        return "undock";
      }

      if (consumePress("fire")) {
        const entry = ROWS[selected];
        if (entry.undock) {
          boughtHere.clear();
          return "undock";
        }
        if (!purchase(entry, wallet, player, loadout, garage)) return "deny";
        boughtHere.add(selected);
        return "buy";
      }

      return moved ? "move" : null;
    },

    // `wallet` and `garage` are READ here — every write went through update()'s
    // purchase() call, which is the only place on this screen that can move
    // money. `visit` is which shop stop this is (hauler.js's milestone count).
    // `player`/`loadout` are READ too, only to print each consumable's CURRENT
    // status (see statusFor) — the shelf already told the player what a
    // purchase gives, this is the other half: what they'd be buying it onto.
    render(ctx, W, H, wallet, visit, garage, player, loadout) {
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

      glowText(ctx, "CARGO DOCK", W / 2, 84, GREEN_BRIGHT, 22, "center", 14, true);
      glowText(ctx, `STOP ${visit}`, W / 2, 112, GREEN_PALE, 11, "center", 6);

      // The one live number on the screen: what this run has to spend, right
      // now. `credits`, not `banked` — credits do not survive a run at all at
      // the moment (see main.js's CREDIT_STORE), so a "BANK" figure here would
      // be promising the player a balance that dies with their next crash.
      // The subtitle says so out loud rather than letting them find out.
      glowText(ctx, `${wallet.credits} CR`, W / 2, 132, PLAYER, 26, "center", 16, true);
      glowText(ctx, "THIS RUN ONLY — NOT CARRIED OVER", W / 2, 166, GREEN_DIM, 10, "center", 0);

      // The shelves. `index` walks ROWS in the same order the cursor does, so
      // the drawn row and the selected row can never disagree — they are the
      // same flattening, done twice, from the same source.
      let y = SHELF_TOP;
      let index = 0;
      for (const shelf of SHELVES) {
        if (shelf.heading) {
          glowText(ctx, shelf.heading, LEFT, y, GREEN_PALE, 12, "left", 8);
          y += HEADING_DROP;
        }
        for (const entry of shelf.entries) {
          drawRow(ctx, entry, y, index === selected, boughtHere.has(index), wallet, garage, player, loadout);
          y += ROW_PITCH;
          index += 1;
        }
        y += SHELF_GAP;
      }

      // The one-line explanation of whatever is under the cursor, in its own
      // fixed slot below the shelves. One line that moves beats a note on every
      // row: the shelf stays a price list you can scan, and the player still
      // never has to guess what a DEFLECTOR is.
      //
      // IT IS ALSO WHERE "WHY CAN'T I BUY THIS" IS ANSWERED. A row can be
      // unbuyable for two completely different reasons — the ladder is finished,
      // or the money is short — and the shelf itself can only afford colour to
      // tell them apart, which is far too quiet a way to say something the
      // player is actively asking. So the note takes priority over the row's own
      // description and says which it is, in words, with the shortfall in it.
      const note = noteFor(ROWS[selected], garage, wallet);
      if (note) {
        glowText(ctx, note.text, W / 2, 612, note.urgent ? HAZARD : GREEN_DIM,
          11, "center", note.urgent ? 6 : 0);
      }

      glowText(ctx, "↑↓ SELECT — SPACE BUY — ESC UNDOCK", W / 2, H - 96,
        GREEN_BRIGHT, 14, "center", 10);
    },
  };
}

// One shelf row. The colour scheme carries all the state there is — what it
// costs, whether you can afford it, whether it is finished — so the player
// reads the shelf rather than a column of status words.
function drawRow(ctx, entry, y, selected, bought, wallet, garage, player, loadout) {
  const price = priceOf(entry, garage);
  const affordable = price !== null && price <= wallet.credits;
  const soldOut = price === null; // a stat at its last tier

  if (selected) {
    glowText(ctx, "»", CURSOR_X, y, PLAYER, 14, "left", 10, true);
  }

  // THREE STATES, and the dimmest is "you cannot have this". An unaffordable
  // row is not hidden — seeing the price of the thing you are saving for is
  // most of what a shop screen is for.
  const label = entry.undock
    ? (selected ? GREEN_BRIGHT : GREEN_PALE)
    : soldOut ? GREEN_DIM
    : selected ? (entry.color ?? GREEN_BRIGHT)
    : affordable ? GREEN_PALE
    : GREEN_DIM;

  glowText(ctx, entry.label, LEFT, y, label, 14, "left", selected ? 10 : 0, selected);

  if (entry.undock) return;

  if (entry.kind) {
    // A consumable: what one purchase gives you, in its own units...
    glowText(ctx, entry.detail, DETAIL_X, y, affordable ? GREEN_PALE : GREEN_DIM,
      12, "center", 0);
    // ...and, alongside it, what the player actually HAS right now — the half
    // the detail column never answered. Without this a player staring at
    // "+100 HULL" has no way to tell a top-up from a purchase they don't need
    // yet, short of alt-tabbing to squint at the health bar behind this
    // screen. Same VALUE_X slot the CAR SYSTEMS shelf uses for its own
    // now-vs-next reading, so the two shelves read as one system.
    const status = statusFor(entry, player, loadout);
    if (status) {
      glowText(ctx, status, VALUE_X, y, affordable ? GREEN_PALE : GREEN_DIM, 12, "center", 0);
    }
  } else {
    // A car system: the tiers owned, and what the next one moves the reading to.
    const level = garage.levelOf(entry);
    drawPips(ctx, PIP_X, y, level, soldOut ? GREEN_DIM : GREEN);
    const now = format(entry, statValue(entry, level));
    const text = soldOut ? now : `${now} → ${format(entry, statValue(entry, level + 1))}`;
    glowText(ctx, text, VALUE_X, y, soldOut ? GREEN_DIM : affordable ? GREEN_PALE : GREEN_DIM,
      12, "center", 0);
  }

  // BOUGHT-THIS-VISIT SITS BESIDE THE PRICE, NOT OVER IT, and that placement is
  // the whole reason it has a column of its own. A consumable can be bought
  // again the moment it has been bought once — that is what makes it a
  // consumable — so a receipt that covered the price would leave a player
  // buying their second repair unable to see what it costs. The mark is
  // feedback about the visit, and the price is still the live fact about the
  // row; both are true at once, so both are drawn.
  //
  // It stays until the player undocks rather than fading on a timer: a shelf of
  // receipts is a summary of what this stop was spent on, which is exactly what
  // somebody about to leave wants to look at.
  if (bought) glowText(ctx, "BOUGHT", MARK_X, y, GREEN_BRIGHT, 11, "left", 6);

  if (soldOut) {
    glowText(ctx, "MAX", RIGHT, y, GREEN_DIM, 12, "right", 0);
  } else {
    glowText(ctx, `${price} CR`, RIGHT, y, affordable ? GREEN : HAZARD, 13, "right",
      selected && affordable ? 8 : 0);
  }
}

// TIER_COUNT little boxes, filled for each tier owned. Stroked-and-filled
// rather than glowText'd — see the PIP_X block above for why these are drawn.
function drawPips(ctx, x, y, level, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  for (let i = 0; i < TIER_COUNT; i++) {
    const px = x + i * (PIP_W + PIP_GAP);
    if (i < level) ctx.fillRect(px, y + 2, PIP_W, PIP_H);
    else ctx.strokeRect(px + 0.5, y + 2.5, PIP_W - 1, PIP_H - 1);
  }
  ctx.restore();
}

// What the player currently HAS, for a consumable row — the CAR SYSTEMS
// shelf's "now" half, without the "-> next" (a consumable doesn't move a
// stat, it tops one up). `player`/`loadout` are undefined in the test suite's
// older calls and in anything that renders before the run's car exists, so
// this reads defensively rather than assuming either is there.
function statusFor(entry, player, loadout) {
  switch (entry.kind) {
    case HEAL:
      if (!player) return null;
      return `${Math.ceil(player.health)}/${player.maxHealth} HULL`;
    case SHIELD:
      if (!player) return null;
      if (player.shieldTime > 0) return `${player.shieldTime.toFixed(1)}S ACTIVE`;
      if (player.shieldCharge > 0) return `${player.shieldCharge.toFixed(1)}S CHARGED`;
      return "NONE ACTIVE";
    case AMMO: {
      const weapon = loadout && loadout.get(entry.weaponId);
      return weapon ? `${weapon.ammoText}/${weapon.type.ammo} RDS` : null;
    }
    default:
      return null;
  }
}

// A stat's reading, in the units its catalogue entry names — and behind the
// sign it names, if it is a bonus on somebody else's figure rather than a figure
// of its own (see the deflector's `prefix`).
function format(stat, value) {
  return `${stat.prefix ?? ""}${value.toFixed(stat.decimals)}${stat.unit}`;
}

// The line under the shelves for whatever the cursor is on, as { text, urgent }
// — `urgent` is drawn in the hazard red the unaffordable price already uses, so
// the two halves of "you cannot have this" agree with each other.
//
// THE ORDER IS THE POINT. Whatever stops a purchase outranks whatever the row
// does, because a player whose press just did nothing is asking one question and
// it is not "what is a deflector". Beyond that: a maxed stat says so rather than
// repeating its description (the player who got it there knows what it does),
// and a consumable in reach says nothing at all, its `detail` column having
// already said it.
function noteFor(entry, garage, wallet) {
  if (entry.undock) return { text: "FLY BACK TO THE ROAD" };

  const price = priceOf(entry, garage);
  if (price === null) return { text: "FULLY UPGRADED" };
  if (price > wallet.credits) {
    // The SHORTFALL, not just the price — the price is already on the row, and
    // what the player actually wants to know is how much more road they have to
    // cover before this is theirs.
    return { text: `NOT ENOUGH CREDITS — ${price - wallet.credits} CR SHORT`, urgent: true };
  }

  return entry.kind ? null : { text: entry.note };
}
