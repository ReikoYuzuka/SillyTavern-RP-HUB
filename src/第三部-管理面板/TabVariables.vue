<template>
  <div class="thp-tab-page">
    <!-- 总开关 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">变量更新总开关</h3>
      </header>
      <label class="thp-switch-row">
        <input v-model="总开关" type="checkbox" />
        <span class="thp-switch"></span>
        <span class="thp-switch-label">启用变量更新（关闭后不进行任何变量操作）</span>
      </label>
      <p class="thp-hint">
        总开关：关闭后不进行任何变量操作（不剥离 AI 回复中的更新块、不写楼层变量、不做开场白初始化、
        不注入世界书；模式二额外模型解析也跳过）。关闭时世界书注入随之自动关闭（开关联动）。
      </p>
    </section>

    <!-- 楼层变量：当前聊天各楼层的 rp_hub 变量池（单向写入酒馆助手楼层消息，只读） -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">楼层变量（rp_hub · 写酒馆助手楼层消息）</h3>
        <div class="thp-btn-group">
          <button class="thp-btn thp-btn-sm thp-btn-ghost" type="button" @click="刷新楼层">刷新</button>
        </div>
      </header>

      <p class="thp-hint">
        AI 回复末尾的 <code class="thp-inline-code">&lt;ui_template_updates&gt;</code> 更新块会被剥离正文，
        并按模板 id 分层写入该楼层消息变量
        <code class="thp-inline-code">chat[i].variables[swipe_id].rp_hub</code>。
        新对话时会把卡面初始 variableState 写入开场白楼层（已有变量则不覆盖）。楼层 iframe 渲染时由酒馆助手合并楼层变量，模板脚本经 getAllVariables() / getVariables({type:'message'}) 读取。本视图只读，无编辑写回。
      </p>
      <p v-if="最近状态" class="thp-hint">{{ 最近状态 }}</p>
      <p v-if="初始化状态" class="thp-hint">{{ 初始化状态 }}</p>
      <p v-if="同步错误" class="thp-hint thp-hint-warn">{{ 同步错误 }}</p>
      <p v-if="上次写入时间" class="thp-hint">最近写入：{{ 格式化时钟(上次写入时间) }}</p>

      <div v-if="楼层变量列表.length === 0" class="thp-log-empty thp-var-empty">
        <p>当前聊天暂无楼层 rp_hub 变量</p>
        <span>新对话会在开场白楼层写入卡面初始变量；生成带更新块的 AI 回复后，变量也会自动写入对应楼层消息并在下方显示。</span>
      </div>

      <div v-else class="thp-floor-list">
        <div v-for="楼层 in 楼层变量列表" :key="String(楼层.messageId)" class="thp-floor-item">
          <div class="thp-floor-head">
            <code class="thp-floor-id">#{{ 楼层.messageId }}</code>
            <span class="thp-badge">{{ 楼层.池列表.length }} 个模板池</span>
            <button
              class="thp-btn thp-btn-sm thp-btn-ghost"
              type="button"
              @click="切换楼层展开(String(楼层.messageId))"
            >
              {{ 楼层展开集合.has(String(楼层.messageId)) ? '收起' : '展开' }}
            </button>
          </div>

          <div v-if="楼层展开集合.has(String(楼层.messageId))" class="thp-sync-pool-list">
            <div v-for="池 in 楼层.池列表" :key="池.id" class="thp-sync-pool">
              <div class="thp-sync-pool-head">
                <code class="thp-sync-pool-id">{{ 池.id }}</code>
                <span class="thp-badge">{{ 池.变量数 }} 个变量</span>
              </div>
              <div class="thp-sync-var-list">
                <div v-for="(值, 路径) in 池.扁平" :key="路径" class="thp-sync-var">
                  <code class="thp-sync-var-path" :title="路径">{{ 路径 }}</code>
                  <code class="thp-sync-var-value" :title="路径">{{ 显示只读值(值) }}</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 模式选择 -->
    <section class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">解析模式</h3>
      </header>
      <label v-for="m in modes" :key="m.value" class="thp-radio-row">
        <input v-model="模式" type="radio" name="thp-mode" :value="m.value" />
        <span>{{ m.label }}</span>
      </label>
      <p v-if="模式 === '跟随主模型'" class="thp-hint">
        跟随主模型：把「让 AI 在正文最末尾输出 &lt;ui_template_updates&gt; 更新块」的指令注入 ST 世界书
        （setExtensionPrompt，位置/深度/顺序/角色可配）。AI 回复自带更新块时，由变量单向同步服务自动
        剥离并写入楼层变量 rp_hub —— 两条通道并存互补。
      </p>
      <p v-if="模式 === '额外模型解析'" class="thp-hint">
        额外模型解析：由独立 OpenAI 兼容 API 在 AI 回复后逐模板分析最近对话，生成变量更新写入楼层变量
        rp_hub。该模式下世界书注入自动关闭（解析出的变量走独立通道，不再注入世界书）。
      </p>
      <template v-if="模式 === '跟随主模型'">
        <label class="thp-switch-row">
          <input v-model="注入使能" type="checkbox" />
          <span class="thp-switch"></span>
          <span class="thp-switch-label">启用世界书注入</span>
        </label>
        <p class="thp-hint">开关联动：变量更新总开关关闭 / 切到额外模型解析时，世界书注入自动关闭（仅「变量更新开启 + 跟随主模型」时启动）。</p>
        <p class="thp-hint">{{ 注入状态 }}</p>
      </template>
    </section>

    <!-- 模式一：跟随主模型 -->
    <template v-if="模式 === '跟随主模型'">
      <!-- 注入位置自定义 -->
      <section class="thp-card">
        <header class="thp-card-header">
          <h3 class="thp-card-title">注入位置自定义</h3>
        </header>

        <div class="thp-field">
          <label class="thp-field-label" for="thp-position">position（注入位置）</label>
          <select id="thp-position" v-model.number="position" class="thp-input">
            <option v-for="opt in 注入位置选项" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <p class="thp-hint">世界书条目位置（对齐 ST world_info_position）：0↑Char / 1↓Char / 5↑EM / 6↓EM / 2↑AN / 3↓AN / 4@D（插入深度，role 生效）/ 7Outlet。默认 4@D。</p>
        </div>

        <div v-if="show_role" class="thp-field">
          <label class="thp-field-label" for="thp-role">role（发言者，插入深度@D 时生效）</label>
          <select id="thp-role" v-model.number="role" class="thp-input">
            <option v-for="r in 注入角色选项" :key="r.value" :value="r.value">{{ r.label }}</option>
          </select>
        </div>

        <div class="thp-field-row">
          <div class="thp-field thp-field-half">
            <label class="thp-field-label" for="thp-depth">depth（深度）</label>
            <input id="thp-depth" v-model.number="depth" type="number" min="0" max="9999" class="thp-input" />
          </div>
          <div class="thp-field thp-field-half">
            <label class="thp-field-label" for="thp-order">order（顺序）</label>
            <input id="thp-order" v-model.number="order" type="number" min="0" max="9999" class="thp-input" />
          </div>
        </div>

        <label class="thp-switch-row">
          <input v-model="constant" type="checkbox" />
          <span class="thp-switch"></span>
          <span class="thp-switch-label">常驻（constant 🔵，开启后换卡/切聊天自动重新注入）</span>
        </label>
        <p class="thp-hint">默认：系统 · 插入深度 @D · depth=4 · order=100 · 常驻</p>
      </section>

      <!-- 注入模板（含占位符预览 / 测试 / 快捷占位符） -->
      <section class="thp-card">
        <header class="thp-card-header">
          <h3 class="thp-card-title">注入模板</h3>
          <span class="thp-badge">示例，可编辑</span>
        </header>

        <!-- 占位符预览 -->
        <div class="thp-field">
          <div class="thp-preview-head">
            <span class="thp-field-label">占位符预览（替换真实值后）</span>
            <button class="thp-btn thp-btn-sm" type="button" @click="测试替换">测试</button>
          </div>
          <pre class="thp-preview-box">{{ 预览文本 }}</pre>
        </div>

        <!-- 常用占位符快捷按钮 -->
        <div class="thp-field">
          <span class="thp-field-label">常用占位符（点击追加到模板当前光标处）</span>
          <div class="thp-tag-row">
            <button
              v-for="p in 常用占位符"
              :key="p.占位"
              class="thp-tag-btn"
              type="button"
              :title="`${p.占位} → ${p.说明}`"
              @click="追加占位符(p.占位)"
            >
              <code>{{ p.占位 }}</code>
            </button>
          </div>
          <!-- 卡面占位符 range 语法说明（v-pre 避免 Vue 插值解析花括号） -->
          <p class="thp-hint" v-pre>
            卡面占位符支持下划线 range 语法，如
            <code>{{rpcard_update_rules_1:5}}</code>（索引 0 起）、
            <code>{{rpcard_update_rules_5:}}</code>、
            <code>{{rpcard_update_rules_5:11:2}}</code>（step）
          </p>
        </div>

        <textarea
          ref="注入模板框"
          v-model="注入模板内容"
          class="thp-textarea"
          rows="4"
          spellcheck="false"
        ></textarea>
        <div class="thp-hint-row">
          <span class="thp-hint">{{ 占位符提示 }}</span>
          <button class="thp-btn thp-btn-sm" type="button" @click="保存注入配置">保存模板</button>
        </div>

        <!-- 卡面变量更新提示词（只读 · 后端卡面 variableSchema._update_rules） -->
        <div class="thp-field">
          <div class="thp-preview-head">
            <span class="thp-field-label">卡面变量更新提示词（只读）</span>
            <span class="thp-badge">{{ 卡面提示词列表.length }} 条</span>
            <button
              class="thp-btn thp-btn-sm thp-btn-ghost"
              type="button"
              :disabled="卡面提示词读取中"
              @click="加载卡面提示词"
            >
              {{ 卡面提示词读取中 ? '读取中…' : '刷新' }}
            </button>
          </div>

          <div v-if="卡面提示词列表.length === 0" class="thp-log-empty thp-rules-empty">
            <p>无</p>
            <span>当前卡无模板 / 模板无更新提示词，卡面提示词占位符替换结果为空</span>
          </div>
          <div v-else class="thp-rules-list">
            <div v-for="item in 卡面提示词列表" :key="item.id || item.i" class="thp-rules-item">
              <div class="thp-rules-head">
                <code class="thp-rules-idx">#{{ item.i }}</code>
                <span class="thp-rules-name" :title="item.id">{{ item.name || '未命名模板' }}</span>
                <span v-if="item.id" class="thp-rules-id">{{ item.id }}</span>
                <button
                  class="thp-btn thp-btn-sm thp-btn-ghost"
                  type="button"
                  @click="切换展开(item.i)"
                >
                  {{ 展开集合.has(item.i) ? '收起' : '展开' }}
                </button>
              </div>
              <pre class="thp-rules-body">{{ 截取提示词(item) }}</pre>
            </div>
          </div>

          <p class="thp-hint">
            占位符语法（Python range，索引从 0 开始，对齐数组下标）：
            <code v-pre>{{rpcard_update_rules}}</code> 全部 ·
            <code v-pre>{{rpcard_update_rules_1:5}}</code> 索引 1~4（stop 不含） ·
            <code v-pre>{{rpcard_update_rules_5:}}</code> 索引 5~末尾 ·
            <code v-pre>{{rpcard_update_rules_5:11:2}}</code> 5,7,9 ·
            <code v-pre>{{rpcard_update_rules_::2}}</code> 0,2,4 · 负 step 例
            <code v-pre>{{rpcard_update_rules_5:0:-2}}</code> → 5,3,1 ·
            越界 / 无模板时替换为空。
          </p>
        </div>
      </section>

      <!-- 手动注入 -->
      <section class="thp-card">
        <header class="thp-card-header">
          <h3 class="thp-card-title">手动操作</h3>
        </header>
        <div class="thp-btn-group">
          <button class="thp-btn thp-btn-primary" type="button" :disabled="注入中" @click="手动注入">
            {{ 注入中 ? '注入中…' : '手动注入到世界书' }}
          </button>
        </div>
        <p class="thp-hint" v-pre>注入前提：当前卡面存在变量更新（uiTemplates）。注入内容 = 上方「注入模板」文本框（默认 = 标准变量更新指令；{{{变量载荷}}} 替换为当前卡模板载荷 JSON，{{{变量}}} 替换为完整指令）。注入目标 = 角色绑定的世界书（未绑定时按角色名创建并绑定，随角色走）。</p>
        <p class="thp-hint">{{ 注入状态 }}</p>
      </section>
    </template>

    <!-- 模式二：额外模型解析（自定义提取标签 / 自定义解析模板） -->
    <section v-if="模式 === '额外模型解析'" class="thp-card">
      <header class="thp-card-header">
        <h3 class="thp-card-title">额外模型解析（模式二）</h3>
        <span class="thp-badge thp-badge-on">已启用</span>
      </header>

      <div class="thp-field">
        <label class="thp-field-label" for="thp-oa-api">OpenAI API Key</label>
        <input id="thp-oa-api" v-model="openai_api" type="password" class="thp-input" placeholder="sk-..." />
      </div>
      <div class="thp-field-row">
        <div class="thp-field thp-field-half">
          <label class="thp-field-label" for="thp-oa-model">模型</label>
          <input id="thp-oa-model" v-model="openai_model" type="text" class="thp-input" placeholder="gpt-4o" />
        </div>
        <div class="thp-field thp-field-half">
          <label class="thp-field-label" for="thp-oa-base">接口地址</label>
          <input
            id="thp-oa-base"
            v-model="openai_base"
            type="text"
            class="thp-input"
            placeholder="https://api.openai.com/v1"
          />
        </div>
      </div>

      <!-- 自定义提取标签 -->
      <div class="thp-field">
        <label class="thp-field-label" for="thp-tag">自定义提取标签</label>
        <input
          id="thp-tag"
          v-model="标签提取"
          type="text"
          class="thp-input"
          placeholder="提取 AI 输出中的变量更新标签（如 &lt;ui_template_updates&gt;...）"
        />
      </div>

      <!-- 自定义解析模板 -->
      <div class="thp-field">
        <label class="thp-field-label" for="thp-extra-tpl">自定义解析模板</label>
        <textarea
          id="thp-extra-tpl"
          v-model="额外模板内容"
          class="thp-textarea"
          rows="3"
          spellcheck="false"
          placeholder="额外模型解析提示词模板（可基于上方预设修改）"
        ></textarea>
      </div>

      <!-- 错误重试次数 -->
      <div class="thp-field">
        <label class="thp-field-label" for="thp-retry">错误重试次数</label>
        <input
          id="thp-retry"
          v-model.number="错误重试次数"
          type="number"
          min="0"
          max="10"
          class="thp-input"
        />
        <p class="thp-hint">额外模型 API 调用失败（HTTP 非 2xx / 网络异常）时整体重发的次数。0 = 不重试。</p>
      </div>

      <div class="thp-btn-group">
        <button class="thp-btn" type="button" @click="保存额外解析配置">保存额外模型配置</button>
        <button class="thp-btn" type="button" :disabled="解析中" @click="重新触发解析">
          {{ 解析中 ? '解析中…' : '重新触发额外解析' }}
        </button>
      </div>
      <p class="thp-hint">{{ 解析状态 }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { 替换卡面提示词, 取更新提示词, type 卡面变量模板 } from './card-prompt';
import { 构建模板载荷JSON, 构建变量更新指令 } from './模型解析';
import { 用聊天切换自动刷新 } from './自动刷新';
import { 扁平化变量表, type 扁平变量表 } from './楼层变量';
import { 上次写入时间, 同步错误, 最近状态, 初始化状态, 变量同步开关响应式, 设置变量同步开关 } from './变量单向同步';
import {
  保存配置,
  配置响应,
  注入世界书,
  额外模型解析,
  拉取模板列表,
  注入位置选项,
  注入角色选项,
  注入状态 as 模型解析服务注入状态,
  解析状态 as 模型解析服务解析状态,
  解析中 as 模型解析服务解析中,
} from './模型解析服务';

/* ---------- 楼层变量（rp_hub · 只读视图） ---------- */

interface 池视图 {
  id: string;
  变量数: number;
  扁平: 扁平变量表;
}

interface 楼层变量视图 {
  messageId: number;
  池列表: 池视图[];
}

/** 扫描当前聊天中带楼层变量（chat[i].variables[swipe_id].rp_hub）的楼层，最新在前 */
function 扫描楼层变量(): 楼层变量视图[] {
  const 视图: 楼层变量视图[] = [];
  try {
    const chat = SillyTavern.chat;
    if (!Array.isArray(chat)) return 视图;
    chat.forEach((消息, i) => {
      if (!消息 || 消息.is_system) return;
      const 变量格 = 消息.variables?.[消息.swipe_id ?? 0];
      const rp_hub = 变量格?.rp_hub;
      if (!rp_hub || typeof rp_hub !== 'object') return;
      const 池列表: 池视图[] = Object.entries(rp_hub as Record<string, unknown>)
        .map(([id, 池]) => {
          const 扁平 = 扁平化变量表(池);
          return { id, 变量数: Object.keys(扁平).length, 扁平 };
        })
        .filter(p => p.变量数 > 0);
      if (池列表.length === 0) return;
      视图.push({ messageId: i, 池列表 });
    });
  } catch {
    // 聊天数组读取异常时忽略，展示空列表
  }
  return 视图.reverse();
}

const 楼层变量列表 = ref<楼层变量视图[]>([]);
const 楼层展开集合 = ref<Set<string>>(new Set());

function 刷新楼层(): void {
  楼层变量列表.value = 扫描楼层变量();
}

function 切换楼层展开(键: string) {
  const 新集合 = new Set(楼层展开集合.value);
  if (新集合.has(键)) 新集合.delete(键);
  else 新集合.add(键);
  楼层展开集合.value = 新集合;
}

function 格式化时钟(iso: string): string {
  try {
    const d = new Date(iso);
    const 补零 = (n: number) => String(n).padStart(2, '0');
    return `${补零(d.getHours())}:${补零(d.getMinutes())}:${补零(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

function 显示只读值(v: unknown): string {
  if (v === null || v === undefined) return '（无）';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

刷新楼层();
用聊天切换自动刷新(() => {
  刷新楼层();
});
用聊天切换自动刷新(() => {
  加载卡面提示词();
});

const 总开关 = computed({
  // A3：读写共享响应式 ref（与「变量同步开关」服务层判定双向同步）。
  // 之前为装饰 ref(true)（与变量单向同步服务无关联）。现经 设置变量同步开关 同步
  // localStorage 键 thp_variable_sync_enabled + ref，UI 开关与服务行为一致且跨组件联动。
  get: () => 变量同步开关响应式.value,
  set: (v: boolean) => 设置变量同步开关(v),
});

/* ---------- 模型解析（模式一 世界书注入 / 模式二 额外模型解析）配置接线 ---------- */

const 注入中 = ref(false);

// ⚠️ 配置 computed 的 get 一律读 配置响应.value（响应式 ref），不能直接 读取配置()（读 localStorage，
// 无响应式依赖 → 切换 radio 等界面不刷新）。set 经 保存配置 写 localStorage 并同步更新 配置响应。

/** 模式一注入开关（E 联动：只在「变量更新总开关开启 + 跟随主模型」时启动；模式二自动视为关闭） */
const 注入使能 = computed({
  get: () => 配置响应.value.注入使能 && 配置响应.value.模式 === '跟随主模型' && 变量同步开关响应式.value,
  set: (v: boolean) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 注入使能: v });
  },
});

const 模式 = computed({
  get: () => 配置响应.value.模式,
  set: (v: '跟随主模型' | '额外模型解析') => {
    const 配置 = 配置响应.value;
    // E 联动：选额外模型解析（模式二）→ 世界书注入自动关闭；选跟随主模型（模式一）→ 自动启动
    保存配置({ ...配置, 模式: v, 注入使能: v === '跟随主模型' });
  },
});

const position = computed({
  get: () => 配置响应.value.注入位置,
  set: (v: number) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 注入位置: v });
  },
});
const role = computed({
  get: () => 配置响应.value.注入角色,
  set: (v: number) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 注入角色: v });
  },
});
const depth = computed({
  get: () => 配置响应.value.注入深度,
  set: (v: number) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 注入深度: v });
  },
});
const order = computed({
  get: () => 配置响应.value.注入顺序,
  set: (v: number) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 注入顺序: v });
  },
});
const constant = computed({
  get: () => 配置响应.value.常驻,
  set: (v: boolean) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 常驻: v });
  },
});
const 注入模板内容 = computed({
  get: () => 配置响应.value.注入模板,
  set: (v: string) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 注入模板: v });
  },
});

const openai_api = computed({
  get: () => 配置响应.value.openai_api,
  set: (v: string) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, openai_api: v });
  },
});
const openai_model = computed({
  get: () => 配置响应.value.openai_model,
  set: (v: string) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, openai_model: v });
  },
});
const openai_base = computed({
  get: () => 配置响应.value.openai_base,
  set: (v: string) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, openai_base: v });
  },
});
const 标签提取 = computed({
  get: () => 配置响应.value.提取标签,
  set: (v: string) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 提取标签: v });
  },
});
const 额外模板内容 = computed({
  get: () => 配置响应.value.解析模板,
  set: (v: string) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 解析模板: v });
  },
});
const 错误重试次数 = computed({
  get: () => 配置响应.value.错误重试次数,
  set: (v: number) => {
    const 配置 = 配置响应.value;
    保存配置({ ...配置, 错误重试次数: Math.max(0, Math.floor(Number(v) || 0)) });
  },
});

const 注入状态 = computed(() => 模型解析服务注入状态.value);
const 解析状态 = computed(() => 模型解析服务解析状态.value);
const 解析中 = computed(() => 模型解析服务解析中.value);

/** 模式一：保存注入配置（模板/位置/深度/顺序/角色/常驻 已实时持久化；此按钮为确认+提示） */
function 保存注入配置() {
  toastr.success('世界书注入配置已保存（切换模式 / 重开聊天自动生效）');
}

/** 模式一：手动注入到世界书（创建真实世界书条目，世界书面板可见、持久化） */
async function 手动注入() {
  if (注入中.value) return;
  注入中.value = true;
  try {
    const 模板列表 = await 拉取模板列表();
    const ok = await 注入世界书(模板列表, {});
    toastr[ok ? 'success' : 'warning'](模型解析服务注入状态.value || (ok ? '已注入世界书' : '注入失败'));
  } finally {
    注入中.value = false;
  }
}

/** 模式二：保存额外模型配置（API Key / 模型 / 基址 / 标签 / 模板 已实时持久化；此按钮为确认+提示） */
function 保存额外解析配置() {
  toastr.success('额外模型配置已保存（API Key / 模型 / 基址 / 提取标签 / 解析模板）');
}

/** 模式二：重新触发额外解析（对最后一条 AI 回复） */
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
    toastr[ok ? 'success' : 'warning'](模型解析服务解析状态.value || (ok ? '额外解析完成' : '额外解析无更新'));
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

// 含花括号占位符，故放在脚本侧避免模板编译解析问题
const 占位符提示 =
  '默认即标准变量更新指令（[UI模板变量更新] + <ui_template_updates> 更新块格式 + 13 条规则 + 模板变量如下：{{{变量载荷}}}），可编辑。动态槽位：{{{变量载荷}}} = 当前卡模板载荷 JSON（id/名称/当前变量/schema）；{{{变量}}} = 完整格式指令（自定义引导语时用它）；{{rpcard_update_rules}} = 卡面 schema 字段说明。支持酒馆占位符（{{char}} / {{user}} / {{newline}} 等，由 ST 注入时解析）。';

const modes = [
  { value: '跟随主模型', label: '跟随主模型' },
  { value: '额外模型解析', label: '额外模型解析' },
] as const;

const show_role = computed(() => position.value === 4); // 插入深度 @D（at_depth）时角色生效

/* ---------- 占位符替换（纯读取上下文 + 纯函数） ---------- */

interface 占位符上下文 {
  char: string;
  user: string;
  newline: string;
  id: string;
  random: string;
  date: string;
  time: string;
}

/**
 * 纯函数：把模板中的常见酒馆占位符替换为上下文中的真实值。
 * 取不到值（上下文为空串）的占位符保留原样，不做任何写操作。
 */
function 替换占位符(模板: string, 上下文: 占位符上下文): string {
  const 表: Record<string, string> = {
    '{{char}}': 上下文.char,
    '{{character}}': 上下文.char,
    '{{user}}': 上下文.user,
    '{{newline}}': 上下文.newline,
    '{{random}}': 上下文.random,
    '{{date}}': 上下文.date,
    '{{time}}': 上下文.time,
    '{{id}}': 上下文.id,
  };
  let 结果 = 模板;
  for (const [占位, 值] of Object.entries(表)) {
    if (值) {
      结果 = 结果.split(占位).join(值);
    }
  }
  return 结果;
}

function 补零(n: number): string {
  return String(n).padStart(2, '0');
}

function 格式化日期(d: Date): string {
  return `${d.getFullYear()}-${补零(d.getMonth() + 1)}-${补零(d.getDate())}`;
}

function 格式化时间(d: Date): string {
  return `${补零(d.getHours())}:${补零(d.getMinutes())}:${补零(d.getSeconds())}`;
}

/** 读取当前角色名：SillyTavern 全局（参照 TabDiagnose.vue 的取数方式） */
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

/** 获取占位符上下文：优先 SillyTavern.getContext()，兜底读全局属性与宿主 window.parent */
function 获取占位符上下文(): 占位符上下文 {
  let char = '';
  let user = '';
  let id = '';
  try {
    const ctx = (SillyTavern as unknown as { getContext?: () => any }).getContext?.();
    if (ctx) {
      char = String(ctx.name2 ?? '');
      user = String(ctx.name1 ?? '');
      id = String(ctx.chatId ?? ctx.characterId ?? '');
    }
  } catch {
    // 忽略，走兜底
  }
  if (!char) char = 获取当前卡名() ?? '';
  if (!char) {
    try {
      char = String(SillyTavern.name2 ?? '');
    } catch {
      char = '';
    }
  }
  if (!user) {
    try {
      user = String(SillyTavern.name1 ?? '');
    } catch {
      user = '';
    }
  }
  // 兜底：宿主全局（脚本 iframe 内读不到时）
  if (!char || !user) {
    try {
      const parent = window.parent as any;
      const pctx = parent?.SillyTavern?.getContext?.();
      if (pctx) {
        if (!char) char = String(pctx.name2 ?? '');
        if (!user) user = String(pctx.name1 ?? '');
        if (!id) id = String(pctx.chatId ?? pctx.characterId ?? '');
      }
    } catch {
      // 忽略
    }
  }
  const now = new Date();
  return {
    char,
    user,
    newline: '\n',
    id,
    random: String(Math.floor(Math.random() * 10000)),
    date: 格式化日期(now),
    time: 格式化时间(now),
  };
}

/** 注入模板实时预览（替换真实值后）；点击「测试」后刷新取值 */
const 测试计数 = ref(0);
const 预览文本 = computed(() => {
  void 测试计数.value;
  return 完整替换(注入模板内容.value);
});

/**
 * 完整替换管线：先替换酒馆宏，再替换卡面变量更新提示词占位符，最后替换 {{{变量载荷}}}/{{{变量}}}
 * （三组互不干扰，与注入链路 构建注入文本 对齐 —— 修复标准注入模板的 {{{变量载荷}}} 预览显示为字面量）。
 * 无模板时保留 {{{变量载荷}}}/{{{变量}}} 原样（与 替换卡面提示词 无模板保留语义一致）。
 */
function 完整替换(模板: string): string {
  const 上下文 = 获取占位符上下文();
  let 文本 = 替换占位符(模板, 上下文);
  文本 = 替换卡面提示词(文本, 卡面模板列表.value);
  if (卡面模板列表.value.length > 0) {
    // 预览无楼层池 → 池表传空 {}，currentVariables 回退卡面 variableState/initialVariableState（展示用）
    文本 = 文本.split('{{{变量载荷}}}').join(构建模板载荷JSON(卡面模板列表.value, {}));
    文本 = 文本.split('{{{变量}}}').join(构建变量更新指令(卡面模板列表.value, {}, 上下文.user));
  }
  return 文本;
}

/** 测试按钮：把替换结果输出到浏览器控制台日志，并在上方预览区显示 */
function 测试替换() {
  const 文本 = 完整替换(注入模板内容.value);
  测试计数.value += 1;
  console.log('[第三部] 占位符已替换完成（含卡面变量更新提示词）：\n' + 文本);
  toastr.info('已把占位符替换结果输出到浏览器控制台（F12 → Console）');
}

/* ---------- 卡面变量更新提示词（后端取数 + 只读预览） ---------- */

/** rp-hub-compat 后端插件地址（相对路径，ST 自动补当前 origin，换端口/域名/局域网都通） */
const BASE = (() => {
  // srcdoc iframe 内相对路径 base 继承可能异常 → 用父窗口 origin 拼绝对路径（跟随部署 origin，不写死）
  try { const o = (window.parent ?? window)?.location?.origin; if (o) return o + '/api/plugins/rp-hub-compat/v1'; } catch {}
  return '/api/plugins/rp-hub-compat/v1';
})();

/** 纯 GET 请求，CORS 直连（Access-Control-Allow-Origin: null）失败返回 null 不抛错 */
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
  marked?: boolean;
}

interface VariablesView {
  cardId: string;
  variables: { uiTemplates?: 卡面变量模板[] };
}

/** 原始模板数组（保持数组下标 = range 索引，供占位符替换使用） */
const 卡面模板列表 = ref<卡面变量模板[]>([]);
const 卡面提示词读取中 = ref(false);

interface 提示词条目 {
  i: number;
  id: string;
  name: string;
  text: string;
}

/** 只读预览条目：仅保留带 _update_rules 的模板，仍带原始下标 */
const 卡面提示词列表 = computed<提示词条目[]>(() =>
  卡面模板列表.value
    .map((t, i) => ({ i, id: String(t?.id ?? ''), name: String(t?.name ?? ''), text: 取更新提示词(t) }))
    .filter(e => e.text),
);

/** 预览条目展开状态（key = 原始数组下标） */
const 展开集合 = ref<Set<number>>(new Set());

function 切换展开(i: number) {
  const 新集合 = new Set(展开集合.value);
  if (新集合.has(i)) 新集合.delete(i);
  else 新集合.add(i);
  展开集合.value = 新集合;
}

/** 折叠时只显示前 80 字，展开显示全文 */
function 截取提示词(item: 提示词条目): string {
  if (展开集合.value.has(item.i) || item.text.length <= 80) return item.text;
  return `${item.text.slice(0, 80)}…`;
}

/** 按当前卡名拉取 uiTemplates，再取各模板的 variableSchema._update_rules */
async function 加载卡面提示词() {
  if (卡面提示词读取中.value) return;
  卡面提示词读取中.value = true;
  try {
    const name = 获取当前卡名();
    if (!name) {
      卡面模板列表.value = [];
      return;
    }
    const by_name = await 请求<ByName>(`${BASE}/cards/by-name/${encodeURIComponent(name)}`);
    if (!by_name) {
      卡面模板列表.value = [];
      return;
    }
    const vars = await 请求<VariablesView>(`${BASE}/cards/${by_name.cardId}/variables?fields=uiTemplates`);
    const templates = vars?.variables?.uiTemplates;
    卡面模板列表.value = Array.isArray(templates) ? templates : [];
  } finally {
    卡面提示词读取中.value = false;
  }
}

/* ---------- 常用占位符快捷按钮 ---------- */

const 常用占位符 = [
  { 占位: '{{{变量载荷}}}', 说明: '当前卡模板载荷 JSON（id/名称/当前变量/schema），标准指令的「模板变量如下」用' },
  { 占位: '{{{变量}}}', 说明: '完整变量更新格式指令（[UI模板变量更新] + <ui_template_updates> 格式 + 规则 + 载荷）' },
  { 占位: '{{char}}', 说明: '角色名' },
  { 占位: '{{user}}', 说明: '用户名' },
  { 占位: '{{newline}}', 说明: '换行' },
  { 占位: '{{random}}', 说明: '随机数' },
  { 占位: '{{date}}', 说明: '当前日期' },
  { 占位: '{{time}}', 说明: '当前时间' },
  { 占位: '{{id}}', 说明: '聊天 ID' },
  { 占位: '{{rpcard_update_rules}}', 说明: '全部卡面更新提示词（schema 字段说明，自定义模板时用）' },
];

const 注入模板框 = ref<HTMLTextAreaElement | null>(null);

/** 点击快捷按钮：光标位于模板 textarea 内则插入光标处，否则追加到末尾 */
function 追加占位符(占位: string) {
  const el = 注入模板框.value;
  // UI-B1 修复：textarea Teleport 到父文档 → 用 el.ownerDocument.activeElement 判定光标（iframe 的 document 永远不是焦点）
  if (el && el.ownerDocument?.activeElement === el) {
    const 起点 = el.selectionStart ?? 注入模板内容.value.length;
    const 终点 = el.selectionEnd ?? 注入模板内容.value.length;
    注入模板内容.value = 注入模板内容.value.slice(0, 起点) + 占位 + 注入模板内容.value.slice(终点);
    requestAnimationFrame(() => {
      el.focus();
      const 新位置 = 起点 + 占位.length;
      el.setSelectionRange(新位置, 新位置);
    });
  } else {
    注入模板内容.value += 占位;
  }
}
</script>
