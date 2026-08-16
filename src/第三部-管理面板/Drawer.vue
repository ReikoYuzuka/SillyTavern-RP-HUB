<template>
  <!-- 真全屏弹出：Teleport 挂【主文档】body，脱离 #extensions_settings2 容器限制（玄狐式 body 挂载），
       遮罩 position:fixed;inset:0 占满视口 + z-index:999999 最高层。入口按钮仍留在设置页（界面.vue）。
       ⚠️ 目标必须传主文档 body 元素（mainBody），不能写字符串 "body"：本扩展跑在酒馆助手
       隐藏脚本 iframe（TH-script--*，display:none）内，Vue runtime-dom 在模块加载时捕获的是
       iframe 的 document（nodeOps.querySelector = doc.querySelector），字符串 to="body" 会被解析成
       iframe 的 body → overlay 进隐藏 iframe → 点击无反应（实测根因）。传元素对象走 Teleport
       非字符串分支直接使用目标，绕过 iframe 的 querySelector。 -->
  <Teleport :to="mainBody">
    <div class="thp-overlay" :class="{ 'thp-overlay-open': open }" @click.self="close">
      <!-- 全屏遮罩 + 视口居中 modal（水平垂直居中，96vw×96vh 全屏铺满自适应） -->
      <section class="thp-modal" role="dialog" aria-modal="true" aria-label="RP助手">
        <header class="thp-modal-header">
          <div class="thp-modal-title">
            <span class="thp-modal-logo">▣</span>
            <span>RP助手</span>
          </div>
          <button class="thp-btn thp-btn-ghost thp-close-btn" type="button" title="关闭" @click="close">✕</button>
        </header>

        <div class="thp-modal-body">
          <nav class="thp-nav">
            <button
              v-for="tab in tabs"
              :key="tab.key"
              type="button"
              class="thp-nav-item"
              :class="{ 'thp-nav-active': active === tab.key }"
              @click="active = tab.key"
            >
              <span class="thp-nav-icon">{{ tab.icon }}</span>
              <span>{{ tab.label }}</span>
            </button>
          </nav>

          <main class="thp-content">
            <section v-show="active === 'diagnose'" class="thp-tab-page">
              <TabDiagnose />
            </section>
            <section v-show="active === 'variables'" class="thp-tab-page">
              <TabVariables />
            </section>
            <section v-show="active === 'floors'" class="thp-tab-page">
              <TabFloors />
            </section>
            <section v-show="active === 'templates'" class="thp-tab-page">
              <TabTemplates />
            </section>
          </main>
        </div>

        <footer class="thp-modal-footer">
          <span>v1.0.0 · 单向楼层变量方案</span>
          <button class="thp-btn thp-btn-sm thp-btn-ghost" type="button" @click="close">关闭</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import TabDiagnose from './TabDiagnose.vue';
import TabFloors from './TabFloors.vue';
import TabTemplates from './TabTemplates.vue';
import TabVariables from './TabVariables.vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

/**
 * Teleport 目标 = 【主文档】body 元素（Fix A，状态栏点不动排查-真全屏回归根因修复）。
 *
 * 背景：本扩展脚本跑在酒馆助手隐藏脚本 iframe（TH-script--*，display:none）内。Vue
 * runtime-dom 在 bundle 模块加载时捕获 document（nodeOps: `const doc = typeof document
 * !== 'undefined' ? document : null` + `querySelector: sel => doc.querySelector(sel)`）——
 * 捕获的是 iframe 的 document。Teleport 字符串目标（to="body"）经 resolveTarget →
 * select('body') → doc.querySelector('body') 解析成 iframe 的 <body> → overlay 被送进
 * 隐藏 iframe → 点击「打开面板」无反应（浏览器实测：主文档 .thp-overlay count=0）。
 *
 * 修复：取 window.parent.document.body（主文档，app 入口即挂主文档 #extensions_settings2，
 * srcdoc iframe 与主文档同源可访问）传【元素对象】——Teleport 对非字符串目标走
 * resolveTarget 直接返回该元素分支，不再经过 iframe 的 querySelector。overlay 节点插入
 * 主文档 body 时自动 adopt（与 app 挂载用父窗口 jQuery 同一机制）。
 *
 * 降级：parent 访问异常 / 无 parent（非 iframe 直接运行，如调试）→ 返回 null → Teleport
 * 不移动目标（overlay 留在 app 容器内，仍可见可点，功能不丢）。
 */
const mainBody = computed<HTMLElement | null>(() => {
  try {
    const p = (window.parent as Window | null)?.document;
    if (p?.body) return p.body as HTMLElement;
  } catch {
    // 跨域 / 访问异常 → 降级 null
  }
  return null; // null → Teleport 不移动，overlay 留在 app 容器内（仍可见）
});

const active = ref('diagnose');

const tabs = [
  { key: 'diagnose', label: '诊断', icon: '◉' },
  { key: 'variables', label: '变量管理', icon: '◈' },
  { key: 'floors', label: '变量楼层', icon: '◩' },
  { key: 'templates', label: '模板 / 渲染', icon: '▤' },
];

const close = () => {
  emit('close');
};

const on_keydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.open) {
    close();
  }
};

// UI-A1 修复：modal Teleport 到父文档、焦点在父文档 → Escape 监听须挂在 parent（脚本跑在隐藏 iframe）
function 父窗口(): Window {
  try { return window.parent && window.parent !== window ? window.parent : window; } catch { return window; }
}

onMounted(() => {
  父窗口().addEventListener('keydown', on_keydown);
});

onBeforeUnmount(() => {
  父窗口().removeEventListener('keydown', on_keydown);
});
</script>
