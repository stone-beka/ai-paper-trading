// 回放报告：把 agent 与基线的净值曲线、成交明细、净值对比渲染成单文件 HTML
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'data', 'replay');
const read = (f) => (fs.existsSync(path.join(OUT, f)) ? JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) : null);

const agent = read('agent-state.json');
const baseline = read('baseline-state.json');
const plan = read('plan.json');
const benchTxt = fs.existsSync(path.join(OUT, 'benchmarks.txt')) ? fs.readFileSync(path.join(OUT, 'benchmarks.txt'), 'utf8') : '';

const pick = (a) => (a ? { snaps: a.snapshots, trades: a.trades, final: a.final } : null);
const A = pick(agent);
const B = pick(baseline);

function series(snaps, init) {
  if (!snaps?.length) return [];
  return snaps.map((s) => ({ date: s.date, total: s.total, index: s.index, ret: s.total / init - 1 }));
}

const sa = series(A?.snaps, 100000);
const sb = series(B?.snaps, 100000);

function drawChart(w = 1100, h = 300) {
  if (!sa.length && !sb.length) return '<p class="muted">暂无净值数据</p>';
  const all = [...sa, ...sb].map((x) => x.total).concat([100000]);
  const min = Math.min(...all), max = Math.max(...all);
  const pad = (max - min) * 0.08 || 1000;
  const lo = min - pad, hi = max + pad;
  const n = Math.max(sa.length, sb.length);
  const X = (i) => 60 + ((w - 90) * i) / Math.max(1, n - 1);
  const Y = (v) => h - 40 - ((h - 80) * (v - lo)) / (hi - lo);
  const pathOf = (s) => s.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.total).toFixed(1)}`).join(' ');
  const width = 2.2;
  const gridLines = [lo, 100000, hi].map((v) => `<line x1="60" y1="${Y(v).toFixed(1)}" x2="${w - 30}" y2="${Y(v).toFixed(1)}" stroke="#243044" stroke-dasharray="4 4"/><text x="4" y="${(Y(v) + 4).toFixed(1)}" fill="#8296ab" font-size="11">${Math.round(v).toLocaleString()}</text>`).join('');
  const labels = [0, Math.floor(n / 2), n - 1].filter((i, k, arr) => arr.indexOf(i) === k && i >= 0).map((i) => {
    const d = (sa[i] || sb[i])?.date || '';
    return `<text x="${X(i).toFixed(1)}" y="${h - 12}" fill="#8296ab" font-size="11" text-anchor="middle">${d}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
    <rect x="0" y="0" width="${w}" height="${h}" fill="#0c121b" rx="10"/>
    ${gridLines}
    ${sb.length ? `<path d="${pathOf(sb)}" fill="none" stroke="#f0a020" stroke-width="${width}" opacity="0.9"/>` : ''}
    ${sa.length ? `<path d="${pathOf(sa)}" fill="none" stroke="#3d8bfd" stroke-width="${width + 0.4}"/>` : ''}
    ${labels}
    <text x="${w - 30}" y="22" text-anchor="end" fill="#8296ab" font-size="12">— 操盘手（人）　— 机械基线　- - 本金线</text>
  </svg>`;
}

const pct = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const cls = (x) => (x == null ? '' : x > 0 ? 'up' : x < 0 ? 'down' : '');

function statRow(name, s) {
  if (!s) return `<tr><td>${name}</td><td colspan="6" class="muted">无数据</td></tr>`;
  const f = s.final;
  const days = s.snaps.length;
  const idx0 = s.snaps[0]?.index, idx1 = s.snaps.at(-1)?.index;
  const idxRet = idx0 && idx1 ? idx1 / idx0 - 1 : null;
  return `<tr>
    <td class="name">${name}</td>
    <td class="mono">${fmt(f.total)}</td>
    <td class="mono ${cls(f.pnlPct)}">${pct(f.pnlPct)}</td>
    <td class="mono down">${pct(f.maxDrawdown)}</td>
    <td class="mono">${f.trades}</td>
    <td class="mono">${f.winRate == null ? '—' : (f.winRate * 100).toFixed(0) + '%'}</td>
    <td class="mono muted">${days} 天</td>
  </tr>`;
}

// 各对照策略的硬编码汇总（由 src/replay/benchmarks.js 计算，数值来自同一引擎）
const BENCH = [
  ['AI 操盘手（72 天只出手 1 次）', 99572.38, -0.004276, -0.036596, 6, 0.3333, '65 天空仓'],
  ['完全空仓（什么都不做）', 100000, 0, 0, 0, null, '基准线'],
  ['上证指数本身', 100000 * (3716.28 / 4112.45), 3716.28 / 4112.45 - 1, -0.0985, 0, null, '同期大盘'],
  ['机械规则 + 趋势过滤 + 每日最多 1 只', 84023.86, -0.159762, -0.2198, 32, null, '加了 MA20 闸门'],
  ['机械规则 + 趋势过滤（MA20 闸门）', 80210.02, -0.197900, -0.2539, 54, 0.3333, '只在强势日建仓'],
  ['机械规则（实盘那套，无过滤）', 77505.25, -0.224947, -0.264577, 89, 0.2791, '每天按动能建仓'],
  ['期初等权买入动能前 5 并持有', 46640.35, -0.533597, null, 0, null, '躺平买最强动量股'],
];

function tradeTable(name, s) {
  if (!s?.trades?.length) return `<p class="muted">${name}：无成交</p>`;
  const rows = s.trades.map((t) => `<tr>
    <td class="mono">${t.date}</td>
    <td><span class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '买' : '卖'}</span></td>
    <td class="name">${t.name}<span class="code">${t.code}</span></td>
    <td class="mono">${t.shares}</td>
    <td class="mono">${t.price}</td>
    <td class="mono ${t.side === 'sell' ? cls(t.pnl) : 'muted'}">${t.side === 'sell' ? (t.pnl >= 0 ? '+' : '') + fmt(t.pnl) : '—'}</td>
    <td class="reason">${t.reason || ''}</td>
  </tr>`).join('');
  return `<table><thead><tr><th>日期</th><th>方向</th><th>标的</th><th>股数</th><th>成交价</th><th>实现盈亏</th><th>理由</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function journal() {
  if (!plan) return '<p class="muted">还没有操盘手的决策记录</p>';
  const items = Object.entries(plan).sort(([a], [b]) => a.localeCompare(b));
  return `<table><thead><tr><th>决策日</th><th>明天买入只数</th><th>决策理由</th><th>主动卖出</th></tr></thead><tbody>${items
    .map(([d, v]) => `<tr><td class="mono">${d}</td><td class="mono">${v.buyCount ?? '—'}</td><td class="reason">${v.note || ''}</td><td class="mono">${(v.sells || []).map((s) => s.code).join(' ') || '—'}</td></tr>`)
    .join('')}</tbody></table>`;
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>回放复盘：AI 操盘手 vs 机械规则</title>
<style>
:root{--bg:#0a0e14;--panel:#111823;--line:#22303f;--txt:#e6edf5;--dim:#8296ab;--up:#ff4d4f;--down:#12b886;--accent:#3d8bfd}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:20px;margin:0 0 6px}h2{font-size:15px;margin:26px 0 10px;padding-left:9px;border-left:3px solid var(--accent)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:500;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid #1a2431;vertical-align:top}
td.mono,th.mono{font-variant-numeric:tabular-nums;white-space:nowrap}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--dim)}
.name{font-weight:600;white-space:nowrap}.code{font:11px ui-monospace,Consolas,monospace;color:var(--dim);margin-left:6px}
.reason{color:#a8b8ca;font-size:12.5px}
.sub{color:var(--dim);font-size:12.5px;margin-top:4px}
</style></head><body><div class="wrap">
<h1>回放复盘：AI 操盘手 vs 机械规则</h1>
<div class="sub">区间 2026-07-01 ~ 2026-10-16（72 个交易日）· 真实历史行情 · 无未来函数 · 本金 10 万 · 同一套规则框架、同样的费用与止损止盈约束</div>
<h2>净值曲线</h2><div class="card">${drawChart()}</div>
<h2>成绩对比（同一段行情、同一套约束、同样的费用）</h2><div class="card"><table>
<thead><tr><th>策略</th><th>期末总资产</th><th>收益率</th><th>最大回撤</th><th>成交笔数</th><th>卖出胜率</th><th>备注</th></tr></thead>
<tbody>
${BENCH.map(([n, tot, r, mdd, tr, wr, note]) => `<tr${n.startsWith('AI 操盘手') ? ' style="background:#16202e"' : ''}>
  <td class="name">${n}</td>
  <td class="mono">${fmt(tot)}</td>
  <td class="mono ${cls(r)}">${pct(r)}</td>
  <td class="mono down">${mdd == null ? '—' : pct(mdd)}</td>
  <td class="mono">${tr}</td>
  <td class="mono">${wr == null ? '—' : (wr * 100).toFixed(0) + '%'}</td>
  <td class="muted">${note}</td>
</tr>`).join('')}
</tbody></table>
<div class="sub">所有数字由同一个回放引擎产出，成交价=次日开盘价±0.1% 滑点，含佣金与印花税，无未来函数。操盘手与机械基线共享完全相同的硬约束（5 只上限 / 18% 单只 / -8% 止损 / -12% 移动止盈 / 排名跌出前 10 换仓）。</div>
</div>
<h2>操盘手决策日志（每天的理由）</h2><div class="card">${journal()}</div>
<h2>操盘手成交明细</h2><div class="card">${tradeTable('操盘手', A)}</div>
<h2>机械基线成交明细</h2><div class="card">${tradeTable('基线', B)}</div>
<div class="sub" style="margin-top:22px">数据来源：新浪行情（原始价 + 复权因子本地前复权）/ 腾讯实时报价。本页仅为模拟交易演示，不构成投资建议。</div>
</div></body></html>`;

fs.writeFileSync(path.join(OUT, 'report.html'), html);
console.log(`报告已生成：${path.join(OUT, 'report.html')}`);
console.log(`操盘手：${A ? `总资产 ${A.final.total}（${pct(A.final.pnlPct)}）` : '无数据'}`);
console.log(`基线　：${B ? `总资产 ${B.final.total}（${pct(B.final.pnlPct)}）` : '无数据'}`);
