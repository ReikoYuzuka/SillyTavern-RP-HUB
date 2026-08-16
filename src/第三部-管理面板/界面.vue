<template>
  <div class="thp-entry">
    <!-- 直接显示在扩展程序设置页（#extensions_settings2）内的区块，样式贴近酒馆扩展区块 -->
    <div class="thp-entry-block">
      <div class="thp-entry-header">
        <b>RP助手</b>
        <span class="thp-entry-tag">RP助手</span>
      </div>
      <p class="thp-entry-desc">变量系统 / 模板渲染 / 诊断管理 · AI 回复更新块单向写入楼层消息变量（rp_hub）、楼层变量记录、卡面模板渲染、世界书注入与额外模型解析的一体化管理。</p>
      <div class="thp-entry-actions">
        <input class="menu_button" type="submit" value="打开面板" @click="open_drawer" />
      </div>
    </div>

    <Drawer :open="open" @close="open = false" />
  </div>
</template>

<script setup lang="ts">
import Drawer from './Drawer.vue';

const open = ref(false);

const open_drawer = () => {
  open.value = true;
};
</script>
