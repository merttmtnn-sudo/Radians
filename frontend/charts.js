// Small dependency-free SVG scatter chart with error bars, hover tooltip and legend.
// Colours: validated categorical palette (dark steps, checked against the panel surface #121829).

const NS = 'http://www.w3.org/2000/svg';
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c'];

function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

export function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  let step = 10 ** Math.floor(Math.log10(raw));
  const err = raw / step;
  if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function extent(vals, pad) {
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

/**
 * opts: { series: [{name, color, points: [{x, y, err, hollow, tip}]}], xLabel, yLabel,
 *         xFmt, yFmt, height, empty }
 */
export function scatterChart(host, opts) {
  host.replaceChildren();
  host.classList.add('chart');
  const series = opts.series.filter(s => s.points.length);
  // legend (always for >= 2 series; identity never by colour alone: names are written out)
  if (series.length >= 2) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    for (const s of series) {
      const it = document.createElement('span');
      const sw = document.createElement('i');
      sw.style.background = s.color;
      it.append(sw, document.createTextNode(`${s.name} (${s.points.length})`));
      lg.append(it);
    }
    host.append(lg);
  }
  const pts = series.flatMap(s => s.points.map(p => ({ ...p, color: s.color, series: s.name })))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) {
    const e = document.createElement('p');
    e.className = 'muted small';
    e.textContent = opts.empty || 'No data';
    host.append(e);
    return;
  }
  const W = Math.max(280, host.clientWidth || 600), H = opts.height || 260;
  const m = { l: 68, r: 14, t: 10, b: 42 };
  const xs = extent(pts.map(p => p.x), 0.03);
  // y range from the values (robust to a few wild error bars)
  const ys = extent(pts.map(p => p.y), 0.08);
  const X = v => m.l + (v - xs[0]) / (xs[1] - xs[0]) * (W - m.l - m.r);
  const Y = v => H - m.b - (v - ys[0]) / (ys[1] - ys[0]) * (H - m.t - m.b);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': opts.yLabel + ' vs ' + opts.xLabel });
  host.append(root);
  const g = svg('g', { class: 'axes' }, root);
  for (const v of niceTicks(ys[0], ys[1], 5)) {
    svg('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }, g);
    svg('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, g).textContent = (opts.yFmt || String)(v);
  }
  for (const v of (opts.xTicks ? opts.xTicks(xs[0], xs[1]) : niceTicks(xs[0], xs[1], Math.max(3, Math.floor(W / 110))))) {
    svg('line', { x1: X(v), x2: X(v), y1: H - m.b, y2: H - m.b + 4, class: 'axis' }, g);
    svg('text', { x: X(v), y: H - m.b + 17, 'text-anchor': 'middle', class: 'tick' }, g).textContent = (opts.xFmt || String)(v);
  }
  svg('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'axis' }, g);
  svg('text', { x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle', class: 'label' }, g).textContent = opts.xLabel;
  svg('text', { x: 14, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', class: 'label', transform: `rotate(-90 14 ${(m.t + H - m.b) / 2})` }, g).textContent = opts.yLabel;
  if (opts.refLine !== undefined && opts.refLine > ys[0] && opts.refLine < ys[1]) {
    svg('line', { x1: m.l, x2: W - m.r, y1: Y(opts.refLine), y2: Y(opts.refLine), class: 'ref' }, g);
  }

  const marks = svg('g', {}, root);
  for (const p of pts) {
    p.cx = X(p.x); p.cy = Y(p.y);
    if (Number.isFinite(p.err) && p.err > 0) {
      const a = Math.max(m.t, Y(p.y + p.err)), b = Math.min(H - m.b, Y(p.y - p.err));
      svg('line', { x1: p.cx, x2: p.cx, y1: a, y2: b, stroke: p.color, 'stroke-opacity': 0.55, 'stroke-width': 1 }, marks);
    }
  }
  for (const p of pts) {
    svg('circle', {
      cx: p.cx, cy: p.cy, r: 4, fill: p.hollow ? 'var(--panel)' : p.color, stroke: p.hollow ? p.color : 'var(--panel)',
      'stroke-width': p.hollow ? 1.5 : 2,
    }, marks);
  }

  // hover: nearest point within reach (target bigger than the mark)
  const tip = document.createElement('div');
  tip.className = 'charttip';
  tip.hidden = true;
  host.append(tip);
  const ring = svg('circle', { r: 7, fill: 'none', stroke: 'var(--text)', 'stroke-width': 1.5, visibility: 'hidden' }, root);
  const hit = svg('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }, root);
  hit.addEventListener('mousemove', (e) => {
    const r = root.getBoundingClientRect();
    const sx = (e.clientX - r.left) * W / r.width, sy = (e.clientY - r.top) * H / r.height;
    let best = null, bd = 18 * 18;
    for (const p of pts) { const d = (p.cx - sx) ** 2 + (p.cy - sy) ** 2; if (d < bd) { bd = d; best = p; } }
    if (!best) { tip.hidden = true; ring.setAttribute('visibility', 'hidden'); return; }
    ring.setAttribute('cx', best.cx); ring.setAttribute('cy', best.cy); ring.setAttribute('visibility', 'visible');
    tip.replaceChildren(...[best.series, ...(best.tip || [])].map((l, i) => {
      const d = document.createElement('div');
      if (i === 0) { const sw = document.createElement('i'); sw.style.background = best.color; d.append(sw); }
      d.append(document.createTextNode(l));
      return d;
    }));
    tip.hidden = false;
    const left = best.cx / W * r.width, top = best.cy / H * r.height;
    tip.style.left = `${Math.min(r.width - 190, Math.max(0, left + 12))}px`;
    tip.style.top = `${Math.max(0, top - 10) + (host.querySelector('.legend')?.offsetHeight || 0)}px`;
  });
  hit.addEventListener('mouseleave', () => { tip.hidden = true; ring.setAttribute('visibility', 'hidden'); });
}

/** Plain table view of the same series (accessibility / copy-paste). */
export function chartTable(host, cols, rows) {
  const t = document.createElement('table');
  t.className = 'datatable';
  const tr = t.createTHead().insertRow();
  for (const c of cols) { const th = document.createElement('th'); th.textContent = c; tr.append(th); }
  const tb = t.createTBody();
  for (const r of rows) { const row = tb.insertRow(); for (const v of r) row.insertCell().textContent = v; }
  host.replaceChildren(t);
}
