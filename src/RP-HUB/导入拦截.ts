/**
 * 导入拦截 —— 计划 §2.1：拦截卡片的导入、拖入动作，判断「酒馆原生卡 vs RP 卡」→ 上传到对应接口。
 *
 * 拦截点（ST 前端导入链路，见 第一部-开发归档/ST前端导入链路分析.md）：
 *   - 拖拽：script.js:12494 `new DragAndDropHandler('body', ...)` 在 document.body 上绑定
 *     jQuery `drop`（冒泡阶段）。本模块在【父窗口 document】上挂**捕获阶段** `drop` 监听，
 *     捕获（document）先于冒泡（body）执行 → `preventDefault + stopImmediatePropagation` 后
 *     ST 的 body 处理器不再触发，完成接管。
 *   - 文件选择：`#character_import_file` change（script.js:11942，jQuery 冒泡绑定）。本模块在
 *     父窗口 document 上挂捕获阶段 `change`，命中该 input 即接管。
 *   - URL 导入（importFromExternalUrl / importFromURL，chub 等在线链接）不拦截（走 ST 原生流程）。
 *
 * 分流判定（后端插件 analyze，不落盘）：
 *   - `marked === true`（手动标记命中）→ RP 卡；
 *   - `features[]` 含任意 `rphub_*`（rphub_ui_templates / rphub_block_* 等，detect.js）→ RP 卡；
 *   - 否则 → 酒馆原生卡。
 *
 * RP 卡 → POST /v1/cards/upload?writeBack=1（插件落盘 + 写回 ST 标准卡 PNG 到角色目录）→
 *   getCharacters() 刷新 → selectCharacterById() 选中（ST 原版自动弹世界书/正则导入询问）。
 * 原生卡 → 复刻 ST importCharacter 的 FormData POST /api/characters/import（avatar/file_type/
 *   user_name + X-CSRF-Token，omitContentType）→ getCharacters() 刷新。
 *
 * 安全网：
 *   - 后端不可达 / analyze 失败 → 全部走原生导入（不阻塞导入流程）。
 *   - 只拦截「角色文件扩展名/MIME 白名单」的文件；非角色文件（图片附件等）与 URL 文本拖入不拦。
 *   - 其它 drop 区（附件弹窗 .popup / 聊天弹窗 #select_chat_popup / 聊天导入 #form_sheld /
 *     画廊 #dragGallery）不拦截，交给对应扩展处理。
 *   - 总开关 localStorage thp_import_intercept_enabled（缺省开启，可 console 关闭）。
 *
 * 本模块顶层无副作用（纯函数可 node 单测）；浏览器行为集中在 启动导入拦截()。
 * ⚠️ 本模块不 import 运行日志（node --test 直接跑 .ts 时无扩展名相对 import 不解析），
 * 导入结果经 toastr 提示即可。
 */

/** rp-hub-compat 后端插件地址（相对路径，ST 自动补当前 origin，与既有模块一致） */
const BASE = (() => {
  // srcdoc iframe 内相对路径 base 继承可能异常 → 用父窗口 origin 拼绝对路径（跟随部署 origin，不写死）
  try { const o = (window.parent ?? window)?.location?.origin; if (o) return o + '/api/plugins/rp-hub-compat/v1'; } catch {}
  return '/api/plugins/rp-hub-compat/v1';
})();

/** ST 角色导入允许的扩展名（processDroppedFiles script.js:10402 / importCharacter script.js:10477） */
const 允许扩展名表 = ['json', 'png', 'yaml', 'yml', 'charx', 'byaf'];

/** ST 角色导入允许的 MIME 前缀（processDroppedFiles script.js:10402-10419） */
const 允许MIME前缀 = [
  'application/json',
  'image/png',
  'application/yaml',
  'application/x-yaml',
  'text/yaml',
  'text/x-yaml',
];

/** 总开关存储键（缺省开启：非 'false' 即启用） */
const 存储键 = 'thp_import_intercept_enabled';

/** 其它 drop 处理区（不拦截，避免破坏 ST 附件/聊天/画廊等既有拖放） */
const 排除选择器 = '#select_chat_popup, .popup, #form_sheld, #dragGallery';

/* ---------- 纯函数（node 可测） ---------- */

/** 文件扩展名（小写） */
export function 文件扩展(文件名: string): string {
  return String(文件名 ?? '').split('.').pop()?.toLowerCase() ?? '';
}

/** 扩展名是否在 ST 角色导入白名单 */
export function 扩展名允许(文件名: string): boolean {
  return 允许扩展名表.includes(文件扩展(文件名));
}

/** 文件是否允许（扩展名或 MIME 命中） */
export function 文件允许(file: { name?: string; type?: string }): boolean {
  if (扩展名允许(String(file?.name ?? ''))) return true;
  return 允许MIME前缀.some(p => String(file?.type ?? '').startsWith(p));
}

/**
 * 由 analyze 响应判定是否为 RP 卡（纯函数）。
 * 判据（对齐后端 detect.js / 标记接口）：marked 强制 rphub；features 含任意 rphub_* 特征。
 */
export function 判定是否为RP卡(analyze: { marked?: boolean; features?: unknown } | null | undefined): boolean {
  if (analyze && analyze.marked === true) return true;
  if (analyze && Array.isArray(analyze.features)) {
    return analyze.features.some(f => typeof f === 'string' && f.startsWith('rphub_'));
  }
  return false;
}

/** 总开关是否启用（关闭后不拦截，ST 原生导入流程照常） */
export function 导入拦截已启用(): boolean {
  try {
    return localStorage.getItem(存储键) !== 'false';
  } catch {
    return true;
  }
}

/** 控制台可读写总开关 */
export function 设置导入拦截开关(启用: boolean): void {
  try {
    localStorage.setItem(存储键, 启用 ? 'true' : 'false');
  } catch {
    // localStorage 不可用时静默降级
  }
}

/* ---------- 前端本地卡判定（后端 analyze 不可用时兜底，纯函数可 node 测） ---------- */

/** PNG 魔数 */
const PNG签名 = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 提取 PNG tEXt 文本块（简易实现，仅取 tEXt 类型；IEND 停止）。
 * 对齐后端 parse/png.js 的块遍历（长度 + 类型 + 数据 + CRC）。
 * @returns [{ keyword, text }]；非 PNG / 解析失败 → []
 */
export function 提取PNG文本块(字节: Uint8Array): Array<{ keyword: string; text: string }> {
  if (!字节 || 字节.length < 8) return [];
  for (let i = 0; i < 8; i++) if (字节[i] !== PNG签名[i]) return [];
  const 块: Array<{ keyword: string; text: string }> = [];
  let 偏移 = 8;
  while (偏移 + 8 <= 字节.length) {
    const 长度 = (字节[偏移] << 24) | (字节[偏移 + 1] << 16) | (字节[偏移 + 2] << 8) | 字节[偏移 + 3];
    const 类型 = String.fromCharCode(字节[偏移 + 4], 字节[偏移 + 5], 字节[偏移 + 6], 字节[偏移 + 7]);
    const 数据起点 = 偏移 + 8;
    const 数据终点 = 数据起点 + 长度;
    if (数据终点 + 4 > 字节.length) break;
    if (类型 === 'tEXt') {
      // 数据 = keyword\0text（ISO-8859-1）。
      // ⚠️ 用 Array.from 而非 .map：Uint8Array.prototype.map 返回 Uint8Array，
      // 回调返回的字符串会被强转成数字（"c"→NaN→0）→ .map(b=>String.fromCharCode(b))
      // 在 Node 下会得到 [0,0,...] → join 后是 "00000" 而非 "chara"（实测踩坑）。
      let 分隔 = 数据起点;
      while (分隔 < 数据终点 && 字节[分隔] !== 0) 分隔++;
      const keyword = Array.from(字节.slice(数据起点, 分隔), b => String.fromCharCode(b)).join('');
      const text = Array.from(字节.slice(分隔 + 1, 数据终点), b => String.fromCharCode(b)).join('');
      块.push({ keyword, text });
    }
    if (类型 === 'IEND') break;
    偏移 = 数据终点 + 4; // 跳过 CRC
  }
  return 块;
}

/**
 * 从 PNG chara / ccv3 块提取卡 JSON（内容为 base64 的卡数据 JSON）。
 * @returns 解析出的对象；无卡块 / 解码失败 → null
 */
export function 解析PNG卡JSON(字节: Uint8Array): Record<string, unknown> | null {
  const 块 = 提取PNG文本块(字节);
  const 卡块 = 块.find(b => b.keyword === 'chara' || b.keyword === 'ccv3');
  if (!卡块 || !卡块.text) return null;
  try {
    const 解码 = atob(卡块.text.trim());
    const bytes = new Uint8Array(解码.length);
    for (let i = 0; i < 解码.length; i++) bytes[i] = 解码.charCodeAt(i);
    const 文本 = new TextDecoder('utf-8').decode(bytes);
    const 解析 = JSON.parse(文本);
    return 解析 && typeof 解析 === 'object' && !Array.isArray(解析) ? 解析 : null;
  } catch {
    return null;
  }
}

/**
 * 从卡 JSON 判定 RP 特征（对齐后端 detect.js：uiTemplates / rp_hub_ui_templates /
 * ui_templates / runtimeByCharacter / rp_hub_watermark / rp_hub_regex_scripts）。
 * 兼容 chara_card_v2 包裹形态（{spec, data}）与平铺形态。
 */
export function 卡JSON是否RP卡(卡: Record<string, unknown>): boolean {
  if (!卡 || typeof 卡 !== 'object') return false;
  const 源 = (卡 as { data?: unknown }).data && typeof (卡 as { data?: unknown }).data === 'object' && !Array.isArray((卡 as { data?: unknown }).data)
    ? (卡 as { data: Record<string, unknown> }).data
    : 卡;
  const ext = 源.extensions && typeof 源.extensions === 'object' && !Array.isArray(源.extensions)
    ? (源.extensions as Record<string, unknown>)
    : {};
  if (Array.isArray(源.uiTemplates) && 源.uiTemplates.length > 0) return true;
  if (Array.isArray(ext.rp_hub_ui_templates) && (ext.rp_hub_ui_templates as unknown[]).length > 0) return true;
  if (Array.isArray(源.ui_templates) && 源.ui_templates.length > 0) return true;
  if (源.uiTemplates !== undefined) return true;
  if (源.ui_templates !== undefined) return true;
  if (源.runtimeByCharacter !== undefined) return true;
  if (ext.rp_hub_watermark !== undefined) return true;
  if (ext.rp_hub_ui_templates !== undefined) return true;
  if (ext.rp_hub_regex_scripts !== undefined) return true;
  if (源.rp_hub_watermark !== undefined) return true;
  // 顶层 data.regex_scripts 非空（rphub 导出卡写法：正则放角色数据顶层而非 ST 标准位
  // extensions.regex_scripts）。对齐后端 detect.js 的 rphub_top_level_regex_scripts 特征。
  if (Array.isArray(源.regex_scripts) && (源.regex_scripts as unknown[]).length > 0) return true;
  return false;
}

/**
 * 前端本地卡类型判定（后端 analyze 不可用时兜底，满足「先判断是什么卡再上传」）：
 *   - PNG：独立 rphub 块（RoleplayHubCard / rp_hub_credit / rp_hub_fingerprint）→ rp；
 *     否则解析 chara/ccv3 JSON 特征 → rp/st；
 *   - JSON：解析 extensions/data 的 rphub_* 特征 → rp/st；
 *   - 无法可靠解析（yaml/yml/charx/byaf、损坏）→ unknown。
 */
export async function 本地判定卡类型(file: { name?: string; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> }): Promise<'rp' | 'st' | 'unknown'> {
  const 名 = String(file?.name ?? '');
  const 扩展 = 文件扩展(名);
  try {
    if (typeof file?.arrayBuffer !== 'function') return 'unknown';
    const 字节 = new Uint8Array(await file.arrayBuffer());
    if (扩展 === 'png' || String(file?.type ?? '').startsWith('image/png')) {
      const 块 = 提取PNG文本块(字节);
      if (块.some(b => b.keyword === 'RoleplayHubCard' || b.keyword === 'rp_hub_credit' || b.keyword === 'rp_hub_fingerprint')) {
        return 'rp';
      }
      const 卡 = 解析PNG卡JSON(字节);
      if (!卡) return 'unknown';
      return 卡JSON是否RP卡(卡) ? 'rp' : 'st';
    }
    if (扩展 === 'json' || String(file?.type ?? '').startsWith('application/json')) {
      const 文本 = new TextDecoder('utf-8').decode(字节);
      const 卡 = JSON.parse(文本) as unknown;
      if (!卡 || typeof 卡 !== 'object' || Array.isArray(卡)) return 'unknown';
      return 卡JSON是否RP卡(卡 as Record<string, unknown>) ? 'rp' : 'st';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ---------- 宿主上下文（浏览器 iframe 环境） ---------- */

/** 读取 ST 上下文（脚本 iframe：SillyTavern 全局经 TH predefine 注入，含 getRequestHeaders/getCharacters/selectCharacterById） */
function 获取上下文(): any {
  try {
    return (SillyTavern as unknown as { getContext?: () => any }).getContext?.() ?? null;
  } catch {
    return null;
  }
}

/** 读取当前用户名（user_name 字段，ST 原生 importCharacter script.js:10484-10490） */
function 获取用户名(): string {
  try {
    const ctx = 获取上下文();
    return String(ctx?.name1 ?? (SillyTavern as any)?.name1 ?? '');
  } catch {
    return '';
  }
}

/** 读取 CSRF 令牌（X-CSRF-Token；ST getRequestHeaders script.js:645） */
function 获取CSRF令牌(): string | null {
  try {
    const headers = (SillyTavern as unknown as { getRequestHeaders?: () => Record<string, string> }).getRequestHeaders?.();
    if (headers) {
      const 值 = headers['X-CSRF-Token'] ?? headers['x-csrf-token'] ?? headers['X-CSRF-TOKEN'];
      if (typeof 值 === 'string' && 值) return 值;
    }
  } catch {
    // 忽略，走兜底
  }
  try {
    const ctx = 获取上下文();
    const h = ctx?.getRequestHeaders?.();
    const 值 = h?.['X-CSRF-Token'] ?? h?.['x-csrf-token'] ?? h?.['X-CSRF-TOKEN'];
    if (typeof 值 === 'string' && 值) return 值;
  } catch {
    // 忽略
  }
  return null;
}

/** 原生导入请求头：X-CSRF-Token 必需；FormData 不能带 Content-Type（边界由浏览器自动生成） */
function 获取原生请求头(): Record<string, string> {
  const 头: Record<string, string> = {};
  const token = 获取CSRF令牌();
  if (token) 头['X-CSRF-Token'] = token;
  try {
    const ctx = 获取上下文();
    const h = ctx?.getRequestHeaders?.({ omitContentType: true });
    if (h && typeof h === 'object') {
      for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
        if (typeof v === 'string' && !/^content-type$/i.test(k)) 头[k] = v;
      }
    }
  } catch {
    // 忽略，用上面的最小头
  }
  delete 头['Content-Type'];
  delete 头['content-type'];
  return 头;
}

/* ---------- 后端交互 ---------- */

/**
 * 分析文件：判定 RP / 原生。
 * 流程（用户要求「先判断是什么卡 → 再确定走什么上传」）：
 *   1. 后端 analyze（必须带 X-CSRF-Token —— ST csrf 中间件全局生效，漏带会 403；
 *      上传RP卡/原生导入 都带了，之前 analyze 漏带 → 永远 403 → 静默回退原生导入，即用户看到的「直接导入了」）；
 *   2. analyze 失败（后端不可用 / 403 / 网络错）→ 前端本地判定兜底（PNG chara 块 / JSON extensions 的 rphub_* 特征）；
 *   3. 本地也无法判定（yaml/损坏）→ 失败（调用方走原生 + 明确提示）。
 * @returns { rp, 失败, 通道 } 通道 = '后端' | '本地'（诊断用）
 */
async function 分析文件(file: File): Promise<{ rp: boolean; 失败: boolean; 通道: '后端' | '本地' }> {
  // 1) 后端 analyze
  // ⚠️ X-Filename 必须 encodeURIComponent：fetch header 只接受 <256 字节（Latin-1），
  // 中文文件名（如「超兽武装.png」）直接放会抛 "Cannot convert ... to ByteString ... > 255"。
  const 头: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) };
  const token = 获取CSRF令牌();
  if (token) 头['X-CSRF-Token'] = token;
  try {
    const res = await fetch(`${BASE}/cards/analyze`, {
      method: 'POST',
      headers: 头,
      body: await file.arrayBuffer(),
    });
    if (res.ok) {
      const data = await res.json();
      return { rp: 判定是否为RP卡(data), 失败: false, 通道: '后端' };
    }
    console.warn(`[第三部] 后端 analyze HTTP ${res.status}，改用前端本地判定`);
  } catch (e) {
    console.warn('[第三部] 后端 analyze 请求异常，改用前端本地判定：', e instanceof Error ? e.message : e);
  }
  // 2) 前端本地判定
  const 本地 = await 本地判定卡类型(file);
  if (本地 !== 'unknown') return { rp: 本地 === 'rp', 失败: false, 通道: '本地' };
  // 3) 无法判定
  return { rp: false, 失败: true, 通道: '后端' };
}

/** RP 卡上传（upload?writeBack=1：插件落盘 + 写回 ST 标准卡 PNG）→ 返回 standardCard.avatar（可能 null=写回失败） */
async function 上传RP卡(file: File): Promise<string | null> {
  const 头: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) };
  const token = 获取CSRF令牌();
  if (token) 头['X-CSRF-Token'] = token;
  try {
    const res = await fetch(`${BASE}/cards/upload?writeBack=1`, {
      method: 'POST',
      headers: 头,
      body: await file.arrayBuffer(),
    });
    if (!res.ok) {
      toastr.error(`RP 卡上传失败：HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const avatar = data?.standardCard?.avatar ?? null;
    if (!avatar && data?.standardCard?.error) {
      console.warn('[第三部] RP 卡写回 ST 失败（插件已落盘）：', data.standardCard.error);
    }
    return avatar;
  } catch (e) {
    toastr.error(`RP 卡上传失败：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * 酒馆原生导入（复刻 ST importCharacter script.js:10470-10534：FormData avatar/file_type/user_name →
 * POST /api/characters/import，header omitContentType + X-CSRF-Token）。
 * @returns 成功返回 avatar 文件名（含 .png）；失败返回 null
 */
async function 原生导入(file: File): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', 文件扩展(file.name));
    formData.append('user_name', 获取用户名());
    const res = await fetch('/api/characters/import', {
      method: 'POST',
      headers: 获取原生请求头(),
      body: formData,
    });
    const data = await res.json().catch(() => null);
    if (data?.file_name) {
      return `${String(data.file_name).replace(/\.png$/i, '')}.png`;
    }
    return null;
  } catch {
    return null;
  }
}

/** 刷新角色列表（getCharacters()：重建 characters 数组 + printCharacters(true)） */
async function 刷新列表(): Promise<void> {
  try {
    const ctx = 获取上下文();
    await ctx?.getCharacters?.();
  } catch {
    // 忽略（刷新失败不阻塞；下次打开列表自动对齐）
  }
}

/** 按 avatar 文件名选中角色（selectCharacterById：真切换 → 触发 ST 原版世界书/正则导入询问） */
async function 选中角色(avatar: string): Promise<void> {
  try {
    const avatarBase = String(avatar).replace(/\.png$/i, '');
    const characters = (SillyTavern as any)?.characters;
    if (!Array.isArray(characters)) return;
    const idx = characters.findIndex((c: any) => String(c?.avatar ?? '').replace(/\.png$/i, '') === avatarBase);
    if (idx < 0) return;
    const ctx = 获取上下文();
    await ctx?.selectCharacterById?.(idx);
  } catch {
    // 忽略（选中失败仅影响自动弹窗，列表已刷新）
  }
}

/* ---------- F2 决策表：本地同步判定 + 按文件独立分流 + 非角色文件事件重放 ---------- */

/** 单个文件的分流结果：接管=本扩展已处理（可带 RP 卡写回 avatar）；重放=非角色文件还原生。 */
type 分流结果 = { 动作: '已接管'; avatar: string | null } | { 动作: '重放' };

/**
 * 单文件决策表（《修复方案验证报告》§二）：
 *   ① 本地快速判定为 RP（PNG rphub 块 / JSON rp_hub 特征）→ 插件上传（免网络等待）；
 *   ② 后端 analyze 判定为 RP（手动标记等后端独有判据）→ 插件上传；
 *   ③ 本地判定为 ST 标准角色卡（chara/ccv3/spec v2）→ 复刻原生的 原生导入()；
 *   ④ 其余（世界书 / 预设 / 背景图 / 损坏 / unknown 且后端无记录）→ 重放给原生，
 *      保证预设 JSON、世界书、backgrounds 等原生拖拽场景行为不被改变。
 */
async function 分流单个文件(file: File): Promise<分流结果> {
  const local = await 本地判定卡类型(file);
  if (local === 'rp') {
    return { 动作: '已接管', avatar: await 接管上传RP卡(file, '本地') };
  }
  const { rp, 失败 } = await 分析文件(file);
  if (!失败 && rp) {
    return { 动作: '已接管', avatar: await 接管上传RP卡(file, '后端') };
  }
  if (local === 'st') {
    const a = await 原生导入(file);
    if (a) {
      toastr.success(`已按酒馆原生流程导入角色：${a}`);
    } else {
      toastr.error(`角色导入失败：${file.name}`);
    }
    return { 动作: '已接管', avatar: null };
  }
  return { 动作: '重放' };
}

/** RP 卡上传 + 成功提示（上传失败提示已在 上传RP卡 内部）；返回写回的标准卡 avatar（可能 null）。 */
async function 接管上传RP卡(file: File, 通道: '本地' | '后端'): Promise<string | null> {
  const a = await 上传RP卡(file);
  toastr.success(`RP 卡已上传${a ? `：${a}` : '（插件已落盘，写回 ST 失败）'}（判定：${通道}）`);
  return a;
}

/**
 * 处理一组白名单文件（drop/change 共用）：按文件独立决策，返回需要重放还原生流程的文件。
 * 废除旧「组内含 RP 卡即整组接管」——多文件混合时各走各的通道。
 */
export async function 处理文件组(files: File[]): Promise<File[]> {
  const 列表 = Array.isArray(files) ? files : [];
  let RP头像: string | null = null;
  let 已接管数 = 0;
  const 重放: File[] = [];
  for (const file of 列表) {
    const 结果 = await 分流单个文件(file);
    if (结果.动作 === '已接管') {
      已接管数 += 1;
      RP头像 ??= 结果.avatar;
    } else {
      重放.push(file);
    }
  }
  // 任一文件被本扩展接管（上传/导入）后才刷新角色列表并尝试自动选中；纯重放组不动原生流程
  if (已接管数 > 0) {
    await 刷新列表();
    if (RP头像) await 选中角色(RP头像);
  }
  return 重放;
}

/* ---------- 拦截挂载（浏览器 iframe 环境） ---------- */

let 已启动 = false;
let 已关闭 = false;

interface ImportDispatcher {
  handleDrop: (e: DragEvent) => boolean;
  handleChange: (e: Event) => boolean;
}

declare global {
  interface Window {
    __RPH_IMPORT_DISPATCHER__?: ImportDispatcher;
  }
}

/** F2：本扩展自己合成并派发的重放 drop 事件（防止分发器二次捕获造成死循环） */
const 重放事件 = new WeakSet<DragEvent>();

/** 目录拖入检测：webkitGetAsEntry().kind === 'directory' → 整组放行原生（原生支持文件夹批量导入）。 */
function 含目录拖入(e: DragEvent): boolean {
  const items = e.dataTransfer?.items;
  if (!items) return false;
  for (let i = 0; i < items.length; i++) {
    try {
      const entry = (items[i] as DataTransferItem & { webkitGetAsEntry?: () => { kind?: string } | null })
        .webkitGetAsEntry?.();
      if (entry && entry.kind === 'directory') return true;
    } catch {
      // 条目访问失败忽略，继续检查其余条目
    }
  }
  return false;
}

/** 合成 bubble 阶段 drop 事件把文件还原生流程（复用原 dataTransfer；仅重放子集时重建 DataTransfer）。 */
function 重放drop(e: DragEvent, files?: File[]): void {
  try {
    let dataTransfer = e.dataTransfer;
    if (files && files.length > 0) {
      const 重建 = new DataTransfer();
      for (const f of files) 重建.items.add(f);
      dataTransfer = 重建;
    }
    if (!dataTransfer || !dataTransfer.files.length) return;
    const 合成 = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });
    重放事件.add(合成);
    (e.target as Element | null)?.dispatchEvent(合成);
    console.info(`[第三部] 导入拦截：已重放 ${dataTransfer.files.length} 个非角色文件给酒馆原生流程`);
  } catch (err) {
    console.warn('[第三部] 导入拦截：重放非角色文件失败：', err instanceof Error ? err.message : err);
  }
}

/**
 * 拦截拖拽（捕获阶段，父窗口 document）。返回 true = 已接管。
 * F2 决策表：同步取得处理权（preventDefault + stopPropagation + stopImmediatePropagation），
 * 异步按文件独立分流——RP 卡上传 / ST 角色卡 原生导入() / 其余（世界书、预设、背景图等）
 * 以合成 drop 事件重放还原生流程，杜绝旧版「无差别拦截破坏原生」与「异步判定后阻断失效」两类缺陷。
 */
function 拦截drop(e: DragEvent): boolean {
  if (重放事件.has(e)) return false; // 本扩展合成的重放事件 → 直接放行
  if (已关闭) {
    console.debug('[第三部] 导入拦截已关闭（__thp导入拦截__.开启() 恢复）');
    return false;
  }
  if (!导入拦截已启用()) {
    console.warn('[第三部] 导入拦截总开关关闭（thp_import_intercept_enabled === "false"），未拦截');
    return false;
  }
  const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
  if (files.length === 0) {
    console.debug('[第三部] 拖入无文件（URL 文本）→ 交 ST importFromURL');
    return false;
  }
  const 角色文件 = files.filter(file => 文件允许(file));
  if (角色文件.length === 0) {
    console.debug('[第三部] 拖入文件不在角色白名单（json/png/yaml/yml/charx/byaf）→ 交 ST 其它 drop 处理',
      files.map(f => f.name));
    return false;
  }
  // 其它 drop 区（附件弹窗 / 聊天弹窗 / 聊天导入 / 画廊）→ 不拦截
  const 目标 = e.target as Element | null;
  if (目标 && typeof 目标.closest === 'function') {
    try {
      if (目标.closest(排除选择器)) {
        console.debug('[第三部] 拖入位置在排除区（附件/聊天/画廊）→ 不拦截');
        return false;
      }
    } catch {
      // closest 异常忽略，继续拦截
    }
  }
  // 文件夹拖入 → 整组放行原生（原生 webkitGetAsEntry 批量导入）
  if (含目录拖入(e)) {
    console.debug('[第三部] 拖入包含文件夹 → 整组交 ST 原生批量导入');
    return false;
  }

  // 同步接管（此时无法区分内容，但白名单内文件的浏览器默认行为与 ST 处理权一并收归本扩展；
  // 非 RP/非角色文件及混合拖入的非白名单附件稍后经 重放drop 完整还原生流程）
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  void (async () => {
    const 非角色文件 = files.filter(file => !文件允许(file));
    const 重放 = await 处理文件组(角色文件);
    const 全部重放 = [...重放, ...非角色文件];
    if (全部重放.length > 0) {
      重放drop(e, 全部重放.length === files.length ? undefined : 全部重放);
    }
  })();
  return true;
}

/**
 * 拦截文件选择（捕获阶段，父窗口 document；命中 #character_import_file）。返回 true = 已接管。
 * 该 input 的用户意图就是「导入角色」→ 无需重放：RP 卡上传，其余一律 原生导入()
 * （含 yaml/charx/byaf 等本地不可判定格式，与原生行为一致）；finally 清空 input.value
 * （保证同一文件可重复选择触发 change）。
 */
function 拦截change(e: Event): boolean {
  if (已关闭 || !导入拦截已启用()) return false;
  const input = e.target as HTMLInputElement | null;
  if (!input || input.id !== 'character_import_file') return false;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length === 0) return false;

  // 同步接管：change 监听为同步派发，任何「先 await 再阻断」的写法都晚于 ST 原生 handler（F2 死代码教训）
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  void (async () => {
    try {
      for (const f of files) {
        const local = await 本地判定卡类型(f);
        if (local === 'rp') {
          await 接管上传RP卡(f, '本地');
          continue;
        }
        const { rp, 失败 } = await 分析文件(f);
        if (!失败 && rp) {
          await 接管上传RP卡(f, '后端');
          continue;
        }
        const a = await 原生导入(f);
        if (a) toastr.success(`已按酒馆原生流程导入角色：${a}`);
        else toastr.error(`角色导入失败：${f.name}`);
      }
      await 刷新列表();
    } finally {
      input.value = '';
    }
  })();
  return true;
}

/**
 * 启动导入拦截（index.ts 挂载时调用）。
 * 在 window.top 上挂载单例代理分发器 window.__RPH_IMPORT_DISPATCHER__，iframe 重载时仅替换 handler，杜绝多次重复绑定。
 */
export function 启动导入拦截(): void {
  if (已启动) return;
  已启动 = true;

  const dispatcher: ImportDispatcher = {
    handleDrop: e => 拦截drop(e),
    handleChange: e => 拦截change(e),
  };

  const 宿主窗口 = window.top ?? window.parent ?? window;
  宿主窗口.__RPH_IMPORT_DISPATCHER__ = dispatcher;

  // 如果宿主尚未绑定代理监听器，则进行一次性绑定
  const doc = 宿主窗口.document;
  if (doc && !(doc as any).__RPH_LISTENER_ATTACHED__) {
    (doc as any).__RPH_LISTENER_ATTACHED__ = true;
    doc.addEventListener('drop', (e: DragEvent) => {
      宿主窗口.__RPH_IMPORT_DISPATCHER__?.handleDrop(e);
    }, true);
    doc.addEventListener('change', (e: Event) => {
      宿主窗口.__RPH_IMPORT_DISPATCHER__?.handleChange(e);
    }, true);
    console.info('[第三部] 导入拦截：已在宿主 document 注册单例捕获分发器');
  }

  // 浏览器控制台诊断入口：
  try {
    (window as unknown as Record<string, unknown>).__thp导入拦截__ = {
      判定是否为RP卡,
      导入拦截已启用,
      设置导入拦截开关,
      处理文件组,
      关闭: () => { 已关闭 = true; },
      开启: () => { 已关闭 = false; },
    };
  } catch {
    // 忽略
  }

  console.info(`[第三部] 导入拦截已启动：单例代理模式（总开关=${导入拦截已启用() ? '开' : '关'}）`);
}

/**
 * 停止导入拦截并清理分发器。
 */
export function 停止导入拦截(): void {
  const 宿主窗口 = window.top ?? window.parent ?? window;
  if (宿主窗口.__RPH_IMPORT_DISPATCHER__) {
    delete 宿主窗口.__RPH_IMPORT_DISPATCHER__;
  }
  已启动 = false;
  try {
    delete (window as unknown as Record<string, unknown>).__thp导入拦截__;
  } catch {
    // 忽略
  }
  console.info('[第三部] 导入拦截已停止：已注销分发器 handler');
}
