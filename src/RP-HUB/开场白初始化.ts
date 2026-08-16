/**
 * 开场白楼层初始化 —— 新对话从卡面 variableState 构建 rp_hub 池表（纯函数，无副作用）。
 *
 * 用途：开场白（first_mes）没有 `<ui_template_updates>` 更新块，若不在开场白楼层写入
 * 卡面初始变量，楼层 iframe 渲染开场白界面时读不到变量 → 界面空。本模块把
 * 「新对话判定 / 开场白楼层定位 / 卡面变量构建初始化池表」做成纯函数，
 * 由变量单向同步服务调用后经 updateVariablesWith(type:'message') 写入开场白楼层。
 *
 * 本模块不依赖 window / DOM / 酒馆助手接口，可在 Node 直接运行单测：
 *   node src/RP-HUB/开场白初始化.test.ts
 */

/** 单模板变量池：{ [变量路径] → 值 }（嵌套对象，对齐 RP-Hub variableState） */
export type 模板变量表 = Record<string, unknown>;

/** 模板 id → 变量池 */
export type 模板池表 = Record<string, 模板变量表>;

/** 深拷贝（普通 JSON 数据；不依赖 lodash，保证可脱离浏览器环境单测） */
export function 深拷贝(值: unknown): unknown {
  if (值 === null || typeof 值 !== 'object') return 值;
  if (Array.isArray(值)) return 值.map(item => 深拷贝(item));
  const 输出: Record<string, unknown> = {};
  for (const [键, 子] of Object.entries(值 as Record<string, unknown>)) {
    输出[键] = 深拷贝(子);
  }
  return 输出;
}

/**
 * 判定是否为「新对话」：is_system=false 的真实消息数 ≤ 1（只有开场白 / 无消息）。
 * @param chat SillyTavern.chat 数组（可为空/非法）
 */
export function 判定新对话(chat: unknown[] | undefined): boolean {
  if (!Array.isArray(chat)) return true;
  let 真实消息数 = 0;
  for (const 消息 of chat) {
    if (消息 && typeof 消息 === 'object' && !(消息 as { is_system?: boolean }).is_system) {
      真实消息数 += 1;
      if (真实消息数 > 1) return false;
    }
  }
  return true;
}

/** 找开场白楼层：第一条非 system 消息的 index（通常是 0）；无则 null */
export function 找开场白楼层(chat: unknown[] | undefined): number | null {
  if (!Array.isArray(chat)) return null;
  const i = chat.findIndex(消息 => 消息 && typeof 消息 === 'object' && !(消息 as { is_system?: boolean }).is_system);
  return i >= 0 ? i : null;
}

/**
 * 从后端 uiTemplates 构建初始化池表：`{ <templateId>: {...variableState} }`。
 * 对齐原版 inferInitialUiTemplateState 优先级链（data-services.js:1255-1268）：
 *   initialVariableState 优先 → 空/缺回退 variableState（不死斩 fate353 例外：
 *   variableState={} 而 initialVariableState 含 fate353_display:"none" —— 若用空变量
 *   渲染，display:{{fate353_display}} 为空值 → 元素可见，开局不该显示却显示了）。
 * 无变量状态的模板注入空池（模板 id 本身仍会被写入，供渲染脚本读取空状态）；
 * 无效项（缺模板 id / 非字符串 id / null）跳过。
 */
export function 构建初始化池表(模板列表: Array<{ id?: unknown; variableState?: unknown; initialVariableState?: unknown } | null | undefined>): 模板池表 {
  const 池表: 模板池表 = {};
  for (const 模板 of 模板列表) {
    if (!模板) continue;
    const id = 模板.id;
    if (!id || typeof id !== 'string') continue;
    // 原版优先级：initialVariableState → variableState（inferInitialUiTemplateState）
    const 状态 = 取初始状态(模板);
    池表[id] = 状态 ? (深拷贝(状态) as 模板变量表) : {};
  }
  return 池表;
}

/** 对齐原版 inferInitialUiTemplateState：initialVariableState 优先，否则 variableState */
function 取初始状态(模板: { variableState?: unknown; initialVariableState?: unknown }): Record<string, unknown> | null {
  const 初始 = 模板.initialVariableState;
  if (初始 && typeof 初始 === 'object' && !Array.isArray(初始)) return 初始 as Record<string, unknown>;
  const 状态 = 模板.variableState;
  if (状态 && typeof 状态 === 'object' && !Array.isArray(状态)) return 状态 as Record<string, unknown>;
  return null;
}

/**
 * 判定哪些模板需要补灌卡面初始变量（空池粘住修复，改法1/2；纯函数可单测）。
 *
 * 语义对齐原版 loadGlobalUiTemplateRuntimeForCharacter 回退链（app.js:2494-2507）的
 * 「池空/缺失 → 回退 initialVariableState」；载体保持酒馆助手楼层变量（不做覆盖已有
 * 有效池、不引入 runtimeByCharacter 持久化）。
 *
 * 判定规则（按模板 id 逐一，不看聊天条数）：
 *   - 楼层池中该模板 id 缺失 → 未初始化（需补灌）；
 *   - 楼层池中该模板 id 内层为空对象 `{}`（无任何键）→ 未初始化（空池粘住场景，
 *     原「Object.keys(已有).length > 0」只看顶层键数会把 `{templateId:{}}` 误判为已初始化）；
 *   - 楼层池中该模板 id 内层有任意键（或非空数组）→ 已初始化（保留，不覆盖）。
 *
 * @param 模板列表 卡面 uiTemplates 数组（只取 id；对应 构建初始化池表 的同源输入）
 * @param 已有池 楼层 rp_hub 池 { [templateId]: 变量池 }（读取楼层变量 的返回）
 * @returns 需要补灌的模板 id 数组（去重，顺序 = 模板列表顺序）
 */
export function 需要补灌模板ids(
  模板列表: Array<{ id?: unknown; variableState?: unknown; initialVariableState?: unknown } | null | undefined> | null | undefined,
  已有池: Record<string, unknown> | null | undefined,
): string[] {
  const 池 = 已有池 && typeof 已有池 === 'object' ? 已有池 : {};
  const ids: string[] = [];
  for (const 模板 of Array.isArray(模板列表) ? 模板列表 : []) {
    if (!模板) continue;
    const id = 模板.id;
    if (typeof id !== 'string' || !id.trim()) continue;
    const 池条目 = 池[id];
    // 内层有内容 = 非空对象（≥1 键）或非空数组（$root 形，≥1 元素）；缺失/null/空 → 需补灌
    const 有内容 = 池条目 !== null && typeof 池条目 === 'object'
      && Object.keys(池条目 as Record<string, unknown>).length > 0;
    if (!有内容) ids.push(id);
  }
  return ids;
}
