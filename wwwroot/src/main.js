// DroneFarm — drone flight test.
// Click anywhere: the drone flies there and picks the matching direction
// sprite (8-dir sheet, atlas-built at load). Four 3D WebGL propellers spin
// on the sprite's rotor pods. A hover bob + scale + ground shadow fake
// altitude: the drone shrinks slightly as it dips.

const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias: true });
if (!gl) throw new Error('WebGL2 not supported');

// ---------- tuning ----------

const SPRITE_SCALE = 0.75; // screen px per sheet px (CSS)
const PROP_SCALE = 1;      // propeller px-per-sheet-px, decoupled from drone size
const SQUASH = 0.52;       // vertical squash of the iso sprite art
const PROP_RADIUS = 21;    // propeller radius, sheet px
const PROP_LIFT = 10;      // raise props above the detected pod caps (CSS px)
const PROP_REVS = 4;       // propeller revs/sec
const HOVER_DISTANCE = 72; // how high the drone hovers above its tile (CSS px)
const BOB_AMP = 3.5;       // hover bob amplitude (CSS px)
const BOB_RATE = 2.1;      // bob speed (rad/s)
const BOB_SCALE = 0.02;    // how much the drone grows (up) / shrinks (down)
const BOB_DIP = 4;         // extra downward travel on the low half of the bob (CSS px)
const HARVEST_DIP_MS = 340; // harvest gesture: quick dip down and back up
const HARVEST_DIP_AMP = 6;  // ...kept subtle (CSS px)
const SPIN_MS = 1000;       // do_a_spin(): orbit around the tile and settle back
const STEP_MS = 50;         // min per-statement dwell: every step visibly highlights
const SPIN_RADIUS = 40;     // ...orbit radius (CSS px)
const MAX_SPEED = 315;     // CSS px/s (was 420; movement read as too fast)
const FRAME_ANGLE0 = -90;  // frame 0 faces screen-north (up); +45°/frame CW
                           // sheet order: N NE E SE / S SW W NW

// ---------- shaders ----------

const SOLID_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
uniform mat4 uMVP;
uniform mat4 uModel;
out vec3 vNormal;
out vec3 vColor;
void main() {
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  gl_Position = uMVP * vec4(aPosition, 1.0);
}`;

const SOLID_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
out vec4 fragColor;
const vec3 LIGHT = normalize(vec3(0.4, 0.8, 0.5));
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float wrap = dot(n, LIGHT) * 0.5 + 0.5;
  vec3 col = vColor * (0.25 + wrap * wrap * 0.95);
  fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;     // unit quad, 0..1
uniform vec4 uDst;                        // x, y, w, h in device px (y down)
uniform vec4 uSrc;                        // u0, v0, u1, v1
uniform vec2 uShear;                      // px offset at the quad's top edge, 0 at the bottom
uniform vec2 uResolution;
out vec2 vUV;
void main() {
  vec2 px = uDst.xy + aCorner * uDst.zw + uShear * (1.0 - aCorner.y);
  vec2 ndc = px / uResolution * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUV = mix(uSrc.xy, uSrc.zw, aCorner);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec4 uTint;   // rgb multiplies (tile light level), a multiplies alpha
out vec4 fragColor;
void main() { fragColor = texture(uTex, vUV) * uTint; }`;

const BLOB_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform vec4 uColor;   // premultiplied
uniform int uMode;     // 0 = soft blob (shadow), 1 = ellipse ring, 2 = diamond ring (tile top)
out vec4 fragColor;
void main() {
  vec2 p = abs(vUV * 2.0 - 1.0);
  float a;
  if (uMode == 2) {
    float d = p.x + p.y;   // L1 metric: 1.0 on the iso diamond edge
    a = smoothstep(0.84, 0.93, d) * (1.0 - smoothstep(0.97, 1.0, d));
  } else {
    float r = length(p);
    if (r > 1.0) discard;
    a = uMode == 1
      ? smoothstep(0.62, 0.82, r) * (1.0 - smoothstep(0.86, 1.0, r))
      : 1.0 - smoothstep(0.0, 1.0, r);
  }
  fragColor = uColor * a;
}`;

function makeProgram(vs, fs) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh));
    }
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog));
  }
  return prog;
}

const solidProg = makeProgram(SOLID_VS, SOLID_FS);
const spriteProg = makeProgram(QUAD_VS, SPRITE_FS);
const blobProg = makeProgram(QUAD_VS, BLOB_FS);
const U = (p, n) => gl.getUniformLocation(p, n);
const u = {
  solidMVP: U(solidProg, 'uMVP'), solidModel: U(solidProg, 'uModel'),
  spriteDst: U(spriteProg, 'uDst'), spriteSrc: U(spriteProg, 'uSrc'), spriteRes: U(spriteProg, 'uResolution'), spriteTint: U(spriteProg, 'uTint'), spriteShear: U(spriteProg, 'uShear'),
  blobDst: U(blobProg, 'uDst'), blobSrc: U(blobProg, 'uSrc'), blobRes: U(blobProg, 'uResolution'), blobColor: U(blobProg, 'uColor'), blobMode: U(blobProg, 'uMode'),
};

// ---------- tiny column-major mat4 ----------

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function rotationX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotationY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

// ---------- propeller mesh (blades + small spinner cap) ----------

function buildPropeller() {
  const pos = [], nor = [], col = [], idx = [];
  const CARBON = [0.13, 0.145, 0.14];
  const LIME = [0.72, 0.95, 0.27];
  const STEEL = [0.45, 0.48, 0.46];

  const vert = (p, n, c) => {
    pos.push(...p);
    nor.push(...n);
    col.push(...c);
    return pos.length / 3 - 1;
  };

  // spinner cap
  const SEG = 12, R = 0.14, Y0 = -0.02, Y1 = 0.1;
  const center = vert([0, Y1, 0], [0, 1, 0], STEEL);
  for (let i = 0; i <= SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const x = Math.cos(a), z = Math.sin(a);
    vert([x * R, Y0, z * R], [x, 0, z], STEEL);
    vert([x * R * 0.7, Y1, z * R * 0.7], [x, 0.4, z], STEEL);
    vert([x * R * 0.7, Y1, z * R * 0.7], [0, 1, 0], STEEL);
  }
  for (let i = 0; i < SEG; i++) {
    const b = 1 + i * 3;
    idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 4);
    idx.push(center, b + 2, b + 5);
  }

  // two tapered, twisted blade strips
  const N = 10;
  for (let b = 0; b < 2; b++) {
    const rot = b * Math.PI;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const r = 0.1 + 0.9 * t;
      const chord = 0.24 * Math.sin(Math.PI * (0.18 + 0.82 * t));
      const twist = 0.5 - 0.35 * t;
      const ct = Math.cos(twist), st = Math.sin(twist);
      const color = t > 0.8 ? LIME : CARBON;
      for (const s of [-0.5, 0.5]) {
        const y = -s * chord * st;
        const z = s * chord * ct;
        vert([cr * r + sr * z, y, -sr * r + cr * z], [sr * st, ct, cr * st], color);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  return { pos, nor, col, idx };
}

const prop = buildPropeller();
const propVao = gl.createVertexArray();
gl.bindVertexArray(propVao);
for (const [loc, data] of [[0, prop.pos], [1, prop.nor], [2, prop.col]]) {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
}
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(prop.idx), gl.STATIC_DRAW);

// unit quad for sprites / blobs
const quadVao = gl.createVertexArray();
gl.bindVertexArray(quadVao);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// ---------- assets ----------

function makeTexture(img) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

let sheet = null; // { tex, frames, w, h }
Atlas.loadImage('assets/drone_512.png').then((img) => {
  const frames = Atlas.build(img, 4, 2, { pods: 4 }); // 4 rotor mounts per frame
  console.table(frames);
  sheet = { tex: makeTexture(img), frames, w: img.naturalWidth, h: img.naturalHeight };
});

const tileTex = {}; // type -> { tex, w, h }
for (const [type, def] of Object.entries(Tiles.DEFS)) {
  Atlas.loadImage(def.src).then((img) => {
    tileTex[type] = { tex: makeTexture(img), w: img.naturalWidth, h: img.naturalHeight };
  });
}

const objTex = {}; // type -> { tex, w, h }
for (const [type, def] of Object.entries(Objects.DEFS)) {
  Atlas.loadImage(def.src).then((img) => {
    objTex[type] = { tex: makeTexture(img), w: img.naturalWidth, h: img.naturalHeight };
  });
}

// ---------- resource bar ----------

const inventory = { hay: 0, bush_seed: 0, tree_seed: 0, carrot_seed: 0, wood: 0, carrot: 0 };

function renderResources() {
  const bar = document.getElementById('resources');
  const want = Object.entries(inventory)
    .filter(([k]) => Objects.RESOURCES[k] && unlocks.has(k)); // resources are unlockable too
  // chips persist across count changes — rebuilding <img> elements on every
  // tick causes a visible flicker, so only the number text is updated unless
  // the set of visible resources itself changed
  const same = bar.children.length === want.length &&
    want.every(([k], i) => bar.children[i].dataset.res === k);
  if (!same) {
    bar.innerHTML = '';
    for (const [k] of want) {
      const res = Objects.RESOURCES[k];
      const chip = document.createElement('div');
      chip.className = 'resource';
      chip.dataset.res = k;
      chip.innerHTML =
        `<img class="resource__icon" data-type="${k}" src="${res.icon}" alt="">` +
        `${res.name.toUpperCase()} <b></b>`;
      bar.appendChild(chip);
    }
  }
  want.forEach(([, count], i) => {
    const b = bar.children[i].querySelector('b');
    if (b.textContent !== String(count)) b.textContent = count;
  });
  // keep unlock-tree affordability in sync with resource changes
  if (unlockUiReady && !unlockOverlay.hidden) renderUnlockTree();
}
let unlockUiReady = false; // set once the unlockables section initializes
// (first render happens once the unlock system below is initialized)

// ---------- world ----------

// world bounds: mapW tiles east x mapH tiles north; the drone wraps at the
// edges. Derived from unlocks (expansions are tree nodes) — never saved.
let mapW = 1;
let mapH = 1;
const TILE_W = 128;        // tile sprite width (px)
const TILE_TOP = 64;       // top diamond height (2:1 iso)
const TILE_ANCHOR_Y = 32;  // top-diamond center, below the sprite's top edge
const TILE_SCALE = 1;
const OBJECT_SCALE = 1;    // world-object sprite scale
const OBJECT_FOOT = 14;    // px from an object sprite's bottom to its ground contact

// (0,0) is always the bottom (south) corner tile; the field extends
// north (-tx) and east (-ty) from it
const map = new Tiles.TileMap();
const objects = new Objects.ObjectMap();

// (re)build the field: every tile grass, hay grown on every eligible tile —
// used at startup, by NEW GAME and by the clear_map() builtin
function resetWorld() {
  map.clear(); // drop any tiles outside the current world size
  objects.clear(); // entities go too — the reset is total
  for (let tx = -(mapH - 1); tx <= 0; tx++) {       // north axis
    for (let ty = -(mapW - 1); ty <= 0; ty++) map.set(tx, ty, 'grass'); // east axis
  }
  for (const t of map.all()) {
    if (Objects.canSpawnOn('hay', t)) {
      objects.set(t.tx, t.ty, 'hay');
    }
  }
}
resetWorld();

// tile coords -> world px (world origin = center of tile 0,0)
function tileWorld(tx, ty) {
  return {
    x: ((tx - ty) * TILE_W * TILE_SCALE) / 2,
    y: ((tx + ty) * TILE_TOP * TILE_SCALE) / 2,
  };
}

// world px -> nearest tile coords (inverse iso transform)
function worldToTile(wx, wy) {
  const hw = (TILE_W * TILE_SCALE) / 2, hh = (TILE_TOP * TILE_SCALE) / 2;
  return {
    tx: Math.round((wx / hw + wy / hh) / 2),
    ty: Math.round((wy / hh - wx / hw) / 2),
  };
}

// ---------- camera ----------

const TILE_H = 85; // full tile sprite height (top face + skirt)

const camera = { x: 0, y: 0, zoom: 1 }; // world point at screen center + zoom
const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;

// camera may travel until the tile field sits at the viewport edge —
// tiles stay fully visible, but can be pushed to any side of the screen
function clampCamera() {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of map.all()) {
    const p = tileWorld(t.tx, t.ty);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (minX === Infinity) {
    camera.x = 0;
    camera.y = 0;
    return;
  }
  const mx = Math.max(0, innerWidth / 2 / camera.zoom - (TILE_W * TILE_SCALE) / 2);
  const my = Math.max(0, innerHeight / 2 / camera.zoom - (TILE_H * TILE_SCALE) / 2);
  camera.x = Math.min(Math.max(camera.x, minX - mx), maxX + mx);
  camera.y = Math.min(Math.max(camera.y, minY - my), maxY + my);
}

// world px -> screen CSS px; the camera focus sits at screen center
function worldToScreen(p) {
  return {
    x: innerWidth / 2 + (p.x - camera.x) * camera.zoom,
    y: innerHeight / 2 + (p.y - camera.y) * camera.zoom,
  };
}

function tileScreen(tx, ty) {
  return worldToScreen(tileWorld(tx, ty));
}

// ---------- game state ----------

const params = new URLSearchParams(location.search);
const state = {
  tile: { tx: 0, ty: 0 },   // committed tile (drone aligns to tile centers)
  moveTo: null,             // target tile while stepping
  pos: tileWorld(0, 0),     // drone ground point, world px
  dir: 3,                   // direction frame; default = logical south (screen SE)
  spin: 0,                  // propeller angle
  bobPhase: 0,
  dipStart: -1e9,           // when the last harvest dip began (ms)
  spinFx: null,             // active do_a_spin: { start, dur, baseDir }
  hover: HOVER_DISTANCE,    // current hover height, eases toward the entity's expected height
};
if (params.has('dir')) state.dir = Number(params.get('dir')) % 8; // dev: force a frame
if (params.has('zoom')) camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(params.get('zoom')))); // dev

// The drone is NOT player-controlled: no keyboard, no click-to-move.
// Movement happens programmatically by setting state.moveTo = { tx, ty };
// the loop glides there and snaps to the tile center. Logical compass is
// rotated 45° from the screen (north = tile -x renders toward screen-NW,
// south = +x toward screen-SE).

function isTyping(el) {
  return el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
}

addEventListener('contextmenu', (e) => {
  if (!isTyping(e.target)) e.preventDefault(); // no right-click menu outside text fields
});

// ---------- drone scripting (C#-like, see csharp.js) ----------

// ---------- drone action sequencing ----------

// drone speed multiplier — 1x for now; upgrades will raise it later.
// Scales movement speed and action gestures alike.
let actionMultiplier = 1;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// every drone action runs strictly in order through this chain — an action
// can't begin until the previous one (move glide, harvest gesture) finished
let actionChain = Promise.resolve();
function enqueueAction(fn) {
  const next = actionChain.then(fn);
  actionChain = next.catch(() => {}); // keep the chain alive if an action fails
  return next;
}

// script coordinates: (0,0) = the bottom corner tile, x grows east,
// y grows north — internal tile coords are tx = -y, ty = -x
function scriptPos() {
  return { x: -state.tile.ty, y: -state.tile.tx };
}

// face the drone along an internal tile-space delta
function faceDelta(dtx, dty) {
  const sdx = dtx - dty;
  const sdy = (dtx + dty) * 0.5;
  state.dir = dirFrame((Math.atan2(sdy / SQUASH, sdx) * 180) / Math.PI);
}

// one cardinal step in script space, wrapping at the map edges; resolves
// when the drone arrives. A wrap is a real flight back across the field —
// the drone never teleports
function moveCardinal(dx, dy) {
  return new Promise((resolve) => {
    const cur = scriptPos();
    const nx = (cur.x + dx + mapW) % mapW;
    const ny = (cur.y + dy + mapH) % mapH;
    const ttx = -ny, tty = -nx;
    faceDelta(-dy, -dx);
    const wrapped = Math.abs(nx - cur.x) > 1 || Math.abs(ny - cur.y) > 1;
    if (wrapped) {
      // face the actual travel direction for the return flight, then turn
      // back to the logical heading on arrival (it "kept going north")
      faceDelta(Math.sign(ttx - state.tile.tx), Math.sign(tty - state.tile.ty));
      state.moveTo = { tx: ttx, ty: tty };
      state.onArrive = () => {
        faceDelta(-dy, -dx);
        resolve();
      };
    } else {
      state.moveTo = { tx: ttx, ty: tty };
      state.onArrive = resolve;
    }
  });
}

const scriptBuiltins = {
  north: () => enqueueAction(() => moveCardinal(0, 1)),
  south: () => enqueueAction(() => moveCardinal(0, -1)),
  east: () => enqueueAction(() => moveCardinal(1, 0)),
  west: () => enqueueAction(() => moveCardinal(-1, 0)),
  // how many of a resource we hold (instant — checking our own cargo,
  // not the world)
  has_resource: (which) => {
    const key = RESOURCE_KEYS[which];
    if (key === undefined) throw new Error('has_resource() takes a Resource value, e.g. Resource.hay');
    return inventory[key] | 0;
  },
  // would harvest() succeed right now? A short sensor-read pause — also
  // means wait-loops like `while (!can_harvest()) {}` don't hot-spin
  can_harvest: () => enqueueAction(async () => {
    await wait(100 / actionMultiplier);
    const o = objects.get(state.tile.tx, state.tile.ty);
    return !!(o && Objects.DEFS[o.type].yields);
  }),
  // harvest the tile the drone is over; returns true if something was taken.
  // Awaits the full dip gesture, so the next action starts cleanly after.
  harvest: () => enqueueAction(async () => {
    state.dipStart = performance.now();
    const took = harvestAt(state.tile.tx, state.tile.ty);
    await wait(HARVEST_DIP_MS / actionMultiplier);
    return took;
  }),
  // a little flourish: orbit the tile once (spinning through all 8 facings)
  // and settle back exactly where it started
  do_a_spin: () => enqueueAction(async () => {
    const dur = SPIN_MS / actionMultiplier;
    state.spinFx = { start: performance.now(), dur, baseDir: state.dir };
    await wait(dur);
  }),
  // the world is square (NxN) except during the 1x3 teaching phase —
  // returns the larger dimension, which is N whenever it matters
  // (instant, no action queue)
  world_size: () => Math.max(mapW, mapH),
  // what's directly under the drone (instant queries, no action queue)
  get_ground: () => {
    const tile = map.get(state.tile.tx, state.tile.ty);
    return tile ? TILE_TO_GROUND[tile.type] ?? null : null;
  },
  get_entity: () => {
    const o = objects.get(state.tile.tx, state.tile.ty);
    return o ? OBJ_TO_ENTITY[o.type] ?? null : null;
  },
  // till the tile below: dirt/grass -> dirt_tilled; tilled -> back to dirt
  till: () => enqueueAction(async () => {
    state.dipStart = performance.now();
    const { tx, ty } = state.tile;
    const cur = map.get(tx, ty);
    if (cur) {
      objects.remove(tx, ty); // tilling plows under whatever was growing
      map.set(tx, ty, cur.type === 'dirt_tilled' ? 'dirt' : 'dirt_tilled');
    }
    await wait(HARVEST_DIP_MS / actionMultiplier);
  }),
  // seed the tile below back into grass — and grass always produces hay,
  // so a fresh clump sprouts after the usual regrow delay
  seed: () => enqueueAction(async () => {
    state.dipStart = performance.now();
    const { tx, ty } = state.tile;
    if (map.get(tx, ty)) {
      map.set(tx, ty, 'grass');
      setTimeout(() => {
        const tile = map.get(tx, ty);
        if (tile && !objects.get(tx, ty) && Objects.canSpawnOn('hay', tile)) {
          objects.set(tx, ty, 'hay');
        }
      }, Objects.DEFS.hay.regrowMs);
    }
    await wait(HARVEST_DIP_MS / actionMultiplier);
  }),
  // plant a sprout (Entity.Tree or Entity.Bush) on the empty tile below;
  // returns true if it was planted
  plant: (what) => enqueueAction(async () => {
    const type = PLANTABLE[what];
    if (!type) throw new Error('plant() takes Entity.Tree, Entity.Bush or Entity.Carrot');
    // each plantable entity is its own unlock
    const lockKey = { tree_sprout: 'plant_tree', bush_sprout: 'plant_bush', carrot_sprout: 'plant_carrot' }[type];
    if (lockKey && !unlocks.has(lockKey)) {
      const ename = Object.keys(ENTITY).find((k) => ENTITY[k] === what);
      throw new Error(`Entity.${ename} is locked — you have not unlocked it yet`);
    }
    state.dipStart = performance.now();
    const { tx, ty } = state.tile;
    const tile = map.get(tx, ty);
    // plants are grown from seeds (hay drops bush/tree seeds, bushes drop
    // carrot seeds)
    const seedKey = { bush_sprout: 'bush_seed', tree_sprout: 'tree_seed', carrot_sprout: 'carrot_seed' }[type];
    let planted = false;
    if (tile && !objects.get(tx, ty) && Objects.canSpawnOn(type, tile) &&
        (!seedKey || (inventory[seedKey] || 0) > 0)) {
      if (seedKey) {
        inventory[seedKey]--;
        renderResources();
      }
      // sound cue right before the sprout appears
      const sdef = Objects.DEFS[type];
      if (sdef.plantSound) {
        const snd = Array.isArray(sdef.plantSound)
          ? sdef.plantSound[(Math.random() * sdef.plantSound.length) | 0]
          : sdef.plantSound;
        playSfx(snd, sdef.plantSoundGain);
      }
      // planting claims the land: grass becomes plain dirt
      const conv = Objects.DEFS[type].convertsGroundTo;
      if (conv && tile.type !== conv && !Tiles.hasClass(tile, 'tilled')) {
        map.set(tx, ty, conv);
      }
      const obj = objects.set(tx, ty, type);
      obj.growAge = 0; // grows via frame dt — one clock for everything
      planted = true;
    }
    await wait(HARVEST_DIP_MS / actionMultiplier);
    return planted;
  }),
  // reset the field (all grass, hay regrown) and fly the drone home to
  // (0,0) — a real flight, not a teleport
  clear_map: () => enqueueAction(async () => {
    resetWorld();
    if (state.tile.tx !== 0 || state.tile.ty !== 0) {
      await new Promise((resolve) => {
        state.moveTo = { tx: 0, ty: 0 };
        state.onArrive = resolve;
      });
    }
  }),
};
const scriptVars = {
  pos_x: () => scriptPos().x,
  pos_y: () => scriptPos().y,
};

// built-in enums exposed to scripts: ground, entity and resource kinds.
// Resource members deliberately match the inventory keys (lowercase).
const GROUND = { Dirt: 0, Tilled: 1, Grass: 2 };
const ENTITY = { Hay: 0, TreeSprout: 1, Tree: 2, BushSprout: 3, Bush: 4, CarrotSprout: 5, Carrot: 6 };
const RESOURCE_KEYS = Object.keys(Objects.RESOURCES);
const RESOURCE = Object.fromEntries(RESOURCE_KEYS.map((k, i) => [k, i]));
const scriptEnums = { Ground: GROUND, Entity: ENTITY, Resource: RESOURCE };

const TILE_TO_GROUND = { dirt: GROUND.Dirt, dirt_tilled: GROUND.Tilled, grass: GROUND.Grass };
const OBJ_TO_ENTITY = {
  hay: ENTITY.Hay,
  tree_sprout: ENTITY.TreeSprout,
  tree: ENTITY.Tree,
  bush_sprout: ENTITY.BushSprout,
  bush: ENTITY.Bush,
  carrot_sprout: ENTITY.CarrotSprout,
  carrot: ENTITY.Carrot,
};
const PLANTABLE = {
  [ENTITY.Tree]: 'tree_sprout',
  [ENTITY.Bush]: 'bush_sprout',
  [ENTITY.Carrot]: 'carrot_sprout', // carrots need tilled soil (spawnOn rule)
};

// merge every panel's functions into one namespace; the run panel's
// top-level statements become the program body
function compileAll(runPanel) {
  const merged = { funcs: {}, classes: {}, enums: {}, body: [] };
  for (const p of UI.panels) {
    if (!p.isScript) continue; // help/text panels aren't part of the program
    let prog;
    try {
      prog = CSharp.parse(p.body.value);
    } catch (e) {
      throw new Error(`[${p.title}] ${e.message}`);
    }
    for (const [name, f] of Object.entries(prog.funcs)) {
      if (merged.funcs[name]) throw new Error(`function '${name}' is defined in more than one panel`);
      f.src = p; // instruction highlighting follows calls into this panel
      merged.funcs[name] = f;
    }
    for (const [name, c] of Object.entries(prog.classes)) {
      if (merged.classes[name]) throw new Error(`class '${name}' is defined in more than one panel`);
      c.src = p;
      merged.classes[name] = c;
    }
    for (const [name, en] of Object.entries(prog.enums)) {
      if (merged.enums[name]) throw new Error(`enum '${name}' is defined in more than one panel`);
      merged.enums[name] = en;
    }
    if (p === runPanel) merged.body = prog.body;
  }
  return merged;
}

// one script at a time: playing while another runs queues it; the current
// script stops at its next statement (finishing its current move first)
const Runner = {
  current: null, // { panel, control }
  queued: null,

  play(panel) {
    if (this.current) {
      if (this.queued && this.queued !== panel) this.queued.setStatus('READY');
      this.queued = panel;
      this.current.control.stopped = true;
      panel.setStatus('QUEUED', 'warn');
      return;
    }
    this.start(panel);
  },

  async start(panel) {
    const control = { stopped: false, paused: false, reason: '' };
    this.current = { panel, control };
    panel.setStatus('RUNNING', 'run');
    let hlPanel = null; // panel currently showing the instruction highlight
    const stoppedText = () => 'STOPPED' + (control.reason ? ` — ${control.reason}` : '');
    try {
      const program = compileAll(panel);
      await CSharp.run(program, {
        builtins: gatedBuiltins(),
        vars: scriptVars,
        enums: scriptEnums,
        locked: lockedName,
        control,
        src: panel,
        // every statement dwells briefly so the active-line highlight is
        // visible on ALL steps (y++, x = 0, ...), not just drone actions;
        // faster drones also step code faster
        stepDelay: () => STEP_MS / actionMultiplier,
        onStep: (line, src) => {
          if (hlPanel && hlPanel !== src) hlPanel.setActiveLine(null);
          hlPanel = src;
          hlPanel?.setActiveLine(line);
        },
      });
      panel.setStatus(control.stopped ? stoppedText() : 'DONE');
    } catch (e) {
      if (e instanceof CSharp.Stop) panel.setStatus(stoppedText());
      else panel.setStatus(`ERROR — ${e.message}`, 'err');
    }
    for (const p of UI.panels) p.setActiveLine(null);
    this.current = null;
    if (this.queued) {
      const nextPanel = this.queued;
      this.queued = null;
      this.start(nextPanel);
    }
  },

  pause(panel) {
    if (this.current?.panel !== panel) return;
    const c = this.current.control;
    c.paused = !c.paused;
    panel.setStatus(c.paused ? 'PAUSED' : 'RUNNING', c.paused ? 'warn' : 'run');
  },

  stop(panel) {
    if (this.current?.panel === panel) {
      this.current.control.stopped = true;
      this.current.control.paused = false;
    }
    if (this.queued === panel) {
      this.queued = null;
      panel.setStatus('READY');
    }
  },
};

// ---------- progression: unlockable API ----------
// Player goals grant these. New games start with only the basics; using
// anything locked errors with "you have not unlocked it yet".

const DEFAULT_UNLOCKS = ['harvest', 'do_a_spin', 'clear_map', 'hay'];
const LOCKABLE_GLOBALS = ['Math', 'Random', 'List', 'Dictionary', 'HashSet', 'Queue', 'Stack', 'Ground', 'Entity', 'Resource', 'pos_x', 'pos_y'];
// language constructs are unlockable too
const LOCKABLE_FEATURES = ['variables', 'booleans', 'if', 'switch', 'while', 'for', 'do_while', 'foreach', 'enum', 'classes', 'ref_out', 'strings'];
// each plantable entity is gated separately inside plant()
const LOCKABLE_ENTITIES = ['plant_tree', 'plant_bush', 'plant_carrot'];
const ALL_LOCKABLE = [
  ...Object.keys(scriptBuiltins),
  ...LOCKABLE_GLOBALS,
  ...LOCKABLE_FEATURES,
  ...LOCKABLE_ENTITIES,
  ...Object.keys(Objects.RESOURCES),
];

let unlocks = new Set(DEFAULT_UNLOCKS);
// which VERSION of each tree stage the player bought (stage id -> v).
// When a stage's definition changes, its `v` is bumped and the old cost is
// recorded in its `oldCosts` — owners of the old version get unlearned and
// refunded on load, free to relearn the new version.
let unlockVersions = {};

// reason a global name can't be used, or null if it's fine
function lockedName(name) {
  if (unlocks.has(name)) return null;
  if (ALL_LOCKABLE.includes(name)) return `'${name}' is locked — you have not unlocked it yet`;
  return null;
}

// builtins handed to the interpreter: locked ones throw instead of acting
function gatedBuiltins() {
  const out = {};
  for (const [name, fn] of Object.entries(scriptBuiltins)) {
    out[name] = unlocks.has(name)
      ? fn
      : () => {
          throw new Error(`${name}() is locked — you have not unlocked it yet`);
        };
  }
  return out;
}

// some abilities ride along with others: unlocking 'if' (whenever that
// unlock exists) also grants can_harvest(), since it's inert without logic
const UNLOCK_COMPANIONS = { if: ['can_harvest'] };

// passive perks: speed boost stages (5 planned) add onto the 1x base.
// actionMultiplier is always derived from unlocks — never saved directly.
const SPEED_BONUS = { speed_1: 0.5, speed_2: 0.5 };

// hay yield stages: each adds +1 hay per harvest on top of the base 1
const HAY_YIELD_BONUS = { hay_yield_1: 1, hay_yield_2: 1 };
function hayYieldAmount() {
  let n = 1;
  for (const [stage, bonus] of Object.entries(HAY_YIELD_BONUS)) {
    if (unlocks.has(stage)) n += bonus;
  }
  return n;
}
let debugSpeed = null; // testing override (bottom-right): absolute 0.5x, not a scale; not saved

function recomputeMultiplier() {
  let m = 1;
  for (const [stage, bonus] of Object.entries(SPEED_BONUS)) {
    if (unlocks.has(stage)) m += bonus;
  }
  actionMultiplier = debugSpeed ?? m;
  // speed badge, bottom-right of the viewport
  const badge = document.getElementById('speedBadge');
  const label = actionMultiplier.toFixed(2).replace(/0$/, '');
  badge.textContent = `SPEED ${label}x`;
  badge.classList.toggle('is-boosted', actionMultiplier > 1);
}

document.getElementById('halfSpeedBtn').addEventListener('click', (e) => {
  debugSpeed = debugSpeed === null ? 0.5 : null; // force exactly 0.5x
  e.currentTarget.classList.toggle('is-active', debugSpeed !== null);
  recomputeMultiplier();
});

// dev: ?speed=0.5 forces the debug speed override (same as the toggle)
if (params.get('speed')) {
  debugSpeed = parseFloat(params.get('speed')) || null;
  document.getElementById('halfSpeedBtn').classList.toggle('is-active', debugSpeed !== null);
}

// goals call this to grant access; suggestions update immediately and an
// open help panel rebuilds in place so it's always up to date
function grantUnlock(name) {
  unlocks.add(name);
  // granting a tree stage records the version being learned
  if (STAGE_BY_ID[name]) unlockVersions[name] = STAGE_BY_ID[name].v ?? 1;
  for (const extra of UNLOCK_COMPANIONS[name] || []) unlocks.add(extra);
  applyOwnedNodeGrants();
  recomputeWorldSize();
  ensureWorldTiles();
  recomputeMultiplier();
  refreshSuggestGlobals();
  refreshHelpPanel();
}

// world bounds are a function of owned expansions. The 1x3 strip is the
// one-and-only non-square world — an intermediate phase that teaches drone
// movement; every expansion after it is square again (3x3, ...).
function recomputeWorldSize() {
  mapW = 1;
  mapH = unlocks.has('world_1x3') ? 3 : 1;
  if (unlocks.has('world_3x3')) mapW = 3; // square again, growing eastward
  // future (square) expansions stack here
}

// add any tiles the current bounds call for, never touching existing ones —
// expansions grow the field without resetting the player's crops
function ensureWorldTiles() {
  for (let tx = -(mapH - 1); tx <= 0; tx++) {
    for (let ty = -(mapW - 1); ty <= 0; ty++) {
      if (!map.get(tx, ty)) {
        const t = map.set(tx, ty, 'grass');
        if (!objects.get(tx, ty) && Objects.canSpawnOn('hay', t)) {
          objects.set(tx, ty, 'hay');
        }
      }
    }
  }
}

// grass always produces hay: sprout it on any empty grass tile (used after
// loading a save, where mid-regrow timers were lost)
function regrowGrassHay() {
  for (const t of map.all()) {
    if (!objects.get(t.tx, t.ty) && Objects.canSpawnOn('hay', t)) {
      objects.set(t.tx, t.ty, 'hay');
    }
  }
}

// version reconciliation: when a stage's definition changed since the
// player bought it (its `v` was bumped), unlearn the stage, strip its
// grants, and refund what THEY paid (oldCosts[their version], falling back
// to the current cost) — they relearn the new version in the tree.
function reconcileUnlockVersions() {
  for (const n of UNLOCK_TREE) {
    for (const s of stagesOf(n)) {
      if (!unlocks.has(s.id)) continue;
      const cur = s.v ?? 1;
      const owned = unlockVersions[s.id] ?? 1;
      if (owned >= cur) continue;
      const refund = (s.oldCosts && s.oldCosts[owned]) || s.cost;
      for (const [k, amt] of Object.entries(refund)) {
        inventory[k] = (inventory[k] || 0) + amt;
      }
      unlocks.delete(s.id);
      delete unlockVersions[s.id];
      // grants still conferred by OTHER owned stages come back via
      // applyOwnedNodeGrants right after this
      for (const g of s.grants) unlocks.delete(g);
      console.info(`'${s.name}' changed (v${owned} -> v${cur}): cost refunded — relearn it in the unlockables tree`);
    }
  }
}

// tree ownership is by stage id; an owned stage confers its CURRENT grants —
// so editing a stage's grant list reaches existing owners automatically.
// (Flat nodes are their own single stage.)
function applyOwnedNodeGrants() {
  for (const n of UNLOCK_TREE) {
    for (const s of n.stages || [n]) {
      if (unlocks.has(s.id)) for (const g of s.grants) unlocks.add(g);
    }
  }
}

// rebuild an open help panel with current unlocks, keeping geometry and
// the selected entry (if it still exists)
function refreshHelpPanel() {
  if (!helpPanelOpen()) return;
  const path = helpPanel.getHelpPath();
  const geom = {
    x: helpPanel.el.offsetLeft,
    y: helpPanel.el.offsetTop,
    w: helpPanel.el.offsetWidth,
    h: helpPanel.el.offsetHeight,
    min: helpPanel.el.classList.contains('panel--min'),
  };
  const hp = openHelpPanel(geom);
  applyPanelGeom(hp, geom);
  if (path) hp.openHelpAt(path);
}

// autocomplete only offers what's unlocked
function refreshSuggestGlobals() {
  UI.suggest.globals = [
    ...Object.keys(scriptBuiltins).filter((n) => unlocks.has(n)).map((name) => ({ name, kind: 'fn' })),
    ...(unlocks.has('pos_x') ? [{ name: 'pos_x', kind: 'var' }] : []),
    ...(unlocks.has('pos_y') ? [{ name: 'pos_y', kind: 'var' }] : []),
  ];
  UI.suggest.enums = {};
  if (unlocks.has('Ground')) UI.suggest.enums.Ground = Object.keys(GROUND);
  if (unlocks.has('Entity')) UI.suggest.enums.Entity = Object.keys(ENTITY);
  if (unlocks.has('Resource')) UI.suggest.enums.Resource = RESOURCE_KEYS;
}
UI.suggest.isLocked = (name) => !!lockedName(name);
refreshSuggestGlobals();

// ---------- unlockables tree ($ menu) ----------
// A full-viewport overlay with its own pannable camera. Nodes cost
// resources and grant unlocks.

const UNLOCK_TREE = [
  {
    id: 'simple_loops',
    name: 'Simple Loops',
    // technical summary; `terms` render bold with code coloring
    desc: 'Repeat code with `while` (checks first) or `do`/`while` (runs once, then checks). Includes `true` / `false` and `can_harvest()`.',
    // shown in the tooltip as highlighted code — exactly what you get
    unlockLines: [
      'while (condition) { }',
      'do { } while (condition);',
      'true / false',
      'can_harvest()',
    ],
    grants: ['while', 'do_while', 'booleans', 'can_harvest'],
    cost: { hay: 5 },
    helpPath: 'LANGUAGE/simple loops', // help opens here after purchase
    x: 0,
    y: 0,
  },
  {
    // multi-stage: each stage adds +1 hay per harvest
    id: 'hay_yield',
    requires: ['simple_loops'],
    x: -260,
    y: 130,
    stages: [
      {
        id: 'hay_yield_1',
        name: 'Increase Hay Yield',
        desc: 'Each hay harvest yields `2` hay instead of `1` — `+100%`.',
        unlockLines: ['harvest();  // hay +2'],
        grants: ['hay_yield_1'],
        cost: { hay: 100 },
      },
      {
        id: 'hay_yield_2',
        name: 'Increase Hay Yield II',
        desc: 'Each hay harvest yields `3` hay — `+200%` over the base.',
        unlockLines: ['harvest();  // hay +3'],
        grants: ['hay_yield_2'],
        cost: { hay: 100, wood: 100 },
      },
    ],
  },
  {
    // multi-stage: the card upgrades in place, I -> II -> ... (5 planned).
    // Stages can add their own requires on top of the node's.
    id: 'speed_boost',
    requires: ['simple_loops'],
    x: 0,
    y: 130,
    stages: [
      {
        id: 'speed_1',
        name: 'Speed Boost I',
        desc: 'All drone actions — flying, harvesting, spinning — run `50%` faster. Stage `1` of `5`.',
        unlockLines: ['speed: 1.0x -> 1.5x'],
        grants: ['speed_1'], // passive perk: no helpPath, nothing to document
        cost: { hay: 100 },
      },
      {
        id: 'speed_2',
        name: 'Speed Boost II',
        desc: 'Another `50%` on top — `2.0x` total. Stage `2` of `5`.',
        unlockLines: ['speed: 1.5x -> 2.0x'],
        grants: ['speed_2'],
        requires: ['bushes'], // wood economy must exist first
        cost: { wood: 100 },
      },
    ],
  },
  {
    id: 'variables',
    name: 'Variables',
    desc: 'Store and reuse values: declare with `int`, `bool`, `string`, `float` or `var` — including nullable `int?` and `??`.',
    unlockLines: [
      'int n = 0;',
      'var crop = "hay";',
      'n = n + 1;',
    ],
    grants: ['variables'],
    requires: ['speed_1'],
    cost: { hay: 250 },
    helpPath: 'LANGUAGE/variables & null',
    x: -330,
    y: 260,
  },
  {
    id: 'basic_logic',
    name: 'Basic Logic',
    desc: 'Branch on conditions with `if` / `else`, using comparisons like `==`, `<` and `&&`.',
    unlockLines: [
      'if (can_harvest()) {',
      '    harvest();',
      '}',
    ],
    grants: ['if'],
    requires: ['speed_1'],
    cost: { hay: 250 },
    helpPath: 'LANGUAGE/if / else',
    x: 110,
    y: 260,
  },
  {
    id: 'bushes',
    name: 'Unlock Bushes',
    v: 2, // v2: land cycle — planting claims grass as dirt, harvest reverts it
    oldCosts: { 1: { hay: 500 } },
    desc: 'Unlocks the `wood` resource: hay harvests drop `bush_seed` half the time. Plant `Entity.Bush` (consumes a seed — the grass becomes dirt), let it grow, harvest it for wood; the land turns back to grass.',
    unlockLines: [
      'harvest();           // 50%: +seed',
      'plant(Entity.Bush);  // -1 seed',
      'harvest();           // -> wood',
      'has_resource(Resource.bush_seed)',
    ],
    grants: ['plant', 'Entity', 'plant_bush', 'bush_seed', 'wood', 'has_resource', 'Resource'],
    requires: ['speed_1'],
    cost: { hay: 500 },
    helpPath: 'DRONE/plant(entity)',
    x: 330,
    y: 260,
  },
  {
    id: 'carrots',
    name: 'Unlock Carrots',
    desc: 'Unlocks the `carrot` resource: bush harvests drop `carrot_seed` half the time. `till()` the ground into tilled soil — check it with `get_ground()` — plant `Entity.Carrot` there (consumes a seed), and harvest it.',
    unlockLines: [
      'till();                // -> tilled',
      'get_ground() == Ground.Tilled',
      'plant(Entity.Carrot);  // -1 seed',
      'harvest();             // -> carrot',
    ],
    grants: ['till', 'get_ground', 'Ground', 'plant_carrot', 'carrot', 'carrot_seed'],
    requires: ['bushes'],
    cost: { wood: 100 },
    helpPath: 'DRONE/till()',
    x: 330,
    y: 390,
  },
  {
    // multi-stage: one card that upgrades in place, I -> II -> ...
    id: 'world_expansion',
    requires: ['speed_1'],
    x: -110,
    y: 260,
    stages: [
      {
        id: 'world_1x3',
        name: 'World Expansion I',
        desc: 'Expands the world to `1x3`, growing northward. Unlocks flight: `north()`, `south()`, `east()`, `west()`.',
        unlockLines: [
          'north();  south();',
          'east();   west();',
          'world: 1x1 -> 1x3',
        ],
        grants: ['north', 'south', 'east', 'west'],
        cost: { hay: 200 },
        helpPath: 'DRONE/north()',
      },
      {
        id: 'world_3x3',
        name: 'World Expansion II',
        desc: 'Expands the world to `3x3`, growing eastward — back to a square field.',
        unlockLines: ['world: 1x3 -> 3x3'],
        grants: [],
        cost: { hay: 100 },
      },
    ],
  },
];

const unlockOverlay = document.getElementById('unlockOverlay');
const unlockViewport = document.getElementById('unlockViewport');
const unlockCanvas = document.getElementById('unlockCanvas');
const unlockCam = { x: 0, y: 0 };

function canAfford(cost) {
  return Object.entries(cost).every(([k, n]) => (inventory[k] || 0) >= n);
}

// tooltip prose: text between `backticks` renders bold with the same
// syntax coloring as the help menu and editors
function renderTipDesc(desc) {
  return desc
    .split('`')
    .map((part, i) =>
      i % 2
        ? `<b class="tipterm">${UI.highlight(part)}</b>`
        : part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('');
}

// icon + amount per resource; red when the player is short of it
function costHtml(cost) {
  return Object.entries(cost)
    .map(([k, n]) => {
      const res = Objects.RESOURCES[k];
      const short = (inventory[k] || 0) < n;
      return `<span class="tipcost__item${short ? ' is-short' : ''}" data-resource="${k}">` +
        `<img src="${res.icon}" alt="${res.name}">${n}</span>`;
    })
    .join('');
}

// stage helpers: multi-stage nodes upgrade in place (I -> II -> ...); a
// flat node is its own single stage
const stagesOf = (n) => n.stages || [n];
const nodeFullyOwned = (n) => stagesOf(n).every((s) => unlocks.has(s.id));
const activeStageOf = (n) => {
  const stages = stagesOf(n);
  return stages.find((s) => !unlocks.has(s.id)) || stages[stages.length - 1];
};
const STAGE_BY_ID = {};
const NODE_BY_STAGE = {};
for (const n of UNLOCK_TREE) {
  for (const s of stagesOf(n)) {
    STAGE_BY_ID[s.id] = s;
    NODE_BY_STAGE[s.id] = n;
  }
}
// what the node currently requires: its own requires plus the active
// stage's (later stages can demand more, e.g. Speed II needs Bushes)
const reqsOf = (n) => [...(n.requires || []), ...(activeStageOf(n).requires || [])];

function nodeTipHtml(stage, owned, unmetReqs) {
  return (
    `<div class="tip__head">${owned ? 'UNLOCKED' : 'UNLOCKS'}</div>` +
    (stage.desc ? `<div class="tip__desc">${renderTipDesc(stage.desc)}</div>` : '') +
    `<div class="tip__codebox">${stage.unlockLines.map((l) => UI.highlight(l)).join('\n')}</div>` +
    (unmetReqs.length
      ? `<div class="tip__req">requires: ${unmetReqs.map((id) => STAGE_BY_ID[id].name).join(', ')}</div>`
      : '') +
    (owned ? '' : `<div class="tipcost">${costHtml(stage.cost)}</div>`)
  );
}

// anything that changes the tree's DOM structure (not just colors)
function unlockTreeShape() {
  return UNLOCK_TREE.map((n) => {
    const unmet = reqsOf(n).filter((id) => !unlocks.has(id)).join('+');
    return `${n.id}:${activeStageOf(n).id}:${nodeFullyOwned(n) ? 1 : 0}:${unmet}`;
  }).join('|');
}

let unlockTreeKey = null;

function renderUnlockTree() {
  // resource ticks only recolor costs in place — a full rebuild recreates
  // the <img> icons and flickers. Rebuild only when the structure changes.
  const key = unlockTreeShape();
  if (key === unlockTreeKey && unlockCanvas.childElementCount) {
    updateUnlockTreeAffordability();
    return;
  }
  unlockTreeKey = key;
  buildUnlockTree();
}

// cheap per-tick pass: toggle affordability classes, refresh tooltips
function updateUnlockTreeAffordability() {
  for (const el of unlockCanvas.querySelectorAll('.unlocknode')) {
    const node = UNLOCK_TREE.find((n) => n.id === el.dataset.node);
    if (!node) continue;
    const owned = nodeFullyOwned(node);
    const stage = activeStageOf(node);
    const unmetReqs = reqsOf(node).filter((id) => !unlocks.has(id));
    if (!owned && !unmetReqs.length) {
      el.classList.toggle('is-poor', !canAfford(stage.cost));
    }
    for (const item of el.querySelectorAll('.tipcost__item')) {
      const k = item.dataset.resource;
      item.classList.toggle('is-short', (inventory[k] || 0) < (stage.cost[k] || 0));
    }
    el.dataset.tiphtml = nodeTipHtml(stage, owned, unmetReqs);
  }
}

function buildUnlockTree() {
  unlockCanvas.innerHTML = '';

  // node cards go in first so the connectors can be trimmed against their
  // REAL rendered rectangles — long titles make cards wider than any fixed
  // guess, which left lines short of some cards and piercing others
  const nodeEls = {};

  for (const node of UNLOCK_TREE) {
    const owned = nodeFullyOwned(node);
    const stage = activeStageOf(node); // first un-bought, or last when done
    const affordable = canAfford(stage.cost);
    const unmetReqs = reqsOf(node).filter((id) => !unlocks.has(id));
    const el = document.createElement('div');
    el.dataset.node = node.id;
    el.className = 'unlocknode' +
      (owned ? ' is-owned' : unmetReqs.length ? ' is-locked' : affordable ? '' : ' is-poor');
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.innerHTML =
      '<svg class="unlocknode__icon" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">' +
      '<rect x="4" y="4" width="8" height="8" transform="rotate(45 8 8)" fill="#b8f33b" /></svg>' +
      `<div class="unlocknode__name">${stage.name}</div>` +
      `<div class="unlocknode__cost">${owned ? 'OWNED' : costHtml(stage.cost)}</div>`;
    // tooltip: technical summary + what you get (help-menu coloring) + cost
    el.dataset.tiphtml = nodeTipHtml(stage, owned, unmetReqs);
    // conditions are checked live: affordability can change without a
    // structural rebuild (counts tick while the overlay is open)
    el.addEventListener('click', () => {
      const buyStage = activeStageOf(node);
      const blocked = nodeFullyOwned(node) ||
        reqsOf(node).some((id) => !unlocks.has(id)) ||
        !canAfford(buyStage.cost);
      if (blocked) return;
      for (const [k, n] of Object.entries(buyStage.cost)) inventory[k] -= n;
      grantUnlock(buyStage.id); // ownership marker; confers the stage's grants
      for (const g of buyStage.grants) grantUnlock(g);
      renderResources();
      renderUnlockTree();
      saveGame();
      // show the player what they just learned: open help at the new entry
      if (buyStage.helpPath) {
        showUnlocks(false);
        document.getElementById('helpBtn').click(); // rebuilds with the unlock
        helpPanel?.openHelpAt(buyStage.helpPath);
      }
    });
    unlockCanvas.appendChild(el);
    nodeEls[node.id] = el;
  }

  // connector lines: border-to-border against measured card rects, with a
  // small standoff so they never touch the cards; slipped underneath
  const svgNS = 'http://www.w3.org/2000/svg';
  const links = document.createElementNS(svgNS, 'svg');
  links.setAttribute('class', 'unlocklinks');
  // a real-sized viewport centered on the canvas origin — zero-size SVGs
  // are skipped by the painter even with overflow: visible
  links.setAttribute('viewBox', '-5000 -5000 10000 10000');
  const GAP = 6; // standoff between line end and card border
  const halfRect = (n) => {
    const el = nodeEls[n.id];
    // fallbacks for the (defensive) case of measuring while display: none
    return { w: (el.offsetWidth || 180) / 2, h: (el.offsetHeight || 92) / 2 };
  };
  for (const node of UNLOCK_TREE) {
    for (const reqId of reqsOf(node)) {
      const req = NODE_BY_STAGE[reqId];
      if (!req || req === node) continue; // stages within one card need no line
      const dx = node.x - req.x;
      const dy = node.y - req.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      // distance from a card's center to its border along the link direction
      const trim = (r) => Math.min(
        ux !== 0 ? r.w / Math.abs(ux) : Infinity,
        uy !== 0 ? r.h / Math.abs(uy) : Infinity,
      ) + GAP;
      const dA = trim(halfRect(req));
      const dB = trim(halfRect(node));
      if (dA + dB >= len) continue; // cards touch — no room for a line
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', req.x + ux * dA);
      line.setAttribute('y1', req.y + uy * dA);
      line.setAttribute('x2', node.x - ux * dB);
      line.setAttribute('y2', node.y - uy * dB);
      // bold the path to the logical next unlock (required stage owned,
      // target not fully bought — affordability doesn't matter); completed
      // paths settle to a medium weight, locked paths stay dim
      if (unlocks.has(reqId)) line.setAttribute('class', nodeFullyOwned(node) ? 'is-done' : 'is-next');
      links.appendChild(line);
    }
  }
  unlockCanvas.insertBefore(links, unlockCanvas.firstChild);

  unlockCanvas.style.transform = `translate(${unlockCam.x}px, ${unlockCam.y}px)`;
}

function showUnlocks(on) {
  unlockOverlay.hidden = !on;
  if (on) {
    // center the tree origin in the viewport
    unlockCam.x = unlockViewport.clientWidth / 2;
    unlockCam.y = unlockViewport.clientHeight / 2;
    renderUnlockTree();
  }
}

document.getElementById('unlocksBtn').addEventListener('click', () => showUnlocks(true));
document.getElementById('unlockCloseBtn').addEventListener('click', () => showUnlocks(false));

// drag to pan the tree (a camera, like the world's)
let unlockDragging = false;
let unlockLastX = 0, unlockLastY = 0;
unlockViewport.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.unlocknode')) return; // nodes are clickable, not draggable
  unlockDragging = true;
  unlockLastX = e.clientX;
  unlockLastY = e.clientY;
  unlockViewport.setPointerCapture(e.pointerId);
});
unlockViewport.addEventListener('pointermove', (e) => {
  if (!unlockDragging) return;
  unlockCam.x += e.clientX - unlockLastX;
  unlockCam.y += e.clientY - unlockLastY;
  unlockLastX = e.clientX;
  unlockLastY = e.clientY;
  unlockCanvas.style.transform = `translate(${unlockCam.x}px, ${unlockCam.y}px)`;
});
unlockViewport.addEventListener('pointerup', () => (unlockDragging = false));
unlockViewport.addEventListener('pointercancel', () => (unlockDragging = false));

unlockUiReady = true;
renderResources(); // resource chips respect unlocks
recomputeMultiplier(); // initial speed badge

// dev: ?unlockall=1 opens the whole API (used by regression tests)
if (params.has('unlockall')) {
  unlocks = new Set(ALL_LOCKABLE);
  refreshSuggestGlobals();
  renderResources(); // chips for every resource now unlocked
}

UI.handlers.play = (p) => Runner.play(p);
UI.handlers.pause = (p) => Runner.pause(p);
UI.handlers.stop = (p) => Runner.stop(p);
UI.handlers.closed = (p) => Runner.stop(p);
UI.handlers.edited = () => {
  // any code edit invalidates the compiled program — stop the running script
  if (Runner.current) {
    Runner.current.control.reason = 'code edited';
    Runner.stop(Runner.current.panel);
  }
};

// the "main" panel always exists: no close button, fixed name
const MAIN_DEFAULT_TEXT = [
  '// DroneFarm — C#-like drone scripting',
  '// Press ▶ to run, ? (top right) for help.',
  '',
  'do_a_spin();',
  '',
].join('\n');

const mainPanel = UI.createPanel({
  title: 'main',
  x: 24,
  y: 96,
  closable: false,
  renamable: false,
  text: MAIN_DEFAULT_TEXT,
});

// dev: ?code=<urlencoded script> overrides main's code; ?autorun=1 plays it on load
if (params.has('code')) {
  mainPanel.body.value = params.get('code');
  mainPanel.body.dispatchEvent(new Event('input'));
}
if (params.has('autorun')) setTimeout(() => Runner.play(mainPanel), 400);

// "+" button: open a new panel, cascading from the top right;
// spawned panels are closable and renamable (double-click the title)
let panelCount = 0;
document.getElementById('addPanel').addEventListener('click', () => {
  const n = panelCount++;
  UI.createPanel({
    title: `PANEL ${n + 1}`,
    x: innerWidth - 380 - (n % 6) * 26,
    y: 140 + (n % 6) * 26,
    text: '// helper functions are shared across panels\n',
  });
});

// "?" button: tabbed help panel — content lives in src/helpcontent.js

// the help tree only documents what the player has unlocked (plus the
// always-available core: controls, language, strings)
function buildHelpSections() {
  const has = (n) => unlocks.has(n);
  const out = {
    CONTROLS: HELP_ALL.CONTROLS,
    SCRIPTING: HELP_ALL.SCRIPTING,
  };

  const droneGates = {
    'Ground / Entity': has('Ground') || has('Entity'),
    'north()': has('north'),
    'south()': has('south'),
    'east()': has('east'),
    'west()': has('west'),
    'harvest()': has('harvest'),
    'has_resource()': has('has_resource'),
    'can_harvest()': has('can_harvest'),
    'do_a_spin()': has('do_a_spin'),
    'world_size()': has('world_size'),
    'get_ground()': has('get_ground'),
    'get_entity()': has('get_entity'),
    'till()': has('till'),
    'seed()': has('seed'),
    'plant(entity)': has('plant'),
    'clear_map()': has('clear_map'),
    'pos_x, pos_y': has('pos_x') || has('pos_y'),
  };
  const drone = {};
  for (const [k, v] of Object.entries(HELP_ALL.DRONE)) {
    if (k === '' || (droneGates[k] ?? true)) drone[k] = v;
  }
  out.DRONE = drone;

  // LANGUAGE: every construct is unlockable; the group hides until one is
  const lang = { '': HELP_ALL.LANGUAGE[''] };
  if (has('variables')) lang['variables & null'] = HELP_ALL.LANGUAGE['variables & null'];
  if (has('if')) lang['if / else'] = HELP_ALL.LANGUAGE['if / else'];
  if (has('switch')) lang['switch / case'] = HELP_ALL.LANGUAGE['switch / case'];
  if (has('while') || has('do_while')) lang['simple loops'] = HELP_ALL.LANGUAGE['simple loops'];
  if (has('for') || has('foreach')) lang['advanced loops'] = HELP_ALL.LANGUAGE['advanced loops'];
  if (has('enum')) lang.enum = HELP_ALL.LANGUAGE.enum;
  if (has('classes')) lang['classes & structs'] = HELP_ALL.LANGUAGE['classes & structs'];
  if (has('ref_out')) lang['ref & out'] = HELP_ALL.LANGUAGE['ref & out'];
  if (Object.keys(lang).length > 1) out.LANGUAGE = lang;

  if (has('Math') || has('Random')) {
    const math = { '': HELP_ALL.MATH[''] };
    if (has('Math')) math.Math = HELP_ALL.MATH.Math;
    if (has('Random')) math.Random = HELP_ALL.MATH.Random;
    out.MATH = math;
  }

  if (has('List') || has('Dictionary') || has('HashSet') || has('Queue') || has('Stack')) {
    const c = { '': HELP_ALL.COLLECTIONS[''], arrays: HELP_ALL.COLLECTIONS.arrays };
    if (has('List')) c.List = HELP_ALL.COLLECTIONS.List;
    if (has('Dictionary')) c.Dictionary = HELP_ALL.COLLECTIONS.Dictionary;
    if (has('HashSet')) c.HashSet = HELP_ALL.COLLECTIONS.HashSet;
    if (has('Queue') || has('Stack')) c['Queue / Stack'] = HELP_ALL.COLLECTIONS['Queue / Stack'];
    out.COLLECTIONS = c;
  }

  if (has('strings')) out.STRINGS = HELP_ALL.STRINGS;

  // example matched to current abilities
  if (has('north') && has('east') && has('for') && has('if')) {
    out.EXAMPLE = HELP_ALL.EXAMPLE;
  } else if (has('while') && has('if')) {
    out.EXAMPLE = [
      'With your current unlocks:',
      '```',
      '// harvest, celebrate, repeat',
      'while (true) {',
      '    if (harvest()) {',
      '        do_a_spin();',
      '    }',
      '}',
      '```',
      'Reach your goals to unlock more',
      'of the drone!',
    ].join('\n');
  } else {
    out.EXAMPLE = [
      'With your current unlocks:',
      '```',
      'harvest();',
      'do_a_spin();',
      'harvest();',
      '```',
      'Reach your goals to unlock more',
      'of the drone — and more of the',
      'language!',
    ].join('\n');
  }

  return out;
}

let helpPanel = null;

function helpPanelOpen() {
  return helpPanel && document.body.contains(helpPanel.el);
}

// (re)create the help panel — always rebuilt so gated entries are current
function openHelpPanel(geom) {
  if (helpPanelOpen()) {
    geom = geom || { x: helpPanel.el.offsetLeft, y: helpPanel.el.offsetTop };
    helpPanel.close();
  }
  helpPanel = UI.createPanel({
    title: 'help',
    x: geom ? geom.x : innerWidth - 500,
    y: geom ? geom.y : 140,
    width: 470,
    height: 340,
    renamable: false,
    help: buildHelpSections(),
  });
  return helpPanel;
}

document.getElementById('helpBtn').addEventListener('click', () => openHelpPanel(null));
if (params.has('help')) document.getElementById('helpBtn').click(); // dev: open help on load
// dev: ?grant=a,b grants specific unlocks (here, after helpPanel exists,
// because grantUnlock refreshes an open help panel)
if (params.get('grant')) {
  for (const g of params.get('grant').split(',')) grantUnlock(g);
}
// dev: ?give=hay:10,bush_seed:2 stocks the inventory
if (params.get('give')) {
  for (const part of params.get('give').split(',')) {
    const [k, n] = part.split(':');
    if (k in inventory) inventory[k] += parseInt(n || '1', 10) || 0;
  }
  renderResources();
}
if (params.has('unlocks')) showUnlocks(true); // dev: open the unlockables tree on load

// left-click drag pans the camera (clamped near the tile field)
let dragging = false;
let lastPX = 0, lastPY = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  lastPX = e.clientX;
  lastPY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  camera.x -= (e.clientX - lastPX) / camera.zoom;
  camera.y -= (e.clientY - lastPY) / camera.zoom;
  lastPX = e.clientX;
  lastPY = e.clientY;
  clampCamera();
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointercancel', () => (dragging = false));

// mouse-wheel zoom, anchored on the cursor — only when the cursor is over
// the map (panels are separate DOM elements, so they scroll natively)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const old = camera.zoom;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, old * Math.exp(-e.deltaY * 0.0012)));
  if (next === old) return;
  const cx = innerWidth / 2, cy = innerHeight / 2;
  const wx = (e.clientX - cx) / old + camera.x; // world point under the cursor...
  const wy = (e.clientY - cy) / old + camera.y;
  camera.zoom = next;
  camera.x = wx - (e.clientX - cx) / next;      // ...stays under the cursor
  camera.y = wy - (e.clientY - cy) / next;
  clampCamera();
}, { passive: false });

// harvest whatever yields a resource on a tile: pop, bank the resource,
// revert the land one step, and let grass produce its hay again
function harvestAt(tx, ty) {
  const o = objects.get(tx, ty);
  if (!o) return false;
  const def = Objects.DEFS[o.type];
  if (!def.yields) return false; // sprouts etc. can't be harvested
  if (def.harvestSound) playSfx(def.harvestSound, def.harvestSoundGain); // as the object pops
  objects.remove(tx, ty);
  // harvesting reverts the land one step: dirt -> grass (hay country
  // again), tilled -> plain dirt. Grass stays grass.
  const ground = map.get(tx, ty);
  if (ground) {
    if (Tiles.hasClass(ground, 'tilled')) map.set(tx, ty, 'dirt');
    else if (ground.type === 'dirt') map.set(tx, ty, 'grass');
  }
  // grass always produces hay — sprout one after the usual regrow delay
  const after = map.get(tx, ty);
  if (after && Objects.canSpawnOn('hay', after)) {
    setTimeout(() => {
      const t2 = map.get(tx, ty);
      if (t2 && !objects.get(tx, ty) && Objects.canSpawnOn('hay', t2)) {
        objects.set(tx, ty, 'hay');
      }
    }, Objects.DEFS.hay.regrowMs);
  }
  // resources are banked IMMEDIATELY — has_resource() must be truthful the
  // moment harvest() returns; the flier is purely cosmetic. First
  // acquisition of a resource reveals its counter.
  if (!unlocks.has(def.yields)) grantUnlock(def.yields);
  // yield upgrades: hay pays more per Increase Hay Yield stage
  const amount = def.yields === 'hay' ? hayYieldAmount() : 1;
  inventory[def.yields] += amount;
  renderResources();
  const p = tileScreen(tx, ty);
  flyResource(def.yields, p.x, p.y);
  // bonus seed drops, gated on having the matching plant unlocked
  for (const drop of def.seedDrops || []) {
    if (unlocks.has(drop.requires) && Math.random() < drop.chance) {
      if (!unlocks.has(drop.resource)) grantUnlock(drop.resource);
      inventory[drop.resource]++;
      renderResources();
      flyResource(drop.resource, p.x + 26, p.y - 10);
    }
  }
  // (no per-entity regrow timers anymore — "grass always produces hay" is
  // the regrowth law, handled by the grass check above)
  return true;
}

// full-size icon sprite rises from the harvest point and shrinks into
// the resource bar chip; the count ticks up when it lands
function flyResource(resKey, fromX, fromY) {
  const res = Objects.RESOURCES[resKey];
  const flier = document.createElement('img');
  flier.src = res.icon;
  flier.className = 'flier';
  flier.onload = () => {
    // pop beside the harvest point at 50% size (covering the tile/drone with
    // a full-size sprite read as a jarring flash), then shrink to the bar
    const w = flier.naturalWidth / 2, h = flier.naturalHeight / 2;
    const SIDE = 48; // sideways offset from the harvest point
    flier.style.left = `${fromX + SIDE}px`;
    flier.style.top = `${fromY - h}px`;
    flier.style.width = `${w}px`;
    const target = document.querySelector(`#resources img[data-type="${resKey}"]`);
    if (!target) {
      flier.remove(); // no chip to fly to — the count is already banked
      return;
    }
    const r = target.getBoundingClientRect();
    const s = r.height / h;
    const dx = r.left - (fromX + SIDE);
    const dy = r.top - (fromY - h);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      flier.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
    }));
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      flier.remove(); // cosmetic only — the count was banked at harvest time
    };
    flier.addEventListener('transitionend', land);
    setTimeout(land, 900); // fallback if the transition event is missed
  };
  document.body.appendChild(flier);
}

// facing angle (deg, y-down screen space) -> sheet frame index
function dirFrame(angleDeg) {
  return ((Math.round((angleDeg - FRAME_ANGLE0) / 45) % 8) + 8) % 8;
}

// ---------- audio channels (mixed into every sound, saved locally) ----------

const audioChannels = Object.assign(
  { master: 1, drone: 1, sfx: 1 },
  JSON.parse(localStorage.getItem('df_audio') || '{}'),
);
function saveAudioChannels() {
  localStorage.setItem('df_audio', JSON.stringify(audioChannels));
}

// ---------- pause menu ----------

let gamePaused = false;
let pauseStarted = 0;
let scriptWasPaused = false;
const pauseMenuEl = document.getElementById('pauseMenu');
const optionsView = document.getElementById('optionsView');

function setPaused(on) {
  if (on === gamePaused) return;
  gamePaused = on;
  pauseMenuEl.hidden = !on;
  if (on) {
    pauseStarted = performance.now();
    // hold the running script (remember if the user had paused it themselves)
    scriptWasPaused = Runner.current ? Runner.current.control.paused : false;
    if (Runner.current) Runner.current.control.paused = true;
    audio?.ctx.suspend().catch(() => {});
    saveGame(); // opening the menu is a natural save point
  } else {
    // shift absolute-time animations so they resume where they froze
    const delta = performance.now() - pauseStarted;
    state.dipStart += delta;
    if (state.spinFx) state.spinFx.start += delta;
    // (growth is dt-driven and freezes with the paused frame loop)
    if (Runner.current && !scriptWasPaused) Runner.current.control.paused = false;
    audio?.ctx.resume().catch(() => {});
    optionsView.hidden = true;
    showSaves(false); // next open starts on the main menu
    showNewGame(false);
  }
}

document.getElementById('menuBtn').addEventListener('click', () => setPaused(true));
document.getElementById('resumeBtn').addEventListener('click', () => setPaused(false));
document.getElementById('optionsBtn').addEventListener('click', () => {
  optionsView.hidden = !optionsView.hidden;
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !isTyping(e.target)) {
    if (!unlockOverlay.hidden) {
      unlockOverlay.hidden = true; // Esc closes the unlockables first
      return;
    }
    setPaused(!gamePaused);
  }
});

// options tabs: Graphics (empty for now) | Audio (channel mixer)
const tabGraphics = document.getElementById('tabGraphics');
const tabAudio = document.getElementById('tabAudio');
const optsGraphics = document.getElementById('optsGraphics');
const optsAudio = document.getElementById('optsAudio');
function showOptionsTab(audioTab) {
  tabAudio.classList.toggle('is-active', audioTab);
  tabGraphics.classList.toggle('is-active', !audioTab);
  optsAudio.hidden = !audioTab;
  optsGraphics.hidden = audioTab;
}
tabGraphics.addEventListener('click', () => showOptionsTab(false));
tabAudio.addEventListener('click', () => showOptionsTab(true));

// channel sliders: init from saved values, apply + save on input
for (const slider of optsAudio.querySelectorAll('input[type="range"]')) {
  const ch = slider.dataset.channel;
  const valueEl = slider.nextElementSibling;
  slider.value = Math.round(audioChannels[ch] * 100);
  valueEl.textContent = slider.value;
  slider.addEventListener('input', () => {
    audioChannels[ch] = slider.value / 100;
    valueEl.textContent = slider.value;
    saveAudioChannels();
  });
}

// ---------- audio: the drone's hum, attached to the drone ----------

const DRONE_VOL = 0.5;     // base hum volume when the drone fills the view
const DRONE_VOL_DIST = 420; // px from view center where the hum is half as loud

let audio = null;
function initAudio() {
  if (audio) return;
  const ctx = new AudioContext();
  const pan = ctx.createStereoPanner();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  pan.connect(gain).connect(ctx.destination);
  audio = { ctx, pan, gain, src: null, buffer: null, posGain: 1 };
  // decode into a buffer: AudioBufferSource loops are sample-accurate
  // (HTMLAudio loop=true has an audible gap at the seam)
  fetch('assets/drone_sound.ogg')
    .then((r) => r.arrayBuffer())
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => {
      audio.buffer = buf;
      startHum();
    })
    .catch(() => {});
}

function startHum() {
  if (!audio || audio.src || !audio.buffer) return;
  const src = audio.ctx.createBufferSource();
  src.buffer = audio.buffer;
  src.loop = true;
  src.connect(audio.pan);
  src.start();
  audio.src = src;
}

// one-shot sound effects, emitted from the drone: they share the hum's
// positional falloff and route through the SFX mixer channel.
// gain: per-sound trim for clips that are mixed hot
function playSfx(name, gain = 1) {
  if (!audio || audio.ctx.state !== 'running') return;
  const el = new Audio(`assets/${name}.ogg`);
  el.volume = Math.min(1, audio.posGain * audioChannels.master * audioChannels.sfx * gain);
  el.play().catch(() => {});
}

// browsers block audio until a user gesture — keep trying until it runs
const tryAudio = () => {
  initAudio();
  audio.ctx.resume().then(() => {
    startHum();
    if (audio.ctx.state === 'running') {
      removeEventListener('pointerdown', tryAudio);
      removeEventListener('keydown', tryAudio);
    }
  });
};
tryAudio();
addEventListener('pointerdown', tryAudio);
addEventListener('keydown', tryAudio);

// called per frame with the drone's screen position
function updateDroneSound(bodyX, bodyY, zoom) {
  if (!audio || audio.ctx.state !== 'running') return;
  const dx = bodyX - innerWidth / 2;
  const dy = bodyY - innerHeight / 2;
  const dist = Math.hypot(dx, dy);
  const falloff = 1 / (1 + (dist / DRONE_VOL_DIST) ** 2);
  audio.posGain = falloff * Math.min(1.15, 0.4 + 0.6 * zoom); // shared with SFX
  const vol = DRONE_VOL * audio.posGain * audioChannels.master * audioChannels.drone;
  const t = audio.ctx.currentTime;
  audio.gain.gain.setTargetAtTime(vol, t, 0.08);
  audio.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, dx / (innerWidth / 2))) * 0.7, t, 0.08);
  // the rotors pitch up while flying (and harder during a spin flourish),
  // easing back down when hovering
  if (audio.src) {
    const targetRate = state.spinFx ? 1.28 : state.moveTo ? 1.18 : 1.0;
    audio.src.playbackRate.setTargetAtTime(targetRate, t, 0.12);
  }
}

// ---------- local saves: the player owns their game (JSON in localStorage) ----------
// Multiple named slots; the active slot autosaves. The save manager in the
// pause menu lists slots for renaming and (re)loading.

const SAVES_KEY = 'df_saves';
const SAVE_EVERY_MS = 5000;

let saveStore = { active: null, slots: [] };
try {
  saveStore = JSON.parse(localStorage.getItem(SAVES_KEY)) || saveStore;
} catch { /* fresh store */ }

function persistStore() {
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(saveStore));
  } catch (e) {
    console.warn('save failed:', e);
  }
}

function activeSlot() {
  return saveStore.slots.find((s) => s.id === saveStore.active);
}

function gatherSave() {
  return {
    v: 1,
    unlocks: [...unlocks],
    unlockVersions: { ...unlockVersions },
    inventory: { ...inventory },
    drone: { tx: state.tile.tx, ty: state.tile.ty, dir: state.dir },
    camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
    tiles: [...map.all()].map((t) => ({
      tx: t.tx, ty: t.ty, type: t.type, light: t.light, flags: t.flags,
    })),
    objects: [...objects.all()].map((o) => ({
      tx: o.tx,
      ty: o.ty,
      type: o.type,
      grow: o.growAge != null ? o.growAge : undefined,
    })),
    panels: UI.panels.filter((p) => p.isScript).map((p) => ({
      main: p === mainPanel,
      title: p.title,
      text: p.body.value,
      x: p.el.offsetLeft,
      y: p.el.offsetTop,
      w: p.el.offsetWidth,
      h: p.el.offsetHeight,
      min: p.el.classList.contains('panel--min'),
    })),
    help: helpPanelOpen()
      ? {
          x: helpPanel.el.offsetLeft,
          y: helpPanel.el.offsetTop,
          w: helpPanel.el.offsetWidth,
          h: helpPanel.el.offsetHeight,
          min: helpPanel.el.classList.contains('panel--min'),
          path: helpPanel.getHelpPath(),
        }
      : null,
  };
}

function saveGame() {
  let slot = activeSlot();
  if (!slot) {
    slot = { id: Math.random().toString(36).slice(2, 9), name: 'AUTOSAVE' };
    saveStore.slots.push(slot);
    saveStore.active = slot.id;
  }
  slot.data = gatherSave();
  slot.time = Date.now();
  persistStore();
}

function applyPanelGeom(p, s) {
  p.el.style.left = s.x + 'px';
  p.el.style.top = s.y + 'px';
  p.el.style.width = s.w + 'px';
  p.el.style.height = s.h + 'px';
  p.minimize(!!s.min);
}

// apply a save's data to the live game — used at boot and by the save
// manager's LOAD button (mid-game)
function applySaveData(save) {
  if (!save || save.v !== 1) return;
  try {
    // halt anything in flight: stop scripts, settle pending movement
    Runner.queued = null;
    if (Runner.current) Runner.current.control.stopped = true;
    if (state.onArrive) {
      const f = state.onArrive;
      state.onArrive = null;
      f();
    }
    state.moveTo = null;
    state.spinFx = null;

    // spawned script panels are recreated from the save; main is reused
    for (const p of [...UI.panels]) {
      if (p.isScript && p !== mainPanel) p.close();
    }

    // progression
    unlocks = new Set(save.unlocks ?? DEFAULT_UNLOCKS);
    unlockVersions = { ...(save.unlockVersions || {}) };
    for (const k of Object.keys(inventory)) inventory[k] = 0; // no cross-world leakage
    Object.assign(inventory, save.inventory);
    reconcileUnlockVersions(); // changed stages: unlearn + refund
    applyOwnedNodeGrants(); // owned tree stages confer their current grants
    refreshSuggestGlobals();
    renderResources();

    // world bounds derive from the unlocks restored above
    recomputeWorldSize();
    if (save.tiles) {
      map.clear();
      for (const t of save.tiles) {
        const tile = map.set(t.tx, t.ty, t.type, t.flags);
        tile.light = t.light ?? 1;
      }
    }
    ensureWorldTiles(); // fill anything the current bounds call for
    regrowGrassHay(); // lost regrow timers: grass always produces hay
    if (save.objects) {
      objects.clear();
      for (const o of save.objects) {
        const obj = objects.set(o.tx, o.ty, o.type);
        if (o.grow != null) obj.growAge = o.grow; // resume growth where it left off
      }
      // tiles that were mid-regrow when saved lost their timers — restart them
      for (const t of map.all()) {
        if (!objects.get(t.tx, t.ty) && Objects.canSpawnOn('hay', t)) {
          setTimeout(() => {
            const tile = map.get(t.tx, t.ty);
            if (tile && !objects.get(t.tx, t.ty) && Objects.canSpawnOn('hay', tile)) {
              objects.set(t.tx, t.ty, 'hay');
            }
          }, Objects.DEFS.hay.regrowMs || 1000);
        }
      }
    }

    // drone
    if (save.drone) {
      state.tile = { tx: save.drone.tx, ty: save.drone.ty };
      state.pos = tileWorld(save.drone.tx, save.drone.ty);
      if (!params.has('dir')) state.dir = save.drone.dir ?? state.dir;
    }

    // camera + multiplier
    if (save.camera && !params.has('zoom')) {
      camera.x = save.camera.x;
      camera.y = save.camera.y;
      camera.zoom = save.camera.zoom ?? 1;
      clampCamera();
    }
    recomputeMultiplier(); // derived from the unlocks restored above

    // panels: main is restored in place, others recreated
    if (save.panels) {
      for (const s of save.panels) {
        if (s.main) {
          if (!params.has('code')) {
            mainPanel.body.value = s.text;
            mainPanel.body.dispatchEvent(new Event('input'));
          }
          applyPanelGeom(mainPanel, s);
        } else {
          const p = UI.createPanel({ title: s.title, text: s.text, x: s.x, y: s.y, width: s.w });
          applyPanelGeom(p, s);
        }
      }
      panelCount = save.panels.length; // keep new-panel cascade offsets fresh
    }

    // help panel: restore open state, geometry and selected entry
    if (save.help) {
      const hp = openHelpPanel({ x: save.help.x, y: save.help.y });
      applyPanelGeom(hp, save.help);
      if (save.help.path) hp.openHelpAt(save.help.path);
    } else if (helpPanelOpen()) {
      helpPanel.close();
      helpPanel = null;
    }
    // saved geometry may come from a larger window — keep panels reachable
    UI.clampPanels();
  } catch (e) {
    console.warn('load failed:', e);
  }
}

// boot: load the active slot, then autosave into it
if (activeSlot()?.data) applySaveData(activeSlot().data);
setInterval(saveGame, SAVE_EVERY_MS);
addEventListener('beforeunload', saveGame);

// ---------- save manager (pause menu > SAVES) ----------

const pauseMainBox = document.getElementById('pauseMain');
const saveManager = document.getElementById('saveManager');
const saveListEl = document.getElementById('saveList');
const saveConfirmEl = document.getElementById('saveConfirm');
const saveConfirmText = document.getElementById('saveConfirmText');
const newSaveBtn = document.getElementById('newSaveBtn');
const closeSavesBtn = document.getElementById('closeSavesBtn');

let pendingDelete = null;

function showSaves(on) {
  saveManager.hidden = !on;
  pauseMainBox.hidden = on;
  if (on) {
    showDeleteConfirm(null);
    renderSaveList();
  }
}

// the delete flow swaps the list for a confirmation prompt
function showDeleteConfirm(slot) {
  pendingDelete = slot ? slot.id : null;
  saveConfirmEl.hidden = !slot;
  saveListEl.hidden = !!slot;
  newSaveBtn.hidden = !!slot;
  closeSavesBtn.hidden = !!slot;
  if (slot) saveConfirmText.textContent = `Delete "${slot.name}"? This cannot be undone.`;
}

function renderSaveList() {
  saveListEl.innerHTML = '';
  for (const slot of saveStore.slots) {
    const row = document.createElement('div');
    row.className = 'save__row' + (slot.id === saveStore.active ? ' is-active' : '');

    const name = document.createElement('input');
    name.className = 'save__name';
    name.value = slot.name;
    name.spellcheck = false;
    name.dataset.tip = 'Rename this save';
    name.addEventListener('change', () => {
      slot.name = name.value.trim() || slot.name;
      name.value = slot.name;
      persistStore();
    });

    const load = document.createElement('button');
    load.type = 'button';
    load.textContent = 'LOAD';
    load.dataset.tip = 'Load this save (also reloads the active one)';
    load.addEventListener('click', () => {
      saveStore.active = slot.id;
      applySaveData(slot.data);
      persistStore();
      renderSaveList();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'save__delete';
    del.textContent = '×';
    del.dataset.tip = 'Delete this save';
    del.addEventListener('click', () => showDeleteConfirm(slot));

    row.append(name, load, del);
    saveListEl.appendChild(row);
  }
}

document.getElementById('confirmDeleteBtn').addEventListener('click', () => {
  const idx = saveStore.slots.findIndex((s) => s.id === pendingDelete);
  if (idx >= 0) {
    const wasActive = saveStore.slots[idx].id === saveStore.active;
    saveStore.slots.splice(idx, 1);
    // deleting the active slot detaches it: the next autosave starts a
    // fresh slot instead of silently overwriting another save
    if (wasActive) saveStore.active = null;
    persistStore();
  }
  showDeleteConfirm(null);
  renderSaveList();
});
document.getElementById('cancelDeleteBtn').addEventListener('click', () => showDeleteConfirm(null));

// ---------- new game (pause menu > NEW GAME) ----------
// The current world is saved into its slot first — no data loss — then a
// factory-fresh world starts in a brand-new active slot.

const newGameBox = document.getElementById('newGameBox');

function showNewGame(on) {
  newGameBox.hidden = !on;
  pauseMainBox.hidden = on;
}

function newGame() {
  // halt anything in flight
  Runner.queued = null;
  if (Runner.current) Runner.current.control.stopped = true;
  if (state.onArrive) {
    const f = state.onArrive;
    state.onArrive = null;
    f();
  }
  state.moveTo = null;
  state.spinFx = null;
  state.dipStart = -1e9;

  // factory world
  unlocks = new Set(DEFAULT_UNLOCKS);
  unlockVersions = {};
  refreshSuggestGlobals();
  for (const k of Object.keys(inventory)) inventory[k] = 0;
  renderResources();
  objects.clear();
  recomputeWorldSize(); // defaults own no expansions -> back to 1x1
  resetWorld();
  state.tile = { tx: 0, ty: 0 };
  state.pos = tileWorld(0, 0);
  state.dir = 3; // logical south (screen SE)
  state.hover = HOVER_DISTANCE;
  camera.x = 0;
  camera.y = 0;
  camera.zoom = 1;
  recomputeMultiplier(); // defaults have no speed stages -> back to 1x

  // panels back to factory: spawned ones close, main resets
  for (const p of [...UI.panels]) {
    if (p.isScript && p !== mainPanel) p.close();
  }
  mainPanel.body.value = MAIN_DEFAULT_TEXT;
  mainPanel.body.dispatchEvent(new Event('input'));
  mainPanel.setStatus('READY');
  panelCount = 0;
  if (helpPanelOpen()) {
    helpPanel.close();
    helpPanel = null;
  }

  // the fresh world gets its own slot and becomes the autosave target
  const slot = {
    id: Math.random().toString(36).slice(2, 9),
    name: `WORLD ${saveStore.slots.length + 1}`,
    time: Date.now(),
    data: gatherSave(),
  };
  saveStore.slots.push(slot);
  saveStore.active = slot.id;
  persistStore();
}

document.getElementById('newGameBtn').addEventListener('click', () => showNewGame(true));
document.getElementById('cancelNewGameBtn').addEventListener('click', () => showNewGame(false));
document.getElementById('confirmNewGameBtn').addEventListener('click', () => {
  saveGame(); // preserve the current world in its slot
  newGame();
  showNewGame(false);
  setPaused(false); // drop into the fresh world
});

document.getElementById('savesBtn').addEventListener('click', () => showSaves(true));
closeSavesBtn.addEventListener('click', () => showSaves(false));
newSaveBtn.addEventListener('click', () => {
  saveGame(); // snapshot the current state into the old slot first
  const slot = {
    id: Math.random().toString(36).slice(2, 9),
    name: `SAVE ${saveStore.slots.length + 1}`,
    time: Date.now(),
    data: gatherSave(),
  };
  saveStore.slots.push(slot);
  saveStore.active = slot.id;
  persistStore();
  renderSaveList();
});

// ---------- resize ----------

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  gl.viewport(0, 0, canvas.width, canvas.height);
}
new ResizeObserver(resize).observe(canvas);
resize();

// ---------- drawing helpers ----------

function drawBlob(cx, cy, w, h, color, mode) {
  gl.useProgram(blobProg);
  gl.uniform2f(u.blobRes, canvas.width, canvas.height);
  gl.uniform4f(u.blobSrc, 0, 0, 1, 1); // vUV spans the quad
  gl.uniform4f(u.blobDst, cx - w / 2, cy - h / 2, w, h);
  gl.uniform4fv(u.blobColor, color);
  gl.uniform1i(u.blobMode, mode);
  gl.bindVertexArray(quadVao);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// place the propeller mesh at a screen position: pitch the view so its disc
// matches the art's iso squash, spin it about Y, size it in pixels
const PROP_PITCH = Math.asin(SQUASH);
function drawProp(cxDev, cyDev, radiusDev, spin) {
  const m = rotationY(spin);
  const v = multiply(rotationX(PROP_PITCH), m);
  const mvp = new Float32Array(v);
  const sx = (radiusDev * 2) / canvas.width;
  const sy = (radiusDev * 2) / canvas.height;
  for (let c = 0; c < 4; c++) {
    mvp[c * 4] *= sx;
    mvp[c * 4 + 1] *= sy;
    mvp[c * 4 + 2] *= 0.01;
  }
  mvp[12] = (2 * cxDev) / canvas.width - 1;
  mvp[13] = 1 - (2 * cyDev) / canvas.height;
  mvp[14] = 0;
  gl.useProgram(solidProg);
  gl.uniformMatrix4fv(u.solidMVP, false, mvp);
  gl.uniformMatrix4fv(u.solidModel, false, m);
  gl.bindVertexArray(propVao);
  gl.drawElements(gl.TRIANGLES, prop.idx.length, gl.UNSIGNED_SHORT, 0);
}

// ---------- main loop ----------

gl.disable(gl.DEPTH_TEST);
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
gl.clearColor(0.067, 0.082, 0.055, 1);

let prev = performance.now();
let prevGrow = performance.now();

function frame(now) {
  if (gamePaused) {
    // freeze everything: no updates, no redraw (the last frame stays up,
    // dimmed under the menu overlay)
    prev = now;
    prevGrow = performance.now(); // growth freezes with the pause too
    requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min((now - prev) / 1000, 0.05);
  prev = now;
  // growth clock: unclamped wall-time delta — keeps up with virtual-time
  // jumps in headless tests and catches up after background-tab throttling
  // (plants keep growing while you look away)
  const growDt = performance.now() - prevGrow;
  prevGrow = performance.now();

  // --- update ---
  state.spin += dt * Math.PI * 2 * PROP_REVS;
  state.bobPhase += dt * BOB_RATE;

  // tile-stepped movement (programmatic only): glide to state.moveTo,
  // snap to the tile center on arrival
  if (state.moveTo) {
    const dest = tileWorld(state.moveTo.tx, state.moveTo.ty);
    const dx = dest.x - state.pos.x;
    const dy = dest.y - state.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      // unsquash screen direction into ground-plane direction
      const ang = (Math.atan2(dy / SQUASH, dx) * 180) / Math.PI;
      state.dir = dirFrame(ang);
    }
    const step = MAX_SPEED * actionMultiplier * dt;
    if (step >= dist) {
      state.pos = dest;
      state.tile = state.moveTo;
      state.moveTo = null;
      if (state.onArrive) {
        const done = state.onArrive;
        state.onArrive = null;
        done();
      }
    } else {
      state.pos.x += (dx / dist) * step;
      state.pos.y += (dy / dist) * step;
    }
  }

  const zoom = camera.zoom;
  // grow sprouts: swell 15% over growMs, then switch into the grown plant.
  // dt-driven (not wall-clock) so it pauses with the game and stays in
  // step with the frame loop everywhere — including virtual-time tests
  for (const o of [...objects.all()]) {
    const def = Objects.DEFS[o.type];
    if (!def.growsInto || o.growAge == null) continue;
    o.growAge += growDt;
    const t = o.growAge / def.growMs;
    if (t >= 1) objects.set(o.tx, o.ty, def.growsInto);
    else o.growScale = 1 + Math.max(0, t) * 0.15;
  }

  const bob = Math.sin(state.bobPhase);     // +1 = up
  const bobScale = 1 + BOB_SCALE * bob;     // up = closer = bigger
  const scale = SPRITE_SCALE * bobScale * zoom;
  // hover height eases toward the expected height over the entity below
  // (trees want more clearance than hay or bare ground)
  const under = objects.get(state.tile.tx, state.tile.ty);
  const targetHover = under ? Objects.DEFS[under.type].droneHeight ?? HOVER_DISTANCE : HOVER_DISTANCE;
  state.hover += (targetHover - state.hover) * Math.min(1, dt * 5);

  const ground = worldToScreen(state.pos);  // tile-plane point under the drone
  const dip = ((1 - bob) / 2) * BOB_DIP;    // sinks slightly through the low half
  // harvest gesture: a quick half-sine dip down and back (faster at higher multipliers)
  const dipT = (now - state.dipStart) / (HARVEST_DIP_MS / actionMultiplier);
  const harvestDip = dipT >= 0 && dipT < 1 ? Math.sin(Math.PI * dipT) * HARVEST_DIP_AMP : 0;

  // do_a_spin: orbit the tile (radius eases out and back in so the drone
  // leaves and returns seamlessly) while cycling through all 8 facings
  let orbitX = 0, orbitY = 0;
  if (state.spinFx) {
    const fx = state.spinFx;
    // clamp: rAF timestamps can slightly precede the action's start time
    const t = Math.max(0, (now - fx.start) / fx.dur);
    if (t >= 1) {
      state.dir = fx.baseDir;
      state.spinFx = null;
    } else {
      const env = Math.sin(Math.PI * t);
      const ang = Math.PI * 2 * t;
      orbitX = SPIN_RADIUS * env * Math.sin(ang);
      orbitY = SPIN_RADIUS * SQUASH * env * Math.cos(ang);
      state.dir = (((fx.baseDir + Math.floor(t * 8)) % 8) + 8) % 8;
    }
  }

  const bodyX = ground.x + orbitX * zoom;
  const bodyY = ground.y + (-state.hover - bob * BOB_AMP + dip + harvestDip + orbitY) * zoom;
  updateDroneSound(bodyX, bodyY, zoom);

  // --- draw ---
  const dpr = canvas.width / canvas.clientWidth;
  gl.clear(gl.COLOR_BUFFER_BIT);

  // ground tiles, painter's order (back to front), tinted by light level
  const tiles = [...map.all()].sort((a, b) => a.tx + a.ty - (b.tx + b.ty));
  gl.useProgram(spriteProg);
  gl.uniform2f(u.spriteRes, canvas.width, canvas.height);
  gl.uniform4f(u.spriteSrc, 0, 0, 1, 1);
  gl.bindVertexArray(quadVao);
  const ts = TILE_SCALE * zoom;
  for (const t of tiles) {
    const img = tileTex[t.type];
    if (!img) continue;
    const p = tileScreen(t.tx, t.ty);
    gl.uniform4f(u.spriteDst,
      (p.x - (TILE_W / 2) * ts) * dpr, (p.y - TILE_ANCHOR_Y * ts) * dpr,
      img.w * ts * dpr, img.h * ts * dpr);
    gl.uniform4f(u.spriteTint, t.light, t.light, t.light, 1);
    gl.bindTexture(gl.TEXTURE_2D, img.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // highlight the tile the drone is over: square outline on its top face
  const over = worldToTile(state.pos.x, state.pos.y);
  if (map.get(over.tx, over.ty)) {
    const c = tileScreen(over.tx, over.ty);
    drawBlob(c.x * dpr, c.y * dpr,
      TILE_W * ts * 1.02 * dpr, TILE_TOP * ts * 1.02 * dpr,
      [0.85, 0.85, 0.85, 0.85], 2);
  }

  // --- shadow layer: all shadows draw before any object or the drone ---

  // drone ground shadow: shrinks + fades as the drone bobs up,
  // and tracks the orbit's ground projection during do_a_spin
  const shW = (96 - 10 * bob) * zoom * dpr;
  const shA = 0.34 - 0.10 * bob;
  drawBlob((ground.x + orbitX * zoom) * dpr, (ground.y + orbitY * zoom) * dpr,
    shW, shW * SQUASH, [0, 0, 0, shA], 0);

  // world objects (hay etc.), painter's order, lit by their tile
  const objs = [...objects.all()].sort((a, b) => a.tx + a.ty - (b.tx + b.ty));

  gl.useProgram(spriteProg);
  gl.uniform4f(u.spriteSrc, 0, 0, 1, 1);
  gl.bindVertexArray(quadVao);

  // object cast shadows: each object's silhouette flattened onto the ground,
  // running SE -> NW (sun in the SE), base pinned to the object's base
  const os = OBJECT_SCALE * zoom;
  for (const o of objs) {
    const img = objTex[o.type];
    if (!img) continue;
    const gs = os * (o.growScale || 1); // sprouts swell while growing
    const p = tileScreen(o.tx, o.ty);
    const yOff = Objects.DEFS[o.type].yOffset || 0;
    const baseY = p.y + (OBJECT_FOOT - yOff) * gs;  // object sprite's bottom edge
    const L = img.h * gs * 1.0;                     // shadow length along the ground
    const hS = L * 0.447;                           // vertical screen extent (2:1 iso NW)
    gl.uniform2f(u.spriteShear, -L * 0.894 * dpr, 0);
    gl.uniform4f(u.spriteDst,
      (p.x - (img.w / 2) * gs) * dpr, (baseY - hS) * dpr,
      img.w * gs * dpr, hS * dpr);
    gl.uniform4f(u.spriteTint, 0, 0, 0, 0.35);
    gl.bindTexture(gl.TEXTURE_2D, img.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  gl.uniform2f(u.spriteShear, 0, 0);

  for (const o of objs) {
    const img = objTex[o.type];
    if (!img) continue;
    const gs = os * (o.growScale || 1);
    const p = tileScreen(o.tx, o.ty);
    const tile = map.get(o.tx, o.ty);
    const light = tile ? tile.light : 1;
    const yOff = Objects.DEFS[o.type].yOffset || 0; // +up, negative = down
    gl.uniform4f(u.spriteDst,
      (p.x - (img.w / 2) * gs) * dpr,
      (p.y - (img.h - OBJECT_FOOT + yOff) * gs) * dpr,
      img.w * gs * dpr, img.h * gs * dpr);
    gl.uniform4f(u.spriteTint, light, light, light, 1);
    gl.bindTexture(gl.TEXTURE_2D, img.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // --- drone, always on top ---
  if (sheet) {
    const f = sheet.frames[state.dir];

    // body sprite, anchored at its pivot
    gl.useProgram(spriteProg);
    gl.uniform2f(u.spriteRes, canvas.width, canvas.height);
    gl.uniform4f(u.spriteTint, 1, 1, 1, 1);
    gl.uniform4f(u.spriteDst,
      (bodyX - f.px * scale) * dpr, (bodyY - f.py * scale) * dpr,
      f.w * scale * dpr, f.h * scale * dpr);
    // half-texel UV inset: edge samples stay inside the frame rect
    gl.uniform4f(u.spriteSrc,
      (f.x + 0.5) / sheet.w, (f.y + 0.5) / sheet.h,
      (f.x + f.w - 0.5) / sheet.w, (f.y + f.h - 0.5) / sheet.h);
    gl.bindTexture(gl.TEXTURE_2D, sheet.tex);
    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // propellers on the atlas-detected rotor pods (relative to the pivot)
    (f.pods || []).forEach((pod, i) => {
      drawProp(
        (bodyX + pod.x * scale) * dpr,
        (bodyY + (pod.y * scale) - PROP_LIFT * zoom) * dpr,
        PROP_RADIUS * PROP_SCALE * bobScale * zoom * dpr, // props track zoom, not drone scale
        state.spin * (i % 2 ? -1 : 1),                    // adjacent rotors counter-rotate
      );
    });
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
