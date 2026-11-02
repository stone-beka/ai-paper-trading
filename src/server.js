// 本地看板服务：静态页 + JSON API
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState } from './lib/engine.js';
import { fetchQuotes } from './lib/market.js';
import { ROOT, readJson, cnDateStr, cnTimeStr } from './lib/store.js';
import { tick } from './tick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const SCAN_CACHE = path.join(ROOT, 'data', 'last-scan.json');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export async function buildView() {
  const s = loadState();
  const priceOf = (c) => s.positions[c]?.lastPrice;
  let mv = 0;
  const positions = Object.values(s.positions).map((p) => {
    const price = p.lastPrice ?? p.avgCost;
    const value = price * p.shares;
    mv += value;
    const cost = p.avgCost * p.shares;
    const rank = s.lastScan?.candidates?.findIndex((c) => c.code === p.code);
    return {
      ...p,
      price,
      value: +value.toFixed(2),
      cost: +cost.toFixed(2),
      pnl: +(value - cost).toFixed(2),
      pnlPct: cost > 0 ? value / cost - 1 : 0,
      dayPct: p.prevClose ? price / p.prevClose - 1 : null,
      rank: rank >= 0 ? rank + 1 : null,
    };
  });
  positions.sort((a, b) => b.value - a.value);

  const total = s.cash + mv;
  const init = s.initialCapital;
  const wins = s.trades.filter((t) => t.side === 'sell' && t.pnl > 0).length;
  const losses = s.trades.filter((t) => t.side === 'sell' && t.pnl <= 0).length;
  const realized = s.trades.filter((t) => t.side === 'sell').reduce((a, t) => a + (t.pnl || 0), 0);

  // 已实现 + 未实现
  const unrealized = positions.reduce((a, p) => a + (p.pnl || 0), 0);
  const feesPaid = s.trades.reduce((a, t) => a + (t.fee || 0), 0);

  // 基准：同样 5 只等权买入后持有不动（不做止损/换仓），全程盯市
  let benchmark = null;
  if (s.benchmark?.entries?.length) {
    const codes = s.benchmark.entries.map((e) => e.code);
    let prices = {};
    try {
      prices = await fetchQuotes(codes);
    } catch {
      prices = {};
    }
    let sum = 0;
    let n = 0;
    const detail = [];
    for (const e of s.benchmark.entries) {
      const cur = prices[e.code]?.price ?? s.positions[e.code]?.lastPrice;
      if (!cur || !e.close) continue;
      const r = cur / e.close - 1;
      sum += r;
      n++;
      detail.push({ code: e.code, name: e.name, entry: e.close, now: cur, ret: r });
    }
    if (n) {
      const ret = sum / n;
      benchmark = {
        name: s.benchmark.name || '等权持有基准',
        startDate: s.benchmark.startDate,
        ret,
        total: +(s.initialCapital * (1 + ret)).toFixed(2),
        detail,
      };
    }
  }

  return {
    serverTime: `${cnDateStr()} ${cnTimeStr()}`,
    account: {
      initialCapital: init,
      cash: +s.cash.toFixed(2),
      mktValue: +mv.toFixed(2),
      total: +total.toFixed(2),
      pnl: +(total - init).toFixed(2),
      pnlPct: total / init - 1,
      realized: +realized.toFixed(2),
      unrealized: +unrealized.toFixed(2),
      feesPaid: +feesPaid.toFixed(2),
      positionPct: total > 0 ? mv / total : 0,
      tradeCount: s.trades.length,
      winCount: wins,
      lossCount: losses,
      winRate: wins + losses ? wins / (wins + losses) : null,
      startedAt: s.snapshots?.[0]?.date ?? null,
    },
    benchmark,
    positions,
    trades: s.trades.slice(0, 200),
    pending: s.pending ?? [],
    events: (s.events ?? []).slice(0, 100),
    snapshots: s.snapshots ?? [],
    scan: s.lastScan
      ? {
          asOf: s.lastScan.asOf,
          at: s.lastScan.at,
          weather: s.lastScan.weather,
          dataSource: s.lastScan.dataSource,
          adjusted: s.lastScan.adjusted,
          universeCount: s.lastScan.universeCount,
          filteredCount: s.lastScan.filteredCount,
          scoredCount: s.lastScan.scoredCount,
          candidates: s.lastScan.candidates.slice(0, 15),
        }
      : null,
    strategy: s.strategy ?? null,
    heldCodes: Object.keys(s.positions),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/state') return send(res, 200, await buildView());
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, ts: Date.now() });
    if (url.pathname === '/api/tick') {
      const force = url.searchParams.get('force') === '1';
      const r = await tick({ force, quiet: true });
      return send(res, 200, { ok: true, result: r, view: await buildView() });
    }
    if (url.pathname === '/api/scan-cache') {
      const c = readJson(SCAN_CACHE, null);
      return send(res, 200, c ?? { error: 'no cache' });
    }
    if (url.pathname === '/api/raw-state') return send(res, 200, loadState());

    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(__dirname, 'web', path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(path.join(__dirname, 'web'))) return send(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    return send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`模拟盘看板已启动： http://127.0.0.1:${PORT}`);
});
