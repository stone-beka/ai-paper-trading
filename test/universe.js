import { fetchUniverse } from '../src/lib/market.js';

const t0 = Date.now();
const u = await fetchUniverse();
console.log(`universe=${u.length} 用时 ${((Date.now()-t0)/1000).toFixed(1)}s`);
const byBoard = {};
for (const s of u) {
  const k = s.code.slice(0, 2);
  byBoard[k] = (byBoard[k] || 0) + 1;
}
console.log('代码前缀分布:', byBoard);
const st = u.filter((s) => /ST/.test(s.name)).length;
console.log('ST 数量:', st, '| 有价数量:', u.filter((s) => s.price > 0).length);
const big = [...u].sort((a,b)=>(b.amount||0)-(a.amount||0)).slice(0,5).map(s=>`${s.name}(${s.code}) ${(s.amount/1e8).toFixed(1)}亿`);
console.log('成交额前5:', big.join(', '));
console.log('含茅台?', u.some(s=>s.code==='600519'), '| 含宁德?', u.some(s=>s.code==='300750'), '| 含中际旭创?', u.some(s=>s.code==='300308'));
