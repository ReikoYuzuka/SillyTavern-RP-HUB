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
 * F3：宿主 id 携带脚本实例标识（getScriptId 同一脚本热重载稳定、不同脚本实例唯一）
 * → 根除「多个同模板扩展共用 #rph-drawer-teleport-host」的互踩问题。
 */
const TELEPORT_HOST_ID = (() => {
  let 标识 = 'default';
  try {
    const raw = getScriptId?.() ?? '';
    const 清洗 = String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (清洗) 标识 = 清洗;
  } catch {
    // getScriptId 不可用（极端环境）→ 用默认标识，退化为共享 id 但不崩溃
  }
  return `rph-drawer-teleport-host-${标识}`;
})();

/**
 * 只清理【属于本实例】的孤儿宿主（同 id 只可能来自本脚本的上一具残留 iframe）。
 * 不再全局扫描 .thp-overlay —— 全局清扫会误删其它扩展/卡面的同名节点（F3 验证结论）。
 * 调用时机必须严格限定：宿主创建【之前】（setup 首建）或本组件卸载/pagehide（清自己的尾巴）。
 * ⚠️ 严禁在 onMounted 里调用 —— computed 无响应式依赖永不重建，那会把刚挂载自身内容的
 * 宿主一并拆掉且永不恢复（旧实现的面板自拆缺陷根因）。
 */
function 清理自身孤儿宿主(): void {
  try {
    const doc = (window.parent as Window | null)?.document;
    const 旧宿主 = doc?.getElementById(TELEPORT_HOST_ID);
    if (旧宿主) 旧宿主.remove();
  } catch {
    // 跨域 / 访问异常忽略
  }
}

/**
 * Teleport 目标 = 【主文档】专属宿主容器元素。先扫后建：先移除本实例的孤儿宿主，
 * 再创建并追加新宿主（保证 Teleport 内容挂进的是本次新建的存活节点）。
 */
const mainBody = computed<HTMLElement | null>(() => {
  try {
    const p = (window.parent as Window | null)?.document;
    if (p?.body) {
      清理自身孤儿宿主();
      let host = p.getElementById(TELEPORT_HOST_ID);
      if (!host) {
        host = p.createElement('div');
        host.id = TELEPORT_HOST_ID;
        p.body.appendChild(host);
      }
      return host as HTMLElement;
    }
  } catch {
    // 跨域 / 访问异常 → 降级 null
  }
  return null;
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

function 父窗口(): Window {
  try { return window.parent && window.parent !== window ? window.parent : window; } catch { return window; }
}

onMounted(() => {
  // F3：不再做任何清理（自拆缺陷）——孤儿清扫已前置到 mainBody 首建；此处只挂监听
  父窗口().addEventListener('keydown', on_keydown);
  $(window).on('pagehide', 清理自身孤儿宿主);
});

onBeforeUnmount(() => {
  父窗口().removeEventListener('keydown', on_keydown);
  $(window).off('pagehide', 清理自身孤儿宿主);
  清理自身孤儿宿主();
});
</script>
