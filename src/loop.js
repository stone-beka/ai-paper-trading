// 常驻心跳进程：交易时段每 3 分钟一次，非交易时段每小时一次
import { tick, inTradingWindow } from './tick.js';
import { log } from './lib/engine.js';

const TRADING_MS = 3 * 60 * 1000;
const IDLE_MS = 60 * 60 * 1000;

let running = false;

async function beat(reason) {
  if (running) return;
  running = true;
  try {
    const force = reason === 'startup' || reason === 'manual';
    await tick({ force, quiet: false });
  } catch (e) {
    console.error('tick 失败：', e && e.message ? e.message : e);
  } finally {
    running = false;
  }
}

async function main() {
  log('心跳进程启动');
  await beat('startup');
  const loop = async () => {
    const trading = inTradingWindow();
    const wait = trading ? TRADING_MS : IDLE_MS;
    setTimeout(async () => {
      await beat(trading ? 'trading' : 'idle');
      loop();
    }, wait);
  };
  loop();
}

main();
