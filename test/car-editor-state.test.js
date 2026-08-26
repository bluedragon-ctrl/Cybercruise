import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCarState,
  buildAllCarState,
  buildObstacleState,
  buildAllObstacleState,
  buildPickupState,
  buildAllPickupState,
  buildUpgradeConsumableState,
  buildAllUpgradeConsumableState,
  buildUpgradeStatState,
  buildAllUpgradeStatState,
  CAR_IDS,
  BEHAVIOR_FIELDS,
  BEHAVIOR_FIELD_GROUPS,
  CAR_TYPE_FIELDS,
  CAR_FIELD_GROUPS,
  OBSTACLE_IDS,
  OBSTACLE_FIELDS,
  PICKUP_IDS,
  PICKUP_SPAWN_FIELDS,
  PICKUP_EFFECT_FIELDS,
  UPGRADE_CONSUMABLE_IDS,
  UPGRADE_STAT_IDS,
  UPGRADE_CONSUMABLE_EFFECT_FIELD_BY_KIND,
  WEAPON_IDS,
  WEAPON_FIELDS,
  WEAPON_FIELD_GROUPS,
  buildWeaponState,
  buildAllWeaponState,
  drivingProfileNameFor,
  drivingProfileScope,
  refreshCatalogues,
} from "../tools/car-editor/state.js";
import { CAR_TYPES } from "../src/game/cartypes.js";
import { DRIVING_PROFILES } from "../src/game/driving.js";
import { OBSTACLE_TYPES } from "../src/game/obstacletypes.js";
import { PICKUP_TYPES } from "../src/game/pickuptypes.js";
import { CONSUMABLES, STATS } from "../src/game/upgrades.js";

const HOSTILE_IDS = CAR_TYPES.filter((t) => t.faction === "enemy").map((t) => t.id);

test("buildAllCarState returns every car in the catalogue, civilian and hostile", () => {
  const all = buildAllCarState();
  assert.deepEqual(
    all.map((c) => c.id).sort(),
    [...CAR_IDS].sort()
  );
  // Sanity check that the roster really does include both factions, not just
  // whatever CAR_IDS happens to derive to.
  assert.ok(all.some((c) => c.faction === "enemy"));
  assert.ok(all.some((c) => c.faction === "neutral"));
});

test("buildCarState returns every catalogue field and every behavior field", () => {
  const state = buildCarState("interceptor");
  for (const field of CAR_TYPE_FIELDS) {
    assert.equal(typeof state.values[field], "number", `missing catalogue field ${field}`);
  }
  for (const field of BEHAVIOR_FIELDS) {
    assert.ok(field in state.behavior, `missing behavior field ${field}`);
    assert.equal(typeof state.behavior[field].inherited, "boolean");
  }
});

test("buildCarState works for a civilian car id", () => {
  const state = buildCarState("sedan");
  assert.equal(state.faction, "neutral");
  assert.equal(typeof state.values.health, "number");
  assert.equal(typeof state.values.minDistance, "number");
});

// Score and credits for a kill are NEGATIVE on the civilian side — running one
// down costs you. Any sign check on these fields would reject the roster the
// game already ships, which is why the server keeps them out of both its
// positive and its non-negative sets.
test("buildCarState reports the civilian side's negative value and bounty", () => {
  const sedan = buildCarState("sedan");
  assert.ok(sedan.values.value < 0);
  assert.ok(sedan.values.bounty < 0);
  const interceptor = buildCarState("interceptor");
  assert.ok(interceptor.values.value > 0);
});

test("laneHome is always one of the three known lane preferences", () => {
  for (const id of CAR_IDS) {
    const state = buildCarState(id);
    assert.ok(["any", "inner", "outer"].includes(state.behavior.laneHome.value));
  }
});

test("nerve is not flagged as inherited for any hostile type, except the cycle's coincidental default", () => {
  // Every hostile profile explicitly sets its own nerve figure (see
  // driving.js's "Hostile dispositions" section) — this is the field where
  // the roster is least likely to accidentally read as bland defaults.
  //
  // The one exception is the cycle: its "darter" profile explicitly writes
  // `nerve: 0`, which happens to be the same figure the commuter default
  // already uses (COMMUTER.nerve = 0 in driving.js). buildCarState's
  // "inherited" flag is a value-based approximation of "not explicitly
  // overridden" (see state.js's header comment) — it cannot see that the
  // source spells the value out, only that it matches the default — so it
  // reports the cycle's nerve as inherited even though driving.js states it
  // explicitly. That's the documented, accepted limitation of the approach,
  // not a bug: the cycle really does dodge every hazard, same as a bland
  // commuter, so the value is correct even if the "(overridden)" cosmetic
  // tag would be missing in the UI.
  for (const id of HOSTILE_IDS) {
    const state = buildCarState(id);
    const expected = id === "cycle" ? true : false;
    assert.equal(
      state.behavior.nerve.inherited,
      expected,
      `${id}.nerve inherited flag should be ${expected}`
    );
  }
});

test("buildCarState throws for a car id outside the catalogue", () => {
  assert.throws(() => buildCarState("ghost"), /unknown car id "ghost"/);
});

test("CAR_TYPE_FIELDS and BEHAVIOR_FIELDS don't overlap", () => {
  // The commit handler routes a car's fields by exactly this test: catalogue
  // fields go to cartypes.js, everything else to the driving profile. A field
  // in both lists would be written to one file and read from the other.
  const overlap = CAR_TYPE_FIELDS.filter((f) => BEHAVIOR_FIELDS.includes(f));
  assert.deepEqual(overlap, []);
});

test("the field-group orderings cover their flat field lists exactly", () => {
  // The form renders from the GROUPS and the server validates against the flat
  // list. A field in one and not the other is either an unrenderable field or
  // an unsaveable one, and neither fails loudly on its own.
  assert.deepEqual(CAR_FIELD_GROUPS.flatMap((g) => g.fields).sort(), [...CAR_TYPE_FIELDS].sort());
  assert.deepEqual(
    BEHAVIOR_FIELD_GROUPS.flatMap((g) => g.fields).sort(),
    [...BEHAVIOR_FIELDS].sort()
  );
  assert.deepEqual(
    WEAPON_FIELD_GROUPS.flatMap((g) => g.fields).sort(),
    [...WEAPON_FIELDS].sort()
  );
});

test("buildAllObstacleState returns every obstacle in the catalogue", () => {
  const all = buildAllObstacleState();
  assert.deepEqual(
    all.map((o) => o.id).sort(),
    [...OBSTACLE_IDS].sort()
  );
  assert.deepEqual(OBSTACLE_IDS, OBSTACLE_TYPES.map((t) => t.id));
});

test("buildObstacleState returns the hazard's own figures, not just its spawn odds", () => {
  const state = buildObstacleState("trestle");
  assert.equal(state.label, "TRESTLE");
  for (const field of ["health", "mass", "blastRadius", "blastDamage", "weight", "minDistance"]) {
    assert.equal(typeof state.values[field], "number", `missing field ${field}`);
  }
});

test("buildObstacleState reports only the fields an entry actually has", () => {
  // The slow-effect fields exist on the SPIKES strip alone. Offering them on
  // every hazard would be a form field writing a key nothing reads.
  const spikes = buildObstacleState("spikes");
  assert.equal(typeof spikes.values.slowTo, "number");
  assert.equal(typeof spikes.values.slowTime, "number");
  assert.equal(typeof spikes.values.contactDamage, "number");

  const trestle = buildObstacleState("trestle");
  assert.ok(!("slowTo" in trestle.values));
  assert.ok(!("contactDamage" in trestle.values));
});

test("every obstacle field the editor offers is one OBSTACLE_FIELDS names", () => {
  for (const state of buildAllObstacleState()) {
    for (const field of Object.keys(state.values)) {
      assert.ok(OBSTACLE_FIELDS.includes(field), `${state.id}: unexpected field ${field}`);
    }
  }
});

test("buildObstacleState throws for an obstacle id outside the catalogue", () => {
  assert.throws(() => buildObstacleState("ghost"), /unknown obstacle id "ghost"/);
});

test("buildAllPickupState returns every pickup in the catalogue", () => {
  const all = buildAllPickupState();
  assert.deepEqual(
    all.map((p) => p.id).sort(),
    [...PICKUP_IDS].sort()
  );
  assert.deepEqual(PICKUP_IDS, PICKUP_TYPES.map((t) => t.id));
});

test("buildPickupState returns weight and minDistance", () => {
  const state = buildPickupState("fix");
  assert.equal(state.label, "FIX");
  for (const field of PICKUP_SPAWN_FIELDS) {
    assert.equal(typeof state.values[field], "number", `missing spawn field ${field}`);
  }
});

test("buildPickupState reports amount for an AMMO pickup, not duration", () => {
  const state = buildPickupState("rocket_ammo");
  assert.equal(state.kind, "ammo");
  assert.equal(typeof state.values.amount, "number");
  assert.ok(!("duration" in state.values));
});

test("buildPickupState reports amount for the HEAL pickup", () => {
  const state = buildPickupState("fix");
  assert.equal(state.kind, "heal");
  assert.equal(typeof state.values.amount, "number");
  assert.ok(!("duration" in state.values));
});

test("buildPickupState reports duration for the SHIELD pickup, not amount", () => {
  const state = buildPickupState("shield");
  assert.equal(state.kind, "shield");
  assert.equal(typeof state.values.duration, "number");
  assert.ok(!("amount" in state.values));
});

test("buildPickupState reports BOTH amount and duration for the BOOST pickup", () => {
  const state = buildPickupState("overdrive");
  assert.equal(state.kind, "boost");
  assert.equal(typeof state.values.amount, "number");
  assert.equal(typeof state.values.duration, "number");
});

test("buildAllPickupState reports every effect field its type carries, and no others", () => {
  for (const state of buildAllPickupState()) {
    const type = PICKUP_TYPES.find((t) => t.id === state.id);
    const effectKeys = Object.keys(state.values).filter((f) => PICKUP_EFFECT_FIELDS.includes(f));
    // At least one: a crate that grants nothing measurable has nothing to tune.
    // Most kinds carry exactly one; BOOST carries both (pickuptypes.js's header
    // explains why an overdrive is meaningless without the pair).
    assert.ok(effectKeys.length > 0, `${state.id} reports no effect field at all`);
    for (const field of effectKeys) {
      assert.ok(field in type, `${state.id} reports "${field}", which its catalogue entry does not have`);
    }
    for (const field of PICKUP_EFFECT_FIELDS) {
      if (field in type) {
        assert.ok(effectKeys.includes(field), `${state.id} has "${field}" but the editor never surfaces it`);
      }
    }
  }
});

test("buildPickupState throws for a pickup id outside the catalogue", () => {
  assert.throws(() => buildPickupState("ghost"), /unknown pickup id "ghost"/);
});

// --- The shop's two shelves (game/upgrades.js) ------------------------------

test("buildAllUpgradeConsumableState returns every row on the consumables shelf", () => {
  const all = buildAllUpgradeConsumableState();
  assert.deepEqual(all.map((e) => e.id).sort(), [...UPGRADE_CONSUMABLE_IDS].sort());
  assert.deepEqual(UPGRADE_CONSUMABLE_IDS, CONSUMABLES.map((e) => e.id));
});

test("buildUpgradeConsumableState reports price and the one effect field its kind uses", () => {
  const heal = buildUpgradeConsumableState("buy_repair");
  assert.equal(heal.kind, "heal");
  assert.equal(heal.effectField, "amount");
  assert.equal(typeof heal.values.price, "number");
  assert.equal(typeof heal.values.amount, "number");

  const shield = buildUpgradeConsumableState("buy_shield");
  assert.equal(shield.kind, "shield");
  assert.equal(shield.effectField, "duration");
  assert.equal(typeof shield.values.duration, "number");

  const ammo = buildUpgradeConsumableState("buy_rocket_ammo");
  assert.equal(ammo.kind, "ammo");
  assert.equal(ammo.effectField, "amount");
  assert.equal(ammo.weaponId, "rocket");
});

test("every consumable's effect field matches UPGRADE_CONSUMABLE_EFFECT_FIELD_BY_KIND", () => {
  for (const state of buildAllUpgradeConsumableState()) {
    assert.equal(state.effectField, UPGRADE_CONSUMABLE_EFFECT_FIELD_BY_KIND[state.kind]);
  }
});

test("buildUpgradeConsumableState throws for a consumable id outside the catalogue", () => {
  assert.throws(
    () => buildUpgradeConsumableState("ghost"),
    /unknown consumable id "ghost"/
  );
});

test("buildAllUpgradeStatState returns every row on the car-systems shelf", () => {
  const all = buildAllUpgradeStatState();
  assert.deepEqual(all.map((s) => s.id).sort(), [...UPGRADE_STAT_IDS].sort());
  assert.deepEqual(UPGRADE_STAT_IDS, STATS.map((s) => s.id));
});

test("buildUpgradeStatState reports price, step and read-only context", () => {
  const state = buildUpgradeStatState("engine");
  assert.equal(typeof state.values.price, "number");
  assert.equal(typeof state.values.step, "number");
  assert.equal(typeof state.base, "number");
  // base/unit/decimals are context for the editor's preview, not fields it can
  // write — the editor only ever sends price/step back (see server.js's
  // validateUpgradeStatChanges).
  assert.equal(state.base, STATS.find((s) => s.id === "engine").base);
});

test("buildUpgradeStatState throws for a stat id outside the catalogue", () => {
  assert.throws(() => buildUpgradeStatState("ghost"), /unknown stat id "ghost"/);
});

// --- Driving profiles are shared, and the editor has to say so --------------

test("drivingProfileNameFor resolves a car with no `driving` key to commuter", () => {
  // The sedan's catalogue entry omits `driving` entirely and drivingFor()
  // falls back to the commuter default. Reading `type.driving` straight
  // through, as the commit handler once did, yielded undefined and made a
  // behavior edit on the sedan unpatchable.
  const sedan = CAR_TYPES.find((t) => t.id === "sedan");
  assert.equal(sedan.driving, undefined);
  assert.equal(drivingProfileNameFor("sedan"), "commuter");
});

test("drivingProfileNameFor returns the named profile for a car that has one", () => {
  assert.equal(drivingProfileNameFor("rival"), "duelist");
});

test("drivingProfileNameFor throws for a car id outside the catalogue", () => {
  assert.throws(() => drivingProfileNameFor("ghost"), /unknown car id "ghost"/);
});

test("drivingProfileScope names the other cars sharing a profile", () => {
  // VAN and BUS both drive "hauler" — editing behavior on one edits both.
  const van = drivingProfileScope("van");
  assert.equal(van.name, "hauler");
  assert.deepEqual(van.sharedWith, ["BUS"]);
  assert.equal(van.isBaseline, false);

  const bus = drivingProfileScope("bus");
  assert.deepEqual(bus.sharedWith, ["VAN"]);
});

test("drivingProfileScope flags the commuter profile as the inherited baseline", () => {
  const sedan = drivingProfileScope("sedan");
  assert.equal(sedan.name, "commuter");
  assert.equal(sedan.isBaseline, true);
});

test("drivingProfileScope reports an exclusive profile as shared with nobody", () => {
  const rival = drivingProfileScope("rival");
  assert.deepEqual(rival.sharedWith, []);
  assert.equal(rival.isBaseline, false);
});

test("every car's resolved profile name exists in DRIVING_PROFILES", () => {
  for (const id of CAR_IDS) {
    assert.ok(
      drivingProfileNameFor(id) in DRIVING_PROFILES,
      `${id} resolves to a profile that driving.js does not define`
    );
  }
});

test("buildCarState carries the profile scope alongside the behavior fields", () => {
  const state = buildCarState("van");
  assert.deepEqual(state.profile, drivingProfileScope("van"));
});

// --- Values are re-read from disk, not frozen at startup --------------------

test("refreshCatalogues re-reads the catalogues and leaves the state builders working", async () => {
  // Nothing has changed on disk here, so this asserts the mechanism itself:
  // the re-imported modules are what the builders read afterwards, and they
  // still produce the same shape and the same values.
  const before = buildAllCarState();
  await refreshCatalogues();
  const after = buildAllCarState();
  assert.deepEqual(after, before);
  assert.equal(
    buildUpgradeStatState("engine").values.price,
    STATS.find((s) => s.id === "engine").price
  );
});

test("every car type declares a faction the editor's nav knows how to group", () => {
  // cartypes.js's own field table lists `faction` as NEUTRAL_FACTION |
  // ENEMY_FACTION, but nothing enforced it — the BUS shipped without one, and
  // the editor's faction-filtered nav silently dropped it from the roster. The
  // nav no longer drops anything (see editor.js's navGroups), but a car
  // landing in "Uncategorised" is still a catalogue bug, so guard the field
  // itself here rather than only surviving its absence.
  for (const type of CAR_TYPES) {
    assert.ok(
      ["enemy", "neutral"].includes(type.faction),
      `${type.id} has faction ${JSON.stringify(type.faction)}`
    );
  }
});

test("buildAllCarState reports a faction for every car", () => {
  for (const state of buildAllCarState()) {
    assert.ok(["enemy", "neutral"].includes(state.faction), `${state.id}: ${state.faction}`);
  }
});

// --- Weapons ---------------------------------------------------------------

test("buildAllWeaponState covers the player's kit and the hostiles' alike", () => {
  const all = buildAllWeaponState();
  assert.deepEqual(all.map((w) => w.id).sort(), [...WEAPON_IDS].sort());
  assert.ok(all.some((w) => w.side === "player"));
  assert.ok(all.some((w) => w.side === "enemy"));
});

test("weapon ids are unique across the two arrays", () => {
  // patchWeaponType finds an entry by `id: "..."` across the whole file, so a
  // player weapon and a hostile one sharing an id would make the first match
  // win silently.
  assert.equal(new Set(WEAPON_IDS).size, WEAPON_IDS.length);
});

test("buildWeaponState reports only the numeric fields an entry actually has", () => {
  const rocket = buildWeaponState("rocket");
  assert.equal(typeof rocket.values.turnRate, "number");
  assert.equal(typeof rocket.values.blastRadius, "number");

  // The mine layer's payload does the damage, so it carries no `damage`, and
  // only the rocket steers.
  const mine = buildWeaponState("mine");
  assert.ok(!("damage" in mine.values));
  assert.equal(mine.payload, "caltrop");
  assert.ok(!("turnRate" in buildWeaponState("cannon").values));
});

test("a weapon with unlimited ammo offers no ammo field, and says why", () => {
  // The default gun never running dry is the premise the rest of the arsenal is
  // balanced against — `ammo: Infinity` is a design statement, not a number to
  // nudge, and it is not a value a number box could round-trip anyway.
  const cannon = buildWeaponState("cannon");
  assert.equal(cannon.unlimitedAmmo, true);
  assert.ok(!("ammo" in cannon.values));

  const rocket = buildWeaponState("rocket");
  assert.equal(rocket.unlimitedAmmo, false);
  assert.equal(typeof rocket.values.ammo, "number");
});

test("every weapon field the editor offers is one WEAPON_FIELDS names", () => {
  for (const weapon of buildAllWeaponState()) {
    for (const field of Object.keys(weapon.values)) {
      assert.ok(WEAPON_FIELDS.includes(field), `${weapon.id}: unexpected field ${field}`);
    }
  }
});

test("no weapon starts a run with more rounds than its magazine holds", () => {
  for (const weapon of buildAllWeaponState()) {
    const { ammo, startAmmo } = weapon.values;
    if (!Number.isFinite(ammo) || !Number.isFinite(startAmmo)) continue;
    assert.ok(startAmmo <= ammo, `${weapon.id}: startAmmo ${startAmmo} > ammo ${ammo}`);
  }
});

test("buildWeaponState throws for a weapon id outside either array", () => {
  assert.throws(() => buildWeaponState("raygun"), /unknown weapon id "raygun"/);
});
