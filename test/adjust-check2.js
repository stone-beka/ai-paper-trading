// 验证：新浪原始价 + 新浪复权因子 -> 能否复现东财前复权
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const symOf = (c) => (/^(60|68|9|5)/.test(c) ? 'sh' : 'sz') + c;

async function get(url, gbk = false) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } });
  const buf = Buffer.from(await r.arrayBuffer());
  return gbk ? new TextDecoder('gbk').decode(buf) : buf.toString('utf8');
}

async function sinaRaw(code, len) {
  const t = await get(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symOf(code)}&scale=240&ma=no&datalen=${len}`);
  return JSON.parse(t).map((b) => ({ date: b.day, close: +b.close }));
}

function parseFactors(txt) {
  const i = txt.indexOf('=');
  if (i < 0) return null;
  let body = txt.slice(i + 1).trim();
  body = body.replace(/;\s*$/, '');
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try {
    const j = JSON.parse(body.slice(s, e + 1));
    return j.data.map((x) => ({ d: x.d, f: +x.f }));
  } catch (err) {
    console.log('   (解析失败:', err.message, ')');
    return null;
  }
}

async function hfq(code) {
  const t = await get(`https://finance.sina.com.cn/realstock/company/${symOf(code)}/hfq.js`, true);
  return { raw: t.slice(0, 60), factors: parseFactors(t) };
}

const refDir = path.join(process.cwd(), 'data', 'ref');
const cases = fs.readdirSync(refDir).map((f) => f.replace('.json', ''));

for (const code of cases) {
  const ref = JSON.parse(fs.readFileSync(path.join(refDir, `${code}.json`), 'utf8'));
  const em = new Map(ref.klines.map((l) => { const p = l.split(','); return [p[0], +p[2]]; }));
  const raw = await sinaRaw(code, 200);
  const { raw: head, factors: f } = await hfq(code);
  if (!f) { console.log(`\n===== ${code}: 因子接口未返回可用数据 -> ${head.replace(/\s+/g, ' ')}`); continue; }
  console.log(`\n===== ${code}  因子 ${f.length} 条（降序）: ${f.slice(0, 3).map((x) => `${x.d}=${x.f.toFixed(4)}`).join(' ')}`);

  const modes = {
    '未复权': (bar) => bar.close,
    '公式A': (bar) => {
      let mul = 1;
      for (let i = 0; i < f.length - 1; i++) if (bar.date < f[i].d) mul *= (f[i].f - f[i + 1].f) / f[i].f;
      return bar.close * mul;
    },
    '公式B': (bar) => {
      let mul = 1;
      for (let i = 0; i < f.length - 1; i++) if (bar.date < f[i].d) mul *= f[i + 1].f / f[i].f;
      return bar.close * mul;
    },
    '公式C': (bar) => {
      let mul = 1;
      for (let i = 0; i < f.length - 1; i++) if (bar.date < f[i].d) mul *= f[i].f / f[i + 1].f;
      return bar.close * mul;
    },
  };
  for (const [name, fn] of Object.entries(modes)) {
    let n = 0, sum = 0, max = 0;
    for (const b of raw) {
      const e = em.get(b.date);
      if (!e) continue;
      const d = Math.abs(fn(b) - e) / e;
      n++; sum += d; if (d > max) max = d;
    }
    if (n) console.log(`  ${name}: 均值 ${((sum / n) * 100).toFixed(3)}%  最大 ${(max * 100).toFixed(3)}%  (n=${n})`);
  }
}
