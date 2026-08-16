<template>
  <div class="thp-tab-page">
    <!-- 运行日志 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">运行日志</h3>
        <div class="thp-btn-group">
          <span class="thp-badge">{{ 运行日志列表.length }} 条</span>
          <button class="thp-btn thp-btn-sm" type="button" @click="清空日志">清空日志</button>
        </div>
      </header>
      <div class="thp-log-box">
        <div v-if="运行日志列表.length === 0" class="thp-log-empty">
          <p>暂无日志</p>
          <span>变量同步 / 模板渲染 / 模型解析 / 楼层记录 / 导入拦截 的操作记录会实时显示在这里（内存保留最近 200 条）</span>
        </div>
        <div v-else class="thp-log-list">
          <div
            v-for="日志 in 运行日志列表"
            :key="日志.id"
            class="thp-log-item"
            :class="`thp-log-${日志.级别}`"
          >
            <code class="thp-log-time">{{ 日志.时间 }}</code>
            <code class="thp-log-source">{{ 日志.来源 }}</code>
            <span class="thp-log-text">{{ 日志.内容 }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 卡面状态 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">卡面状态</h3>
        <button class="thp-btn thp-btn-sm thp-btn-ghost" type="button" :disabled="loading" @click="刷新状态">
          {{ loading ? '刷新中…' : '刷新状态' }}
        </button>
      </header>

      <p v-if="!has_selected" class="thp-hint thp-hint-warn">当前未选中角色（或处于群聊未指定角色），以下字段显示为 —</p>

      <dl class="thp-kv">
        <div class="thp-kv-item">
          <dt>当前卡名</dt>
          <dd>{{ 卡名 }}</dd>
        </div>
        <div class="thp-kv-item">
          <dt>是否 RP 卡</dt>
          <dd>{{ 是否RP卡 }}</dd>
        </div>
        <div class="thp-kv-item">
          <dt>formatDetail</dt>
          <dd>{{ formatDetail }}</dd>
        </div>
        <div class="thp-kv-item">
          <dt>变量数</dt>
          <dd>{{ 变量数 }}</dd>
        </div>
        <div class="thp-kv-item">
          <dt>卡面模板</dt>
          <dd>{{ 卡面模板 }}</dd>
        </div>
        <div class="thp-kv-item">
          <dt>渲染状态</dt>
          <dd>{{ 渲染状态 }}</dd>
        </div>
        <div class="thp-kv-item">
          <dt>注入状态</dt>
          <dd>{{ 注入状态 }}</dd>
        </div>
        <div class="thp-kv-item">
          <dt>解析状态</dt>
          <dd>{{ 解析状态 }}</dd>
        </div>
      </dl>
      <p v-if="提示" class="thp-hint">{{ 提示 }}</p>
    </section>

    <!-- 全局模板渲染开关 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">全局模板渲染开关</h3>
      </header>
      <label class="thp-switch-row">
        <input v-model="渲染开关" type="checkbox" />
        <span class="thp-switch"></span>
        <span class="thp-switch-label">启用模板渲染（开启后才会进行模板渲染）</span>
      </label>
      <p class="thp-hint">
        全局总控：与「模板 / 渲染」页的渲染总开关为同一个开关（localStorage
        <code class="thp-inline-code">thp_template_render_enabled</code>），两处 UI 联动。
        关闭后不进行任何模板渲染操作。
      </p>
    </section>

    <!-- 常用功能 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">常用功能</h3>
      </header>
      <div class="thp-btn-group">
        <button class="thp-btn" type="button" :disabled="注入中" @click="手动注入变量">手动注入变量</button>
        <button class="thp-btn" type="button" :disabled="解析中" @click="重新触发解析">重新触发解析</button>
        <button class="thp-btn" type="button" :disabled="loading" @click="刷新状态">刷新状态</button>
        <button class="thp-btn" type="button" :disabled="重渲染中" @click="强制重新渲染">
          {{ 重渲染中 ? '重渲染中…' : '强制重新渲染' }}
        </button>
      </div>
      <p class="thp-hint">{{ 注入状态 }}</p>
      <p class="thp-hint">{{ 解析状态 }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { 用聊天切换自动刷新 } from './自动刷新';
import { 强制重渲染全部, 渲染开关响应式, 设置渲染开关, 渲染状态 as 模板渲染服务状态 } from './模板渲染服务';
import { 扁平化变量表 } from './楼层变量';
import { 运行日志列表, 清空运行日志 } from './运行日志';
import {
  注入世界书,
  额外模型解析,
  拉取模板列表,
  注入状态,
  解析状态,
  解析中,
} from './模型解析服务';

/** rp-hub-compat 后端插件地址（相对路径，ST 自动补当前 origin，换端口/域名/局域网都通） */
const BASE = (() => {
  // srcdoc iframe 内相对路径 base 继承可能异常 → 用父窗口 origin 拼绝对路径（跟随部署 origin，不写死）
  try { const o = (window.parent ?? window)?.location?.origin; if (o) return o + '/api/plugins/rp-hub-compat/v1'; } catch {}
  return '/api/plugins/rp-hub-compat/v1';
})();

const 卡名 = ref('—');
const 是否RP卡 = ref('—');
const formatDetail = ref('—');
const 变量数 = ref('—');
const 卡面模板 = ref('—');
const 提示 = ref('');

const loading = ref(false);
const 重渲染中 = ref(false);

/** 清空运行日志（内存日志） */
function 清空日志(): void {
  清空运行日志();
}

/**
 * 全局模板渲染开关（A3：与「模板 / 渲染」页同一响应式 ref，两处实时联动；
 * set 经 设置渲染开关 同步 localStorage + ref + 清理/收敛存量渲染）。
 */
const 渲染开关 = computed({
  get: () => 渲染开关响应式.value,
  set: (v: boolean) => 设置渲染开关(v),
});

/** 渲染状态展示：总开关 + 服务最近状态 */
const 渲染状态 = computed(() => `${渲染开关响应式.value ? '开启' : '关闭'}${模板渲染服务状态.value ? ` · ${模板渲染服务状态.value}` : ''}`);

/** 手动注入到世界书（模式一；创建真实世界书条目，世界书面板可见） */
const 注入中 = ref(false);
async function 手动注入变量() {
  if (注入中.value) return;
  注入中.value = true;
  try {
    const 模板列表 = await 拉取模板列表();
    const ok = await 注入世界书(模板列表, {});
    toastr[ok ? 'success' : 'warning'](注入状态.value || (ok ? '已注入世界书' : '注入失败'));
  } finally {
    注入中.value = false;
  }
}

/** 重新触发额外解析（模式二；对最后一条 AI 回复） */
async function 重新触发解析() {
  if (解析中.value) return;
  try {
    const 模板列表 = await 拉取模板列表();
    if (模板列表 === null) {
      toastr.warning('后端（rp-hub-compat）未就绪，无法拉取模板列表');
      return;
    }
    const 最后AI = 找最后AI楼层();
    if (最后AI === null) {
      toastr.warning('当前聊天无 AI 回复，无可解析');
      return;
    }
    const ok = await 额外模型解析(最后AI, 模板列表);
    toastr[ok ? 'success' : 'warning'](解析状态.value || (ok ? '额外解析完成' : '额外解析无更新'));
  } catch (e) {
    toastr.error(`额外解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 找当前聊天最后一条 AI 消息下标 */
function 找最后AI楼层(): number | null {
  try {
    const chat = SillyTavern.chat;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
      const 消息 = chat[i];
      if (消息 && !消息.is_system && !消息.is_user && typeof 消息.mes === 'string') return i;
    }
  } catch {
    // 忽略
  }
  return null;
}

/** 是否已选中角色（有有效的 this_chid 且角色列表中取得到名字）。
 *  UI-D1 修复：依赖响应式 ref（卡名），避免直读非响应式 SillyTavern.characterId 导致提示粘滞 */
const has_selected = computed(() => 卡名.value !== '—' && 卡名.value !== '');

/** 读取当前卡名：SillyTavern.getContext().characterId / characters（脚本 iframe 可用） */
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

/** 纯 GET 请求，跨域 CORS（Access-Control-Allow-Origin: null）下无需预检，失败返回 null 不抛错 */
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
  formatDetail: string | null;
  marked: boolean;
}

interface VariablesView {
  cardId: string;
  variables: { uiTemplates?: Array<{ variableState?: unknown; initialVariableState?: unknown } | null | undefined> };
}

/** 取模板的 variableState / initialVariableState（跳过空对象，避免 `{}` 覆盖掉有值的 initial） */
function 取模板状态(模板: { variableState?: unknown; initialVariableState?: unknown } | null | undefined): unknown {
  if (!模板) return null;
  const 有值 = (v: unknown): boolean => Array.isArray(v) ? v.length > 0 : !!(v && typeof v === 'object' && Object.keys(v as object).length > 0);
  if (有值(模板.variableState)) return 模板.variableState;
  if (有值(模板.initialVariableState)) return 模板.initialVariableState;
  return 模板.variableState ?? 模板.initialVariableState;
}

/** 单模板变量计数：数组（$root）按元素条数；对象按扁平化叶子键数；空/缺失 → 0 */
function 计数模板变量(模板: { variableState?: unknown; initialVariableState?: unknown } | null | undefined): number {
  const 状态 = 取模板状态(模板);
  if (Array.isArray(状态)) return 状态.length;
  if (状态 && typeof 状态 === 'object') return Object.keys(扁平化变量表(状态)).length;
  return 0;
}

/** rp-hub-compat（第二部）挂到 window 上的全局入口：强制重新渲染桥。 */
interface 兼容桥 {
  clearModeCache?: () => void;
  forceRerenderAll?: () => Promise<{ count: number; skipped: number }>;
}

/**
 * 读取第二部挂的 window.__rphubCompat__（全部层级都找不到时返回 null）。
 * 第三部脚本跑在酒馆助手 iframe（about:srcdoc），iframe 的 window ≠ 主页面 window；
 * 第二部 mountCompatApi() 挂在主页面 window 上。逐层回退查找：
 *   window → window.parent → window.top，任一找到即返回。
 * window.parent / window.top 可能跨源抛错 → 每层独立 try/catch，失败继续向上。
 */
function 获取兼容桥(): 兼容桥 | null {
  const 层级: Array<Window | null> = [];
  try { 层级.push(window); } catch { /* 忽略（window 访问异常） */ }
  try { 层级.push(window.parent); } catch { /* 跨源 / 访问异常，忽略 */ }
  try { 层级.push(window.top); } catch { /* 跨源 / 访问异常，忽略 */ }
  for (const g of 层级) {
    try {
      const api = (g as unknown as Record<string, unknown> | null | undefined)?.__rphubCompat__;
      if (api && typeof api === 'object') return api as 兼容桥;
    } catch {
      // 该层访问异常 → 尝试上一层
    }
  }
  return null;
}

/**
 * 强制重新渲染（解决换浏览器/刷新后正常、但缓存导致界面未围栏化/未渲染）：
 *  ① 第二部：清 formatDetail 内存缓存（30 分钟 TTL）→ 遍历当前聊天逐条重算
 *     （forceRerenderAll：脏 rph_display 重算为干净，走围栏化判定）+ 覆盖 DOM。
 *  ② 第三部：forceRerenderAll 对模板消息（rph_template_render）让位 display_text/DOM
 *     （display.js:94 守卫 + pure.js:174）且不发射任何事件 → display_text 仍旧内容。
 *     追加 强制重渲染全部()：清合并缓存 → 逐条 渲染单条（写干净 display_text + 标记）→
 *     触发 CHARACTER_MESSAGE_RENDERED 让酒馆助手补建 iframe。
 *  后台执行（逐条 await 让出主线程，不卡 UI）。第二部未加载 → toastr 提示。
 *  汇报区分：第二部重算 count + 第三部重渲染 count。
 */
async function 强制重新渲染() {
  if (重渲染中.value) return;
  const 桥 = 获取兼容桥();
  if (!桥 || typeof 桥.forceRerenderAll !== 'function') {
    toastr.warning('rp-hub-compat 扩展未加载（第二部未启用，无法强制重新渲染）');
    return;
  }
  重渲染中.value = true;
  let 第二部count = 0;
  let 第二部跳过 = 0;
  try {
    // ① 第二部：数据层重算（含脏 rph_display → 干净）
    try {
      const 第二部结果 = await 桥.forceRerenderAll();
      第二部count = 第二部结果?.count ?? 0;
      第二部跳过 = 第二部结果?.skipped ?? 0;
    } catch (error) {
      console.error('[第三部] 第二部强制重算失败：', error);
      toastr.error(`第二部强制重算失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // ② 第三部：模板消息显示链补齐（forceRerenderAll 不触发第三部渲染 → display_text 仍旧）
    let 第三部count = 0;
    let 第三部跳过 = 0;
    try {
      const 第三部结果 = await 强制重渲染全部();
      第三部count = 第三部结果?.count ?? 0;
      第三部跳过 = 第三部结果?.skipped ?? 0;
    } catch (error) {
      console.error('[第三部] 强制重渲染全部失败：', error);
      toastr.error(`强制重渲染全部失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const 总计 = 第二部count + 第三部count;
    if (总计 > 0) {
      toastr.success(
        `已强制重新渲染 ${总计} 条消息（第二部重算 ${第二部count} 条${第二部跳过 > 0 ? `，跳过 ${第二部跳过}` : ''}；第三部重渲染 ${第三部count} 条${第三部跳过 > 0 ? `，跳过 ${第三部跳过}` : ''}）`,
      );
    } else {
      toastr.success('已强制重新渲染完成（当前无可处理的消息）');
    }
  } finally {
    重渲染中.value = false;
  }
}

async function 刷新状态() {
  if (loading.value) return;
  loading.value = true;

  卡名.value = '—';
  是否RP卡.value = '—';
  formatDetail.value = '—';
  变量数.value = '—';
  卡面模板.value = '—';
  提示.value = '';

  const name = 获取当前卡名();
  if (!name) {
    提示.value = '未选中角色，请先在角色列表中选择一张卡后再刷新。';
    loading.value = false;
    return;
  }
  卡名.value = name;

  // 后端 by-name：是否 RP 卡 / 手动标记 / formatDetail
  const by_name = await 请求<ByName>(`${BASE}/cards/by-name/${encodeURIComponent(name)}`);
  if (by_name) {
    是否RP卡.value = by_name.formatDetail === 'rphub' ? '是' : '否';
    formatDetail.value = by_name.formatDetail ?? '—';
    提示.value = by_name.formatDetail === 'rphub' ? '格式识别：RP-Hub' : '格式识别：ST / 未知';

    if (by_name.marked) {
      是否RP卡.value += '（手动标记）';
      提示.value += ' · 已手动标记为 RP 卡';
    }

    // 后端 variables 视图：uiTemplates 数量 + 模板变量总数（扁平化各模板变量池）
    const vars = await 请求<VariablesView>(`${BASE}/cards/${by_name.cardId}/variables?fields=uiTemplates`);
    const templates = vars?.variables?.uiTemplates;
    if (Array.isArray(templates)) {
      卡面模板.value = templates.length > 0 ? `有（${templates.length} 个）` : '无';
      const 模板数 = templates.filter(t => t && typeof t === 'object').length;
      // 变量数 = 各模板 variableState（回退 initialVariableState，跳过空对象）扁平化叶子键数 + 数组条数
      const 键数 = templates.reduce((n, t) => n + 计数模板变量(t), 0);
      变量数.value = String(键数);
      提示.value += ` · ${模板数} 个模板 · ${键数} 个变量键（variableState/initialVariableState 扁平化，数组形按条数）`;
    }
  } else {
    是否RP卡.value = '—';
    formatDetail.value = '—';
    提示.value = '后端（rp-hub-compat）未找到该卡记录，RP 卡判定与模板信息不可用。';

    // 兜底：酒馆助手当前聊天变量数
    try {
      const variables = getVariables({ type: 'chat' });
      const count = variables && typeof variables === 'object' ? Object.keys(variables).length : 0;
      变量数.value = String(count);
    } catch {
      变量数.value = '—';
    }
  }

  loading.value = false;
}

用聊天切换自动刷新(刷新状态);
</script>
