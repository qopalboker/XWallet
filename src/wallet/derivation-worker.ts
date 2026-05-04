/**
 * worker_threads worker for HD derivation.
 *
 * یه protocol ساده: parent یه پیام `DeriveTask` می‌فرسته، ما یه پیام
 * `DeriveResponse` (موفقیت یا خطا) برمی‌گردونیم. هیچ shared state ای
 * نگه نمی‌داریم؛ هر task مستقل پردازش می‌شه.
 *
 * این فایل هم تو dev (tsx) و هم تو prod (dist/.../derivation-worker.js)
 * مستقیم اجرا می‌شه. صرفاً CommonJS import ها باید کار کنن — derivation.ts
 * ESM-pure هست پس از همین path import می‌کنیم.
 */

import { parentPort } from 'node:worker_threads';
import { deriveMany, type DeriveManyRequest, type DerivedAddress } from './derivation.js';

export interface DeriveTask {
  id: number;
  mnemonic: string;
  requests: DeriveManyRequest[];
  passphrase?: string;
}

export interface DeriveResponse {
  id: number;
  ok: boolean;
  result?: DerivedAddress[];
  error?: string;
}

if (!parentPort) {
  throw new Error('derivation-worker.ts must be run as a worker_threads worker');
}

parentPort.on('message', async (task: DeriveTask) => {
  try {
    const result = await deriveMany(task.mnemonic, task.requests, task.passphrase ?? '');
    const resp: DeriveResponse = { id: task.id, ok: true, result };
    parentPort!.postMessage(resp);
  } catch (e) {
    const resp: DeriveResponse = {
      id: task.id,
      ok: false,
      error: (e as Error).message,
    };
    parentPort!.postMessage(resp);
  }
});
