// 心跳：执行待办 -> 更新持仓 -> 扫描 -> 生成并挂出交易计划
import { runScan } from './lib/scan.js';
import { fetchQuotes, fetchIndex, INDEX_SH } from './lib/market.js';
import {
  loadState, saveState, doBuy, doSell, snapshot, addEvent, totalAssets, log,
} from './lib/engine.js';
import { STRATEGY } from './lib/strategy.js';
import { cnDateStr, cnTimeStr, writeJson, dataDir, acquireLockAsync, releaseLock, log as logStore } from './lib/store.js';
import path from 'node:path';

export const LIVE = { dryRun: false };

/** 是否 A 股连续竞价时段（北京时间 9:30-11:30 / 13:00-15:00） */
export function inTradingWindow(d = new Date()) {
  const x = new Date(d.getTime() + 8 * 3600 * 1000);
  const day = x.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hm = x.getUTCHours() * 60 + x.getUTCMinutes();
  return (hm >= 570 && hm <= 690) || (hm >= 780 && hm <= 900);
}

/** 猜下一个交易日（跳周末）；真实执行时用最新指数日期校验 */
export function nextTradingDateGuess(lastDate) {
  const t = Date.parse(lastDate + 'T00:00:00Z');
  for (let i = 1; i <= 10; i++) {
    const d = new Date(t + i * 86400000);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) return d.toISOString().slice(0, 10);
  }
  return lastDate;
}

/** 补计交易日序号（心跳可能断档） */
export function syncTradeDaySeq(s, indexBars) {
  const dates = indexBars.map((b) => b.date);
  const last = s.lastTradingDay;
  if (!last) {
    s.tradeDaySeq = s.tradeDaySeq || 0;
    s.lastTradingDay = dates[dates.length - 1];
    return 0;
  }
  const i = dates.indexOf(last);
  const added = i >= 0 ? dates.length - 1 - i : 1;
  if (added > 0) {
    s.tradeDaySeq = (s.tradeDaySeq || 0) + added;
    s.lastTradingDay = dates[dates.length - 1];
  }
  return added;
}

/** 执行待办：以当日开盘价成交（开盘价来自实时行情） */
async function executePending(s, today, quotes) {
  const list = s.pending || [];
  if (!list.length) return [];
  const done = [];

  for (const p of list.filter((x) => x.action === 'sell')) {
    const q = quotes[p.code];
    const price = q?.open || q?.price;
    if (!(price > 0)) { log(`跳过卖出 ${p.name}：取不到有效开盘价`); continue; }
    const tr = doSell(s, { code: p.code, price, date: today, reason: p.reason });
    if (tr) {
      done.push(tr);
      s.coolDown = s.coolDown || {};
      s.coolDown[p.code] = today;
      s.coolDownSeq = s.coolDownSeq || {};
      s.coolDownSeq[p.code] = s.tradeDaySeq || 0;
    }
  }

  const taNow = totalAssets(s, (c) => quotes[c]?.price ?? s.positions[c]?.lastPrice);
  const perAmount = taNow.total * STRATEGY.positionPct;
  const maxExposure = s.lastScan?.weather?.above ? STRATEGY.maxExposureStrong : STRATEGY.maxExposureWeak;
  for (const p of list.filter((x) => x.action === 'buy')) {
    if (s.positions[p.code]) continue;
    const q = quotes[p.code];
    const price = q?.open || q?.price;
    if (!(price > 0)) { log(`跳过买入 ${p.name}：取不到有效开盘价`); continue; }
    if (Object.keys(s.positions).length >= STRATEGY.maxPositions) { log(`跳过买入 ${p.name}：持仓已满`); continue; }
    // 总敞口上限（弱势 60% / 强势 95%）：按最新价重算当前市值
    const mvNow = Object.values(s.positions).reduce((a, x) => a + (quotes[x.code]?.price ?? x.lastPrice ?? x.avgCost) * x.shares, 0);
    if ((mvNow + perAmount) / taNow.total > maxExposure + 1e-6) {
      log(`跳过买入 ${p.name}：总敞口将达 ${(((mvNow + perAmount) / taNow.total) * 100).toFixed(1)}%，超过当期上限 ${(maxExposure * 100).toFixed(0)}%`);
      continue;
    }
    const cashFloor = taNow.total * STRATEGY.minCashPct;
    const budget = Math.min(perAmount, Math.max(0, s.cash - cashFloor));
    if (budget < price * 100 * 1.001) { log(`跳过买入 ${p.name}：资金不足（一手需 ${(price * 100).toFixed(0)}，预算 ${budget.toFixed(0)}）`); continue; }
    const tr = doBuy(s, { code: p.code, name: p.name, price, targetAmount: budget, date: today, reason: p.reason });
    if (tr) done.push(tr);
  }

  s.pending = [];
  return done;
}

/** 冷却期：卖出后 5 个交易日内不回购 */
export function isCooling(s, code) {
  const seq = s.coolDownSeq?.[code];
  if (seq == null) return false;
  return (s.tradeDaySeq || 0) - seq < STRATEGY.noRebuyDays;
}

/** 生成卖出（止损/止盈/换仓）与买入信号 */
export function buildSignals(s, scan, today) {
  const weather = scan.weather;
  const ranked = scan.candidates;
  const rankOf = new Map(ranked.map((c, i) => [c.code, i + 1]));
  const exit = [];
  const enter = [];
  const held = Object.keys(s.positions).length;

  // 资金闸门：执行时用的预算 = min(总资产×18%, 可用现金 - 现金底线)
  const priceOf = (code) => {
    const c = ranked.find((x) => x.code === code);
    return c?.close ?? s.positions[code]?.lastPrice ?? s.positions[code]?.avgCost;
  };
  const cash = Number.isFinite(s.cash) ? s.cash : 0;
  const mvNow = Object.values(s.positions).reduce((a, p) => a + (p.lastPrice ?? p.avgCost ?? 0) * p.shares, 0);
  const totalNow = cash + mvNow;
  const budget = Math.min(totalNow * STRATEGY.positionPct, Math.max(0, cash - totalNow * STRATEGY.minCashPct));
  // 总敞口上限：弱势 60% / 强势 95%
  const maxExposure = weather.above ? STRATEGY.maxExposureStrong : STRATEGY.maxExposureWeak;
  const exposureRoom = Math.max(0, totalNow * maxExposure - mvNow);
  const affordable = (code) => {
    const p = priceOf(code);
    // 缺价格/缺现金数据时不做拦截（交由执行阶段兜底），避免状态不完整就误杀信号
    if (!Number.isFinite(p) || p <= 0) return true;
    if (!Number.isFinite(budget) || totalNow <= 0) return true;
    const lot = p * 100 * 1.001;
    return lot <= budget && lot <= exposureRoom;
  };

  for (const [code, pos] of Object.entries(s.positions)) {
    const price = pos.lastPrice ?? pos.avgCost;
    const ret = price / pos.avgCost - 1;
    if (ret <= STRATEGY.stopLoss) {
      exit.push({
        code, name: pos.name, action: 'sell',
        reason: `止损：现价 ${price.toFixed(2)} vs 成本 ${pos.avgCost.toFixed(3)}，亏 ${(ret * 100).toFixed(2)}%（阈值 ${(STRATEGY.stopLoss * 100).toFixed(0)}%）`,
      });
      continue;
    }
    const dd = pos.highClose ? price / pos.highClose - 1 : 0;
    if (ret > 0 && dd <= STRATEGY.trailDrawdown) {
      exit.push({
        code, name: pos.name, action: 'sell',
        reason: `移动止盈：最高收盘 ${pos.highClose.toFixed(2)} 回撤 ${(dd * 100).toFixed(2)}%（阈值 ${(-STRATEGY.trailDrawdown * 100).toFixed(0)}%），落袋 +${(ret * 100).toFixed(2)}%`,
      });
      continue;
    }
    const r = rankOf.get(code);
    if (r == null) {
      exit.push({ code, name: pos.name, action: 'sell', reason: '换仓：已跌出候选池前 30 名（动能消失）' });
    } else if (r > STRATEGY.maxPositions && r > 10) {
      exit.push({ code, name: pos.name, action: 'sell', reason: `换仓：动能排名跌至第 ${r} 名，持仓只保留前 ${STRATEGY.maxPositions}` });
    }
  }

  const willHold = held - exit.length;
  const isWeak = !weather.above;
  for (const c of ranked.slice(0, 10)) {
    if (willHold + enter.length >= STRATEGY.maxPositions) break;
    if (s.positions[c.code] || enter.find((e) => e.code === c.code)) continue;
    if (isCooling(s, c.code)) continue;
    if (isWeak && enter.length >= 1) break; // 弱势市场每次最多新增 1 只
    if (rankOf.get(c.code) <= STRATEGY.maxPositions) {
      if (!affordable(c.code)) continue; // 一手就超出可用预算（高价股），挂单也会被拒
      enter.push({
        code: c.code, name: c.name, action: 'buy',
        reason: `动能第 ${rankOf.get(c.code)} 名：20日 ${(c.r20 * 100).toFixed(1)}%、60日 ${(c.r60 * 100).toFixed(1)}%、波动 ${(c.vol * 100).toFixed(1)}%，得分 ${c.score.toFixed(3)}`,
      });
    }
  }
  return { exit, enter };
}

export function saveScan(scan) {
  writeJson(path.join(dataDir(), 'last-scan.json'), scan);
}

export async function tick({ force = false, quiet = false, now = new Date(), noLock = false } = {}) {
  const def = !quiet;
  if (!noLock) {
    const lock = await acquireLockAsync('tick', 90000, def ? (m) => logStore(m) : null);
    if (!lock.ok) {
      if (def) logStore(`心跳被跳过：另一实例持续占用（pid ${lock.holder?.pid}）`);
      return { skipped: true, reason: 'locked' };
    }
  }
  try {
    return await tickInner({ force, quiet, now });
  } finally {
    if (!noLock) releaseLock('tick');
  }
}

async function tickInner({ force = false, quiet = false, now = new Date() } = {}) {
  const def = !quiet;
  const s = loadState();
  const today = cnDateStr(now);

  const idx = await fetchIndex(INDEX_SH, 60);
  const lastBar = idx.bars[idx.bars.length - 1];
  const latestTradingDay = lastBar.date;
  const dayAdvanced = syncTradeDaySeq(s, idx.bars);

  const watch = new Set([...Object.keys(s.positions), ...(s.pending || []).map((p) => p.code)]);
  const quotes = watch.size ? await fetchQuotes([...watch]) : {};

  // 1) 执行待办（开盘后、且已跨入新交易日；force 为测试用强制通道）
  let executed = [];
  const pendingExec = s.pending?.[0]?.execDate;
  const canExec = s.pending?.length && (force || (inTradingWindow(now) && pendingExec && today >= pendingExec && dayAdvanced > 0));
  if (canExec && !LIVE.dryRun) {
    executed = await executePending(s, today, quotes);
    if (executed.length) addEvent(s, 'exec', `开盘执行交易计划 ${executed.length} 笔（成交价=当日开盘价）`);
    else log('待办执行完毕：无可成交标的');
  } else if (s.pending?.length && def) {
    log(`有待办 ${s.pending.length} 条，等待 ${pendingExec} 开盘（当前 ${today} ${cnTimeStr(now)}）`);
  }

  // 2) 更新持仓最新价与持仓期最高收盘
  for (const [code, pos] of Object.entries(s.positions)) {
    const q = quotes[code];
    const price = q?.price && q.price > 0 ? q.price : pos.lastPrice;
    if (price > 0) {
      pos.lastPrice = price;
      pos.highClose = Math.max(pos.highClose || 0, price, pos.avgCost);
    }
  }

  // 3) 扫描（落后最新交易日 或 强制）
  const needScan = force || !s.lastScan || s.lastScan.asOf !== latestTradingDay || !s.lastScan.candidates?.length;
  if (needScan) {
    const scan = await runScan({ verbose: def });
    s.lastScan = scan;
    s.strategy = scan.strategy;
    saveScan(scan);
  } else if (def) {
    log(`沿用上次扫描结果 asOf=${s.lastScan.asOf}`);
  }

  // 4) 信号
  const signals = buildSignals(s, s.lastScan, today);

  // 5) 挂待办
  const hasPending = (s.pending || []).length > 0;
  if ((signals.exit.length || signals.enter.length) && !hasPending) {
    const execDate = nextTradingDateGuess(latestTradingDay);
    s.pending = [...signals.exit, ...signals.enter].map((x) => ({ ...x, execDate, createdAt: `${today} ${cnTimeStr(now)}` }));
    addEvent(s, 'plan', `挂出交易计划（${execDate} 开盘执行）：卖出 ${signals.exit.length} 只 / 买入 ${signals.enter.length} 只`, { signals });
    if (def) {
      console.log(`\n▶ 计划于 ${execDate} 开盘执行：`);
      if (!signals.exit.length && !signals.enter.length) console.log('   （无动作）');
      signals.exit.forEach((e) => console.log(`   [卖] ${e.name} — ${e.reason}`));
      signals.enter.forEach((e) => console.log(`   [买] ${e.name} — ${e.reason}`));
    }
  } else if (hasPending && def) {
    log(`已有 ${s.pending.length} 条待办，本次不重复挂单`);
  }

  // 6) 快照 + 落盘
  snapshot(s, latestTradingDay, lastBar.close);
  if (!LIVE.dryRun) saveState(s);

  const ta = totalAssets(s, (c) => s.positions[c]?.lastPrice ?? quotes[c]?.price);
  if (def) log(`总资产 ${ta.total.toFixed(2)}（现金 ${s.cash.toFixed(2)}，市值 ${ta.mktValue.toFixed(2)}，持仓 ${Object.keys(s.positions).length} 只）`);
  return {
    today, latestTradingDay, executedCount: executed.length, signals,
    positions: Object.keys(s.positions).length, total: ta.total,
  };
}

// 命令行直接运行：node src/tick.js [--force]
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/src/tick.js')) {
  const force = process.argv.includes('--force');
  tick({ force, quiet: false })
    .then((r) => { log('心跳完成', JSON.stringify(r)); })
    .catch((e) => { console.error('心跳失败：', e); process.exit(1); });
}
