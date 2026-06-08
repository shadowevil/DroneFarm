// Tiles — tile type registry + sparse infinite tile map.
//
// Types carry classifications (a tile can be several things: grass is both
// dirt and grass) and default state flags (tilled dirt spawns with
// flags.tilled = true). Each placed tile gets its own light level and its
// own copy of the flags, so per-tile state can change at runtime.
//
// The map is a sparse Map keyed by "tx,ty" — unbounded in every direction,
// only occupied cells are stored.

const Tiles = (() => {
  const DEFS = {
    grass: {
      src: 'assets/tile_grass.png',
      classes: ['dirt', 'grass'],
      flags: {},
    },
    dirt: {
      src: 'assets/tile_dirt.png',
      classes: ['dirt'],
      flags: {},
    },
    dirt_tilled: {
      src: 'assets/tile_dirt_tilled.png',
      classes: ['dirt', 'tilled'],
      flags: { tilled: true },
    },
  };

  class TileMap {
    constructor() {
      this.cells = new Map();
    }

    static key(tx, ty) {
      return tx + ',' + ty;
    }

    // Place (or replace) a tile. Returns the tile object:
    // { type, tx, ty, light, flags } — mutate light/flags freely.
    set(tx, ty, type, flags = {}) {
      const def = DEFS[type];
      if (!def) throw new Error('Tiles: unknown type ' + type);
      const tile = {
        type,
        tx,
        ty,
        light: 1,
        flags: { ...def.flags, ...flags },
      };
      this.cells.set(TileMap.key(tx, ty), tile);
      return tile;
    }

    get(tx, ty) {
      return this.cells.get(TileMap.key(tx, ty));
    }

    remove(tx, ty) {
      return this.cells.delete(TileMap.key(tx, ty));
    }

    clear() {
      this.cells.clear();
    }

    all() {
      return this.cells.values();
    }
  }

  // classification check: hasClass(tile, 'dirt') is true for grass,
  // dirt and dirt_tilled alike
  function hasClass(tile, cls) {
    return DEFS[tile.type].classes.includes(cls);
  }

  return { DEFS, TileMap, hasClass };
})();
