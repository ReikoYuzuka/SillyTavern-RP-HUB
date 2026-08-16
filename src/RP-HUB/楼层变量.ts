/**
 * 变量楼层 —— 逐楼变量快照 / 差异 / 还原计算（纯函数，无副作用）。
 *
 * 数据模型：
 *   snapshot：某一楼层「处理完成后」的完整变量扁平快照（initial + 各模板 variableState 汇总，点路径扁平化）
 *   diff    ：相对「上一楼记录」的变更：{ 变量名 → { 旧值, 新值 } }，无变化 = 空对象
 *
 * 本模块不依赖 window / DOM，可在 Node 直接运行单测：
 *   node src/RP-HUB/楼层变量.test.ts
 * 浏览器采集链路与楼层记录共用同一套逻辑，保证前后端/测试一致。
 */

/** 扁平化后的变量表：点路径 → 叶子值 */
export type 扁平变量表 = Record<string, unknown>;

/** 一次变量变更 */
export interface 变化条目 {
  旧值: unknown;
  新值: unknown;
}

/** 差异表：变量名 → 变更；无变化 = 空对象 */
export type 差异表 = Record<string, 变化条目>;

/** 一层楼（一条消息）的变量记录 */
export interface 楼层记录 {
  /** 酒馆消息 id（.mes 的 message_id / mesid） */
  messageId: number | string;
  /** 记录时间 ISO 字符串 */
  timestamp: string;
  /** 该楼层处理完成后的完整变量快照（扁平） */
  snapshot: 扁平变量表;
  /** 相对上一楼层的变更（无变更 = 空对象） */
  diff: 差异表;
}

/** 单聊天的记录集合 */
export interface 聊天记录 {
  cardName: string | null;
  cardId: string | null;
  records: 楼层记录[];
}

/** localStorage 持久化结构（按聊天组织） */
export interface 存储结构 {
  version: 1;
  chats: Record<string, 聊天记录>;
}

/**
 * 递归扁平化对象为 点路径 → 叶子值。
 * 数组 / 空对象 / 原始值视为叶子；嵌套非空对象继续展开。
 */
export function 扁平化变量表(输入: unknown, 前缀 = ''): 扁平变量表 {
  const 输出: 扁平变量表 = {};
  if (!输入 || typeof 输入 !== 'object' || Array.isArray(输入)) return 输出;
  for (const [键, 值] of Object.entries(输入 as Record<string, unknown>)) {
    const 路径 = 前缀 ? `${前缀}.${键}` : 键;
    if (值 && typeof 值 === 'object' && !Array.isArray(值) && Object.keys(值 as object).length > 0) {
      Object.assign(输出, 扁平化变量表(值, 路径));
    } else {
      输出[路径] = 值;
    }
  }
  return 输出;
}

/** 后端 GET .../cards/{cardId}/variables → variables 的形态（保留：诊断/卡面提示词等后端视图使用） */
export interface 后端变量 {
  initial?: unknown;
  uiTemplates?: Array<{ id?: unknown; variableState?: unknown } | null | undefined>;
  runtimeByCharacter?: unknown;
}

/**
 * 酒馆助手消息楼层变量的保留命名空间：`chat[i].variables[swipe_id].rp_hub.<templateId>.<变量>`。
 * 酒馆助手即真相：本扩展的 UI / 楼层快照都以此为数据源（单向写入，不做双向同步）。
 */
export const rp_hub命名空间 = 'rp_hub';

/**
 * 把酒馆助手楼层变量 `rp_hub` 子树（`{ [templateId]: variableState }`）合并为扁平快照。
 * 与「构建快照」不同：本快照是「模板作用域」扁平表，键形如 `{templateId}.{变量点路径}`。
 * 作用：楼层采集 / 楼层记录（快照即逐楼变量，diff 相对上一楼）。
 */
export function rp_hub构建快照(rp_hub值: unknown): 扁平变量表 {
  if (!rp_hub值 || typeof rp_hub值 !== 'object' || Array.isArray(rp_hub值)) return {};
  const 输出: 扁平变量表 = {};
  for (const [模板id, 池] of Object.entries(rp_hub值 as Record<string, unknown>)) {
    const 池扁平 = 扁平化变量表(池);
    for (const [路径, 值] of Object.entries(池扁平)) {
      输出[`${模板id}.${路径}`] = 值;
    }
  }
  return 输出;
}

/** 深比较（JSON 序列化兜底）；null / undefined 视为相等（都是「缺失」） */
export function 值相同(甲: unknown, 乙: unknown): boolean {
  if (甲 === 乙) return true;
  try {
    return JSON.stringify(甲 ?? null) === JSON.stringify(乙 ?? null);
  } catch {
    return false;
  }
}

/**
 * 生成差异：前一快照 → 当前快照，变化的键写入 diff。
 * 缺失键以 null 表示（快照中无该变量）。
 */
export function 生成差异(前一: 扁平变量表 | undefined, 当前: 扁平变量表 | undefined): 差异表 {
  const 前 = 前一 ?? {};
  const 今 = 当前 ?? {};
  const diff: 差异表 = {};
  const 全部键 = new Set([...Object.keys(前), ...Object.keys(今)]);
  for (const 键 of 全部键) {
    const 旧 = 前[键];
    const 新 = 今[键];
    if (!值相同(旧, 新)) {
      diff[键] = { 旧值: 旧 === undefined ? null : 旧, 新值: 新 === undefined ? null : 新 };
    }
  }
  return diff;
}

/** 按 messageId 幂等插入/覆盖楼层记录（覆盖同 messageId 旧记录） */
export function 插入或覆盖记录(记录列表: 楼层记录[], 新记录: 楼层记录): 楼层记录[] {
  const 结果 = 记录列表.filter(r => String(r.messageId) !== String(新记录.messageId));
  结果.push(新记录);
  return 结果;
}

/** 取「比该 messageId 小且最接近」的上一条楼层记录（作为 diff 基准）；无则返回 undefined */
export function 取前一楼记录(记录列表: 楼层记录[], messageId: number | string): 楼层记录 | undefined {
  const 目标 = Number(messageId);
  if (Number.isNaN(目标)) return undefined;
  let best: 楼层记录 | undefined;
  for (const r of 记录列表) {
    const id = Number(r.messageId);
    if (!Number.isNaN(id) && id < 目标) {
      if (!best || id > Number(best.messageId)) best = r;
    }
  }
  return best;
}

/** 楼层记录按 messageId 排序（asc=true 正序；false 倒序） */
export function 排序楼层(记录列表: 楼层记录[], asc = true): 楼层记录[] {
  return [...(记录列表 ?? [])].sort((a, b) => {
    const ia = Number(a.messageId) || 0;
    const ib = Number(b.messageId) || 0;
    return asc ? ia - ib : ib - ia;
  });
}

/** 空存储结构 */
export function 空存储(): 存储结构 {
  return { version: 1, chats: {} };
}
