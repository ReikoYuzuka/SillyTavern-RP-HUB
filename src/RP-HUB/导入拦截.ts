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

/**
 * 处理一组角色文件（分流）：
 *   后端可达时：RP 卡 → upload?writeBack=1 + 刷新 + 选中（触发原生弹窗）；原生卡 → 原生导入。
 *   后端不可达（analyze 失败）→ 全部走原生导入（不阻塞导入流程）。
 */
export async function 处理文件组(files: File[]): Promise<void> {
  const 列表 = Array.isArray(files) ? files : [];
  const 原生头像: string[] = [];
  let RP头像: string | null = null;
  let 后端失败 = 0;
  for (const file of 列表) {
    const { rp, 失败, 通道 } = await 分析文件(file);
    if (失败) {
      后端失败 += 1;
      // 后端 analyze 与本地判定都失败（损坏 / 不支持的格式）→ 回退原生导入 + 明确提示
      console.warn(`[第三部] 卡类型判定失败（后端 analyze + 本地判定均不可用），文件「${file.name}」回退为酒馆原生导入`);
      const a = await 原生导入(file);
      if (a) 原生头像.push(a);
      continue;
    }
    if (rp) {
      const a = await 上传RP卡(file);
      if (a) RP头像 ??= a;
      toastr.success(`RP 卡已上传${a ? `：${a}` : '（插件已落盘，写回 ST 失败）'}（判定：${通道}）`);
    } else {
      const a = await 原生导入(file);
      if (a) 原生头像.push(a);
      toastr.success(`已按酒馆原生流程导入：${a ?? file.name}（判定：${通道}）`);
    }
  }
  if (后端失败 > 0 && 后端失败 === 列表.length) {
    console.warn('[第三部] 全部文件卡类型判定失败，导入已回退为酒馆原生流程');
  }
  if (原生头像.length > 0 || RP头像) {
    await 刷新列表();
    if (RP头像) await 选中角色(RP头像);
  }
}

/* ---------- 拦截挂载（浏览器 iframe 环境） ---------- */

let 已启动 = false;
let 已关闭 = false;
/** 已挂监听的目标文档集合（防重复挂载） */
const 已挂载文档 = new Set<Document>();
let drop处理器: ((e: Event) => void) | null = null;
let change处理器: ((e: Event) => void) | null = null;

/** 拦截拖拽（捕获阶段，父窗口 document）。返回 true = 已接管（ST 不再处理） */
function 拦截drop(e: DragEvent): boolean {
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
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  console.info('[第三部] 导入拦截命中：接管 %d 个角色文件 →', 角色文件.length, 角色文件.map(f => f.name));
  void 处理文件组(角色文件);
  return true;
}

/** 拦截文件选择（捕获阶段，父窗口 document；命中 #character_import_file）。返回 true = 已接管 */
function 拦截change(e: Event): boolean {
  if (已关闭 || !导入拦截已启用()) return false;
  const input = e.target as HTMLInputElement | null;
  if (!input || input.id !== 'character_import_file') return false;
  const files = input.files ? Array.from(input.files) : [];
  if (files.length === 0) return false;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  console.info('[第三部] 导入拦截命中：接管文件选择 %d 个 →', files.length, files.map(f => f.name));
  void (async () => {
    try {
      await 处理文件组(files);
    } finally {
      // 清空 input 值，允许重复导入同一文件（对齐 ST change 处理器 script.js:11967）
      input.value = '';
    }
  })();
  return true;
}

/**
 * 启动导入拦截（index.ts 挂载时调用）。
 * 本扩展脚本跑在酒馆助手隐藏 iframe（TH-script--*，srcdoc/blob，与 ST 页面同源）：
 *   挂捕获阶段监听到【父窗口 document】——拖拽/选择事件发生在父文档上，iframe 自身收不到。
 * 健壮挂载：对 window.parent.document / window.top.document / window.document 都尝试挂载
 *   （去重），覆盖 iframe 嵌套深度不同的情况；父窗口跨域不可访问（极端情况）→ 降级不拦截。
 * 诊断：启动时输出挂载目标与总开关状态；每次 drop/change 命中或放行都输出原因。
 */
export function 启动导入拦截(): void {
  if (已启动) return;
  已启动 = true;
  drop处理器 = e => 拦截drop(e as DragEvent);
  change处理器 = e => 拦截change(e);

  const 候选文档: Array<{ 名: string; 文档: Document | null | undefined }> = [];
  try {
    const 父 = window.parent?.document;
    候选文档.push({ 名: 'parent.document', 文档: 父 });
  } catch {
    // 跨域 / 访问异常
  }
  try {
    const 顶 = window.top?.document;
    if (顶 && 顶 !== 候选文档[0]?.文档) 候选文档.push({ 名: 'top.document', 文档: 顶 });
  } catch {
    // 跨域 / 访问异常
  }
  try {
    const 自 = document;
    if (自 && 自 !== 候选文档[0]?.文档 && 自 !== 候选文档[1]?.文档) 候选文档.push({ 名: '自身 document', 文档: 自 });
  } catch {
    // 忽略
  }

  let 挂载数 = 0;
  for (const { 名, 文档 } of 候选文档) {
    if (!文档 || 已挂载文档.has(文档)) continue;
    文档.addEventListener('drop', drop处理器, true);
    文档.addEventListener('change', change处理器, true);
    已挂载文档.add(文档);
    挂载数 += 1;
    console.info(`[第三部] 导入拦截：已挂载 drop/change 捕获监听 → ${名}`);
  }

  if (挂载数 === 0) {
    console.warn('[第三部] 无法访问任何目标 document，导入拦截不可用（ST 原生导入流程不受影响）');
  }

  // 浏览器控制台诊断入口：
  //   __thp导入拦截__.设置开关(false) 关闭拦截；__thp导入拦截__.处理文件组([file]) 手动分流
  try {
    (window as unknown as Record<string, unknown>).__thp导入拦截__ = {
      判定是否为RP卡,
      导入拦截已启用,
      设置导入拦截开关,
      处理文件组,
      已挂载文档数: () => 已挂载文档.size,
      关闭: () => { 已关闭 = true; },
      开启: () => { 已关闭 = false; },
    };
  } catch {
    // 极少数环境不允许扩展 window，忽略
  }

  console.info(`[第三部] 导入拦截已启动：拖入 / 文件选择 → RP 卡（upload?writeBack=1）vs 酒馆原生卡分流（总开关=${导入拦截已启用() ? '开' : '关'}，已挂载 ${挂载数} 个文档）`);
}

/**
 * 停止导入拦截并卸载所有已挂载的捕获监听（🔴-5 修复）。
 * 背景：本脚本跑在酒馆助手隐藏 iframe，但监听挂在 parent/top/自身 document 上——TH「实时监听」
 * 热重载 = 销毁旧 iframe 新建 iframe，挂在父文档上的捕获监听不会随 iframe 关闭自动移除；
 * 不卸载会残留旧闭包（含旧 SillyTavern 引用），一次 drop/change 触发 N 次处理（重复导入/上传）
 * 且内存泄漏。index.ts 的 pagehide 回调调用本函数（对比 挂编辑原文回显 用 window.__rphEditObserver
 * 跨重载 disconnect，本模块此前无等价机制）。
 */
export function 停止导入拦截(): void {
  if (!已启动 && 已挂载文档.size === 0) return;
  for (const 文档 of 已挂载文档) {
    try {
      if (drop处理器) 文档.removeEventListener('drop', drop处理器, true);
      if (change处理器) 文档.removeEventListener('change', change处理器, true);
    } catch {
      // 跨域 / 文档已销毁 → 忽略
    }
  }
  已挂载文档.clear();
  drop处理器 = null;
  change处理器 = null;
  已启动 = false;
  try {
    delete (window as unknown as Record<string, unknown>).__thp导入拦截__;
  } catch {
    // 忽略
  }
  console.info('[第三部] 导入拦截已停止：已卸载所有 drop/change 捕获监听');
}
