import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

/** 数据目录可用 DSH_PAPER_DATA 覆盖（用于隔离测试，避免污染真实账户） */
export function dataDir() {
  return process.env.DSH_PAPER_DATA ? path.resolve(process.env.DSH_PAPER_DATA) : path.join(ROOT, 'data');
}
export const DATA_DIR = dataDir();
export function stateFile() {
  return path.join(dataDir(), 'state.json');
}
export const STATE_FILE = stateFile();

// ---------- 进程锁：同一时间只允许一个写状态 ----------
export function lockPath(name = 'tick') {
  return path.join(dataDir(), `${name}.lock`);
}
export function readLock(name = 'tick') {
  try {
    return JSON.parse(fs.readFileSync(lockPath(name), 'utf8'));
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 同步尝试加锁（不等待） */
export function tryLock(name = 'tick') {
  const f = lockPath(name);
  ensureDir(dataDir());
  const cur = readLock(name);
  if (cur && pidAlive(cur.pid)) return { ok: false, holder: cur };
  if (cur && Date.now() - (cur.at || 0) < 3000) return { ok: false, holder: cur, recent: true };
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), name }), 'utf8');
  return { ok: true };
}

/**
 * 等待式加锁：被占用时等待释放（避免"命令重试 -> 两个实例互相拒绝 -> 都失败"）
 * @param {number} timeoutMs 最长等待时间
 */
export async function acquireLockAsync(name = 'tick', timeoutMs = 240000, logFn = null) {
  const t0 = Date.now();
  let logged = false;
  for (;;) {
    const r = tryLock(name);
    if (r.ok) return { ok: true };
    if (Date.now() - t0 > timeoutMs) return { ok: false, holder: r.holder };
    if (!logged && logFn) {
      logFn(`另一个 ${name} 进程正在运行（pid ${r.holder?.pid}），等待其完成...`);
      logged = true;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

export function releaseLock(name = 'tick') {
  try {
    fs.unlinkSync(lockPath(name));
  } catch {
    /* ignore */
  }
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免读到半截 JSON */
export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function nowCn() {
  // 统一用北京时间
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(d.toISOString().replace('Z', '+08:00'));
}

export function cnDateStr(d = new Date()) {
  const x = new Date(d.getTime() + 8 * 3600 * 1000);
  return x.toISOString().slice(0, 10);
}

export function cnTimeStr(d = new Date()) {
  const x = new Date(d.getTime() + 8 * 3600 * 1000);
  return x.toISOString().slice(11, 19);
}

export function log(...args) {
  console.log(`[${cnDateStr()} ${cnTimeStr()}]`, ...args);
}
