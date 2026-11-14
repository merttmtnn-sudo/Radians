// Small dependency-free canvas chart: scatter with error bars, lines, vertical markers, hover.
export class Plot {
  constructor(canvas, tip) {
    this.cv = canvas; this.tip = tip;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.data = null;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('mousemove', e => this.hover(e));
    canvas.addEventListener('mouseleave', () => { this.hot = null; this.tip?.classList.add('hidden'); this.draw(); });
  }
  set(d) { this.data = d; this.draw(); }

  static ticks(a, b, log, n = 6) {
    if (log) {
      const out = [];
      for (let e = Math.floor(Math.log10(a)); e <= Math.ceil(Math.log10(b)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= a && v <= b) out.push(v); }
      return out;
    }
    const span = b - a || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-6; v += step) out.push(+v.toPrecision(10));
    return out;
  }
  static fmt(v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
    return +v.toPrecision(4) + '';
  }

  draw() {
    const cv = this.cv, d = this.data;
    const r = cv.getBoundingClientRect();
    const W = Math.max(50, Math.round(r.width * this.dpr)), H = Math.max(50, Math.round(r.height * this.dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const s = this.dpr;
    ctx.font = `${11 * s}px Segoe UI, system-ui, sans-serif`;
    if (!d || !d.series.some(se => se.points.length)) {
      ctx.fillStyle = '#6f7ea8'; ctx.textAlign = 'center';
      ctx.fillText(d?.empty || 'No data yet', W / 2, H / 2);
      return;
    }
    const pad = { l: 64 * s, r: 16 * s, t: 14 * s, b: 34 * s };
    const all = d.series.flatMap(se => se.points);
    const xs = all.map(p => p.x).filter(isFinite), ys = all.flatMap(p => [p.y - (p.e || 0), p.y + (p.e || 0)]).filter(v => isFinite(v) && (!d.logY || v > 0));
    let [x0, x1] = d.xRange || [Math.min(...xs), Math.max(...xs)];
    if (x0 === x1) { x0 -= 1; x1 += 1; }
    const xp = (x1 - x0) * 0.03; x0 -= xp; x1 += xp;
    // robust y range
    const ysorted = ys.slice().sort((a, b) => a - b);
    let y0 = ysorted[Math.floor(ysorted.length * 0.005)], y1 = ysorted[Math.ceil(ysorted.length * 0.995) - 1];
    if (d.yRange) [y0, y1] = d.yRange;
    if (!isFinite(y0) || !isFinite(y1)) { y0 = 0; y1 = 1; }
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    if (d.logY) { y0 = Math.max(y0, y1 / 1e5); const f = Math.pow(y1 / y0, 0.06); y0 /= f; y1 *= f; }
    else { const yp = (y1 - y0) * 0.08; y0 -= yp; y1 += yp; }
    if (d.invertY) [y0, y1] = [y1, y0];
    const X = x => pad.l + (x - x0) / (x1 - x0) * (W - pad.l - pad.r);
    const Y = d.logY ? (y => pad.t + (1 - (Math.log10(y) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0))) * (H - pad.t - pad.b))
      : (y => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b));
    this.map = { X, Y, pad, W, H };
    // grid & axes
    ctx.strokeStyle = '#1b2748'; ctx.lineWidth = 1; ctx.fillStyle = '#8796bd';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of (d.xTicks ? d.xTicks(x0, x1) : Plot.ticks(x0, x1, false))) {
      const x = X(t); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
      ctx.fillText(d.xFmt ? d.xFmt(t) : Plot.fmt(t), x, H - pad.b + 5 * s);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    for (const t of Plot.ticks(ya, yb, d.logY)) {
      const y = Y(t); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillText(Plot.fmt(t), pad.l - 6 * s, y);
    }
    ctx.strokeStyle = '#3a4d80'; ctx.strokeRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b);
    ctx.fillStyle = '#aebde6'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(d.xLabel || '', pad.l + (W - pad.l - pad.r) / 2, H - 2 * s);
    ctx.save(); ctx.translate(13 * s, pad.t + (H - pad.t - pad.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(d.yLabel || '', 0, 0); ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b); ctx.clip();
    // vertical markers
    for (const m of d.markers || []) {
      const x = X(m.x); if (x < pad.l || x > W - pad.r) continue;
      ctx.strokeStyle = m.color || 'rgba(255,255,255,0.25)'; ctx.setLineDash([4 * s, 4 * s]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.save(); ctx.translate(x + 3 * s, pad.t + 4 * s); ctx.rotate(Math.PI / 2); ctx.fillStyle = m.color || '#aaa'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(m.label, 0, 0); ctx.restore();
    }
    // series
    this.pts = [];
    for (const se of d.series) {
      if (se.line) {
        ctx.strokeStyle = se.color; ctx.lineWidth = (se.width || 1.6) * s; ctx.beginPath();
        let pen = false;
        for (const p of se.points) {
          if (!isFinite(p.y) || (d.logY && p.y <= 0)) { pen = false; continue; }
          const x = X(p.x), y = Y(p.y);
          pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
        }
        ctx.stroke();
      }
      if (se.dots === false) continue;
      for (const p of se.points) {
        if (!isFinite(p.y) || (d.logY && p.y <= 0)) continue;
        const x = X(p.x), y = Y(p.y), c = p.color || se.color;
        if (p.e && isFinite(p.e)) {
          const ya2 = d.logY ? Math.max(p.y - p.e, y0 * 1.0001) : p.y - p.e;
          ctx.strokeStyle = c; ctx.globalAlpha = 0.55; ctx.lineWidth = 1 * s;
          ctx.beginPath(); ctx.moveTo(x, Y(ya2)); ctx.lineTo(x, Y(p.y + p.e)); ctx.stroke(); ctx.globalAlpha = 1;
        }
        const rr = (se.size || 2.6) * s;
        ctx.fillStyle = c;
        ctx.beginPath();
        if (se.shape === 'square') ctx.rect(x - rr, y - rr, 2 * rr, 2 * rr);
        else if (se.shape === 'diamond') { ctx.moveTo(x, y - rr * 1.4); ctx.lineTo(x + rr * 1.4, y); ctx.lineTo(x, y + rr * 1.4); ctx.lineTo(x - rr * 1.4, y); }
        else ctx.arc(x, y, rr, 0, Math.PI * 2);
        if (p.hollow) { ctx.strokeStyle = c; ctx.lineWidth = 1.2 * s; ctx.stroke(); } else ctx.fill();
        if (se.outline) { ctx.strokeStyle = '#000'; ctx.lineWidth = 1 * s; ctx.stroke(); }
        this.pts.push({ x, y, p, se });
      }
    }
    if (this.hot) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * s; ctx.beginPath(); ctx.arc(this.hot.x, this.hot.y, 6 * s, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
    // legend
    const leg = d.legend || [];
    let lx = W - pad.r - 8 * s, ly = pad.t + 8 * s;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const l of leg) {
      ctx.fillStyle = '#dbe5ff'; ctx.fillText(l.label, lx - 14 * s, ly);
      ctx.fillStyle = l.color; ctx.beginPath(); ctx.arc(lx - 5 * s, ly, 4 * s, 0, Math.PI * 2); ctx.fill();
      ly += 15 * s;
    }
  }
  hover(e) {
    if (!this.pts?.length) return;
    const s = this.dpr, mx = e.offsetX * s, my = e.offsetY * s;
    let best = null, bd = 12 * s;
    for (const q of this.pts) { const dd = Math.hypot(q.x - mx, q.y - my); if (dd < bd) { bd = dd; best = q; } }
    if (best !== this.hot) { this.hot = best; this.draw(); }
    if (this.tip) {
      if (best && best.p.tip) {
        this.tip.innerHTML = best.p.tip;
        this.tip.classList.remove('hidden');
        const pr = this.cv.getBoundingClientRect(), par = this.tip.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
        let left = pr.left - par.left + e.offsetX + 14, top = pr.top - par.top + e.offsetY + 10;
        if (left + 260 > par.width) left -= 280;
        this.tip.style.left = left + 'px'; this.tip.style.top = top + 'px';
      } else this.tip.classList.add('hidden');
    }
  }
  png() { return this.cv.toDataURL('image/png'); }
}
