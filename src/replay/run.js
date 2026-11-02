// 回放执行器 CLI
//   node src/replay/run.js context <日期>            看盘：账户 + 市场环境 + 候选 + 触发提示（无未来函数）
//   node src/replay/run.js run <计划文件>            按计划逐日执行，产出账户/成交/净值曲线
//   node src/replay/run.js baseline                  跑机械规则基线（与实盘同一套规则）做对照
import fs from 'node:fs';
import path from 'node:path';
import {
  market, tradingDays, rankAt, weatherAt, newAccount, buy, sell, markToMarket, totalAssets,
  barAt, barsUpTo, COST, STRATEGY, INITIAL_CAPITAL,
} from './engine.js';

const OUT_DIR = path.join(process.cwd(), 'data', 'replay');

const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (x, d = 2) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');

function ensureDays(from, to) {
  const days = tradingDays();
  const i0 = from ? days.findIndex((d) => d >= from) : 0;
  const i1 = to ? days.findIndex((d) => d > to) : days.length;
  return days.slice(i0, i1 < 0 ? days.length : i1);
}

/** 账户在某天的持仓视图（含浮盈、持仓天数、相对最高收盘的回撤） */
function positionView(a, date) {
  return Object.values(a.positions).map((p) => {
    const b = barAt(p.code, date);
    const close = b?.close ?? p.lastPrice ?? p.avgCost;
    const mv = close * p.shares;
    const ret = close / p.avgCost - 1;
    const dd = p.highClose ? close / p.highClose - 1 : 0;
    return {
      code: p.code, name: p.name, shares: p.shares,
      avgCost: +p.avgCost.toFixed(3), close: +close.toFixed(2),
      value: +mv.toFixed(2), pnl: +(mv - p.avgCost * p.shares).toFixed(2), ret, dd,
      highClose: +(p.highClose ?? 0).toFixed(2),
      holdBars: barsUpTo(p.code, date)?.length ?? 0,
      rank: rankAt(date).findIndex((c) => c.code === p.code) + 1 || null,
    };
  });
}

/** 决策上下文：日子、账户、市场、候选、提示 */
export function buildContext(a, date, { top = 20 } = {}) {
  const weather = weatherAt(date);
  const cands = rankAt(date, { top: 30, gate: weather.gate });
  const view = positionView(a, date);
  const ta = totalAssets(a, (c) => view.find((v) => v.code === c)?.close ?? null);

  // 触发提示：止损线 / 止盈线 / 排名掉出
  const alerts = [];
  for (const v of view) {
    if (v.ret <= STRATEGY.stopLoss) alerts.push({ code: v.code, name: v.name, kind: '止损触发', detail: `浮亏 ${pct(v.ret)}（阈值 ${(STRATEGY.stopLoss * 100).toFixed(0)}%）` });
    else if (v.ret > 0 && v.dd <= STRATEGY.trailDrawdown) alerts.push({ code: v.code, name: v.name, kind: '止盈触发', detail: `自最高收盘 ${fmt(v.highClose)} 回撤 ${pct(v.dd)}（阈值 ${(-STRATEGY.trailDrawdown * 100).toFixed(0)}%）` });
    if (v.rank == null) alerts.push({ code: v.code, name: v.name, kind: '掉出候选池', detail: '已不在前 30 名' });
    else if (v.rank > 10) alerts.push({ code: v.code, name: v.name, kind: '排名下滑', detail: `跌至第 ${v.rank} 名（规则：>10 名应换出）` });
  }

  return {
    date,
    weather,
    account: { cash: +a.cash.toFixed(2), mktValue: +ta.mktValue.toFixed(2), total: +ta.total.toFixed(2), positionPct: ta.mktValue / ta.total },
    positions: view,
    alerts,
    candidates: cands.slice(0, top).map((c, i) => ({
      rank: i + 1, code: c.code, name: c.name, close: +c.close.toFixed(2),
      score: +c.score.toFixed(4), r20: +c.r20.toFixed(4), r60: +c.r60.toFixed(4), vol: +c.vol.toFixed(4),
      lotCost: +(c.close * 100).toFixed(0),
    })),
    rules: STRATEGY.rules,
  };
}

function printContext(ctx) {
  console.log(`\n================ 决策日 ${ctx.date} ================`);
  const w = ctx.weather;
  console.log(`市场：上证 ${fmt(w.indexClose)} vs MA20 ${fmt(w.ma20)} -> ${w.above ? '强势' : '弱势（分数×0.5，总敞口≤60%，每次最多新增1只）'}  近5日 ${pct(w.chg5)}`);
  console.log(`账户：总资产 ${fmt(ctx.account.total)}（现金 ${fmt(ctx.account.cash)}，市值 ${fmt(ctx.account.mktValue)}，仓位 ${(ctx.account.positionPct * 100).toFixed(1)}%）`);
  if (ctx.positions.length) {
    console.log('\n持仓：');
    for (const p of ctx.positions) {
      console.log(`  ${p.name}(${p.code}) ${p.shares}股 成本${p.avgCost} 现价${p.close} 盈亏${p.pnl}（${pct(p.ret)}）持仓期最高${p.highClose} ${p.rank ? '排名第' + p.rank : '已掉出候选'}`);
    }
  } else console.log('\n持仓：空仓');
  if (ctx.alerts.length) {
    console.log('\n⚠️ 触发提示（按规则应当处理）：');
    for (const a of ctx.alerts) console.log(`  [${a.kind}] ${a.name}(${a.code}) — ${a.detail}`);
  } else console.log('\n（无规则触发提示）');
  console.log(`\n候选排名 Top${ctx.candidates.length}（截至 ${ctx.date} 收盘，得分已含市场开关）：`);
  console.log('  #  标的            现价     得分    20日     60日     波动    一手成本');
  for (const c of ctx.candidates) {
    console.log(`  ${String(c.rank).padStart(2)} ${c.name.padEnd(8, '　')}(${c.code}) ${String(c.close).padStart(8)} ${String(c.score).padStart(7)} ${pct(c.r20, 1).padStart(8)} ${pct(c.r60, 1).padStart(8)} ${(c.vol * 100).toFixed(1).padStart(6)}% ${String(c.lotCost).padStart(8)}`);
  }
}

/**
 * 决定「明天买哪几只」，挂成待办在次日开盘成交。
 * 两种模式共用同一套硬约束（5 只上限 / 18% 单只 / 10% 现金底线 / 弱势 60% 敞口上限 / 弱势每次最多新增 1 只）：
 *  - mechanical：完全按动能排名买前几名
 *  - agent：在规则框架内由人来定「买几只」并从排名里挑（buyPick 指定优先顺序，blockBuys 排除）
 */
export function decideBuys(a, date, weather, cash, report, { mode = 'mechanical', buyCount = null, pick = null, block = [], maxBuys = null } = {}) {
  const ranked = rankAt(date, { top: 30, gate: weather.gate });
  const rankOf = new Map(ranked.map((c, i) => [c.code, i + 1]));

  // 换仓卖出（规则）：排名跌出前 10
  const sellSet = new Set(a.pending.filter((p) => p.action === 'sell').map((p) => p.code));
  for (const p of Object.values(a.positions)) {
    const r = rankOf.get(p.code);
    if (r == null || (r > STRATEGY.maxPositions && r > 10)) {
      if (!sellSet.has(p.code)) {
        a.pending.push({ action: 'sell', code: p.code, name: p.name, reason: `规则换仓：动能排名${r == null ? '掉出前 30' : `第 ${r} 名`}` });
        sellSet.add(p.code);
      }
    }
  }

  const mvNow = Object.values(a.positions).reduce((s, p) => s + (barAt(p.code, date)?.close ?? p.lastPrice) * p.shares, 0);
  const total = cash + mvNow;
  const maxExp = weather.above ? STRATEGY.maxExposureStrong : STRATEGY.maxExposureWeak;
  const room = Math.max(0, total * maxExp - mvNow);
  const budget = Math.min(total * STRATEGY.positionPct, Math.max(0, cash - total * STRATEGY.minCashPct), room);
  let slots = STRATEGY.maxPositions - (Object.keys(a.positions).length - sellSet.size);
  if (slots <= 0) return [];

  // 候选顺序
  let order;
  if (mode === 'agent' && Array.isArray(pick) && pick.length) {
    const byCode = new Map(ranked.map((c) => [c.code, c]));
    order = pick.map((code) => byCode.get(code)).filter(Boolean);
    for (const c of ranked) if (!order.find((x) => x.code === c.code)) order.push(c);
  } else {
    order = ranked;
  }

  let want = mode === 'agent' ? (Number.isFinite(buyCount) ? buyCount : 0) : slots;
  if (Number.isFinite(maxBuys)) want = Math.min(want, maxBuys);
  if (!weather.above) want = Math.min(want, 1); // 弱势市场每次最多新增 1 只
  want = Math.min(want, slots);

  const held = new Set(Object.keys(a.positions));
  const blocked = new Set(block);
  const planned = [];
  for (const c of order.slice(0, 12)) {
    if (planned.length >= want) break;
    if (held.has(c.code) || blocked.has(c.code)) continue;
    if (sellSet.has(c.code)) continue;
    if (rankOf.get(c.code) > 10) continue; // 只在有动能的标的里挑
    if (c.close * 100 * 1.001 > budget) continue; // 一手买不起
    a.pending.push({
      action: 'buy', code: c.code, name: c.name,
      reason: mode === 'agent'
        ? `主动建仓：动能第 ${rankOf.get(c.code)} 名（得分 ${c.score.toFixed(3)}，20日 ${(c.r20 * 100).toFixed(1)}%）`
        : `规则建仓：动能第 ${rankOf.get(c.code)} 名（得分 ${c.score.toFixed(3)}）`,
    });
    held.add(c.code);
    planned.push(c.code);
  }
  return planned;
}

/** ------------------------------------------------------------------
 * 执行一份「计划」：{ "2026-07-21": { buyCount:2, buyPick:["601811"], blockBuys:[], sells:[{code,reason}], note:"..." }, ... }
 * 决策日 D 的指令在 D+1 开盘成交。规则止损/止盈/换仓的卖出始终自动执行（引擎负责，不需要人猜未来）。
 * ------------------------------------------------------------------ */
export function runPlan(plan, { start, end, autoRules = true, mechanical = false, verbose = true, buyGate = null, maxBuysPerDay = null } = {}) {
  const days = ensureDays(start, end);
  const a = newAccount();
  const report = { start: days[0], end: days[days.length - 1], decisions: [], skipped: [] };

  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    a.curDate = date;

    // 1) 开盘：执行上一个决策日的待办
    if (a.pending.length) {
      const q = a.pending;
      a.pending = [];
      const executed = [];
      for (const o of q.filter((x) => x.action === 'sell')) {
        const b = barAt(o.code, date);
        if (!b) { report.skipped.push({ date, code: o.code, why: '停牌/无行情' }); continue; }
        if (a.positions[o.code]?.openDate === date) { report.skipped.push({ date, code: o.code, why: 'T+1 当日买入不可卖' }); continue; }
        const tr = sell(a, { code: o.code, open: b.open, date, reason: o.reason });
        if (tr) executed.push(tr);
      }
      const ta = totalAssets(a, (c) => barAt(c, date)?.open ?? a.positions[c]?.lastPrice);
      const weather = weatherAt(days[Math.max(0, i - 1)]);
      const maxExp = weather.above ? STRATEGY.maxExposureStrong : STRATEGY.maxExposureWeak;
      const perAmount = ta.total * STRATEGY.positionPct;
      const mvAtOpen = () => Object.values(a.positions).reduce((s, p) => s + (barAt(p.code, date)?.open ?? p.lastPrice) * p.shares, 0);
      for (const o of q.filter((x) => x.action === 'buy')) {
        if (a.positions[o.code]) continue;
        if (Object.keys(a.positions).length >= STRATEGY.maxPositions) { report.skipped.push({ date, code: o.code, why: '持仓已满 5 只' }); continue; }
        const b = barAt(o.code, date);
        if (!b || !(b.open > 0)) { report.skipped.push({ date, code: o.code, why: '停牌/无开盘价' }); continue; }
        if ((mvAtOpen() + perAmount) / ta.total > maxExp + 1e-6) { report.skipped.push({ date, code: o.code, why: `敞口将超 ${(maxExp * 100).toFixed(0)}% 上限` }); continue; }
        const cashFloor = ta.total * STRATEGY.minCashPct;
        const budget = Math.min(perAmount, Math.max(0, a.cash - cashFloor));
        if (budget < b.open * 100 * 1.001) { report.skipped.push({ date, code: o.code, why: `一手 ${(b.open * 100).toFixed(0)} 元超预算 ${budget.toFixed(0)} 元` }); continue; }
        const tr = buy(a, { code: o.code, name: market().stocks[o.code]?.name, open: b.open, targetAmount: budget, date, reason: o.reason });
        if (tr) executed.push(tr);
      }
      report.decisions.push({ date, phase: '开盘执行', executed: executed.map((t) => ({ side: t.side, code: t.code, name: t.name, shares: t.shares, price: t.price, pnl: t.pnl ?? null, reason: t.reason })) });
    }

    // 2) 收盘盯市
    const snap = markToMarket(a, date);

    // 3) 收盘后：规则止损/止盈自动排队（换仓卖出由 decideBuys 处理）
    if (autoRules) {
      const queued = new Set(a.pending.filter((p) => p.action === 'sell').map((p) => p.code));
      for (const p of Object.values(a.positions)) {
        if (queued.has(p.code)) continue;
        const b = barAt(p.code, date);
        if (!b) continue;
        const ret = b.close / p.avgCost - 1;
        const dd = p.highClose ? b.close / p.highClose - 1 : 0;
        if (ret <= STRATEGY.stopLoss) {
          a.pending.push({ action: 'sell', code: p.code, name: p.name, reason: `规则止损：浮亏 ${pct(ret)}（阈值 ${(STRATEGY.stopLoss * 100).toFixed(0)}%）` });
          queued.add(p.code);
        } else if (ret > 0 && dd <= STRATEGY.trailDrawdown) {
          a.pending.push({ action: 'sell', code: p.code, name: p.name, reason: `规则止盈：自持仓期最高收盘 ${fmt(p.highClose)} 回撤 ${pct(dd)}` });
          queued.add(p.code);
        }
      }
    }

    const todays = plan?.[date];
    if (todays) {
      report.decisions.push({
        date, phase: '决策',
        note: todays.note ?? null,
        sellCount: (todays.sells || []).length,
        buyCount: todays.buyCount ?? null,
      });
      for (const s of todays.sells || []) {
        if (!a.positions[s.code]) continue;
        a.pending = a.pending.filter((p) => p.code !== s.code);
        a.pending.push({ action: 'sell', code: s.code, name: a.positions[s.code].name, reason: s.reason || '主动卖出' });
      }
    }

    // 收盘后决定「买哪几只」：机械模式=完全按规则；agent 模式=在规则框架内挑选（buyPick 可覆盖排序）
    const weatherNow = weatherAt(date);
    const gateOpen = buyGate ? buyGate(weatherNow, date, a, report) : true;
    if ((mechanical || !plan) && gateOpen) {
      decideBuys(a, date, weatherNow, a.cash, report, { mode: 'mechanical', maxBuys: maxBuysPerDay });
    } else if ((mechanical || !plan) && !gateOpen) {
      report.skipped.push({ date, why: '建仓闸门关闭（趋势过滤）' });
    } else if (todays) {
      decideBuys(a, date, weatherNow, a.cash, report, {
        mode: 'agent',
        buyCount: todays.buyCount ?? 0,
        pick: todays.buyPick || null,
        block: todays.blockBuys || [],
      });
    }
  }

  // 汇总
  const last = a.snapshots.at(-1);
  a.final = {
    total: last.total,
    pnl: +(last.total - INITIAL_CAPITAL).toFixed(2),
    pnlPct: last.total / INITIAL_CAPITAL - 1,
    trades: a.trades.length,
    winRate: (() => {
      const s = a.trades.filter((t) => t.side === 'sell');
      if (!s.length) return null;
      return s.filter((t) => t.pnl > 0).length / s.length;
    })(),
    maxDrawdown: (() => {
      let peak = -Infinity, mdd = 0;
      for (const s of a.snapshots) { peak = Math.max(peak, s.total); mdd = Math.min(mdd, s.total / peak - 1); }
      return mdd;
    })(),
  };
  report.account = a;
  if (verbose) printSummary(a);
  return { account: a, report };
}

function printSummary(a) {
  const f = a.final;
  console.log(`\n================ 回放结果 ================`);
  console.log(`区间：${a.snapshots[0].date} ~ ${a.snapshots.at(-1).date}（${a.snapshots.length} 个交易日）`);
  console.log(`本金 ${fmt(INITIAL_CAPITAL, 0)} -> 总资产 ${fmt(f.total)}  盈亏 ${f.pnl >= 0 ? '+' : ''}${fmt(f.pnl)}（${pct(f.pnlPct)}）`);
  console.log(`最大回撤 ${pct(f.maxDrawdown)} | 成交 ${f.trades} 笔 | 卖出胜率 ${f.winRate == null ? '—' : (f.winRate * 100).toFixed(0) + '%'}`);
  console.log('\n成交明细：');
  for (const t of a.trades) {
    console.log(`  ${t.date} ${t.side === 'buy' ? '买' : '卖'} ${t.name}(${t.code}) ${t.shares}股 @${t.price}${t.side === 'sell' ? ` 盈亏${t.pnl >= 0 ? '+' : ''}${t.pnl}(${pct(t.pnlPct)})` : ''} — ${t.reason}`);
  }
  if (a.trades.length === 0) console.log('  （无成交）');
}

// ---------------- CLI ----------------
const [cmd, arg1, arg2] = process.argv.slice(2);

if (cmd === 'context') {
  const a = fs.existsSync(path.join(OUT_DIR, 'agent-state.json'))
    ? Object.assign(newAccount(), JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'agent-state.json'), 'utf8')))
    : newAccount();
  const date = arg1 || tradingDays().at(-1);
  printContext(buildContext(a, date));
  console.log('\n（把决策写成 JSON 计划文件后，用 node src/replay/run.js run <计划文件> 执行）');
} else if (cmd === 'run') {
  const plan = JSON.parse(fs.readFileSync(arg1, 'utf8'));
  const { account, report } = runPlan(plan, { start: arg2 || undefined });
  fs.writeFileSync(path.join(OUT_DIR, 'agent-state.json'), JSON.stringify(account, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'agent-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n账户与报告已写入 data/replay/agent-state.json、agent-report.json`);
} else if (cmd === 'baseline') {
  const start = arg1 || '2026-02-02';
  const { account } = runPlan(null, { start, mechanical: true, autoRules: true });
  fs.writeFileSync(path.join(OUT_DIR, 'baseline-state.json'), JSON.stringify(account, null, 2));
  console.log(`\n基线账户已写入 data/replay/baseline-state.json（起始 ${start}）`);
} else {
  console.log('用法：node src/replay/run.js context <日期> | run <计划文件> [起始日] | baseline');
}
