/**
 * 运行日志 —— 第三部各服务的操作记录收集器（UI 侧「诊断 → 运行日志」展示）。
 *
 * 纯内存（不持久化，刷新即清空）；各服务在关键动作处调用 记录日志：
 *   - 变量同步（剥离更新块 / 写楼层变量 / 开场白初始化 / 总开关切换）
 *   - 模板渲染（渲染单条 / 全量收敛 / 强制重渲染 / 渲染总开关切换 / 存量清理）
 *   - 模型解析（世界书注入 / 额外模型解析 / 打开卡注入确认 / 模式切换）
 *   - 楼层记录（楼层变量采集 / 删除 / 清空）
 *   - 导入拦截（RP 卡 vs 原生卡分流）
 *   - 系统（加载 / 错误）
 *
 * 高频日志策略：只记录「有意义的动作」（写入 / 注入 / 解析 / 初始化 / 开关 / 错误），
 * 不记录每轮 RENDERED 的「已渲染且未变」等静默跳过，避免刷屏；内存上限 200 条，
 * 超出丢最旧。
 *
 * ⚠️ 依赖说明：本模块 import vue（ref）——只能被「浏览器/服务模块」（变量单向同步 /
 * 模板渲染服务 / 模型解析服务 / 楼层变量服务 / index / TabDiagnose）引用；
 * 纯函数可测模块（导入拦截 等，node --test 直接跑 .ts、无扩展名相对 import 不解析）
 * 不得 import 本模块（会拉断 node 测试链路）。
 */
import { ref } from 'vue';

/** 日志级别 */
export type 日志级别 = 'info' | 'warn' | 'error';

/** 一条运行日志 */
export interface 运行日志条目 {
  /** 自增 id（Vue key 用） */
  id: number;
  /** HH:mm:ss */
  时间: string;
  /** 来源（变量同步 / 模板渲染 / 模型解析 / 楼层记录 / 导入拦截 / 系统） */
  来源: string;
  /** 内容 */
  内容: string;
  /** 级别（info / warn / error） */
  级别: 日志级别;
}

/** 内存上限（条） */
const 上限 = 200;

let 序号 = 0;

/** 日志列表（最新在后；UI 倒序展示或顺序展示均可） */
export const 运行日志列表 = ref<运行日志条目[]>([]);

/** 记录一条日志（自动截断到内存上限） */
export function 记录日志(来源: string, 内容: string, 级别: 日志级别 = 'info'): void {
  const 条目: 运行日志条目 = {
    id: ++序号,
    时间: 格式化时间(new Date()),
    来源,
    内容,
    级别,
  };
  const 列表 = 运行日志列表.value;
  列表.push(条目);
  if (列表.length > 上限) 列表.splice(0, 列表.length - 上限);
}

/** 清空日志（UI「清空日志」按钮） */
export function 清空运行日志(): void {
  运行日志列表.value = [];
}

/** HH:mm:ss */
function 格式化时间(d: Date): string {
  const 补零 = (n: number) => String(n).padStart(2, '0');
  return `${补零(d.getHours())}:${补零(d.getMinutes())}:${补零(d.getSeconds())}`;
}
