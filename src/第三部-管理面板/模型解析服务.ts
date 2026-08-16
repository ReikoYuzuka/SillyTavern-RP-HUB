/**
 * 模型解析服务 —— 「世界书注入（模式一·跟随主模型）」+「额外模型解析（模式二）」。
 *
 * 依据（设计记录.md §4.2 模式一/模式二，用户 2026-08 拍板「只做这两件事，以实际代码为主」；
 * 后续拍板选 A：模式一改用 TH createWorldbookEntries 创建【真实世界书条目】）：
 *   - 模式一：把「让 AI 在正文末尾输出 <ui_template_updates> 更新块」的指令写成 ST 世界书条目
 *     （当前聊天世界书，世界书面板可见、持久化、可删）。指令内容由当前卡模板列表 + 楼层
 *     变量池构建（{{{变量}}} 占位替换；{{rpcard_update_rules}} 预解析为卡面提示词）。
 *     与既有「楼层变量 rp_hub」通道并存：楼层变量仍由 变量单向同步.ts 自动剥离解析 AI
 *     回复更新块写入；模式一是让 AI *产生* 更新块的提示词注入，二者互补不冲突。
 *   - 模式二：独立 OpenAI 兼容 API 直连（openai_api/model/base），在 AI 回复后对每个模板
 *     单独分析最近对话 → 生成变量更新 → 写入楼层变量 rp_hub（独立通道）。该模式下模式一
 *     的世界书注入自动关闭。支持自定义提取标签（AI 输出被思维链包裹时只取标签内容）与
 *     自定义解析模板。
 *
 * 接口选型（优先 TH/ST 实际可用接口，以实际代码为主）：
 *   - 注入：TavernHelper.createWorldbookEntries（worldbook.ts:441，TH 挂在父窗口 globalThis，
 *     index.ts:478；脚本 iframe 经 predefine.js:12 把父窗口 TavernHelper 浅拷进 iframe）。
 *     世界书名 = TavernHelper.getOrCreateChatWorldbook('current')（worldbook.ts:77）。
 *     位置/角色 8 枚举经 世界书位置映射/世界书角色映射（模型解析.ts，对齐 TH toWorldbookEntry
 *     worldbook.ts:230-240 与 ST world_info_position world-info.js:855）。
 *     删除 = deleteWorldbookEntries(worldbook_name, e => e.name === 条目名)（worldbook.ts:460）。
 *   - 写入：写楼层变量（变量单向同步.ts，TH updateVariablesWith type:'message'）。
 *   - 配置持久化：localStorage（thp_model_parse_config）。
 *
 * 与设计记录的差异（以实际为主）：
 *   - 设计 position 0↑Char/1↓Char/5↑EM/6↓EM/2↑AN/3↓AN/4@D/7Outlet 即 ST 世界书条目位置
 *     （world_info_position），现按真实世界书条目完整映射（不再用 setExtensionPrompt 的
 *     extension_prompt_types 近似）。
 *   - 设计「双向同步回写插件数据」未做（当前第三部以楼层变量 rp_hub 为真相源，无插件自库）。
 */

import { ref } from 'vue';
import { 写楼层变量, 变量同步开关已启用, 同步错误 } from './变量单向同步';
import { 渲染开关已启用 } from './模板渲染服务';
import {
  构建解析系统提示词,
  构建变量更新指令,
  构建注入文本,
  构建模板载荷JSON,
  标准注入模板,
  提取标签内容,
  解析模型变量响应,
  合并解析变量,
  收集最近消息,
  模板变量JSON,
  变量说明文本,
  模板当前变量,
  世界书位置映射,
  世界书角色映射,
  type 最近消息,
  type 卡面变量模板,
  type 模板池表,
} from './模型解析';
import { 转换更新块 } from './更新块转换';
import { 替换卡面提示词 } from './card-prompt';
import { 记录日志 } from './运行日志';

/* ---------- 配置 ---------- */

/** 注入位置（ST 世界书条目 position.type 8 枚举，设计记录 §4.2；对应值见 世界书位置映射） */
export const 注入位置选项 = [
  { value: 0, label: '0 · 角色定义前（↑Char）' },
  { value: 1, label: '1 · 角色定义后（↓Char）' },
  { value: 5, label: '5 · 示例消息前（↑EM）' },
  { value: 6, label: '6 · 示例消息后（↓EM）' },
  { value: 2, label: '2 · 作者注释前（↑AN）' },
  { value: 3, label: '3 · 作者注释后（↓AN）' },
  { value: 4, label: '4 · 插入深度 @D（+role，默认）' },
  { value: 7, label: '7 · 锚点（Outlet）' },
] as const;

/** 注入角色（ST 世界书条目 position.role） */
export const 注入角色选项 = [
  { value: 0, label: '系统 System' },
  { value: 1, label: '用户 User' },
  { value: 2, label: 'AI Assistant' },
] as const;

export interface 解析配置 {
  /** 当前模式（UI「解析模式」区块单选） */
  模式: '跟随主模型' | '额外模型解析';
  /* ---- 模式一：世界书注入 ---- */
  /** 模式一注入开关（跟随主模型模式下启用才注入） */
  注入使能: boolean;
  /** 注入位置（ST 世界书条目 position.type 枚举值 0-7） */
  注入位置: number;
  /** 注入深度（仅 @D 生效） */
  注入深度: number;
  /** 注入顺序（世界书条目 position.order） */
  注入顺序: number;
  /** 注入角色 */
  注入角色: number;
  /** 常驻：true = 条目 strategy=constant（常驻注入，换卡/切聊天自动重新注入）；false = 条目 strategy=selective（空 keys 不自动激活，条目保留在世界书，幂等去重仍生效） */
  常驻: boolean;
  /** 世界书注入模板（含 {{{变量}}} 占位 / {{rpcard_update_rules}} 占位） */
  注入模板: string;
  /* ---- 模式二：额外模型解析 ---- */
  /** OpenAI 兼容 API Key */
  openai_api: string;
  /** 额外模型名 */
  openai_model: string;
  /** API 基址（默认 https://api.openai.com/v1） */
  openai_base: string;
  /** 自定义解析模板（含 {{{变量说明}}}/{{{当前变量}}}/{{{最近对话}}}/{{{用户信息}}} 占位；空 = 用内置中文模板） */
  解析模板: string;
  /** 自定义提取标签（AI 输出被思维链包裹时只取 <标签>...</标签> 内容；空 = 不提取直接解析） */
  提取标签: string;
  /** 额外模型解析 API 调用失败时的错误重试次数（0 = 不重试；每次失败后整体重发请求） */
  错误重试次数: number;
}

const 配置存储键 = 'thp_model_parse_config';

/** 默认配置（对齐设计记录 §4.2 默认值：系统 · 插入深度@D · depth=4 · order=100 · 常驻） */
export function 默认配置(): 解析配置 {
  return {
    模式: '跟随主模型',
    注入使能: true,
    注入位置: 4, // at_depth（插入深度 @D，设计默认）
    注入深度: 4,
    注入顺序: 100,
    注入角色: 0, // System
    常驻: true,
    // 默认注入模板 = 标准格式指令串（RP-Hub 原版 buildMainModelUiTemplatePrompt 一整串：
    // [UI模板变量更新] + <ui_template_updates> 格式 + 13 条规则 + 模板变量如下:{{{变量载荷}}}）。
    // 注入时 {{{变量载荷}}} 被替换为当前卡模板载荷 JSON（id/name/当前变量/schema）。
    // 不再套「你每次必须在正文最末尾输出」例子壳（用户要求标准默认）。
    注入模板: 标准注入模板,
    openai_api: '',
    openai_model: '',
    openai_base: 'https://api.openai.com/v1',
    解析模板: '',
    提取标签: '',
    错误重试次数: 1,
  };
}

/** 已淘汰的旧默认注入模板（「你每次必须在正文最末尾输出」例子壳：无 {{{变量载荷}}} 槽） */
const 旧默认注入模板1 = '你每次必须在正文最末尾输出\n{{rpcard_update_rules}}';
const 旧默认注入模板2 = '你每次必须在正文最末尾输出\n{{{变量}}}';

export function 读取配置(): 解析配置 {
  try {
    const raw = localStorage.getItem(配置存储键);
    if (raw) {
      const 存 = JSON.parse(raw) as Partial<解析配置>;
      const 合并 = { ...默认配置(), ...存 };
      // 配置迁移（2026-08-15 两轮）：旧默认模板是「引导行 + 占位符」的例子壳，不是标准指令。
      // 第一轮旧值 {{rpcard_update_rules}}（注入只出 schema 字段说明，AI 不知输出更新块）；
      // 第二轮旧值 {{{变量}}}（例子壳）。两者都就地升级为标准格式指令串（含 {{{变量载荷}}} 槽）。
      if (合并.注入模板 === 旧默认注入模板1 || 合并.注入模板 === 旧默认注入模板2) {
        合并.注入模板 = 默认配置().注入模板;
      }
      return 合并;
    }
  } catch {
    // 解析失败 → 默认
  }
  return 默认配置();
}

export function 保存配置(配置: 解析配置): void {
  // 同步更新响应式配置源（UI computed 的 get 依赖它 → set 后界面立即刷新）。
  // 保存的是已迁移值，不重跑迁移（迁移只在 读取配置 初始化时执行）。
  const 旧配置 = 配置响应.value;
  配置响应.value = 配置;
  // 模式切换记录（解析模式单选变化时记一条，输入框逐键保存不记录）
  if (旧配置.模式 !== 配置.模式) {
    记录日志('模型解析', `解析模式 → ${配置.模式}`);
  }
  try {
    localStorage.setItem(配置存储键, JSON.stringify(配置));
  } catch {
    // localStorage 不可用时静默降级（注入仍按内存配置生效，只是不持久）
  }
}

/**
 * 响应式配置源（UI 专用）。
 * 背景（radio 切换无反应修复）：localStorage 不在 Vue 响应式系统内 —— computed get 若直接
 * `读取配置()`（读 localStorage）就没有响应式依赖，set 后 Vue 不会重新求值。故 UI computed
 * 一律读 `配置响应.value.xxx`，set 经 保存配置 同步更新本 ref。
 * 初始化用 读取配置()（含旧默认模板迁移），之后由 保存配置 覆盖。
 */
export const 配置响应 = ref<解析配置>(读取配置());

/* ---------- 响应式状态（供 UI 展示） ---------- */

/** 最近一次世界书注入状态说明 */
export const 注入状态 = ref('待命');
/** 最近一次额外模型解析状态说明 */
export const 解析状态 = ref('待命');
/** 额外模型解析是否进行中（防重入） */
export const 解析中 = ref(false);

/* ---------- 宿主上下文 ---------- */

/** 读取 ST 上下文（脚本 iframe：SillyTavern 全局经 TH predefine 注入） */
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

/** 读取当前用户名（{{user}} 宏替换源；与模板渲染服务 获取用户名 同模式） */
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

/* ---------- rp-hub-compat 后端（模板定义/变量视图拉取） ---------- */

/** 相对路径，ST 自动补当前 origin（与第二部 rp-mode.js:29 一致，换端口/域名/局域网都通） */
const BASE = (() => {
  // srcdoc iframe 内相对路径 base 继承可能异常 → 用父窗口 origin 拼绝对路径（跟随部署 origin，不写死）
  try { const o = (window.parent ?? window)?.location?.origin; if (o) return o + '/api/plugins/rp-hub-compat/v1'; } catch {}
  return '/api/plugins/rp-hub-compat/v1';
})();

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
  cardId: string;
  variables: { uiTemplates?: 卡面变量模板[] };
}

/** 拉取当前卡 uiTemplates（模板列表；后端不可达 → null） */
export async function 拉取模板列表(): Promise<卡面变量模板[] | null> {
  try {
    const 卡名 = 获取当前卡名();
    if (!卡名) return null;
    const by_name = await 请求<ByName>(`${BASE}/cards/by-name/${encodeURIComponent(卡名)}`);
    if (!by_name) return null;
    const vars = await 请求<VariablesView>(`${BASE}/cards/${by_name.cardId}/variables?fields=uiTemplates`);
    return Array.isArray(vars?.variables?.uiTemplates) ? vars.variables.uiTemplates : [];
  } catch {
    return null;
  }
}

/* ---------- 模式一：世界书注入（真实世界书条目） ---------- */

/**
 * E 联动核心（计划 §2.3）：世界书注入只在「变量更新总开关开启 + 跟随主模型 + 注入开关开启」时启动。
 * 变量更新总开关关闭（不剥离/不写楼层/不初始化/不注入）或模式二（额外模型解析）→ 自动视为关闭。
 * 两处实现：UI（TabVariables 模式/总开关 setter 联动）与注入逻辑（本判定，检查并注入/注入世界书 入口）。
 */
export function 世界书注入应启动(配置: 解析配置): boolean {
  return 变量同步开关已启用() && 配置.模式 === '跟随主模型' && !!配置.注入使能;
}

/**
 * 注入条目名（世界书条目 comment/name 定位标识，删除/幂等用）。
 * 用户要求统一固定名 `[RP]变量更新`（不再带 order）。ST 世界书条目名（comment 字段）为自由文本，
 * 方括号无特殊语义（RP 生态条目如 `[mvu_update]变量输出格式` 即含方括号），字面匹配无需转义。
 * 存量旧条目 `TH-RP-*` 不改名（不去动用户已有数据）；去重时新旧名都查（见 是否已注入世界书）。
 */
export const 注入条目名 = '[RP]变量更新';

/** 取 TH TavernHelper 通道（脚本 iframe 经 predefine.js:12 浅拷进 window；跨域/异常降级尝试父窗口） */
function 获取TH(): Record<string, unknown> | null {
  try {
    const th = (window as unknown as Record<string, unknown>).TavernHelper;
    if (th && typeof th === 'object' && !Array.isArray(th)) return th as Record<string, unknown>;
  } catch {
    // 忽略，走父窗口
  }
  try {
    const parent = window.parent as Window & { TavernHelper?: Record<string, unknown> };
    if (parent?.TavernHelper && typeof parent.TavernHelper === 'object' && !Array.isArray(parent.TavernHelper)) {
      return parent.TavernHelper;
    }
  } catch {
    // 忽略
  }
  return null;
}

/** 世界书注入相关 TH 方法可用性检查（供调用方前置判断） */
function TH可用(th: Record<string, unknown> | null): boolean {
  return !!th
    && typeof th.getCharWorldbookNames === 'function'
    && typeof th.getWorldbookNames === 'function'
    && typeof th.createWorldbook === 'function'
    && typeof th.rebindCharWorldbooks === 'function'
    && typeof th.createWorldbookEntries === 'function'
    && typeof th.deleteWorldbookEntries === 'function';
}

/** 取当前角色已绑定的世界书（读角色卡 extensions.world；未绑定 → null；卡不存在/API 异常 → null） */
function 角色绑定世界书名(th: Record<string, unknown> | null): string | null {
  if (!th) return null;
  try {
    const thObj = th as { getCharWorldbookNames?: (name: string) => { primary?: string | null } };
    const 结果 = thObj.getCharWorldbookNames?.('current');
    const primary = 结果?.primary;
    return typeof primary === 'string' && primary ? primary : null;
  } catch {
    return null;
  }
}

/**
 * 取世界书名（角色绑定优先，创建时按角色名命名）—— 反馈 1 单点。
 * 返回 `{ 世界书名, 绑定警告? }`：
 *   - 已绑定且世界书真实存在 → 直接复用（保持绑定关系）；
 *   - 已绑定但指向的世界书不存在（卡引用未导入的世界书 → createWorldbookEntries 会抛
 *     「未能找到世界书」导致注入失败）→ 重建为「角色名」世界书并绑定；
 *   - 未绑定 → 创建「角色名」世界书（幂等）并尝试绑定到角色卡；绑定失败（rebindCharWorldbooks
 *     内部 POST /api/characters/edit 依赖角色编辑表单，可能抛错）不阻断注入，返回 绑定警告。
 * TH 无 getOrCreateCharWorldbook 现成接口（worldbook.ts:23-81 仅 getCharWorldbookNames /
 * rebindCharWorldbooks / createWorldbook），由上述原语组合实现。
 * @returns 世界书名（null=失败）；绑定警告 = 创建成功但绑定角色失败的说明
 */
async function 取世界书名(th: Record<string, unknown> | null): Promise<{ 世界书名: string | null; 绑定警告?: string }> {
  if (!th) return { 世界书名: null };
  const thObj = th as {
    getWorldbookNames?: () => string[];
    createWorldbook?: (name: string, entries?: unknown[]) => Promise<boolean>;
    rebindCharWorldbooks?: (name: 'current', books: { primary?: string | null; additional?: string[] }) => Promise<void>;
  };
  const 卡名 = 获取当前卡名();
  if (!卡名) return { 世界书名: null };
  try {
    const 已绑定 = 角色绑定世界书名(th);
    const 存在表 = typeof thObj.getWorldbookNames === 'function' ? thObj.getWorldbookNames() : [];
    // 已绑定且世界书存在 → 直接复用
    if (已绑定 && 存在表.includes(已绑定)) return { 世界书名: 已绑定 };
    if (已绑定 && !存在表.includes(已绑定)) {
      // 卡引用未导入的世界书（常见：RP 卡 extensions.world 指向作者世界书，本地未导入）
      console.warn(`[第三部] 角色卡绑定世界书「${已绑定}」不存在（可能未导入），重建为「${卡名}」`);
    }
    if (typeof thObj.createWorldbook !== 'function' || typeof thObj.rebindCharWorldbooks !== 'function') return { 世界书名: null };
    await thObj.createWorldbook(卡名, []); // 幂等：已存在同名则复用（返回 false，不覆盖）
    // 绑定到角色卡（随角色走）；失败不阻断注入（条目仍创建，用户可手动绑定）
    try {
      await thObj.rebindCharWorldbooks('current', { primary: 卡名, additional: [] });
      return { 世界书名: 卡名 };
    } catch (bindErr) {
      console.warn('[第三部] 角色世界书绑定失败（条目仍注入，可在世界书面板手动绑定）：', bindErr instanceof Error ? bindErr.message : bindErr);
      return { 世界书名: 卡名, 绑定警告: `已创建世界书「${卡名}」但绑定角色失败（可在世界书面板手动绑定）` };
    }
  } catch (e) {
    console.warn('[第三部] 取世界书名失败：', e instanceof Error ? e.message : e);
    return { 世界书名: null };
  }
}

/**
 * 世界书注入：在当前角色绑定的世界书创建【真实世界书条目】（TH createWorldbookEntries）。
 * 世界书名经 取世界书名 单点取得（角色已绑定 → 复用；未绑定 → 按角色名创建并绑定到角色卡，
 * 换聊天不丢、随角色走）。
 * 幂等：先删同名旧条目（deleteWorldbookEntries 按 name 匹配）再建新条目，重复调用不重复追加。
 * 条目：name = [RP]变量更新、content = 注入文本（默认 = 标准格式指令串 + 模板载荷 JSON；
 *   自定义模板含 {{{变量}}}/{{{变量载荷}}} 时按占位替换）、
 * position.type = 世界书位置映射(配置.注入位置)、position.role = 世界书角色映射、
 * position.depth / position.order 照传、constant（strategy.type='constant'）由 常驻 决定。
 * @returns 是否成功
 */
export async function 注入世界书(模板列表: 卡面变量模板[] | null, 池表: Record<string, unknown>): Promise<boolean> {
  const 配置 = 读取配置();
  if (!世界书注入应启动(配置)) {
    注入状态.value = '世界书注入未启用（需 变量更新总开关开启 + 跟随主模型 + 注入开关开启）';
    记录日志('模型解析', '世界书注入未启用（需 总开关开启 + 跟随主模型 + 注入开关开启）');
    return false;
  }
  if (!Array.isArray(模板列表) || 模板列表.length === 0) {
    注入状态.value = '卡面无 uiTemplates，跳过注入';
    记录日志('模型解析', '卡面无 uiTemplates，跳过注入');
    return false;
  }
  const th = 获取TH();
  if (!TH可用(th)) {
    注入状态.value = 'TH TavernHelper 角色世界书 API 不可用（getCharWorldbookNames / createWorldbook / rebindCharWorldbooks / createWorldbookEntries 缺失）';
    记录日志('模型解析', 'TH 角色世界书 API 不可用（getCharWorldbookNames / createWorldbook / rebindCharWorldbooks / createWorldbookEntries 缺失）', 'warn');
    return false;
  }
  try {
    // 角色绑定世界书名（未绑定 → 按角色名创建并绑定；绑定失败不阻断，返回 绑定警告）
    const { 世界书名, 绑定警告 } = await 取世界书名(th);
    if (!世界书名) {
      注入状态.value = '取角色世界书失败（未选中角色 / 创建世界书失败），跳过注入';
      记录日志('模型解析', '取角色世界书失败（未选中角色 / 创建世界书失败），跳过注入', 'warn');
      return false;
    }
    // 指令 + 模板 → 注入文本（默认 = 标准格式指令串 + 模板载荷 JSON；自定义模板含占位符时替换）
    const 指令 = 构建变量更新指令(模板列表, 池表, 获取用户名());
    const 载荷JSON = 构建模板载荷JSON(模板列表, 池表);
    const 模板文本 = 替换卡面提示词(配置.注入模板, 模板列表);
    const 内容 = 构建注入文本(模板文本, 指令, 载荷JSON);
    const 条目名 = 注入条目名;
    // 幂等：先删同名旧条目
    try {
      await (th as { deleteWorldbookEntries: (name: string, p: (e: { name?: string }) => boolean) => Promise<unknown> })
        .deleteWorldbookEntries(世界书名, e => e?.name === 条目名);
    } catch {
      // 无旧条目 / 删除失败 → 忽略（继续创建）
    }
    // 创建条目（PartialDeep：name/content/position 即可，其余 TH 补默认）
    const 位置 = Number.isFinite(Number(配置.注入位置)) ? Number(配置.注入位置) : 4;
    const 深度 = Number.isFinite(Number(配置.注入深度)) ? Number(配置.注入深度) : 4;
    const 角色 = Number.isFinite(Number(配置.注入角色)) ? Number(配置.注入角色) : 0;
    await (th as { createWorldbookEntries: (name: string, entries: unknown[]) => Promise<unknown> })
      .createWorldbookEntries(世界书名, [{
        name: 条目名,
        enabled: true,
        content: 内容,
        strategy: { type: 配置.常驻 ? 'constant' : 'selective', keys: [], keys_secondary: { logic: 'and_any', keys: [] } },
        position: {
          type: 世界书位置映射(位置),
          role: 世界书角色映射(角色),
          depth: 深度,
          // C3：order=0 是合法值（ST order 越小越靠前），不能用 || 100 吞掉；仅非法值回退默认 100
          order: Number.isFinite(Number(配置.注入顺序)) ? Number(配置.注入顺序) : 100,
        },
      }]);
    注入状态.value = `已注入世界书「${世界书名}」：条目 ${条目名}（${模板列表.length} 个模板 · 位置=${位置} · 深度=${深度}${配置.常驻 ? ' · 常驻' : ' · 不常驻（selective，不自动注入）'}）${绑定警告 ? `；${绑定警告}` : ''}`;
    记录日志('模型解析', `已注入世界书「${世界书名}」条目 ${条目名}（${模板列表.length} 个模板 · 位置=${位置} · 深度=${深度}${配置.常驻 ? ' · 常驻' : ' · 不常驻'}）`);
    return true;
  } catch (e) {
    注入状态.value = `世界书注入失败：${e instanceof Error ? e.message : String(e)}`;
    记录日志('模型解析', `世界书注入失败：${e instanceof Error ? e.message : String(e)}`, 'warn');
    return false;
  }
}

/** 取消世界书注入：删除本插件创建的世界书条目（deleteWorldbookEntries 按条目名匹配）。
 * 非破坏性：只查「已绑定世界书」中的条目（未绑定 → 不创建/不绑定，直接提示无需取消）。 */
export async function 取消注入世界书(): Promise<void> {
  const 条目名 = 注入条目名;
  const th = 获取TH();
  if (!TH可用(th)) return;
  try {
    const 世界书名 = 角色绑定世界书名(th);
    if (!世界书名) {
      注入状态.value = '当前角色未绑定世界书，无需取消';
      记录日志('模型解析', '取消注入：当前角色未绑定世界书，无需取消');
      return;
    }
    await (th as { deleteWorldbookEntries: (name: string, p: (e: { name?: string }) => boolean) => Promise<unknown> })
      .deleteWorldbookEntries(世界书名, e => e?.name === 条目名);
    注入状态.value = `已取消注入：角色世界书「${世界书名}」条目 ${条目名} 已删除`;
    记录日志('模型解析', `已取消注入：角色世界书「${世界书名}」条目 ${条目名} 已删除`);
  } catch (e) {
    console.warn('[第三部] 取消注入失败：', e instanceof Error ? e.message : e);
    注入状态.value = '取消注入失败（世界书可能不存在或条目缺失）';
    记录日志('模型解析', '取消注入失败（世界书可能不存在或条目缺失）', 'warn');
  }
}

/* ---------- 模式二：额外模型解析 ---------- */

/** 最近消息收集（从当前聊天取最后 N 条非系统消息，与 RP-Hub sourceMessages 对齐） */
function 收集当前聊天最近消息(深度: number): 最近消息[] {
  try {
    const chat = SillyTavern.chat;
    if (!Array.isArray(chat)) return [];
    const 卡名 = 获取当前卡名();
    const 用户名 = 获取用户名();
    const 列表: 最近消息[] = [];
    for (const 消息 of chat) {
      if (!消息 || typeof 消息.mes !== 'string' || 消息.is_system) continue;
      列表.push({
        role: 消息.is_user ? 'user' : 'assistant',
        name: 消息.is_user ? 用户名 : (消息.name || 卡名 || ''),
        content: 消息.mes,
      });
    }
    return 收集最近消息(列表, 深度);
  } catch {
    return [];
  }
}

/** 自定义解析模板占位替换（{{{变量说明}}}/{{{当前变量}}}/{{{最近对话}}}/{{{用户信息}}}） */
function 渲染解析模板(模板: string, 参数: { 变量说明: string; 当前变量: string; 最近对话: string; 用户信息: string }): string {
  if (!模板) {
    return 构建解析系统提示词({
      当前变量JSON: 参数.当前变量,
      变量说明: 参数.变量说明,
      用户信息: 参数.用户信息,
      用户名: 获取用户名(),
    });
  }
  return 模板
    .replace('{{{变量说明}}}', 参数.变量说明)
    .replace('{{{当前变量}}}', 参数.当前变量)
    .replace('{{{最近对话}}}', 参数.最近对话)
    .replace('{{{用户信息}}}', 参数.用户信息);
}

/** MS5 修复：API 调用超时上限（挂起时不再永久阻塞解析通道）。 */
const 解析API超时毫秒 = 60_000;

/** 调用 OpenAI 兼容 chat/completions（非流式，温度 0.2，对齐 RP-Hub） */
async function 调用补全API(配置: 解析配置, 系统提示词: string, 用户内容: string): Promise<string | null> {
  const base = String(配置.openai_base || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const controller = new AbortController();
  const 超时 = setTimeout(() => controller.abort(), 解析API超时毫秒);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${配置.openai_api}`,
      },
      body: JSON.stringify({
        model: 配置.openai_model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: 系统提示词 },
          { role: 'user', content: 用户内容 },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const 文本 = await res.text().catch(() => '');
      throw new Error(`API Error: ${res.status} ${文本.slice(0, 120)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  } finally {
    clearTimeout(超时);
  }
}

/**
 * 带错误重试的 API 调用（计划 §1.2 模式二「错误重试次数」）：
 * 失败（HTTP 非 2xx / 网络异常）时按配置 错误重试次数 整体重发请求，最后一次失败仍抛错。
 * @returns 内容或 null（成功但无 content）
 */
async function 调用补全API带重试(配置: 解析配置, 系统提示词: string, 用户内容: string): Promise<string | null> {
  const 重试 = Math.max(0, Math.floor(Number(配置.错误重试次数) || 0));
  let 最后错误: unknown = null;
  for (let i = 0; i <= 重试; i++) {
    try {
      return await 调用补全API(配置, 系统提示词, 用户内容);
    } catch (e) {
      最后错误 = e;
      if (i < 重试) {
        console.warn(`[第三部] 额外模型解析 API 调用失败（第 ${i + 1} 次失败，共可重试 ${重试} 次）：`, e instanceof Error ? e.message : e);
      }
    }
  }
  if (最后错误) throw 最后错误;
  return null;
}

/** 提取标签内容：取 <标签>...</标签> 之间的内容（已移至 模型解析.ts 纯函数，此处复用导入） */

/**
 * 模式二：额外模型解析一条消息的变量更新（AI 回复 → 提取/解析 → 写入该楼层 rp_hub）。
 * 流程（对齐设计 §4.2 模式二 + RP-Hub updateUiTemplatesFromChat）：
 *   1. 提取标签内容（配置了标签时）；有内容 → 直接 解析模型变量响应；
 *   2. 否则（无标签/无内容）→ 对每个模板调独立 OpenAI API（最近 N 条 + 当前变量 + schema）；
 *   3. 结果按模板合并 → 写楼层变量(messageId, 池表)。
 * @param messageId 目标楼层（AI 回复所在消息）
 * @param 模板列表  当前卡 uiTemplates（可 null → 跳过）
 * @returns 是否写入了楼层变量
 */
export async function 额外模型解析(messageId: number, 模板列表: 卡面变量模板[] | null): Promise<boolean> {
  const 配置 = 读取配置();
  // 总开关：关闭后不对变量做任何操作（模式二解析写楼层变量也跳过）
  if (!变量同步开关已启用()) {
    解析状态.value = '变量更新总开关关闭，跳过额外解析';
    记录日志('模型解析', '额外解析跳过：变量更新总开关关闭');
    return false;
  }
  if (配置.模式 !== '额外模型解析') {
    解析状态.value = '模式二未启用（当前为跟随主模型），跳过解析';
    记录日志('模型解析', '额外解析跳过：当前模式为跟随主模型');
    return false;
  }
  if (解析中.value) {
    // MS4 修复：防重入期间到达的消息不再静默丢弃，记录跳过日志（供诊断连续消息漏解析）
    console.warn(`[第三部] 额外模型解析防重入：消息 #${messageId} 在解析中到达，已跳过（可考虑待处理队列）`);
    return false;
  }
  if (!Array.isArray(模板列表) || 模板列表.length === 0) {
    解析状态.value = '卡面无 uiTemplates，跳过额外解析';
    记录日志('模型解析', '额外解析跳过：卡面无 uiTemplates');
    return false;
  }
  解析中.value = true;
  try {
    // 读取目标楼层自身池表（作为"当前变量"；message 层）
    const 当前池 = 读取楼层变量(messageId);
    // 提取标签：有内容 → 直接解析，不再调 API（无需 API Key/模型/基址配置，纯本地解析）
    const 标签内容 = 配置.提取标签 ? 提取标签内容(读取消息正文(messageId), 配置.提取标签) : '';
    if (标签内容) {
      const 池表 = await 解析并合并(标签内容, 当前池, 模板列表, 0);
      const ok = 写楼层变量(messageId, 池表);
      解析状态.value = ok
        ? `#${messageId} 标签提取解析完成，写入 ${Object.keys(池表).length} 个模板池（rp_hub）`
        : `#${messageId} 标签解析写楼层变量失败`;
      if (ok) {
        记录日志('模型解析', `#${messageId} 标签提取解析完成，写入 ${Object.keys(池表).length} 个模板池`);
      } else {
        记录日志('模型解析', `#${messageId} 标签解析写楼层变量失败：${同步错误.value || '未知原因'}`, 'warn');
      }
      return ok;
    }
    // 无标签内容 → 逐模板调独立 API：此时才校验 API 配置（A2：标签通道不依赖 API 配置）
    if (!配置.openai_api || !配置.openai_model) {
      解析状态.value = '额外模型未配置（API Key / 模型为空），请在变量管理·额外模型解析中填写';
      记录日志('模型解析', '额外解析跳过：API Key / 模型未配置', 'warn');
      return false;
    }
    // 最近消息收集（对齐 RP-Hub sourceMessages 后 N 条）
    const 最近消息列表 = 收集当前聊天最近消息(4);
    const 用户信息 = 构建用户信息();
    let 失败数 = 0;
    for (const 模板 of 模板列表) {
      if (!模板 || typeof 模板 !== 'object' || typeof 模板.id !== 'string' || !模板.id.trim()) continue;
      try {
        const 当前变量 = 当前池[模板.id] ?? 模板当前变量(模板);
        const 系统提示词 = 渲染解析模板(配置.解析模板, {
          变量说明: 变量说明文本(模板.variableSchema),
          当前变量: 模板变量JSON(当前变量),
          最近对话: JSON.stringify(最近消息列表, null, 2),
          用户信息,
        });
        const 内容 = await 调用补全API带重试(配置, 系统提示词, JSON.stringify({ recentMessages: 最近消息列表 }, null, 2));
        if (内容 === null) {
          失败数++;
          continue;
        }
        const 解析 = 解析模型变量响应(内容);
        const 池 = (当前池[模板.id] && typeof 当前池[模板.id] === 'object' && !Array.isArray(当前池[模板.id]))
          ? 当前池[模板.id]
          : ({} as 模板池表[string]);
        const 合并后 = 合并解析变量(池, 解析.变量);
        当前池[模板.id] = 合并后 as 模板池表[string];
      } catch (e) {
        失败数++;
        console.warn(`[第三部] 额外模型解析模板 ${模板.id} 失败：`, e instanceof Error ? e.message : e);
      }
    }
    const 有效池表: 模板池表 = {};
    for (const [id, 池] of Object.entries(当前池)) {
      if (池 && typeof 池 === 'object' && Object.keys(池 as Record<string, unknown>).length > 0) 有效池表[id] = 池;
    }
    if (Object.keys(有效池表).length === 0) {
      解析状态.value = `#${messageId} 额外模型解析无有效更新${失败数 > 0 ? `（${失败数} 个失败）` : ''}`;
      记录日志('模型解析', `#${messageId} 额外模型解析无有效更新${失败数 > 0 ? `（${失败数} 个失败）` : ''}`, 失败数 > 0 ? 'warn' : 'info');
      return false;
    }
    const ok = 写楼层变量(messageId, 有效池表);
    解析状态.value = ok
      ? `#${messageId} 额外模型解析完成，写入 ${Object.keys(有效池表).length} 个模板池${失败数 > 0 ? `（${失败数} 个失败）` : ''}`
      : `#${messageId} 额外模型解析写楼层变量失败`;
    if (ok) {
      记录日志('模型解析', `#${messageId} 额外模型解析完成，写入 ${Object.keys(有效池表).length} 个模板池${失败数 > 0 ? `（${失败数} 个失败）` : ''}`, 失败数 > 0 ? 'warn' : 'info');
    } else {
      记录日志('模型解析', `#${messageId} 额外模型解析写楼层变量失败：${同步错误.value || '未知原因'}`, 'warn');
    }
    return ok;
  } catch (e) {
    解析状态.value = `额外模型解析失败：${e instanceof Error ? e.message : String(e)}`;
    记录日志('模型解析', `#${messageId} 额外模型解析异常：${e instanceof Error ? e.message : String(e)}`, 'warn');
    return false;
  } finally {
    解析中.value = false;
  }
}

/** 读取某条消息正文（mes） */
function 读取消息正文(messageId: number): string {
  try {
    const chat = SillyTavern.chat;
    if (Array.isArray(chat) && chat[messageId] && typeof chat[messageId].mes === 'string') return chat[messageId].mes;
  } catch {
    // 忽略
  }
  return '';
}

/** 从某楼层读 rp_hub 池表（与 变量单向同步.ts 读取楼层变量 同语义，内联避免循环依赖） */
function 读取楼层变量(messageId: number): 模板池表 {
  try {
    const 全表 = getVariables({ type: 'message', message_id: messageId });
    const 池表 = ((_.get(全表, 'rp_hub', {}) ?? {}) as 模板池表);
    return _.cloneDeep(池表);
  } catch {
    return {};
  }
}

/**
 * 解析一段内容并合并进池表（标签内容走这里）。
 * 优先级：
 *   1. 内容含 <ui_template_updates> 更新块 → 用 转换更新块 按模板 id 分组（多模板正确）；
 *   2. 否则按 解析模型变量响应 解析（单模板 {"variables":...} / 裸数组 $root）写入首个模板。
 */
async function 解析并合并(
  内容: string,
  当前池: 模板池表,
  模板列表: 卡面变量模板[],
  _深度: number,
): Promise<模板池表> {
  // 形态 1：更新块（多模板分组）
  const 块结果 = 转换更新块(内容);
  if (块结果.变量表 && Object.keys(块结果.变量表).length > 0) {
    return { ...当前池, ...块结果.变量表 };
  }
  // 形态 2：单模板变量响应 / 裸数组
  const 结果 = 解析模型变量响应(内容);
  const 首个模板 = 模板列表.find(t => t && typeof t === 'object' && typeof t.id === 'string' && t.id.trim());
  if (结果.变量 && typeof 结果.变量 === 'object' && !Array.isArray(结果.变量)) {
    if (首个模板 && typeof 首个模板.id === 'string') {
      const 池 = (当前池[首个模板.id] && typeof 当前池[首个模板.id] === 'object' && !Array.isArray(当前池[首个模板.id]))
        ? 当前池[首个模板.id]
        : ({} as 模板池表[string]);
      当前池[首个模板.id] = 合并解析变量(池, 结果.变量) as 模板池表[string];
    }
  } else if (Array.isArray(结果.变量) && 首个模板 && typeof 首个模板.id === 'string') {
    当前池[首个模板.id] = 结果.变量 as unknown as 模板池表[string]; // $root 整池替换（对齐 更新块转换.ts 数组形转换）
  }
  return 当前池;
}

/** 用户信息（对齐 RP-Hub buildUserInfoPrompt 的轻量版：称呼/人名） */
function 构建用户信息(): string {
  const 用户名 = 获取用户名();
  return [`user: ${用户名 || '未知用户'}`, `user_name: ${用户名 || ''}`].join('\n');
}

/* ---------- 打开卡注入确认（计划 §2.2 + 去重） ---------- */

/**
 * 是否已在角色绑定世界书中注入过变量更新条目（去重：已注入 → 不再弹确认框 / 不重复注入）。
 * 与注入共用 取世界书名：已绑定 → 直接查条目；未绑定 → 不创建/不绑定（非破坏性，读不到即视为
 * 未注入，可弹确认框）。世界书/API 不可用 → false（视为未注入，可弹确认框）。
 * 新旧名都查：新名 `[RP]变量更新` 或存量旧名 `TH-RP-*` 任一存在都视为已注入（避免切换命名后重复注入）。
 */
export async function 是否已注入世界书(): Promise<boolean> {
  const th = 获取TH();
  if (!TH可用(th)) return false;
  try {
    // 只查已绑定世界书：未绑定 → 未注入（不创建、不绑定，保持非破坏性）
    const 世界书名 = 角色绑定世界书名(th);
    if (!世界书名) return false;
    const thObj = th as { getWorldbook?: (name: string) => Promise<Array<{ name?: string }>> };
    const 条目 = await thObj.getWorldbook?.(世界书名);
    return Array.isArray(条目) && 条目.some(e =>
      typeof e?.name === 'string' && (e.name === 注入条目名 || /^TH-RP-/.test(e.name)));
  } catch {
    return false;
  }
}

/**
 * 弹出「是否注入到世界书」确认框（计划 §2.2）。
 * 用 ST 原生 callGenericPopup（经 SillyTavern.getContext() 取得；函数定义于父窗口模块，
 * 调用时其 realm 为父窗口 → 弹窗渲染在主页面，而非隐藏脚本 iframe）。
 * @returns true = 确定注入；false = 取消 / 弹窗失败（失败不自动注入，避免误操作）
 */
async function 弹注入确认框(卡名: string): Promise<boolean> {
  try {
    const ctx = 获取上下文();
    const 类型 = ctx?.POPUP_TYPE;
    const 结果枚举 = ctx?.POPUP_RESULT;
    const html =
      `<h3>是否注入到世界书？</h3>` +
      `<p>检测到 RP 卡「${卡名}」尚未注入变量更新（[RP]变量更新）到世界书。</p>` +
      `<p>确定后将在此角色绑定的世界书创建变量更新提示词条目（未绑定时按角色名创建并绑定），AI 回复时按标准格式在正文末尾输出更新块。</p>`;
    const 结果 = await ctx?.callGenericPopup?.(html, 类型?.CONFIRM);
    return 结果 === (结果枚举?.AFFIRMATIVE ?? 1);
  } catch (e) {
    console.warn('[第三部] 注入确认弹窗失败（本次不自动注入）：', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/* ---------- 启动 hook ---------- */

/**
 * 打开卡 / 切换聊天时：模式一注入（计划 §2.2 + §2.3）。
 * 触发条件（同时满足）：变量更新总开关开启 + 跟随主模型 + 注入开关开启（E 联动）+ 渲染功能开启
 *   + 卡面存在模板 + 尚未注入过（去重）。
 * 去重：已注入过（世界书已存在 [RP]变量更新 或存量 TH-RP-* 条目）→ 不再弹确认框、不重复注入。
 * 未注入过 → 弹「是否注入到世界书」确认框 → 确定注入 / 取消本次不注入。
 */
export async function 检查并注入(): Promise<void> {
  const 配置 = 读取配置();
  if (!世界书注入应启动(配置)) {
    return;
  }
  // 计划 §2.2 条件 3：渲染功能开启才提示注入
  if (!渲染开关已启用()) {
    return;
  }
  // D 去重：已注入过 → 跳过（不弹框 / 不重复注入）
  if (await 是否已注入世界书()) {
    注入状态.value = '已注入过（世界书存在 [RP]变量更新 条目），跳过';
    记录日志('模型解析', '打开卡：已注入过（世界书存在 [RP]变量更新 条目），跳过确认');
    return;
  }
  const 模板列表 = await 拉取模板列表();
  if (模板列表 === null) {
    注入状态.value = '后端未就绪，跳过注入（切换聊天后重试）';
    记录日志('模型解析', '打开卡：后端未就绪，跳过注入确认', 'warn');
    return;
  }
  // A1：计划 §2.2 条件 2「该卡存在模板」——无模板的卡不弹确认框（之前只判 null，
  // 空数组会继续弹窗，用户确认后才提示「卡面无 uiTemplates」）
  if (模板列表.length === 0) {
    注入状态.value = '卡面无 uiTemplates，跳过注入确认';
    记录日志('模型解析', '打开卡：卡面无 uiTemplates，跳过注入确认');
    return;
  }
  const 卡名 = 获取当前卡名();
  const 确认 = await 弹注入确认框(卡名 ?? '当前卡');
  if (!确认) {
    注入状态.value = '已取消注入（本次不注入，下次打开该卡再询问）';
    记录日志('模型解析', '打开卡：用户取消了注入确认（本次不注入）');
    return;
  }
  await 注入世界书(模板列表, {});
}

/** 启动模型解析服务（index.ts 挂载时调用）：
 *   CHAT_CHANGED → 打开卡注入确认/注入（计划 §2.2/§2.3）；MESSAGE_RECEIVED → 模式二自动解析。 */
export function 启动模型解析服务(): void {
  // 模式二：AI 回复后自动额外解析（MESSAGE_RECEIVED 在后段执行，等正文落定；
  // 变量更新总开关关闭 → 不做任何变量操作，跳过）
  try {
    (eventOn as (事件: unknown, 处理器: (message_id: number) => void) => { stop: () => void })(
      tavern_events.MESSAGE_RECEIVED,
      message_id => {
        if (!变量同步开关已启用()) return;
        const 配置 = 读取配置();
        if (配置.模式 !== '额外模型解析') return;
        void (async () => {
          const 模板列表 = await 拉取模板列表();
          if (模板列表 === null) {
            解析状态.value = '后端未就绪，跳过自动解析';
            记录日志('模型解析', '自动解析跳过：后端未就绪', 'warn');
            return;
          }
          await 额外模型解析(message_id, 模板列表);
        })();
      },
    );
  } catch {
    // 忽略（事件 API 不可用 → 仅手动触发）
  }
  // 打开卡/切换聊天 → 注入确认/注入（计划 §2.2 去重 + §2.3 联动）
  try {
    (eventOn as (事件: unknown, 处理器: () => void) => { stop: () => void })(tavern_events.CHAT_CHANGED, () => {
      void 检查并注入();
    });
  } catch {
    // 忽略
  }
  // 挂载时对当前聊天检查注入
  void 检查并注入();

  console.info('[第三部] 模型解析服务已启动：模式一 世界书注入（跟随主模型 + 打开卡确认）+ 模式二 额外模型解析（OpenAI 兼容 API）');
}
