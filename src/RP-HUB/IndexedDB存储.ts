/**
 * IndexedDB存储.ts —— 楼层变量异步持久化（细粒度行级存储 + BroadcastChannel 同步 + 防抖落盘）。
 *
 * 背景：
 *   - 原实现单体大 JSON 存储在多标签页并发写入时极易产生全量覆盖与时钟冲突；
 *   - 现升级为按 chatId 细粒度行级原子存储（行内 updatedAt 仅诊断用时间戳）；
 *   - 引入 BroadcastChannel('rph_idb_sync')，跨标签页广播落盘事件。
 *
 * F4 修复：收到广播不再直接 delete 本地内存条目（会与「本页防抖窗口内的在途写」竞态——
 * 定时器到期时 chats[chatId] 已被删 → put 被跳过 → 本页修改静默丢失），改为
 * 「合并去重回填队列」：待落盘命中则跳过回填（本页在途胜出，落盘后自然覆盖对方，
 * 行级 last-writer-wins）；否则 读Chat记录 单行读回整体替换内存条目。
 */

import type { 存储结构, 聊天记录 } from './楼层变量';

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
let 待落盘ChatIds = new Set<string>();
let 落盘定时器: ReturnType<typeof setTimeout> | null = null;
let 数据库: IDBDatabase | null = null;
let 数据库打开中: Promise<IDBDatabase> | null = null;

/* ---------- F4：广播回填队列（同 chatId 合并去重；微任务级延迟摊平广播风暴） ---------- */

const 待回填ChatIds = new Set<string>();
let 回填定时器: ReturnType<typeof setTimeout> | null = null;

function 调度回填(chatId: string): void {
  待回填ChatIds.add(chatId);
  if (回填定时器) return;
  回填定时器 = setTimeout(() => {
    回填定时器 = null;
    const ids = Array.from(待回填ChatIds);
    待回填ChatIds.clear();
    void 执行回填(ids);
  }, 0);
}

async function 执行回填(chatIds: string[]): Promise<void> {
  for (const chatId of chatIds) {
    // 本页该 chatId 有在途未落盘的修改 → 本页在途胜出：跳过回填，待本页落盘后整行覆盖对方
    if (待落盘ChatIds.has(chatId)) continue;
    try {
      const 行 = await 读Chat记录(chatId);
      if (!内存存储) continue; // 尚未初始化/已被 clear_all → 下次 读存储 会全量加载
      if (行) {
        内存存储.chats[chatId] = 行;
      } else {
        delete 内存存储.chats[chatId]; // 对端删除了该聊天（清空）→ 同步移除
      }
    } catch {
      // 回填失败忽略（下次广播重试；内存态保持不变）
    }
  }
}

/** 跨标签页广播同步通道 */
let 同步通道: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    同步通道 = new BroadcastChannel('rph_idb_sync');
    同步通道.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === 'chat_updated' && typeof data.chatId === 'string') {
        // F4：不 delete —— 进合并去重回填队列，从 IDB 单行读回替换内存条目
        调度回填(data.chatId);
      } else if (data && data.type === 'clear_all') {
        内存存储 = null;
      }
    };
  }
} catch {
  // BroadcastChannel 不可用时忽略
}

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
        const rows = (req.result as Array<{ chatId: string; value: { version: number; chats: Record<string, 聊天记录>; updatedAt?: number } }>) ?? [];
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

/** 从 IndexedDB 读指定 chatId 的记录 */
export async function 读Chat记录(chatId: string): Promise<聊天记录 | null> {
  try {
    const db = await 打开数据库();
    return await new Promise<聊天记录 | null>((resolve) => {
      const tx = db.transaction(仓库名, 'readonly');
      const store = tx.objectStore(仓库名);
      const req = store.get(chatId);
      req.onsuccess = () => {
        const row = req.result;
        if (row?.value?.chats?.[chatId]) {
          resolve(row.value.chats[chatId]);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** 把全量/增量存储按行原子写入 IndexedDB 并广播同步事件。 */
async function 写数据库(存储: 存储结构, 指定ChatIds?: Set<string>): Promise<void> {
  try {
    const db = await 打开数据库();
    const chatIdsToWrite = 指定ChatIds && 指定ChatIds.size > 0
      ? Array.from(指定ChatIds)
      : Object.keys(存储.chats ?? {});

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(仓库名, 'readwrite');
      const store = tx.objectStore(仓库名);
      for (const chatId of chatIdsToWrite) {
        const 聊天 = 存储.chats?.[chatId];
        if (聊天) {
          // F4：行级 last-writer-wins —— updatedAt 仅诊断/排序用，冲突正确性由「在途跳过回填」保证
          store.put({ chatId, value: { version: 存储.version ?? 1, chats: { [chatId]: 聊天 }, updatedAt: Date.now() } });
        }
      }
      tx.oncomplete = () => {
        // 广播变更事件
        for (const chatId of chatIdsToWrite) {
          同步通道?.postMessage({ type: 'chat_updated', chatId });
        }
        resolve();
      };
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

/** 调度防抖落盘（内存存储 → IndexedDB；1.5s 聚合，支持指定 chatId 细粒度更新）。 */
export function 调度落盘(chatId?: string): void {
  if (chatId) {
    待落盘ChatIds.add(chatId);
  }
  if (落盘定时器) return;
  落盘定时器 = setTimeout(() => {
    落盘定时器 = null;
    const 快照 = 内存存储;
    const targets = new Set(待落盘ChatIds);
    待落盘ChatIds.clear();
    if (快照) void 写数据库(快照, targets.size > 0 ? targets : undefined);
  }, 落盘防抖毫秒);
}

/** 立即落盘（界面主动刷新/清空时调用，确保改动已持久化）。 */
export async function 立即落盘(): Promise<void> {
  if (落盘定时器) {
    clearTimeout(落盘定时器);
    落盘定时器 = null;
  }
  const 快照 = 内存存储;
  const targets = new Set(待落盘ChatIds);
  待落盘ChatIds.clear();
  if (快照) await 写数据库(快照, targets.size > 0 ? targets : undefined);
}
