// 策略：动能轮动（规则固定、可复现、可质疑）
import { STRATEGY } from './strategy-config.js';
export { STRATEGY };

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

/** 单根K线的成交额（腾讯K线只给手数，用均价估算） */
function barAmount(b) {
  return ((b.open + b.close + b.high + b.low) / 4) * (b.volume || 0) * 100;
}

/**
 * 对单只股票算分。bars 为前复权日K，按时间升序。
 * 打分 = 0.5×20日涨幅 + 0.3×60日涨幅 − 0.2×20日波动率
 */
export function scoreStock(bars) {
  const n = bars.length;
  if (n < 121) return null;
  const close = bars[n - 1].close;
  const c20 = bars[n - 21].close;
  const c60 = bars[n - 61].close;
  const r20 = close / c20 - 1;
  const r60 = close / c60 - 1;

  const rets = [];
  for (let i = n - 20; i < n; i++) rets.push(bars[i].close / bars[i - 1].close - 1);
  const vol = std(rets) * Math.sqrt(20);

  const amt20 = mean(bars.slice(n - 20).map(barAmount));

  // 排除“最新一天一字涨停”（买不进去）
  const last = bars[n - 1];
  const oneWordLimit = last.high === last.low;
  // 排除刚上市（前复权数据太短已在上面拦住）；排除最新价异常
  const limitUpToday = (last.pct ?? 0) >= 9.7 || (last.pct ?? 0) >= 19.7;

  return {
    score: 0.5 * r20 + 0.3 * r60 - 0.2 * vol,
    r20,
    r60,
    vol,
    amt20,
    lastDate: last.date,
    lastClose: close,
    high20: Math.max(...bars.slice(-20).map((b) => b.high)),
    low20: Math.min(...bars.slice(-20).map((b) => b.low)),
    lastPct: last.pct,
    listed: n,
    tradable: !oneWordLimit,
    limitUpToday,
  };
}

/** 大盘环境：上证收盘 vs MA20 */
export function marketWeather(indexBars) {
  const n = indexBars.length;
  const close = indexBars[n - 1].close;
  const ma20 = mean(indexBars.slice(n - 20).map((b) => b.close));
  const chg5 = n >= 6 ? close / indexBars[n - 6].close - 1 : 0;
  const chg20 = n >= 21 ? close / indexBars[n - 21].close - 1 : 0;
  const above = close >= ma20;
  return {
    indexClose: +close.toFixed(2),
    ma20: +ma20.toFixed(2),
    above,
    gate: above ? 1 : 0.5,
    chg5,
    chg20,
    date: indexBars[n - 1].date,
  };
}

/** 硬性预筛（用全市场快照） */
export function prefilter(list) {
  return list.filter((s) => {
    if (!s.code || !s.name) return false;
    if (/^(4|8)/.test(s.code)) return false; // 排除北交所
    if (!/^(60|68|00|30)/.test(s.code)) return false;
    if (/ST|退/.test(s.name)) return false;
    if (!s.price || s.price <= 0) return false;
    if (s.floatMcap == null || s.floatMcap < 50e8 || s.floatMcap > 5000e8) return false;
    if (s.amount == null || s.amount < 8000e4) return false;
    if (s.pct != null && (s.pct > 11 || s.pct < -11)) return false; // 剔除异常
    return true;
  });
}

/**
 * 候选排名
 * @param {Object} klines code -> {name,bars}
 * @param {Object} snapshot code -> 快照
 * @param {number} gate 市场开关
 */
export function rankCandidates(klines, snapshot, gate = 1, limit = 30) {
  const rows = [];
  for (const [code, k] of Object.entries(klines)) {
    const sc = scoreStock(k.bars);
    if (!sc) continue;
    if (sc.amt20 < 8000e4) continue; // 20日均成交额下限
    if (!sc.tradable) continue; // 一字板买不进
    const snap = snapshot[code] || {};
    rows.push({
      code,
      name: k.name || snap.name,
      score: sc.score * gate,
      rawScore: sc.score,
      r20: sc.r20,
      r60: sc.r60,
      vol: sc.vol,
      close: snap.price ?? sc.lastClose,
      amt20: sc.amt20,
      amt: snap.amount ?? null,
      floatMcap: snap.floatMcap ?? null,
      floatMcapYi: snap.floatMcap != null ? +(snap.floatMcap / 1e8).toFixed(1) : null,
      pct: snap.pct ?? sc.lastPct,
      lastDate: sc.lastDate,
      high20: sc.high20,
      low20: sc.low20,
      listed: sc.listed,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}
