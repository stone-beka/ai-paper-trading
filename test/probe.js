// 探测哪些行情入口在 Node 下可用
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function tryUrl(label, url, opts = {}) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: opts.referer || 'https://quote.eastmoney.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    clearTimeout(t);
    const buf = Buffer.from(await res.arrayBuffer());
    const txt = new TextDecoder(opts.gbk ? 'gbk' : 'utf-8').decode(buf);
    console.log(`✅ ${label}  HTTP ${res.status}  ${buf.length}B  ${((Date.now()-t0)/1000).toFixed(1)}s  ${txt.slice(0, 110).replace(/\s+/g,' ')}`);
    return txt;
  } catch (e) {
    console.log(`❌ ${label}  ${e?.cause?.code || e?.name}: ${e?.cause?.message || e?.message}  ${((Date.now()-t0)/1000).toFixed(1)}s`);
    return null;
  }
}

const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f6,f20,f21';

await tryUrl('东财 clist push2', CLIST);
await new Promise(r=>setTimeout(r,1500));
await tryUrl('东财 clist push2 无Referer', CLIST.replace('push2.', 'push2.'), { referer: 'https://www.eastmoney.com/' });
await new Promise(r=>setTimeout(r,1500));
await tryUrl('东财 push2his kline', 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=1&end=20500101&lmt=3');
await new Promise(r=>setTimeout(r,1500));
await tryUrl('东财 82.push2 clist', 'https://82.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f6');
await new Promise(r=>setTimeout(r,1500));
await tryUrl('腾讯全市场列表', 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hs&sort_type=price&direct=down&offset=0&count=100', { referer: 'https://gu.qq.com/' });
await new Promise(r=>setTimeout(r,1500));
await tryUrl('腾讯 qt 行情', 'https://qt.gtimg.cn/q=sh600519', { gbk: true, referer: 'https://gu.qq.com/' });
await new Promise(r=>setTimeout(r,1500));
await tryUrl('新浪列表(sina)', 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=100&sort=amount&asc=0&node=hs_a', { gbk: true, referer: 'https://finance.sina.com.cn/' });
