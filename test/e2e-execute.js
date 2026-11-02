// 端到端测试：待办指令 -> 开盘成交 -> 落盘（隔离数据目录，用真实行情）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-e2e-'));
process.env.DSH_PAPER_DATA = tmp;

const { newState, saveState, loadState, buyCost, COST, INITIAL_CAPITAL } = await import('../src/lib/engine.js');
const { tick } = await import('../src/tick.js');
const { fetchQuotes } = await import('../src/lib/market.js');

// 构造一个账户：一只浮亏 -9.8% 等止损，一只正常持有，现金足够再买一只
// 注意：现金必须与 initialCapital 自洽，否则总资产口径失真
const s = newState();
s.positions = {
  '600519': { code: '600519', name: '贵州茅台', shares: 100, avgCost: 1500, openDate: '2026-10-16', highClose: 1500, lastPrice: 1353, coolDownUntil: null },
  '002242': { code: '002242', name: '九阳股份', shares: 600, avgCost: 17.6, openDate: '2026-10-16', highClose: 18.2, lastPrice: 17.79, coolDownUntil: null },
};
// 总资产 ≈ 100000：持仓市值 ≈ 1353×100 + 17.79×600 = 146,  这里直接算给 cash
const startMv = 1353 * 100 + 17.79 * 600;
s.cash = INITIAL_CAPITAL - startMv;
s.pending = [
  { code: '600519', name: '贵州茅台', action: 'sell', reason: '止损：测试', execDate: '2026-10-19', createdAt: '2026-10-17 18:00:00' },
  { code: '600127', name: '金健米业', action: 'buy', reason: '动能第 1 名：测试', execDate: '2026-10-19', createdAt: '2026-10-17 18:00:00' },
];
s.lastTradingDay = '2026-10-16';
s.tradeDaySeq = 0;
s.snapshots = [{ date: '2026-10-16', total: INITIAL_CAPITAL, cash: s.cash, mktValue: startMv, index: 3716.28 }];
saveState(s);

console.log(`隔离目录: ${tmp}`);
console.log(`起始：现金 ${s.cash.toFixed(2)} + 持仓市值 ${startMv.toFixed(2)} = ${INITIAL_CAPITAL} 元`);
console.log('\n====== 执行成交链路 ======');

const quotes = await fetchQuotes(['600519', '600127']);
console.log(`开盘价参考：贵州茅台 ${quotes['600519']?.open} / 金健米业 ${quotes['600127']?.open}`);

const r = await tick({ force: true, quiet: false });

const after = loadState();
const sells = after.trades.filter((t) => t.side === 'sell');
const buys = after.trades.filter((t) => t.side === 'buy');

console.log(`\n结果：成交 ${after.trades.length} 笔（卖 ${sells.length} / 买 ${buys.length}），待办剩余 ${after.pending.length}`);

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); process.exitCode = 1; }
};

t('止损单已按开盘价成交', () => {
  assert.strictEqual(sells.length, 1, `应有 1 笔卖出，实际 ${sells.length}`);
  assert.strictEqual(sells[0].code, '600519');
  assert.strictEqual(sells[0].reason, '止损：测试');
  assert.ok(sells[0].price > 0);
});

t('卖出成交价 = 开盘价 × (1 - 滑点)', () => {
  const expect = quotes['600519'].open * (1 - COST.slippage);
  assert.ok(Math.abs(sells[0].price - expect) < 0.01, `期望 ${expect.toFixed(3)}，实际 ${sells[0].price}`);
});

t('卖出后持仓被移除，并记录卖出日期用于冷却', () => {
  assert.strictEqual(after.positions['600519'], undefined);
  assert.ok(after.coolDown['600519'], '应写入冷却记录');
  assert.ok(after.coolDownSeq['600519'] != null, '应写入冷却交易序号');
});

t('卖出现金 = 之前现金 + 回款(已扣费)', () => {
  const gross = sells[0].price * sells[0].shares;
  const fee = Math.max(gross * COST.commissionRate, COST.commissionMin) + gross * COST.stampTaxRate;
  assert.ok(Math.abs(sells[0].amount - (gross - fee)) < 0.05, `回款 ${sells[0].amount} 应约等于 ${(gross - fee).toFixed(2)}`);
});

t('买入单按开盘价成交且手数为 100 整数倍', () => {
  assert.strictEqual(buys.length, 1, `应有 1 笔买入，实际 ${buys.length}`);
  assert.strictEqual(buys[0].code, '600127');
  assert.strictEqual(buys[0].shares % 100, 0);
  const expect = quotes['600127'].open * (1 + COST.slippage);
  assert.ok(Math.abs(buys[0].price - expect) < 0.01, `期望 ${expect.toFixed(3)}，实际 ${buys[0].price}`);
  assert.ok(after.positions['600127'], '应出现在持仓中');
});

t('单只买入不超过目标仓位 18%', () => {
  const gross = buys[0].shares * buys[0].price;
  const ta = after.cash + Object.values(after.positions).reduce((a, p) => a + p.lastPrice * p.shares, 0);
  assert.ok(gross <= ta * 0.18 * 1.05, `单只买入 ${gross.toFixed(0)} 不应显著超过总资产 ${ta.toFixed(0)} 的 18%`);
  assert.ok(after.cash >= 0, '现金不应为负');
});

t('旧待办已处理，且新计划被重新挂出（不重复执行已成交的指令）', () => {
  const stale = after.pending.filter((p) => p.createdAt !== undefined && p.reason.includes('测试'));
  assert.strictEqual(stale.length, 0, '旧待办不应残留');
  for (const p of after.pending) {
    assert.ok(p.execDate > after.lastTradingDay || p.execDate === '2026-10-19', `新计划执行日应晚于 ${after.lastTradingDay}，实际 ${p.execDate}`);
  }
});

t('已成交标的不会在同一批待办里重复出现', () => {
  const codes = after.pending.map((p) => p.code);
  assert.strictEqual(new Set(codes).size, codes.length, '待办中有重复标的');
  assert.ok(!codes.includes('600519') || after.coolDownSeq['600519'] == null, '已清仓的标的若在待办中必须是重新建仓');
});

t('成交后现金与持仓市值自洽（总资产 = 现金 + 市值）', () => {
  const mv = Object.values(after.positions).reduce((a, p) => a + p.lastPrice * p.shares, 0);
  const total = after.cash + mv;
  assert.ok(Math.abs(total - r.total) / r.total < 0.02, `快照总资产 ${r.total.toFixed(2)} 与重算 ${total.toFixed(2)} 偏差过大`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项，${process.exitCode ? '有失败' : '全部通过 ✅'}\n`);
