// 最小资金门槛测算：ETF/个股的一手金额 + 最低佣金对小资金的杀伤
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

// 常见宽基/红利/债券 ETF
const ETFS = [
  ['sh510300', '沪深300ETF'],
  ['sh510500', '中证500ETF'],
  ['sh512880', '证券ETF'],
  ['sh510880', '红利ETF'],
  ['sh515180', '红利ETF易方达'],
  ['sh563020', '中证红利低波ETF'],
  ['sh511010', '国债ETF'],
  ['sh511880', '银华日利(货基)'],
  ['sh588000', '科创50ETF'],
  ['sz159915', '创业板ETF'],
  ['sh510050', '上证50ETF'],
  ['sh512100', '中证1000ETF'],
];

function quote(sym) {
  const out = execFileSync('curl.exe', ['-s', '-m', '15', '-A', UA, '-e', 'https://gu.qq.com/', `https://qt.gtimg.cn/q=${sym}`], { encoding: 'latin1', maxBuffer: 1 << 20 });
  const m = out.match(/="([^"]*)"/);
  if (!m) return null;
  const f = m[1].split('~');
  return { name: f[1], price: +f[3] };
}

console.log('===== 各类 ETF 一手金额（100 份起买）=====');
const rows = [];
for (const [sym, label] of ETFS) {
  try {
    const q = quote(sym);
    if (!q || !q.price) { console.log(`  ${label.padEnd(20)} 取价失败`); continue; }
    const lot = q.price * 100;
    rows.push({ sym, label, name: q.name, price: q.price, lot });
    console.log(`  ${label.padEnd(20)} 现价 ${String(q.price).padStart(7)}  一手 ${lot.toFixed(0).padStart(7)} 元`);
  } catch (e) {
    console.log(`  ${label.padEnd(20)} 失败 ${e.message.slice(0, 40)}`);
  }
}

console.log('\n===== 最低佣金 5 元对小资金的杀伤（一年再平衡 1 次）=====');
console.log('  假设：买入 + 卖出各一次，佣金各按最低 5 元计 → 年固定成本 10 元');
console.log(`  ${'本金'.padStart(9)} ${'10元占本金'.padStart(12)} ${'对年化5%收益的侵蚀'.padStart(22)} ${'实际年化'.padStart(10)}`);
for (const cap of [500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]) {
  const drag = 10 / cap;
  const gross = 0.05;
  const net = gross - drag;
  console.log(`  ${String(cap).padStart(9)} ${((drag * 100).toFixed(2) + '%').padStart(12)} ${((drag / gross) * 100).toFixed(0).padStart(20)}% ${(net >= 0 ? '+' : '') + (net * 100).toFixed(2) + '%'}`);
}

console.log('\n===== ETF 交易的真实费用结构（对比个股）=====');
console.log('  个股：佣金 0.025%（最低5元）+ 卖出印花税 0.05% + 过户费极小');
console.log('  ETF ：佣金 0.025%（最低5元），**免印花税**，无过户费');
console.log(`  → 一次完整买卖（个股）约 0.10% + 滑点；ETF 约 0.05% + 滑点`);
console.log('\n  关键：免印花税这一条，让小资金的摩擦成本直接砍半');

console.log('\n===== 基金（场外）门槛 =====');
console.log('  公募基金申购：多数 10 元起，定投 1~10 元起（无 5 元最低佣金问题）');
console.log('  货币基金：1 元起，随时申赎，无手续费');
console.log('  → 这是真正的"零门槛"通道，代价是不能盘中交易、按净值成交');

fs.writeFileSync(path.join(process.cwd(), 'data', 'replay', 'min-capital.json'), JSON.stringify(rows, null, 2));
console.log('\n已写入 data/replay/min-capital.json');
