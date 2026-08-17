/**
 * 模板渲染服务 —— 方案A 渲染器（浏览器 iframe 环境）。
 *
 * 数据流（变量渲染-验证与决策.md §2）：
 *   触发事件（CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_SWIPED /
 *   MESSAGE_UPDATED / MESSAGE_EDITED / 'chatLoaded'，eventMakeFirst 先于 rp-hub-compat
 *   与酒馆助手 iframe store 执行）
 *     → 读「开场白→当前楼」各楼层 rp_hub 池的合并池（合并楼层池，对齐原版
 *        「状态跨楼层携带、每层渲染全部 active 模板」，见 合并楼层池-影响检测.md）
 *     → 模板定义懒取 + 按卡名缓存（后端 uiTemplates 数组）
 *     → 渲染全部模板（enabled && 池有条目，top/bottom 分区 + order 降序，复刻引擎
 *       含 @别名.field 补丁 / {{user}} 宏，剥离代码围栏，确保 html> 标记，包 ```html 围栏）
 *     → 写 msg.extra.display_text（正文 + 围栏）+ rph_template_render / rph_template_hash /
 *       rph_template_display 标记 → 触发 ST 重渲染该楼（updateMessageBlock）
 *     → 给 .mes_text 补 rph-rendered class（rp-hub-compat 修复4 语义，pure.js:193-217）
 *
 * 显示通道双写冲突（本服务采用方案，变量渲染-验证与决策.md §2.5）：
 *   - rp-hub-compat coverMessage 修复3（display.js:96）：.mes_text 内已有 div.TH-render
 *     （酒馆助手已 iframe 化）→ 整体跳过；修复4（pure.js:193-217）：DOM 带 rph-rendered
 *     标记且引擎重算一致 → 跳过覆盖。本服务 eventMakeFirst 先写 DOM（含 rph-rendered），
 *     同事件酒馆助手随后 iframe 化 → rp-hub-compat 天然跳过，模板界面存活。
 *   - 数据层残留：rp-hub-compat commitMessageView/commitDisplay 会把 display_text 覆写为
 *     引擎输出（swipe 重处理 / 样式切换等）→ 本服务以「display_text !== rph_template_display
 *     或池哈希变化」判定需重渲染，在后续事件上收敛恢复模板界面。
 *
 * 性能（§2.7）：per 消息缓存（rph_template_hash + rph_template_display），合并楼层池未变且
 *   display_text 未被外部覆写 → 跳过；合并池按楼层顺序滚动缓存（merged[k] = 合并 merged[k-1] +
 *   第 k 层池，chatLoaded 全量 O(n)）；模板定义按卡名缓存（30 分钟 TTL，CHAT_CHANGED 失效）；
 *   chatLoaded 全量逐条处理每 20 条 setTimeout(0) 让出一帧；display_text 持久化防抖。
 *
 * 总开关：localStorage thp_template_render_enabled（缺省开启）。
 */
import { ref } from 'vue';
import { 读取楼层变量 } from './变量单向同步';
import { 深合并池, 回退卡面初始状态, 渲染全部模板, 判断显示键状态, 是模板消息, 脚本内含脏span, 清理脚本脏span, type 模板定义, type 模板池表 } from './模板渲染';
import { 记录日志 } from './运行日志';
import { 读取事件顺序锚点, 应用事件顺序 } from './事件顺序';

/** rp-hub-compat 后端插件地址（相对路径，ST 自动补当前 origin，换端口/域名/局域网都通） */
const BASE = (() => {
  // srcdoc iframe 内相对路径 base 继承可能异常 → 用父窗口 origin 拼绝对路径（跟随部署 origin，不写死）
  try { const o = (window.parent ?? window)?.location?.origin; if (o) return o + '/api/plugins/rp-hub-compat/v1'; } catch {}
  return '/api/plugins/rp-hub-compat/v1';
})();

/** 渲染总开关 localStorage 键（缺省开启：非 'false' 即启用） */
const 存储键 = 'thp_template_render_enabled';

/** rp-hub-compat 引擎渲染结果写入 .mes_text 的标记 class（对齐其 pure.js RENDER_MARK_CLASS） */
const 引擎标记 = 'rph-rendered';

/** 模板定义缓存 TTL（毫秒，对齐 rp-hub-compat rp-mode 的 30 分钟） */
const 缓存TTL毫秒 = 30 * 60 * 1000;

/** 事件处理器在同一消息上的防重入集合（触发重扫描时防递归） */
const 重扫描中 = new Set<number>();

/**
 * 每消息「有 TH-render 但无 iframe（折叠壳）」时触发重扫描的次数上限。
 * 防循环兜底：TH 补挂 iframe 是异步的，正常 1-2 轮即可收敛（iface 挂上后重新断言
 * 走「有 iframe → 零动作」停止）。若 TH 因自身原因永久补挂失败，每轮 RENDERED 都会
 * 触发重扫 → 达上限后停止触发（降级为折叠代码块，可点按钮查看，不比现状差）。
 */
const 重扫次数上限 = 3;
/** 每消息已触发重扫描的累计次数（成功挂载 iframe / 重新渲染时重置） */
const 重扫计数 = new Map<number, number>();

/**
 * 渲染输出版本（写入 extra.rph_template_version）。变更检测的关键补充：
 * 哈希只覆盖「输入池」，而渲染输出（dvh→vh 兼容、display 兜底、围栏化等）演进时
 * 输入池不变 → 哈希一致 → 旧 display_text 被跳过保留。输出版本使旧输出失效：
 * 无该字段或版本 < 当前 → 不满足跳过条件 → 强制重渲染写新 display_text。
 * v1 = 初版（无 dvh 兼容、无 display:none 兜底）；v2 = dvh→vh + _display 空值兜底；
 * v3 = 围栏化正文完整对齐第二部 fenceFullHtml（HTML 容器 div + 内部完整文档代码块
 *      形态：方案 c 短路精确化补空行 + 完整文档提取 + div 配平 + style/script/iframe 骨架）；
 * v4 = 用户消息不渲染模板（渲染单条 is_user 过滤，对齐原版 assistant-only）+ 围栏化
 *      注入 vh min-height reset 样式（模板不占满整屏）+ 注入 triggerSlash 桥与
 *      data-slash 点击委托（狐策等卡正则产物 iframe 内按钮可点，对齐原版 scriptShim）。
 * v5 = triggerSlash 语义分发（渲染部分共存审查 H1/M2 修复）：桥脚本升级为
 *      「/ 开头 → ST 执行器；纯文本 → 发消息+生成（RP-Hub app.js:8423 语义）」——
 *      FATE-353 类纯文本 data-slash 按钮可点；并在 ST 主窗口挂 window.parent.triggerSlash
 *      （NC-MAP/公寓直调）。桥脚本内容进 display_text 围栏 → 输出变化 → bump。
 * v6 = 生成防重入 + /trigger 生成通道（渲染部分共存审查-第二轮 H1-new/H2-new 修复）：
 *      桥内 sendUserMessage 增加「生成中防重入」（父窗口 document.body.dataset.generating
 *      + GENERATION_STARTED/ENDED 事件标志，判定见 模板渲染.ts 判定生成中；生成中
 *      toastr「正在生成中，请稍后...」并 return，对齐 RP-Hub app.js:8426-8429）；
 *      触发生成从 ctx.generate('normal') 改为 executeSlashCommandsWithOptions('/trigger')
 *      （回退 host.TavernHelper.triggerSlash('/trigger')）——/trigger 先清空 #send_textarea
 *      再 Generate（slash-commands.js:4999），输入框内容不再被误发，且自带 waitUntilCondition
 *      防重入。桥脚本内容进 display_text 围栏 → 输出变化 → bump。
 * v7 = RP 模板消息判别（H-A）+ 兼容层注入参数化（H-B），渲染部分双向兼容审查-第三轮：
 *      渲染单条 增加「是模板消息（extra.rph_template_render / rph_has_update / rph_initial）」
 *      判别 —— TH 作者原生前端消息（无 RP 模板来源）不再被模板渲染器接管（不写 display_text、
 *      不覆盖 DOM、不打 rph_template_render）；渲染输出（哪些消息被渲染）变化 + 引入新标记
 *      （变量单向同步置 rph_has_update / rph_initial）→ bump。兼容性说明：
 *      - 旧 v6 持久化的「正常模板消息」因 rph_template_render===true 仍被判为模板消息（不消失）；
 *      - 旧 v6 被误渲染的「TH 原生消息」同样带 rph_template_render===true → 仍被渲染（保留
 *        现状，不自动回退 —— 这是 rph_template_render 兼容旧数据标记的固有取舍）；
 *      - 从未被渲染的 TH 原生消息（无任何标记）→ 判别后不再被接管，围栏恢复原样。
 * v8 = 脏 rph_display 引擎重算（狐策点不动方案 A）：
 *      渲染单条 正文源取 rph_display 时检测「脏 span」（单引号 `<span style='...#fff0f5'>`，
 *      历史旧预设污染产物，插进 JS 字符串内部 → 单引号嵌套 → JS 语法错误 → 狐策作者
 *      IIFE 中断 → toggleCollapsible 未挂 → 按钮点不动）→ 脏则异步调第二部
 *      __rphubCompat__.processAndCover(messageId, { force: true })（用 rph_raw_mes 干净源
 *      重算 rph_display；模板消息 commitDisplay 跳过 display_text）→ 重算后重读干净
 *      rph_display → 走正常渲染。渲染输出变化（干净 rph_display 进 display_text，不再写脏值）
 *      → bump。旧 v7 持久化含脏 rph_display 的消息因 version 不匹配 → 重渲染 → 走脏检测 → 重算。
 * v9 = 方案 A 修正（浏览器验证方向）：脏检测精确化 + 清理即渲染 + H-A 回退判据。
 *      - 脏检测只查 <script>...</script> 块内（脚本内含脏span）：上一版 正文含脏span
 *        扫全文，会把正文里合法的粉色 span（注释美化，RP-Hub 原版正常行为，实测楼1
 *        重算后仍含 2 个正文粉色 span）误判为脏 → 重算循环 → 3 次上限卡死楼1。
 *      - 清理即渲染：脚本块内脏 span 直接用 清理脚本脏span 还原为纯文本（对齐浏览器
 *        验证成功的清理正则），不再依赖引擎重算作为唯一修复（引擎重算对「ST 实际正则
 *        本身带脏 span」的卡无效 —— 用户实测 ST 里狐策正则就是带 span 注释的旧版，
 *        重算后还会脏）；rph_template_body 写干净正文保证下次跳过条件命中不重复清理。
 *        清理不净的极端情况才回退引擎重算（保留 重算次数上限）。
 *      - H-A 回退判据：是模板消息 增加第二参数（消息对象），mes/rph_raw_mes 含 RP 美化
 *        标签（<fox_selc> 等）时视为模板消息 —— v7 引入标记之前持久化的历史消息无
 *        rph_template_render/has_update/initial（实测楼3 全 undefined，严格版直接跳过
 *        → 脏检测永不执行 → 磁盘 rph_display 永远脏）。
 *      渲染输出变化（脚本内脏 span 被清理进 display_text + 更多历史消息进入渲染）→ bump。
 * v10 = 脚本脏 span 清理开关化（默认关闭，不改版本）：v9 的「清理即渲染」是特定冲突场景
 *      （卡内嵌正则与预设脚本冲突）的兜底，用户定性为「这是冲突」→ 默认关闭
 *      （thp_script_clean_enabled，缺省 false）。关闭 = 完全不介入（不清理、不触发引擎
 *      重算，脏 rph_display 原样渲染）；开启 = v9 清理即渲染逻辑。⚠️ 语义说明：v9 默认
 *      清理，v10 默认不清理 —— 默认渲染输出从「清理后」回到「原样脏」；但按用户指令不 bump
 *      版本（开关由用户显式开启时清理 = 既有 v9 行为，行为本身未变）。旧 v9 持久化已清理的
 *      display_text 保留（版本仍 9，跳过条件命中）；开关开启后后续事件对脏消息重新清理。
 * v11 = 清理范围扩展（两条线路隔离 需求3，bump 9→10 后的语义版本）：脚本块内脏标签判据
 *      「单引号 style + #fff0f5」→「脚本块内任意单引号 style 的 span/div」（不死斩裸单引号
 *      span，`<span style='display:inline;color:#ffe1a1;font-family:Consolas,Menlo,'Microsoft
 *      YaHei',monospace'>` 等不含 #fff0f5 的形态，刚满十八粉色便签同族）+ 单引号逃逸丢失
 *      形态（style 值内含未配对单引号）。清理还原为标签内纯文本（裸捕获组，不带引号 → JS
 *      合法，new Function 可编译）。⚠️ 本清理仍受 thp_script_clean_enabled 开关约束
 *      （默认关闭）；清理范围扩展只影响「开关开启后清理哪些脏标签」。
 *
 * v12 = 模板段骨架补齐（方案A）+ 兼容层注入正则修复（方案B），状态栏点不动修复；
 *       输出版本常量 10→11（上方 v11 注释描述的是常量 10 期的追加语义，注释号领先常量 1）：
 *       渲染输出形态变化（fence1 类以 `<body` 开头的模板段补 `<html><head></head>` 骨架；
 *       兼容层注入点修正）→ 输入池不变但输出变 → 哈希不覆盖输出变化 → bump 强制存量重渲染。
 *       - 方案A（确保html标记）：以 `<body` 开头且无 `<html`/`<head` 的模板段 → 前置
 *         `<!DOCTYPE html><html><head></head>` 骨架，消除 TH createSrcContent 包装后的嵌套
 *         body（内层 body data-r18 等属性丢失）+ 给兼容层提供真实 `<head>` 落点。
 *       - 方案B（注入模板兼容层）：`<head([^>]*)>` → `<head\b[^>]*>`，词边界避免误匹配
 *         `<header id="header">`，reset + triggerSlash 桥不再塞进 header 元素内部。
 *       - 围栏化 处理顺序重排：srcdoc双重转义 → 确保html标记（补骨架）→ 注入模板兼容层
 *         （先补骨架再注入，否则兼容层前置到内容开头会被误判跳过补骨架）。
 * v13 = 方案C：DOMContentLoaded 兜底（状态栏点不动收尾修复），输出版本常量 11→12：
 *       兼容层桥脚本（head 内，先于模板主脚本执行）注入 DCL 兜底 —— TH srcdoc iframe 里
 *       DOMContentLoaded 可能未触发/已错过，模板主脚本 inits（_t1~_t12）全依赖 DCL 回调
 *       （真实世界模拟器V2.1 状态栏 fence1），fence0 问卷用顶层同步绑定不受影响。
 *       兜底逻辑（生成DCL兜底脚本，幂等）：注册 DCL 监听置 __rpDCLFired；轮询
 *       readyState==='complete'（=DCL 必然已 fire）且未 dispatch 过 → 重放一次 DCL，
 *       前置置位 __rpDCLFired 杜绝二次 dispatch/_t1~_t12 重复绑定；DCL 正常触发 → 零动作。
 *       桥脚本内容进 display_text 围栏 → 输出变化 → bump 强制存量重渲染。
 * v14 = 脚本内实体 \x26 转义（状态栏点不动真根因修复），输出版本常量 12→13：
 *       实体解码破坏链确诊（1.txt 全链实测 + ST/TH 源码对照）：模板脚本 JS 字符串内实体
 *       字面量（真实世界模拟器V2.1 状态栏主脚本 esc 函数 `'&#39;'`）被 ST → TH 管道双重
 *       解码破坏 → 主脚本语法错误 → 从未执行 → 按钮全无绑定：
 *         ST makeHtml（script.js:1880，showdown encodeCode 把 code 块内 & → &amp;）
 *         → ST script.js:1889-1891（<code> 块内 &amp; → & 还原）
 *         → TH Iframe.vue:44 `$pre.find('code').text()`（jQuery 实体解码）
 *       `'&#39;'` → `'''`（3 裸单引号）→ JS 字符串截断 → IIFE 解析失败 → DCL 监听器从未
 *       注册（方案C 兜底 dispatch 白给）。问卷 fence0 不含实体字面量 → 不受影响。
 *       修复：围栏化 时把 <script> 块内「完整实体 &」（后跟 [a-zA-Z]+; 或 #\d+;）改写为
 *       \x26（JS 十六进制转义）——\x26 不含裸 &，管道三层均不命中，JS 求值还原为 &
 *       → esc 函数值不变（esc('&')='&amp;'、esc("'")='&#39;'）；&& 运算符（后不跟
 *       字母+;）不误伤。渲染输出形态变化（script 内容 &→\x26）→ bump 强制存量重渲染。
 *
 * ⚠️ 历史不 bump 说明（v6 期的「display_text 键缺失」修复，保持 6，未 bump）：
 *   「display_text 键缺失 → 编辑后不重渲染 / 狐策点不动」修复改的是**恢复/跳过判定**，
 *   不改变渲染输出形态：
 *   方案 A（重新断言DOM 补回 display_text 键）恢复内容 = 既有 rph_template_display（原样补回，
 *   不重新生成）；方案 B（跳过条件 display_text 缺失即强制重渲染）渲染输出 = 渲染全部模板
 *   在「池/正文/用户名未变」时的产物，与既有 rph_template_display 字节一致。故旧持久化消息
 *   无需失效重渲染，bump 无必要。v7 改「哪些消息被渲染」+ 新标记（bump 6→7）；v8 改
 *   「脏正文进渲染输出」（bump 7→8）；v9 改「脚本内脏 span 清理进渲染输出」+ H-A 回退
 *   （bump 8→9）；v10 改「清理范围扩展为任意单引号 style 的 span/div（不死斩裸单引号
 *   span，不再只认 #fff0f5）」+ 引擎级自动脚本区隔离（第二部，第三部渲染输出不变但
 *   展示侧正文 = 已隔离脚本区后的 rph_display）+ H-A 回退标签扩展 —— 输出形态变化，bump
 *   9→10。
 */
// R1 修复说明：上方版本链最新登记到 v14（常量 12→13），但实际常量 = 14（领先 1）——
// 存在一次未登记的 bump。保持常量 14 不变（改常量会改变存量重渲染语义），仅在此登记差异，
// 后续 bump 时同步补全 v15 注释，使 vN ↔ 常量一一对应。
// v15 = 围栏化正文「正文 + 尾部面板」拆分（醉酒的丈母娘开场白正文墙文本修复）：
//       交互片段标记 加块级开头锚定（不再裸用 交互片段标记.test(串)，否则正文含 <button>
//       即整段围栏）+ 新增 拆分正文面板（正文纯 markdown 在前、HTML 面板在后 → 正文内联 +
//       面板骨架围栏），避免「正文 + 尾部面板」被整段围栏进 iframe → 正文 \r\n\r\n 塌陷成
//       墙文本。渲染输出形态变化（正文段移出 iframe 围栏、内联渲染）→ bump 强制存量重渲染。
// v16 = 开场白 scoped 桥（路线 B，专项-开场白scoped桥/设计.md）：开场白（rph_initial===true）
//       正文段经第二部 runScoped 跑局部正则（沉浸式容器包渐变盒 + 隐藏运行状态栏），面板段照常
//       围栏。渲染输出形态变化（开场白正文从「纯 <p>」变「渐变盒正文」）→ bump 强制存量重渲染。
// v17 = 开场白正文「已渲染」检测（路线 B 二次包裹修复）：开场白正文段若已被第二部第一遍正则
//       渲染过（命中 thp_routeB_skip_rendered_patterns 检测模式，如裸 ^([\s\S]+)$ 沉浸式容器
//       包出的渐变盒）→ 跳过 runScoped，不再二次包裹（仙子修行 span>div>span 畸形）。
//       渲染输出形态变化（已渲染正文不再二次跑 scoped）→ bump 强制存量重渲染。
const 输出版本 = 17;

/* ---------- 响应式状态（供 UI 只读展示） ---------- */
/** 最近一次渲染处理状态说明 */
export const 渲染状态 = ref('等待渲染事件…');
/** 最近渲染错误文本（空串 = 无错误） */
export const 渲染错误 = ref('');
/** 模板定义是否已就绪（诊断用） */
export const 模板定义就绪 = ref(false);

/**
 * 响应式渲染开关（A3：UI 跨组件联动）。
 * 背景：TabDiagnose「全局模板渲染开关」与 TabTemplates「渲染总开关」此前都直接读
 * localStorage（非响应式）→ 在一处关闭后切到另一 Tab 显示仍为开启（假联动）。
 * 现 UI computed 一律读本 ref（同一 Vue app 内共享 → 两处实时联动）；
 * 服务层判定仍用 渲染开关已启用()（读 localStorage 键），两者经 设置渲染开关 双向同步。
 * 跨脚本重载（iframe 刷新）时 ref 重新初始化 = 读 localStorage 当前值。
 */
export const 渲染开关响应式 = ref(渲染开关已启用());

/* ---------- 总开关 ---------- */

export function 渲染开关已启用(): boolean {
  try {
    return localStorage.getItem(存储键) !== 'false';
  } catch {
    return true;
  }
}

/** 界面/控制台可读写总开关 */
export function 设置渲染开关(启用: boolean): void {
  try {
    localStorage.setItem(存储键, 启用 ? 'true' : 'false');
  } catch {
    // localStorage 不可用时静默降级
  }
  // A3：同步响应式 ref（UI 跨组件联动；服务层判定仍走 localStorage 键）
  渲染开关响应式.value = 启用;
  记录日志('模板渲染', `渲染总开关 → ${启用 ? '开启' : '关闭'}`);
  // 关闭 → 立即清理存量模板渲染（ST 优先读 display_text，不清理旧面板会一直在）；
  // 开启 → 立即对当前聊天重新收敛（恢复模板界面），避免等下次事件才生效。
  try {
    if (!启用) {
      清理存量渲染();
    } else {
      void 全量收敛();
    }
  } catch (e) {
    console.warn('[第三部] 渲染开关联动清理失败：', e instanceof Error ? e.message : String(e));
  }
}

/* ---------- 脚本脏 span 清理开关（默认关闭，狐策方案 A v10 追加） ---------- */

/** 脚本脏 span 清理开关 localStorage 键（缺省关闭：非 'true' 即禁用） */
const 清理存储键 = 'thp_script_clean_enabled';

/**
 * 脚本脏 span 清理开关是否启用。
 * 背景（方案 A v9→v10）：v9 的「脚本内含脏span → 清理脚本脏span → 清理即渲染」是特定
 * 冲突场景（卡内嵌正则与预设脚本冲突，脏 span 插进 JS 字符串内部 → 单引号嵌套 → JS 语法
 * 错误 → 狐策作者 IIFE 中断 → 按钮点不动）的兜底。用户定性为「这是冲突」—— 默认关闭，
 * 需要时手动开。关闭 = 完全不介入（不清理、不触发引擎重算，脏 rph_display 原样渲染，
 * 选择权全交给用户）；开启 = v9 清理即渲染逻辑。
 * @returns 是否启用（默认 false）
 */
export function 脚本清理已启用(): boolean {
  try {
    return localStorage.getItem(清理存储键) === 'true';
  } catch {
    return false;
  }
}

/** UI-C1 修复：脚本清理开关响应式 ref（UI 复选框联动；服务层判定仍读 localStorage） */
export const 脚本清理响应式 = ref(脚本清理已启用());

/** 界面/控制台可读写脚本脏 span 清理开关 */
export function 设置脚本清理开关(启用: boolean): void {
  try {
    localStorage.setItem(清理存储键, 启用 ? 'true' : 'false');
  } catch {
    // localStorage 不可用时静默降级
  }
  脚本清理响应式.value = 启用;
  记录日志('模板渲染', `脚本脏 span 清理 → ${启用 ? '开启' : '关闭'}`);
}

/* ---------- 开场白正文「已渲染」检测（路线 B 二次包裹修复，默认值可自定义） ---------- */

/** 已渲染正文检测清单 localStorage 键（JSON 字符串数组，每条 = 一段特征文字或 /正则/） */
const 已渲染正文模式键 = 'thp_routeB_skip_rendered_patterns';

/**
 * 默认「已渲染正文」检测清单。
 *
 * ============================================================================
 * 一、这清单是干什么的（先看懂再改）
 * ============================================================================
 * 开场白（rph_initial === true 的消息）走「路线 B scoped 桥」：第三部会把正文段再交给
 * 第二部跑一遍卡内 scoped 正则（比如「沉浸式容器」把正文包进渐变盒）。
 *
 * 但有些卡的「沉浸式容器 / 正文美化容器」正则没有「看到面板就跳过」的守卫，就是裸的
 * 整段匹配（形如 /^([\s\S]+)$/）。这类卡在第一遍（第二部引擎）就已经把正文渲染好了——
 * 正文早就被包进一个带 background/linear-gradient 的 <div> 容器里了。
 *
 * 如果路线 B 再跑一遍，就会「二次包裹」：保护替换会把已经带 div/span 标签的正文按标签
 * 切碎，每一小段又各自包一层容器 → 渲染结果变成一堆嵌套的 span>div>span 畸形（仙子修行
 * 实测：1 个容器被炸成 209 个容器、91 处畸形）。
 *
 * 所以这里维护一份「已渲染正文」的特征文字清单：正文里只要含有其中任一条特征，就认为
 * 「第一遍已经渲染好了」，路线 B 直接跳过、不再二次跑。
 * ============================================================================
 * 二、怎么判断一张卡要不要加进清单（判断）
 * ============================================================================
 * 出现「正文被二次包裹 / 嵌套 span>div>span / 容器数量暴增」的畸形时，做两步：
 *   1. 打开出问题的那条消息，看正文本身（不是面板）是不是已经被包进了一个带
 *      background 或 linear-gradient 的 <div> 里；
 *   2. 确认这个 div 是「正文容器」，不是「面板」。面板会在围栏化时被拆出去单独进
 *      iframe，正文容器才是我们要判断的对象。
 * 两步都成立 → 这张卡属于「第一遍就渲染好了」，把它正文容器的特征文字加进来。
 *
 * 反例（不用加）：醉酒的丈母娘那种容器正则自带负前瞻守卫（^(?![\s\S]*(面板标记))），
 * 第一遍看到面板会主动跳过、正文保持纯文本，路线 B 才第一次包 —— 这种不加。
 * ============================================================================
 * 三、怎么提取特征文字（提取）
 * ============================================================================
 * 两个途径，选一个：
 *   A. 看这张卡的 scoped 正则（沉浸式容器 / 正文美化容器那条），打开它的 replaceString，
 *      找到 <div style="background: ..."> 里那段渐变/背景样式；
 *   B. 直接打开消息渲染出来的 HTML，复制正文容器 style 属性里那段颜色值。
 * 然后抄「渐变颜色值开头那一截」—— 越独特越好，一般 linear-gradient( 后面那一串颜色
 * 值就足够区分，例如：
 *     卡片正文被包进 <div style="background: linear-gradient(180deg, rgba(28,21,19…)"…>
 *     → 抄 linear-gradient(180deg, rgba(28,21,19
 * ============================================================================
 * 四、怎么写进清单（写入）
 * ============================================================================
 *   1. 普通文字（默认，推荐）：直接粘那段颜色值，一条一行，不用加反斜杠、不用转义。
 *      匹配规则 = 字面子串（大小写不敏感），正文里含有这段字就命中。
 *   2. 需要模糊匹配时才用正则：把整条写成 /正则/flags 形式，
 *      例如 /linear-gradient\(180deg,\s*rgba/ 可以一条同时覆盖
 *      「180deg, rgba」和「180deg,rgba」（中间有没有空格都能中）。
 *   3. 留空行忽略。
 * ============================================================================
 * 五、特征文字的取舍要领（避免误伤 / 漏判）
 * ============================================================================
 *   - 不要太宽：只写 linear-gradient 会把所有带渐变的正文都判成「已渲染」，误伤别的卡；
 *     至少要带到「颜色值 + 数字」这个粒度（如上例里的 180deg / 28,21,19）。
 *   - 不要太长：整段 style 全粘进去虽然精确，但别人改一点样式就失效；取「渐变函数名 +
 *     前几个颜色参数」最稳。
 *   - 挑「正文容器独有」的词：面板里的颜色会被拆走、不影响；正文容器专属的颜色/结构
 *     才是要抄的。
 *
 * 默认值（两条线：一条通用正则兜底 + 三条具体颜色，命中的都是「整段包裹型」容器）：
 *   1. 通用兜底：/^<div\b[^>]*background/ —— 正文以「带 background 样式的 <div」开头
 *      即视为已渲染。因为所有整段包裹容器都会把正文包成一个带背景的 div（且在开头），
 *      纯正文不会以 <div 开头，所以这一条能覆盖绝大多数卡，不必每张卡抄颜色。
 *   2. 具体颜色（历史实测，精确零误伤，作为通用条失效时的后备 / 也当「怎么写」的示例）：
 *      - 与妹生活 正文美化容器：linear-gradient(135deg,#fff5f7…
 *      - 仙子的修行 沉浸式容器-玄幻金边：linear-gradient(180deg, rgba(28,21,19…
 *      - 醉酒的丈母娘 沉浸式容器：linear-gradient(#fffafa,#f8f0f0…
 * 用户可在「模板 / 渲染」页追加/修改。
 */
export const 默认已渲染正文模式 = [
  '/^<div\\b[^>]*background/',
  'linear-gradient(135deg,#fff5f7',
  'linear-gradient(180deg, rgba(28,21,19',
  'linear-gradient(#fffafa,#f8f0f0',
];

/** 读取「已渲染正文」检测模式（缺省/非法 → 默认值）。 */
export function 读取已渲染正文模式(): string[] {
  try {
    const raw = localStorage.getItem(已渲染正文模式键);
    if (!raw) return [...默认已渲染正文模式];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const list = parsed.map((x) => String(x ?? '').trim()).filter(Boolean);
      if (list.length > 0) return list;
    }
    return [...默认已渲染正文模式];
  } catch {
    return [...默认已渲染正文模式];
  }
}

/** 已渲染正文模式响应式 ref（UI 联动；服务层判定仍读 localStorage）。 */
export const 已渲染正文模式响应式 = ref(读取已渲染正文模式());

/** 写「已渲染正文」检测模式（去空去重），并同步响应式 ref。 */
export function 设置已渲染正文模式(模式: string[]): void {
  try {
    const list = (Array.isArray(模式) ? 模式 : []).map((x) => String(x ?? '').trim()).filter(Boolean);
    localStorage.setItem(已渲染正文模式键, JSON.stringify([...new Set(list)]));
  } catch {
    // localStorage 不可用时静默降级
  }
  已渲染正文模式响应式.value = 读取已渲染正文模式();
  记录日志('模板渲染', `开场白正文已渲染检测模式已更新（${已渲染正文模式响应式.value.length} 条）`);
}

/** 恢复默认「已渲染正文」检测模式（UI「恢复默认」按钮用）。 */
export function 重置已渲染正文模式(): void {
  try {
    localStorage.setItem(已渲染正文模式键, JSON.stringify([...默认已渲染正文模式]));
  } catch {
    // 忽略
  }
  已渲染正文模式响应式.value = [...默认已渲染正文模式];
  记录日志('模板渲染', `开场白正文已渲染检测模式已恢复默认（${默认已渲染正文模式.length} 条）`);
}

/**
 * 判断一段正文是不是「已经被第二部第一遍渲染过」。
 *
 * 判断依据（简单说）：拿正文去和「已渲染正文」清单里的每一条特征文字比对，只要正文里
 * 含有其中任一条特征，就判定为「已渲染」，返回 true → 调用方（渲染单条 的 正文变换）
 * 就跳过 runScoped，不再二次渲染。
 *
 * 每条特征的两种写法：
 *   - 普通文字（默认，最常用）：直接按「字面子串」比对（大小写不敏感）。例如清单里写
 *     linear-gradient(180deg, rgba(28,21,19，正文里只要出现这一段就算命中。不用转义。
 *   - /正则/flags 形式：当需要模糊匹配（比如容忍空格差异）时才用。识别规则 = 整条以 /
 *     开头、以 /flags 结尾，就按正则解析；正则编译失败 → 忽略这一条，不影响其它条。
 *
 * @param 正文 待判定的正文段（路线 B 拆出来的「前文本」）
 * @returns true = 已渲染（应跳过 runScoped）；false = 未渲染（照常跑 runScoped）
 */
export function 检测已渲染正文(正文: string): boolean {
  const 串 = String(正文 ?? '');
  if (!串) return false;
  // 提前把正文转成小写，普通文字按大小写不敏感比对
  const 小写串 = 串.toLowerCase();
  for (const 行 of 读取已渲染正文模式()) {
    const p = String(行 ?? '').trim();
    if (!p) continue; // 空行忽略
    // 写法一：整条是 /正则/flags 形式 → 按正则匹配（用于模糊匹配）
    const 正则 = p.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    if (正则) {
      try {
        if (new RegExp(正则[1], 正则[2] || 'i').test(串)) return true;
      } catch {
        // 正则写坏了 → 跳过这条，别让一条坏正则挡住其它条
      }
      continue;
    }
    // 写法二：普通文字 → 字面子串匹配（正文里含有这段字就命中）
    if (小写串.includes(p.toLowerCase())) return true;
  }
  return false;
}

/* ---------- 宿主上下文 ---------- */

/** 读取 SillyTavern 上下文（iframe 注入全局，@types 未声明 getContext，参照现有取法） */
function 获取上下文(): any {
  try {
    return (SillyTavern as unknown as { getContext?: () => any }).getContext?.() ?? null;
  } catch {
    return null;
  }
}

/** 读取当前卡名 */
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

/** 读取当前用户名（{{user}} 宏替换源；优先 getContext().name1，兜底全局 / parent） */
function 获取用户名(): string {
  try {
    const ctx = 获取上下文();
    const u = ctx?.name1 ?? (SillyTavern as any)?.name1;
    if (typeof u === 'string') return u;
  } catch {
    // 忽略，走兜底
  }
  try {
    const parent = window.parent as any;
    const pctx = parent?.SillyTavern?.getContext?.();
    const u = pctx?.name1;
    if (typeof u === 'string') return u;
  } catch {
    // 忽略
  }
  return '';
}

/** 读取某条消息对象（SillyTavern.chat 为 live 引用） */
function 获取消息(messageId: number): SillyTavern.ChatMessage | null {
  try {
    const chat = SillyTavern.chat;
    if (!Array.isArray(chat) || messageId < 0 || messageId >= chat.length) return null;
    return chat[messageId];
  } catch {
    return null;
  }
}

/* ---------- 模板定义懒取 + 缓存 ---------- */

/** 纯 GET 请求，CORS 直连失败返回 null 不抛错 */
async function 请求<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface ByName {
  cardId: string;
}

interface VariablesView {
  variables?: { uiTemplates?: 模板定义[] };
}

let 模板定义缓存: { 卡名: string | null; 模板列表: 模板定义[] | null; 时间: number } | null = null;

/** 命中缓存（含空卡名占位）→ 返回列表（可能为 null=卡无模板）；未命中 → null */
function 取缓存(): { 模板列表: 模板定义[] | null } | null {
  const 卡名 = 获取当前卡名();
  if (!卡名) return { 模板列表: null };
  if (模板定义缓存 && 模板定义缓存.卡名 === 卡名 && Date.now() - 模板定义缓存.时间 < 缓存TTL毫秒) {
    return { 模板列表: 模板定义缓存.模板列表 };
  }
  return null;
}

/**
 * 拉取当前卡模板定义（后端 uiTemplates 数组）并缓存；后端不可达 / 卡未匹配 / 无模板 → null。
 * 幂等可重复调用；CHAT_CHANGED 时调用方清缓存。
 * 导出（B1：TabTemplates「检测当前卡模板」按钮复用，替代占位）。
 */
export async function 拉取模板定义(): Promise<模板定义[] | null> {
  const 卡名 = 获取当前卡名();
  if (!卡名) {
    模板定义缓存 = { 卡名: null, 模板列表: null, 时间: Date.now() };
    模板定义就绪.value = false;
    return null;
  }
  const 命中 = 取缓存();
  if (命中) {
    模板定义就绪.value = Array.isArray(命中.模板列表);
    return 命中.模板列表;
  }
  try {
    const by_name = await 请求<ByName>(`${BASE}/cards/by-name/${encodeURIComponent(卡名)}`);
    if (!by_name) {
      模板定义缓存 = { 卡名, 模板列表: null, 时间: Date.now() };
      模板定义就绪.value = false;
      return null;
    }
    const vars = await 请求<VariablesView>(`${BASE}/cards/${by_name.cardId}/variables?fields=uiTemplates`);
    const 列表 = Array.isArray(vars?.variables?.uiTemplates) ? vars.variables.uiTemplates : null;
    模板定义缓存 = { 卡名, 模板列表: 列表, 时间: Date.now() };
    模板定义就绪.value = Array.isArray(列表);
    return 列表;
  } catch (e) {
    渲染错误.value = `模板定义拉取失败：${e instanceof Error ? e.message : String(e)}`;
    记录日志('模板渲染', `模板定义拉取失败：${e instanceof Error ? e.message : String(e)}`, 'warn');
    return null;
  }
}

/** 清模板定义缓存（CHAT_CHANGED / 手动刷新时调用） */
export function 清空模板定义缓存(): void {
  模板定义缓存 = null;
  模板定义就绪.value = false;
}

/* ---------- 渲染提交 ---------- */

/** 防抖持久化 display_text（ST saveChat = saveChatConditional） */
let 保存定时器: ReturnType<typeof setTimeout> | null = null;
function 调度保存(): void {
  if (保存定时器) return;
  保存定时器 = setTimeout(() => {
    保存定时器 = null;
    try {
      const ctx = 获取上下文();
      (ctx?.saveChat ?? (SillyTavern as any)?.saveChat)?.();
    } catch {
      // 保存失败不阻塞主流程（下次事件重写 display_text 仍会再次保存）
    }
  }, 600);
}

/**
 * 提交渲染结果：写 display_text + 标记 → ST 重渲染该楼 → .mes_text 补 rph-rendered 标记。
 * 安全网：同事件后续监听（rp-hub-compat 的 forceApply 覆盖 / 其它扩展）可能把 DOM 换回
 * 引擎输出 —— setTimeout(0) 后若 DOM 仍无 TH-render iframe，则重新断言模板 DOM 并触发
 * CHARACTER_MESSAGE_RENDERED（让酒馆助手补建 iframe；rp-hub-compat 因 TH-render/标记跳过）。
 * @param 正文 本次渲染用的正文源（决策 D3：rph_display 或回退 mes）—— 写入标记用于变更检测
 * @returns 是否成功写入了 display_text
 */
function 提交渲染(messageId: number, 消息: SillyTavern.ChatMessage, 显示文本: string, 池哈希: string, 正文: string): boolean {
  try {
    const extra = 消息.extra ?? (消息.extra = {});
    extra.display_text = 显示文本;
    extra.rph_template_render = true;
    extra.rph_template_hash = 池哈希;
    extra.rph_template_body = 正文;
    extra.rph_template_display = 显示文本;
    extra.rph_template_version = 输出版本;
  } catch (e) {
    渲染错误.value = `写 display_text 失败：${e instanceof Error ? e.message : String(e)}`;
    return false;
  }
  // 触发 ST 重渲染该楼（getMessageTextHTML / updateMessageBlock 优先读 display_text，
  // script.js:1970/1977；本函数不发射 RENDERED 事件，不会立即引起三方再次处理）
  try {
    const ctx = 获取上下文();
    if (typeof ctx?.updateMessageBlock === 'function') {
      ctx.updateMessageBlock(messageId, 消息);
    } else if (typeof (SillyTavern as any)?.updateMessageBlock === 'function') {
      (SillyTavern as any).updateMessageBlock(messageId, 消息);
    }
  } catch (e) {
    渲染错误.value = `ST 重渲染失败：${e instanceof Error ? e.message : String(e)}`;
  }
  // DOM 补 rph-rendered 标记（脚本 iframe 的 $ 为父页面 jQuery，parent_jquery.js）：
  // rp-hub-compat 修复4 据此把当前 DOM 视为引擎结果 → 重算一致时跳过覆盖。
  try {
    const $mesText = $('.mes[mesid="' + messageId + '"] .mes_text');
    if ($mesText.length > 0 && $mesText.find('textarea').length === 0) {
      $mesText.addClass(引擎标记);
    }
  } catch {
    // 编辑态 / DOM 未就绪时忽略（编辑态跳过是本服务的既有策略）
  }
  调度保存();
  // 新一轮渲染：重置该消息的重扫计数（重扫上限只约束同一轮渲染的收敛）
  重扫计数.delete(messageId);
  // 干净渲染成功：重置脏 rph_display 重算计数（狐策点不动方案 A，下次再脏可重新触发）
  重算计数.delete(messageId);
  // 安全网：本事件其它监听（尤其 rp-hub-compat UPDATED forceApply）可能已把 DOM 换回引擎
  // 输出 —— 下一帧若 DOM 仍无 TH-render，重新断言模板 DOM 并触发重扫描（收敛）。
  setTimeout(() => {
    重新断言DOM(messageId);
  }, 0);
  return true;
}

/**
 * 重新断言模板 DOM（安全网 / 聊天打开收敛共用）：
 * 仅当该消息是本服务渲染结果（rph_template_render + rph_template_display）时处理。
 * 按 DOM 三种状态分流（方案 A，容器内代码块TH折叠未iframe-根因调查.md）：
 *   1. 有 div.TH-render iframe    → 已 iframe 化（真渲染）→ 零动作（幂等，防抖动）。
 *   2. 有 div.TH-render 无 iframe → 折叠壳（TH 挂载失败/被销毁/竞态）：**不重建**
 *      —— jQuery .html() 重建会销毁 Vue 组件树管理的 iframe（竞态根因：setTimeout(0)
 *      断言早于 TH Teleport 挂载，重建销毁刚挂的 iframe 且 onBeforeUnmount 不执行，
 *      hidden! 残留）。只补 rph-rendered 标记 + 触发 RENDERED 重扫让 TH 补挂 iframe；
 *      重扫计数达 重扫次数上限 后不再触发（防 TH 补挂失败时无限循环）。
 *   3. 无 div.TH-render          → 模板围栏未渲染（DOM 是裸 ST 渲染 / 被外部换回）
 *      → updateMessageBlock 重建 + 补标记 + 触发重扫描（保持原逻辑）。
 * 编辑态（textarea）→ 跳过。
 *
 * display_text 键缺失恢复（方案 A，编辑后不重渲染 / 狐策点不动 修复）：ST 某些路径会删除
 * `extra.display_text` 键（swipe clearMessageData script.js:10062），此时 rph_template_display
 * 仍在 —— 若直接 return 则 DOM 永远停在 ST 用 mes 纯正文渲染的裸正文（无模板围栏）。故
 * 键缺失但 rph_template_display 是有效字符串时，补回 display_text 键再走下方三分支恢复。
 */
function 重新断言DOM(messageId: number): void {
  try {
    const 消息 = 获取消息(messageId);
    if (!消息) return;
    const extra = 消息.extra ?? {};
    if (extra.rph_template_render !== true || typeof extra.rph_template_display !== 'string') return;
    // display_text 被外部改写为其它值（存在且 ≠ rph_template_display）→ 交给事件收敛重渲染
    if (判断显示键状态(extra) === '存在但不一致') return;
    // display_text 键缺失/空 → 补回显示键（值 = rph_template_display），随后走下方恢复路径
    if (typeof extra.display_text !== 'string' || extra.display_text.length === 0) {
      extra.display_text = extra.rph_template_display;
      调度保存(); // 持久化补回的 display_text（防抖，ST saveChat 落盘）
    }
    const $mesText = $('.mes[mesid="' + messageId + '"] .mes_text');
    if ($mesText.length === 0) return;
    if ($mesText.find('textarea').length > 0) return; // 编辑态
    const 有TH容器 = $mesText.find('div.TH-render').length > 0;
    const 有THiframe = $mesText.find('div.TH-render iframe').length > 0;
    if (有TH容器 && 有THiframe) return; // 已 iframe 化（真渲染）→ 零动作
    // 补 rph-rendered 标记（DOM 已是本服务渲染结果；rp-hub-compat 修复4 据此跳过覆盖）
    $mesText.addClass(引擎标记);
    if (有TH容器) {
      // 折叠壳（TH 补挂失败/竞态）：不重建（避免 jQuery 销毁 Vue 管理的 iframe），
      // 只触发重扫描让 TH 补挂；计数达上限后停止触发（防无限循环）。
      const 已触发 = 重扫计数.get(messageId) ?? 0;
      if (已触发 < 重扫次数上限) {
        重扫计数.set(messageId, 已触发 + 1);
        触发重扫描(messageId);
      }
      return;
    }
    // 无 TH-render → 模板围栏未渲染 → 重建 + 重扫描
    重扫计数.set(messageId, 0);
    const ctx = 获取上下文();
    if (typeof ctx?.updateMessageBlock === 'function') {
      ctx.updateMessageBlock(messageId, 消息);
    }
    触发重扫描(messageId);
  } catch {
    // DOM 操作失败忽略（下次事件仍会收敛）
  }
}

/** 计算楼层池哈希（变更检测用） */
function 计算池哈希(池表: Record<string, unknown>): string {
  try {
    return JSON.stringify(池表);
  } catch {
    return 'unserializable:' + Object.keys(池表).length;
  }
}

/* ---------- 合并楼层池（全兼容：对齐原版「状态跨楼层携带、每层渲染全部 active 模板」） ---------- */

/** 各层合并池缓存：merged[k] = 合并(merged[k-1], 第 k 层池)（顺序滚动合并，O(n)） */
const 合并缓存 = new Map<number, 模板池表>();

/** 清空合并缓存（聊天切换 / 消息增删 / 编辑后调用） */
function 清空合并缓存(): void {
  合并缓存.clear();
}

/**
 * 读取到当前楼层为止的合并池（对齐原版 attachUiTemplateBlocksToLastAssistant 每次渲染
 * 全部 active 模板 + variableState 全局跨回合累积，合并楼层池-影响检测.md）。
 * merged[k] = 深合并(merged[k-1], 第 k 层池)；楼层无池则沿用前一层的合并结果。
 * 顺序滚动缓存：新增楼层只合并一次（O(层数) 而非 O(n²)）。
 * @param messageId 目标楼层
 * @returns 合并池（开场白初始变量 + 各层更新累积）
 */
function 读取合并楼层变量(messageId: number): 模板池表 {
  const chat = SillyTavern.chat;
  if (!Array.isArray(chat) || messageId < 0) return {};
  // 增量：从缓存中已有最高层续滚（旧楼层变化时清空缓存由调用方负责）
  let 起点 = -1;
  for (const k of 合并缓存.keys()) {
    if (k > 起点) 起点 = k;
  }
  let 累计: 模板池表 = {};
  if (起点 >= 0 && 起点 < messageId) {
    // 从缓存续滚
    累计 = 合并缓存.get(起点) ?? {};
  } else if (起点 >= messageId) {
    const 命中 = 合并缓存.get(messageId);
    if (命中 !== undefined) return 命中;
    // C4 防御：缓存键不连续（如中间楼层被删/序号前移后未清缓存）→ 从 0 重滚，
    // 避免返回空表导致渲染空池
    起点 = -1;
    累计 = {};
  }
  for (let k = 起点 + 1; k <= messageId; k++) {
    const 楼层池 = 读取楼层变量(k); // 每层自身池
    累计 = 深合并池(累计, 楼层池);
    合并缓存.set(k, 累计);
  }
  return 累计;
}

/**
 * 渲染单条消息（模板定义缓存命中时全同步，在事件内完成 —— 保证先于酒馆助手同事件扫描）。
 * 正文视角（决策 D3）：display_text = 引擎美化正文（msg.extra.rph_display，rphub 美化输出）
 *   + 模板围栏；rph_display 缺失（未处理消息 / 非 rphub 卡）时回退 msg.mes。
 * @param messageId 目标楼层
 * @param 选项.记日志 是否记录运行日志（默认 true；全量收敛/强制重渲染循环传 false 防刷屏）
 * @param 选项.强制 是否绕过「已渲染且未变」缓存跳过（默认 false；「强制重新渲染」按钮
 *   传 true —— 无论缓存是否一致都完整重渲染写回 display_text + updateMessageBlock，
 *   使「强制」语义真正落地，否则已渲染未变的消息会被缓存跳过 = 点了按钮界面无变化）。
 * @returns { 渲染了, 原因 } 原因：'模板定义未就绪' 时调用方可走异步补渲染
 */
export function 渲染单条(messageId: number, 选项: { 记日志?: boolean; 强制?: boolean } = {}): { 渲染了: boolean; 原因?: string } {
  if (!渲染开关已启用()) return { 渲染了: false, 原因: '渲染总开关关闭' };
  const 消息 = 获取消息(messageId);
  if (!消息 || typeof 消息.mes !== 'string' || 消息.is_system) {
    return { 渲染了: false, 原因: '跳过（消息不存在 / 系统消息）' };
  }
  // 用户消息不渲染模板（对齐原版 attachUiTemplateBlocksToLastAssistant 只挂 assistant，
  // app.js:2275-2279 getLastAssistantMessage）。用户楼层合并了前序 AI 楼层的池状态，
  // 若不过滤会渲染出模板围栏（柚夏实测：用户消息显示 app-wrapper 状态栏，问题 2）。
  if (消息.is_user) {
    return { 渲染了: false, 原因: '用户消息不渲染模板（对齐原版 assistant-only）' };
  }
  // H-A：RP 模板消息判别（渲染部分双向兼容审查-第三轮）——TH 作者原生前端消息
  // （assistant、把 ```html 界面直接写进 mes、无 RP 模板来源）不被模板渲染器接管：
  // 不满足「是模板消息」→ 跳过（不渲染、不写 display_text、不覆盖 DOM、不打
  // rph_template_render）。是模板消息 = 满足任一：
  //   extra.rph_template_render===true（已渲染/已持久化的模板消息——兼容旧数据）
  //   extra.rph_has_update===true（本消息带过 <ui_template_updates> 更新块）
  //   extra.rph_initial===true（开场白初始化目标楼层）
  //   H-A 回退判据（追加修复）：mes / rph_raw_mes 含 RP 美化标签（<fox_selc> 等）
  //     —— v7 之前持久化的历史消息无上述三标记但确需渲染（楼3 狐策消息，实测
  //     rph_template_render 全 undefined，严格版会直接跳过 → 脏检测永不执行）。
  // 语义权衡（严格版）：RP 卡中「不带更新块的非开场白 assistant 消息」不再渲染模板
  // （显示纯正文）——与原版「每回合全量渲染」偏离，但这是 TH 原生消息可共存的必要代价；
  // 回退判据只救旧数据（详见 模板渲染.ts 是模板消息 注释）。
  if (!是模板消息(消息.extra, 消息)) {
    return { 渲染了: false, 原因: '非 RP 模板消息（H-A 判别：无 rph_template_render / rph_has_update / rph_initial / RP 美化标签）' };
  }
  // 合并楼层池（全兼容）：渲染到当前楼层为止的累积状态（开场白初始 + 各层更新），
  // 对齐原版「每层渲染全部 active 模板、状态跨楼层携带」（合并楼层池-影响检测.md）。
  // 改法4（空池粘住修复）：读取合并池后先做渲染侧回退 —— 合并池内层为空的模板
  // 回退卡面 initialVariableState（对齐原版回退链 app.js:2494-2507 语义；只读回退，
  // 不写回 chat 变量、不引入 runtimeByCharacter、不污染合并缓存 —— 返回新对象）。
  // 冷缓存（模板定义未就绪）时回退无操作，由下方「模板定义未就绪」路径异步补取后重进。
  // 池空早退：合并池为空（开场白无初始变量且前序楼层均无更新，且卡面无初始变量可回退）→ 不渲染。
  const 池表原始 = 读取合并楼层变量(messageId);
  const 缓存早取 = 取缓存();
  const 池表 = 缓存早取?.模板列表?.length
    ? 回退卡面初始状态(池表原始, 缓存早取.模板列表)
    : 池表原始;
  const 池键数 = Object.keys(池表).length;
  if (池键数 === 0) {
    // 池仍空：模板定义缓存未就绪 → 交给「模板定义未就绪」路径异步补取后重试（回退需模板列表）；
    // 否则（卡面无初始变量可回退）→ 真空池，不渲染。
    if (!缓存早取) return { 渲染了: false, 原因: '模板定义未就绪（触发异步取）' };
    return { 渲染了: false, 原因: '合并楼层池为空' };
  }
  const 池哈希 = 计算池哈希(池表);
  // 正文源（决策 D3）：优先 rph_display（引擎美化输出），缺失回退 msg.mes（剥离更新块后正文）
  let 正文 = typeof 消息.extra?.rph_display === 'string' && 消息.extra.rph_display.length > 0
    ? 消息.extra.rph_display
    : 消息.mes;
  // 脏 rph_display 清理（狐策点不动方案 A 修正 v9 → v10 开关化）：脚本块内的脏 span
  // （单引号粉色 span 插进 JS 字符串内部 → 单引号嵌套 → JS 语法错误 → 狐策作者 IIFE
  // 中断 → toggleCollapsible 未挂 → 按钮点不动）→ 清理即渲染。只查 <script>...</script>
  // 块内（正文美化粉色 span 不在脚本块内，不误判 —— 上一版 正文含脏span 全文扫描把楼1
  // 正文粉色 span 误判 → 重算循环 → 3 次上限卡死）。
  // ⚠️ v10：本清理默认**关闭**（thp_script_clean_enabled，默认 false）。脏 span 是特定
  // 冲突场景（卡内嵌正则与预设脚本冲突）的兜底，用户定性为「这是冲突」—— 关闭 = 完全不
  // 介入（不清理、不触发引擎重算，脏 rph_display 原样渲染，选择权全交给用户）；开启 = 下方
  // 清理即渲染逻辑。
  if (脚本清理已启用() && 脚本内含脏span(正文)) {
    const 干净正文 = 清理脚本脏span(正文);
    if (脚本内含脏span(干净正文)) {
      // 清理不净（极端：当前预设正则本身带脏 span，清理正则不匹配）→ 回退引擎重算
      // （processAndCover 用 rph_raw_mes 干净源重算）；达重算次数上限 → 跳过渲染保留现状。
      const 已试 = 重算计数.get(messageId) ?? 0;
      if (已试 >= 重算次数上限) {
        return { 渲染了: false, 原因: '脏 rph_display 清理不净且重算超限，跳过渲染（保留现状）' };
      }
      重算计数.set(messageId, 已试 + 1);
      void 异步重算脏显示并重渲染(messageId);
      return { 渲染了: false, 原因: '脏 rph_display 清理不净，触发引擎重算' };
    }
    // 清理成功：用干净正文渲染（rph_template_body 写干净正文 → 下次跳过条件命中不重复清理）
    正文 = 干净正文;
  }
  // 缓存命中且 display_text 未被外部覆写且正文源未变 → 跳过（重载/重复事件收敛）。
  // 但编辑取消（ST messageEditCancel 用 chat[messageId].mes 重建 DOM，script.js:8238）等
  // 场景下 extra 标记未变、DOM 却被 ST 换成纯正文（无模板围栏）—— 复用重新断言DOM 安全网：
  // 若当前 DOM 无 TH-render（不是模板 iframe），用 display_text 重建模板围栏 + 触发重扫描收敛。
  // 方案 B：display_text 键缺失/空（被 ST 删除，script.js:10062）时跳过条件不命中 →
  // 走下方完整渲染路径（渲染全部模板 → 提交渲染 → 写回 display_text + updateMessageBlock 重建）。
  const extra = 消息.extra ?? {};
  if (
    !选项.强制 &&
    extra.rph_template_render === true &&
    extra.rph_template_version === 输出版本 &&
    extra.rph_template_hash === 池哈希 &&
    extra.rph_template_body === 正文 &&
    判断显示键状态(extra) === '存在且一致'
  ) {
    重新断言DOM(messageId);
    return { 渲染了: false, 原因: '已渲染且未变' };
  }
  const 缓存 = 取缓存();
  if (!缓存) return { 渲染了: false, 原因: '模板定义未就绪（触发异步取）' };
  if (!缓存.模板列表 || 缓存.模板列表.length === 0) {
    return { 渲染了: false, 原因: '卡面无 uiTemplates' };
  }
  // 路线 B 开场白 scoped 桥：开场白（rph_initial===true）把拆出的正文段交给第二部引擎跑
  // scoped 正则（沉浸式容器包渐变盒 + 隐藏运行状态栏），面板段照常围栏进 iframe。
  // 第二部 runScoped 缺失（未加载/旧版本）→ 正文变换 undefined → 围栏化正文走原样（不包渐变盒）。
  // 已渲染守卫：正文已被第二部第一遍正则渲染过（命中「已渲染正文检测模式」）→ 不再二次跑
  // runScoped（否则保护替换按标签切碎正文、每段再包一层容器 → span>div>span 畸形，仙子修行实测）。
  let 正文变换: ((text: string) => string) | undefined;
  if (消息.extra?.rph_initial === true) {
    const 桥 = 获取引擎桥();
    if (桥 && typeof 桥.runScoped === 'function') {
      正文变换 = (text) => (检测已渲染正文(text) ? text : 桥.runScoped!(text));
    }
  }
  const 显示文本 = 渲染全部模板({
    模板列表: 缓存.模板列表,
    池表,
    正文,
    用户名: 获取用户名(),
    正文变换,
  });
  if (显示文本 === null) return { 渲染了: false, 原因: '无可渲染模板' };
  提交渲染(messageId, 消息, 显示文本, 池哈希, 正文);
  if (选项.记日志 !== false) {
    记录日志('模板渲染', `#${messageId} 已渲染模板界面（${缓存.模板列表.length} 个模板）`);
  }
  return { 渲染了: true };
}

/**
 * 异步补渲染：缓存未命中（首次事件 / 扩展刚加载）→ 拉模板定义后再渲染，
 * 完成后触发 CHARACTER_MESSAGE_RENDERED 让酒馆助手补建 iframe（重扫描防重入）。
 */
async function 异步补渲染(messageId: number): Promise<void> {
  await 拉取模板定义();
  渲染单条(messageId); // 此时缓存已热（同步渲染）；后端不可达则内部跳过
  触发重扫描(messageId);
}

/* ---------- 脏 rph_display 引擎重算（狐策点不动方案 A，渲染部分双向兼容审查-第三轮 续） ---------- */

/**
 * 第二部引擎全局入口（window.__rphubCompat__，pipeline/force-render.js mountCompatApi 挂载）。
 * 第三部脚本跑在酒馆助手 iframe（about:srcdoc），iframe 的 window ≠ 主页面 window；
 * 第二部 mountCompatApi 挂在主页面 window 上。逐层回退查找：
 *   window → window.parent → window.top，任一找到即返回。
 * window.parent / window.top 可能跨源抛错 → 每层独立 try/catch，失败继续向上。
 */
function 获取引擎桥(): { processAndCover?: (messageId: number, opts?: { force?: boolean }) => Promise<unknown>; runScoped?: (text: string, opts?: { mode?: string; role?: number | null }) => string } | null {
  const 层级: Array<Window | null> = [];
  try { 层级.push(window); } catch { /* 忽略（window 访问异常） */ }
  try { 层级.push(window.parent); } catch { /* 跨源 / 访问异常，忽略 */ }
  try { 层级.push(window.top); } catch { /* 跨源 / 访问异常，忽略 */ }
  for (const g of 层级) {
    try {
      const api = (g as unknown as Record<string, unknown> | null | undefined)?.__rphubCompat__;
      if (api && typeof api === 'object') return api as { processAndCover?: (messageId: number, opts?: { force?: boolean }) => Promise<unknown>; runScoped?: (text: string, opts?: { mode?: string; role?: number | null }) => string };
    } catch {
      // 该层访问异常 → 尝试上一层
    }
  }
  return null;
}

/** 每消息脏 rph_display 引擎重算尝试次数上限（达上限本会话不再重试，防重算不收敛时死循环） */
const 重算次数上限 = 3;
/** 每消息已触发脏重算的累计次数（干净渲染成功 / 重新渲染时重置） */
const 重算计数 = new Map<number, number>();

/**
 * 脏 rph_display → 第二部引擎重算（异步，防重入）。
 * 引擎侧：processAndCover(messageId, { force: true }) 经 processMessageView → source 缺省
 * 取 snapshotRaw(msg)（已有 rph_raw_mes 快照，为剥离更新块后的干净源）→ 当前预设脚本重算
 * 显示通道 → commitMessageView 写回干净 rph_display；模板消息（rph_template_render）下
 * commitDisplay 跳过 display_text 覆写（pure.js:174），第三部标记不受影响。
 * @returns 重算是否成功（processAndCover 缺失 / 抛错 → false，调用方降级保留现状）
 */
async function 引擎重算脏显示(messageId: number): Promise<boolean> {
  const 桥 = 获取引擎桥();
  if (!桥 || typeof 桥.processAndCover !== 'function') {
    // 降级：第二部未挂 processAndCover（旧版本 / 未加载）→ 保留现状，warn 一次。
    // 不渲染脏正文（避免把脏 v8 display_text 持久化，否则脏检测会被缓存命中永久绕过）。
    console.warn('[第三部] __rphubCompat__.processAndCover 不可用，脏 rph_display 无法引擎重算，保留现状（升级 rp-hub-compat 后重开聊天可修复）');
    return false;
  }
  try {
    await 桥.processAndCover(messageId, { force: true });
    return true;
  } catch (e) {
    console.warn('[第三部] 引擎重算脏 rph_display 失败：', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * 脏 rph_display：引擎重算 → 成功后重读 rph_display（此时应干净）→ 重新走 渲染单条
 * （提交 display_text + 标记 + updateMessageBlock）→ 触发 TH 重扫描补建 iframe。
 * 重算不成功 → 保持现状不重渲染（旧 display_text 由 ST 照常显示，与修复前一致）。
 */
async function 异步重算脏显示并重渲染(messageId: number): Promise<void> {
  const 重算成功 = await 引擎重算脏显示(messageId);
  if (!重算成功) return; // 降级：保留现状，本会话后续事件不再重试（计数已累计）
  // 重算完成：rph_display 已干净 → 渲染单条 正文源重读干净值 → 缓存命中判定因正文源
  // 变化（rph_template_body ≠ 旧脏值）不命中 → 完整渲染写干净 display_text。
  const 结果 = 渲染单条(messageId);
  if (结果.渲染了) {
    // 干净重渲染成功 → 触发 TH 补建 iframe（提交渲染 只 updateMessageBlock，不发射
    // RENDERED，TH 不会自动重扫该楼 —— 不加这行则自动修复路径只换数据不换界面）。
    触发重扫描(messageId);
  }
}

/** 触发酒馆助手对该消息补建 iframe（emit CHARACTER_MESSAGE_RENDERED，防重入） */
function 触发重扫描(messageId: number): void {
  if (重扫描中.has(messageId)) return;
  重扫描中.add(messageId);
  try {
    (eventEmit as (事件: unknown, ...参数: unknown[]) => void)(tavern_events.CHARACTER_MESSAGE_RENDERED, messageId);
  } catch {
    // 事件 API 不可用时静默降级（模板界面降级为代码块，下次事件仍会收敛）
  }
  重扫描中.delete(messageId);
}

/**
 * 事件处理入口：同步渲染；缓存未热时异步补渲染。
 * C1 性能：只对「内容变更类」事件（swipe 切换 / 编辑保存 / 消息更新，楼层池或序号可能变）
 * 清空合并缓存；纯显示事件（CHARACTER/USER_MESSAGE_RENDERED）保留滚动合并缓存
 * （长聊天每轮 RENDERED 不再从 0 重合并到目标楼层，O(n) → O(1) 摊销）。
 * 消息删除 / 加载更早历史（MESSAGE_DELETED / MORE_MESSAGES_LOADED）在启动时另行注册清缓存。
 * @param 清缓存 true = 先清空合并缓存再渲染（内容变更类事件）
 */
function 处理事件(messageId: number, 清缓存 = false): void {
  if (清缓存) 清空合并缓存();
  const 结果 = 渲染单条(messageId);
  if (结果.原因 === '模板定义未就绪（触发异步取）') {
    void 异步补渲染(messageId);
  }
  if (结果.渲染了) {
    渲染状态.value = `#${messageId} 已渲染模板界面`;
    渲染错误.value = '';
  }
}

/**
 * 关闭渲染开关时清理存量模板渲染（用户反馈「渲染开关没有用，一直是打开的」根治）。
 *
 * 根因：总开关只阻止「新渲染」（渲染单条/全量收敛/强制重渲染全部 均有守卫），但已持久化的
 * `extra.display_text`（含 ```html 模板围栏）仍在，ST updateMessageBlock 优先读 display_text
 * （script.js:1977 `message?.extra?.display_text ?? message.mes`）→ 关掉开关旧面板照常显示。
 *
 * 本函数把每个「已渲染模板」的消息 display_text 还原为纯正文（rph_template_body / mes），
 * 并 updateMessageBlock 重建 DOM + 触发重扫描（酒馆助手据此摘除残留模板 iframe）。
 * 保留 rph_template_* 标记：重新开启开关后 渲染单条 的跳过条件（判断显示键状态 === '存在且一致'）
 * 因 display_text ≠ rph_template_display 而不命中 → 走完整渲染路径恢复模板界面。
 * 幂等：已是纯正文的消息跳过；渲染开关开启时零动作。
 * @returns 本次还原的消息数
 */
function 清理存量渲染(): number {
  if (渲染开关已启用()) return 0;
  const chat = SillyTavern.chat;
  if (!Array.isArray(chat)) return 0;
  let count = 0;
  for (let messageId = 0; messageId < chat.length; messageId++) {
    const 消息 = chat[messageId];
    if (!消息 || 消息.is_system) continue;
    const extra = 消息.extra;
    if (!extra || typeof extra !== 'object') continue;
    // 只有本服务渲染过（有 rph_template_display 缓存）的消息才需要还原
    if (typeof extra.rph_template_display !== 'string' || extra.rph_template_display.length === 0) continue;
    const 纯正文 = typeof extra.rph_template_body === 'string' && extra.rph_template_body.length > 0
      ? extra.rph_template_body
      : (typeof 消息.mes === 'string' ? 消息.mes : '');
    if (extra.display_text === 纯正文) continue; // 已是纯正文（幂等，避免重复重建 DOM）
    extra.display_text = 纯正文;
    count += 1;
    try {
      const ctx = 获取上下文();
      if (typeof ctx?.updateMessageBlock === 'function') {
        ctx.updateMessageBlock(messageId, 消息);
      } else if (typeof (SillyTavern as any)?.updateMessageBlock === 'function') {
        (SillyTavern as any).updateMessageBlock(messageId, 消息);
      }
    } catch {
      // DOM 重建失败不阻塞数据层（display_text 已还原，下次事件仍会收敛）
    }
    // 触发重扫描：酒馆助手据此重新扫描该楼，摘除模板 iframe（更新块/模板围栏已不在正文）
    触发重扫描(messageId);
  }
  if (count > 0) {
    调度保存(); // 持久化还原后的 display_text（防抖，ST saveChat 落盘）
    渲染状态.value = `渲染开关已关闭：已还原 ${count} 条消息为纯正文`;
    记录日志('模板渲染', `渲染开关关闭：已还原 ${count} 条消息为纯正文`);
  } else {
    渲染状态.value = '渲染开关已关闭：当前无可清理的模板渲染';
  }
  return count;
}

/* ---------- chatLoaded 全量收敛 ---------- */

/**
 * 打开已有聊天：逐条收敛。已持久化 display_text（rph_template_render + 哈希匹配）且 ST 已
 * 按它渲染（酒馆助手同事件扫描已 iframe 化）→ 跳过；display_text 被 rp-hub-compat 覆写或
 * 缺失 → 重新渲染。最后统一重新断言 DOM（聊天打开时 rp-hub-compat 的 CHAT_LOADED 自动覆盖
 * 可能把模板 DOM 换回引擎输出 —— 无 TH-render 时重建模板围栏 + 触发重扫描收敛）。
 * 每 20 条让出一帧，不阻塞聊天渲染。
 */
async function 全量收敛(): Promise<void> {
  if (!渲染开关已启用()) {
    // 开关关闭：不渲染模板，但需清理存量模板 display_text（ST 优先读 display_text，
    // 只阻止新渲染不够 —— 打开已有聊天时旧面板仍在）。
    清理存量渲染();
    return;
  }
  const chat = SillyTavern.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    渲染状态.value = '模板渲染：当前聊天为空，跳过';
    return;
  }
  await 拉取模板定义(); // 预热缓存（后端不可达时内部降级）
  let 处理数 = 0;
  let 跳过数 = 0;
  for (let messageId = 0; messageId < chat.length; messageId++) {
    const 消息 = chat[messageId];
    if (!消息 || 消息.is_system) {
      跳过数 += 1;
      continue;
    }
    const 结果 = 渲染单条(messageId, { 记日志: false });
    if (结果.渲染了) {
      处理数 += 1;
    } else {
      跳过数 += 1;
    }
    // 已持久化模板渲染的消息：DOM 可能被 rp-hub-compat 覆盖（打开已有聊天路径），统一重断言
    重新断言DOM(messageId);
    // 合作式让出主线程（长聊天逐条渲染不卡 UI）
    if ((messageId + 1) % 20 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  渲染状态.value = `模板渲染：已处理 ${处理数} 条，跳过 ${跳过数} 条`;
  记录日志('模板渲染', `聊天打开全量收敛：已处理 ${处理数} 条，跳过 ${跳过数} 条`);
}

/* ---------- 强制重渲染全部（TabDiagnose「强制重新渲染」按钮第三部侧，追加修复） ---------- */

/**
 * 第三部全量重渲染（TabDiagnose「强制重新渲染」按钮调用，方案 A 追加修复）。
 *
 * 背景：第二部 forceRerenderAll 只重算数据层（rph_display 脏→干净），对模板消息
 * （rph_template_render）让位 display_text/DOM（display.js:94 coverMessage 入口守卫 +
 * pure.js:174 commitDisplay 模板消息跳过），且不发射任何事件 → 第三部 渲染单条 不跑
 * → display_text 仍是旧内容 → 用户点「强制重新渲染」按钮界面无变化。
 *
 * 本函数补齐显示链（在 桥.forceRerenderAll() 之后调用）：
 *   1. 清空合并缓存（防御性：楼层池来源与第二部无关，但保证池哈希重算）；
 *   2. 预热模板定义缓存（后端 uiTemplates，避免逐条 渲染单条 打「模板定义未就绪」）；
 *   3. 逐条 渲染单条（强制：绕过「已渲染且未变」缓存跳过，保证点了按钮就真的重渲染）——
 *      模板消息：读 rph_display（第二部已重算干净）→ 干净渲染写
 *      display_text + 标记 + updateMessageBlock；若第二部重算后仍脏（如当前预设也坏），
 *      渲染单条 的脏检测会拦截 → 异步引擎重算（计数累计，达 重算次数上限 后跳过）；
 *      非模板消息：H-A 判别跳过（保持现状，第二部已按其 rph_display 覆盖 DOM）；
 *   4. 每条成功渲染的消息 触发重扫描（emit CHARACTER_MESSAGE_RENDERED，让酒馆助手
 *      补建 iframe —— 提交渲染 不发射 RENDERED，不加则显示链仍缺 iframe）；
 *   5. 每 20 条让出一帧（长聊天不卡 UI）。
 *
 * @returns { count: 第三部成功渲染条数, skipped: 跳过条数 }
 */
export async function 强制重渲染全部(): Promise<{ count: number; skipped: number }> {
  if (!渲染开关已启用()) {
    渲染状态.value = '模板渲染：渲染总开关关闭，跳过';
    return { count: 0, skipped: 0 };
  }
  const chat = SillyTavern.chat;
  if (!Array.isArray(chat) || chat.length === 0) {
    渲染状态.value = '模板渲染：当前聊天为空，跳过';
    return { count: 0, skipped: 0 };
  }
  清空合并缓存();
  await 拉取模板定义(); // 预热缓存（后端不可达时内部降级）
  let count = 0;
  let skipped = 0;
  for (let messageId = 0; messageId < chat.length; messageId++) {
    const 消息 = chat[messageId];
    if (!消息 || 消息.is_system) {
      skipped += 1;
      continue;
    }
    const 结果 = 渲染单条(messageId, { 记日志: false, 强制: true });
    if (结果.渲染了) {
      count += 1;
      // 触发 TH 补建 iframe（渲染单条 只写数据 + updateMessageBlock，不发射 RENDERED）
      触发重扫描(messageId);
    } else {
      skipped += 1;
    }
    // 合作式让出主线程（长聊天逐条渲染不卡 UI）
    if ((messageId + 1) % 20 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  渲染状态.value = `模板渲染：强制重渲染 ${count} 条，跳过 ${skipped} 条`;
  记录日志('模板渲染', `强制重渲染：已处理 ${count} 条，跳过 ${skipped} 条`);
  return { count, skipped };
}

/* ---------- 启动 ---------- */

/** 安全注册事件：优先 eventMakeFirst（先于 rp-hub-compat / 酒馆助手 iframe store 处理），降级 eventOn */
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
    // 事件 API 完全不可用时静默降级：界面仍可用，渲染不生效
  }
}

/**
 * 启动模板渲染服务（index.ts 挂载时调用）：
 *   触发面对齐酒馆助手 iframe store（message.ts:120-136）+ chatLoaded；
 *   CHAT_CHANGED → 清模板定义缓存（换卡后重新拉取）。
 * eventOn 在脚本 iframe 关闭时由环境自动卸载。
 */
export function 启动模板渲染服务(): void {
  if (tavern_events?.CHARACTER_MESSAGE_RENDERED) {
    注册最先(tavern_events.CHARACTER_MESSAGE_RENDERED, message_id => 处理事件(message_id));
  }
  if (tavern_events?.USER_MESSAGE_RENDERED) {
    注册最先(tavern_events.USER_MESSAGE_RENDERED, message_id => 处理事件(message_id));
  }
  // C1：swipe 切换会改该楼层 variables[swipe_id] 池 → 合并缓存失效（清）；
  // 编辑保存 / 消息更新同样可能改楼层池 → 清；RENDERED 类纯显示事件不清。
  if (tavern_events?.MESSAGE_SWIPED) {
    注册最先(tavern_events.MESSAGE_SWIPED, message_id => 处理事件(message_id, true));
  }
  if (tavern_events?.MESSAGE_UPDATED) {
    注册最先(tavern_events.MESSAGE_UPDATED, message_id => 处理事件(message_id, true));
  }
  if (tavern_events?.MESSAGE_EDITED) {
    // IN1 修复：MESSAGE_EDITED 改 eventOn（尾插）——让 变量单向同步 的 makeFirst「剥离更新块 + 写池」
    // 先于本渲染执行。此前两者都用 makeFirst，后注册的本模块插到最前 → 编辑保存时先渲染读旧池、
    // 正文可能读到未剥离的更新块。RENDERED/SWIPED/UPDATED 仍保持 makeFirst（先于第二部/酒馆助手）。
    try {
      (eventOn as (事件: unknown, 处理器: (message_id: number) => void) => { stop: () => void })(
        tavern_events.MESSAGE_EDITED,
        message_id => 处理事件(message_id, true),
      );
    } catch {
      // 忽略
    }
  }
  // 消息删除 / 加载更早历史会移动后续楼层序号 → 索引键合并缓存失效。
  // 严格说所有渲染入口（处理事件先清缓存 / chatLoaded 前必有 CHAT_CHANGED 清缓存）都会在
  // 下一次读取前清掉，这里属防御性兜底（防止未来新增直接读缓存的路径时读到陈旧索引）。
  try {
    (eventOn as (事件: unknown, 处理器: () => void) => { stop: () => void })(tavern_events.MESSAGE_DELETED, () => {
      清空合并缓存();
    });
  } catch {
    // 忽略
  }
  try {
    (eventOn as (事件: unknown, 处理器: () => void) => { stop: () => void })(tavern_events.MORE_MESSAGES_LOADED, () => {
      清空合并缓存();
    });
  } catch {
    // 忽略
  }
  // chatLoaded：打开已有聊天 → 全量收敛（已持久化且未变的消息跳过）
  try {
    (eventMakeFirst as (事件: string, 处理器: () => void) => { stop: () => void })('chatLoaded', () => void 全量收敛());
  } catch {
    try {
      (eventOn as (事件: string, 处理器: () => void) => { stop: () => void })('chatLoaded', () => void 全量收敛());
    } catch {
      // 忽略
    }
  }
  // 切卡/换聊天 → 清模板定义缓存 + 清合并缓存
  try {
    (eventOn as (事件: unknown, 处理器: () => void) => { stop: () => void })(tavern_events.CHAT_CHANGED, () => {
      清空模板定义缓存();
      清空合并缓存();
      渲染状态.value = '等待渲染事件…';
      渲染错误.value = '';
    });
  } catch {
    // 忽略
  }

  // 挂载时预热当前卡模板定义（当前聊天已打开时，首次 RENDERED 可直接同步渲染）
  void 拉取模板定义();

  // 挂载时若开关已关闭（如刷新后恢复旧状态 / 扩展重载），立即清理存量模板渲染，
  // 避免已持久化的 display_text（模板围栏）在关闭状态下继续显示。
  try {
    if (!渲染开关已启用()) {
      清理存量渲染();
    }
  } catch {
    // 忽略（清理失败不影响其余服务）
  }

  // 事件执行顺序（ST-Prompt-Template 渲染冲突兼容）：刷新后按 localStorage 锚点自动应用
  // （本插件监听者重排到锚点来源之后）。幂等：锚点空 / 找不到本插件 / 找不到锚点 / 已在
  // 目标位 → 内部跳过，无副作用。
  try {
    const 锚点 = 读取事件顺序锚点();
    if (锚点) {
      const 结果 = 应用事件顺序(锚点);
      console.info(`[第三部] 事件执行顺序自动应用：${结果.reason}`);
    }
  } catch {
    // 事件顺序模块不可用忽略（不影响模板渲染）
  }

  // 浏览器控制台诊断入口（调试期保留）：
  //   await __thp模板渲染__.拉取模板定义(); __thp模板渲染__.渲染单条(<messageId>); __thp模板渲染__.渲染状态.value
  //   __thp模板渲染__.清理存量渲染()   手动还原存量模板为纯正文
  try {
    (window as unknown as Record<string, unknown>).__thp模板渲染__ = {
      渲染单条,
      拉取模板定义,
      清空模板定义缓存,
      渲染开关已启用,
      设置渲染开关,
      清理存量渲染,
      脚本清理已启用,
      设置脚本清理开关,
      读取已渲染正文模式,
      设置已渲染正文模式,
      重置已渲染正文模式,
      检测已渲染正文,
      默认已渲染正文模式,
      全量收敛,
      渲染状态,
      渲染错误,
      模板定义就绪,
    };
  } catch {
    // 极少数环境不允许扩展 window，忽略
  }

  console.info('[第三部] 模板渲染服务已启动：楼层 rp_hub → 复刻模板引擎 → display_text 围栏 → 酒馆助手 iframe');
}
