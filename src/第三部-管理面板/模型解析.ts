/**
 * 模型解析 —— 「额外模型解析」模式的核心纯函数（无副作用，可 Node 单测）。
 *
 * 对齐 RP-Hub 原版（app.js:3457-3655 updateUiTemplatesFromChat + built-in-content.js:161-191
 * buildUiTemplateAnalysisSystemPrompt）：
 *   独立模型对「最近 N 条对话」逐模板分析，返回 {"variables":{...},"reason":"..."} 或
 *   裸数组（模板根变量为数组时整池替换），解析结果经 设路径 合并进该模板池表。
 *
 * 本模块只做纯转换：系统提示词构建 / 响应解析 / 最近消息收集。API 调用（直连 OpenAI 兼容
 * 端点或复用酒馆主 API）在服务层（TabVariables / 启动入口）按配置决定，不在此处。
 *
 * 变量同步语义与 变量单向同步.ts 一致：解析结果最终写进楼层变量 rp_hub
 * （chat[i].variables[swipe_id].rp_hub，经 写楼层变量()）。
 *
 * 本模块不依赖 window / DOM / 酒馆助手接口，且保持自包含（不 import 其它内部模块），
 * 可在 Node 直接运行单测：
 *   node src/第三部-管理面板/模型解析.test.ts
 */

/** 单模板变量池：{ [变量路径] → 值 }（嵌套对象，对齐 RP-Hub variableState；与 更新块转换.ts 同构） */
export type 模板变量表 = Record<string, unknown>;

/** 模板 id → 变量池 */
export type 模板池表 = Record<string, 模板变量表>;

/**
 * 写侧路径分段（🔴-4 修复，与 更新块转换.ts 的 拆分写路径 同构，改动需同步）：
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

/** 按点路径在普通对象上设值（对齐 lodash set：支持 `a[0].b` 方括号数组下标；与 更新块转换.ts 设路径 同构） */
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

/** 卡面变量模板（后端 uiTemplates 数组元素，只取解析所需字段；与 card-prompt.ts 卡面变量模板 同构） */
export interface 卡面变量模板 {
  id: string;
  name?: string;
  variableState?: unknown;
  initialVariableState?: unknown;
  /** 变量说明：对象（含 _update_rules）或整段规则字符串（真实世界模拟器V2.1 等卡形态） */
  variableSchema?: Record<string, unknown> | string;
}

/**
 * 构建单模板分析系统提示词（对齐 RP-Hub buildUiTemplateAnalysisSystemPrompt，中文版）。
 * 只分析一个模板：给定当前变量 JSON + 变量说明 + 用户信息，要求模型输出严格 JSON。
 * @param 参数 当前变量 JSON / 变量说明文本 / 用户信息 / 当前用户名
 * @returns 系统提示词全文（多段换行拼接）
 */
export function 构建解析系统提示词(参数: {
  /** 当前变量 JSON（缩进 2 的字符串，来自 模板.variableState） */
  当前变量JSON: string;
  /** 变量说明文本（variableSchema 字符串化；可为空串 → 不输出该段） */
  变量说明: string;
  /** 用户信息（称呼/人称/用户名判断用） */
  用户信息: string;
  /** 当前用户名（变量内容涉及用户时直接写此名） */
  用户名: string;
}): string {
  const { 当前变量JSON, 变量说明, 用户信息, 用户名 } = 参数;
  const 段落 = [
    '你是RP-Hub的UI变量更新器。当前请求只分析一个UI模板。',
    '只根据用户消息里提供的最近对话，更新下方模板已定义的变量。',
    '严格返回JSON，不要解释，不要输出Markdown。',
    '返回格式固定为 {"variables":{"变量路径":"新值"},"reason":"简短原因"}，例如 {"variables":{"a_line_1":"新台词","a_line_3":"新台词"},"reason":"对话内容更新了角色台词"}。',
    '输出前必须逐项检查当前变量JSON中的所有现有字段，不得只关注上一轮或最近连续更新过的字段；凡本轮剧情已明确改变的字段都要一并更新。当前值仍准确时不得仅改写措辞制造变化。',
    '变量值可以是文字、数字、对象或JSON数组；普通对象优先使用点路径更新。',
    '只允许更新当前变量JSON中已经存在的字段路径，以及变量说明明确允许新增的动态键或ID；除此之外不得新增对象键或顶层变量。动态键必须满足变量说明中的关联条件。',
    '如果模板根变量本身就是数组，可以直接返回JSON数组；固定数组仅修改成员内容时使用索引路径，例如 {"equipment[0].name":"短剑"}；数组新增、删除或重新排序成员时必须返回完整数组。',
    '清理与当前剧情无关的模板示例也属于必须完成的更新。只有剧情没有变化且当前变量中不存在待清理的示例内容时，才返回 {"variables":{},"reason":"无变化"}。不要返回模板id，不要套updates数组，不要修改HTML。',
    `变量内容涉及用户时，必须直接写当前用户名“${用户名.trim()}”；禁止保留用户占位符、双花括号或其他模板占位写法。`,
    '',
    '用户信息如下（用于判断称呼、人称和用户相关变量；不要在JSON外复述）：',
    用户信息,
    '',
    '当前变量JSON如下：',
    当前变量JSON,
  ];
  if (变量说明) {
    段落.push('', '变量说明如下（给AI参考，必须按这里理解字段含义和生成规则）：', 变量说明);
  }
  段落.push(
    '最终限制：无论变量说明如何描述，都不得输出当前变量JSON中不存在的字段路径；输出空variables对象前必须逐项检查当前变量JSON的内容。若模板内容与当前剧情不符，不得因此返回空更新：通用字段按当前剧情更新，与当前剧情不符的专属字段必须显式改为符合含义的"未出现"或"未解锁"等状态，数值字段改为符合未登场情况的数值；不得仅因名称相近就把不符的专属字段强行套给当前角色。其他与当前剧情无关的模板示例内容也必须在variables中显式更新对应变量，不得留空、写null或以剧情无关为由省略更新；已由剧情确认的数据不得清空。',
  );
  return 段落.join('\n');
}

/** 模型解析响应解析结果：解析出的变量表（对象 = 合并进池；数组 = $root 整池替换），或 null（无有效内容） */
export interface 解析结果 {
  /** 变量内容（对象：逐变量点路径合并；数组：整池替换） */
  变量: unknown;
  /** 模型给出的原因文本（reason，可空串） */
  原因: string;
}

/**
 * 解析独立模型的变量分析响应（对齐 RP-Hub normalizeUiTemplateUpdates + parseUiTemplateUpdateJson）。
 * 接受三种形态：
 *   - {"variables": {...}, "reason": "..."}   → 单模板对象合并（模式二标准形态）
 *   - {"updates": [...]}                       → RP-Hub 更新块形态（复用 更新块分组 语义）
 *   - 裸 JSON 数组                             → 模板根变量为数组的整池替换
 * 纯 JSON 数组 / {"variables":{...}} 直接返回；{"updates":[...]} 需外层再按 id 分组，
 * 本函数对单模板场景直接取第一项（调用方逐模板解析，模板 id 已知）。
 * @param content 模型输出文本（可能是 ```json 围栏包裹）
 * @throws 非法 JSON / 结构异常（由调用方记录原因）
 */
export function 解析模型变量响应(content: string): 解析结果 {
  const 规范化 = String(content ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const 解析 = JSON.parse(规范化);

  // 形态三：裸数组（模板根变量为数组）
  if (Array.isArray(解析)) {
    return { 变量: 解析, 原因: '' };
  }
  if (!解析 || typeof 解析 !== 'object') {
    throw new Error(`响应不是对象/数组：${String(内容摘要(规范化))}`);
  }

  // 形态一：{"variables": {...}, "reason": "..."}（标准）
  if (Object.prototype.hasOwnProperty.call(解析, 'variables')) {
    const 变量 = (解析 as { variables?: unknown }).variables;
    const 原因 = String((解析 as { reason?: unknown }).reason ?? '').trim();
    if (变量 === undefined || 变量 === null) return { 变量: {}, 原因 };
    return { 变量, 原因 };
  }

  // 形态二：{"updates": [...]}（RP-Hub 更新块形态）—— 取第一项（单模板场景）
  if (Object.prototype.hasOwnProperty.call(解析, 'updates')) {
    const updates = (解析 as { updates?: unknown }).updates;
    if (Array.isArray(updates) && updates.length > 0) {
      const 首项 = updates[0];
      if (首项 && typeof 首项 === 'object') {
        const 变量 = (首项 as { variables?: unknown }).variables;
        const 原因 = String((首项 as { reason?: unknown }).reason ?? '').trim();
        return { 变量: 变量 ?? {}, 原因 };
      }
    }
    return { 变量: {}, 原因: '' }; // 空 updates → 无变化
  }

  // 形态四：直接对象 {"字段":"值"}（宽松，视为单模板变量对象）
  return { 变量: 解析, 原因: '' };
}

/** 内容摘要（诊断用，截断超长非法 JSON 报错文本） */
function 内容摘要(文本: string): string {
  const 压缩 = 文本.replace(/\s+/g, ' ').slice(0, 120);
  return 压缩.length > 120 ? 压缩 + '…' : 压缩;
}

/**
 * 把解析出的变量内容合并进某模板池，返回合并后的池值（调用方写回池表）。
 * 对齐 更新块转换.ts 的 更新块分组 合并语义（同一模板多次输出逐变量覆盖）。
 * @param 池 目标模板池（对象形态时原地逐变量合并）
 * @param 变量 解析出的变量内容（对象或数组）
 * @returns 合并后的池值：对象形态返回原池（已合并）；数组形态返回数组本身（$root 整池替换）
 */
export function 合并解析变量(池: 模板池表[string], 变量: unknown): unknown {
  if (Array.isArray(变量)) {
    // $root 数组形：整池替换（调用方用返回值写回池表条目）
    return 变量;
  }
  if (变量 && typeof 变量 === 'object') {
    for (const [键, 值] of Object.entries(变量 as Record<string, unknown>)) {
      设路径(池, 键, 值);
    }
  }
  return 池;
}

/** 最近消息条目（角色名 + 内容，供独立模型分析用） */
export interface 最近消息 {
  role: 'user' | 'assistant';
  name: string;
  content: string;
}

/**
 * 收集最近 N 条非系统消息（对齐 RP-Hub updateUiTemplatesFromChat 的 sourceMessages：
 *   getPostprocessedChatMessages(contextMessages, { includeSystem:false }) → 取后 N 条，
 *   content 替换 {{user}} 宏 + 剥离 cot/系统块）。本模块接收已整理的消息数组，
 *   不做 DOM/API 访问（调用方提供），保证纯函数可测。
 * @param 消息列表 已整理的消息数组（role/name/content）
 * @param 深度 保留条数（对齐原版 clamp 4~10；调用方已归一）
 * @returns 最近 N 条
 */
export function 收集最近消息(消息列表: 最近消息[], 深度: number): 最近消息[] {
  const 深度归一 = Number.isFinite(深度) ? Math.max(1, Math.min(50, Math.floor(深度))) : 4;
  return (Array.isArray(消息列表) ? 消息列表 : []).slice(-深度归一);
}

/** 模板变量 JSON（缩进 2，对齐 RP-Hub currentVariableJson） */
export function 模板变量JSON(池: unknown): string {
  try {
    return JSON.stringify(池 ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

/** 变量说明文本：variableSchema 字符串化（对齐 RP-Hub stringifyUiSchema，对象/字符串直出，空 → ''） */
export function 变量说明文本(schema: unknown): string {
  if (typeof schema === 'string') return schema.trim();
  if (schema && typeof schema === 'object') {
    try {
      return JSON.stringify(schema, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

/** 读取模板当前变量池（variableState 优先，回退 initialVariableState；对齐原版运行时回退链） */
export function 模板当前变量(模板: 卡面变量模板): Record<string, unknown> {
  const 状态 = (模板.variableState && typeof 模板.variableState === 'object'
    ? 模板.variableState
    : (模板.initialVariableState && typeof 模板.initialVariableState === 'object'
        ? 模板.initialVariableState
        : {})) as Record<string, unknown>;
  return 状态;
}

/* ---------- 模式一（世界书注入）纯逻辑 ---------- */

/**
 * 构建模板载荷 JSON（对齐 RP-Hub buildMainModelUiTemplatePrompt 的 templatePayload）：
 * `[{ id, name, currentVariables, variableSchema }]` 缩进 2 序列化。
 * 纯函数；供 构建变量更新指令 与 标准注入模板（{{{变量载荷}}} 占位）共用。
 */
export function 构建模板载荷JSON(模板列表: 卡面变量模板[], 池表: Record<string, unknown>): string {
  const 载荷 = (Array.isArray(模板列表) ? 模板列表 : [])
    .filter(t => t && typeof t === 'object')
    .map(t => {
      const 池 = 池表 && typeof 池表 === 'object' ? (池表 as Record<string, unknown>)[String(t.id)] : undefined;
      return {
        id: t.id,
        name: t.name || 'UI模板',
        currentVariables: 池 ?? 模板当前变量(t),
        variableSchema: t.variableSchema || '',
      };
    });
  return JSON.stringify(载荷, null, 2);
}

/**
 * 标准注入模板（用户要的「标准提示词」= RP-Hub 原版 buildMainModelUiTemplatePrompt 那一整串格式指令）。
 * 教 AI 在正文末尾输出 <ui_template_updates> 更新块 + 13 条规则 + 模板载荷。
 * 动态槽位：
 *   - `{{{变量载荷}}}`：注入时替换为 构建模板载荷JSON 输出（当前卡模板 id/name/当前变量/schema）；
 *   - `{{user}}`：ST 宏，注入提示词时由 ST 替换为当前用户名（对齐原版「直接写当前用户名」语义）。
 * 无「你每次必须在正文最末尾输出」引导行（那是用户给的例子壳，不是标准）。
 */
export const 标准注入模板 = [
  '[UI模板变量更新]',
  '你需要在正文结束后追加一个隐藏变量更新块。这个块只给前端读取，不属于正文，不要在正文中提到它。',
  '格式必须严格如下：',
  '<ui_template_updates>',
  '{"updates":[{"id":"模板id","variables":{"变量名":"完整值"},"reason":"简短原因"}]}',
  '</ui_template_updates>',
  'updates只列出本轮确实需要更新的模板，每个模板最多输出一次；清理与当前剧情无关的模板示例也属于本轮必须完成的更新。只有剧情没有变化且当前变量中不存在待清理的示例内容时，才返回 {"updates":[]}。',
  '普通对象优先使用点路径更新，固定数组仅修改成员内容时使用索引路径，数组新增、删除或重新排序成员时必须返回完整数组。',
  '只允许更新当前变量JSON中已经存在的字段路径，以及变量说明明确允许新增的动态键或ID；除此之外不得新增对象键或顶层变量。',
  '变量内容涉及用户时，必须直接写当前用户名“{{user}}”；禁止保留用户占位符、双花括号或其他模板占位写法。',
  '模板变量如下：',
  '{{{变量载荷}}}',
  '最终限制：根对象只能包含updates；reason只能写在updates数组内对应的更新项中。每个updates项都必须包含reason。根对象关闭后立即输出结束标签，不得再追加字符。',
].join('\n');

/**
 * 构建「{{{变量}}}」占位内容 = 让 AI 输出 <ui_template_updates> 更新块的完整指令
 * （对齐 RP-Hub buildMainModelUiTemplatePrompt 核心语义 app.js:2134-2151 + built-in-content.js
 * buildMainModelUiTemplatePrompt，收敛为本扩展格式）。纯函数，用户名由调用方注入。
 * 本指令即 标准注入模板 的运行时等价物：载荷以真实用户名内联、payload 已填充。
 * @param 模板列表 当前卡 uiTemplates
 * @param 池表    当前楼层合并池（{ [templateId]: 变量池 }，作为"当前变量"）
 * @param 用户名  当前用户名（{{user}} 宏替换源；可空串）
 * @returns 指令文本（含模板 id/名称/当前变量/schema）
 */
export function 构建变量更新指令(模板列表: 卡面变量模板[], 池表: Record<string, unknown>, 用户名 = ''): string {
  return [
    '[UI模板变量更新]',
    '你需要在正文结束后追加一个隐藏变量更新块。这个块只给前端读取，不属于正文，不要在正文中提到它。',
    '格式必须严格如下：',
    '<ui_template_updates>',
    '{"updates":[{"id":"模板id","variables":{"变量名":"完整值"},"reason":"简短原因"}]}',
    '</ui_template_updates>',
    'updates只列出本轮确实需要更新的模板，每个模板最多输出一次；清理与当前剧情无关的模板示例也属于本轮必须完成的更新。只有剧情没有变化且当前变量中不存在待清理的示例内容时，才返回 {"updates":[]}。',
    '普通对象优先使用点路径更新，固定数组仅修改成员内容时使用索引路径，数组新增、删除或重新排序成员时必须返回完整数组。',
    '只允许更新当前变量JSON中已经存在的字段路径，以及变量说明明确允许新增的动态键或ID；除此之外不得新增对象键或顶层变量。',
    `变量内容涉及用户时，必须直接写当前用户名“${用户名.trim()}”；禁止保留用户占位符、双花括号或其他模板占位写法。`,
    '模板变量如下：',
    构建模板载荷JSON(模板列表, 池表),
    '最终限制：根对象只能包含updates；reason只能写在updates数组内对应的更新项中。每个updates项都必须包含reason。根对象关闭后立即输出结束标签，不得再追加字符。',
  ].join('\n');
}

/**
 * 构建最终注入文本（纯函数）。
 * 调用方应先解析 {{rpcard_update_rules}} 系列占位（替换卡面提示词）；{{char}}/{{user}}
 * 等酒馆宏由 ST 注入时 substituteParams 解析（script.js:3296）。
 * 占位替换：
 *   - `{{{变量}}}`    → 完整指令（构建变量更新指令 输出：格式 + 规则 + 载荷）——自定义模板把整条
 *     指令嵌到自己的引导语之后用；
 *   - `{{{变量载荷}}}` → 仅模板载荷 JSON（构建模板载荷JSON 输出）——标准注入模板（默认值）用它
 *     作为「模板变量如下：」行，注入结果 = 原版标准指令（无引导行、无规则重复）。
 * 规则：
 *   - 空模板 → 直接返回完整指令；
 *   - 含占位符 → 依次替换（{{{变量载荷}}} 先、{{{变量}}} 后，互不干扰）；
 *   - 其余 → 模板原样（模板即注入内容，不追加指令，避免与卡面自带格式指令冲突）。
 * @param 注入模板 用户配置的世界书注入模板（已预替换 {{rpcard_update_rules}}；空 → 仅指令）
 * @param 指令     构建变量更新指令 的输出
 * @param 载荷JSON 构建模板载荷JSON 的输出（标准注入模板的 {{{变量载荷}}} 槽）
 * @returns 注入文本
 */
export function 构建注入文本(注入模板: string, 指令: string, 载荷JSON: string): string {
  const 模板 = String(注入模板 || '').trim();
  if (!模板) return 指令;
  let 结果 = 模板;
  if (结果.includes('{{{变量载荷}}}')) {
    结果 = 结果.split('{{{变量载荷}}}').join(String(载荷JSON ?? ''));
  }
  if (结果.includes('{{{变量}}}')) {
    结果 = 结果.split('{{{变量}}}').join(指令);
  }
  return 结果;
}

/**
 * 提取标签内容：取 <标签>...</标签> 之间的内容（纯函数）。
 * 用于「AI 输出被思维链等包裹时只取变量更新部分」（设计记录 §4.2 模式二）。
 * @param 正文 原始文本
 * @param 标签 自定义标签名（空 → 原样返回）
 * @returns 第一个标签包裹的内容（trim）；无标签 / 无匹配 → 空串
 */
export function 提取标签内容(正文: string, 标签: string): string {
  const 文本 = String(正文 ?? '');
  const 标签名 = String(标签 ?? '').trim();
  if (!标签名) return 文本;
  // M3 修复：标签名需转义正则元字符（含 . * + ? [ ] ( ) { } ^ $ | \ 时不再失效/抛错）
  const 转义标签 = 标签名.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const 模式 = new RegExp(`<${转义标签}\\b[^>]*>([\\s\\S]*?)</${转义标签}>`, 'i');
  const 匹配 = 文本.match(模式);
  return 匹配 ? 匹配[1].trim() : '';
}

/* ---------- 世界书条目位置/角色映射（模式一·真实世界书条目，纯函数可测） ---------- */

/**
 * 注入位置 → ST 世界书条目 position.type（对齐 TH worldbook.ts toWorldbookEntry 映射
 * worldbook.ts:230-240 与 ST world_info_position world-info.js:855）：
 *   0↑Char / 1↓Char / 5↑EM / 6↓EM / 2↑AN / 3↓AN / 4@D / 7Outlet（设计记录 §4.2 原样）。
 * 不在 0-7 → 默认 at_depth。
 */
export function 世界书位置映射(位置: number): string {
  const 表: Record<number, string> = {
    0: 'before_character_definition',
    1: 'after_character_definition',
    5: 'before_example_messages',
    6: 'after_example_messages',
    2: 'before_author_note',
    3: 'after_author_note',
    4: 'at_depth',
    7: 'outlet',
  };
  return 表[位置] ?? 'at_depth';
}

/** 注入角色（0 system / 1 user / 2 assistant）→ ST 世界书条目 role */
export function 世界书角色映射(角色: number): 'system' | 'user' | 'assistant' {
  return ({ 0: 'system', 1: 'user', 2: 'assistant' } as const)[角色] ?? 'system';
}

/** 注入位置选项（8 枚举，设计记录 §4.2；UI「注入位置自定义」下拉用） */
export const 注入位置选项 = [
  { value: 0, label: '0 · 角色定义前（↑Char）' },
  { value: 1, label: '1 · 角色定义后（↓Char）' },
  { value: 5, label: '5 · 示例消息前（↑EM）' },
  { value: 6, label: '6 · 示例消息后（↓EM）' },
  { value: 2, label: '2 · 作者注释前（↑AN）' },
  { value: 3, label: '3 · 作者注释后（↓AN）' },
  { value: 4, label: '4 · 插入深度 @D（+role）' },
  { value: 7, label: '7 · 锚点（Outlet）' },
] as const;

/** 注入角色选项（UI「role」下拉用） */
export const 注入角色选项 = [
  { value: 0, label: '系统 System' },
  { value: 1, label: '用户 User' },
  { value: 2, label: 'AI Assistant' },
] as const;
