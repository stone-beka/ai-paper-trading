// 补全指数历史（只更新 market.json 的 index 部分，不重拉个股）
import fs from 'node:fs';
import path from 'node:path';
import { fetchIndex, INDEX_SH } from '../lib/market.js';
import { cacheFile } from './cache.js';

const file = cacheFile('market');
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('原指数根数:', m.index.bars.length, m.index.bars[0].date, '~', m.index.bars.at(-1).date);

const idx = await fetchIndex(INDEX_SH, 2000);
console.log('新指数根数:', idx.bars.length, idx.bars[0].date, '~', idx.bars.at(-1).date);

m.index = { symbol: idx.symbol, name: idx.name, bars: idx.bars };
fs.writeFileSync(file, JSON.stringify(m));
console.log('已更新:', file, (fs.statSync(file).size / 1e6).toFixed(1), 'MB');
