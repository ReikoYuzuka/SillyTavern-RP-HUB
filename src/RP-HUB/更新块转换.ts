/**
 * 更新块转换 —— RP-Hub `<ui_template_updates>` 更新块 → 酒馆助手楼层变量 rp_hub 池表（纯函数，无副作用）。
 *
 * 对齐 RP-Hub 本体（data-services.js）：
 *   UI_TEMPLATE_UPDATES_PATTERN       /<ui_template_updates\b[^>]*>([\s\S]*?)<\/ui_template_updates>/i
 *   stripUiTemplateUpdateBlock        全局剥离闭合块 + 剥离末尾未闭合块 + trimEnd
 *   parseUiTemplateUpdateJson         去除代码围栏后 JSON.parse
 *   更新块 JSON 形态                   { updates: [{ id, variables, ... }] }（variables 为对象或数组）
 *
 * 转换目标（本扩展数据模型，写入酒馆助手消息楼层变量 chat[i].variables[swipe_id].rp_hub）：
 *   { [templateId]: 变量池 }
 *   - variables 为对象 → 按变量名深设进该模板池（对齐 RP-Hub setUiTemplateValue 语义，
 *     同一模板多次输出的变量合并，后写覆盖）；重复模板 id 不报错（本扩展不校验卡面 schema，
 *     直接透传）。
 *   - variables 为数组 → 整池替换（RP-Hub `$root` 数组形，如 social_nodes 列表）。
 *
 * 本模块不依赖 window / DOM / 酒馆助手接口，可在 Node 直接运行单测：
 *   node src/RP-HUB/更新块转换.test.ts
 */

/** 单模板变量池：{ [变量路径] → 值 }（嵌套对象，对齐 RP-Hub variableState） */
export type 模板变量表 = Record<string, unknown>;

/** 模板 id → 变量池 */
export type 模板池表 = Record<string, 模板变量表>;

/** 更新块匹配：首块捕获其 JSON 内容（对齐 RP-Hub UI_TEMPLATE_UPDATES_PATTERN） */
const 更新块匹配模式 = /<ui_template_updates\b[^>]*>([\s\S]*?)<\/ui_template_updates>/i;

/** 剥离全部闭合更新块（对齐 RP-Hub UI_TEMPLATE_UPDATES_STRIP_PATTERN） */
const 更新块剥离模式 = /<ui_template_updates\b[^>]*>[\s\S]*?<\/ui_template_updates>/gi;

/** 剥离末尾未闭合的更新块开头（对齐 RP-Hub UI_TEMPLATE_UPDATES_OPEN_STRIP_PATTERN） */
const 更新块未闭合剥离模式 = /<ui_template_updates\b[^>]*>[\s\S]*$/i;

/** 剥离更新块：移除所有闭合块 + 末尾未闭合块，并 trimEnd（对齐 RP-Hub stripUiTemplateUpdateBlock） */
export function 剥离更新块(文本: string): string {
  return String(文本 ?? '')
    .replace(更新块剥离模式, '')
    .replace(更新块未闭合剥离模式, '')
    .trimEnd();
}

/** 解析更新块 JSON：去除 ```json 代码围栏后 JSON.parse；非法 JSON 抛错（对齐 RP-Hub parseUiTemplateUpdateJson） */
export function 解析更新块JSON(内容: string): unknown {
  const 规范化 = String(内容 ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(规范化);
}

/**
 * 把解析出的更新块对象按模板 id 分组转换为池表。
 * 形态：{ updates: [{ id, variables }] }；variables 为对象（合并进池）或数组（整池替换）。
 * 无 updates / 无效项 / 缺模板 id / 缺 variables 一律跳过；整体非法输入返回空表（不抛错）。
 */
export function 更新块分组(解析: unknown): 模板池表 {
  const 池表: 模板池表 = {};
  if (!解析 || typeof 解析 !== 'object' || Array.isArray(解析)) return 池表;
  const updates = (解析 as { updates?: unknown }).updates;
  if (!Array.isArray(updates)) return 池表;

  for (const 更新 of updates) {
    if (!更新 || typeof 更新 !== 'object' || Array.isArray(更新)) continue;
    const { id, variables } = 更新 as { id?: unknown; variables?: unknown };
    if (typeof id !== 'string' || !id.trim()) continue;
    const 模板id = id.trim();

    if (Array.isArray(variables)) {
      // $root 数组形：整池替换
      池表[模板id] = variables as unknown as 模板变量表;
      continue;
    }
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) continue;

    // 合并进已有池（同一模板多次输出 → 逐变量覆盖）
    池表[模板id] = 池表[模板id] && typeof 池表[模板id] === 'object' && !Array.isArray(池表[模板id])
      ? 池表[模板id]
      : {};
    for (const [键, 值] of Object.entries(variables as Record<string, unknown>)) {
      设路径(池表[模板id], 键, 值);
    }
  }
  return 池表;
}

/**
 * 写侧路径分段（🔴-4 修复，与 模型解析.ts 的 拆分写路径 同构，改动需同步）：
 * 保留「方括号下标」信息——`a[0].b` 的 `[0]` 是数组下标（下钻时建数组），`a.b`/`a['x']`/`a["x"]` 是对象键。
 * 与读侧 模板渲染.ts 拆分路径 对齐：数组下标段归一为纯数字字符串（'0'），读侧按 `obj['0']` 访问。
 */
function 拆分写路径(点路径: string): Array<{ 键: string; 数组下标: boolean }> {
  const 原文 = String(点路径 || '').trim();
  const 段: Array<{ 键: string; 数组下标: boolean }> = [];
  let 当前 = '';
  const 提交当前 = () => {
    if (当前 !== '') {
      段.push({ 键: 当前, 数组下标: false });
      当前 = '';
    }
  };
  for (let i = 0; i < 原文.length; i++) {
    const 字符 = 原文[i];
    if (字符 === '.') {
      提交当前();
    } else if (字符 === '[') {
      提交当前();
      let 内 = '';
      i += 1;
      while (i < 原文.length && 原文[i] !== ']') {
        内 += 原文[i];
        i += 1;
      }
      内 = 内.trim();
      if (内 !== '') {
        const 去引号 = 内.replace(/^(['"])(.*)\1$/, '$2');
        段.push({ 键: 去引号, 数组下标: /^\d+$/.test(内) });
      }
    } else {
      当前 += 字符;
    }
  }
  提交当前();
  return 段;
}

/** 按点路径在普通对象上设值（对齐 lodash set：支持 `a[0].b` 方括号数组下标；路径不存在时自动建中间对象/数组） */
export function 设路径(目标: Record<string, unknown>, 点路径: string, 值: unknown): void {
  if (!点路径) return;
  const 段 = 拆分写路径(点路径);
  if (段.length === 0) return;
  let 当前 = 目标;
  for (let i = 0; i < 段.length - 1; i++) {
    const 键 = 段[i].键;
    const 下一段是数组下标 = 段[i + 1].数组下标;
    const 下一 = 当前[键];
    if (Array.isArray(下一)) {
      // 🔴-4/UB4 修复：已存在数组时保留数组（数组下标成员修改不能把数组覆盖成 {}）
      当前 = 下一 as unknown as Record<string, unknown>;
      continue;
    }
    if (下一 === null || typeof 下一 !== 'object') {
      当前[键] = 下一段是数组下标 ? [] : {};
    }
    当前 = 当前[键] as Record<string, unknown>;
  }
  当前[段[段.length - 1].键] = 值;
}

/** 一次转换的结果 */
export interface 转换结果 {
  /** 剥离更新块后的正文（对用户 / 对 AI 隐藏） */
  正文: string;
  /** 转换出的模板池表；无更新块 / 解析失败 / 池为空时为 null */
  变量表: 模板池表 | null;
  /** 解析失败原因文本（仅 JSON 非法时有值，正文仍会被剥离） */
  错误: string | null;
}

/**
 * 主入口：正文 → 剥离正文 + 模板池表。
 * 无更新块 → 原样返回（正文 = 输入，不 trim，避免误伤普通消息）。
 * 有更新块但 JSON 非法 → 正文剥离，变量表 null，错误记录原因（正文照常隐藏）。
 * UB2 说明：多更新块时仅**首个**更新块被解析（匹配模式无 `g`），其余块由 剥离更新块 全局删除
 * 但内容丢弃（对齐 RP-Hub 原版单块语义）。若未来需支持多块，改匹配模式为全局并逐块合并。
 */
export function 转换更新块(文本: string): 转换结果 {
  const 原文 = String(文本 ?? '');
  const 匹配 = 原文.match(更新块匹配模式);
  if (!匹配) {
    return { 正文: 原文, 变量表: null, 错误: null };
  }
  const 正文 = 剥离更新块(原文);
  const 内容 = 匹配[1];
  if (!内容 || !内容.trim()) {
    return { 正文, 变量表: null, 错误: null };
  }
  try {
    const 解析 = 解析更新块JSON(内容);
    const 变量表 = 更新块分组(解析);
    return { 正文, 变量表: Object.keys(变量表).length > 0 ? 变量表 : null, 错误: null };
  } catch (e) {
    return { 正文, 变量表: null, 错误: String(e instanceof Error ? e.message : e) };
  }
}
