/**
 * 变量楼层 —— 前端采集 / 存储服务（浏览器 iframe 环境）。
 *
 * 数据源（酒馆助手即真相）：
 *   消息楼层变量 `chat[i].variables[swipe_id].rp_hub`（{ [templateId]: variableState }）
 *   —— 由「变量单向同步服务」把 AI 回复更新块写入当前楼层消息变量。快照 = 该楼层
 *   自身 rp_hub 子树合并后的扁平表（逐楼独立，非 chat 层累积池）。
 *
 * 采集链路：
 *   eventOn(MESSAGE_RECEIVED / MESSAGE_UPDATED / MESSAGE_EDITED / GENERATION_ENDED)
 *     → 延迟 800ms（等酒馆助手楼层变量落定）→ 读该楼层消息变量 rp_hub → rp_hub构建快照
 *     → 与上一楼记录生成 diff → 幂等写入 localStorage（按聊天组织）
 *
 * 删除清理：
 *   eventOn(MESSAGE_DELETED) → 移除该楼层的记录（楼层变量随消息一起消失，
 *   由酒馆助手天然处理，无需写回还原）→ localStorage 历史随之清理。
 *
 * 存储结构（localStorage 键 thp_floor_variables_v1）：
 *   { version: 1, chats: { [chatId]: { cardName, cardId, records: [{ messageId, timestamp, snapshot, diff }] } } }
 *   localStorage 仅作变更历史；快照值一律以酒馆助手楼层变量为准。
 */
import { ref } from 'vue';
import {
  生成差异,
  插入或覆盖记录,
  取前一楼记录,
  rp_hub构建快照,
  空存储,
  type 扁平变量表,
  type 楼层记录,
  type 聊天记录,
  type 存储结构,
} from './楼层变量';
import { rp_hub命名空间 } from './楼层变量';
import { 记录日志 } from './运行日志';

/** rp-hub-compat 后端插件地址（相对路径，ST 自动补当前 origin，换端口/域名/局域网都通） */
const BASE = (() => {
  // srcdoc iframe 内相对路径 base 继承可能异常 → 用父窗口 origin 拼绝对路径（跟随部署 origin，不写死）
  try { const o = (window.parent ?? window)?.location?.origin; if (o) return o + '/api/plugins/rp-hub-compat/v1'; } catch {}
  return '/api/plugins/rp-hub-compat/v1';
})();

/** localStorage 键 */
const 存储键 = 'thp_floor_variables_v1';

/** 事件采集延迟（毫秒）：等后端/楼层变量落定后再拉快照 */
const 采集延迟毫秒 = 800;

/* ---------- 响应式状态（供「变量楼层」Tab 界面读取） ---------- */
const 当前聊天ID = ref<string | null>(null);
const 当前聊天记录 = ref<楼层记录[]>([]);
const 当前卡片名 = ref<string | null>(null);
const 当前卡片ID = ref<string | null>(null);

/* ---------- localStorage 读写 ---------- */

function 加载存储(): 存储结构 {
  try {
    const 原文 = localStorage.getItem(存储键);
    if (!原文) return 空存储();
    const 解析 = JSON.parse(原文) as 存储结构;
    if (!解析 || typeof 解析 !== 'object' || !解析.chats || typeof 解析.chats !== 'object') return 空存储();
    return 解析;
  } catch {
    return 空存储();
  }
}

function 保存存储(存储: 存储结构): void {
  try {
    localStorage.setItem(存储键, JSON.stringify(存储));
  } catch {
    // localStorage 不可用/写满时静默降级，不阻塞主流程
  }
}

/* ---------- SillyTavern / 宿主上下文 ---------- */

/** 读取 SillyTavern 上下文（iframe 宿主注入的全局对象，@types 未声明 getContext，参照 TabVariables 的取法） */
function 获取上下文(): any {
  try {
    return (SillyTavern as unknown as { getContext?: () => any }).getContext?.() ?? null;
  } catch {
    return null;
  }
}

/** 读取当前聊天 id（优先 getContext().chatId，兜底 getCurrentChatId / window.parent） */
function 获取聊天ID(): string | null {
  try {
    const ctx = 获取上下文();
    const id = ctx?.chatId ?? (SillyTavern as any)?.getCurrentChatId?.();
    if (typeof id === 'string' && id) return id;
  } catch {
    // 忽略，走兜底
  }
  try {
    const parent = window.parent as any;
    const pctx = parent?.SillyTavern?.getContext?.();
    const id = pctx?.chatId ?? parent?.SillyTavern?.getCurrentChatId?.();
    if (typeof id === 'string' && id) return id;
  } catch {
    // 忽略
  }
  return null;
}

/** 读取当前卡名（参照 TabDiagnose.vue 的取数方式） */
function 获取当前卡名(): string | null {
  try {
    const chid = SillyTavern.characterId;
    const characters = SillyTavern.characters;
    if (chid == null || chid === '' || Number(chid) < 0 || !Array.isArray(characters) || characters.length === 0) {
      return null;
    }
    const card = characters[Number(chid)];
    return card && typeof card.name === 'string' && card.name ? card.name : null;
  } catch {
    return null;
  }
}

/* ---------- 后端卡片信息（仅用于记录 cardName / cardId，快照不再依赖后端） ---------- */

/** 纯 GET 请求，CORS 直连（Access-Control-Allow-Origin: null）失败返回 null 不抛错 */
async function 请求<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface ByName {
  cardId: string;
  formatDetail: string | null;
}

/** 按当前卡名拉取 RP-Hub 卡片信息；无角色 / 非 rphub 卡 / 接口失败返回 null */
async function 拉取当前卡片(): Promise<{ cardName: string; cardId: string } | null> {
  const 卡名 = 获取当前卡名();
  if (!卡名) return null;
  const by_name = await 请求<ByName>(`${BASE}/cards/by-name/${encodeURIComponent(卡名)}`);
  if (!by_name) return null;
  return { cardName: 卡名, cardId: by_name.cardId };
}

/**
 * 读取指定楼层的酒馆助手消息变量 rp_hub 并构建扁平快照（酒馆助手即真相）。
 * 不在响应式依赖上采集，直接读楼层变量最新值；读不到 / 异常返回空表。
 */
function 读取楼层rp_hub快照(messageId: number | string): 扁平变量表 {
  try {
    const 全表 = getVariables({ type: 'message', message_id: Number(messageId) });
    return rp_hub构建快照(_.get(全表, rp_hub命名空间, {}));
  } catch {
    return {};
  }
}

/* ---------- 采集：记录楼层 ---------- */

async function 记录楼层(messageId: number | string): Promise<void> {
  const 聊天 = 获取聊天ID();
  if (!聊天) return;
  const 存储 = 加载存储();
  const 聊天集: 聊天记录 = 存储.chats[聊天] ?? { cardName: null, cardId: null, records: [] };
  // C2：卡片信息按聊天缓存 —— 仅该聊天首次记录时才请求后端 by-name，
  // 之后复用聊天集已存的 cardName/cardId（避免每楼一次后端请求；切聊天自然失效）
  let 卡片: { cardName: string; cardId: string } | null = null;
  if (!聊天集.cardName || !聊天集.cardId) {
    卡片 = await 拉取当前卡片();
  }
  const 快照 = 读取楼层rp_hub快照(messageId);
  // 完全无变量的楼不记录空楼层，避免刷屏「无变更」
  const 上一楼 = 取前一楼记录(聊天集.records, messageId);
  const 有内容 = Object.keys(快照).length > 0 || Object.keys(上一楼?.snapshot ?? {}).length > 0;
  if (!有内容) {
    刷新当前聊天();
    return;
  }
  聊天集.cardName = 卡片?.cardName ?? 聊天集.cardName;
  聊天集.cardId = 卡片?.cardId ?? 聊天集.cardId;
  const diff = 生成差异(上一楼?.snapshot, 快照);
  const 记录: 楼层记录 = {
    messageId,
    timestamp: new Date().toISOString(),
    snapshot: 快照,
    diff,
  };
  聊天集.records = 插入或覆盖记录(聊天集.records, 记录);
  存储.chats[聊天] = 聊天集;
  保存存储(存储);
  记录日志('楼层记录', `#${messageId} 楼层变量已记录（${Object.keys(diff).length} 个变更）`);
  刷新当前聊天();
}

/** 消息事件合并防抖：同一 messageId 的多次事件只做一次采集 */
const 采集定时器 = new Map<string | number, ReturnType<typeof setTimeout>>();

function 调度采集(messageId: number | string): void {
  const 旧 = 采集定时器.get(messageId);
  if (旧) clearTimeout(旧);
  采集定时器.set(
    messageId,
    setTimeout(() => {
      采集定时器.delete(messageId);
      void 记录楼层(messageId);
    }, 采集延迟毫秒),
  );
}

/* ---------- 删除：清理历史（楼层变量随消息消失，酒馆助手天然处理） ---------- */

async function 删除楼层记录(messageId: number | string): Promise<void> {
  const 聊天 = 获取聊天ID();
  if (!聊天) return;
  const 存储 = 加载存储();
  const 聊天集 = 存储.chats[聊天];
  if (!聊天集) return;
  const 新记录 = 聊天集.records.filter(r => String(r.messageId) !== String(messageId));
  if (新记录.length === 聊天集.records.length) {
    刷新当前聊天();
    return;
  }
  聊天集.records = 新记录;
  保存存储(存储);
  记录日志('楼层记录', `#${messageId} 楼层变量记录已删除（消息删除）`);
  刷新当前聊天();
}

/* ---------- 聊天切换 / 刷新 ---------- */

function 刷新当前聊天(): void {
  const 聊天 = 获取聊天ID();
  当前聊天ID.value = 聊天;
  if (!聊天) {
    当前聊天记录.value = [];
    当前卡片名.value = null;
    当前卡片ID.value = null;
    return;
  }
  const 存储 = 加载存储();
  const 聊天集 = 存储.chats[聊天];
  当前聊天记录.value = 聊天集?.records ?? [];
  当前卡片名.value = 聊天集?.cardName ?? null;
  当前卡片ID.value = 聊天集?.cardId ?? null;
}

/* ---------- 对外 API ---------- */

/** 启动事件监听（index.ts 挂载时调用；eventOn 在 iframe 关闭时自动卸载） */
export function 启动楼层记录服务(): void {
  刷新当前聊天();
  const 注册 = (事件: unknown, 处理器: (message_id: number) => void) => {
    try {
      (eventOn as (事件: unknown, 处理器: (message_id: number) => void) => { stop: () => void })(事件, 处理器);
    } catch {
      // 事件 API 不可用（极端情况）时静默降级：采集不生效但界面可用
    }
  };
  // 采集：AI 消息到达（及后续楼层更新/编辑/生成结束，防抖合并）
  if (tavern_events?.MESSAGE_RECEIVED) 注册(tavern_events.MESSAGE_RECEIVED, message_id => 调度采集(message_id));
  if (tavern_events?.MESSAGE_UPDATED) 注册(tavern_events.MESSAGE_UPDATED, message_id => 调度采集(message_id));
  if (tavern_events?.MESSAGE_EDITED) 注册(tavern_events.MESSAGE_EDITED, message_id => 调度采集(message_id));
  if (tavern_events?.GENERATION_ENDED) 注册(tavern_events.GENERATION_ENDED, message_id => 调度采集(message_id));
  // 删除 → 清理历史（楼层变量随消息消失）
  if (tavern_events?.MESSAGE_DELETED) 注册(tavern_events.MESSAGE_DELETED, message_id => void 删除楼层记录(message_id));
  // 切换聊天 → 记录列表随之切换
  if (tavern_events?.CHAT_CHANGED) {
    try {
      (eventOn as (事件: unknown, 处理器: () => void) => { stop: () => void })(tavern_events.CHAT_CHANGED, () =>
        刷新当前聊天(),
      );
    } catch {
      // 忽略
    }
  }
}

/** 界面「刷新」：重新从 localStorage 加载当前聊天记录 */
export function 刷新楼层记录(): void {
  刷新当前聊天();
}

/** 界面「清空本聊天记录」 */
export function 清空当前聊天记录(): void {
  const 聊天 = 当前聊天ID.value;
  if (!聊天) return;
  const 存储 = 加载存储();
  delete 存储.chats[聊天];
  保存存储(存储);
  记录日志('楼层记录', `已清空当前聊天（${聊天}）的楼层变量记录`);
  刷新当前聊天();
}

export { 当前聊天ID, 当前聊天记录, 当前卡片名, 当前卡片ID };
