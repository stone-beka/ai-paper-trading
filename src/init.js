// 初始化：扫描一次，按最新收盘价建立初始组合（基准仓位）
import fs from 'node:fs';
import path from 'node:path';
import { runScan } from './lib/scan.js';
import {
  saveState, newState, doBuy, snapshot, addEvent, totalAssets,
  buyCost, maxBuyShares, COST, log,
} from './lib/engine.js';
import { saveScan } from './tick.js';
import { STRATEGY } from './lib/strategy.js';
import { acquireLockAsync, releaseLock, log as logStore } from './lib/store.js';

const SEED_BUILD_STRONG = 0.9;  // 大盘在 MA20 上方：初始投入 90%
const SEED_BUILD_WEAK = 0.6;    // 大盘在 MA20 下方：初始只投 60%（弱势降风险）
const SEED_POSITIONS = 5;       // 初始持仓只数

/**
 * 按目标金额分配建仓：等额分配 -> 剔除一手占比过高的标的 -> 用余钱补仓
 * 目标是让仓位尽量贴近目标比例，而不是机械等额卡住
 */
function allocate(candidates, totalAmount, limit) {
  const picks = candidates.slice(0, limit);
  return picks;
}

async function main() {
  const lock = await acquireLockAsync('init', 300000, (m) => logStore(m));
  if (!lock.ok) {
    console.error(`初始化失败：等待 ${((300000) / 1000).toFixed(0)}s 仍未拿到锁（holder pid ${lock.holder?.pid}）`);
    process.exit(2);
  }
  try {
    // 若另一实例已经写好账户，直接复用（命令被重试时不会重复建仓）
    const existing = loadStateSafe();
    if (existing && existing.trades?.length && process.env.DSH_PAPER_FORCE !== '1') {
      logStore(`检测到已有账户（${existing.trades.length} 笔成交，初始化于 ${existing.snapshots?.[0]?.date}），跳过重建。`);
      return existing;
    }
    return await run();
  } finally {
    releaseLock('init');
  }
}

function loadStateSafe() {
  try {
    const f = path.join(process.env.DSH_PAPER_DATA ? path.resolve(process.env.DSH_PAPER_DATA) : path.join(process.cwd(), 'data'), 'state.json');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

async function run() {
  log('开始全市场扫描...');
  const scan = await runScan();
  saveScan(scan);

  const s = newState();
  const buyDate = scan.asOf;
  // 弱势市场降低初始仓位（与“市场开关”一致的降风险逻辑）
  const seedBuild = scan.weather.above ? SEED_BUILD_STRONG : SEED_BUILD_WEAK;
  const budget = s.initialCapital * seedBuild;
  log(`大盘 ${scan.weather.above ? '强势' : '弱势'}：初始建仓比例 ${(seedBuild * 100).toFixed(0)}%，拟投入 ${budget.toFixed(0)} 元`);

  const picks = allocate(scan.candidates, budget, SEED_POSITIONS);
  const perAmount = budget / picks.length;

  // 先按等额下单
  const orders = [];
  for (const [i, c] of picks.entries()) {
    const shares = maxBuyShares({ cash: budget - orders.reduce((a, o) => a + o.cost, 0) }, c.close);
    const want = Math.floor(perAmount / (c.close * (1 + COST.slippage) * COST.lotSize)) * COST.lotSize;
    const take = Math.min(want, shares);
    if (take > 0) orders.push({ c, shares: take, cost: buyCost(c.close * (1 + COST.slippage), take).total });
  }

  // 余钱按排名顺序补一手（尽量贴近目标仓位）
  let used = orders.reduce((a, o) => a + o.cost, 0);
  for (const o of orders) {
    while (used + buyCost(o.c.close * (1 + COST.slippage), COST.lotSize).total <= budget) {
      o.shares += COST.lotSize;
      o.cost = buyCost(o.c.close * (1 + COST.slippage), o.shares).total;
      used = orders.reduce((a, x) => a + x.cost, 0);
    }
  }

  for (const [i, o] of orders.entries()) {
    const tr = doBuy(s, {
      code: o.c.code,
      name: o.c.name,
      price: o.c.close,
      targetAmount: o.cost,
      date: buyDate,
      reason: `初始建仓：动能第 ${i + 1} 名（20日 ${(o.c.r20 * 100).toFixed(1)}%、60日 ${(o.c.r60 * 100).toFixed(1)}%、波动 ${(o.c.vol * 100).toFixed(1)}%，得分 ${o.c.score.toFixed(3)}）`,
    });
    if (tr) log(`建仓 ${o.c.name}(${o.c.code}) ${tr.shares}股 @${tr.price}，金额 ${tr.amount.toFixed(2)}`);
  }

  for (const [code, pos] of Object.entries(s.positions)) {
    const c = scan.candidates.find((x) => x.code === code);
    pos.lastPrice = c ? c.close : pos.avgCost;
    pos.highClose = Math.max(pos.highClose || 0, pos.lastPrice);
  }

  // 基准：同样这 5 只等权买入后全程不动
  s.benchmark = {
    name: '等权买入同样 5 只并持有不动（不做止损/换仓）',
    startDate: buyDate,
    entries: orders.map((o) => ({ code: o.c.code, name: o.c.name, close: o.c.close })),
  };

  snapshot(s, buyDate, scan.weather.indexClose);
  s.lastScan = scan;
  s.strategy = scan.strategy;
  s.lastTradingDay = scan.asOf;
  s.tradeDaySeq = 0;
  addEvent(
    s, 'init',
    `账户初始化：本金 ${s.initialCapital} 元，按 ${buyDate} 收盘价建仓 ${Object.keys(s.positions).length} 只，投入 ${seedBuild * 100}% 仓位（大盘${scan.weather.above ? '强势' : '弱势'}）。上证 ${scan.weather.indexClose} vs MA20 ${scan.weather.ma20}。`
  );
  saveState(s);

  const ta = totalAssets(s, (c) => s.positions[c]?.lastPrice);
  console.log('\n================ 账户就绪 ================');
  console.log(`本金 ${s.initialCapital} 元 | 现金 ${s.cash.toFixed(2)} | 市值 ${ta.mktValue.toFixed(2)} | 总资产 ${ta.total.toFixed(2)}（仓位 ${((ta.mktValue / ta.total) * 100).toFixed(1)}%）`);
  console.log('\n初始持仓：');
  for (const p of Object.values(s.positions)) {
    console.log(`  ${p.name}(${p.code})  ${p.shares}股  成本 ${p.avgCost.toFixed(3)}  收盘 ${p.lastPrice}  市值 ${(p.lastPrice * p.shares).toFixed(2)}`);
  }
  console.log('\n候补排名 Top15：');
  scan.candidates.slice(0, 15).forEach((c, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${c.name}(${c.code})  得分 ${c.score.toFixed(3)}  20日 ${(c.r20 * 100).toFixed(1)}%  60日 ${(c.r60 * 100).toFixed(1)}%  波动 ${(c.vol * 100).toFixed(1)}%  流通 ${c.floatMcapYi}亿  今日 ${c.pct}%`
    );
  });
}

main().catch((e) => {
  console.error('初始化失败：', e);
  process.exit(1);
});

main().catch((e) => {
  console.error('初始化失败：', e);
  process.exit(1);
});
