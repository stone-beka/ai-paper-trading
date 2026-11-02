// 对照基准：同期大盘、等权持有、机械规则、机械+趋势过滤、空仓
import fs from 'node:fs';
import path from 'node:path';
import { runPlan } from './run.js';
import { market, rankAt, weatherAt, barAt } from './engine.js';

const START = '2026-07-01';
const END = '2026-10-16';
const OUT = path.join(process.cwd(), 'data', 'replay');

const m = market();
const idxDays = m.index.bars.filter((b) => b.date >= START && b.date <= END);
const c0 = idxDays[0].close;
const c1 = idxDays.at(-1).close;
let peak = -Infinity, mdd = 0;
for (const b of idxDays) { peak = Math.max(peak, b.close); mdd = Math.min(mdd, b.close / peak - 1); }

const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

say('=== 同期大盘（上证指数） ===');
say(`  ${idxDays[0].date} ${c0} -> ${idxDays.at(-1).date} ${c1}  收益 ${(((c1 / c0) - 1) * 100).toFixed(2)}%`);
say(`  区间最高 ${Math.max(...idxDays.map((b) => b.close))}  最低 ${Math.min(...idxDays.map((b) => b.close))}  最大回撤 ${(mdd * 100).toFixed(2)}%`);
say('');
say('=== 逐月 ===');
const byMonth = {};
for (const b of idxDays) (byMonth[b.date.slice(0, 7)] ||= []).push(b.close);
for (const [k, v] of Object.entries(byMonth)) say(`  ${k}: ${v[0]} -> ${v.at(-1)}  ${(((v.at(-1) / v[0]) - 1) * 100).toFixed(2)}%`);

// 对照：期初等权买入动能前 5 并持有
say('');
say('=== 对照：期初（2026-07-01）等权买入动能前 5、持有不动 ===');
const w0 = weatherAt(START);
const top5 = rankAt(START, { top: 5, gate: w0.gate });
let sum = 0, n = 0;
for (const c of top5) {
  const b = barAt(c.code, END);
  if (!b) continue;
  const r = b.close / c.close - 1;
  sum += r; n++;
  say(`  ${c.name}(${c.code}) ${c.close} -> ${b.close}  ${(r * 100).toFixed(2)}%`);
}
const holdRet = sum / Math.max(1, n);
say(`  等权收益 ${(holdRet * 100).toFixed(2)}%  ->  期末 ${(100000 * (1 + holdRet)).toFixed(2)} 元`);

// 对照：机械规则（无过滤）
const base = runPlan(null, { start: START, mechanical: true, autoRules: true, verbose: false });
const bf = base.account.final;
say('');
say('=== 对照：机械规则（每天按动能建仓，无趋势过滤） ===');
say(`  期末 ${bf.total.toFixed(2)} 元  收益 ${(bf.pnlPct * 100).toFixed(2)}%  最大回撤 ${(bf.maxDrawdown * 100).toFixed(2)}%  成交 ${bf.trades} 笔  胜率 ${(bf.winRate * 100).toFixed(0)}%`);

// 对照：机械规则 + 只在指数站上 MA20 时建仓
const trend = runPlan(null, {
  start: START, mechanical: true, autoRules: true, verbose: false,
  buyGate: (w) => w.above,
});
const tf = trend.account.final;
say('');
say('=== 对照：机械规则 + 趋势过滤（只在指数站上 MA20 时允许建仓） ===');
say(`  期末 ${tf.total.toFixed(2)} 元  收益 ${(tf.pnlPct * 100).toFixed(2)}%  最大回撤 ${(tf.maxDrawdown * 100).toFixed(2)}%  成交 ${tf.trades} 笔  胜率 ${tf.winRate == null ? '—' : (tf.winRate * 100).toFixed(0) + '%'}`);

// 对照：机械规则 + 趋势过滤 + 每天最多买 1 只
const one = runPlan(null, {
  start: START, mechanical: true, autoRules: true, verbose: false,
  buyGate: (w) => w.above, maxBuysPerDay: 1,
});
const of = one.account.final;
say('');
say('=== 对照：机械规则 + 趋势过滤 + 每天最多新增 1 只 ===');
say(`  期末 ${of.total.toFixed(2)} 元  收益 ${(of.pnlPct * 100).toFixed(2)}%  最大回撤 ${(of.maxDrawdown * 100).toFixed(2)}%  成交 ${of.trades} 笔`);

// 对照：完全空仓
say('');
say('=== 对照：完全空仓 ===');
say(`  期末 100,000.00 元  收益 0.00%  最大回撤 0.00%  成交 0 笔`);

fs.writeFileSync(path.join(OUT, 'benchmarks.txt'), lines.join('\n'));
console.log(`\n已写入 data/replay/benchmarks.txt`);
