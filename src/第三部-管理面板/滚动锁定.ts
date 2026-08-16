/**
 * 滚动锁定服务 —— 防止玄狐等脚本全量刷新（forceRefreshAll → 酒馆助手 refreshOneMessage
 * → .mes_text.empty() 删除状态面板 iframe）导致聊天滚动跳回顶部。
 *
 * 机制（纯事件驱动，无轮询）：
 *   - 监听 #chat 的 scroll：稳定 150ms 后提交「已保存位置」（连续滚动/重渲染跳位不覆盖）；
 *   - 渲染窗口：渲染事件（RENDERED/SWIPED/UPDATED/EDITED/chatLoaded）发生时进入窗口，
 *     期间跳位不提交；恢复延迟后仅当「当前 < 已保存 - 阈值」（向上跳位，即 clamp 到顶）
 *     才恢复 —— 向下（新消息滚到底）不干预，避免破坏「新消息自动滚到底」。
 * 滚动容器：#chat（ST 1.18 的聊天滚动容器，body overflow hidden、window 不滚动）。
 * 开关：localStorage thp_scroll_lock_enabled（缺省开启：非 'false' 即启用）。
 */
import { ref } from 'vue';
import { 记录日志 } from './运行日志';

const 存储键 = 'thp_scroll_lock_enabled';
const 稳定毫秒 = 150;    // scroll 稳定多久才提交位置
const 恢复延迟毫秒 = 400; // 渲染事件后多久恢复（等 iframe 重建、高度涨回）
const 跳位阈值 = 100;    // 向上跳位超过该像素才恢复（避免小位移误恢复）

export const 滚动锁定响应式 = ref(滚动锁定已启用());

export function 滚动锁定已启用(): boolean {
  try { return localStorage.getItem(存储键) !== 'false'; } catch { return true; }
}

export function 设置滚动锁定开关(启用: boolean): void {
  try { localStorage.setItem(存储键, 启用 ? 'true' : 'false'); } catch { /* localStorage 不可用时降级 */ }
  滚动锁定响应式.value = 启用;
  记录日志('滚动锁定', `滚动锁定 → ${启用 ? '开启' : '关闭'}`);
  if (启用) 启动滚动锁定(); else 停止滚动锁定();
}

/* ---------- 内部状态 ---------- */

let 已保存位置 = 0;
let 待提交位置 = 0;
let 提交定时器: ReturnType<typeof setTimeout> | null = null;
let 恢复定时器: ReturnType<typeof setTimeout> | null = null;
let 渲染窗口 = false;
let 已挂载 = false;
/** S1：渲染窗口内用户是否主动滚动过（wheel/touchmove/keydown），用于放弃「跳位恢复」以免抢滚动 */
let 用户滚动过 = false;
const 已注册事件: Array<{ stop: () => void }> = [];

/** ST 主窗口（脚本跑在 about:srcdoc iframe，聊天在父窗口）。 */
function 父窗口(): Window | null {
  try { return window.parent && window.parent !== window ? window.parent : window; } catch { return window; }
}

/** 聊天滚动容器 #chat（ST 1.18 滚动容器；不存在则退回 document.scrollingElement）。 */
function 聊天容器(): HTMLElement | null {
  try {
    const w = 父窗口();
    return w?.document?.getElementById?.('chat') ?? w?.document?.scrollingElement ?? null;
  } catch { return null; }
}

function 当前滚动位置(): number {
  return 聊天容器()?.scrollTop ?? 0;
}

function 恢复滚动位置(y: number): void {
  try {
    const el = 聊天容器();
    if (el) el.scrollTop = y;
  } catch { /* 跨源/异常忽略 */ }
}

/** S1：记录用户主动滚动输入（wheel/touchmove/keydown 只由用户触发，程序性 scrollTop 不触发）。 */
function 记录用户滚动(): void {
  用户滚动过 = true;
}

function onScroll(): void {
  if (!已挂载) return;
  待提交位置 = 当前滚动位置();
  if (提交定时器) clearTimeout(提交定时器);
  提交定时器 = setTimeout(() => {
    提交定时器 = null;
    // 渲染窗口内不提交（重渲染触发的跳位/clamp 不落地为「已保存位置」）
    if (!渲染窗口) 已保存位置 = 待提交位置;
  }, 稳定毫秒);
}

function onRender(): void {
  if (!已挂载) return;
  渲染窗口 = true;
  用户滚动过 = false; // S1：新渲染窗口开始时重置用户滚动标记
  if (提交定时器) { clearTimeout(提交定时器); 提交定时器 = null; }
  if (恢复定时器) clearTimeout(恢复定时器);
  恢复定时器 = setTimeout(() => {
    恢复定时器 = null;
    const 当前 = 当前滚动位置();
    // S1 修复：窗口内用户主动滚动过 → 尊重用户位置（提交而非恢复），避免上滚被抢
    if (用户滚动过) {
      已保存位置 = 当前;
      渲染窗口 = false;
      return;
    }
    // 仅向上跳位（clamp 到顶）才恢复；否则（新消息滚到底）提交新位置
    if (当前 < 已保存位置 - 跳位阈值) 恢复滚动位置(已保存位置);
    else 已保存位置 = 当前;
    渲染窗口 = false;
  }, 恢复延迟毫秒);
}

/** 渲染事件列表（对齐模板渲染服务的触发面 + chatLoaded）。 */
function 渲染事件列表(): string[] {
  const 列表: string[] = [];
  if (tavern_events?.CHARACTER_MESSAGE_RENDERED) 列表.push(tavern_events.CHARACTER_MESSAGE_RENDERED);
  if (tavern_events?.USER_MESSAGE_RENDERED) 列表.push(tavern_events.USER_MESSAGE_RENDERED);
  if (tavern_events?.MESSAGE_SWIPED) 列表.push(tavern_events.MESSAGE_SWIPED);
  if (tavern_events?.MESSAGE_UPDATED) 列表.push(tavern_events.MESSAGE_UPDATED);
  if (tavern_events?.MESSAGE_EDITED) 列表.push(tavern_events.MESSAGE_EDITED);
  // S4：删消息 / 加载更早历史也会重建 DOM 并跳位，纳入渲染窗口
  if (tavern_events?.MESSAGE_DELETED) 列表.push(tavern_events.MESSAGE_DELETED);
  if (tavern_events?.MORE_MESSAGES_LOADED) 列表.push(tavern_events.MORE_MESSAGES_LOADED);
  列表.push('chatLoaded');
  return 列表;
}

export function 启动滚动锁定(): void {
  if (已挂载) return;
  if (!滚动锁定已启用()) return;
  已挂载 = true;
  已保存位置 = 当前滚动位置();
  用户滚动过 = false;
  const 容器 = 聊天容器();
  try { 容器?.addEventListener?.('scroll', onScroll, { passive: true }); } catch { /* 忽略 */ }
  // S1：记录用户主动滚动输入（wheel/touchmove/keydown），区分「渲染跳位」与「用户上滚」
  try { 容器?.addEventListener?.('wheel', 记录用户滚动, { passive: true }); } catch { /* 忽略 */ }
  try { 容器?.addEventListener?.('touchmove', 记录用户滚动, { passive: true }); } catch { /* 忽略 */ }
  try { 容器?.addEventListener?.('keydown', 记录用户滚动, { passive: true }); } catch { /* 忽略 */ }
  for (const 事件 of 渲染事件列表()) {
    try {
      const 注册 = eventOn as unknown as (事件: unknown, 处理器: () => void) => { stop: () => void };
      已注册事件.push(注册(事件, onRender));
    } catch { /* 忽略 */ }
  }
  // S2：切聊天重置已保存位置，避免新聊天被恢复到旧聊天 scrollTop
  if (tavern_events?.CHAT_CHANGED) {
    try {
      const 注册聊天变更 = eventOn as unknown as (事件: unknown, 处理器: () => void) => { stop: () => void };
      已注册事件.push(注册聊天变更(tavern_events.CHAT_CHANGED, () => {
        已保存位置 = 0;
        if (提交定时器) { clearTimeout(提交定时器); 提交定时器 = null; }
        if (恢复定时器) { clearTimeout(恢复定时器); 恢复定时器 = null; }
        渲染窗口 = false;
      }));
    } catch { /* 忽略 */ }
  }
}

export function 停止滚动锁定(): void {
  if (!已挂载) return;
  已挂载 = false;
  if (提交定时器) { clearTimeout(提交定时器); 提交定时器 = null; }
  if (恢复定时器) { clearTimeout(恢复定时器); 恢复定时器 = null; }
  const 容器 = 聊天容器();
  try { 容器?.removeEventListener?.('scroll', onScroll); } catch { /* 忽略 */ }
  try { 容器?.removeEventListener?.('wheel', 记录用户滚动); } catch { /* 忽略 */ }
  try { 容器?.removeEventListener?.('touchmove', 记录用户滚动); } catch { /* 忽略 */ }
  try { 容器?.removeEventListener?.('keydown', 记录用户滚动); } catch { /* 忽略 */ }
  for (const r of 已注册事件) { try { r.stop(); } catch { /* 忽略 */ } }
  已注册事件.length = 0;
}
