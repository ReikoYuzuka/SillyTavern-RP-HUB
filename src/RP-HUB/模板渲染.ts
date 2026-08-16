/**
 * 模板渲染 —— 复刻 RP-Hub 原版模板引擎（方案A 渲染器核心，纯函数，无副作用）。
 *
 * 对齐基准：RP-Hub `assets/js/data-services.js:1308-1453`
 *   splitUiTemplatePath     1308-1313  点路径归一（a.b.c / a[0].b / a['x'].b）
 *   readUiTemplatePath      1315-1324  根路径点取（含顶层直查）
 *   getUiTemplateValue      1326-1359  表达式求值：this/.、@index/@number/@first/@last/@key、
 *                                      root.x、../父上下文回退、#each as 显式别名、局部值回退
 *   stringifyUiTemplateValue 1385-1396 值 → 字符串（对象 JSON 缩进 2）
 *   escapeUiValue           1398-1403  & < > " ' 五字符 HTML 转义
 *   createUiTemplateRenderContext 1405-1414 渲染上下文
 *   renderUiTemplateString  1416-1424  先 #each 展开再 {{表达式}} 全局替换（跳过 else/#开头//开头）
 *   renderUiTemplateEachBlocks 1426-1453 #each 循环（数组按 index / 对象按 entries，最多 50 轮，
 *                                        空数组 → {{else}} 分支）
 *   stripUiTemplateCodeFence 1249-1253 剥 ```html 代码围栏
 *
 * 补丁（对齐 变量渲染-验证与决策.md §2.1）：
 *   P1 @别名.field：`#each` 未声明 as 别名时，`@name[.path]` 中的 name 按「当前项」解析
 *      （不死斩 t7 义体模板 `{{#each cyberware_items}}` + `{{@item.*}}` 依赖此语法）；
 *      不破坏 @index/@number/@first/@last/@key 语义（优先匹配）。
 *   P2 {{user}} 宏：变量值字符串内 `{{\s*user\s*}}` 替换为注入的用户名
 *      （对齐 RP-Hub replaceUserNamePlaceholder，app.js:550-551）。
 *
 * 顶层编排辅助（服务与测试共用，纯函数）：
 *   确保html标记 / 围栏化 / 筛选可渲染模板 / 拼接显示文本
 *
 * 本模块不依赖 window / DOM / 酒馆助手接口，可在 Node 直接运行单测：
 *   node src/RP-HUB/模板渲染.test.ts
 */

/** 单模板变量池：{ [变量路径] → 值 }（嵌套对象，对齐 RP-Hub variableState） */
export type 模板变量表 = Record<string, unknown>;

/** 模板 id → 变量池（可为数组/$root 形） */
export type 模板池表 = Record<string, 模板变量表 | unknown[]>;

/** 深拷贝（普通 JSON 数据；数组/对象递归，原始值直返） */
export function 深拷贝(值: unknown): unknown {
  if (值 === null || typeof 值 !== 'object') return 值;
  if (Array.isArray(值)) return 值.map(item => 深拷贝(item));
  const 输出: Record<string, unknown> = {};
  for (const [键, 子] of Object.entries(值 as Record<string, unknown>)) {
    输出[键] = 深拷贝(子);
  }
  return 输出;
}

/** 对象级深合并（来源覆盖目标同键、保留其他键；嵌套对象递归；非对象值来源覆盖） */
function 深合并对象(目标: Record<string, unknown>, 来源: Record<string, unknown>): Record<string, unknown> {
  const 结果: Record<string, unknown> = { ...目标 };
  for (const [键, 值] of Object.entries(来源)) {
    const 目标值 = 结果[键];
    if (
      目标值 !== null && typeof 目标值 === 'object' && !Array.isArray(目标值) &&
      值 !== null && typeof 值 === 'object' && !Array.isArray(值)
    ) {
      结果[键] = 深合并对象(目标值 as Record<string, unknown>, 值 as Record<string, unknown>);
    } else {
      结果[键] = 深拷贝(值);
    }
  }
  return 结果;
}

/**
 * 深合并楼层池（全兼容：对齐原版「状态跨楼层携带、每层渲染全部 active 模板」，
 * 见 合并楼层池-影响检测.md）。目标 = 已合并 0..k-1 层的池；来源 = 第 k 层池。
 * - 对象池：深合并（后楼层覆盖同键、保留其他键，嵌套对象递归）
 * - 数组 / $root 形：整池替换（对齐 RP-Hub setUiTemplateValue $root 语义，更新块转换.ts:70-72）
 * @param 目标 累计合并池（可为 {}）
 * @param 来源 当前楼层池
 * @returns 新合并池（不修改入参）
 */
export function 深合并池(目标: 模板池表, 来源: 模板池表): 模板池表 {
  const 结果: 模板池表 = { ...目标 };
  for (const [模板id, 池] of Object.entries(来源)) {
    const 目标池 = 结果[模板id];
    if (
      目标池 !== undefined && 目标池 !== null && typeof 目标池 === 'object' && !Array.isArray(目标池) &&
      池 !== null && typeof 池 === 'object' && !Array.isArray(池) &&
      !('$root' in (池 as Record<string, unknown>))
    ) {
      结果[模板id] = 深合并对象(目标池 as Record<string, unknown>, 池 as Record<string, unknown>);
    } else {
      结果[模板id] = 深拷贝(池) as 模板变量表 | unknown[];
    }
  }
  return 结果;
}

/**
 * 渲染侧回退兜底（改法4，空池粘住修复）：合并楼层池中【内层为空/缺失】的模板，
 * 回退用卡面模板定义 initialVariableState（优先）或 variableState 深合并补上。
 *
 * 语义对齐原版 loadGlobalUiTemplateRuntimeForCharacter 回退链（app.js:2494-2507：
 * runtime → legacy → initialVariableState → {}）的「池空回退卡面初始变量」段；
 * 载体保持酒馆助手方式（不改内存池 / 不引入 runtimeByCharacter 持久化）。
 *
 * 三个「不」：
 *   - 不写回 chat[i].variables（纯渲染视图回退，幂等；写数据只走 写楼层变量 TH 通道）；
 *   - 不引入 runtimeByCharacter（不做跨角色/分支持久化）；
 *   - 不污染合并缓存 —— 返回新对象（浅拷顶层 + 只对空内层覆盖深拷贝），后续楼层
 *     更新块的键照常覆盖（深合并池 后楼覆盖前楼语义不受影响）。
 *
 * 已启用（enabled !== false）且「池条目缺失或内层空对象」的模板才回退；数组形
 * （$root）视为有内容不回退；无初始状态的模板保留现状（缺失或空）。
 * 幂等纯函数，可 Node 单测。
 *
 * @param 池表   合并楼层池 { [templateId]: 变量池 }
 * @param 模板列表 卡面 uiTemplates 定义（后端 variables.uiTemplates）
 * @returns 回退后的新池表（不修改入参）
 */
export function 回退卡面初始状态(
  池表: Record<string, unknown> | null | undefined,
  模板列表: 模板定义[] | null | undefined,
): 模板池表 {
  const 池 = 池表 && typeof 池表 === 'object' ? 池表 : {};
  const 列表 = Array.isArray(模板列表) ? 模板列表 : [];
  const 结果 = { ...池 } as 模板池表;
  for (const 模板 of 列表) {
    if (!模板 || typeof 模板 !== 'object') continue;
    if (模板.enabled === false) continue; // 已禁用模板不回退
    const id = 模板.id;
    if (typeof id !== 'string' || !id.trim()) continue;
    const 现有 = 结果[id];
    // 有内容判定：内层对象有 ≥1 键（数组形 / 非空对象）→ 保留；缺失 / 空对象 → 回退
    const 有内容 = 现有 !== null && typeof 现有 === 'object'
      && Object.keys(现有 as Record<string, unknown>).length > 0;
    if (有内容) continue;
    // 取卡面初始状态：initialVariableState 优先，空/缺回退 variableState（对齐
    // inferInitialUiTemplateState 优先级链，data-services.js:1255-1272）
    let 初始: unknown = null;
    const ivs = 模板.initialVariableState;
    if (ivs && typeof ivs === 'object' && !Array.isArray(ivs)) 初始 = ivs;
    else {
      const vs = 模板.variableState;
      if (vs && typeof vs === 'object' && !Array.isArray(vs)) 初始 = vs;
    }
    if (初始 && typeof 初始 === 'object') {
      结果[id] = 深拷贝(初始) as 模板变量表;
    }
  }
  return 结果;
}

/** 渲染选项 */
export interface 渲染选项 {
  /** 当前用户名：替换变量值内 {{user}} 宏；缺省不替换 */
  用户名?: string;
  /** P1 @别名.field 补丁开关（缺省 true）；false = 严格复刻原版（t7 渲染为空） */
  启用别名补丁?: boolean;
  /** #each 展开最大轮数（缺省 50，对齐原版） */
  深度上限?: number;
}

/** #each 渲染循环上下文（对齐 createUiTemplateRenderContext） */
export interface 渲染上下文 {
  root: unknown;
  current: unknown;
  parentContext: 渲染上下文 | null;
  index: number;
  key: string;
  length: number;
  alias: string;
}

/* ---------- 路径解析 ---------- */

/** 点路径归一：`a[0].b` / `a['x']` / `a["x"]` → `a.0.b` / `a.x.b`（对齐 splitUiTemplatePath） */
export function 拆分路径(路径: string): string[] {
  return String(路径 || '')
    .trim()
    .replace(/\[(?:'([^']+)'|"([^"]+)"|([^\]]+))\]/g, (_, 单引号, 双引号, 裸值) => `.${单引号 ?? 双引号 ?? String(裸值 || '').trim()}`)
    .split('.')
    .map(段 => 段.trim())
    .filter(Boolean);
}

/** 按点路径在普通对象上取值（对齐 readUiTemplatePath） */
export function 按路径读取(源: unknown, 路径: string): unknown {
  const 规范化 = String(路径 || '').trim();
  if (!规范化 || 规范化 === 'this' || 规范化 === '.') return 源;
  if (源 !== null && typeof 源 === 'object' && Object.prototype.hasOwnProperty.call(源, 规范化)) {
    return (源 as Record<string, unknown>)[规范化];
  }
  return 拆分路径(规范化).reduce<unknown>(
    (当前, 键) => (当前 !== undefined && 当前 !== null && (当前 as Record<string, unknown>)[键] !== undefined
      ? (当前 as Record<string, unknown>)[键]
      : undefined),
    源,
  );
}

/* ---------- 表达式求值 ---------- */

/** @index/@number/@first/@last/@key 保留表达式集合（补丁 P1 不得破坏这些语义） */
const 保留循环表达式 = new Set(['@index', '@number', '@first', '@last', '@key']);

/**
 * 模板表达式求值（对齐 getUiTemplateValue + 补丁 P1）。
 * 补丁 P1：无 as 别名时，`@name[.path]` 中 name 按当前项解析（@name → current，@name.path → current.path）。
 * @param 源   根变量表
 * @param 路径 表达式（如 `a.b`、`@index`、`root.x`、`../y`、`item.z`、`@item.field`）
 * @param 上下文 循环上下文（可空）
 * @param 选项 渲染选项（P1 开关）
 */
export function 求模板值(源: unknown, 路径: string, 上下文: 渲染上下文 | null = null, 选项: 渲染选项 = {}): unknown {
  const 表达式 = String(路径 || '').trim();
  if (!表达式) return undefined;
  if (上下文) {
    if (表达式 === 'this' || 表达式 === '.') return 上下文.current;
    if (表达式 === '@index') return 上下文.index ?? 0;
    if (表达式 === '@number') return (上下文.index ?? 0) + 1;
    if (表达式 === '@first') return (上下文.index ?? 0) === 0;
    if (表达式 === '@last') return (上下文.index ?? 0) === (上下文.length ?? 0) - 1;
    if (表达式 === '@key') return 上下文.key ?? 上下文.index ?? '';
    if (表达式.startsWith('root.')) return 按路径读取(上下文.root, 表达式.slice(5));
    if (表达式 === 'root') return 上下文.root;
    if (表达式.startsWith('../')) {
      let 父上下文 = 上下文.parentContext;
      let 父路径 = 表达式;
      while (父路径.startsWith('../')) {
        父路径 = 父路径.slice(3);
        if (父路径.startsWith('../') && 父上下文?.parentContext) {
          父上下文 = 父上下文.parentContext;
        }
      }
      const 兜底父 = { root: 上下文.root, current: 上下文.root, parentContext: null, index: 0, key: '', length: 1, alias: '' };
      return 求模板值(上下文.root, 父路径, 父上下文 || 兜底父, 选项);
    }
    if (上下文.alias && (表达式 === 上下文.alias || 表达式.startsWith(`${上下文.alias}.`))) {
      return 表达式 === 上下文.alias
        ? 上下文.current
        : 按路径读取(上下文.current, 表达式.slice(上下文.alias.length + 1));
    }
    // 补丁 P1：无 as 别名时 @name[.path] 按当前项解析（不破坏 @index/@number/@first/@last/@key）
    if (选项.启用别名补丁 !== false && !上下文.alias && !保留循环表达式.has(表达式)) {
      const 补丁匹配 = 表达式.match(/^@([A-Za-z_$][\w$]*)(?:\.(.*))?$/);
      if (补丁匹配) {
        return 补丁匹配[2] === undefined || 补丁匹配[2] === ''
          ? 上下文.current
          : 按路径读取(上下文.current, 补丁匹配[2]);
      }
    }
    const 局部值 = 按路径读取(上下文.current, 表达式);
    if (局部值 !== undefined) return 局部值;
  }
  return 按路径读取(源, 表达式);
}

/* ---------- 字符串化与转义 ---------- */

/** 值 → 字符串（对象 JSON 缩进 2，null/undefined → 空串；对齐 stringifyUiTemplateValue） */
export function 字符串化值(值: unknown): string {
  if (值 === undefined || 值 === null) return '';
  if (typeof 值 === 'string') return 值;
  if (typeof 值 === 'object') {
    try {
      return JSON.stringify(值, null, 2);
    } catch {
      return String(值);
    }
  }
  return String(值);
}

/** {{user}} 宏替换（对齐 RP-Hub replaceUserNamePlaceholder：`{{\s*user\s*}}` 大小写不敏感） */
export function 替换用户宏(文本: unknown, 用户名?: string): string {
  const 值 = 字符串化值(文本);
  if (!用户名 || !值) return 值;
  return 值.replace(/\{\{\s*user\s*\}\}/gi, () => String(用户名 || '').trim());
}

/** HTML 转义（对齐 escapeUiValue：& < > " ' 五字符） */
export function 转义模板值(值: unknown, 用户名?: string): string {
  return 替换用户宏(值, 用户名)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- 渲染上下文 ---------- */

/** 构建渲染上下文（对齐 createUiTemplateRenderContext） */
export function 构建渲染上下文(变量: unknown, 覆盖: Partial<渲染上下文> = {}): 渲染上下文 {
  return {
    root: 变量,
    current: 变量,
    parentContext: null,
    index: 0,
    key: '',
    length: 1,
    alias: '',
    ...覆盖,
  };
}

/* ---------- #each 展开 ---------- */

/** #each 块匹配（对齐 renderUiTemplateEachBlocks 的 eachBlockPattern） */
const each块匹配 = /\{\{\s*#each\s+([^\s}]+)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\}((?:(?!\{\{\s*#each\b)[\s\S])*?)\{\{\s*\/each\s*\}\}/g;

/**
 * #each 循环展开（对齐 renderUiTemplateEachBlocks）：
 *   数组按 index 迭代，对象按 Object.entries 迭代；子上下文带 current/index/key/length/alias/parentContext；
 *   空数组/空对象/非容器 → {{else}} 分支（无 else 则空）；最多 深度上限（默认 50）轮。
 */
export function 渲染each块(模板文本: string, 变量: unknown, 上下文: 渲染上下文 | null = null, 选项: 渲染选项 = {}): string {
  let 输出 = String(模板文本 || '');
  const 深度上限 = typeof 选项.深度上限 === 'number' && 选项.深度上限 > 0 ? 选项.深度上限 : 50;
  for (let 轮 = 0; 轮 < 深度上限; 轮++) {
    let 有替换 = false;
    输出 = 输出.replace(each块匹配, (_匹配, 路径, 别名, 主体) => {
      有替换 = true;
      const 值 = 求模板值(变量, 路径, 上下文, 选项);
      const [条目模板, 空模板 = ''] = String(主体 || '').split(/\{\{\s*else\s*\}\}/i);
      const 条目列表 = Array.isArray(值)
        ? 值.map((条目, index) => ({ 条目, key: index, index }))
        : (值 !== null && typeof 值 === 'object'
            ? Object.entries(值 as Record<string, unknown>).map(([键, 条目], index) => ({ 条目, key: 键, index }))
            : []);
      if (!条目列表.length) return 渲染模板字符串(空模板, 变量, { ...选项, 当前上下文: 上下文 });
      return 条目列表.map(({ 条目, key, index }) =>
        渲染模板字符串(条目模板, 变量, {
          ...选项,
          当前上下文: 构建渲染上下文(变量, {
            current: 条目,
            parentContext: 上下文,
            index,
            key: String(key),
            length: 条目列表.length,
            alias: 别名 || '',
          }),
        }),
      ).join('');
    });
    if (!有替换) break;
  }
  return 输出;
}

/* ---------- 模板字符串渲染 ---------- */

/** 渲染选项（含内部循环上下文覆盖） */
export interface 渲染字符串选项 extends 渲染选项 {
  /** 内部：当前渲染上下文（#each 子项递归用） */
  当前上下文?: 渲染上下文 | null;
}

/**
 * 渲染模板字符串（对齐 renderUiTemplateString）：
 *   1. 先 #each 展开；
 *   2. 再对剩余 `{{ 表达式 }}` 全局替换：求值 → HTML 转义（含 {{user}} 宏）后内插。
 *   跳过 `{{else}}`、`{{#...}}`、`{{/...}}`（保留原样）。
 * @param 模板文本 模板字符串（含 {{变量}} 占位与 {{#each}} 块）
 * @param 变量   变量表（根）
 * @param 选项   渲染选项（用户名 / @别名补丁 / 深度上限 / 当前上下文）
 */
export function 渲染模板字符串(模板文本: string, 变量: unknown, 选项: 渲染字符串选项 = {}): string {
  const 活动上下文 = 选项.当前上下文 ?? 构建渲染上下文(变量);
  const 展开后 = 渲染each块(String(模板文本 || ''), 变量, 活动上下文, 选项);
  return 展开后.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (匹配, 表达式) => {
    const 键 = String(表达式 || '').trim();
    if (!键 || 键 === 'else' || 键.startsWith('#') || 键.startsWith('/')) return 匹配;
    const 值 = 求模板值(变量, 键, 活动上下文, 选项);
    // 兜底（fate353 误显示修复，第三部渲染层）：display 控制变量（表达式以 _display 结尾）
    // 缺失/空 → 渲染为 'none'（模板默认隐藏，对齐原版「display:{{xxx_display}} 初始 none」；
    // 否则 CSS `display:;` 空值无效 → 浏览器回退 block → 不该显示的面板显示出来）。
    if ((值 === undefined || 值 === null || 值 === '') && /_display$/i.test(键)) {
      return 'none';
    }
    return 转义模板值(值, 选项.用户名);
  });
}

/* ---------- 代码围栏剥离 ---------- */

/** 剥 ```html 代码围栏（对齐 stripUiTemplateCodeFence） */
export function 剥离代码围栏(文本: unknown): string {
  const 规范化 = String(文本 || '').trim();
  const 围栏匹配 = 规范化.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\s*```$/);
  return (围栏匹配 ? 围栏匹配[1] : 规范化).trim();
}

/* ---------- 顶层编排辅助（服务与测试共用） ---------- */

/** isFrontend 命中所需标记（对齐酒馆助手 is_frontend.ts：`html>` / `<head>` / `<body`，`<head>` 带闭合尖括号） */
const 前端标记 = ['html>', '<head>', '<body'];

/**
 * 模板段是否含可命中酒馆助手 isFrontend 的标记。
 * ⚠️ 必须与 TH is_frontend.ts 逐字一致（`<head>` 带 `>`）：宽松的 `<head` 会误命中
 * `<header>` 等标签 → 误判"已含标记"不补骨架 → 围栏段以 `<style>` 开头 → TH 不 iframe
 * → 模板界面显示为巨大代码块（不死斩 timehud 实测）。修复：与 TH 对齐。
 */
export function 含html标记(html: string): boolean {
  return 前端标记.some(标记 => String(html || '').includes(标记));
}

/**
 * 确保最终 HTML 可命中酒馆助手 isFrontend：不含 `html>` / `<head>` / `<body` 时前置
 * `<!DOCTYPE html>`（该串含 `html>` 子串）。方案A 渲染器兜底（变量渲染-验证与决策.md §2.6）。
 * ⚠️ 判定与 TH is_frontend.ts 逐字一致（含html标记），`<header>` 等不会误命中。
 *
 * 骨架补齐（状态栏点不动修复，方案A）：以 `<body` 开头、且不含 `<html`/`<head` 的模板段
 * （真实世界模拟器V2.1 状态栏 fence1：`<body data-r18=...>`）→ 补 `<html><head></head>` 骨架。
 *   背景：TH createSrcContent（iframe.ts:81-103）把围栏内容包进
 *   `<html><head>…</head><body>${content}</body></html>`，模板段若以 `<body` 开头会形成
 *   嵌套 `<body>`（内层 body 的 data-r18 等属性丢失、结构异常）；且 注入模板兼容层 的
 *   `<head\b>` 正则需要真实 `<head>` 落点（方案B）。对齐原版 buildExecutableHtmlDocument
 *   （data-services.js:1552-1563）对非完整文档统一包 `<html><head>…</head><body>` 骨架。
 *   幂等：已含 `<html`/`<head` 的完整文档 / 纯片段（不以 `<body` 开头）均不受影响。
 */
export function 确保html标记(html: string): string {
  const 内容 = String(html || '');
  // 方案A：以 <body 开头且无 <html / <head 骨架 → 前置 <!DOCTYPE html><html><head></head>
  if (/^\s*<body\b/i.test(内容) && !/<html\b/i.test(内容) && !/<head\b/i.test(内容)) {
    return `<!DOCTYPE html>\n<html>\n<head></head>\n${内容}`;
  }
  if (含html标记(内容)) return 内容;
  return `<!DOCTYPE html>\n${内容}`;
}

/** 脚本块内实体 `&` 匹配：后跟 `[a-zA-Z]+;`（命名实体）或 `#\d+;`（十进制数字实体）才视为
 * 完整实体字面量；`&&`（后跟 &）、`& `（后跟空格）、`&T`（后跟非字母+;）等不命中。 */
const 脚本实体匹配 = /&(?=[a-zA-Z]+;|#\d+;)/g;

/**
 * 转义脚本内实体 Amp（实体解码破坏链修复，状态栏点不动真根因，纯函数可测）。
 *
 * 把 `<script>...</script>` 块内「完整实体字面量」的 `&` 改写为 `\x26`（JS 十六进制转义）。
 *
 * 背景（TH iframe 转义链双重解码，1.txt 全链实测确诊）：模板脚本 JS 字符串内实体字面量
 * （真实世界模拟器V2.1 状态栏主脚本 esc 函数 `'&#39;'`）在 ST → TH 管道中被解码破坏：
 *   ST converter.makeHtml（script.js:1880，showdown encodeCode 把 code 块内 & → &amp;）
 *   → ST script.js:1889-1891（<code> 块内 &amp; → & 还原）
 *   → TH Iframe.vue:44 `$pre.find('code').text()`（jQuery 实体解码）
 * `'&#39;'` 经「& → &amp; → & → 实体解码」变成 3 个裸单引号 `'''` → JS 字符串被截断
 * → 状态栏主脚本 IIFE 语法错误 → 从未执行 → DCL 监听器从未注册（方案C 兜底 dispatch 白给）
 * → 按钮全无绑定。问卷 fence0 因不含实体字面量而不受影响。
 *
 * 修复：实体 `&` → `\x26`。`\x26` 不含裸 `&`，管道三层（encodeCode / `&amp;`→`&` 还原 /
 * `.text()` 解码）均不命中；JS 求值时 `\x26` 还原为 `&` → 字符串值保持实体字面量
 * （esc('&')='&amp;'、esc("'")='&#39;'、esc('<')='&lt;' 等不变）。
 *
 * 只动 `<script>` 块内；非 script 段（HTML 正文 `&amp;` 等）不动 —— 正文实体由浏览器
 * HTML 解析正常处理，不经 ST/TH 代码块管道，无此问题。
 *
 * 幂等：`\x26` 后不是 `&`（不命中前瞻），二次调用零改动。
 * ⚠️ 十六进制数字实体（`&#x27;` 等）不在此正则范围内 —— 卡片 esc 函数规范用十进制
 * （`&#39;`），当前真实世界模拟器V2.1 不涉及；如遇 `&#x..;` 形态需另行扩展。
 *
 * @param html 模板 HTML（可含多个 <script> 块）
 * @returns 脚本块内实体 & 转义为 \x26 的新 HTML（非脚本段原样）
 */
export function 转义脚本内实体Amp(html: string): string {
  const 内容 = String(html ?? '');
  if (!内容.includes('&')) return 内容; // 快速短路：无 & 无需处理
  脚本块匹配模式.lastIndex = 0;
  return 内容.replace(脚本块匹配模式, (块) => {
    const 开标签匹配 = 块.match(/^<script\b[^>]*>/);
    if (!开标签匹配) return 块; // 异常形态（无开标签）→ 原样
    const 主体 = 块.slice(开标签匹配[0].length, 块.length - '</script>'.length);
    const 转义后主体 = 主体.replace(脚本实体匹配, () => String.raw`\x26`);
    return 开标签匹配[0] + 转义后主体 + '</script>';
  });
}

/** 包 ```html 围栏（ST 转 <pre><code class="language-html"> → 酒馆助手 iframe 化）。
 * 模板段内 iframe 的 srcdoc 属性同样走 srcdoc双重转义（& 翻倍 + dvh→vh 兼容），
 * 否则 ST 管线打平后裸引号截断嵌套 srcdoc（与正文段同问题）。
 *
 * 处理顺序（状态栏点不动修复 方案A/B/C/v14）：
 *   1. srcdoc双重转义（dvh→vh + srcdoc & 翻倍）；
 *   2. 转义脚本内实体Amp（v14：<script> 块内实体 & → \x26，修复 ST/TH 双重解码破坏
 *      JS 字符串内实体字面量 → 主脚本语法错误 → 按钮点不动真根因）；
 *   3. 确保html标记：以 `<body` 开头的模板段补 `<html><head></head>` 骨架
 *      （消除 TH createSrcContent 包装后的嵌套 body）；
 *   4. 注入模板兼容层：reset + triggerSlash 桥注入真实 `<head>`（配合 `<head\b>` 正则，
 *      不再误匹配 `<header id="header">` 把桥塞进 header 内）。
 * 必须先补骨架再注入兼容层 —— 否则兼容层在无 `<head>` 时前置到内容开头，
 * 确保html标记 会看到以 `<style>` 开头而误判「非 <body 开头」跳过补骨架。 */
export function 围栏化(html: string): string {
  return `\n\n\`\`\`html\n${注入模板兼容层(确保html标记(转义脚本内实体Amp(srcdoc双重转义(html))))}\n\`\`\`\n\n`;
}

/**
 * 从 / 开头文本里提取命令名（`/` 后到首个空白/竖线/结束），小写；非 / 开头返回空串。
 * 与桥脚本内 `s.match(/^\/([^\s|]+)/)` 同一规则，修改时两边必须同步。
 */
export function 提取slash命令名(文本: string): string {
  const s = String(文本 ?? '').trim();
  if (s.charAt(0) !== '/') return '';
  const m = s.match(/^\/([^\s|]+)/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 判断 / 开头文本是否「已注册 slash 命令」（命令名在命令表里）。
 * 命令表 = ST SlashCommandParser.commands（`{ [name]: SlashCommand }`）。
 *   - 命令表缺省（拿不到，如 Node 单测）→ 保守 true（按命令处理，避免把真命令当纯文本发出）；
 *   - 命令名命中表 → true；未命中（如 /构筑命运完毕！… 纯文本）→ false → 走「发消息+生成」，
 *     拦截掉 ST 的 Unknown command 报错。
 * 与桥脚本内 isRegisteredSlash 同一规则，修改时两边必须同步。
 */
export function 是已注册slash命令(文本: string, 命令表?: Record<string, unknown> | null): boolean {
  const 名 = 提取slash命令名(文本);
  if (!名) return false;
  if (!命令表) return true; // 拿不到表 → 保守按命令处理
  return Object.prototype.hasOwnProperty.call(命令表, 名);
}

/**
 * triggerSlash 语义分发判定（H1 修复，纯函数；与桥脚本内 makeDispatcher 同一规则，
 * 修改时两边必须同步）：
 *   - 文本 trim 后以 `/` 开头 **且是已注册 slash 命令** → 'slash'（走 TH/ST 执行器，如 /send、/trigger）；
 *   - 其余（空串 / 纯文本 / 以 `/` 开头但非注册命令的纯文本）→ 'send'（走 RP-Hub 语义：发消息+生成）。
 * @param 命令表 ST SlashCommandParser.commands（缺省 = 保守按命令处理）
 */
export function 判断triggerSlash语义(文本: string, 命令表?: Record<string, unknown> | null): 'slash' | 'send' {
  const s = String(文本 ?? '').trim();
  if (s.length === 0 || s.charAt(0) !== '/') return 'send';
  return 是已注册slash命令(s, 命令表) ? 'slash' : 'send';
}

/**
 * 生成中判定（H1 防重入修复，纯函数；与桥脚本内 `isGeneratingNow` 的核心规则一致，
 * 修改时两边必须同步）。
 *
 * 两个信号源（均来自父窗口，ST 1.18.0）：
 *   - dataset 标志：`deactivateSendButtons` 设置 `document.body.dataset.generating='true'`
 *     （script.js:7026-7030），`activateSendButtons` 删除（script.js:7016-7021）——正常
 *     非 dryRun 生成的权威标志，所有 iframe 可同步读取；
 *   - 事件标志：`GENERATION_STARTED`（script.js:4240，Generate 入口必发）/ `GENERATION_ENDED`
 *     （script.js:3477，hideStopButton 内）——事件标志覆盖「GENERATION_STARTED 已发、
 *     deactivateSendButtons 尚未执行」的微任务窗口（此时 dataset 尚未设置）。
 *
 * 判定规则：dataset 标志 **或** 事件标志 为真 → 生成中。
 * ⚠️ 桥脚本内对该规则额外做了「陈旧自愈」：事件标志为真但 dataset 缺失且超过 300ms
 * （已过微任务窗口）→ 视为 GENERATION_ENDED 漏触发（ST 早退路径 stop button 未显示则
 * 不 emit ENDED，script.js:3474-3478），清事件标志返回 false —— 真实生成中 dataset
 * 必为 true（script.js:7029），因此自愈不会误判。
 *
 * @param dataset标志 父窗口 document.body.dataset.generating === 'true'
 * @param 事件标志     父窗口共享的事件标志（GENERATION_STARTED 置 true / ENDED 置 false）
 * @returns true = 生成中（不应再触发生成）
 */
export function 判定生成中(dataset标志: boolean, 事件标志: boolean): boolean {
  return dataset标志 === true || 事件标志 === true;
}

/**
 * 生成 triggerSlash 语义分发桥脚本（H1/M2 修复 + 第二轮 H1-new/H2-new 修复，纯函数可测；
 * 返回 JS 函数体，不含 <script> 标签）。
 *
 * 背景：RP-Hub 原版 `window.triggerSlash(text)` 语义 = 「把 text 当用户消息发出 + 触发生成」
 * （RP-Hub app.js:8423-8440：push {role:'user',content,isSelf:true,isTriggered:true} + generateResponse）。
 * 而 TH 注入 iframe 的 `triggerSlash`（predefine.js:12-18 把 TavernHelper 顶层 merge 进 iframe，
 * function/index.ts:420-421）是 **ST slash 命令执行器**（src/function/slash.ts:3-9，/send /trigger 等）。
 * ST 解析器对**不以 `/` 开头的文本整体丢弃**（SlashCommandParser.js:783-790 非命令分支
 * `while(!testCommandEnd()) this.take()`）→ FATE-353 类「纯文本 data-slash」按钮点击无动作。
 *
 * 本桥做四件事：
 *  1. **H1**：把 iframe 内 `window.triggerSlash` 包装成语义分发器——
 *     `/` 开头 → 转发原版（TH 版 = ST 执行器，/ 命令路径不受破坏）；否则 → `sendUserMessage`
 *     （发消息+生成，对齐 RP-Hub 语义）。TH predefine 已注入 triggerSlash 时，此处是
 *     「包装一层」而非「不装」——这是 H1 生效的关键（渲染部分共存审查 H1）。幂等标记
 *     `__rpTriggerSlashDispatch`。
 *  2. **M2**：挂 ST 主窗口全局 `window.parent.triggerSlash`（NC-MAP/公寓模板脚本直调
 *     `window.parent.triggerSlash(cmd)`）——typeof 守卫：parent 已有 triggerSlash 则不覆盖
 *     （ST 1.18.0 本身不挂此全局，script.js:292 仅 `globalThis.SillyTavern={libs,getContext}`）。
 *  3. **H1-new（第二轮）防重入**：`sendUserMessage` 入口用 `isGeneratingNow()`（父窗口
 *     `document.body.dataset.generating` + GENERATION_STARTED/ENDED 事件标志，见 判定生成中）
 *     判定生成中 → `toastr.warning('正在生成中，请稍后...')` 并 return（对齐 RP-Hub
 *     app.js:8426-8429 `isGenerating` 守卫语义）。
 *  4. **H2-new（第二轮）生成通道**：触发生成从 `ctx.generate('normal')` 改为 ST `/trigger`
 *     命令（`executeSlashCommandsWithOptions('/trigger')`，st-context.js:170 已暴露；回退
 *     `host.TavernHelper.triggerSlash('/trigger')`）。原因（渲染部分共存审查-第二轮 H2-new）：
 *     ST `Generate('normal')` 的 normal 分支会读 `#send_textarea` 并把非空内容当第二条用户
 *     消息发送（script.js:4340-4343 + 4375-4386）——直调 generate('normal') 会误发输入框
 *     内容；`/trigger`（slash-commands.js:4986-5020）先清空 `#send_textarea`（:4999）再
 *     `Generate('normal', { force_chid })`，且自带 waitUntilCondition 防重入（:4990，生成中
 *     等待、10s 超时 toastr 拒绝）——与我们的 isGeneratingNow 快速守卫互为冗余，杜绝并发生成。
 *
 * sendUserMessage 复刻 ST sendMessageAsUser 的核心步骤（script.js:5815-5864）：
 *   chat.push(message) → saveChatConditional → emit MESSAGE_SENT → addOneMessage →
 *   emit USER_MESSAGE_RENDERED → /trigger（触发生成）。
 *   ⚠️ 不选 `/send 文本|/trigger` 管道：ST 解析器非严格模式下把 `|` 当命令分隔（管道），
 *   自然语言文本含 `|`/引号/换行会截断；且 getContext **不暴露** sendMessageAsUser
 *   （st-context.js:114-306 无该键）→ 用 getContext 原语（chat/addOneMessage/saveChat/
 *   eventSource/eventTypes/executeSlashCommandsWithOptions）复刻。风险：不做
 *   getRegexedString/substituteParams/populateFileAttachment（RP-Hub 原版同样不做，保持
 *   语义对齐）；未 await saveChat/emit（内存消息已入 chat，addOneMessage 同步渲染，
 *   后续事件异步收敛）。
 */
export function 生成triggerSlash桥脚本(): string {
  return `(function () {
  var host = window.parent;

  // H1-new：生成中判定（与 TS 纯函数 判定生成中 同步，修改时两边必须一致）
  function isGeneratingNow() {
    var dg = false;
    try {
      // ST deactivateSendButtons 设置 document.body.dataset.generating='true'
      // （script.js:7026-7030），activateSendButtons 删除（script.js:7016-7021）
      dg = !!(host && host.document && host.document.body && host.document.body.dataset &&
        host.document.body.dataset.generating === 'true');
    } catch (e) { dg = false; }
    if (dg) return true;
    // 事件标志（GENERATION_STARTED 置 true / ENDED 置 false）覆盖「STARTED 已发、
    // deactivateSendButtons 未执行」的微任务窗口（此时 dataset 尚未设置）
    if (host && host.__rpGenerating === true) {
      // 陈旧自愈：真实生成中 dataset 必为 true；事件标志为真但 dataset 缺失且超过
      // 300ms → GENERATION_ENDED 漏触发（ST 早退路径 stop button 未显示则不 emit ENDED，
      // script.js:3474-3478），清标志防永久锁死
      var since = host.__rpGeneratingSince || 0;
      if (Date.now() - since > 300) {
        host.__rpGenerating = false;
      } else {
        return true;
      }
    }
    return false;
  }

  function toastGenerating() {
    try {
      var t = (host && host.toastr) || window.toastr;
      if (t && typeof t.warning === 'function') t.warning('正在生成中，请稍后...');
    } catch (e) {}
  }

  // H2-new：触发生成改用 ST /trigger 命令（slash-commands.js:4986-5020）。
  // 它会先清空 #send_textarea（:4999）再 Generate('normal')——输入框内容不会被误发；
  // 且自带 waitUntilCondition 防重入（:4990，生成中等待、10s 超时 toastr 拒绝）。
  function runGeneration() {
    var p = null;
    try {
      if (host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function') {
        var c = host.SillyTavern.getContext();
        // st-context.js:170 暴露 executeSlashCommandsWithOptions
        if (c && typeof c.executeSlashCommandsWithOptions === 'function') {
          p = c.executeSlashCommandsWithOptions('/trigger');
        }
      }
    } catch (e) {}
    if (p === null) {
      try {
        // TH 通道回退：TavernHelper.triggerSlash = executeSlashCommandsWithOptions
        // （src/function/slash.ts:3-9）
        if (host && host.TavernHelper && typeof host.TavernHelper.triggerSlash === 'function') {
          p = host.TavernHelper.triggerSlash('/trigger');
        }
      } catch (e) {}
    }
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }

  function sendUserMessage(text) {
    // H1-new：生成中防重入（对齐 RP-Hub app.js:8426-8429 isGenerating 守卫）
    if (isGeneratingNow()) { toastGenerating(); return false; }
    try {
      var ctx = host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function'
        ? host.SillyTavern.getContext() : null;
      if (!ctx || !ctx.chat || typeof ctx.chat.push !== 'function') return false;
      var msg = {
        name: ctx.name1 || '',
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: String(text),
        extra: {}
      };
      ctx.chat.push(msg);
      var id = ctx.chat.length - 1;
      if (typeof ctx.saveChat === 'function') { try { ctx.saveChat(); } catch (e) {} }
      var et = ctx.eventTypes || {};
      if (ctx.eventSource) { try { ctx.eventSource.emit(et.MESSAGE_SENT || 'message_sent', id); } catch (e) {} }
      if (typeof ctx.addOneMessage === 'function') { try { ctx.addOneMessage(msg); } catch (e) {} }
      if (ctx.eventSource) { try { ctx.eventSource.emit(et.USER_MESSAGE_RENDERED || 'user_message_rendered', id); } catch (e) {} }
      runGeneration();
      return true;
    } catch (e) { return false; }
  }

  // 探测 / 开头文本是否「已注册 slash 命令」：命令名（/ 后到首个空白/竖线/结束）在
  // 父窗口 SlashCommandParser.commands 表里 → 真命令；否则（如 /构筑命运完毕！…纯文本）→ 非法，
  // 走发消息+生成（RP-Hub 语义），避免 ST 解析器报 Unknown command。
  function isRegisteredSlash(s) {
    var m = s.match(/^\\/([^\\s|]+)/);
    if (!m) return false;
    var name = m[1].toLowerCase();
    try {
      var c = host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function'
        ? host.SillyTavern.getContext() : null;
      var table = c && c.SlashCommandParser ? c.SlashCommandParser.commands : null;
      if (!table) return true; // 拿不到命令表 → 保守按命令处理（避免把真命令当纯文本发出）
      return Object.prototype.hasOwnProperty.call(table, name);
    } catch (e) { return true; }
  }

  function makeDispatcher(original) {
    return function (text) {
      var s = String(text || '').trim();
      if (!s) return;
      if (s.charAt(0) === '/' && isRegisteredSlash(s)) {
        if (typeof original === 'function') return original(text);
        if (host && host.TavernHelper && typeof host.TavernHelper.triggerSlash === 'function') {
          return host.TavernHelper.triggerSlash(text);
        }
        return sendUserMessage(text);
      }
      return sendUserMessage(text);
    };
  }

  if (!window.__rpTriggerSlashDispatch) {
    window.__rpTriggerSlashDispatch = true;
    window.triggerSlash = makeDispatcher(typeof window.triggerSlash === 'function' ? window.triggerSlash : null);
    // H1-new：生成状态事件监听。eventSource/eventTypes 均为父窗口对象（st-context.js:137-138），
    // 所有 iframe 共享 host.__rpGenerating —— 任意 iframe 收到事件即更新全局标志，跨 iframe 一致。
    try {
      var ctx0 = host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function'
        ? host.SillyTavern.getContext() : null;
      if (ctx0 && ctx0.eventSource && ctx0.eventTypes) {
        var et0 = ctx0.eventTypes;
        var onGS = function () { try { host.__rpGenerating = true; host.__rpGeneratingSince = Date.now(); } catch (e) {} };
        var onGE = function () { try { host.__rpGenerating = false; } catch (e) {} };
        // GENERATION_STARTED：Generate 入口必发（script.js:4240）；GENERATION_ENDED：hideStopButton
        // 内（script.js:3477，stop button 曾显示才会 emit）
        ctx0.eventSource.on(et0.GENERATION_STARTED || 'generation_started', onGS);
        ctx0.eventSource.on(et0.GENERATION_ENDED || 'generation_ended', onGE);
      }
    } catch (e) {}
  }

  try {
    if (host && typeof host.triggerSlash !== 'function') {
      host.triggerSlash = makeDispatcher(null);
    }
  } catch (e) {}

  if (!window.__rpDataSlashDelegate) {
    window.__rpDataSlashDelegate = true;
    window.addEventListener('click', function (event) {
      var t = event.target && event.target.closest && event.target.closest('[data-slash]');
      if (t) {
        event.preventDefault();
        var c = t.getAttribute('data-slash');
        if (c && window.triggerSlash) window.triggerSlash(c);
      }
    });
  }

${生成DCL兜底脚本()}
})();`;
}

/**
 * 方案C：DOMContentLoaded 兜底脚本（纯函数可测，状态栏点不动修复）。
 *
 * 背景：TH srcdoc iframe 里 DOMContentLoaded 可能未触发/已错过。模板主脚本的 inits
 * （_t1~_t12 事件绑定）全依赖 DCL 回调（如真实世界模拟器V2.1 状态栏 fence1）；而 fence0
 * 问卷用顶层同步绑定不依赖 DCL → 问卷能点、状态栏不能。桥脚本在 <head> 内先于主脚本执行
 * → 在此注册 DCL 监听 + 轮询兜底重放，覆盖「DCL 已错过 / 主脚本注册晚于 DCL」两种时序。
 *
 * 幂等设计：
 *   - `__rpDCLGuard`：防重复注入（兼容层桥本身幂等）。
 *   - `__rpDCLFired`：DCL 正常触发置 true → 兜底零动作（对「DCL 正常的模板」无副作用）；
 *     兜底 dispatch 前置位 → 最多重放一次，杜绝 _t1~_t12 二次执行/事件重复绑定。
 *   - 轮询：300ms 间隔，readyState==='complete'（=DCL 必然已 fire）且未 dispatch 过 → 重放；
 *     覆盖「主脚本注册晚于 DCL」场景（body 末尾主脚本同步执行，轮询开始后它已注册）。
 *     达上限（~5s）或已 dispatch → 停轮询。
 *
 * @returns JS 函数体（不含 <script> 标签），供桥脚本尾部拼接
 */
export function 生成DCL兜底脚本(): string {
  return `  // ---- 方案C：DOMContentLoaded 兜底（与 TS 纯函数 生成DCL兜底脚本 同步）----
  if (!window.__rpDCLGuard) {
    window.__rpDCLGuard = true;
    window.__rpDCLFired = false;
    // 1. 正常 DCL 触发：置标志（主脚本 init 已跑，兜底无需动作）
    document.addEventListener('DOMContentLoaded', function () {
      window.__rpDCLFired = true;
    });
    // 2. 轮询兜底：DCL 已错过（readyState==='complete' 意味着 DCL 必然已 fire）且从未
    //    dispatch 过 → 重放一次。轮询保证「主脚本注册晚于 DCL」也被覆盖（主脚本在 body
    //    末尾同步执行，轮询开始时它已注册监听器）。最多重放一次（__rpDCLFired 前置置位）。
    function rpTryDispatchDCL() {
      try {
        if (!window.__rpDCLFired && document.readyState === 'complete') {
          window.__rpDCLFired = true; // 先置位防重复重放
          document.dispatchEvent(new Event('DOMContentLoaded'));
        }
      } catch (e) {}
    }
    var rpDclTries = 0;
    var rpDclTimer = setInterval(function () {
      rpTryDispatchDCL();
      rpDclTries++;
      // 已 dispatch 或已达上限（约 5s：300ms*~17 次）→ 停止轮询
      if (window.__rpDCLFired || rpDclTries > 17) clearInterval(rpDclTimer);
    }, 300);
  }`;
}

/**
 * 模板兼容层（问题 1/3 修复，第三部三问题-根因调查与修复方案.md + 渲染部分共存审查 H1/M2）：
 * 注入到最终进入酒馆助手 iframe 的完整 HTML 内，包含两部分：
 *
 * 1. reset 样式（问题 3：模板 `min-height:100vh` 占满整屏）：
 *    TH replaceVhInContent（iframe.ts:5-29）把 `min-height:100vh` 转成
 *    `var(--TH-viewport-height)`（= 父窗口整屏高）→ adjust_iframe_height.js 把
 *    iframe 高度撑到整屏 → 模板显示巨大。对齐原版 resetStyle（data-services.js:1460）
 *    强制 html/body/常见容器 class 的 height/min-height 归零。
 *
 * 2. triggerSlash 语义分发桥 + data-slash 点击委托（问题 1 狐策点不动 / H1 FATE-353
 *    纯文本按钮 / M2 parent.triggerSlash 直调）——见 生成triggerSlash桥脚本。
 *    幂等特征 __rpDataSlashDelegate（也作为本函数整体幂等标记）。
 *
 * @param html 最终围栏化的完整 HTML（已含 <!DOCTYPE html> 骨架 / <head>）
 */
export function 注入模板兼容层(html: string): string {
  const 内容 = String(html || '');
  // 幂等：已注入过兼容层（含 __rpDataSlashDelegate 桥脚本特征）→ 原样返回
  if (内容.includes('__rpDataSlashDelegate')) return 内容;
  const 兼容层 =
    `<style>
html,body{margin:0!important;padding:0!important;width:100%!important;height:auto!important;min-height:auto!important;word-wrap:break-word!important;box-sizing:border-box!important;overflow:hidden!important;}
.app-wrapper,.app-container,.container,.reality-panel,#app{height:auto!important;min-height:0!important;max-width:100%!important;width:100%!important;margin:0!important;border-radius:0!important;box-shadow:none!important;border:none!important;}
</style>
<script>
${生成triggerSlash桥脚本()}
<\/script>`;
  // 注入位置：优先 <head> 后，其次 <html...> 后（兼容代码块内容带语言标记行/无 head 的文档），
  // 再次开头的 <!doctype> 后，最后回退前置（骨架片段）。
  // ⚠️ 方案B：`<head\b>` 词边界 —— 不能用 `<head([^>]*)>`（会误匹配 `<header id="header">`
  // 把 reset/桥塞进 header 元素内部，状态栏点不动结构异常源之一；`\b` 保证只匹配真正的 `<head`）。
  const 头部匹配 = 内容.match(/<head\b[^>]*>/i);
  if (头部匹配) {
    const 索引 = 头部匹配.index! + 头部匹配[0].length;
    return 内容.slice(0, 索引) + 兼容层 + 内容.slice(索引);
  }
  const html标签 = 内容.match(/<html([^>]*)>/i);
  if (html标签) {
    const 索引 = html标签.index! + html标签[0].length;
    return 内容.slice(0, 索引) + 兼容层 + 内容.slice(索引);
  }
  const 文档声明 = 内容.match(/(\s*<!doctype html>\s*)/i);
  if (文档声明) {
    const 索引 = 文档声明.index! + 文档声明[0].length;
    return 内容.slice(0, 索引) + 兼容层 + 内容.slice(索引);
  }
  return 兼容层 + 内容;
}

/** 模板定义（对齐后端 variables.uiTemplates 数组条目，只取渲染所需字段） */
export interface 模板定义 {
  id?: unknown;
  htmlTemplate?: unknown;
  enabled?: unknown;
  order?: unknown;
  placement?: unknown;
  /** 卡面初始变量（改法4 渲染侧回退兜底读取；后端 uiTemplates 条目带此字段） */
  initialVariableState?: unknown;
  /** 卡面变量（改法4 回退次选；initialVariableState 缺失时用） */
  variableState?: unknown;
}

/** 可渲染模板（含渲染顺序号：top 段在前 / bottom 段在后，组内按 order 降序） */
export interface 可渲染模板 {
  定义: 模板定义;
  顺序号: number;
}

/**
 * 筛选可渲染模板：`enabled !== false`（对齐原版 activeUiTemplates，app.js:2107）且
 * 楼层池含该模板条目；返回按「top → bottom」分区、组内 `order` 降序（缺省 0，
 * 同 order 保持原数组顺序）的列表（对齐原版 app.js:2101-2106 排序 + 2280-2287 分区）。
 * @param 模板列表 后端 uiTemplates 数组
 * @param 池表   楼层 rp_hub 池 { [templateId]: 变量池 }
 */
export function 筛选可渲染模板(模板列表: 模板定义[] | null | undefined, 池表: Record<string, unknown> | null | undefined): 可渲染模板[] {
  const 列表 = Array.isArray(模板列表) ? 模板列表 : [];
  const 池 = 池表 && typeof 池表 === 'object' ? 池表 : {};
  const 结果: 可渲染模板[] = [];
  for (const 定义 of 列表) {
    if (!定义 || typeof 定义 !== 'object') continue;
    if (定义.enabled === false) continue; // enabled !== false（对齐原版）
    const id = 定义.id;
    if (typeof id !== 'string' || !id.trim()) continue;
    if (!Object.prototype.hasOwnProperty.call(池, id)) continue; // 楼层池必须有该模板条目
    结果.push({ 定义, 顺序号: 结果.length });
  }
  const order = (定义: 模板定义) => Number(定义.order) || 0;
  结果.sort((a, b) => {
    const 甲是top = a.定义.placement === 'top';
    const 乙是top = b.定义.placement === 'top';
    if (甲是top !== 乙是top) return 甲是top ? -1 : 1; // top 段在前，bottom 段在后
    return order(b.定义) - order(a.定义) || a.顺序号 - b.顺序号; // 组内 order 降序，稳定
  });
  return 结果;
}

/**
 * 拼接显示文本：`围栏化正文 + 围栏模板段`。
 * 模板段 = 各模板渲染结果按顺序拼接后确保 html 标记并包 ```html 围栏。
 * 正文段（引擎美化输出 rph_display）完整对齐第二部 fenceFullHtml 围栏化：
 *   完整文档段提取 + div 配平 + style/script/iframe 骨架 + 短路精确化
 *   （含 ``` 时检测完整文档代码块补空行）+ srcdoc 双重转义 —— 正文段可能含
 *   HTML 容器 div + 内部完整文档代码块（刚满十八/云隐瑶池梦）、裸 iframe/style
 *   （不死斩 CBB）、div + 完整文档拼接（与妹生活）等形态，统一走围栏化正文。
 * 无模板段（空列表）→ 原样返回正文（不围栏）。
 * @param 正文    消息正文（决策 D3：msg.extra.rph_display 引擎美化输出）
 * @param 模板渲染结果 各模板渲染后的 HTML 字符串（已按 筛选可渲染模板 顺序）
 * @param 注入兼容层 正文段围栏化时是否注入模板兼容层（reset 样式 + triggerSlash 桥 +
 *                   data-slash 委托，渲染部分双向兼容审查-第三轮 H-B）。
 *                   默认 true（狐策/表裏等 RP 美化完整文档在正文段，需要 reset/桥，
 *                   默认 false 会导致按钮点不动回归）；TH 作者原生围栏场景（若未来有
 *                   调用方需要不污染作者 iframe）传 false —— 本服务当前所有调用路径
 *                   经「RP 模板消息判别」（H-A）只处理模板消息，正文必为 RP 内容，
 *                   恒传 true。
 */
export function 拼接显示文本(正文: string, 模板渲染结果: string[], 注入兼容层 = true, 正文变换: (text: string) => string = (t) => t): string {
  const 正文串 = String(正文 ?? '');
  if (!Array.isArray(模板渲染结果) || 模板渲染结果.length === 0) return 正文串;
  const 模板段 = 模板渲染结果.join('');
  return 围栏化正文(正文串, 注入兼容层, 正文变换) + 围栏化(模板段);
}

/** HTML 界面片段开头特征（与第二部 html-fence.js 片段分支同语义）：
 * <style / <script / <iframe 开头 = 美化界面，ST 会剥 → 需补骨架围栏进酒馆助手 iframe。
 * 普通 markdown 正文（含 < 被转义）不会命中。 */
const 正文片段开头 = /^\s*<(?:style|script|iframe)\b/i;

/** 交互元素特征：片段含 onclick / <button / addEventListener 即视为「交互界面」。
 * 对齐原版 renderMarkdown 的 replaceEscapedHtmlParagraphs / replaceScriptedPanels 语义。
 * 纯样式 div（妹生活正文容器）不含这些 → 不围栏（保持内联）。 */
const 交互片段标记 = /(onclick\s*=|<button\b|addEventListener\b)/i;

/**
 * 片段界面开头特征（对齐第二部 html-fence.js FRAGMENT_INTERFACE_START_RE）：
 * 以块级容器标签 div/span/table/img/section/article/aside/header/footer/nav/main 开头。
 * ⚠️ 不含 <!doctype/<html/<head/<body（完整文档）也不含 <style/<script/<iframe
 * （由 正文片段开头 无条件围栏）——本判据只补「带交互/样式标记的块级片段界面」。
 */
const 片段界面开头 = /^\s*<(div|span|table|img|section|article|aside|header|footer|nav|main)\b/i;

/** 片段界面「交互/样式标记」：含 class/onclick/<script/data-slash/addEventListener/<style。
 * 守卫：避免误围栏「纯 style div」（正文美化容器只有 style 属性、无 class/交互）。 */
const 片段界面标记 = /(class\s*=|onclick\s*=|<\s*script\b|data-slash\s*=|addEventListener|<\s*style\b)/i;

/** 是否为「片段界面」（以块级标签开头 且 含交互/样式标记）→ 应围栏 iframe 化。 */
function 是片段界面(文本: string): boolean {
  const s = String(文本 ?? '');
  return 片段界面开头.test(s) && 片段界面标记.test(s);
}

/** 骨架围栏（补 <!DOCTYPE html> 让酒馆助手 isFrontend 命中 html>）：片段界面无 <html>/<head>/<body>，
 * 裸围栏后 isFrontend 扫不到 → 必须补 doctype 骨架。注入兼容层由 规整完整文档围栏空行 后续处理。 */
function 骨架围栏(片段: string): string {
  return `\n\n\`\`\`html\n<!DOCTYPE html>\n${srcdoc双重转义(片段)}\n\`\`\`\n\n`;
}

/** 块级面板根标签（用于「正文 + 尾部面板」拆分）：不含 span/img/button 等内联标签，
 * 避免把正文里的内联元素误当面板起点。 */
const 块级面板开头 = /<!--|<(?:style|script|iframe|div|table|section|article|aside|header|footer|nav|main)\b[^>]*>/i;

/**
 * 拆分「正文（纯 markdown）+ 尾部 HTML 面板片段」：找正文后第一个面板起点（HTML 注释
 * `<!--` 或块级标签）作为面板起点。注释优先 —— 醉酒的丈母娘面板是
 * `<!-- ZY_OPENING_UI_START --><style>…<div class="zy-open-ui">…`，注释在 <style> 之前，
 * 若不把注释算作面板起点，注释会留在正文段 → 沉浸式容器负前瞻（扫 <!--ZY_OPENING_UI_START-->）
 * 又命中 → 正文不进渐变盒。
 * 仅用于无完整文档、非片段开头的正文段（正文在前、面板在后）。正文无面板起点 / 开头即
 * 标签（已由片段分支处理）→ null；前文本纯空白（无正文）→ null。
 * @param 串 无完整文档、非片段开头的正文段
 * @returns { 前文本, 面板段 } | null —— 面板段为「第一个注释/块级标签到末尾」的 HTML
 */
function 拆分正文面板(串: string): { 前文本: string; 面板段: string } | null {
  const m = 串.match(块级面板开头);
  if (!m) return null;
  const 面板起 = m.index ?? 0;
  if (面板起 <= 0) return null;
  const 前文本 = 串.slice(0, 面板起);
  if (!前文本.trim()) return null;
  return { 前文本, 面板段: 串.slice(面板起) };
}

/* ---------- 正文段围栏化（完整对齐第二部 html-fence.js fenceFullHtml，处理同一来源 rph_display） ---------- */

/** 完整 HTML 文档开头标记（对齐第二部 FULL_HTML_MATCH_RE：`<!doctype html>` 或 `<html ...>`，`<html\b>` 排除 <htmlx>） */
const 完整文档标记 = /(<!doctype html>|<html\b[^>]*>)/i;

/** 代码块文本是否为「完整 HTML 文档」（含 <!doctype/<html 标记且命中酒馆助手 isFrontend）。 */
function 是完整文档代码块(代码块: string): boolean {
  return 完整文档标记.test(代码块) && 含html标记(代码块);
}

/** 围栏代码块是否为「完整 HTML 文档」（对齐第二部 isFullDocFencedBlock：开围栏 ``` 后 3 字符起、闭围栏止）。 */
function 围栏块是完整文档(文本: string, 开: number, 闭: number): boolean {
  return 是完整文档代码块(文本.slice(开 + 3, 闭));
}

/**
 * 在开围栏前补一个空行（fenced code 识别要求：围栏前必须有空白行，否则 ``` 被当普通
 * 文本渲染 → <pre> 不生成 → TH isFrontend 扫不到）。幂等：p 在文本开头 / p 前已是空行
 * 分隔（\n\n 或空行 + \n）→ 零改动。对齐第二部 ensureBlankLineBefore。
 */
function 确保围栏前空行(文本: string, p: number): string {
  if (p <= 0) return 文本;
  const 最后换行 = 文本.lastIndexOf('\n', p - 1);
  if (最后换行 !== -1) {
    const 前缀 = 文本.slice(最后换行, p);
    if (前缀 === '\n' || /^\n\s*$/.test(前缀)) {
      // 围栏位于行首（或行首带缩进）：检查上一行是否为空行
      const 上上行 = 文本.lastIndexOf('\n', 最后换行 - 1);
      if (上上行 === -1) {
        if (/^\s*$/.test(文本.slice(0, 最后换行))) return 文本; // 第一行为空 → 已空行
      } else if (/^\s*$/.test(文本.slice(上上行, 最后换行))) {
        return 文本; // 上一行为空 → 已空行
      }
      // 行尾换行后插入一个 '\n' 形成空行（围栏行保持行首）
      return 文本.slice(0, 最后换行 + 1) + '\n' + 文本.slice(最后换行 + 1);
    }
  }
  // 围栏紧跟非换行内容：直接插 '\n\n'
  return 文本.slice(0, p) + '\n\n' + 文本.slice(p);
}

/**
 * 规整完整文档围栏空行（渲染部分双向兼容审查-第三轮 H-B 参数化）：
 *   1. 按 ``` 配对扫描（偶数索引开围栏、奇数索引闭围栏；奇数个时最后一个视为无闭开围栏），
 *      检查是否存在「完整文档代码块」；
 *   2. 无 → 原样短路（幂等保护完全保留：普通 markdown / js / css / 反引号文本）；
 *   3. 有 → 只给完整文档代码块的开围栏前补空行（已空行跳过，二次调用幂等）。
 *   4. 对完整文档代码块内部注入模板兼容层（问题 1/3）——狐策/表裏等完整文档代码块
 *      最终进酒馆助手 iframe，需注入 reset（min-height:100vh 不占满整屏）与
 *      triggerSlash/data-slash 桥（按钮可点）。注入幂等（已注入含 __rpDataSlashDelegate
 *      则跳过）。div 配平 / srcdoc 转义不在本分支做。
 *   @param 注入兼容层 是否注入模板兼容层（H-B：false 时只补空行不注入，供不污染
 *                    TH 作者原生围栏的调用方使用；本服务当前恒 true）。
 */
function 规整完整文档围栏空行(文本: string, 注入兼容层: boolean): string {
  const 位置: number[] = [];
  let 索引 = 0;
  while ((索引 = 文本.indexOf('```', 索引)) !== -1) { 位置.push(索引); 索引 += 3; }
  const 对数 = Math.floor(位置.length / 2);
  let 有完整文档 = false;
  for (let i = 0; i < 对数; i++) {
    if (围栏块是完整文档(文本, 位置[i * 2], 位置[i * 2 + 1])) { 有完整文档 = true; break; }
  }
  if (!有完整文档 && 位置.length % 2 === 1) {
    const 末尾 = 位置[位置.length - 1];
    if (是完整文档代码块(文本.slice(末尾 + 3))) 有完整文档 = true;
  }
  if (!有完整文档) return 文本;
  // 只给完整文档块的开围栏前补空行（从后往前插入，避免索引偏移）
  let 输出 = 文本;
  for (let i = 对数 - 1; i >= 0; i--) {
    if (围栏块是完整文档(文本, 位置[i * 2], 位置[i * 2 + 1])) {
      输出 = 确保围栏前空行(输出, 位置[i * 2]);
    }
  }
  if (位置.length % 2 === 1) {
    const 末尾 = 位置[位置.length - 1];
    if (是完整文档代码块(文本.slice(末尾 + 3))) 输出 = 确保围栏前空行(输出, 末尾);
  }
  if (!注入兼容层) return 输出; // H-B：不注入兼容层时只补空行（不污染作者围栏）
  // 对完整文档代码块内部注入模板兼容层（问题 1/3）。需重新定位围栏（补空行后偏移）。
  const 新位置: number[] = [];
  索引 = 0;
  while ((索引 = 输出.indexOf('```', 索引)) !== -1) { 新位置.push(索引); 索引 += 3; }
  const 新对数 = Math.floor(新位置.length / 2);
  for (let i = 新对数 - 1; i >= 0; i--) {
    if (围栏块是完整文档(输出, 新位置[i * 2], 新位置[i * 2 + 1])) {
      const 开 = 新位置[i * 2] + 3;
      const 闭 = 新位置[i * 2 + 1];
      输出 = 输出.slice(0, 开) + 注入模板兼容层(输出.slice(开, 闭)) + 输出.slice(闭);
    }
  }
  if (新位置.length % 2 === 1) {
    const 末尾 = 新位置[新位置.length - 1];
    if (是完整文档代码块(输出.slice(末尾 + 3))) {
      输出 = 输出.slice(0, 末尾 + 3) + 注入模板兼容层(输出.slice(末尾 + 3)) + '';
    }
  }
  return 输出;
}

/**
 * div 配平（对齐第二部 balanceDivBeforeFence，与妹生活类卡）：preText 缺 N 个 </div>
 * 时在围栏前补 N 个；postText 前导剥离等量游离 </div>（那些闭合本属于 preText，
 * 被正则拼接挤到文档段后面）。启发式：仅影响「缺失闭合」的拼接场景。
 */
function 配平div闭合(前文本: string, 后文本: string): { 前文本: string; 后文本: string } {
  // H2 修复：剔除 HTML 注释与自闭合 <div/> 后再计数，避免注释/脚本字符串/散文本内的 <div 误判配平
  // （与第二部 html-fence.js balanceDivBeforeFence 同步镜像，改动需两侧一致）。
  const 清理 = String(前文本)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div\b[^>]*\/>/gi, '');
  const 开 = (清理.match(/<div\b/gi) || []).length;
  const 闭 = (清理.match(/<\/div>/gi) || []).length;
  const 缺 = 开 - 闭;
  if (缺 <= 0) return { 前文本, 后文本 };
  let 修正后 = 后文本;
  for (let i = 0; i < 缺; i++) {
    const m = 修正后.match(/^\s*<\/div>\s*/);
    if (!m) break;
    修正后 = 修正后.slice(m[0].length);
  }
  return { 前文本: 前文本 + '</div>'.repeat(缺), 后文本: 修正后 };
}

/**
 * H4 修复：混合形态兜底 —— 文本已含 ``` 围栏时，旧短路分支只补空行，会漏掉
 * 「围栏区间之外的裸完整文档」（与妹生活 #4 同型：预设产出已围栏的思维链/选项 +
 * 卡内嵌 ui 产出未围栏的状态面板并存）。按 ``` 配对找出围栏区间，对区间之外的裸完整
 * 文档逐个补 ```html 围栏（含 srcdoc 双重转义 + div 配平）。幂等：已围栏的在 ``` 区间内
 * 不被再围栏。对齐第二部 html-fence.js `fenceUnfencedFullDocs`，两侧需一致。
 */
function 围栏化裸完整文档(文本: string): string {
  const 串 = String(文本);
  const 位置: number[] = [];
  let 索引 = 0;
  while ((索引 = 串.indexOf('```', 索引)) !== -1) { 位置.push(索引); 索引 += 3; }
  // 围栏区间之外的 gap（未围栏区）：偶数个 ```（成对）→ 首尾 + 每对闭合之间是 gap；
  // 奇数个（末尾未闭合开围栏）→ 末尾开围栏之后视为「围栏内」，不算 gap
  const 区间: Array<{ 起: number; 止: number }> = [];
  let 段起 = 0;
  let 是开 = true;
  for (let i = 0; i < 位置.length; i++) {
    const p = 位置[i];
    if (是开) {
      if (p > 段起) 区间.push({ 起: 段起, 止: p });
    } else {
      段起 = p + 3;
    }
    是开 = !是开;
  }
  if (位置.length % 2 === 0 && 段起 < 串.length) 区间.push({ 起: 段起, 止: 串.length });
  const 待围栏: Array<{ 起: number; 止: number; 类型: '片段' | '文档' }> = [];
  for (const gap of 区间) {
    const gap文本 = 串.slice(gap.起, gap.止);
    // 3a. 片段界面（<style/<script/<iframe 开头，或 div/span/... 开头且含 class/onclick/script
    //     标记）→ 整段骨架围栏（补 <!DOCTYPE html> 让酒馆助手 isFrontend 命中）。
    if (正文片段开头.test(gap文本) || 是片段界面(gap文本)) {
      待围栏.push({ 起: gap.起, 止: gap.止, 类型: '片段' });
      continue;
    }
    // 3b. 裸完整文档 → 逐个围栏（从后往前处理，避免 index 偏移）
    let seg = gap文本;
    let 偏移 = 0;
    while (seg.length > 0) {
      const m = seg.match(完整文档标记);
      if (!m) break;
      const 相对起 = m.index ?? 0;
      const 相对闭 = seg.toLowerCase().indexOf('</html>', 相对起);
      if (相对闭 === -1) break;
      const 相对止 = 相对闭 + '</html>'.length;
      待围栏.push({ 起: gap.起 + 偏移 + 相对起, 止: gap.起 + 偏移 + 相对止, 类型: '文档' });
      偏移 += 相对止;
      seg = seg.slice(相对止);
    }
  }
  if (待围栏.length === 0) return 串;
  待围栏.sort((a, b) => b.起 - a.起); // 从后往前围栏，避免 index 偏移
  let 输出 = 串;
  for (const seg of 待围栏) {
    const 原文 = 输出.substring(seg.起, seg.止);
    // 片段界面 → 骨架围栏（补 <!DOCTYPE html>）；完整文档 → 裸 ```html 围栏（文档自带 doctype）
    const 围栏段 = seg.类型 === '片段' ? 骨架围栏(原文) : ('\n\n```html\n' + srcdoc双重转义(原文) + '\n```\n\n');
    let 前文本 = 输出.substring(0, seg.起);
    let 后文本 = 输出.substring(seg.止);
    // 空包裹 div 兜底：full doc 紧跟在「开 div 且无文本（仅自闭合 div/空白）」之后 →
    // 该 div 是「正文美化容器」误包 full doc 的空壳（外层 div + 内层左竖条自闭合 div）。
    // 移除空骨架（而非补 </div>），避免围栏化后留下空正文美化容器。
    const 空div = 前文本.match(/(<div\b[^>]*>(?:<div\b[^>]*><\/div>|\s)*)$/);
    if (空div) {
      前文本 = 前文本.slice(0, 空div.index);
      后文本 = 后文本.replace(/^\s*<\/div>/, '');
    } else {
      ({ 前文本, 后文本 } = 配平div闭合(前文本, 后文本));
    }
    输出 = 前文本 + 围栏段 + 后文本;
  }
  return 输出;
}

/**
 * 正文段围栏化 —— 完整对齐第二部 html-fence.js `fenceFullHtml`（同一来源 rph_display
 * 引擎美化输出，语义不可漂移）。按顺序判定：
 *   1. 空 / 非字符串 → 原样；
 *   2. 含 ``` 围栏 → 短路精确化（方案 c）+ H4：先围栏「围栏外的裸完整文档」，再给
 *      所有完整文档代码块补空行（HTML 容器 div + 内部完整文档代码块形态，刚满十八 /
 *      云隐瑶池梦）；无完整文档则原样（普通 markdown / js / css / 反引号文本幂等短路）；
 *   3. 无 ```：任意位置匹配完整 HTML 文档（<!doctype/<html）→ 提取文档段单独包
 *      ```html 围栏 + div 配平（与妹生活）+ srcdoc 双重转义（绝区零），前后文本保留；
 *   4. 无完整文档：<style/<script/<iframe 开头纯片段 → 补 <!DOCTYPE html> 骨架围栏
 *      （不死斩 CBB）；纯 div/table 片段 / 普通 markdown → 原样（对齐原版第 2 分支
 *      内联渲染，纯 div 片段不围栏是既定平台差异，与第二部一致）。
 */
export function 围栏化正文(正文: string, 注入兼容层 = true, 正文变换: (text: string) => string = (t) => t): string {
  const 串 = String(正文 ?? '');
  if (!串) return 串;
  if (串.includes('```')) return 规整完整文档围栏空行(围栏化裸完整文档(串), 注入兼容层); // 短路精确化 + H4
  const 文档匹配 = 串.match(完整文档标记);
  if (!文档匹配) {
    if (正文片段开头.test(串)) {
      // 骨架围栏：进酒馆助手 iframe 存活（ST 会剥 iframe/script）；srcdoc 双重转义 + dvh→vh
      // H-B：注入兼容层（reset + triggerSlash 桥）按参数开关（默认 true，供不污染作者围栏的调用方传 false）
      const 骨架内容 = 注入兼容层 ? 注入模板兼容层(srcdoc双重转义(串)) : srcdoc双重转义(串);
      return `\n\n\`\`\`html\n<!DOCTYPE html>\n${骨架内容}\n\`\`\`\n\n`;
    }
    // 片段界面（div/article/span/... 开头且含 class/onclick/script 等标记，ZZZ 状态栏/阅读器；
    // 或块级开头含 onclick/<button/addEventListener，警花卡按钮点不动修复 方案 A）：
    // 对齐原版三类 iframe 判据 —— 原版靠宽松 cleanConfig 内联，本渲染器只能 iframe 化。
    // 纯样式 div（妹生活正文容器，只有 style 属性）→ 不命中，保持内联（正文可复制/搜索）。
    // ⚠️ 交互片段标记 必须与 片段界面开头 组合（块级开头）—— 不能单独 `交互片段标记.test(串)`
    //   否则「正文纯 markdown + 尾部面板」会被整段围栏（正文被拉进 iframe → \r\n\r\n 塌陷成墙文本，
    //   醉酒的丈母娘实测）。
    if (是片段界面(串) || (片段界面开头.test(串) && 交互片段标记.test(串))) {
      const 骨架内容 = 注入兼容层 ? 注入模板兼容层(srcdoc双重转义(串)) : srcdoc双重转义(串);
      return `\n\n\`\`\`html\n<!DOCTYPE html>\n${骨架内容}\n\`\`\`\n\n`;
    }
    // 正文（纯 markdown）+ 尾部 HTML 面板片段 → 拆分：面板段围栏进 iframe（按钮/data-slash 存活），
    // 正文段保持内联（ST markdown → <p>，段落换行不丢失 —— 醉酒的丈母娘正文墙文本修复）。
    const 拆分 = 拆分正文面板(串);
    if (拆分) {
      const 骨架内容 = 注入兼容层 ? 注入模板兼容层(srcdoc双重转义(拆分.面板段)) : srcdoc双重转义(拆分.面板段);
      // 正文变换（路线 B 开场白 scoped 桥）：对拆出的正文段套一层（如 runScoped 包渐变盒 + 隐藏状态栏），
      // 面板段照常围栏。缺省恒等（不改变既有行为）。
      return 正文变换(拆分.前文本) + `\n\n\`\`\`html\n<!DOCTYPE html>\n${骨架内容}\n\`\`\`\n\n`;
    }
    return 串; // 纯 div/table 片段 / 普通 markdown → 原样（对齐原版内联）
  }
  const 起始 = 文档匹配.index ?? 0;
  const 闭合标签 = '</html>';
  const 闭合位置 = 串.toLowerCase().lastIndexOf(闭合标签);
  const 有闭合 = 闭合位置 !== -1 && 闭合位置 > 起始;
  const 终止 = 有闭合 ? 闭合位置 + 闭合标签.length : 串.length;
  // srcdoc 双重转义（绝区零状态栏）+ 模板兼容层（reset 样式 + triggerSlash 桥，问题 1/3）
  // H-B：注入兼容层按参数开关（默认 true）
  const 文档段 = 注入兼容层
    ? 注入模板兼容层(srcdoc双重转义(串.substring(起始, 终止)))
    : srcdoc双重转义(串.substring(起始, 终止));
  let 前文本 = 串.substring(0, 起始);
  let 后文本 = 有闭合 ? 串.substring(终止) : '';
  ({ 前文本, 后文本 } = 配平div闭合(前文本, 后文本)); // div 配平（与妹生活）
  // 围栏前后必须补空行：ST markdown 的 fenced code block 要求前后空白行才识别为 <pre><code>
  return 正文变换(前文本) + '\n\n```html\n' + 文档段 + '\n```\n\n' + 后文本;
}

/** srcdoc 属性值实体翻倍（对齐第二部 html-fence escapeSrcdocEntities：& → &amp;，
 * 使 ST 管线层层打平后恰好恢复为浏览器所需的单重实体，嵌套 srcdoc 不被裸引号截断）。
 * 附加兼容（CBB 塌陷修复，第三部兼容层）：**整个 HTML 段**内的 `dvh` 视口单位 → `vh`
 * （不限 srcdoc 值内 —— CBB iframe 的 dvh 在 style 属性：`style="height:min(92dvh,760px)"`）。
 * 酒馆助手 replaceVhInContent（iframe.ts:25）正则 `(\d+(?:\.\d+)?)vh\b` 只替换 vh
 * 不替换 dvh → CBB iframe 视口塌陷 6px。原版不经 TH 管线不塌陷；第三部在围栏化写入前
 * 把 dvh 归一为 vh（TH 能处理）。普通正文含 dvh 字样概率极低，仅作用于围栏化界面段。 */
function srcdoc双重转义(html: string): string {
  const 无dvh = String(html).replace(/(\d+(?:\.\d+)?)dvh\b/gi, '$1vh');
  return 无dvh.replace(/(<iframe\b[^>]*\bsrcdoc=")([^"]*)(")/gi, (_匹配, 前, 值, 后) => (
    前 + 值.replace(/&/g, '&amp;') + 后
  ));
}

/** 一次渲染的全部输入（服务与测试共用） */
export interface 渲染请求 {
  /** 后端 uiTemplates 数组（可为空） */
  模板列表: 模板定义[] | null | undefined;
  /** 楼层 rp_hub 池 { [templateId]: 变量池 } */
  池表: Record<string, unknown> | null | undefined;
  /** 消息正文（msg.mes 剥离更新块后） */
  正文: string;
  /** 当前用户名（{{user}} 宏替换） */
  用户名?: string;
  /** 正文段变换（路线 B 开场白 scoped 桥：对拆出的正文段套一层，如 runScoped 包渐变盒；缺省恒等） */
  正文变换?: (text: string) => string;
}

/**
 * 渲染全部可渲染模板并拼接显示文本（纯函数，服务与测试共用）。
 * 步骤：筛选（enabled && 池有条目，top/bottom 分区 + order 降序）→ 逐模板复刻渲染
 * （含 @别名补丁 / {{user}} 宏）→ 拼接（正文 + ```html 围栏模板段）。
 * 无可渲染模板（空列表 / 池无条目 / 后端无模板定义）→ 返回 null（服务不写 display_text）。
 */
export function 渲染全部模板(请求: 渲染请求): string | null {
  const { 模板列表, 池表, 正文, 用户名, 正文变换 } = 请求;
  const 可渲染 = 筛选可渲染模板(模板列表, 池表);
  if (可渲染.length === 0) return null;
  const 池 = 池表 && typeof 池表 === 'object' ? 池表 : {};
  const 结果: string[] = [];
  for (const { 定义 } of 可渲染) {
    const 池条目 = 池[String(定义.id)] && typeof 池[String(定义.id)] === 'object'
      ? (池[String(定义.id)] as Record<string, unknown>)
      : {};
    结果.push(渲染模板字符串(剥离代码围栏(定义.htmlTemplate), 池条目, { 用户名 }));
  }
  // H-B：注入兼容层显式传 true —— 本服务经「RP 模板消息判别」只处理模板消息，
  // 正文必为 RP 内容（狐策/表裏等美化产物需要 reset/桥），不污染 TH 作者围栏。
  return 拼接显示文本(正文, 结果, true, 正文变换);
}

/* ---------- 显示键状态判定（编辑后恢复 / 跳过条件共用，纯函数可测） ---------- */

/**
 * display_text 显示键状态（编辑后不重渲染 / 狐策点不动 修复，模板渲染服务.ts:330-380/451-457 共用）：
 * 现场：ST 某些路径（swipe clearMessageData script.js:10062 等）会**删除/清空** `extra.display_text`
 * 键，而本服务渲染缓存 `extra.rph_template_display` 仍在 —— 编辑取消/保存后 ST 用 `mes` 纯正文
 * 重建 DOM（script.js:8246/8346），且 updateMessageBlock/getMessageTextHTML 优先读 display_text
 * （script.js:1977/2470）→ 键缺失时回退 mes 纯正文 → 模板围栏/狐策界面消失且不再恢复。
 * 三态判定：
 *   - '存在且一致'：display_text 是字符串且非空，且 === rph_template_display（显示键=渲染缓存）→ 正常跳过；
 *   - '存在但不一致'：display_text 是字符串且非空，但 ≠ rph_template_display（被外部改写为其它值）→ 交给事件收敛重渲染；
 *   - '缺失'：display_text 缺失/空串（键被删或清空），但 rph_template_display 是有效字符串 → 需补回显示键恢复。
 */
export type 显示键状态 = '存在且一致' | '存在但不一致' | '缺失';

export function 判断显示键状态(extra: Record<string, unknown> | null | undefined): 显示键状态 {
  const display = extra?.['display_text'];
  const 缓存显示 = extra?.['rph_template_display'];
  const display是串 = typeof display === 'string' && display.length > 0;
  const 缓存是串 = typeof 缓存显示 === 'string' && 缓存显示.length > 0;
  if (!display是串) return '缺失';
  return 缓存是串 && display === 缓存显示 ? '存在且一致' : '存在但不一致';
}

/* ---------- RP 模板消息判别（H-A，渲染部分双向兼容审查-第三轮） ---------- */

/**
 * 消息是否为「RP 模板消息」（决定模板渲染器是否接管显示，纯函数可测）。
 *
 * 背景（H-A）：方向 2 前置条件 —— TH 作者原生前端消息（assistant、把 ```html 界面直接
 * 写进 mes）不能被模板渲染器接管。模板渲染器只该处理「与 RP-Hub 模板渲染有来源关系」的
 * 消息。判定优先级：
 *   1. **消息自身标记**（严格版，主代理定稿；新消息）：任一标记 === true → 模板消息；
 *   2. **H-A 回退判据**（旧数据兼容，渲染部分双向兼容审查-第三轮 追加修复）：v7 引入
 *      rph_template_render / rph_has_update / rph_initial 标记之前的历史消息没有这三个
 *      标记，但 mes / rph_raw_mes 含 RP 美化标签（<fox_selc> 等）时确需渲染 —— 无标记
 *      但含 RP 标签 → 仍视为模板消息。该回退只救旧数据；TH 原生前端消息不含这些 RP
 *      专属标签，不会被误判（实测：楼3 历史消息 rph_template_render 全 undefined，
 *      严格版直接跳过 → 脏检测永不执行 → 磁盘 rph_display 永远脏）。
 *
 * 是模板消息（满足任一）：
 *   - extra.rph_template_render === true：已渲染/已持久化的模板消息 —— 兼容旧数据，
 *     避免判别引入后（bump 输出）旧界面因无标记消失；
 *   - extra.rph_has_update === true：本消息带过 <ui_template_updates> 更新块 ——
 *     变量单向同步服务写池成功后置（变量单向同步.ts 处理消息）；
 *   - extra.rph_initial === true：开场白初始化目标楼层 —— 开场白初始化写池时置
 *     （变量单向同步.ts 检查并初始化）；
 *   - 回退：mes / extra.rph_raw_mes 含 RP 美化标签（RP模板消息回退标签）。
 *
 * 语义权衡（写进汇报）：严格版下，RP 卡中「不带更新块的非开场白 assistant 消息」不再渲染
 * 模板（显示纯正文）—— 与原版「每回合全量渲染」偏离，但这是 TH 原生消息可共存的必要代价；
 * 回退判据弥补「v7 之前持久化的历史消息无标记」的漏网（楼3 狐策消息依赖此才进入渲染）。
 *
 * @param extra 消息的 extra 对象（可 null / undefined）
 * @param 消息 消息对象（可空；用于 H-A 回退判据：读 mes / extra.rph_raw_mes）
 * @returns 是否应视为 RP 模板消息（模板渲染器可接管）
 */
export function 是模板消息(
  extra: Record<string, unknown> | null | undefined,
  消息?: { mes?: unknown; extra?: Record<string, unknown> | null } | null,
): boolean {
  if (extra && typeof extra === 'object') {
    if (extra.rph_template_render === true || extra.rph_has_update === true || extra.rph_initial === true) return true;
  }
  // H-A 回退判据（旧数据兼容）：无三标记但 mes / rph_raw_mes 含 RP 美化标签 → 视为模板消息
  if (消息 && typeof 消息 === 'object') {
    const mes = typeof 消息.mes === 'string' ? 消息.mes : '';
    const raw = 消息.extra && typeof 消息.extra === 'object' && typeof 消息.extra.rph_raw_mes === 'string'
      ? 消息.extra.rph_raw_mes
      : '';
    return RP模板消息回退标签.test(mes) || RP模板消息回退标签.test(raw);
  }
  return false;
}

/** RP 美化标签（H-A 回退判据）：狐策/表裏等 RP-Hub 卡消息正文中的美化/选项标签。
 * 只收 RP-Hub 专属标签，不收通用 HTML 标签 —— TH 作者原生前端消息（含 <html>/<body>
 * 等通用标签）不会被误判为模板消息。 */
const RP模板消息回退标签 = /<fox_selc\b|<fox_input\b|<fox_tip\b|<fox_front\b|<fox_hugou\b|<draft\b|<backgrounds\b|<timefox\b|<bi\b|<ui_template_updates\b|<options\b/i;

/* ---------- 脏 rph_display 检测与清理（狐策点不动方案 A 修正） ---------- */

/**
 * 脏 span 特征：历史旧预设的显示正则向模型输出注入的装饰 span。
 * 判据 = **单引号 style 属性**的 `<span>` / `<div>`（v9→v10 扩展，两条线路隔离 需求3）：
 *   - v9 只认 `<span style='...' + #fff0f5`（粉色背景签名色，刚满十八 楼3 实测 22 个
 *     `style='display: block; background: #fff0f5; ...'` span，其中 10 个在
 *     `<script>...</script>` 块内且插进 JS 字符串内部（`modeBtn.title = '填充模式<span
 *     style='display: ...`）→ 单引号嵌套 → JS 语法错误（Unexpected identifier 'display'）
 *     → 狐策作者 IIFE 中断 → toggleCollapsible 未挂 + 选项卡片 0 → 按钮点不动）。
 *   - v10 扩展：不死斩裸单引号 span（`<span style='display:inline;color:#ffe1a1;font-family:
 *     Consolas,Menlo,'Microsoft YaHei',monospace'>`，不死斩 [11]-[16] 正文沉浸框/对白霓虹牌
 *     /侧写芯片/章节标题/关键词霓虹/数值警示，刚满十八粉色便签同族）不含 #fff0f5 —— 只要
 *     是单引号 style 的 span/div 即判脏（单引号嵌套必然破坏脚本 JS 字符串；双引号 style /
 *     无 style 标签是正常 HTML，不在脚本块内判脏）。含「单引号逃逸丢失」形态
 *     （font-family:'Microsoft —— style 值内含未配对单引号，美化正则把卡片里的
 *     'Microsoft YaHei' 单引号直接带进 HTML）。
 *
 * ⚠️ 判定范围（v9 修正，浏览器验证 + 磁盘数据复核）：**只查 `<script>...</script>` 块内**。
 * 上一版 正文含脏span 扫全文，会命中正文里合法的粉色 span（预设「注释美化」把正文
 * `（……）` 思考包成粉色 span —— RP-Hub 原版正常行为，实测楼1 重算后 rph_display 6779B
 * 仍含 2 个正文粉色 span）→ 每轮判脏 → 异步重算 → 重算后正文还有 → 3 次上限跳过
 * → 楼1 被误判卡死。脚本块外的单引号 span 一律视为正文美化，不判脏、不清理。
 *
 * ⚠️ v10 开关语义（模板渲染服务.ts）：本清理默认**关闭**（thp_script_clean_enabled，
 * 缺省 false）。开启时 = v9/v10 清理即渲染逻辑；关闭 = 完全不介入。
 */

/** 脚本块匹配：`<script ...>...</script>`（含 `<script` 开标签）。 */
const 脚本块匹配模式 = /<script\b[^>]*>[\s\S]*?<\/script>/gi;

/** 脚本块内的脏标签签名（单引号 style 的 <span>/<div>，含单引号逃逸丢失形态与未闭合形态）。
 * 不要求闭合 `>`（v9 实测的未闭合/被 JS 字符串截断形态：`style='display:` 后即无引号内容），
 * 只要 `<span`/`<div` 标签内出现 `style='` 前缀即判脏。 */
const 脚本脏span模式 = /<(?:span|div)\b[^>]*style='/i;

/**
 * 正文的 `<script>...</script>` 块内是否含脏标签（单引号 style 的 span/div）。
 * 只查脚本块内 —— 正文里的单引号 span（美化/注释，RP-Hub 原版正常行为）不在脚本块内，
 * 不误判（实测楼1 重算后正文仍含 2 个粉色 span，上一版 正文含脏span 全文扫描误判
 * → 重算循环 → 3 次上限卡死）。
 * @param 正文 消息正文（msg.extra.rph_display 引擎显示输出）
 * @returns 是否含脚本块内脏标签（需清理）
 */
export function 脚本内含脏span(正文: string): boolean {
  if (typeof 正文 !== 'string' || 正文.length === 0) return false;
  脚本块匹配模式.lastIndex = 0;
  let 块;
  while ((块 = 脚本块匹配模式.exec(正文)) !== null) {
    if (脚本块含脏(块[0])) return true;
  }
  return false;
}

/**
 * 脚本块内的脏 span 是否命中（单引号 style 的 span/div）。
 * 注意：单引号 style 属性可能含未配对单引号（`font-family:'Microsoft` —— style 值内的
 * 单引号会被正则吃掉），但 `style='` 前缀本身必含一个配对引号，故用 `<span style='` 形态
 * 的保守匹配（不要求闭合 `>`，兼容被 JS 字符串截断的未闭合形态）。
 * @param 块 单个 <script>...</script> 块文本
 * @returns 是否含脏标签
 */
function 脚本块含脏(块: string): boolean {
  脚本脏span模式.lastIndex = 0;
  return 脚本脏span模式.test(块);
}

/**
 * 清理脚本块内的脏 span / div（v9→v10 扩展，对齐浏览器已验证的清理正则思路）。
 * 只对 `<script>...</script>` 块内做替换，把单引号 style 标签还原为其内纯文本：
 *   - v9 形态：`<span style='display: block; background: #fff0f5; ...; border-left: 4px solid #ff69b4; ...;'>注释文本</span>`
 *     → `注释文本`（浏览器验证成功正则：
 *     `/<span style='display: block; background: #fff0f5;[\s\S]*?border-left: 4px solid #ff69b4;[\s\S]*?'>([^<]*)<\/span>/g`）
 *   - v10 形态（不死斩）：`<span style='display:inline;color:#ffe1a1;font-family:Consolas,Menlo,'Microsoft YaHei',monospace'>值</span>`
 *     → `值`。泛化正则：`<(span|div)\b[^>]*style='[^>]*>([\s\S]*?)<\/\1>` → 捕获组 2
 *     （**裸捕获组 `$2`，不带引号** —— 带引号 '$2' 会产出 `'填充模式（点击切换为发送）''`
 *     非法 JS（Node 实测），裸捕获文本还原为 `'填充模式（点击切换为发送）'` 合法）。
 *     自闭合单引号标签（`<span style='...' />`）无内容 → 清空。
 * 只处理单引号 style；双引号 / 无 style 标签不动。正文单引号 span 不在脚本块内，不触碰。
 * @param 正文 消息正文（含脚本块）
 * @returns 清理后的正文（脚本块内脏标签还原为纯文本；脚本块外原样）
 */
export function 清理脚本脏span(正文: string): string {
  if (typeof 正文 !== 'string' || 正文.length === 0) return 正文;
  脚本块匹配模式.lastIndex = 0;
  return 正文.replace(脚本块匹配模式, (块) => {
    const 脚本内容 = 块.replace(/^<script\b[^>]*>/, '').replace(/<\/script>$/, '');
    const 干净脚本内容 = 脚本内容.replace(
      /<(span|div)\b[^>]*style='[^>]*>([\s\S]*?)<\/\1>/gi,
      (_全, _标签, 文本) => String(文本 ?? ''),
    ).replace(
      /<(span|div)\b[^>]*style='[^>]*\/>/gi,
      '',
    );
    return 块.replace(脚本内容, 干净脚本内容);
  });
}
