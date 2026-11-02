// 单元测试：撮合与账务的正确性（隔离数据目录，不碰真实账户）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-test-'));
process.env.DSH_PAPER_DATA = tmp;

const { newState, saveState, loadState, doBuy, doSell, buyCost, sellProceeds, maxBuyShares, totalAssets, snapshot, COST } =
  await import('../src/lib/engine.js');
const { buildSignals, isCooling, nextTradingDateGuess, inTradingWindow, syncTradeDaySeq } = await import('../src/tick.js');
const { STRATEGY } = await import('../src/lib/strategy.js');

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
};

console.log(`\n数据目录: ${tmp}\n====== 撮合与账务 ======`);

t('买入：现金扣减 = 成交额 + 手续费，持股 = 手数×100', () => {
  const s = newState();
  const price = 10;
  const tr = doBuy(s, { code: '600000', name: '测试股', price, targetAmount: 20000, date: '2026-10-16', reason: 'test' });
  assert.ok(tr, '应成交');
  const fill = price * (1 + COST.slippage);
  const expectShares = tr.shares;
  assert.strictEqual(expectShares % 100, 0, '必须是 100 股整数倍');
  const { fee, total } = buyCost(fill, expectShares);
  assert.ok(Math.abs(s.cash - (100000 - total)) < 0.01, `现金应扣 ${total}，实际 ${s.cash}`);
  assert.strictEqual(s.positions['600000'].shares, expectShares);
});

t('卖出：回款 = 成交额 - 手续费 - 印花税，盈亏记账正确', () => {
  const s = newState();
  const buy = doBuy(s, { code: '600000', name: '测试股', price: 10, targetAmount: 20000, date: '2026-10-16', reason: 't' });
  const avgCost = s.positions['600000'].avgCost;
  const cashAfterBuy = s.cash;
  const sell = doSell(s, { code: '600000', price: 12, date: '2026-10-20', reason: 't' });
  assert.ok(sell, '应成交');
  const fill = 12 * (1 - COST.slippage);
  const { total } = sellProceeds(fill, buy.shares);
  assert.ok(Math.abs(s.cash - (cashAfterBuy + total)) < 0.01, '现金应等于买入后现金 + 回款');
  assert.ok(Math.abs(sell.pnl - (total - avgCost * buy.shares)) < 0.011, `盈亏 = 回款 - 成本(${(avgCost * buy.shares).toFixed(2)})，实际 ${sell.pnl}`);
  assert.ok(sell.pnl > 0, '10 买 12 卖应盈利');
  assert.strictEqual(s.positions['600000'], undefined, '卖出后应无持仓');
});

t('卖出含印花税：卖价比买价高 0.1% 时仍应亏损（费用吃掉）', () => {
  const s = newState();
  const buy = doBuy(s, { code: '600000', name: 'T', price: 10, targetAmount: 50000, date: '2026-10-16', reason: 't' });
  const sell = doSell(s, { code: '600000', price: 10.01, date: '2026-10-17', reason: 't' });
  assert.ok(sell.pnl < 0, `微涨 0.1% 应被费用吃成亏损，实际 ${sell.pnl}`);
});

t('最大可买：不会买超现金', () => {
  const s = newState();
  s.cash = 5000;
  const shares = maxBuyShares(s, 33.33);
  const { total } = buyCost(33.33 * (1 + COST.slippage), shares);
  assert.ok(total <= 5000, `花费 ${total} 不应超过现金 5000`);
  assert.ok(total + 33.33 * (1 + COST.slippage) * 100 > 5000, '应该已经是最接近上限的手数');
});

t('总资产 = 现金 + 持仓市值（按给定价格盯市）', () => {
  const s = newState();
  doBuy(s, { code: '600000', name: 'T', price: 10, targetAmount: 20000, date: '2026-10-16', reason: 't' });
  const shares = s.positions['600000'].shares;
  const { total } = totalAssets(s, (c) => (c === '600000' ? 11 : null));
  assert.ok(Math.abs(total - (s.cash + 11 * shares)) < 0.01);
});

t('快照：同一天重复记录会覆盖而不是新增', () => {
  const s = newState();
  snapshot(s, '2026-10-16', 3716.28);
  snapshot(s, '2026-10-16', 3716.28);
  assert.strictEqual(s.snapshots.length, 1);
});

console.log('\n====== 信号规则 ======');

const mkScan = (candidates, above = true) => ({
  weather: { above, gate: above ? 1 : 0.5, indexClose: 3700, ma20: 3800 },
  candidates,
});
const mkPos = (code, avgCost, lastPrice, highClose, name = 'P' + code) => ({
  code,
  name,
  shares: 1000,
  avgCost,
  lastPrice,
  highClose,
  openDate: '2026-10-16',
});

t('止损：亏损 8% 触发卖出', () => {
  const s = { positions: { '600001': mkPos('600001', 10, 9.19, 10) }, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan([{ code: '600001', name: 'A', score: 1 }]), '2026-10-17');
  assert.strictEqual(sig.exit.length, 1);
  assert.ok(sig.exit[0].reason.includes('止损'), sig.exit[0].reason);
});

t('止损边界：亏 7.9% 不触发', () => {
  const s = { positions: { '600001': mkPos('600001', 10, 9.21, 10) }, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan([{ code: '600001', name: 'A', score: 1 }]), '2026-10-17');
  assert.strictEqual(sig.exit.length, 0);
});

t('移动止盈：盈利中从最高收盘回撤 12% 触发', () => {
  const s = { positions: { '600001': mkPos('600001', 10, 11.5, 13.2) }, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan([{ code: '600001', name: 'A', score: 1 }]), '2026-10-17');
  assert.strictEqual(sig.exit.length, 1);
  assert.ok(sig.exit[0].reason.includes('移动止盈'), sig.exit[0].reason);
});

t('移动止盈：亏损状态下不适用（由止损负责）', () => {
  const s = { positions: { '600001': mkPos('600001', 10, 9.5, 10.9) }, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan([{ code: '600001', name: 'A', score: 1 }]), '2026-10-17');
  assert.strictEqual(sig.exit.filter((e) => e.reason.includes('移动止盈')).length, 0);
});

t('换仓：排名跌到第 11 名触发卖出', () => {
  const cands = Array.from({ length: 12 }, (_, i) => ({ code: String(600100 + i), name: 'S' + i, score: 1 - i * 0.01 }));
  const s = { positions: { '600110': mkPos('600110', 10, 10.5, 10.6) }, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan(cands), '2026-10-17');
  assert.strictEqual(sig.exit.length, 1, JSON.stringify(sig));
  assert.ok(sig.exit[0].reason.includes('排名跌至第 11'), sig.exit[0].reason);
});

t('换仓：排名第 8 名不触发（前 10 名容忍区）', () => {
  const cands = Array.from({ length: 12 }, (_, i) => ({ code: String(600100 + i), name: 'S' + i, score: 1 - i * 0.01 }));
  const s = { positions: { '600107': mkPos('600107', 10, 10.5, 10.6) }, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan(cands), '2026-10-17');
  assert.strictEqual(sig.exit.length, 0, JSON.stringify(sig));
});

t('买入：强势市场最多补足 5 只', () => {
  const cands = Array.from({ length: 8 }, (_, i) => ({ code: String(600100 + i), name: 'S' + i, score: 1 - i * 0.01, r20: 0.1, r60: 0.2, vol: 0.3, close: 10 }));
  const s = { positions: {}, cash: 100000, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan(cands, true), '2026-10-17');
  assert.strictEqual(sig.enter.length, 5, JSON.stringify(sig.enter.map((x) => x.code)));
});

t('买入：弱势市场每次最多新增 1 只', () => {
  const cands = Array.from({ length: 8 }, (_, i) => ({ code: String(600100 + i), name: 'S' + i, score: 1 - i * 0.01, r20: 0.1, r60: 0.2, vol: 0.3, close: 10 }));
  const s = { positions: {}, cash: 100000, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan(cands, false), '2026-10-17');
  assert.strictEqual(sig.enter.length, 1);
});

t('资金闸门：一手超出可用预算的高价股不会被挂单', () => {
  const cands = [
    { code: '688137', name: '近岸蛋白', score: 1.0, r20: 0.5, r60: 0.8, vol: 0.3, close: 140 },
    { code: '600100', name: '便宜股', score: 0.9, r20: 0.4, r60: 0.6, vol: 0.3, close: 10 },
  ];
  // 现金 50000、无持仓：单只预算 18%×50000=9000，一手 14000 买不起
  const s = { positions: {}, cash: 50000, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan(cands, true), '2026-10-17');
  assert.ok(!sig.enter.find((e) => e.code === '688137'), '高价股不应被挂单');
  assert.ok(sig.enter.find((e) => e.code === '600100'), '应跳过贵的、买入买得起的');
});

t('资金闸门：现金充足时高价股可以挂单', () => {
  const cands = [{ code: '688137', name: '近岸蛋白', score: 1.0, r20: 0.5, r60: 0.8, vol: 0.3, close: 100 }];
  const s = { positions: {}, cash: 100000, tradeDaySeq: 0, coolDownSeq: {} };
  const sig = buildSignals(s, mkScan(cands, true), '2026-10-17');
  assert.strictEqual(sig.enter.length, 1, '一手 10000 ≤ 预算 18000，应可挂单');
});

t('总敞口上限：弱势市场持仓已达 59% 时不再追加买入', () => {
  const cands = [{ code: '600100', name: '便宜股', score: 1.0, r20: 0.5, r60: 0.8, vol: 0.3, close: 10 }];
  const s = {
    positions: { '000001': { code: '000001', name: '老仓', shares: 5000, avgCost: 10, lastPrice: 11.8, highClose: 11.8 } },
    cash: 41000, tradeDaySeq: 0, coolDownSeq: {},
  };
  // 总资产 = 41000 + 59000 = 100000，市值占比 59% -> 弱势上限 60%，只剩 1000 元空间
  const sig = buildSignals(s, mkScan(cands, false), '2026-10-17');
  assert.strictEqual(sig.enter.length, 0, `应因敞口上限被拦，实际 ${JSON.stringify(sig.enter)}`);
});

t('总敞口上限：强势市场上限 95%，同样状态可以买入', () => {
  const cands = [{ code: '600100', name: '便宜股', score: 1.0, r20: 0.5, r60: 0.8, vol: 0.3, close: 10 }];
  const s = {
    positions: { '000001': { code: '000001', name: '老仓', shares: 5000, avgCost: 10, lastPrice: 11.8, highClose: 11.8 } },
    cash: 41000, tradeDaySeq: 0, coolDownSeq: {},
  };
  const sig = buildSignals(s, mkScan(cands, true), '2026-10-17');
  assert.strictEqual(sig.enter.length, 1, '强势市场应允许买入');
});

t('冷却期：卖出后 5 个交易日内不再买入该股', () => {
  const cands = [{ code: '600100', name: 'S', score: 1, r20: 0.1, r60: 0.2, vol: 0.3 }];
  const s = { positions: {}, coolDownSeq: { '600100': 0 }, tradeDaySeq: 3, coolDown: {} };
  assert.strictEqual(isCooling(s, '600100'), true, '第 3 个交易日应仍在冷却');
  s.tradeDaySeq = 5;
  assert.strictEqual(isCooling(s, '600100'), false, '第 5 个交易日后应解除');
});

t('冷却期：没有卖出记录的股票不受限', () => {
  const s = { positions: {}, coolDownSeq: {}, tradeDaySeq: 1 };
  assert.strictEqual(isCooling(s, '600100'), false);
});

console.log('\n====== 时间与交易日 ======');

t('交易时段判断（北京时间）', () => {
  const at = (iso) => new Date(iso);
  assert.strictEqual(inTradingWindow(at('2026-10-16T01:35:00Z')), true, '北京 09:35 应开盘');
  assert.strictEqual(inTradingWindow(at('2026-10-16T04:00:00Z')), false, '北京 12:00 午休');
  assert.strictEqual(inTradingWindow(at('2026-10-16T05:30:00Z')), true, '北京 13:30 应开盘');
  assert.strictEqual(inTradingWindow(at('2026-10-17T02:00:00Z')), false, '周六不开盘');
});

t('下一交易日猜测：周五 -> 下周一；周四 -> 周五', () => {
  assert.strictEqual(nextTradingDateGuess('2026-10-16'), '2026-10-19'); // 周五 -> 周一
  assert.strictEqual(nextTradingDateGuess('2026-10-15'), '2026-10-16'); // 周四 -> 周五
});

t('交易日序号补计：断档多日也能补上', () => {
  const s = { lastTradingDay: '2026-10-13', tradeDaySeq: 10 };
  const added = syncTradeDaySeq(s, [
    { date: '2026-10-13' }, { date: '2026-10-14' }, { date: '2026-10-15' }, { date: '2026-10-16' },
  ]);
  assert.strictEqual(added, 3);
  assert.strictEqual(s.tradeDaySeq, 13);
  assert.strictEqual(s.lastTradingDay, '2026-10-16');
});

t('状态落盘/读取往返一致', () => {
  const s = newState();
  s.cash = 12345.67;
  saveState(s);
  const back = loadState();
  assert.strictEqual(back.cash, 12345.67);
});

console.log(`\n通过 ${pass} 项断言检查${process.exitCode ? '，有失败' : '，全部通过 ✅'}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
