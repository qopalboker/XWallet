/**
 * worker_threads pool برای derivation سنگین (PBKDF2).
 *
 * mnemonicToSeed یه عملیات CPU-bound سنکرونه که event loop رو بلاک می‌کنه.
 * تو generation انبوه (مثلاً ۱۰هزار ولت) این بیشترین وقت رو می‌خوره. این pool
 * کار رو بین چند worker_thread تقسیم می‌کنه (پیش‌فرض = cores - 1).
 *
 * استفاده:
 *   await deriveManyParallel(mnemonic, requests)
 *
 * Lazy init: pool فقط وقتی اولین بار صدا زده می‌شه ساخته می‌شه. اگه
 * `WALLET_DERIVATION_POOL_SIZE=0` ست بشه، fallback به همون deriveMany تو
 * thread اصلی (برای تست/debug).
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { deriveMany, type DeriveManyRequest, type DerivedAddress } from './derivation.js';
import type { DeriveResponse, DeriveTask } from './derivation-worker.js';

interface PendingTask {
  resolve: (addrs: DerivedAddress[]) => void;
  reject: (err: Error) => void;
}

class DerivationPool {
  private size: number;
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private workQueue: { task: DeriveTask; pending: PendingTask }[] = [];
  private pending = new Map<number, PendingTask>();
  private nextId = 1;
  private initialized = false;

  constructor() {
    const envSize = Number(process.env.WALLET_DERIVATION_POOL_SIZE);
    if (Number.isFinite(envSize) && envSize >= 0) {
      this.size = Math.floor(envSize);
    } else {
      // پیش‌فرض: cores - 1، حداقل 1، حداکثر 8 (بیشتر از این عملاً کمکی نمی‌کنه چون DB bottleneck می‌شه)
      this.size = Math.max(1, Math.min(8, os.cpus().length - 1));
    }
  }

  /** آدرس فایل worker، با تشخیص dev (.ts) vs prod (.js) از روی import.meta.url. */
  private resolveWorkerSpec(): { url: URL; execArgv: string[] } {
    const here = fileURLToPath(import.meta.url);
    const isTs = here.endsWith('.ts');
    const url = new URL(
      isTs ? './derivation-worker.ts' : './derivation-worker.js',
      import.meta.url
    );
    // tsx رو فقط تو dev نیاز داریم تا فایل .ts رو لود کنه.
    const execArgv = isTs ? ['--import', 'tsx'] : [];
    return { url, execArgv };
  }

  private spawnWorker(): Worker {
    const { url, execArgv } = this.resolveWorkerSpec();
    const w = new Worker(url, { execArgv });

    w.on('message', (resp: DeriveResponse) => {
      const p = this.pending.get(resp.id);
      if (!p) return;
      this.pending.delete(resp.id);
      if (resp.ok && resp.result) {
        p.resolve(resp.result);
      } else {
        p.reject(new Error(resp.error ?? 'derivation worker failed'));
      }
      this.releaseWorker(w);
    });

    w.on('error', (err) => {
      console.error('[derivation-pool] worker error:', err);
      // همه task‌های pending روی این worker رو reject کن. شناسه‌گذاری
      // یک‌به‌یک نداریم پس همه‌ی pending رو fail می‌کنیم — احتیاطی.
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      // worker رو از pool خارج کن و یکی جدید جایگزین کن (best-effort).
      this.workers = this.workers.filter((x) => x !== w);
      this.idleWorkers = this.idleWorkers.filter((x) => x !== w);
      try {
        const replacement = this.spawnWorker();
        this.workers.push(replacement);
        this.idleWorkers.push(replacement);
      } catch (e) {
        console.error('[derivation-pool] failed to respawn worker:', e);
      }
    });

    return w;
  }

  private init(): void {
    if (this.initialized) return;
    if (this.size === 0) {
      this.initialized = true;
      return;
    }
    for (let i = 0; i < this.size; i++) {
      const w = this.spawnWorker();
      this.workers.push(w);
      this.idleWorkers.push(w);
    }
    this.initialized = true;
  }

  private releaseWorker(w: Worker): void {
    const next = this.workQueue.shift();
    if (next) {
      this.pending.set(next.task.id, next.pending);
      w.postMessage(next.task);
    } else {
      this.idleWorkers.push(w);
    }
  }

  async derive(
    mnemonic: string,
    requests: DeriveManyRequest[],
    passphrase: string = ''
  ): Promise<DerivedAddress[]> {
    this.init();

    // اگه اندازه pool صفر بود (یا پیش از init) به deriveMany در thread اصلی fallback می‌کنیم.
    if (this.size === 0) {
      return deriveMany(mnemonic, requests, passphrase);
    }

    const task: DeriveTask = {
      id: this.nextId++,
      mnemonic,
      requests,
      passphrase,
    };

    return new Promise<DerivedAddress[]>((resolve, reject) => {
      const pending: PendingTask = { resolve, reject };
      const idle = this.idleWorkers.shift();
      if (idle) {
        this.pending.set(task.id, pending);
        idle.postMessage(task);
      } else {
        this.workQueue.push({ task, pending });
      }
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idleWorkers = [];
    this.workQueue = [];
    this.pending.clear();
    this.initialized = false;
  }

  poolSize(): number {
    return this.size;
  }
}

let _pool: DerivationPool | null = null;

function getPool(): DerivationPool {
  if (!_pool) _pool = new DerivationPool();
  return _pool;
}

/**
 * موازی‌شده deriveMany. اگه pool ست شده باشه از worker_threads استفاده می‌کنه،
 * در غیر این‌صورت همون deriveMany توی thread اصلی صدا می‌زنه.
 */
export async function deriveManyParallel(
  mnemonic: string,
  requests: DeriveManyRequest[],
  passphrase: string = ''
): Promise<DerivedAddress[]> {
  return getPool().derive(mnemonic, requests, passphrase);
}

/**
 * چندین mnemonic رو هم‌زمان derive می‌کنه و map ای از index → addresses بر می‌گردونه.
 * این تابع برای generation chunked استفاده می‌شه: هر mnemonic روی یه worker thread
 * مستقل می‌ره و همه با هم اجرا می‌شن.
 */
export async function deriveManyForWallets(
  mnemonics: string[],
  requests: DeriveManyRequest[]
): Promise<DerivedAddress[][]> {
  const pool = getPool();
  return Promise.all(mnemonics.map((m) => pool.derive(m, requests, '')));
}

export async function closeDerivationPool(): Promise<void> {
  if (_pool) {
    await _pool.close();
    _pool = null;
  }
}

export function getDerivationPoolSize(): number {
  return getPool().poolSize();
}
