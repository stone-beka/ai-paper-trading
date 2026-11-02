// 模拟撮合引擎：账户、持仓、成交、盈亏
import { stateFile, readJson, writeJson, cnDateStr, cnTimeStr, log } from './store.js';
export { log };

export const COST = {
  commissionRate: 0.00025,
  commissionMin: 5,
  stampTaxRate: 0.0005, // 仅卖出
  slippage: 0.001,
  lotSize: 100,
};

export const INITIAL_CAPITAL = 100000;

export function newState() {
  return {
    version: 1,
    strategy: null,
    initialCapital: INITIAL_CAPITAL,
    cash: INITIAL_CAPITAL,
    positions: {}, // code -> {code,name,shares,avgCost,openDate,highClose,coolDownUntil,lastPrice}
    trades: [],
    snapshots: [], // {date, total, cash, mktValue, index}
    pending: [], // 待次日开盘执行的指令 {code,name,action,reason,createdAt}
    lastScan: null,
    events: [],
  };
}

export function loadState() {
  return readJson(stateFile(), null) || newState();
}

export function saveState(s) {
  writeJson(stateFile(), s);
}

export function addEvent(s, type, msg, extra = {}) {
  s.events.unshift({ at: `${cnDateStr()} ${cnTimeStr()}`, type, msg, ...extra });
  if (s.events.length > 500) s.events.length = 500;
}

export function buyCost(price, shares) {
  const gross = price * shares;
  const fee = Math.max(gross * COST.commissionRate, COST.commissionMin);
  return { gross, fee, total: gross + fee, fillPrice: price * (1 + COST.slippage) };
}

export function sellProceeds(price, shares) {
  const gross = price * shares;
  const fee = Math.max(gross * COST.commissionRate, COST.commissionMin) + gross * COST.stampTaxRate;
  return { gross, fee, total: gross - fee, fillPrice: price * (1 - COST.slippage) };
}

/** 可买手数（100 股整数倍），现金约束 */
export function maxBuyShares(s, price) {
  const p = price * (1 + COST.slippage);
  let lots = Math.floor(s.cash / (p * COST.lotSize));
  while (lots > 0) {
    const shares = lots * COST.lotSize;
    const { fee } = buyCost(p, shares);
    if (shares * p + fee <= s.cash) return shares;
    lots--;
  }
  return 0;
}

/**
 * 按目标金额买入
 * @param {string} date 交易日
 * @param {string} phase 阶段标签：开盘交易 / 止损卖出 等
 */
export function doBuy(s, { code, name, price, targetAmount, date, reason }) {
  if (!(price > 0)) return null;
  const p = price * (1 + COST.slippage);
  let lots = Math.floor(targetAmount / (p * COST.lotSize));
  while (lots > 0) {
    const shares = lots * COST.lotSize;
    const { fee } = buyCost(p, shares);
    if (shares * p + fee <= s.cash) break;
    lots--;
  }
  const shares = lots * COST.lotSize;
  if (shares <= 0) return null;
  const { fee, total } = buyCost(p, shares);
  s.cash -= total;
  const pos = s.positions[code] || {
    code,
    name,
    shares: 0,
    avgCost: 0,
    openDate: date,
    highClose: price,
    coolDownUntil: null,
  };
  const newShares = pos.shares + shares;
  pos.avgCost = (pos.avgCost * pos.shares + p * shares + fee) / newShares;
  pos.shares = newShares;
  pos.name = name || pos.name;
  pos.lastPrice = price;
  pos.highClose = Math.max(pos.highClose || 0, price);
  s.positions[code] = pos;

  const tr = {
    date,
    time: cnTimeStr(),
    code,
    name,
    side: 'buy',
    shares,
    price: +p.toFixed(3),
    fee: +fee.toFixed(2),
    amount: +total.toFixed(2),
    reason,
    cashAfter: +s.cash.toFixed(2),
  };
  s.trades.unshift(tr);
  addEvent(s, 'buy', `买入 ${name}(${code}) ${shares}股 @${p.toFixed(2)}，用现金 ${total.toFixed(2)} 元（含费 ${fee.toFixed(2)}）`, {
    reason,
  });
  return tr;
}

export function doSell(s, { code, price, date, reason, all = true }) {
  const pos = s.positions[code];
  if (!pos || pos.shares <= 0 || !(price > 0)) return null;
  const shares = pos.shares;
  const p = price * (1 - COST.slippage);
  const { fee, total } = sellProceeds(p, shares);
  const pnl = total - pos.avgCost * shares;
  const pnlPct = pos.avgCost > 0 ? total / (pos.avgCost * shares) - 1 : 0;
  s.cash += total;

  const tr = {
    date,
    time: cnTimeStr(),
    code,
    name: pos.name,
    side: 'sell',
    shares,
    price: +p.toFixed(3),
    avgCost: +pos.avgCost.toFixed(4),
    fee: +fee.toFixed(2),
    amount: +total.toFixed(2),
    pnl: +pnl.toFixed(2),
    pnlPct: +pnlPct.toFixed(4),
    holdDays: pos.openDate ? Math.max(1, dayDiff(pos.openDate, date)) : null,
    reason,
    cashAfter: +s.cash.toFixed(2),
  };
  s.trades.unshift(tr);
  const win = pnl >= 0 ? '盈' : '亏';
  addEvent(
    s,
    'sell',
    `卖出 ${pos.name}(${code}) ${shares}股 @${p.toFixed(2)}，回款 ${total.toFixed(2)} 元，${win} ${pnl.toFixed(2)} 元 (${(pnlPct * 100).toFixed(2)}%)`,
    { reason }
  );
  delete s.positions[code];
  return tr;
}

function dayDiff(a, b) {
  const t1 = Date.parse(a + 'T00:00:00Z');
  const t2 = Date.parse(b + 'T00:00:00Z');
  return Math.round((t2 - t1) / 86400000);
}

/** 总资产（用给定价格表盯市，缺失则用 lastPrice / avgCost） */
export function totalAssets(s, priceOf = () => null) {
  let mv = 0;
  for (const pos of Object.values(s.positions)) {
    const pr = priceOf(pos.code) ?? pos.lastPrice ?? pos.avgCost;
    mv += pr * pos.shares;
  }
  return { cash: s.cash, mktValue: mv, total: s.cash + mv };
}

/** 记录每日净值快照 */
export function snapshot(s, date, indexClose) {
  const { cash, mktValue, total } = totalAssets(s, (c) => s.positions[c]?.lastPrice);
  const last = s.snapshots[s.snapshots.length - 1];
  const rec = {
    date,
    total: +total.toFixed(2),
    cash: +cash.toFixed(2),
    mktValue: +mktValue.toFixed(2),
    index: indexClose ?? (last ? last.index : null),
  };
  const i = s.snapshots.findIndex((x) => x.date === date);
  if (i >= 0) s.snapshots[i] = rec;
  else s.snapshots.push(rec);
  if (s.snapshots.length > 2000) s.snapshots = s.snapshots.slice(-2000);
  return rec;
}
