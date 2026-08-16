/**
 * 打开 / 切换新卡（CHAT_CHANGED）时自动重新执行一次「刷新」，并在组件挂载时执行一次。
 *
 * 用途：诊断 / 变量管理 / 变量楼层 三个 Tab 在切卡后自动刷新对应数据，
 *       无需用户手动点「刷新」按钮。
 *
 * 说明：
 *  - 依赖 iframe 环境的 eventOn / tavern_events（酒馆助手注入，与楼层变量服务.ts 同一套事件机制）
 *  - 刷新函数应为幂等且可安全重复调用（各刷新函数内部自带防重复与「未选角色」降级）
 *  - 组件卸载时自动取消监听（eventOn 返回的 stop()）
 */
import { onBeforeUnmount, onMounted } from 'vue';

export function 用聊天切换自动刷新(刷新: () => void): void {
  let 停止: (() => void) | null = null;

  onMounted(() => {
    // 挂载时先刷一次（保持原有 onMounted(刷新) 的行为）
    刷新();
    // 之后每次打开/切换新卡（CHAT_CHANGED）都自动再刷一次
    try {
      const 注册 = eventOn(tavern_events.CHAT_CHANGED, () => 刷新());
      停止 = 注册?.stop ?? null;
    } catch {
      // 事件 API 不可用时静默降级：仅保留挂载时刷新
      停止 = null;
    }
  });

  onBeforeUnmount(() => {
    停止?.();
    停止 = null;
  });
}
