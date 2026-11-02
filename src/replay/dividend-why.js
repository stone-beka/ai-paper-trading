// 追问：红利策略为什么有效？是不是"低估值+分散"的必然结果，而非运气
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'data', 'replay');
const file = path.join(OUT, 'dividend-check.json');
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const data = j.data;

const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
function stats(bars, from, to) {
  const seg = bars.filter((b) => b.date >= from && b.date <= to);
  if (seg.length < 30) return null;
  const ret = seg.at(-1).close / seg[0].close - 1;
  let pk = -Infinity, mdd = 0;
  for (const b of seg) { pk = Math.max(pk, b.close); mdd = Math.min(mdd, b.close / pk - 1); }
  const years = seg.length / 242;
  return { ret, years, mdd, cagr: Math.pow(1 + ret, 1 / years) - 1, days: seg.length };
}

console.log('===== 逐年对比：红利 vs 沪深300 vs 上证 =====');
const YEARS = [];
for (let y = 2018; y <= 2026; y++) YEARS.push([`${y}-01-01`, `${y}-12-31`, String(y)]);

const SYMS = [['sh000015', '上证红利'], ['sh000149', '180红利'], ['sh000300', '沪深300'], ['sh000001', '上证指数']];
console.log(`  ${'年份'.padEnd(6)} ${SYMS.map((s) => s[1].padStart(10)).join(' ')}`);
let redWin = 0, total = 0;
for (const [f, t, label] of YEARS) {
  const row = [];
  let redRet = null, hsRet = null;
  for (const [sym, name] of SYMS) {
    const d = data[sym];
    if (!d) { row.push('—'.padStart(10)); continue; }
    const s = stats(d.bars, f, t);
    if (!s || s.days < 100) { row.push('—'.padStart(10)); continue; }
    row.push(pct(s.ret).padStart(10));
    if (sym === 'sh000015') redRet = s.ret;
    if (sym === 'sh000300') hsRet = s.ret;
  }
  if (redRet != null && hsRet != null) {
    total++;
    if (redRet > hsRet) redWin++;
  }
  console.log(`  ${label.padEnd(6)} ${row.join(' ')}`);
}
console.log(`\n  红利跑赢沪深300 的年份：${redWin}/${total}`);

console.log('\n===== 滚动 3 年窗口：红利 vs 沪深300 =====');
const red = data['sh000015'].bars;
const hs = data['sh000300'].bars;
const dates = red.map((b) => b.date).filter((d) => d >= '2019-01-01');
let wins = 0, n = 0, sumRed = 0, sumHs = 0;
const rows = [];
for (let i = 0; i + 726 < dates.length; i += 21) {
  const f = dates[i], t = dates[Math.min(i + 726, dates.length - 1)];
  const a = stats(red, f, t), b = stats(hs, f, t);
  if (!a || !b) continue;
  n++;
  sumRed += a.cagr; sumHs += b.cagr;
  if (a.cagr > b.cagr) wins++;
  if (n % 12 === 1) rows.push(`    ${f} ~ ${t}   红利年化 ${pct(a.cagr).padStart(8)}  沪深300年化 ${pct(b.cagr).padStart(8)}  ${a.cagr > b.cagr ? '红利赢' : '沪深300赢'}`);
}
rows.forEach((r) => console.log(r));
console.log(`\n  滚动 3 年窗口共 ${n} 个：红利跑赢 ${wins} 个（${((wins / n) * 100).toFixed(0)}%）`);
console.log(`  平均年化：红利 ${pct(sumRed / n)}  vs  沪深300 ${pct(sumHs / n)}`);

console.log('\n===== 红利 vs 沪深300：相对强弱曲线（确认不是单段幸运期） =====');
const ratio = [];
const hsMap = new Map(hs.map((b) => [b.date, b.close]));
for (const b of red) {
  const h = hsMap.get(b.date);
  if (h) ratio.push({ date: b.date, r: b.close / h });
}
const step = Math.max(1, Math.floor(ratio.length / 20));
console.log('   日期         红利/沪深300');
for (let i = 0; i < ratio.length; i += step) {
  const p = ratio[i];
  const bar = '█'.repeat(Math.max(1, Math.round(p.r * 8)));
  console.log(`   ${p.date}  ${p.r.toFixed(3)}  ${bar}`);
}
const r0 = ratio[0].r, r1 = ratio.at(-1).r;
console.log(`\n  期初比值 ${r0.toFixed(3)} -> 期末 ${r1.toFixed(3)}，${r1 > r0 ? '红利持续走强' : '红利走弱'}（变化 ${pct(r1 / r0 - 1)}）`);
