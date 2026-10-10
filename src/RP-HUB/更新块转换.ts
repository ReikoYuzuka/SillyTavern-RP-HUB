/**
 * 更新块转换 —— RP-Hub `<ui_template_updates>` 更新块 → 酒馆助手楼层变量 rp_hub 池表（纯函数，无副作用）。
 *
 * 对齐 RP-Hub 本体（终审报告 D1 / P1-D2 / D4，行号为 2026-10-07 实读）：
 *   data-services.js:1381-1394  findUiTemplateUpdateBlock —— 取**最后一个未保护**开标签
 *                               （保护扫描 = core-utils.js:299-324 findLastUnprotectedMatch，
 *                               includeUiTemplateUpdates 豁免：受保护更新块区域的**开头开标签**
 *                               仍可搜索），taggedTail 锚定到文末、**闭合标签可选**；
 *   data-services.js:1396-1400  stripUiTemplateUpdateBlock —— 正文 = 开标签之前的部分 trimEnd
 *                               （多块时更早的闭合块留在正文中——官方原样语义）；
 *   data-services.js:1402-1422  parseUiTemplateUpdates —— 剥 ``` 围栏 → JSON.parse（空内容=无更新）
 *                               → 多模板判定（期望模板 >1 且裸数组且每项 {id:string, variables 存在}）
 *                               → 否则单模板 { id:'', variables:解析结果 }（裸对象/裸数组/任意 JSON 合法）；
 *   data-services.js:1424-1497  normalizeUiTemplateUpdateList —— 严格校验：缺 variables / 缺模板ID /
 *                               未知模板ID / 重复输出 → issues；官方 throw → app.js:2445-2449
 *                               recordFailure（console.warn + uiTemplateAnalysisFailure 标记，可见）；
 *                               本扩展折算为 错误 文本返回（调用方记录日志），同样**全量不应用**。
 *   core-utils.js:19-69         parseCot 栈式思考块（保护扫描依赖，TS 镜像）；
 *   core-utils.js:278-297       protectedContentPattern + splitProtectedText（保护扫描依赖，TS 镜像）。
 *
 * 与官方的差异（均为本扩展数据模型 / 环境所限，已在修复报告声明）：
 *   - 不做官方 validateValue 变量 schema 类型校验（:1457-1493）——本扩展池模型对卡面 schema
 *     透传（不校验未定义变量/类型错误），校验收敛到结构层（上述 issues）；
 *   - 官方 expectedTemplates 来自内存 activeUiTemplates（恒可知）；本扩展由调用方注入
 *     期望模板 id 列表（楼层池键 ∪ 开场白初始化池键 / 后端模板列表），列表未知时（空）：
 *     带显式 id 的更新仍接受（未知模板ID校验跳过），裸 JSON 单模板更新回填失败 → 可见 issue；
 *   - {updates:[…]} 外包裹形态是本扩展 标准注入模板（模型解析.ts）教授的协议，解析层
 *     按官方多模板路径同款 map({id, variables}) 处理；未定义字段（reason 等）同官方
 *     :1439-1440 校验拒绝（注入指令已同步禁止输出 reason，见 模型解析.ts 最终限制行）。
 *
 * 转换目标（本扩展数据模型，写入酒馆助手消息楼层变量 chat[i].variables[swipe_id].rp_hub）：
 *   { [templateId]: 变量池 }
 *   - variables 为对象 → 按变量名深设进该模板池（对齐 RP-Hub setUiTemplateValue 语义，
 *     同一模板多次输出的变量合并，后写覆盖）。
 *   - variables 为数组 → 整池替换（RP-Hub `$root` 数组形，如 social_nodes 列表）。
 *
 * 本模块不依赖 window / DOM / 酒馆助手接口，可在 Node 直接运行单测（临时脚本 import 本文件）。
 */

/** 单模板变量池：{ [变量路径] → 值 }（嵌套对象，对齐 RP-Hub variableState） */
export type 模板变量表 = Record<string, unknown>;

/** 模板 id → 变量池 */
export type 模板池表 = Record<string, 模板变量表>;

/* ==================== 保护扫描 TS 镜像（取块依赖，core-utils.js 实读镜像） ==================== */

/** 官方 parseCot 的 token 扫描正则（core-utils.js:24 逐字，gi）。 */
const PARSE_COT_TOKENS = /<(html|script|style|ui_template_updates)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<!--[\s\S]*?(?:-->|$)|```[\s\S]*?(?:```|$)|`[^`\r\n]*`|<\s*(\/?)\s*(thinking|think|cot)\s*>|<\/?[a-zA-Z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;

/** 官方 protectedContentPattern 的 source（core-utils.js:278 逐字，14 备选）。 */
const 官方保护源 = "<!DOCTYPE html>[\\s\\S]*?<\\/html>|<html\\b[^>]*>[\\s\\S]*?<\\/html>|<script\\b[^>]*>[\\s\\S]*?<\\/script>|<style\\b[^>]*>[\\s\\S]*?<\\/style>|<!DOCTYPE html>[\\s\\S]*$|<html\\b[^>]*>[\\s\\S]*$|<script\\b[^>]*>[\\s\\S]*$|<style\\b[^>]*>[\\s\\S]*$|<ui_template_updates\\b[^>]*>[\\s\\S]*?(?:<\\/ui_template_updates>|$)|<!--[\\s\\S]*?(?:-->|$)|```[\\s\\S]*?```|```[\\s\\S]*$|`[^`]+`|<\\/?[a-zA-Z][\\w:-]*(?:[^\"'<>]|\"[^\"]*\"|'[^']*')*>";

/** 官方 protectedContentPattern（core-utils.js:278，gi）。 */
const 保护拆分模式 = new RegExp(`(${官方保护源})`, 'gi');

/** 官方 exactProtectedContentPattern（core-utils.js:279，^…$ i 锚定）。 */
const 保护精确模式 = new RegExp(`^(${官方保护源})$`, 'i');

/**
 * parseCot 思考块范围 —— 逐字复刻 core-utils.js:19-69 的栈式解析（只取 ranges）：
 * 重复开标签仍属于分析；只有真正的闭合标签才能放行正文；尾部未闭合 → range 吃到文本末尾（:56）。
 */
export function parseCotRanges(text: string): Array<{ start: number; end: number }> {
  const source = String(text || '');
  if (!source) return [];
  const openTags: string[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  let blockStart = 0;
  for (const match of source.matchAll(PARSE_COT_TOKENS)) {
    if (!match[3]) continue; // 非思考标签 token：只推进扫描
    const tag = match[3].toLowerCase();
    if (!match[2]) {
      if (!openTags.length) blockStart = match.index ?? 0;
      if (!openTags.includes(tag)) openTags.push(tag);
    } else if (openTags[openTags.length - 1] === tag) {
      openTags.pop();
      if (!openTags.length) ranges.push({ start: blockStart, end: (match.index ?? 0) + match[0].length });
    }
  }
  if (openTags.length) ranges.push({ start: blockStart, end: source.length });
  return ranges;
}

/** splitProtectedText（core-utils.js:280-294）：先 parseCot.ranges 标思考块受保护，其余按保护模式切分。 */
function 拆保护段(source: string): Array<{ 文本: string; 受保护: boolean }> {
  const parts: Array<{ 文本: string; 受保护: boolean }> = [];
  const appendPlain = (value: string) => {
    value.split(保护拆分模式).forEach(part => {
      if (part) parts.push({ 文本: part, 受保护: 保护精确模式.test(part) });
    });
  };
  let cursor = 0;
  for (const { start, end } of parseCotRanges(source)) {
    appendPlain(source.slice(cursor, start));
    parts.push({ 文本: source.slice(start, end), 受保护: true });
    cursor = end;
  }
  appendPlain(source.slice(cursor));
  return parts;
}

/**
 * findLastUnprotectedMatch（core-utils.js:321-324 + :299-320 findUnprotectedMatches 的
 * includeUiTemplateUpdates 豁免）：返回最后一个未保护 `<ui_template_updates` 开标签的下标。
 * 受保护的更新块区域只有**开头的开标签**可搜索（core-utils.js:304-306）；块内 JSON 不参与匹配。
 */
function 查找最后未保护开标签(source: string): { index: number } | null {
  const pattern = /<ui_template_updates\b[^>]*>/gi;
  let offset = 0;
  const 命中: number[] = [];
  for (const part of 拆保护段(source)) {
    const searchable = !part.受保护
      ? part.文本
      : (part.文本.match(/^<ui_template_updates\b[^>]*>/i)?.[0] || '');
    if (searchable) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(searchable)) !== null) {
        命中.push((m.index ?? 0) + offset);
        if (!m[0]) pattern.lastIndex += 1;
      }
    }
    offset += part.文本.length;
  }
  return 命中.length ? { index: 命中[命中.length - 1] } : null;
}

/** 更新块匹配结果（对齐 findUiTemplateUpdateBlock 返回：[taggedTail, 内容]，外加起始下标） */
export interface 更新块匹配 {
  /** 开标签起到文末（trimEnd）的整段 */
  块文本: string;
  /** 块内 JSON 内容（闭合标签可选；官方锚定正则下，闭合标签之后的残余正文会并入内容） */
  内容: string;
  /** 开标签在原文中的下标 */
  起始: number;
}

/**
 * findUiTemplateUpdateBlock（data-services.js:1381-1394 逐字镜像）：
 * 最后一个未保护开标签 → taggedTail 锚定到文末（/^<ui_template_updates\b[^>]*>([\s\S]*?)(?:<\/ui_template_updates>)?$/i）
 * → 闭合标签可选。无未保护开标签 / 尾部不匹配 → null。
 */
export function 查找更新块(文本: string): 更新块匹配 | null {
  const source = String(文本 ?? '');
  const 候选 = 查找最后未保护开标签(source);
  if (!候选) return null;
  const taggedTail = source.slice(候选.index).trimEnd();
  const tagged = taggedTail.match(/^<ui_template_updates\b[^>]*>([\s\S]*?)(?:<\/ui_template_updates>)?$/i);
  if (!tagged) return null;
  return { 块文本: taggedTail, 内容: tagged[1], 起始: 候选.index };
}

/* ==================== 剥离 / 解析（对齐 stripUiTemplateUpdateBlock / parseUiTemplateUpdates） ==================== */

/**
 * 剥离更新块（stripUiTemplateUpdateBlock，data-services.js:1396-1400 逐字镜像）：
 * 更新块（最后一个未保护开标签）之前的正文 trimEnd；无更新块 → 原样返回（不 trim）。
 */
export function 剥离更新块(文本: string): string {
  const source = String(文本 ?? '');
  const 匹配 = 查找更新块(source);
  return 匹配 ? source.slice(0, 匹配.起始).trimEnd() : source;
}

/**
 * 解析更新块 JSON（parseUiTemplateUpdates 前半，data-services.js:1402-1415 逐字镜像）：
 * 剥 ```json 围栏后 JSON.parse；空内容 → undefined（官方返回 {updates:[]}，等价无更新）；
 * 非法 JSON → SyntaxError('JSON变量块格式错误：…')。
 */
export function 解析更新块JSON(内容: string): unknown {
  const 规范化 = String(内容 ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!规范化) return undefined;
  try {
    return JSON.parse(规范化);
  } catch (e) {
    throw new SyntaxError(`JSON变量块格式错误：${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/* ==================== 分组（对齐 parseUiTemplateUpdates 判定树 + normalizeUiTemplateUpdateList 校验） ==================== */

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

/** 把单条更新写入池表：对象 → 逐变量点路径合并（后写覆盖）；数组 → $root 整池替换。 */
function 写入池(池表: 模板池表, id: string, 变量: unknown): void {
  if (Array.isArray(变量)) {
    池表[id] = 变量 as unknown as 模板变量表;
    return;
  }
  const 池 = (池表[id] && typeof 池表[id] === 'object' && !Array.isArray(池表[id]))
    ? 池表[id]
    : ({} as 模板变量表);
  池表[id] = 池;
  for (const [键, 值] of Object.entries(变量 as Record<string, unknown>)) {
    设路径(池, 键, 值);
  }
}

/**
 * 逐更新项校验并合并（normalizeUiTemplateUpdateList :1434-1447 + :1484-1487 的结构层镜像）：
 * 缺 variables / 缺模板ID / 未知模板ID / 重复输出 → push 进 问题（官方 join('；') 后 throw）。
 * id 回填：显式 id 为空且期望模板恰好 1 个 → 回填（官方 :1442）。
 */
function 归一并合并更新项(
  原始项: unknown[],
  期望模板ids: string[] | undefined,
  池表: 模板池表,
  问题: string[],
): void {
  const 已收 = new Map<string, number>();
  const 有期望列表 = Array.isArray(期望模板ids) && 期望模板ids.length > 0;
  原始项.forEach((项, 序号) => {
    const 位置 = `第 ${序号 + 1} 项`;
    if (!项 || typeof 项 !== 'object' || Array.isArray(项)) {
      问题.push(`${位置}不是有效对象`);
      return;
    }
    const 记录 = 项 as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(记录, 'variables')) {
      问题.push(`${位置}缺少 variables 字段`);
      return;
    }
    const 变量 = 记录.variables;
    if (变量 === null || typeof 变量 !== 'object') {
      问题.push(`${位置}的 variables 必须是对象或数组`);
      return;
    }
    // 官方 :1439-1440：update 项只允许 id/variables 两个字段
    const 未知字段 = Object.keys(记录).filter(键 => 键 !== 'id' && 键 !== 'variables');
    if (未知字段.length > 0) {
      问题.push(`${位置}包含未定义字段：${未知字段.join('、')}`);
      return;
    }
    const 显式id = typeof 记录.id === 'string' ? 记录.id.trim() : '';
    const id = 显式id || (期望模板ids?.length === 1 ? 期望模板ids[0] : '');
    if (!id) {
      问题.push(期望模板ids && 期望模板ids.length > 1
        ? `${位置}缺少模板ID；多模板必须使用JSON数组成员的 id 字段`
        : `${位置}缺少有效模板ID`);
      return;
    }
    if (有期望列表 && !期望模板ids!.includes(id)) {
      问题.push(`${位置}使用了未知模板ID“${id}”`);
      return;
    }
    已收.set(id, (已收.get(id) ?? 0) + 1);
    写入池(池表, id, 变量);
  });
  for (const [id, 次数] of 已收) {
    if (次数 > 1) 问题.push(`模板“${id}”重复输出了 ${次数} 次`);
  }
}

/** 更新块分组结果：池表 + 结构校验问题（空数组 = 无问题） */
export interface 分组结果 {
  池表: 模板池表;
  问题: string[];
}

/**
 * 把解析出的更新块对象按官方判定树（data-services.js:1402-1422）分组为池表：
 *   A. {updates:[…]} 外包裹（本扩展 标准注入模板 协议）→ 逐项 {id, variables}；
 *      未定义字段（reason 等）按官方 :1439-1440 严格拒绝（校验失败、整块不应用，不静默丢弃）；
 *   B. 裸数组且每项 {id:string, variables 存在} 且期望模板 >1 → 官方多模板路径（:1416-1419）；
 *      期望模板列表未知（未提供/为空）时同形数组也按多模板处理（兼容放宽：显式 id 无需回填）；
 *   C. 其余任意 JSON（裸对象/裸数组 $root）→ 单模板 variables（:1421），id 回填要求期望模板恰好 1 个。
 * 校验问题非空时调用方应整体不应用（官方 normalize throw → recordFailure 全量失败语义）。
 */
export function 更新块分组(解析: unknown, 期望模板ids?: string[]): 分组结果 {
  const 池表: 模板池表 = {};
  const 问题: string[] = [];
  if (解析 === undefined) return { 池表, 问题 }; // 空内容 → 无更新（官方 :1407 {updates:[]} 等价）

  // 形态 A：{updates:[…]} 外包裹
  if (解析 && typeof 解析 === 'object' && !Array.isArray(解析)
    && Array.isArray((解析 as { updates?: unknown }).updates)) {
    归一并合并更新项((解析 as { updates: unknown[] }).updates, 期望模板ids, 池表, 问题);
    return { 池表, 问题 };
  }

  // 形态 B：裸更新项数组（官方多模板判定 :1416-1418）
  const 是更新项数组 = Array.isArray(解析) && 解析.every(项 =>
    项 !== null && typeof 项 === 'object' && !Array.isArray(项)
    && typeof (项 as { id?: unknown }).id === 'string'
    && Object.prototype.hasOwnProperty.call(项 as Record<string, unknown>, 'variables'));
  if (是更新项数组 && (期望模板ids?.length ?? 0) !== 1) {
    // 期望 >1 = 官方路径；期望未知（undefined/空）= 兼容放宽（显式 id 直接采用）
    归一并合并更新项(解析 as unknown[], 期望模板ids, 池表, 问题);
    return { 池表, 问题 };
  }

  // 形态 C：单模板裸 JSON（官方 :1421 {updates:[{id:'', variables:parsed}]} → normalize :1443）；
  // 官方文案：期望>1 → '第 1 项缺少模板ID；多模板必须使用JSON数组成员的 id 字段'；否则 '缺少有效模板ID'
  // （官方 else 支同样不被修正提示词正则 /缺少模板ID|多个模板/i 命中，见 built-in-content.js:193；
  //  期望未知的自加文案则内嵌「缺少模板ID」子串，保证未来接自愈链时可被官方式正则命中）。
  const id = 期望模板ids?.length === 1 ? 期望模板ids[0] : '';
  if (!id) {
    问题.push(期望模板ids && 期望模板ids.length > 1
      ? '第 1 项缺少模板ID；多模板必须使用JSON数组成员的 id 字段'
      : '第 1 项缺少模板ID：裸 JSON 更新要求当前卡面恰好一个模板用于回填（或改用 {"updates":[{"id":"模板id","variables":{…}}]} 包裹形态）');
    return { 池表, 问题 };
  }
  if (解析 === null || typeof 解析 !== 'object') {
    问题.push(`变量块JSON必须是对象或数组（当前：${解析 === null ? 'null' : typeof 解析}）`);
    return { 池表, 问题 };
  }
  写入池(池表, id, 解析);
  return { 池表, 问题 };
}

/* ==================== 主入口 ==================== */

/** 一次转换的结果 */
export interface 转换结果 {
  /** 剥离更新块后的正文（对用户 / 对 AI 隐藏） */
  正文: string;
  /** 转换出的模板池表；无更新块 / 解析失败 / 校验失败 / 池为空时为 null */
  变量表: 模板池表 | null;
  /** 失败原因文本（JSON 非法 或 结构校验问题，多项以 '；' 连接；成功时 null） */
  错误: string | null;
}

/** 转换更新块选项 */
export interface 转换更新块选项 {
  /**
   * 当前卡面模板 id 列表（官方 expectedTemplates，data-services.js:1402）：
   * 用于单模板裸 JSON 的 id 回填与未知模板ID校验。调用方注入（楼层池键 ∪ 开场白初始化池键 /
   * 后端模板列表）；不提供或为空 → 带显式 id 的更新照常处理，裸 JSON 回填失败（可见 issue）。
   */
  期望模板ids?: string[];
}

/**
 * 主入口：正文 → 剥离正文 + 模板池表（对齐 findUiTemplateUpdateBlock + parseUiTemplateUpdates +
 * normalizeUiTemplateUpdateList 链，全量失败语义：结构校验问题非空 → 变量表 null + 错误文本）。
 * 无更新块 → 原样返回（正文 = 输入，不 trim，避免误伤普通消息）。
 * 有更新块但 JSON 非法 / 校验失败 → 正文剥离，变量表 null，错误记录原因（正文照常隐藏）。
 * 多更新块语义（官方）：仅**最后一个**未保护块被解析；更早的闭合块不解析且**留在正文中**
 * （stripUiTemplateUpdateBlock 只切到最后一个开标签，data-services.js:1396-1400）。
 */
export function 转换更新块(文本: string, 选项: 转换更新块选项 = {}): 转换结果 {
  const 原文 = String(文本 ?? '');
  const 匹配 = 查找更新块(原文);
  if (!匹配) {
    return { 正文: 原文, 变量表: null, 错误: null };
  }
  const 正文 = 原文.slice(0, 匹配.起始).trimEnd();
  const 内容 = 匹配.内容;
  if (!内容 || !内容.trim()) {
    return { 正文, 变量表: null, 错误: null }; // 空块 → 无更新（官方 :1407）
  }
  let 解析: unknown;
  try {
    解析 = 解析更新块JSON(内容);
  } catch (e) {
    return { 正文, 变量表: null, 错误: String(e instanceof Error ? e.message : e) };
  }
  const { 池表, 问题 } = 更新块分组(解析, 选项.期望模板ids);
  if (问题.length > 0) {
    // 官方 normalizeUiTemplateUpdateList throw（:1495）→ recordFailure（app.js:2445-2449）等价：
    // 全量不应用 + 可见失败原因。
    return { 正文, 变量表: null, 错误: 问题.join('；') };
  }
  return { 正文, 变量表: Object.keys(池表).length > 0 ? 池表 : null, 错误: null };
}
