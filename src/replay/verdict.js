// 最终裁决：真实指数（身份已确认）+ 资产配置对比 + 可视化
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'data', 'replay');
const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'indices-raw.json'), 'utf8'));

const NAME = {
  sh000001: '上证指数', sh000300: '沪深300（大盘）', sh000905: '中证500（中盘）',
  sh000852: '中证1000（小盘）', sz399303: '国证2000（小盘）', sh000847: '中证医药（行业）',
};
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
const COST = 0.0015;

/** 固定权重组合，年度再平衡，支持现金部分
 *  权重按字面解释（不必和为 1，剩余即现金；和 >1 时按比例缩放）
 */
function portfolio(weights, from, to, { capital = 100000 } = {}) {
  const syms = Object.keys(weights).filter((s) => raw[s]);
  const dates = raw[syms[0]].bars.filter((b) => b.date >= from && b.date <= to).map((b) => b.date);
  const px = {};
  for (const s of syms) px[s] = new Map(raw[s].bars.filter((b) => b.date >= from && b.date <= to).map((b) => [b.date, b.close]));

  const sum = syms.reduce((a, s) => a + weights[s], 0);
  const scale = sum > 1 ? sum : 1;                 // 超过 1 就等比缩放
  const w = Object.fromEntries(syms.map((s) => [s, weights[s] / scale]));
  const cashW = Math.max(0, 1 - syms.reduce((a, s) => a + w[s], 0));

  const getPx = (s, d) => {
    const m = px[s];
    let p = m.get(d);
    if (p === undefined) { for (const [k, vv] of m) { if (k <= d) p = vv; else break; } }
    return p;
  };

  const units = {};
  for (const s of syms) units[s] = (capital * w[s] * (1 - COST)) / getPx(s, dates[0]);
  let cash = capital * cashW;

  const valAt = (d) => {
    let v = cash;
    for (const s of syms) { const p = getPx(s, d); if (p) v += units[s] * p; }
    return v;
  };

  let nextIdx = 242, rebalances = 0;
  let peak = -Infinity, mdd = 0;
  const curve = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const v = valAt(d);
    peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1);
    curve.push({ date: d, value: +v.toFixed(2) });
    if (i >= nextIdx && i < dates.length - 1) {
      // 再平衡到目标权重：先算总资产，扣一次单边成本，再重建仓位与现金
      const total = valAt(d) * (1 - COST);
      for (const s of syms) {
        const p = getPx(s, d);
        if (p) units[s] = (total * w[s]) / p;
      }
      cash = total * cashW;   // 关键：现金必须一起复位，否则会凭空造出资产
      rebalances++;
      nextIdx += 242;
    }
  }
  const final = valAt(dates.at(-1));
  const years = dates.length / 242;
  return { final, ret: final / capital - 1, cagr: Math.pow(final / capital, 1 / years) - 1, mdd, years, rebalances, curve, dates };
}

const PLANS = [
  ['纯现金', {}],
  ['100% 上证指数', { sh000001: 1 }],
  ['100% 沪深300', { sh000300: 1 }],
  ['100% 中证1000（小盘）', { sh000852: 1 }],
  ['100% 国证2000（小盘）', { sz399303: 1 }],
  ['100% 中证医药（行业）', { sh000847: 1 }],
  ['50% 沪深300 + 50% 中证医药', { sh000300: 0.5, sh000847: 0.5 }],
  ['40% 沪深300 + 30% 国证2000 + 30% 现金', { sh000300: 0.4, sz399303: 0.3 }],
  ['等权 5 个指数', { sh000300: 0.2, sh000905: 0.2, sh000852: 0.2, sz399303: 0.2, sh000847: 0.2 }],
  ['20% 各指数 + 20% 现金（分散+缓冲）', { sh000300: 0.2, sh000905: 0.2, sh000852: 0.2, sz399303: 0.2 }],
];

const WINDOWS = [
  ['2018-07-17', '2026-10-16', '8.3 年（最长）'],
  ['2021-01-04', '2026-10-16', '5.8 年'],
  ['2023-01-03', '2026-10-16', '3.8 年'],
];

const all = {};
for (const [f, t, label] of WINDOWS) {
  console.log(`\n████ ${label}  ${f} ~ ${t}`);
  console.log(`  ${'配置（年度再平衡）'.padEnd(42)} ${'期末'.padStart(9)} ${'总收益'.padStart(10)} ${'年化'.padStart(9)} ${'回撤'.padStart(9)}`);
  const rows = [];
  for (const [name, w] of PLANS) {
    const r = Object.keys(w).length ? portfolio(w, f, t) : {
      final: 100000, ret: 0, cagr: 0, mdd: 0,
      curve: raw.sh000001.bars.filter((b) => b.date >= f && b.date <= t).map((b) => ({ date: b.date, value: 100000 })),
      dates: [],
    };
    rows.push({ name, ...r });
    console.log(`  ${name.padEnd(40)} ${(r.final / 10000).toFixed(2).padStart(7)}万 ${pct(r.ret).padStart(10)} ${pct(r.cagr).padStart(9)} ${pct(r.mdd).padStart(9)}`);
  }
  all[label] = rows;
}
fs.writeFileSync(path.join(OUT, 'allocation-final.json'), JSON.stringify(all, null, 2));

// ---------- 可视化 ----------
const W = '8.3 年（最长）';
const rows = all[W];
const w = 1120, h = 420, P = 46;
const allVals = rows.flatMap((r) => r.curve.map((c) => c.value));
const lo = Math.min(...allVals) * 0.96, hi = Math.max(...allVals) * 1.04;
const dates = rows.find((r) => r.curve.length > 100).curve.map((c) => c.date);
const X = (i) => P + ((w - P - 30) * i) / (dates.length - 1);
const Y = (v) => h - 40 - ((h - 70) * (v - lo)) / (hi - lo);
const COLORS = ['#5a6b80', '#3d8bfd', '#12b886', '#f0a020', '#ff4d4f', '#a78bfa', '#f472b6', '#22d3ee', '#84cc16', '#eab308'];
const paths = rows.map((r, k) => {
  const step = Math.max(1, Math.floor(r.curve.length / 400));
  const pts = r.curve.filter((_, i) => i % step === 0);
  return { d: pts.map((c, i) => `${i ? 'L' : 'M'}${X(i * step).toFixed(1)},${Y(c.value).toFixed(1)}`).join(' '), color: COLORS[k % COLORS.length], name: r.name, final: r.final };
});

const chart = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
  <rect width="${w}" height="${h}" fill="#0c121b" rx="10"/>
  ${[lo, (lo + hi) / 2, hi].map((v) => `<line x1="${P}" y1="${Y(v).toFixed(1)}" x2="${w - 30}" y2="${Y(v).toFixed(1)}" stroke="#243044" stroke-dasharray="4 4"/><text x="4" y="${(Y(v) + 4).toFixed(1)}" fill="#8296ab" font-size="10">${(v / 10000).toFixed(1)}万</text>`).join('')}
  <line x1="${P}" y1="${Y(100000).toFixed(1)}" x2="${w - 30}" y2="${Y(100000).toFixed(1)}" stroke="#4a5a6e" stroke-width="1"/>
  ${paths.map((p) => `<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="1.9"/>`).join('')}
  ${[0, Math.floor(dates.length / 2), dates.length - 1].map((i) => `<text x="${X(i).toFixed(1)}" y="${h - 12}" fill="#8296ab" font-size="10" text-anchor="middle">${dates[Math.min(i, dates.length - 1)]}</text>`).join('')}
  <text x="${w - 30}" y="20" text-anchor="end" fill="#8296ab" font-size="11">10 万元本金 · 8.3 年 · 年度再平衡 · 含 0.15% 单边成本</text>
</svg>`;

const legend = paths.map((p) => `<div style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 0">
  <span style="display:inline-block;width:14px;height:3px;background:${p.color}"></span>
  <span style="flex:1">${p.name}</span>
  <span style="color:#8296ab;font-variant-numeric:tabular-nums">${(p.final / 10000).toFixed(2)} 万</span></div>`).join('');

const fmtRow = (r, best) => `<tr${best ? ' style="background:#16202e"' : ''}>
  <td>${r.name}</td>
  <td style="text-align:right">${(r.final / 10000).toFixed(2)} 万</td>
  <td style="text-align:right;color:${r.ret >= 0 ? '#ff4d4f' : '#12b886'}">${pct(r.ret)}</td>
  <td style="text-align:right">${pct(r.cagr)}</td>
  <td style="text-align:right;color:#12b886">${pct(r.mdd)}</td>
</tr>`;

const tables = WINDOWS.map(([f, t, label]) => {
  const rr = all[label];
  const best = rr.reduce((a, b) => (b.final > a.final ? b : a));
  return `<h2>${label}　${f} ~ ${t}</h2><table>
    <thead><tr><th>配置（年度再平衡）</th><th style="text-align:right">期末</th><th style="text-align:right">总收益</th><th style="text-align:right">年化</th><th style="text-align:right">最大回撤</th></tr></thead>
    <tbody>${rr.map((r) => fmtRow(r, r.name === best.name)).join('')}</tbody></table>`;
}).join('');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>最终裁决：真实指数 vs 我的受污染数据</title>
<style>
:root{--bg:#0a0e14;--panel:#111823;--line:#22303f;--txt:#e6edf5;--dim:#8296ab;--up:#ff4d4f;--down:#12b886;--accent:#3d8bfd;--warn:#f0a020}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.65 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:21px;margin:0 0 6px}h2{font-size:14.5px;margin:26px 0 8px;padding-left:9px;border-left:3px solid var(--accent);color:var(--dim)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:4px}
th{text-align:left;color:var(--dim);font-weight:500;font-size:12px;padding:7px 10px;border-bottom:1px solid var(--line)}
td{padding:7px 10px;border-bottom:1px solid #1a2431;font-variant-numeric:tabular-nums}
.sub{color:var(--dim);font-size:12.5px;line-height:1.75}
.warn{color:var(--warn)}.bad{color:#ff6b6b}.good{color:#12b886}
.big{font:600 24px/1.15 ui-monospace,Consolas,monospace}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.cell{background:#0d131c;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.lbl{font-size:11.5px;color:var(--dim);margin-bottom:6px}
</style></head><body><div class="wrap">
<h1>最终裁决：真实指数 vs 我的受污染数据</h1>
<div class="sub">数据源：新浪指数日K（2000 根，2018-07-17 ~ 2026-10-16）· <b>无幸存者偏差、无流动性偏差</b> · 指数身份已用行情接口逐一确认</div>

<h2>先看打脸的部分</h2>
<div class="card"><div class="kv">
  <div class="cell"><div class="lbl">我上一轮（受污染个股池）</div><div class="big bad">小盘 3.8 年 +436%</div><div class="sub">年化 ~67%</div></div>
  <div class="cell"><div class="lbl">真实指数（国证2000）</div><div class="big">3.8 年 +12.00%</div><div class="sub">年化 +3.04%</div></div>
  <div class="cell"><div class="lbl">放大倍数</div><div class="big warn">≈ 36 倍</div><div class="sub">全是幸存者偏差</div></div>
  <div class="cell"><div class="lbl">另一个坑</div><div class="big warn">sh000847 ≠ 小市值</div><div class="sub">实际是「中证医药」行业指数，我差点把它当成微盘股证据</div></div>
</div></div>

<h2>真实指数的市值风格（8.3 年）</h2>
<div class="card"><table>
<thead><tr><th>指数</th><th style="text-align:right">总收益</th><th style="text-align:right">年化</th><th style="text-align:right">最大回撤</th><th>结论</th></tr></thead>
<tbody>
  <tr><td>上证指数</td><td style="text-align:right">+32.81%</td><td style="text-align:right">+3.49%</td><td style="text-align:right;color:#12b886">-27.27%</td><td class="sub">回撤最小</td></tr>
  <tr><td>沪深300（大盘）</td><td style="text-align:right">+20.91%</td><td style="text-align:right">+2.32%</td><td style="text-align:right;color:#12b886">-45.60%</td><td class="sub">最好的公司，最差的指数</td></tr>
  <tr><td>中证500（中盘）</td><td style="text-align:right">+30.34%</td><td style="text-align:right">+3.26%</td><td style="text-align:right;color:#12b886">-41.81%</td><td class="sub">平庸</td></tr>
  <tr><td>中证1000（小盘）</td><td style="text-align:right">+19.85%</td><td style="text-align:right">+2.21%</td><td style="text-align:right;color:#12b886">-46.71%</td><td class="sub">最差</td></tr>
  <tr><td>国证2000（小盘）</td><td style="text-align:right">+47.01%</td><td style="text-align:right">+4.77%</td><td style="text-align:right;color:#12b886">-42.68%</td><td class="sub">略好，但回撤巨大</td></tr>
  <tr><td>中证医药（行业）</td><td style="text-align:right">+64.01%</td><td style="text-align:right">+6.17%</td><td style="text-align:right;color:#12b886">-31.18%</td><td class="sub">最好——但是行业押注，不可外推</td></tr>
</tbody></table>
<div class="sub"><b>"小盘溢价"确实存在，但远没有传说中那么大，而且不稳定：</b>8.3 年国证2000 年化 4.77% 跑赢沪深300 的 2.32%；但 2021 年以来中证1000 只有 -0.30%，2023 年以来中证1000（+1.05%）反而跑输上证（+4.77%）。<b>没有稳定的风格 win。</b></div>
</div>

<h2>资产配置对比（真实指数、含成本）</h2>
<div class="card">${chart}<div style="margin-top:12px">${legend}</div></div>
${tables}

<h2>最终结论</h2>
<div class="card"><div class="sub">
<b>① 在 A 股这段 8.3 年里，没有一个"能赚钱"的策略。</b>最好的配置年化 +6%，而且要承受 -31% 的回撤；市场本身（上证）年化只有 +3.49%。<br><br>
<b>② 我之前所有"超额收益"都是数据偏差。</b>受污染个股池测出的小盘 +436%，真实是 +12%（3.8 年），放大 36 倍。<b>这个教训比任何策略都值钱：不控制偏差，回测就是在自我欺骗。</b><br><br>
<b>③ 唯一稳健的东西仍然是成本纪律。</b>年换手 1 次成本 -0.30%，每周换手 -13.95%。在一个年化 3.5% 的市场里，这几乎决定了生死。<br><br>
<b>④ 分散是唯一免费的改善。</b>50% 沪深300 + 50% 中证医药：8.3 年 +40.62%、回撤 -32.62%，显著好于单独持有沪深300（+19.47% / -45.85%）。跨资产/跨风格分散能压低回撤，而回撤是唯一你能真正控制的东西。<br><br>
<b>⑤ 所以"赢"的可行定义只剩一个：</b>用最低成本拿到市场平均收益（年化 3%~6%），把回撤控制在你能睡着觉的范围内，并且<b>绝不做那个给市场交手续费的人</b>。
</div></div>

<div class="sub" style="margin-top:20px">全部数字可用 <code>node src/replay/index-premium.js</code>（指数对比）、<code>node src/replay/allocation.js</code>（配置回测）复现。不构成投资建议。</div>
</div></body></html>`;

fs.writeFileSync(path.join(OUT, 'verdict.html'), html);
console.log('\n已生成 data/replay/verdict.html');
