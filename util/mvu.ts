import { StoreDefinition } from 'pinia';
import { effectScope } from 'vue';

/**
 * F5（方案甲）：把「message_id 为 -1/'latest'/undefined」的选项延迟到每次轮询 / watcher
 * 回调时解析为当下最新非 system 楼层号 —— 修复#11 初版在 define 期固化的语义漂移。
 * store id 仍以 -1 字面量参与计算（不嵌入具体楼层号），保持「每个使用点一个 store」的身份。
 */
function 解析动态消息楼层(option: VariableOption): VariableOption | null {
  if (option.type !== 'message') return option;
  const raw = option.message_id;
  if (raw !== undefined && raw !== 'latest' && raw !== -1) {
    return option; // 已是具体楼层号，原样使用
  }
  try {
    const chat = SillyTavern.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null; // 空聊天：本轮回调跳过
    let 最新 = -1;
    chat.forEach((m, i) => {
      if (m && !(m as { is_system?: boolean }).is_system) 最新 = i;
    });
    if (最新 < 0) return null;
    return { ...option, message_id: 最新 };
  } catch {
    return null;
  }
}

/**
 * MVU 数据 Store 工厂（《修复方案验证报告》§五 · 方案甲）：
 * - effectScope 包裹轮询与 watchIgnorable，CHAT_CHANGED 时 scope.stop() + store.$dispose()
 *   → 下次 useDataStore() 由 Pinia 重跑 setup 全新重建（旧实现 stop 后永久失能的修复）；
 * - dispose 后微任务预热一次新实例，规避组件下次取 store 时的复活初值窗口；
 * - 不再监听 pagehide stop（泄漏治理的目标场景是切卡，不是切标签页；隐藏后返回由
 *   CHAT_CHANGED/重建路径自然恢复，避免「切走再回来功能死了」）；
 * - ⚠️ additional_setup 幂等要求：scope 重建会整体重跑 setup → additional_setup 必须可安全
 *   重复执行（只做纯 ref 加工/局部 watch，禁止累积注册全局监听或一次性副作用）。
 */
export function defineMvuDataStore<T extends z.ZodObject>(
  schema: T,
  variable_option: VariableOption,
  additional_setup?: (data: Ref<z.infer<T>>) => void,
): StoreDefinition<`mvu_data.${string}`, { data: Ref<z.infer<T>> }> {
  // 不改写入参对象（避免调用方共享对象被意外带上 message_id:-1）
  const 规范化选项: VariableOption = (() => {
    try {
      const 克隆 = _.cloneDeep(variable_option);
      if (克隆.type === 'message' && (克隆.message_id === undefined || 克隆.message_id === 'latest')) {
        克隆.message_id = -1;
      }
      return 克隆;
    } catch {
      return variable_option;
    }
  })();

  const storeId = `mvu_data.${_(规范化选项)
    .entries()
    .sortBy(entry => entry[0])
    .map(entry => entry[1])
    .join('.')}`;

  /** 最近一次 setup 创建的内层 scope（dispose 时双保险显式停止；Pinia $dispose 亦会级联停止子 scope） */
  let 最新scope: ReturnType<typeof effectScope> | null = null;

  const useStoreBase = defineStore(storeId, errorCatched(() => {
    const scope = effectScope();
    最新scope = scope;

    const state = scope.run(() => {
      const data = ref(
        schema.parse(_.get(getVariables(规范化选项), 'stat_data', {}), { reportInput: true }),
      ) as Ref<z.infer<T>>;
      if (additional_setup) {
        // 幂等约定见函数注释：每次 scope 重建都会重新执行
        additional_setup(data);
      }

      useIntervalFn(() => {
        const 动态选项 = 解析动态消息楼层(规范化选项);
        if (!动态选项) return; // 空聊天等场景本轮跳过（不再对 -1 盲读）
        const stat_data = _.get(getVariables(动态选项), 'stat_data', {});
        const result = schema.safeParse(stat_data);
        if (result.error) {
          return;
        }
        if (!_.isEqual(data.value, result.data)) {
          ignoreUpdates(() => {
            data.value = result.data;
          });
          if (!_.isEqual(stat_data, result.data)) {
            updateVariablesWith(variables => _.set(variables, 'stat_data', result.data), 动态选项);
          }
        }
      }, 2000);

      const { ignoreUpdates } = watchIgnorable(
        data,
        new_data => {
          const 动态选项 = 解析动态消息楼层(规范化选项);
          if (!动态选项) return;
          const result = schema.safeParse(new_data);
          if (result.error) {
            return;
          }
          if (!_.isEqual(new_data, result.data)) {
            ignoreUpdates(() => {
              data.value = result.data;
            });
          }
          updateVariablesWith(variables => _.set(variables, 'stat_data', result.data), 动态选项);
        },
        { deep: true },
      );

      return { data };
    })!;

    return state;
  }));

  /** 当前活跃实例；CHAT_CHANGED 时 dispose 并清空，下次调用包装函数即全新重建。 */
  let 活跃实例: ReturnType<typeof useStoreBase> | null = null;

  const useStore = ((...args: Parameters<typeof useStoreBase>) => {
    活跃实例 = useStoreBase(...args);
    return 活跃实例;
  }) as typeof useStoreBase;

  // 切卡 / 切聊天：停掉旧副作用并注销实例 → 下次 useDataStore() 自动全新重建（方案甲核心）
  try {
    if (typeof tavern_events !== 'undefined' && tavern_events.CHAT_CHANGED) {
      eventOn(tavern_events.CHAT_CHANGED, () => {
        try {
          最新scope?.stop();
        } catch {
          // 忽略
        }
        try {
          活跃实例?.$dispose();
        } catch {
          // 忽略
        }
        活跃实例 = null;
        // 预热：微任务里立刻重建一个新实例，让后续 useDataStore() 拿到已完成 setup 的热 store，
        // 而非处于半初始化状态（schema.parse 尚未完成的初值窗口）
        void Promise.resolve().then(() => {
          try {
            活跃实例 = useStoreBase();
          } catch {
            // 极端环境（pinia 未就绪等）忽略；下次组件内 useStore() 自然重建
          }
        });
      });
    }
  } catch {
    // 事件 API 不可用（node 测试环境等）忽略：退化为无自动重建
  }

  return useStore as unknown as StoreDefinition<`mvu_data.${string}`, { data: Ref<z.infer<T>> }>;
}
