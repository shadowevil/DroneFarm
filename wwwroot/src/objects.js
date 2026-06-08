// Objects — world object registry + sparse object map.
//
// Objects are sprites that live on tiles: resources, props, machines.
// Each type carries a classification, a display name, a world sprite and a
// UI icon, plus the tile classes it's allowed to spawn on.

const Objects = (() => {
  // resources that can land in the player's resource bar
  const RESOURCES = {
    hay: { name: 'Hay', icon: 'assets/icon_hay.png' },
    bush_seed: { name: 'Bush Seed', icon: 'assets/bush_seed.png' },
    tree_seed: { name: 'Tree Seed', icon: 'assets/tree_seed.png' },
    carrot_seed: { name: 'Carrot Seed', icon: 'assets/carrot_seed.png' },
    wood: { name: 'Wood', icon: 'assets/icon_wood.png' },
    carrot: { name: 'Carrot', icon: 'assets/icon_carrot.png' },
  };

  const DEFS = {
    hay: {
      name: 'Hay',
      classification: 'resource',
      src: 'assets/resource_raw_hay.png',
      spawnOn: ['grass'], // hay ONLY grows on grass — dirt is for planting
      yOffset: -13,      // per-type vertical placement tweak: +up, negative = down (sheet px)
      yields: 'hay',     // what harvest() collects from it
      regrowMs: 1000,    // regrows this long after being harvested
      droneHeight: 90,   // expected drone hover height above this entity (CSS px)
      harvestSound: 'hay_grab', // played as the harvest pops it
      harvestSoundGain: 0.25,   // the clip is mixed hot — trim it down
      // bonus drops alongside the yield — only once the plant is unlocked
      seedDrops: [
        { resource: 'bush_seed', requires: 'plant_bush', chance: 0.5 },
        { resource: 'tree_seed', requires: 'plant_tree', chance: 0.5 },
      ],
    },
    // plants grow from sprouts: the sprout slowly swells ~15% over growMs,
    // then switches into the grown form
    tree_sprout: {
      name: 'Tree Sprout',
      classification: 'plant',
      src: 'assets/tree_sprout.png',
      spawnOn: ['dirt'],
      convertsGroundTo: 'dirt', // planting claims the land (grass -> dirt)
      growsInto: 'tree',
      growMs: 4000,
      droneHeight: 95,
      plantSound: 'plant_tree',
      plantSoundGain: 0.25, // mixed hot — trim to 25%
    },
    tree: {
      name: 'Tree',
      classification: 'plant',
      src: 'assets/tree.png',
      spawnOn: ['dirt'],
      yields: 'wood',
      droneHeight: 155, // trees are tall — the drone clears the canopy
    },
    bush_sprout: {
      name: 'Bush Sprout',
      classification: 'plant',
      src: 'assets/bush_sprout.png',
      spawnOn: ['dirt'],
      convertsGroundTo: 'dirt', // planting claims the land (grass -> dirt)
      growsInto: 'bush',
      growMs: 2000,
      droneHeight: 90,
      plantSound: 'plant_tree',
      plantSoundGain: 0.25, // mixed hot — trim to 25%
    },
    bush: {
      name: 'Bush',
      classification: 'plant',
      src: 'assets/bush.png',
      spawnOn: ['dirt'],
      yields: 'wood',
      droneHeight: 105,
      // bushes feed the carrot economy — once carrots are unlocked
      seedDrops: [
        { resource: 'carrot_seed', requires: 'plant_carrot', chance: 0.5 },
      ],
    },
    // carrots only grow in tilled soil
    carrot_sprout: {
      name: 'Carrot Sprout',
      classification: 'plant',
      src: 'assets/carrot_sprout.png',
      spawnOn: ['tilled'],
      growsInto: 'carrot',
      growMs: 3000,
      droneHeight: 80,
      plantSound: ['plant_generic_1', 'plant_generic_2'], // random pick
      plantSoundGain: 0.25, // mixed hot — trim to 25%
    },
    carrot: {
      name: 'Carrot',
      classification: 'resource',
      src: 'assets/resource_raw_carrot.png',
      spawnOn: ['tilled'],
      yields: 'carrot',
      yOffset: -5, // sit a touch lower on the tilled soil
      droneHeight: 85,
    },
  };

  class ObjectMap {
    constructor() {
      this.cells = new Map(); // one object per tile, keyed "tx,ty"
    }

    static key(tx, ty) {
      return tx + ',' + ty;
    }

    set(tx, ty, type) {
      const def = DEFS[type];
      if (!def) throw new Error('Objects: unknown type ' + type);
      const obj = { type, tx, ty };
      this.cells.set(ObjectMap.key(tx, ty), obj);
      return obj;
    }

    get(tx, ty) {
      return this.cells.get(ObjectMap.key(tx, ty));
    }

    remove(tx, ty) {
      return this.cells.delete(ObjectMap.key(tx, ty));
    }

    clear() {
      this.cells.clear();
    }

    all() {
      return this.cells.values();
    }
  }

  function canSpawnOn(type, tile) {
    const def = DEFS[type];
    if (!def.spawnOn.every((cls) => Tiles.hasClass(tile, cls))) return false;
    if (def.notOn && def.notOn.some((cls) => Tiles.hasClass(tile, cls))) return false;
    return true;
  }

  return { DEFS, RESOURCES, ObjectMap, canSpawnOn };
})();
