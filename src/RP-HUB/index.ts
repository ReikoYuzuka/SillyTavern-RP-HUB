import './style.css';
import { createScriptIdDiv, teleportStyle } from '@util/script';
import 界面 from './界面.vue';
import { 启动楼层记录服务 } from './楼层变量服务';
import { 启动变量单向同步服务, 刷新待保存 } from './变量单向同步';
import { 启动模板渲染服务 } from './模板渲染服务';
import { 启动模型解析服务 } from './模型解析服务';
import { 启动导入拦截, 停止导入拦截 } from './导入拦截';
import { 启动滚动锁定 } from './滚动锁定';
import { 记录日志 } from './运行日志';

$(() => {
  const app = createApp(界面).use(createPinia());

  const $app = createScriptIdDiv().appendTo('#extensions_settings2');
  app.mount($app[0]);

  // 把脚本内生成的样式复制到酒馆网页 <head>，使挂载到酒馆页面上的组件样式生效
  const { destroy } = teleportStyle();

  // 启动变量单向转换服务（AI 回复更新块 → 该楼层消息变量 rp_hub，正文剥离，无轮询/无写回）
  启动变量单向同步服务();
  // 启动变量楼层采集/还原服务（监听消息事件，快照/还原以酒馆助手 rp_hub 为准，localStorage 仅存变更历史）
  启动楼层记录服务();
  // 启动模板渲染服务（方案A 渲染器：楼层 rp_hub → 复刻模板引擎 → display_text ```html 围栏 → 酒馆助手 iframe）
  启动模板渲染服务();
  // 启动模型解析服务（模式一 世界书注入 + 打开卡注入确认 / 模式二 额外模型解析 OpenAI 兼容 API）
  启动模型解析服务();
  // 启动导入拦截服务（计划 §2.1：拦截卡片导入/拖入，区分 RP 卡 vs 酒馆原生卡 → 对应接口上传）
  启动导入拦截();
  // 启动滚动锁定服务（默认开启：防止脚本全量刷新导致聊天滚动跳回顶部；可在「模板 / 渲染」页关闭）
  启动滚动锁定();
  // 系统日志：面板加载完成（诊断「运行日志」可据此确认脚本版本已更新）
  记录日志('系统', 'RP助手已加载（v1.0.0 · 运行日志已启用）');

  // 关闭脚本时卸载组件并移除注入的样式
  $(window).on('pagehide', () => {
    app.unmount();
    $app.remove();
    destroy();
    // V3 修复：flush 待落盘的防抖保存（避免 600ms 内刷新更新块回显）
    刷新待保存();
    // 🔴-5 修复：卸载挂在 parent/top document 上的导入拦截捕获监听，
    // 避免 TH 热重载后旧监听残留（重复导入/上传 + 内存泄漏）。
    停止导入拦截();
  });
});
