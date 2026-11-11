// Shared by validate-matrix.mjs and tune-lift.mjs: look statistics of one frame.
export function features(d, w, h) {
  const hist = new Uint32Array(256);
  const g = new Float64Array(24);
  const gn = new Float64Array(24);
  let n = 0; let sum = 0; let dark = 0; let bright = 0; let sat = 0;
  for (let y = 70; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const k = (y * w + x) * 3;
      const l = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
      hist[Math.round(l)] += 1; sum += l; n += 1;
      if (l < 16) dark += 1;
      if (l > 120) bright += 1;
      sat += Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]);
      const c = Math.floor((y / h) * 4) * 6 + Math.floor((x / w) * 6);
      g[c] += l; gn[c] += 1;
    }
  }
  const pct = (p) => { let c = 0; for (let i = 0; i < 256; i += 1) { c += hist[i]; if (c >= n * p) return i; } return 255; };
  const grid = Array.from(g, (v, i) => v / gn[i]);
  const top = (grid[0] + grid[1] + grid[2] + grid[3] + grid[4] + grid[5]) / 6;
  const bot = (grid[18] + grid[19] + grid[20] + grid[21] + grid[22] + grid[23]) / 6;
  return { L: sum / n, p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), dark: dark / n, bright: bright / n, topbot: top / Math.max(bot, 1), sat: sat / n };
}
