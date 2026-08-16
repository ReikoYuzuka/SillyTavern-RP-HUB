/**
 * 变量单向同步服务 —— AI 回复更新块 → 酒馆助手楼层变量（rp_hub 命名空间）。
 *
 * 纯单向链路（无轮询、无写回、无双向同步）：
 *   AI 回复正文最末尾带 <ui_template_updates> 更新块
 *     → 监听 MESSAGE_RECEIVED / MESSAGE_EDITED（eventMakeFirst，先于 rp-hub-compat 引擎处理）
 *     → 转换更新块（剥离 + 解析 JSON + 按模板 id 分组）
 *     → updateVariablesWith 写进【当前这条楼层消息】的变量 chat[i].variables[swipe_id].rp_hub
 *     → 更新块从正文剥离（消息 .mes 与当前 swipe 原文同步剥离，对用户 / 对 AI 隐藏）
 *
 * 真相源：酒馆助手消息楼层变量。楼层 iframe 渲染时 RP-Hub 模板脚本经
 * getAllVariables() / getVariables({type:'message'}) 读取 rp_hub（酒馆助手
 * variables.ts _getAllVariables 对 TH-message iframe 合并到当前楼层为止的各楼层变量）。
 *
 * 事件时序说明（与 rp-hub-compat 扩展协作）：
 *   - 本服务用 eventMakeFirst 注册 MESSAGE_RECEIVED，先于 rp-hub-compat 的 processAndCover
 *     执行 → 剥离发生在 rp-hub-compat snapshotRaw/commitMessageView 之前，其 rph_raw_mes
 *     快照即为剥离后的正文；本扩展与 rp-hub-compat 相互独立，均可单独工作。
 *   - 写入用酒馆助手 API updateVariablesWith({type:'message'})，由酒馆助手负责
 *     swipe 数组归一化与 saveChatConditionalDebounced 落盘。
 *
 * 编辑回显原始文本（E 需求，2026-08 用户提出）：
 *   ST 编辑框（#curEditTextarea，script.js:8212）默认填 chat[id].mes（已剥离更新块）
 *   → 用户看不到 AI 原始输出，无法检查/纠正（黑盒）。本服务剥离前把完整原文（含更新块）
 *   存入 extra.rph_raw_full，并挂观察器（挂编辑原文回显）：ST 创建编辑框时若该消息有
 *   rph_raw_full → 用原文替换编辑框内容。用户可检查 AI 是否按要求输出更新块、路径/值
 *   是否正确，可手动修改；保存后（MESSAGE_EDITED）处理消息 重新剥离+解析写池，
 *   用户修改的更新块直接生效（messageEditDone script.js:8346 读剥离后 mes 重建 DOM，
 *   更新块不露到显示层）。取消编辑（messageEditCancel）用剥离后 mes 重建，不受影响。
 */
import { ref } from 'vue';
import { rp_hub命名空间 } from './楼层变量';
import { 转换更新块, type 模板池表 } from './更新块转换';
import { 找开场白楼层, 构建初始化池表, 需要补灌模板ids } from './开场白初始化';
import { 记录日志 } from './运行日志';

/* ---------- 响应式状态（供「变量管理」Tab 只读展示） ---------- */
/** 最近一次成功写入楼层变量的时间 */
export const 上次写入时间 = ref<string | null>(null);
/** 最近同步错误文本（空串 = 无错误） */
export const 同步错误 = ref('');
/** 最近一次处理状态说明（供 UI 展示） */
export const 最近状态 = ref('等待 AI 回复…');
/** 开场白初始化的状态说明（供 UI 展示） */
export const 初始化状态 = ref('');

/** 读取当前聊天数组中的某条消息（脚本 iframe：SillyTavern.chat 为 live 引用） */
function 获取消息(messageId: number): SillyTavern.ChatMessage | null {
  try {
    const chat = SillyTavern.chat;
    if (!Array.isArray(chat) || messageId < 0 || messageId >= chat.length) return null;
    return chat[messageId];
  } catch {
    return null;
  }
}

/** 读取某楼层的 rp_hub 池表（消息变量 getVariables type:'message'，深拷贝，异常降级为空表） */
export function 读取楼层变量(messageId: number): 模板池表 {
  try {
    const 全表 = getVariables({ type: 'message', message_id: messageId });
    const 池表 = ((_.get(全表, rp_hub命名空间, {}) ?? {}) as 模板池表);
    return _.cloneDeep(池表);
  } catch {
    return {};
  }
}

/**
 * 把池表写进某楼层的消息变量（updateVariablesWith 读→改→写，type:'message'）。
 * 合并策略：`{ ...远程池, ...新池 }` —— 只覆盖本批更新涉及的模板池，
 * 该楼层已有 / 其余脚本写入的模板池保留（仅该楼层局部，不触碰 chat 层）。
 * @returns 是否成功
 */
export function 写楼层变量(messageId: number, 池表: 模板池表): boolean {
  try {
    updateVariablesWith(变量表 => {
      const 远程 = ((_.get(变量表, rp_hub命名空间, {}) ?? {}) as 模板池表);
      return _.set(变量表, rp_hub命名空间, { ...远程, ...池表 });
    }, { type: 'message', message_id: messageId });
    上次写入时间.value = new Date().toISOString();
    同步错误.value = '';
    return true;
  } catch (e) {
    同步错误.value = String(e instanceof Error ? e.message : e);
    return false;
  }
}

/** V2 修复：剥离全部 swipe 的更新块（各自独立剥离，防浏览任一 swipe 时回显更新块）。 */
function 剥离全部swipe(消息: SillyTavern.ChatMessage): void {
  try {
    if (!Array.isArray(消息.swipes)) return;
    for (let i = 0; i < 消息.swipes.length; i++) {
      const sw = 消息.swipes[i];
      if (typeof sw !== 'string') continue;
      const { 正文: 该正文 } = 转换更新块(sw);
      if (该正文 !== sw) 消息.swipes[i] = 该正文;
    }
  } catch {
    // 忽略（swipes 结构异常时跳过，不影响主流程）
  }
}

/**
 * C5：防抖持久化剥离后的消息正文（ST saveChat）。
 * 背景：剥离更新块直接改 chat[i].mes / swipes，若不在重载/切聊天前落盘，刷新后更新块会回显。
 * 楼层变量由 TH updateVariablesWith 负责保存，mes 的修改需本服务显式调度保存（防抖合并）。
 */
let 保存定时器: ReturnType<typeof setTimeout> | null = null;
function 调度保存(): void {
  if (保存定时器) return;
  保存定时器 = setTimeout(() => {
    保存定时器 = null;
    try {
      const ctx = (SillyTavern as unknown as { getContext?: () => any }).getContext?.();
      (ctx?.saveChat ?? (SillyTavern as any)?.saveChat)?.();
    } catch {
      // 保存失败不阻塞主流程（下次事件重新剥离时再次保存）
    }
  }, 600);
}

/** V3 修复：pagehide 时 flush 待落盘的防抖保存（否则 600ms 内刷新/切聊天更新块会回显）。 */
export function 刷新待保存(): void {
  if (!保存定时器) return;
  clearTimeout(保存定时器);
  保存定时器 = null;
  try {
    const ctx = (SillyTavern as unknown as { getContext?: () => any }).getContext?.();
    (ctx?.saveChat ?? (SillyTavern as any)?.saveChat)?.();
  } catch {
    // 忽略（pagehide 时 best-effort）
  }
}

/**
 * 处理单条消息：剥离更新块 + 写楼层变量（幂等，可安全重复调用）。
 * @param 是编辑 V1 修复：true = MESSAGE_EDITED（用户编辑保存）路径，此时「无更新块」才清除
 *   rph_raw_full 原文标记；false = MESSAGE_RECEIVED（continue/append/regenerate 重入）路径，
 *   无更新块时不删原文标记（否则续写/追加重入会误删「编辑回显 AI 原文」能力）。
 * @returns 是否写入了楼层变量
 */
export function 处理消息(messageId: number, 是编辑 = false): { handled: boolean; reason?: string } {
  // M-6 总开关：关闭后不进行任何变量操作（不剥离、不写池、不置标记）
  if (!变量同步开关已启用()) return { handled: false, reason: '变量同步总开关关闭' };
  const 消息 = 获取消息(messageId);
  if (!消息 || typeof 消息.mes !== 'string' || 消息.is_system) {
    return { handled: false, reason: '跳过（消息不存在 / 系统消息）' };
  }

  const 原文 = 消息.mes; // 剥离前完整原文（编辑回显用，E 需求）
  const { 正文, 变量表, 错误 } = 转换更新块(消息.mes);

  // 无论解析成败，更新块一律从正文剥离（对用户 / 对 AI 隐藏）
  if (正文 !== 消息.mes) {
    // 存原始完整文本（含更新块）：ST 编辑时回显原文，供用户检查 AI 是否按要求
    // 输出更新块 / 手动纠正（挂编辑原文回显 读取本键替换编辑框内容）
    try {
      消息.extra ??= {};
      消息.extra.rph_raw_full = 原文;
      console.info(`[第三部] 变量同步：消息 #${messageId} 已存 AI 原文（${原文.length} 字符，含更新块）`);
    } catch (e) {
      console.warn('[第三部] 变量同步：存 rph_raw_full 失败：', e);
      // extra 不可写时忽略（回显降级为剥离后文本，不影响主流程）
    }
    消息.mes = 正文;
    剥离全部swipe(消息); // V2：剥离全部 swipe（各自独立剥离）
    调度保存(); // C5：剥离改动落盘（防抖），避免重载/切聊天前更新块回显
  } else if (是编辑 && 消息.extra && typeof 消息.extra.rph_raw_full === 'string') {
    // V1 修复：仅编辑保存后无更新块（用户删除了更新块 / 手动清空）→ 清除原文标记，
    // 下次编辑框回显当前 mes（避免旧原文反复回写造成循环）。continue/append 重入不清除。
    try {
      delete 消息.extra.rph_raw_full;
      console.info(`[第三部] 变量同步：消息 #${messageId} 无更新块，清除 rph_raw_full`);
      调度保存();
    } catch {
      // 忽略
    }
  }

  if (!变量表) {
    if (错误) {
      同步错误.value = `#${messageId} 更新块 JSON 解析失败：${错误}`;
      最近状态.value = `#${messageId} 更新块已剥离（解析失败）`;
      记录日志('变量同步', `#${messageId} 更新块 JSON 解析失败：${错误}`, 'warn');
    }
    return { handled: false, reason: 错误 ? '更新块解析失败' : '无更新块' };
  }

  const ok = 写楼层变量(messageId, 变量表);
  if (ok) {
    // H-A：本消息带过 <ui_template_updates> 更新块且写池成功 → 置 rph_has_update 标记。
    // 模板渲染服务「RP 模板消息判别」据此判定本消息为模板消息（可接管显示）。
    // 写池与剥离的同步性：剥离（改 mes/swipe）在前，写楼层变量（TH updateVariablesWith
    // 同步 updater，同步完成）在后 —— 标记设置于写成功之后，与池落定一致。
    // 幂等：重复事件（RENDERED 重扫等）再次进入时标记已存在，无副作用。
    try {
      消息.extra ??= {};
      消息.extra.rph_has_update = true;
    } catch {
      // extra 不可写时忽略（标记缺失 → 该消息不被判为模板消息，渲染跳过，功能降级不报错）
    }
  }
  最近状态.value = ok
    ? `#${messageId} 已写入 ${Object.keys(变量表).length} 个模板池（rp_hub）`
    : `#${messageId} 楼层变量写入失败`;
  if (ok) {
    记录日志('变量同步', `#${messageId} 已写入 ${Object.keys(变量表).length} 个模板池（rp_hub）`);
  } else {
    记录日志('变量同步', `#${messageId} 楼层变量写入失败：${同步错误.value || '未知原因'}`, 'warn');
  }
  return { handled: ok, reason: ok ? undefined : `写入失败：${同步错误.value || '未知原因'}` };
}

/* ---------- 开场白初始化（新对话：从卡面 variableState 写入开场白楼层） ---------- */

/** rp-hub-compat 后端插件地址（相对路径，ST 自动补当前 origin，换端口/域名/局域网都通） */
const BASE = (() => {
  // srcdoc iframe 内相对路径 base 继承可能异常 → 用父窗口 origin 拼绝对路径（跟随部署 origin，不写死）
  try { const o = (window.parent ?? window)?.location?.origin; if (o) return o + '/api/plugins/rp-hub-compat/v1'; } catch {}
  return '/api/plugins/rp-hub-compat/v1';
})();

/** 变量同步总开关 localStorage 键（缺省开启：非 'false' 即启用；M-6 UI 总开关接线） */
const 同步存储键 = 'thp_variable_sync_enabled';

/**
 * 响应式变量同步开关（A3：UI 跨组件联动）。
 * 背景：TabVariables「变量更新总开关」此前直接读 localStorage（非响应式），
 * 关闭后「注入使能」开关不会跟着变灰（假联动）。
 * 现 UI computed 读本 ref；服务层判定仍用 变量同步开关已启用()（读 localStorage 键），
 * 两者经 设置变量同步开关 双向同步。
 */
export const 变量同步开关响应式 = ref(变量同步开关已启用());

/** 变量同步总开关是否启用（关闭后不进行任何变量操作：不剥离、不写池、不初始化、不置标记） */
export function 变量同步开关已启用(): boolean {
  try {
    return localStorage.getItem(同步存储键) !== 'false';
  } catch {
    return true;
  }
}

/** 界面/控制台可读写变量同步总开关 */
export function 设置变量同步开关(启用: boolean): void {
  try {
    localStorage.setItem(同步存储键, 启用 ? 'true' : 'false');
  } catch {
    // localStorage 不可用时静默降级
  }
  // A3：同步响应式 ref（UI 跨组件联动；服务层判定仍走 localStorage 键）
  变量同步开关响应式.value = 启用;
  记录日志('变量同步', `变量更新总开关 → ${启用 ? '开启' : '关闭'}`);
}

interface ByName {
  cardId: string;
  formatDetail: string | null;
}

interface 模板视图 {
  id?: unknown;
  variableState?: unknown;
}

interface VariablesView {
  cardId: string;
  variables: { uiTemplates?: 模板视图[] };
}

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

/** 读取当前卡名（脚本 iframe：SillyTavern 全局） */
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

/** 读取当前聊天 id（优先 getContext().chatId，兜底 getCurrentChatId / window.parent） */
function 获取聊天ID(): string | null {
  try {
    const ctx = (SillyTavern as unknown as { getContext?: () => any }).getContext?.();
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

/** 已成功初始化/确认无需补灌的聊天 id（避免同一聊天重复请求后端；CHAT_CHANGED 重置） */
let 已初始化聊天: string | null = null;

/**
 * 开场白楼层初始化（幂等，可安全在挂载与每次 CHAT_CHANGED 调用）：
 *   读后端卡面 uiTemplates → 构建 rp_hub 池表 → 用写楼层变量() 把【内层为空的模板】
 *   补灌进【开场白所在楼层】的 message 层变量 chat[i].variables[swipe_id].rp_hub。
 *
 * 空池粘住修复（对齐原版 loadGlobalUiTemplateRuntimeForCharacter 回退链语义 app.js:2494-2507，
 * 载体保持酒馆助手楼层变量）：
 *   - 改法2：不再因「聊天已有历史」跳过 —— 移除 判定新对话 守卫。初始化不看聊天条数，
 *     只按模板内层判定（改法1）；已有有效内层的模板一律保留不覆盖。
 *   - 改法1：已初始化判定从「顶层键数 > 0」改为「逐模板内层是否有内容」——
 *     空池 `{templateId:{}}`（内层无键）不再被误判为已初始化，会补灌卡面 initialVariableState。
 *   - 改法3：已初始化聊天 只在「成功写入 / 确认全部已有效 / 无可做」后置位；
 *     后端不可达 / 写入失败 / 异常 → 不置位（下次 CHAT_CHANGED 重试）。
 */
export async function 检查并初始化(): Promise<void> {
  // M-6 总开关：关闭后不进行开场白初始化
  if (!变量同步开关已启用()) {
    初始化状态.value = '变量同步总开关关闭，跳过开场白初始化';
    return;
  }
  const 聊天 = 获取聊天ID();
  if (聊天 && 聊天 === 已初始化聊天) return; // 本聊天已成功初始化/确认无需补灌
  try {
    const chat = SillyTavern.chat;
    // 改法2：不再依赖 判定新对话 —— 任何聊天长度都走到「按模板判定是否需要补灌」。
    const 楼层 = 找开场白楼层(chat);
    if (楼层 === null) {
      初始化状态.value = '无开场白楼层，跳过初始化';
      已初始化聊天 = 聊天; // 无可做 → 置位（避免重复请求）
      return;
    }
    const 卡名 = 获取当前卡名();
    if (!卡名) {
      初始化状态.value = '未选中角色，跳过开场白初始化';
      return; // 瞬态（未选中角色），不置位
    }
    const by_name = await 请求<ByName>(`${BASE}/cards/by-name/${encodeURIComponent(卡名)}`);
    if (!by_name) {
      初始化状态.value = '后端（rp-hub-compat）未匹配到该卡，跳过开场白初始化';
      return; // 后端不可达 → 不置位（下次 CHAT_CHANGED 重试）
    }
    const vars = await 请求<VariablesView>(`${BASE}/cards/${by_name.cardId}/variables?fields=uiTemplates`);
    const 模板列表 = vars?.variables?.uiTemplates ?? [];
    const 全池表 = 构建初始化池表(模板列表);
    if (Object.keys(全池表).length === 0) {
      初始化状态.value = '卡面无 uiTemplates 可初始化';
      已初始化聊天 = 聊天; // 卡无模板 → 置位（无需重试）
      return;
    }
    // 改法1：逐模板内层判定需补灌集合（内层空/缺失 = 未初始化）。只补灌内层为空的模板，
    // 已有有效内层保留不覆盖（对齐原版「runtime 有值优先、缺失才回退 initialVariableState」）。
    const 已有 = 读取楼层变量(楼层);
    const 需补灌ids = 需要补灌模板ids(模板列表, 已有);
    if (需补灌ids.length === 0) {
      初始化状态.value = `开场白楼层 #${楼层} 模板池已全部有效，保留现有（不覆盖）`;
      已初始化聊天 = 聊天; // 全部已有效 → 置位（避免重复后端请求）
      return;
    }
    // 只取需补灌模板构建子池（写楼层变量 内部 `{...远程, ...池表}` 按模板 id 覆盖，
    // 只写子集不会触碰已有有效池）
    const 补灌池表: 模板池表 = {};
    for (const id of 需补灌ids) {
      if (Object.prototype.hasOwnProperty.call(全池表, id)) 补灌池表[id] = 全池表[id];
    }
    if (Object.keys(补灌池表).length === 0) {
      初始化状态.value = '需补灌模板均无卡面初始变量，跳过';
      已初始化聊天 = 聊天; // 无内容可补 → 置位
      return;
    }
    const ok = 写楼层变量(楼层, 补灌池表);
    if (ok) {
      // 改法3：成功写入有效池 → 置位（本聊天不再重复初始化）
      已初始化聊天 = 聊天;
      // H-A：开场白初始化目标楼层 → 置 rph_initial 标记。模板渲染服务「RP 模板消息
      // 判别」据此把开场白楼层判为模板消息（开场白无 <ui_template_updates> 更新块，
      // 变量来自卡面 variableState，需此标记才渲染初始界面）。
      try {
        const 开场白消息 = chat[楼层];
        if (开场白消息 && typeof 开场白消息 === 'object') {
          开场白消息.extra ??= {};
          开场白消息.extra.rph_initial = true;
        }
      } catch {
        // extra 不可写时忽略（标记缺失 → 开场白不被判为模板消息，渲染跳过，降级）
      }
    }
    // 写入失败 → 不置位（下次 CHAT_CHANGED 重试），仅记录状态
    初始化状态.value = ok
      ? `已在开场白楼层 #${楼层} 补灌 ${Object.keys(补灌池表).length} 个模板池（rp_hub）`
      : `开场白初始化写楼层变量失败：${同步错误.value || '未知原因'}`;
    if (ok) {
      记录日志('变量同步', `开场白 #${楼层} 补灌 ${Object.keys(补灌池表).length} 个模板池（rp_hub）`);
    } else {
      记录日志('变量同步', `开场白 #${楼层} 补灌失败：${同步错误.value || '未知原因'}`, 'warn');
    }
  } catch (e) {
    // 异常 → 不置位（下次 CHAT_CHANGED 重试）
    初始化状态.value = `开场白初始化失败：${String(e instanceof Error ? e.message : e)}`;
    记录日志('变量同步', `开场白初始化异常：${String(e instanceof Error ? e.message : e)}`, 'warn');
  }
}

/* ---------- 启动 ---------- */

/** 安全注册事件：优先 eventMakeFirst（先于 rp-hub-compat 处理），降级 eventOn */
function 注册最先(事件: unknown, 处理器: (message_id: number) => void): void {
  try {
    (eventMakeFirst as (事件: unknown, 处理器: (message_id: number) => void) => { stop: () => void })(事件, 处理器);
    return;
  } catch {
    // 事件 API 不可用时尝试普通注册
  }
  try {
    (eventOn as (事件: unknown, 处理器: (message_id: number) => void) => { stop: () => void })(事件, 处理器);
  } catch {
    // 事件 API 完全不可用时静默降级：界面仍可用，转换不生效
  }
}

/* ---------- 编辑回显原始文本（E 需求：编辑时可见 AI 原始输出含更新块，可人工检查/纠正） ---------- */

/**
 * 编辑回显：ST 编辑框（#curEditTextarea，script.js:8212）默认填 chat[id].mes
 * （已剥离更新块）→ 用户看不到 AI 原始输出（黑盒）。本函数对候选文档挂观察器，
 * 当 ST 创建编辑框（编辑开始，含按钮/快捷键/上下文菜单路径）时，若该消息存在
 * extra.rph_raw_full（剥离前完整原文）→ 用原文替换编辑框内容，光标移到末尾
 * （对齐 ST messageEdit script.js:8228-8231 行为）。
 *
 * 保存后链路（无需额外处理）：
 *   .mes_edit_done → messageEditDone → updateMessage 写回 mes → emit MESSAGE_EDITED
 *   → 本服务 处理消息（eventMakeFirst 同步）重新剥离+解析写池 → 用户修改的更新块生效；
 *   messageEditDone script.js:8346 读剥离后 mes 重建 DOM → 更新块不露到显示层。
 * 取消编辑（messageEditCancel script.js:8245）用剥离后 mes 重建 DOM，不受影响。
 *
 * 诊断（2026-08 用户反馈「变量更新了但编辑看不到原文」，加详细日志定位断点）：
 *   - 挂载：输出每个候选文档（parent/top/self）的挂载结果；
 *   - 观察回调：输出编辑框存在性 / mesid / 消息 extra 键 / rph_raw_full 有无 / 替换结果。
 * 防重：observer 引用存对应窗口（脚本热重载/重复挂载先断开旧实例）。
 */
function 挂编辑原文回显(): void {
  const 候选: Array<{ 名: string; 文档: Document | null }> = [];
  try {
    候选.push({ 名: 'parent.document', 文档: (window.parent ?? null)?.document ?? null });
  } catch {
    // 跨域 / 访问异常
  }
  try {
    const 顶 = window.top?.document ?? null;
    if (顶 && 顶 !== 候选[0]?.文档) 候选.push({ 名: 'top.document', 文档: 顶 });
  } catch {
    // 跨域 / 访问异常
  }
  try {
    const 自 = document;
    if (自 !== 候选[0]?.文档 && 自 !== 候选[1]?.文档) 候选.push({ 名: 'self.document', 文档: 自 });
  } catch {
    // 忽略
  }

  for (const { 名, 文档 } of 候选) {
    if (!文档) {
      console.warn(`[第三部] 编辑回显：候选 ${名} 访问失败，跳过`);
      continue;
    }
    if (!文档.body) {
      console.warn(`[第三部] 编辑回显：候选 ${名} 无 body，跳过`);
      continue;
    }
    const 窗口 = (名 === 'parent.document' ? window.parent : 名 === 'top.document' ? window.top : window) as
      (Window & { __rphEditObserver?: MutationObserver | null }) | null;
    if (窗口?.__rphEditObserver) {
      try {
        窗口.__rphEditObserver.disconnect();
      } catch {
        // 忽略（旧实例断开失败不影响新挂载）
      }
    }
    const observer = new MutationObserver(() => {
      try {
        const textarea = 文档.getElementById('curEditTextarea') as HTMLTextAreaElement | null;
        console.info(`[第三部] 编辑回显[${名}]：观察回调触发，编辑框存在=${!!textarea}`);
        if (textarea) 尝试回显(textarea);
      } catch (e) {
        console.warn(`[第三部] 编辑回显[${名}]：观察回调异常：`, e);
      }
    });
    try {
      observer.observe(文档.body, { childList: true, subtree: true });
      if (窗口) 窗口.__rphEditObserver = observer;
      console.info(`[第三部] 编辑回显：观察器已挂 → ${名}（body#${文档.body.id || 'body'}）`);
    } catch (e) {
      console.warn(`[第三部] 编辑回显：${名} 挂观察器失败：`, e);
    }
  }

  // 兜底：.mes_edit 编辑按钮点击后延迟一次性检查（覆盖观察器未触发的边缘场景；
  // 捕获阶段先于 ST 冒泡处理器，150ms 覆盖「先 await messageEditDone 保存旧编辑」的耗时）
  try {
    const 主文档 = 候选[0]?.文档 ?? document;
    if (主文档?.body) {
      主文档.addEventListener('click', (e) => {
        const t = e.target as Element | null;
        if (!t || typeof t.closest !== 'function' || !t.closest('.mes_edit')) return;
        setTimeout(() => {
          try {
            const textarea = 主文档.getElementById('curEditTextarea') as HTMLTextAreaElement | null;
            console.info(`[第三部] 编辑回显[click兜底]：.mes_edit 点击后检查，编辑框存在=${!!textarea}`);
            if (textarea) 尝试回显(textarea);
          } catch (e2) {
            console.warn('[第三部] 编辑回显：click 兜底异常：', e2);
          }
        }, 150);
      }, true);
      console.info('[第三部] 编辑回显：click 兜底已挂（.mes_edit → 150ms 后一次性检查）');
    }
  } catch {
    // 忽略（兜底挂载失败不影响观察器主路径）
  }
}

/** 每个编辑框实例只回显一次（WeakSet 存元素引用，编辑框销毁后自动释放；防覆盖用户输入） */
const 已回显 = new WeakSet<HTMLTextAreaElement>();

/**
 * 尝试把编辑框内容替换为该消息的 AI 原始文本（每个编辑框实例只回显一次）。
 * 诊断日志分级：命中 rph_raw_full 并替换 → info；无原文 / 已回显 → info（定位断点用）。
 */
function 尝试回显(textarea: HTMLTextAreaElement): void {
  try {
    if (已回显.has(textarea)) {
      console.info('[第三部] 编辑回显：该编辑框已回显过，跳过');
      return;
    }
    const mesEl = textarea.closest('.mes');
    const id = mesEl?.getAttribute('mesid');
    if (id === null || id === undefined) {
      console.info('[第三部] 编辑回显：编辑框未找到 .mes[mesid]');
      return;
    }
    const chat = (SillyTavern as unknown as { chat?: unknown[] })?.chat;
    const 消息 = (Array.isArray(chat) ? chat[Number(id)] : undefined) as
      { extra?: { rph_raw_full?: unknown } } | undefined;
    console.info(
      `[第三部] 编辑回显：消息 #${id}，extra 键=[${消息?.extra ? Object.keys(消息.extra).join(', ') : '无'}]` +
      `，chat 长度=${Array.isArray(chat) ? chat.length : '非数组'}`,
    );
    const 原文 = 消息?.extra?.rph_raw_full;
    if (typeof 原文 !== 'string' || 原文.length === 0) {
      console.info(`[第三部] 编辑回显：消息 #${id} 无 rph_raw_full（原文未存），保持剥离后文本`);
      return;
    }
    已回显.add(textarea);
    textarea.value = 原文;
    textarea.setSelectionRange(原文.length, 原文.length);
    console.info(`[第三部] 编辑回显：消息 #${id} 已回显 AI 原始文本（${原文.length} 字符，含更新块）`);
  } catch (e) {
    console.warn('[第三部] 编辑回显：替换异常：', e);
  }
}

/**
 * 启动单向同步服务（index.ts 挂载时调用）：
 *   MESSAGE_RECEIVED（AI 回复）/ MESSAGE_EDITED（编辑保存）→ 处理消息；
 *   挂载时 + CHAT_CHANGED → 检查并初始化开场白楼层变量（新对话从卡面 variableState 写入）；
 *   挂编辑回显观察器（ST 编辑消息时显示 AI 原始文本含更新块）。
 * eventOn 在脚本 iframe 关闭时由环境自动卸载。
 */
export function 启动变量单向同步服务(): void {
  if (tavern_events?.MESSAGE_RECEIVED) {
    注册最先(tavern_events.MESSAGE_RECEIVED, message_id => void 处理消息(message_id));
  }
  if (tavern_events?.MESSAGE_EDITED) {
    // V1 修复：编辑保存路径传 是编辑=true（无更新块时才清除 rph_raw_full）
    注册最先(tavern_events.MESSAGE_EDITED, message_id => void 处理消息(message_id, true));
  }
  // E 需求：ST 编辑消息时回显 AI 原始文本（含更新块，extra.rph_raw_full）供检查/纠正
  挂编辑原文回显();
  try {
    eventOn(tavern_events.CHAT_CHANGED, () => {
      已初始化聊天 = null;
      最近状态.value = '等待 AI 回复…';
      同步错误.value = '';
      初始化状态.value = '';
      void 检查并初始化();
    });
  } catch {
    // 忽略
  }

  // 挂载时初始化当前聊天（若已打开新对话的 RP 卡，开场白楼层立即获得初始变量）
  void 检查并初始化();

  // 浏览器控制台诊断入口（调试期保留）：
  //   在脚本 iframe 控制台执行
  //   await __thp变量单向同步__.处理消息(<messageId>); __thp变量单向同步__.最近状态.value
  try {
    (window as unknown as Record<string, unknown>).__thp变量单向同步__ = {
      处理消息,
      读取楼层变量,
      写楼层变量,
      检查并初始化,
      变量同步开关已启用,
      设置变量同步开关,
      上次写入时间,
      同步错误,
      最近状态,
      初始化状态,
    };
  } catch {
    // 极少数环境不允许扩展 window，忽略
  }

  console.info('[第三部] 变量单向同步服务已启动：AI 回复更新块 → 楼层变量（message 层 rp_hub）+ 开场白初始化');
}
