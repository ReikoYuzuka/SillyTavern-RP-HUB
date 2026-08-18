/**
 * IndexedDB存储.ts —— 楼层变量异步持久化（IndexedDB + 防抖落盘）。
 *
 * 背景（performance_audit.md §3）：原实现每楼同步写 localStorage（JSON.stringify +
 * setItem 同步刷盘），楼层多时单次阻塞 50-100ms（移动端更甚）→ 主线程卡顿。
 *
 * 本模块把持久化迁移到 IndexedDB（异步、容量大），并加防抖合并落盘：
 *   - 内存中立即更新（主线程零同步 I/O）；
 *   - 后台 setTimeout 1.5s 聚合一次 IndexedDB 写入。
 *
 * 兼容：存储结构不变（{ version, chats: {...} }，与 楼层变量.ts 的 存储结构 一致），
 * 首次启动时把旧 localStorage 数据迁移进 IndexedDB（无缝升级）。
 */

import type { 存储结构 } from './楼层变量';

/** IndexedDB 库名 / 版本 / 仓库名。 */
const 库名 = 'thp_floor_variables_db';
const 库版本 = 1;
const 仓库名 = 'chats';

/** 旧 localStorage 键（迁移来源）。 */
const 旧存储键 = 'thp_floor_variables_v1';

/** 防抖落盘间隔（毫秒）。 */
const 落盘防抖毫秒 = 1500;

/** 内存写缓存：chatId → 聊天记录（防抖聚合用）。 */
let 内存存储: 存储结构 | null = null;
let 落盘定时器: ReturnType<typeof setTimeout> | null = null;
let 数据库: IDBDatabase | null = null;
let 数据库打开中: Promise<IDBDatabase> | null = null;

/** 打开（或复用）IndexedDB 连接。 */
function 打开数据库(): Promise<IDBDatabase> {
  if (数据库) return Promise.resolve(数据库);
  if (数据库打开中) return 数据库打开中;
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB 不可用'));
  数据库打开中 = new Promise((resolve, reject) => {
    const req = indexedDB.open(库名, 库版本);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(仓库名)) {
        db.createObjectStore(仓库名, { keyPath: 'chatId' });
      }
    };
    req.onsuccess = () => {
      数据库 = req.result;
      数据库打开中 = null;
      resolve(req.result);
    };
    req.onerror = () => {
      数据库打开中 = null;
      reject(req.error);
    };
  });
  return 数据库打开中;
}

/** 从 IndexedDB 读全量存储（无记录 / 失败返回 null）。 */
async function 读数据库(): Promise<存储结构 | null> {
  try {
    const db = await 打开数据库();
    return await new Promise<存储结构 | null>((resolve) => {
      const tx = db.transaction(仓库名, 'readonly');
      const store = tx.objectStore(仓库名);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as Array<{ chatId: string; value: 存储结构 }>) ?? [];
        // 多行合并（理论单行，防御性合并）：chats 逐条覆盖
        const 合并: 存储结构 = { version: 1, chats: {} };
        for (const row of rows) {
          if (row?.value?.chats && typeof row.value.chats === 'object') {
            Object.assign(合并.chats, row.value.chats);
          }
        }
        resolve(合并);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** 把全量存储写入 IndexedDB（按 chatId 分行存，事务批量）。 */
async function 写数据库(存储: 存储结构): Promise<void> {
  try {
    const db = await 打开数据库();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(仓库名, 'readwrite');
      const store = tx.objectStore(仓库名);
      for (const [chatId, 聊天] of Object.entries(存储.chats ?? {})) {
        store.put({ chatId, value: { version: 存储.version ?? 1, chats: { [chatId]: 聊天 } } });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 写失败静默降级（内存态保留，下次事件仍会尝试）
  }
}

/**
 * 读取存储：优先内存缓存 → IndexedDB → 旧 localStorage（迁移）。
 * 返回的存储结构为「当前权威数据」；调用方改动后需经 调度落盘 持久化。
 */
export async function 读存储(): Promise<存储结构> {
  if (内存存储) return 内存存储;
  // 1. IndexedDB
  const 库数据 = await 读数据库();
  if (库数据 && Object.keys(库数据.chats ?? {}).length > 0) {
    内存存储 = 库数据;
    return 库数据;
  }
  // 2. 旧 localStorage（迁移：读出后立即异步落盘到 IndexedDB）
  try {
    const 原文 = localStorage.getItem(旧存储键);
    if (原文) {
      const 解析 = JSON.parse(原文) as 存储结构;
      if (解析 && typeof 解析 === 'object' && 解析.chats && typeof 解析.chats === 'object') {
        内存存储 = 解析;
        调度落盘(); // 异步迁移到 IndexedDB
        return 解析;
      }
    }
  } catch {
    // 旧数据损坏忽略
  }
  内存存储 = { version: 1, chats: {} };
  return 内存存储;
}

/** 调度防抖落盘（内存存储 → IndexedDB；1.5s 聚合，主线程零阻塞）。 */
export function 调度落盘(): void {
  if (落盘定时器) return;
  落盘定时器 = setTimeout(() => {
    落盘定时器 = null;
    const 快照 = 内存存储;
    if (快照) void 写数据库(快照);
  }, 落盘防抖毫秒);
}

/** 立即落盘（界面主动刷新/清空时调用，确保改动已持久化）。 */
export async function 立即落盘(): Promise<void> {
  if (落盘定时器) {
    clearTimeout(落盘定时器);
    落盘定时器 = null;
  }
  const 快照 = 内存存储;
  if (快照) await 写数据库(快照);
}
