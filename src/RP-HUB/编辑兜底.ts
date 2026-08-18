/**
 * 编辑兜底.ts —— 编辑取消后引擎结果恢复兜底（第三部前端）。
 *
 * 背景（2026-08-18 实测）：ST 编辑取消时用 `chat[id].mes`（原始文本，含
 * Story_Background 等应隐藏标签）重建 .mes_text（updateMessageBlock）—— 该收尾
 * 动作发生在事件链之后（或与之竞态），会把第二部 coverMessage 写回的引擎结果
 * （rph_display，已隐藏）覆盖回未隐藏状态。
 *
 * 本模块（纯前端兜底，不改第二部）：
 *   - 在主窗口 eventSource 注册监听（第三部 iframe 初始化晚于主窗口扩展 → 天然排后）：
 *     MESSAGE_UPDATED（编辑取消/保存）、MESSAGE_SWIPED（消息切换）、CHAT_LOADED（重开
 *     聊天/刷新）。收到后 setTimeout 延时（保证晚于 ST 的 updateMessageBlock 收尾重建）
 *     再调 window.parent.__rphubCompat__.processAndCover（第二部桥：用引擎缓存重算 +
 *     强制覆盖 .mes_text DOM）→ 成为最后写 DOM 的一方 → 隐藏生效；随后补发
 *     character_message_rendered 让酒馆助手 JSR 重扫 iframe 化（ST 用未围栏 display_text
 *     重建时前端代码块会变回代码块，补发后恢复界面）。
 *   - 幂等/安全：仅对已处理消息（rph_done）且引擎结果存在时执行；桥/事件不可用
 *     静默跳过；不干预正常渲染（延时后重算一致则覆盖无变化）。
 *   - 延时值可调（编辑兜底延时毫秒，localStorage 键 thp_edit_recover_delay）。
 *
 * ⚠️ 事件名：ST eventSource 用**小写**事件名（MESSAGE_UPDATED = 'message_updated'）。
 * 必须从主窗口 event_types 动态读取，不能硬编码大写字符串 —— 否则监听注册到
 * 不存在的键上，ST emit 时收不到（2026-08-18 实测「注册了但不触发」根因）。
 */

/** 第二部桥全局键（window.parent.__rphubCompat__）。 */
const 桥键 = '__rphubCompat__';

/** 延时配置键（localStorage，毫秒；默认 80 —— 晚于 ST updateMessageBlock 收尾）。 */
const 延时存储键 = 'thp_edit_recover_delay';

/** 总开关键（localStorage；默认开启）。 */
const 开关存储键 = 'thp_edit_recover_enabled';

/** 默认延时（毫秒）。 */
const 默认延时 = 80;

/** 读取总开关（默认开启）。 */
export function 编辑兜底已启用(): boolean {
  try {
    return localStorage.getItem(开关存储键) !== 'false';
  } catch {
    return true;
  }
}

/** 设置总开关（持久化；开启时若未注册则重新启动）。 */
export function 设置编辑兜底(启用: boolean): void {
  try {
    localStorage.setItem(开关存储键, 启用 ? 'true' : 'false');
  } catch {
    // localStorage 不可用静默降级
  }
  if (启用) {
    已注册 = false; // 允许重新注册（此前关闭时未注册）
    启动编辑兜底();
  }
}

/** 读取延时（localStorage；非法回退默认）。 */
export function 读取延时(): number {
  try {
    const v = Number(localStorage.getItem(延时存储键));
    return Number.isFinite(v) && v >= 0 && v <= 2000 ? v : 默认延时;
  } catch {
    return 默认延时;
  }
}

/** 访问主窗口（跨 iframe；失败返回 null）。 */
function 取主窗口(): Window | null {
  try {
    return (window.parent ?? window) as Window;
  } catch {
    return null;
  }
}

/** 第二部桥（window.parent.__rphubCompat__；不可用返回 null）。 */
function 取桥(): { processAndCover?: (id: number, opts?: { force?: boolean }) => Promise<unknown> } | null {
  try {
    const w = 取主窗口();
    const api = (w as unknown as Record<string, unknown>)[桥键];
    return api && typeof api === 'object' ? (api as { processAndCover?: (id: number, opts?: { force?: boolean }) => Promise<unknown> }) : null;
  } catch {
    return null;
  }
}

/** 已注册标记（防重复注册）。 */
let 已注册 = false;

/** 防重入：同一消息的连续 MESSAGE_UPDATED（保存+取消交替）合并为一次延时覆盖。 */
const 挂起 = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * 启动编辑兜底（第三部挂载时调用）。
 * 在**主窗口** eventSource 上注册 MESSAGE_UPDATED —— 直接挂主窗口数组，排位由
 * 注册时机决定（第三部晚于主窗口扩展 → 靠后）；再加延时，确保晚于 ST 收尾重建。
 */
export function 启动编辑兜底(): void {
  if (已注册) return;
  if (!编辑兜底已启用()) return; // 总开关关闭 → 不注册（零干预）
  try {
    const w = 取主窗口();
    // ⚠️ 事件名必须从主窗口 event_types 动态读取（ST 用小写，如 'message_updated'）；
    // 硬编码大写会注册到不存在的键上，ST emit 时收不到。
    const ctx = (w as unknown as { SillyTavern?: { getContext?: () => { event_types?: Record<string, string> } } })?.SillyTavern?.getContext?.();
    const 事件表 = ctx?.event_types;
    if (!事件表) return;
    const es = (w as unknown as { eventSource?: { on?: (e: string, fn: (...args: unknown[]) => void) => void } })?.eventSource;
    if (!es || typeof es.on !== 'function') return;

    // 编辑取消/保存（MESSAGE_UPDATED）→ 该消息延时恢复
    if (事件表.MESSAGE_UPDATED) {
      es.on(事件表.MESSAGE_UPDATED, (messageId: unknown) => {
        调度覆盖(Number(messageId));
      });
    }
    // 消息切换（MESSAGE_SWIPED）→ 该消息延时恢复（ST 用未围栏 display_text 重建 → 补围栏 + iframe 化）
    if (事件表.MESSAGE_SWIPED) {
      es.on(事件表.MESSAGE_SWIPED, (messageId: unknown) => {
        调度覆盖(Number(messageId));
      });
    }
    // 重开聊天/刷新（CHAT_LOADED）→ 遍历全部已处理消息延时恢复
    if (事件表.CHAT_LOADED) {
      es.on(事件表.CHAT_LOADED, () => {
        try {
          const chat = (w as unknown as { SillyTavern?: { getContext?: () => { chat?: Array<{ extra?: Record<string, unknown> }> } } })?.SillyTavern?.getContext?.()?.chat;
          if (!Array.isArray(chat)) return;
          for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.extra?.rph_done === true) 调度覆盖(i);
          }
        } catch {
          // 遍历失败忽略
        }
      });
    }
    已注册 = true;
    console.info('[第三部] 编辑兜底已启动：message_updated / message_swiped / chatLoaded 延时恢复引擎结果 + iframe 化。');
  } catch {
    // 事件源不可用静默跳过（不影响其它功能）
  }
}

/** 调度延时覆盖（防重入：同消息合并，仅最后执行一次）。 */
function 调度覆盖(messageId: number): void {
  if (!Number.isInteger(messageId) || messageId < 0) return;
  const 已有 = 挂起.get(messageId);
  if (已有) clearTimeout(已有);
  const timer = setTimeout(() => {
    挂起.delete(messageId);
    void 执行覆盖(messageId);
  }, 读取延时());
  挂起.set(messageId, timer);
}

/** 延时后执行覆盖：调第二部桥 processAndCover 强制写回引擎结果，再补发渲染事件让 JSR iframe 化。 */
async function 执行覆盖(messageId: number): Promise<void> {
  try {
    // 主窗口 chat 里该消息是否已处理（rph_done）且引擎结果存在 —— 未处理不干预
    const w = 取主窗口();
    const ctx = (w as unknown as { SillyTavern?: { getContext?: () => { chat?: Array<{ extra?: Record<string, unknown> }>; event_types?: Record<string, string> } } })?.SillyTavern?.getContext?.();
    const msg = ctx?.chat?.[messageId];
    if (!msg || msg.extra?.rph_done !== true) return;
    const 桥 = 取桥();
    if (!桥 || typeof 桥.processAndCover !== 'function') return;
    await 桥.processAndCover(messageId, { force: true });
    // 补发渲染事件：引擎结果（含前端围栏）写回后，让酒馆助手 JSR 重扫并 iframe 化。
    // 否则界面停留在 <pre><code> 代码块（PT 冲突同源：写回后无人触发 JSR 重扫）。
    try {
      const 事件名 = ctx?.event_types?.CHARACTER_MESSAGE_RENDERED;
      const es = (w as unknown as { eventSource?: { emit?: (e: string, id: number, t: string) => void } })?.eventSource;
      if (事件名 && es && typeof es.emit === 'function') {
        es.emit(事件名, messageId, 'normal');
      }
    } catch {
      // 补发失败忽略（下次事件仍会尝试）
    }
  } catch {
    // 覆盖失败忽略（下次事件仍会尝试；不干预正常流程）
  }
}
