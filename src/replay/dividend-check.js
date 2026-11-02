// 钱从哪来：股息（红利指数含分红）vs 价格指数（不含分红）
// 用于回答「市场到底给不给钱」——A股指数默认不含分红，红利指数是含分红的
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = path.join(process.cwd(), 'data', 'replay');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

function name(sym) {
  try {
    const out = execFileSync('curl.exe', ['-s', '-m', '15', '-A', UA, '-e', 'https://gu.qq.com/', `https://qt.gtimg.cn/q=${sym}`], { encoding: 'latin1', maxBuffer: 1 << 20 });
    const m = out.match(/="([^"]*)"/);
    return m ? m[1].split('~')[1] : '?';
  } catch { return '?'; }
}
function kline(sym, len = 2000) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${len}`;
  const out = execFileSync('curl.exe', ['-s', '-m', '40', '-A', UA, '-e', 'https://finance.sina.com.cn/', url], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return JSON.parse(out).map((b) => ({ date: b.day, close: +b.close }));
}

// 候选：中证红利、红利低波、上证50、上证指数（价格指数，不含分红）
const CAND = [
  ['sh000922', '中证红利（价格指数）'],
  ['sh000015', '上证红利'],
  ['sh000149', '红利低波?'],
  ['sh000016', '上证50'],
  ['sh000001', '上证指数'],
  ['sh000300', '沪深300'],
];

const data = {};
for (const [sym, label] of CAND) {
  try {
    const bars = kline(sym);
    data[sym] = { sym, label, name: name(sym), bars };
    console.log(`✅ ${sym}  ${label.padEnd(22)} 行情名=${name(sym)}  ${bars.length} 根 ${bars[0].date}~${bars.at(-1).date}`);
  } catch (e) {
    console.log(`❌ ${sym} ${label} ${e.message.slice(0, 60)}`);
  }
}

const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
function stats(bars, from, to) {
  const seg = bars.filter((b) => b.date >= from && b.date <= to);
  if (seg.length < 30) return null;
  const ret = seg.at(-1).close / seg[0].close - 1;
  let pk = -Infinity, mdd = 0;
  for (const b of seg) { pk = Math.max(pk, b.close); mdd = Math.min(mdd, b.close / pk - 1); }
  const years = seg.length / 242;
  return { ret, years, mdd, cagr: Math.pow(1 + ret, 1 / years) - 1 };
}

console.log('\n' + '='.repeat(84));
for (const [f, t, label] of [['2018-07-17', '2026-10-16', '8.3 年'], ['2021-01-04', '2026-10-16', '5.8 年'], ['2016-01-04', '2026-10-16', '10.8 年']]) {
  console.log(`\n██ ${label}  ${f} ~ ${t}`);
  console.log(`  ${'指数'.padEnd(30)} ${'总收益'.padStart(10)} ${'年化'.padStart(9)} ${'最大回撤'.padStart(10)}`);
  for (const [sym, d] of Object.entries(data)) {
    const s = stats(d.bars, f, t);
    if (!s) { console.log(`  ${d.name.padEnd(28)} （区间数据不足）`); continue; }
    console.log(`  ${(d.name || d.label).padEnd(28)} ${pct(s.ret).padStart(10)} ${pct(s.cagr).padStart(9)} ${pct(s.mdd).padStart(10)}`);
  }
}

const out = {};
for (const [sym, d] of Object.entries(data)) {
  out[sym] = { name: d.name, label: d.label, first: d.bars[0].date, last: d.bars.at(-1).date, n: d.bars.length };
}
fs.writeFileSync(path.join(OUT, 'dividend-check.json'), JSON.stringify({ meta: out, data }, null, 2));
console.log('\n已写入 data/replay/dividend-check.json');
