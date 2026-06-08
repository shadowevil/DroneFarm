// Atlas — builds sprite atlases from sheet images at load time.
//
// Scans the alpha channel for connected sprite islands, so sheets don't need
// perfectly aligned grids (the drone sheet drifts up to 19px off its cells).
// Each frame gets an alpha-weighted centroid pivot, so sprites stay anchored
// when switching directions even if the art wobbles between frames.
//
// Falls back to uniform grid cells when pixel access is blocked (file://).

const Atlas = (() => {
  const ALPHA_MIN = 8; // ignore near-transparent halo pixels

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Atlas: failed to load ${src}`));
      img.src = src;
    });
  }

  function uniform(w, h, cols, rows) {
    const fw = w / cols, fh = h / rows;
    const frames = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        frames.push({ x: c * fw, y: r * fh, w: fw, h: fh, px: fw / 2, py: fh / 2 });
      }
    }
    return frames;
  }

  // Find arm-tip mount points: the N strongest radial maxima of the alpha
  // silhouette around the pivot, pulled inward by `inset` px to land on the
  // pod center. Returns [{x, y}] relative to the pivot, in angular order.
  function detectPods(rgba, sheetW, f, count, inset) {
    const BINS = 72;
    const rMax = new Float32Array(BINS);
    for (let y = f.y; y < f.y + f.h; y++) {
      for (let x = f.x; x < f.x + f.w; x++) {
        if (rgba[(y * sheetW + x) * 4 + 3] <= 60) continue;
        const dx = x - (f.x + f.px), dy = y - (f.y + f.py);
        const d = Math.hypot(dx, dy);
        const bin = ((Math.round((Math.atan2(dy, dx) / (2 * Math.PI)) * BINS) % BINS) + BINS) % BINS;
        if (d > rMax[bin]) rMax[bin] = d;
      }
    }
    // circular smoothing
    const sm = new Float32Array(BINS);
    for (let i = 0; i < BINS; i++) {
      let s = 0, wsum = 0;
      for (let k = -2; k <= 2; k++) {
        const wgt = 3 - Math.abs(k);
        s += rMax[(i + k + BINS) % BINS] * wgt;
        wsum += wgt;
      }
      sm[i] = s / wsum;
    }
    // local maxima, best `count` with >=45 deg separation
    const peaks = [];
    for (let i = 0; i < BINS; i++) {
      const a = sm[(i - 1 + BINS) % BINS], b = sm[i], c = sm[(i + 1) % BINS];
      if (b >= a && b > c) peaks.push({ bin: i, a, b, c });
    }
    peaks.sort((p, q) => q.b - p.b);
    const minSep = BINS / 8;
    const chosen = [];
    for (const p of peaks) {
      if (chosen.length === count) break;
      const clear = chosen.every((o) => {
        const d = Math.abs(o.bin - p.bin);
        return Math.min(d, BINS - d) >= minSep;
      });
      if (clear) chosen.push(p);
    }
    chosen.sort((p, q) => p.bin - q.bin);
    return chosen.map((p) => {
      // parabolic sub-bin refinement of the peak angle
      const denom = p.a - 2 * p.b + p.c;
      const off = denom ? (0.5 * (p.a - p.c)) / denom : 0;
      const ang = ((p.bin + off) / BINS) * Math.PI * 2;
      const r = p.b - inset;
      return { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
    });
  }

  // Returns frames in row-major grid order:
  // { x, y, w, h, px, py, pods? } — px/py is the pivot relative to the frame
  // corner. opts.pods = N detects N rotor mount points per frame.
  // opts.pad (default 1) expands each frame into the transparent gutter
  // around it, so edge sampling can't bleed neighboring sprites in.
  function build(img, cols, rows, opts = {}) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    let rgba;
    try {
      rgba = ctx.getImageData(0, 0, w, h).data;
    } catch {
      console.warn('Atlas: pixel access blocked (file://?) — using uniform grid');
      return uniform(w, h, cols, rows);
    }

    // flood-fill connected sprite islands (8-way adjacency)
    const label = new Int32Array(w * h);
    const queue = new Int32Array(w * h);
    const blobs = [];
    for (let start = 0; start < w * h; start++) {
      if (label[start] || rgba[start * 4 + 3] <= ALPHA_MIN) continue;
      const id = blobs.length + 1;
      const b = { x0: w, y0: h, x1: 0, y1: 0, mass: 0, mx: 0, my: 0 };
      label[start] = id;
      queue[0] = start;
      let head = 0, tail = 1;
      while (head < tail) {
        const p = queue[head++];
        const x = p % w, y = (p / w) | 0;
        const a = rgba[p * 4 + 3];
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y;
        if (y > b.y1) b.y1 = y;
        b.mass += a;
        b.mx += x * a;
        b.my += y * a;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const n = ny * w + nx;
            if (!label[n] && rgba[n * 4 + 3] > ALPHA_MIN) {
              label[n] = id;
              queue[tail++] = n;
            }
          }
        }
      }
      blobs.push(b);
    }

    // drop debris, keep the heaviest cols*rows islands
    const want = cols * rows;
    if (blobs.length !== want) {
      console.warn(`Atlas: found ${blobs.length} islands, expected ${want} — keeping the largest`);
    }
    const main = blobs.sort((a, b) => b.mass - a.mass).slice(0, want);

    // sort into row-major grid order by centroid
    main.sort((a, b) => a.my / a.mass - b.my / b.mass);
    const frames = [];
    for (let r = 0; r < rows; r++) {
      const row = main
        .slice(r * cols, (r + 1) * cols)
        .sort((a, b) => a.mx / a.mass - b.mx / b.mass);
      for (const b of row) {
        // separate islands are >=2px apart, so a 1px pad ring is transparent
        const pad = opts.pad ?? 1;
        const x0 = Math.max(0, b.x0 - pad);
        const y0 = Math.max(0, b.y0 - pad);
        const x1 = Math.min(w - 1, b.x1 + pad);
        const y1 = Math.min(h - 1, b.y1 + pad);
        frames.push({
          x: x0,
          y: y0,
          w: x1 - x0 + 1,
          h: y1 - y0 + 1,
          px: b.mx / b.mass - x0, // alpha-weighted centroid pivot
          py: b.my / b.mass - y0,
        });
      }
    }
    if (opts.pods) {
      for (const f of frames) {
        f.pods = detectPods(rgba, w, f, opts.pods, opts.podInset ?? 10);
      }
    }
    return frames;
  }

  return { loadImage, build };
})();
