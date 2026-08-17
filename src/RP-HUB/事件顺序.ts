/**
 * 事件顺序.ts —— 主窗口 character_message_rendered 监听者顺序管理（第三部前端）。
 *
 * 背景（ST-Prompt-Template 渲染冲突，2026-08-17 报告）：
 *   ST-Prompt-Template 在主窗口 character_message_rendered 事件上注册最早
 *   （源码特征 render_enabled / code_blocks_enabled），每轮事件先 d.html(m)
 *   整体重写 .mes_text → 排在它之后的酒馆助手（JSR）找不到可 iframe 化的前端
 *   pre → 消息显示为代码块而非渲染界面。
 *
 * 本模块（方案 1：只移动本插件自己的监听者）：
 *   - getEventListenerTable()：用户手动点「获取当前顺序」时读取主窗口
 *     eventSource.events[EVENT] 数组，标注来源（本插件/提示词模板/酒馆助手/
 *     translate/其他-源码片段），供面板展示。
 *   - applyEventListenerOrder(anchorId)：把本插件监听者 splice 到锚点来源之后。
 *     锚点按来源特征重新定位（数组刷新后顺序可能变化，数字序号不可靠）。
 *   - 设置存 localStorage（键 thp_event_order_anchor，值 = 来源标识，空 = 不重排）。
 *
 * 设计约束：
 *   - 第三部跑在酒馆助手 iframe 里，主窗口事件数组经 window.parent.eventSource 访问；
 *     跨源访问失败（about:srcdoc 一般同源）→ 返回不可用。
 *   - 只移动本插件监听者；不改其它扩展函数（不包 wrapper、不改行为）。
 *   - 设置缺省空 = 不重排（现状），完全手动开启，零自动干预副作用。
 */

/** 目标事件名（主窗口）。 */
export const 顺序事件名 = 'character_message_rendered';

/** 设置存储键（localStorage，与第三部其它设置同风格）。 */
export const 事件顺序存储键 = 'thp_event_order_anchor';

/** 可选的锚点来源（用户可选的「排到谁之后」）。 */
export const 事件锚点选项 = [
  { id: '', name: '不重排（默认）' },
  { id: 'prompt-template', name: '提示词模板之后' },
  { id: 'tavern-helper', name: '酒馆助手之后' },
] as const;

/** 访问主窗口 eventSource（跨 iframe；失败返回 null）。 */
function 取主窗口事件源(): { events?: Record<string, unknown[]> } | null {
  try {
    const w = (window.parent ?? window) as unknown as { eventSource?: { events?: Record<string, unknown[]> } };
    if (w?.eventSource?.events) return w.eventSource;
  } catch {
    // 跨源访问异常
  }
  return null;
}

/** 本插件监听者识别：函数源码含 onCharacterRendered / rp-hub-compat / coverMessage 特征。 */
export function 是本插件监听者(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  try {
    const s = String(fn);
    return s.includes('onCharacterRendered') || s.includes('rp-hub-compat') || s.includes('coverMessage');
  } catch {
    return false;
  }
}

/** 来源特征表：源码片段 → 来源标识（尽力识别，压缩代码特征可能随版本变化）。 */
const 来源特征表: Array<{ id: string; name: string; re: RegExp }> = [
  { id: 'prompt-template', name: '提示词模板(ST-Prompt-Template)', re: /render_enabled|code_blocks_enabled|\[HTML\] rendering|Prompt Template/ },
  { id: 'tavern-helper', name: '酒馆助手(iframe)', re: /settings\.render\.enabled|auditRuntimes|render\$mes|iframe_runtimes|TH-render/ },
  { id: 'translate', name: 'translate(翻译)', re: /translateFunction|shouldTranslateFunction/ },
  { id: 'memory', name: 'memory(摘要)', re: /summary_sources\.extras|onChatEvent/ },
];

/** 识别监听者来源：本插件优先；其次特征表；未知返回 null。 */
export function 识别监听者来源(fn: unknown): { id: string; name: string } | null {
  if (是本插件监听者(fn)) return { id: 'ours', name: '本插件(RegexPlus)' };
  try {
    const s = String(fn);
    for (const m of 来源特征表) {
      if (m.re.test(s)) return { id: m.id, name: m.name };
    }
  } catch {
    // 忽略
  }
  return null;
}

/** 当前监听者数组（主窗口；不可用返回 null）。 */
function 取监听者数组(): unknown[] | null {
  try {
    const es = 取主窗口事件源();
    const list = es?.events?.[顺序事件名];
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** 本插件监听者在数组中的当前下标（未找到返回 -1）。 */
function 找本插件下标(list: unknown[]): number {
  if (!Array.isArray(list)) return -1;
  for (let i = 0; i < list.length; i++) {
    if (是本插件监听者(list[i])) return i;
  }
  return -1;
}

/** 按来源标识找第一个匹配下标（未找到返回 -1）。 */
function 找来源下标(list: unknown[], sourceId: string): number {
  if (!Array.isArray(list) || !sourceId) return -1;
  for (let i = 0; i < list.length; i++) {
    if (识别监听者来源(list[i])?.id === sourceId) return i;
  }
  return -1;
}

export interface 监听者条目 {
  index: number;
  id: string | null;
  name: string;
  preview: string;
}

export interface 监听者表 {
  list: 监听者条目[];
  oursIndex: number;
  available: boolean;
}

/** 构建监听者展示表（供面板「获取当前顺序」显示）。 */
export function 获取监听者表(): 监听者表 {
  const arr = 取监听者数组();
  if (!arr) return { list: [], oursIndex: -1, available: false };
  const list: 监听者条目[] = arr.map((fn, index) => {
    const src = 识别监听者来源(fn);
    let preview = '';
    try {
      preview = String(fn).replace(/\s+/g, ' ').slice(0, 60);
    } catch {
      // 忽略
    }
    return {
      index,
      id: src?.id ?? null,
      name: src?.name ?? '其他(匿名)',
      preview,
    };
  });
  return { list, oursIndex: 找本插件下标(arr), available: true };
}

/** 读取锚点设置（localStorage；空 = 不重排）。 */
export function 读取事件顺序锚点(): string {
  try {
    const v = localStorage.getItem(事件顺序存储键);
    return v === 'prompt-template' || v === 'tavern-helper' ? v : '';
  } catch {
    return '';
  }
}

/** 保存锚点设置（localStorage；空 = 不重排）。 */
export function 保存事件顺序锚点(锚点: string): void {
  try {
    if (锚点 === 'prompt-template' || 锚点 === 'tavern-helper') {
      localStorage.setItem(事件顺序存储键, 锚点);
    } else {
      localStorage.removeItem(事件顺序存储键);
    }
  } catch {
    // localStorage 不可用静默降级
  }
}

/** 应用事件顺序：把本插件监听者重排到锚点来源之后。 */
export function 应用事件顺序(锚点: string): { applied: boolean; reason: string; oursIndex: number } {
  const arr = 取监听者数组();
  if (!arr) return { applied: false, reason: '主窗口事件监听者数组不可用（跨 iframe 访问失败？）', oursIndex: -1 };
  const oursIndex = 找本插件下标(arr);
  if (oursIndex === -1) return { applied: false, reason: '未找到本插件监听者（RegexPlus 未加载？）', oursIndex: -1 };
  if (!锚点) return { applied: false, reason: '锚点为空（不重排）', oursIndex };

  const anchorIndex = 找来源下标(arr, 锚点);
  if (anchorIndex === -1) return { applied: false, reason: `未找到锚点来源「${锚点}」`, oursIndex };

  const targetIndex = Math.min(arr.length, anchorIndex + 1);
  if (oursIndex === targetIndex) {
    return { applied: true, reason: '已在目标位置', oursIndex };
  }

  const [fn] = arr.splice(oursIndex, 1);
  const insertAt = oursIndex < targetIndex ? targetIndex - 1 : targetIndex;
  arr.splice(Math.max(0, Math.min(insertAt, arr.length)), 0, fn);
  const newOurs = 找本插件下标(arr);
  return { applied: true, reason: `已移动到锚点「${锚点}」之后（第 ${newOurs} 位）`, oursIndex: newOurs };
}
