<template>
  <div class="thp-tab-page">
    <!-- 渲染总开关 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">渲染总开关</h3>
      </header>
      <label class="thp-switch-row">
        <input v-model="渲染开关" type="checkbox" />
        <span class="thp-switch"></span>
        <span class="thp-switch-label">启用卡面模板渲染（占位）</span>
      </label>
      <p class="thp-hint">关闭后不进行任何模板渲染操作</p>
    </section>

    <!-- 脚本脏 span 清理开关 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">脚本脏 span 清理</h3>
      </header>
      <label class="thp-switch-row">
        <input v-model="脚本清理开关" type="checkbox" />
        <span class="thp-switch"></span>
        <span class="thp-switch-label">启用脚本内脏 span 清理（默认关闭）</span>
      </label>
      <p class="thp-hint">
        用于卡内嵌正则与预设脚本冲突场景：脚本块内出现单引号粉色装饰 span（插进 JS 字符串内部
        导致语法错误、按钮点不动）时，自动把该 span 还原为纯文本。默认关闭（不介入、原样渲染）；
        遇到狐策类按钮点不动再手动开启。
      </p>
    </section>

    <!-- 滚动锁定 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">滚动锁定</h3>
      </header>
      <label class="thp-switch-row">
        <input v-model="滚动锁定开关" type="checkbox" />
        <span class="thp-switch"></span>
        <span class="thp-switch-label">锁定聊天滚动位置（默认开启）</span>
      </label>
      <p class="thp-hint">
        防止脚本全量刷新（如玄狐 forceRefreshAll 重渲染所有楼层、删除状态面板 iframe）导致聊天滚动
        跳回顶部。仅当向上跳位（clamp 到顶）时恢复；向下（新消息自动滚到底）不干预。
      </p>
    </section>

    <!-- 开场白正文「已渲染」检测（路线 B 二次包裹修复） -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">开场白正文「已渲染」检测</h3>
      </header>
      <p class="thp-hint">
        开场白（路线 B scoped 桥）把正文交给第二部重渲染前，先按下面检测「正文是否已被第二部第一遍
        渲染过」（如已含沉浸式容器/正文美化容器的渐变盒）。命中任一 → 跳过重渲染，避免二次包裹
        （span&gt;div&gt;span 畸形嵌套）。
      </p>
      <textarea
        v-model="已渲染模式文本"
        class="thp-textarea"
        rows="7"
        spellcheck="false"
        placeholder="每行一条，例如：&#10;/^&lt;div\b[^&gt;]*background/&#10;linear-gradient(135deg,#fff5f7&#10;linear-gradient(180deg, rgba(28,21,19&#10;linear-gradient(#fffafa,#f8f0f0"
      ></textarea>
      <div class="thp-btn-group">
        <button class="thp-btn thp-btn-primary" type="button" @click="保存已渲染模式">保存</button>
        <button class="thp-btn" type="button" @click="恢复默认已渲染模式">恢复默认</button>
      </div>
      <p class="thp-hint">当前 {{ 已渲染正文模式响应式.length }} 条检测模式。</p>
      <div class="thp-hint" style="line-height: 1.8;">
        <b>怎么写（新增卡片时）：</b><br />
        0. 默认已带一条<b>通用正则</b> <code>/^&lt;div\b[^&gt;]*background/</code>（正文以带背景样式的
        <code>&lt;div</code> 开头即视为已渲染），大多数「整段包裹容器」卡都不用另外加。<br />
        1. 要更精确时，直接复制正文容器样式里<b>一段独特的特征文字</b>（推荐渐变颜色值那一截），不用加反斜杠转义。<br />
        2. 例：卡片正文被包进
        <code>&lt;div style="background: linear-gradient(180deg, rgba(28,21,19…)"&gt;</code> →
        填 <code>linear-gradient(180deg, rgba(28,21,19</code> 即可。<br />
        3. 需要模糊匹配（如容忍空格差异）时才用正则，写成 <code>/linear-gradient\(180deg,\s*rgba/</code> 这种
        <code>/…/</code> 包裹形式。<br />
        4. 每条一行；留空行忽略；命中即视为「已渲染」，跳过二次渲染。
      </div>
    </section>

    <!-- 说明 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">说明</h3>
      </header>
      <p class="thp-note">
        检测到卡面带模板标记时，将提示是否启用渲染（占位）。<br />
        启动渲染后，该卡的模板渲染功能生效。
      </p>
    </section>

    <!-- 操作 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">操作</h3>
      </header>
      <div class="thp-btn-group thp-btn-group-stack">
        <button class="thp-btn" type="button" :disabled="检测中" @click="检测当前卡模板">
          {{ 检测中 ? '检测中…' : '检测当前卡模板' }}
        </button>
        <button class="thp-btn thp-btn-primary" type="button" @click="启动渲染">启动渲染</button>
        <button class="thp-btn thp-btn-danger" type="button" @click="停止渲染">停止渲染</button>
      </div>
      <p v-if="检测结果" class="thp-hint">{{ 检测结果 }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { 渲染开关响应式, 设置渲染开关, 脚本清理响应式, 设置脚本清理开关, 拉取模板定义, 渲染错误, 已渲染正文模式响应式, 设置已渲染正文模式, 重置已渲染正文模式, 默认已渲染正文模式 } from './模板渲染服务';
import { 滚动锁定响应式, 设置滚动锁定开关 } from './滚动锁定';

// A3：渲染总开关（与「诊断」页同一响应式 ref，两处实时联动；set 同步
// localStorage + ref + 清理/收敛存量渲染）。
const 渲染开关 = computed({
  get: () => 渲染开关响应式.value,
  set: (v: boolean) => 设置渲染开关(v),
});

// 脚本脏 span 清理开关（狐策方案 A v10）：读写 localStorage 键 thp_script_clean_enabled，
// 默认关闭（thp_script_clean_enabled 非 'true' 即禁用）。用于卡内嵌正则与预设脚本冲突场景。
const 脚本清理开关 = computed({
  get: () => 脚本清理响应式.value, // UI-C1 修复：用响应式 ref 联动（直读 localStorage 会导致复选框假联动）
  set: (v: boolean) => 设置脚本清理开关(v),
});

// 滚动锁定开关（读写 localStorage 键 thp_scroll_lock_enabled，默认开启）：防止脚本全量刷新
// 导致聊天滚动跳回顶部。set 同步 localStorage + ref + 挂载/卸载滚动锁定服务。
const 滚动锁定开关 = computed({
  get: () => 滚动锁定响应式.value,
  set: (v: boolean) => 设置滚动锁定开关(v),
});

/* ---------- 开场白正文「已渲染」检测（路线 B 二次包裹修复，默认值可自定义） ---------- */

// 文本框内容 = 当前检测模式逐行拼接；保存时按换行拆分写回服务层。
const 已渲染模式文本 = ref(已渲染正文模式响应式.value.join('\n'));

function 保存已渲染模式() {
  const 行 = 已渲染模式文本.value.split('\n').map((x) => x.trim()).filter(Boolean);
  设置已渲染正文模式(行);
  已渲染模式文本.value = 已渲染正文模式响应式.value.join('\n');
  toastr.success(`已保存 ${已渲染正文模式响应式.value.length} 条开场白正文已渲染检测模式`);
}

function 恢复默认已渲染模式() {
  重置已渲染正文模式();
  已渲染模式文本.value = 默认已渲染正文模式.join('\n');
  toastr.success(`已恢复默认 ${默认已渲染正文模式.length} 条检测模式`);
}

/* ---------- B1：操作按钮接线（原为占位） ---------- */

const 检测中 = ref(false);
const 检测结果 = ref('');

/** 检测当前卡模板：拉取后端 uiTemplates（复用模板渲染服务缓存），结果 toastr + 页内提示 */
async function 检测当前卡模板() {
  if (检测中.value) return;
  检测中.value = true;
  检测结果.value = '';
  try {
    const 列表 = await 拉取模板定义();
    if (列表 === null) {
      const 提示 = 渲染错误.value || '未匹配到当前卡模板（后端未就绪 / 未选中角色 / 卡无记录）';
      检测结果.value = 提示;
      toastr.warning(提示);
    } else if (列表.length === 0) {
      检测结果.value = '当前卡无 uiTemplates（无模板可渲染）';
      toastr.info(检测结果.value);
    } else {
      const 启用数 = 列表.filter(t => t && t.enabled !== false).length;
      检测结果.value = `检测到 ${列表.length} 个模板（${启用数} 个启用）`;
      toastr.success(检测结果.value);
    }
  } finally {
    检测中.value = false;
  }
}

/** 启动渲染 = 打开渲染总开关（设置渲染开关 会立即对当前聊天收敛恢复模板界面） */
function 启动渲染() {
  设置渲染开关(true);
  toastr.success('已启动模板渲染（全局渲染开关已开启，存量消息正在收敛）');
}

/** 停止渲染 = 关闭渲染总开关（设置渲染开关 会立即清理存量模板渲染还原为纯正文） */
function 停止渲染() {
  设置渲染开关(false);
  toastr.success('已停止模板渲染（存量模板界面已还原为纯正文）');
}
</script>
