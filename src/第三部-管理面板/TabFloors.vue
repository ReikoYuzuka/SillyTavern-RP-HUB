<template>
  <div class="thp-tab-page">
    <!-- 说明 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">变量楼层</h3>
        <div class="thp-btn-group">
          <button class="thp-btn thp-btn-sm thp-btn-ghost" type="button" @click="刷新">刷新</button>
          <button
            class="thp-btn thp-btn-sm thp-btn-danger"
            type="button"
            :disabled="记录列表.length === 0"
            @click="清空"
          >
            清空本聊天记录
          </button>
        </div>
      </header>
      <p class="thp-hint">当前聊天：<code class="thp-inline-code">{{ 当前聊天ID || '—' }}</code></p>
      <p class="thp-hint">
        采集：AI 消息到达（MESSAGE_RECEIVED / MESSAGE_UPDATED 等）后读取该楼层消息自身的变量（message 层 rp_hub，由变量单向同步服务写入），生成逐楼快照与变更记录；localStorage 仅存变更历史，快照值以酒馆助手为准。
      </p>
      <p class="thp-hint">
        删除：删除目标楼层后，该楼层变量随消息一同消失（酒馆助手天然处理，无需写回还原），本表同时清理对应记录。
      </p>
    </section>

    <!-- 楼层记录列表 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">楼层记录</h3>
        <span class="thp-badge">{{ 记录列表.length }} 条</span>
      </header>

      <div v-if="记录列表.length === 0" class="thp-log-empty thp-var-empty">
        <p>暂无楼层变量记录</p>
        <span>生成几条 AI 消息后会自动采集；切换聊天后此处随之切换。</span>
      </div>
      <div v-else class="thp-floor-list">
        <div v-for="记录 in 记录列表" :key="String(记录.messageId)" class="thp-floor-item">
          <div class="thp-floor-head">
            <code class="thp-floor-id">#{{ 记录.messageId }}</code>
            <span class="thp-floor-time">{{ 格式化时间(记录.timestamp) }}</span>
            <span class="thp-badge" :class="变更数(记录) > 0 ? 'thp-badge-change' : 'thp-badge-none'">
              {{ 变更数(记录) > 0 ? `${变更数(记录)} 个变量变更` : '无变更' }}
            </span>
            <button class="thp-btn thp-btn-sm thp-btn-ghost" type="button" @click="切换展开(String(记录.messageId))">
              {{ 展开集合.has(String(记录.messageId)) ? '收起' : '展开' }}
            </button>
          </div>

          <div v-if="展开集合.has(String(记录.messageId))" class="thp-floor-detail">
            <template v-if="变更数(记录) > 0">
              <p class="thp-floor-section-title">变量变更（diff · 相对上一楼）</p>
              <div class="thp-diff-table">
                <div class="thp-diff-row thp-diff-head">
                  <span>变量名</span>
                  <span>旧值</span>
                  <span>新值</span>
                </div>
                <div v-for="(变化, 名) in 记录.diff" :key="名" class="thp-diff-row">
                  <code class="thp-diff-key">{{ 名 }}</code>
                  <code class="thp-diff-old">{{ 显示值(变化.旧值) }}</code>
                  <code class="thp-diff-new">{{ 显示值(变化.新值) }}</code>
                </div>
              </div>
            </template>
            <p class="thp-floor-section-title">完整变量快照（snapshot）</p>
            <pre class="thp-snapshot">{{ 快照文本(记录.snapshot) }}</pre>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { 排序楼层, type 楼层记录 } from './楼层变量';
import { 当前聊天ID, 当前聊天记录, 刷新楼层记录, 清空当前聊天记录 } from './楼层变量服务';
import { 用聊天切换自动刷新 } from './自动刷新';

/** 楼层记录按 messageId 倒序（最新在前） */
const 记录列表 = computed<楼层记录[]>(() => 排序楼层(当前聊天记录.value, false));

const 展开集合 = ref<Set<string>>(new Set());

function 变更数(记录: 楼层记录): number {
  return Object.keys(记录?.diff ?? {}).length;
}

function 切换展开(键: string) {
  const 新集合 = new Set(展开集合.value);
  if (新集合.has(键)) 新集合.delete(键);
  else 新集合.add(键);
  展开集合.value = 新集合;
}

function 格式化时间(iso: string): string {
  try {
    const d = new Date(iso);
    const 补零 = (n: number) => String(n).padStart(2, '0');
    return `${补零(d.getMonth() + 1)}-${补零(d.getDate())} ${补零(d.getHours())}:${补零(d.getMinutes())}:${补零(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

function 显示值(v: unknown): string {
  if (v === null || v === undefined) return '（无）';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function 快照文本(快照: Record<string, unknown>): string {
  return JSON.stringify(快照 ?? {}, null, 2);
}

function 刷新() {
  刷新楼层记录();
}

function 清空() {
  清空当前聊天记录();
}

用聊天切换自动刷新(刷新);
</script>
