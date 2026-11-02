// 生成设计书可视化页：成本曲线、再平衡对比、策略卡片
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'data', 'replay');
const fd = JSON.parse(fs.readFileSync(path.join(OUT, 'final-design.json'), 'utf8'));

const pct = (x, d = 2) => (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
const fmt = (n) => Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// 成本曲线：年换手次数 -> 10 年后的剩余比例
const costPts = [];
for (let n = 0; n <= 60; n++) {
  const drag = Math.pow(1 - 0.003, n);
  costPts.push({ n, remain: Math.pow(drag, 10) });
}
function costChart(w = 560, h = 240) {
  const X = (n) => 50 + ((w - 80) * n) / 60;
  const Y = (v) => h - 34 - (h - 60) * (v - 0) / 1.0;
  const path = costPts.map((p, i) => `${i ? 'L' : 'M'}${X(p.n).toFixed(1)},${Y(p.remain).toFixed(1)}`).join(' ');
  const marks = [0, 1, 4, 12, 50].map((n) => {
    const p = costPts[n];
    const anchor = n === 0 ? 'end' : n === 50 ? 'end' : 'middle';
    const dx = n === 0 ? -6 : n === 50 ? 6 : 0;
    const dy = n === 0 ? 16 : -8;
    return `<circle cx="${X(n).toFixed(1)}" cy="${Y(p.remain).toFixed(1)}" r="3.5" fill="#ff4d4f"/>
      <text x="${(X(n) + dx).toFixed(1)}" y="${(Y(p.remain) + dy).toFixed(1)}" fill="#e6edf5" font-size="10" text-anchor="${anchor}">${(p.remain * 100).toFixed(1)}%</text>
      <text x="${X(n).toFixed(1)}" y="${h - 14}" fill="#8296ab" font-size="10" text-anchor="middle">${n}次</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">
    <rect width="${w}" height="${h}" fill="#0c121b" rx="10"/>
    <line x1="50" y1="${Y(1).toFixed(1)}" x2="${w - 30}" y2="${Y(1).toFixed(1)}" stroke="#243044" stroke-dasharray="4 4"/>
    <path d="${path}" fill="none" stroke="#ff4d4f" stroke-width="2.2"/>
    ${marks}
    <text x="52" y="18" fill="#8296ab" font-size="11">10 年后本金剩余比例（每次再平衡双边成本 0.3%）</text>
  </svg>`;
}

const rebFreq = fd.rebalanceFreq;
const bal = fd.balanced;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>赢钱策略设计书 · 数据附录</title>
<style>
:root{--bg:#0a0e14;--panel:#111823;--line:#22303f;--txt:#e6edf5;--dim:#8296ab;--up:#ff4d4f;--down:#12b886;--accent:#3d8bfd;--warn:#f0a020}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.65 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:21px;margin:0 0 6px}h2{font-size:15px;margin:28px 0 10px;padding-left:9px;border-left:3px solid var(--accent)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.grid{display:grid;gap:14px}.two{grid-template-columns:1fr 1fr}@media(max-width:860px){.two{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:500;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid #1a2431;font-variant-numeric:tabular-nums}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--dim)}.warn{color:var(--warn)}
.sub{color:var(--dim);font-size:12.5px;margin-top:6px;line-height:1.7}
.big{font:600 26px/1.15 ui-monospace,Consolas,monospace}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kv .cell{background:#0d131c;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kv .lbl{font-size:11.5px;color:var(--dim);letter-spacing:.3px}
.rules{counter-reset:r;list-style:none;padding:0;margin:0}
.rules li{counter-increment:r;position:relative;padding:9px 0 9px 40px;border-bottom:1px solid #1a2431}
.rules li::before{content:counter(r);position:absolute;left:0;top:9px;width:26px;height:26px;border-radius:50%;
  background:#182233;color:var(--accent);display:flex;align-items:center;justify-content:center;font:600 12px/1 monospace}
.bad{color:#ff6b6b}.good{color:#12b886}
</style></head><body><div class="wrap">
<h1>赢钱策略设计书 · 数据附录</h1>
<div class="sub">全部数字来自上证指数 2018-07-17 ~ 2026-10-16（2000 根日K，8.3 年，<b>零幸存者偏差</b>）· 可用 <code>node src/replay/final-design.js</code> 复现</div>

<h2>第一步：接受残酷的地基</h2>
<div class="card"><div class="kv">
  <div class="cell"><div class="lbl">买入持有收益</div><div class="big up">+32.81%</div></div>
  <div class="cell"><div class="lbl">年化收益</div><div class="big">+3.49%</div></div>
  <div class="cell"><div class="lbl">最大回撤</div><div class="big down">-27.27%</div></div>
  <div class="cell"><div class="lbl">10 万本金 8.3 年后</div><div class="big">${fmt(fd.index.final)}</div></div>
</div>
<div class="sub">8.3 年年化 3.49%、回撤 27%——这就是中国宽基指数的真实答卷。<b>任何主动策略必须先证明自己能超过这个数。</b></div>
</div>

<h2>第二步：成本是唯一 100% 确定的东西</h2>
<div class="grid two">
  <div class="card">${costChart()}</div>
  <div class="card"><table>
    <thead><tr><th>年换手次数</th><th>年化成本拖累</th><th>场景</th></tr></thead>
    <tbody>
      <tr><td>0 次</td><td class="down">0.00%</td><td class="muted">买入持有</td></tr>
      <tr><td>1 次</td><td class="down">-0.30%</td><td class="muted">年度再平衡 ← 本设计</td></tr>
      <tr><td>4 次</td><td class="down">-1.19%</td><td class="muted">季度调仓</td></tr>
      <tr><td>12 次</td><td class="down">-3.54%</td><td class="muted">每月调仓</td></tr>
      <tr><td>50 次</td><td class="down bad">-13.95%</td><td class="muted">每周调仓</td></tr>
      <tr><td>242 次</td><td class="down bad">-51.67%</td><td class="muted">每天调仓</td></tr>
    </tbody></table>
    <div class="sub">年化 3.49% 的市场里，每周调仓交 13.95% 过路费。<b>这是主动策略的第一死因</b>，我自己的机械规则 3.8 年亏损中 57% 就是它。</div>
  </div>
</div>

<h2>第三步：再平衡频率几乎不敏感 → 那就用最低频的</h2>
<div class="card"><table>
  <thead><tr><th>再平衡频率（70% 指数 + 30% 现金）</th><th>收益</th><th>年化</th><th>最大回撤</th><th>交易次数</th></tr></thead>
  <tbody>${rebFreq.map((r) => `<tr>
    <td>每 ${r.months} 个月${r.months === 12 ? ' ← 本设计' : ''}</td>
    <td class="up">+${(r.ret * 100).toFixed(2)}%</td>
    <td>+${(r.cagr * 100).toFixed(2)}%</td>
    <td class="down">${(r.mdd * 100).toFixed(2)}%</td>
    <td>${r.rebalances} 次</td></tr>`).join('')}</tbody></table>
  <div class="sub">频率降 10 倍，年化只差 0.06 个百分点。<b>宁可少做，不要多做。</b></div>
</div>

<h2>第四步：仓位决定你能睡得多好</h2>
<div class="card"><table>
  <thead><tr><th>配置（年度再平衡）</th><th>收益</th><th>年化</th><th>最大回撤</th></tr></thead>
  <tbody>${bal.map((r) => `<tr>
    <td>${(r.stockPct * 100).toFixed(0)}% 指数 + ${((1 - r.stockPct) * 100).toFixed(0)}% 现金${r.stockPct === 0.7 ? ' ← 本设计' : ''}</td>
    <td class="up">+${(r.ret * 100).toFixed(2)}%</td>
    <td>+${(r.cagr * 100).toFixed(2)}%</td>
    <td class="down">${(r.mdd * 100).toFixed(2)}%</td></tr>`).join('')}</tbody></table>
  <div class="sub">收益与回撤几乎线性同增：<b>没有免费的午餐，只有你能承受的波动。</b></div>
</div>

<h2>最终设计：三账户哑铃</h2>
<div class="card"><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr))">
  <div class="cell"><div class="lbl">A 核心仓 · 70%</div><div style="margin:6px 0;font-weight:600">宽基指数 / 等权指数</div>
    <div class="sub">一次性或 3 个月定投建仓<br>每年再平衡 1 次<br>不择时、不轮动、不看K线</div></div>
  <div class="cell"><div class="lbl">B 增强仓 · 20%</div><div style="margin:6px 0;font-weight:600">20–30 只等权</div>
    <div class="sub">非ST / 流通市值 50–500亿 / 日均额≥5000万<br>单只≤5%<br>年换手目标 &lt;30%</div></div>
  <div class="cell"><div class="lbl">C 现金仓 · 10%</div><div style="margin:6px 0;font-weight:600">再平衡弹药</div>
    <div class="sub">不做杠杆、不做空<br>不做衍生品<br>防止追高的心理缓冲</div></div>
</div></div>

<h2>三条铁律</h2>
<div class="card"><ol class="rules">
  <li><b>年换手 ≤ 1 次</b>（成本拖累 ≤ 0.30%）</li>
  <li><b>不加杠杆、不做空、不碰衍生品</b></li>
  <li><b>年度再平衡日以外，不看盘、不操作</b></li>
</ol></div>

<h2>诚实的预期</h2>
<div class="card"><table>
  <thead><tr><th>项目</th><th>乐观</th><th>中性</th><th>悲观</th></tr></thead>
  <tbody>
    <tr><td>年化</td><td class="up">+8%</td><td><b>+3.5%</b><span class="muted">（= 指数 8.3 年实测）</span></td><td class="down">-5%</td></tr>
    <tr><td>最大回撤</td><td>-15%</td><td><b>-25%</b></td><td class="down">-40%</td></tr>  </tbody></table>
  <div class="sub">目标不是"赢很多"，而是<b>用最低成本、最低换手，拿到市场平均收益，并保证不被自己搞死</b>。<br>
  若 8.3 年年化 3.49% 让你失望——那是市场的问题，不是策略的问题。任何声称能稳定年化 20% 的方案，先问三件事：<b>样本外验证了吗？参数敏感吗？扣成本了吗？</b></div>
</div>

<h2>夸大与未验证（必须标明）</h2>
<div class="card"><div class="sub">
<b class="warn">① 幸存者偏差未消除。</b>我那份"等权 +102% vs 指数 +19%"的对比，池子只含"2026 年 10 月还活着"的 600 只股票，小盘股胜率 96% 是假象。方向性判断（等权优于市值加权）有独立支撑，但<b>具体数值不可信</b>。<br>
<b class="warn">② 未做样本外测试。</b>参数是在同一段历史上定的，还没有在 2018 年之前的数据上验证过。<br>
<b class="warn">③ 未用真实 ETF 净值验证。</b>用指数代替 ETF，忽略了跟踪误差和管理费（实际会更差一点）。<br>
<b class="warn">④ 我上一轮给的 +48.44% 操盘手成绩，同样带幸存者偏差</b>，不能当收益预期引用。
</div></div>

<div class="sub" style="margin-top:24px">数据来源：新浪行情（指数日K），本地复权与计算。本页为方法论演示，不构成投资建议。</div>
</div></body></html>`;

fs.writeFileSync(path.join(OUT, 'design.html'), html);
console.log('已生成 data/replay/design.html');
