// 生成逐日决策上下文文件，供子代理阅读（模拟账户 + 真实行情，严格无未来函数）
import fs from 'node:fs';
import path from 'node:path';
import { buildContext, runPlan } from './run.js';
import { tradingDays } from './engine.js';

const START = process.argv[2] || '2026-07-01';
const OUT = path.join(process.cwd(), 'data', 'replay', 'contexts');

// 1) 先用「完全按规则建仓」跑一遍，得到每天真实的账户状态（作为看盘背景）
const { account: sim } = runPlan(null, { start: START, mechanical: true, verbose: false });

// 2) 逐日重建账户状态并导出上下文
fs.mkdirSync(OUT, { recursive: true });
const days = tradingDays().filter((d) => d >= START);
const stateByDate = new Map(sim.snapshots.map((s) => [s.date, s]));

// 用真实成交重建每日持仓（成交发生在开盘，所以决策日看到的持仓=当日开盘后、收盘前）
const rebuilt = { cash: 100000, positions: {} };
let ti = 0;
const trades = sim.trades;
const index = [];

for (const date of days) {
  // 应用当日开盘的成交
  while (ti < trades.length && trades[ti].date === date) {
    const t = trades[ti++];
    if (t.side === 'buy') {
      const p = rebuilt.positions[t.code] || { code: t.code, name: t.name, shares: 0, avgCost: 0, openDate: date, highClose: 0 };
      const ns = p.shares + t.shares;
      p.avgCost = (p.avgCost * p.shares + t.amount) / ns;
      p.shares = ns;
      p.openDate = p.openDate || date;
      rebuilt.cash -= t.amount;
      rebuilt.positions[t.code] = p;
    } else {
      delete rebuilt.positions[t.code];
      rebuilt.cash += t.amount;
    }
  }

  // 用截至当日的收盘价盯市
  const acct = {
    initialCapital: 100000,
    cash: rebuilt.cash,
    positions: JSON.parse(JSON.stringify(rebuilt.positions)),
    trades: [],
    snapshots: [],
    pending: [],
    events: [],
  };
  for (const [code, p] of Object.entries(acct.positions)) {
    const bars = (await import('./engine.js')).barsUpTo(code, date);
    const last = bars?.at(-1);
    if (last) {
      p.lastPrice = last.close;
      p.highClose = Math.max(p.highClose || 0, last.close);
    }
  }

  const ctx = buildContext(acct, date, { top: 20 });
  const snap = stateByDate.get(date);
  const dayIdx = index.length;
  const file = path.join(OUT, `${String(dayIdx).padStart(3, '0')}_${date}.json`);
  fs.writeFileSync(file, JSON.stringify({
    ...ctx,
    note: '这是「机械规则」运行到当天的账户状态，仅作为看盘背景；你自己的决策会走另一条路径。',
    snapshot: snap ? { total: snap.total, index: snap.index } : null,
  }, null, 2));
  index.push({ file: path.relative(process.cwd(), file), date, total: snap?.total ?? null, index: snap?.index ?? null });
  if (dayIdx % 10 === 0) console.log(`  已导出 ${dayIdx + 1}/${days.length} 天（${date}）`);
}

fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify(index, null, 2));
console.log(`\n共导出 ${index.length} 个决策日上下文 -> data/replay/contexts/`);
console.log(`清单：data/replay/contexts/_index.json`);
