/**
 * 卡面变量更新提示词占位符：Python range 语法解析 + 替换（纯函数，无副作用）。
 *
 * 占位符形态（索引从 0 开始，对齐 Python range）：
 *   {{rpcard_update_rules}}           = range(0, len)   全部模板提示词
 *   {{rpcard_update_rules_all}}       = range(0, len)   全部（别名）
 *   {{rpcard_update_rules_1:5}}       = range(1,5)      索引 1..4（stop 不含）
 *   {{rpcard_update_rules_:5}}        = range(0,5)      索引 0..4
 *   {{rpcard_update_rules_5:}}        = range(5,len)    索引 5..末尾
 *   {{rpcard_update_rules_5:11:2}}    = range(5,11,2)   5,7,9
 *   {{rpcard_update_rules_::2}}       = range(0,len,2)  0,2,4,...
 *   {{rpcard_update_rules_5:0:-2}}    = range(5,0,-2)   5,3,1（负 step 倒序）
 *
 * 解析规则：后缀 `_` 后按 `:` 分 1~3 段 → start/stop/step。
 *   空段默认：start 空 → 0、stop 空 → len、step 空 → 1；单段视为 stop（同 range(stop)）。
 *   无效（非整数段 / step=0）或 len=0 时返回空数组 → 替换为空字符串。
 *   越界索引（<0 或 >=len）在生成时过滤。
 */

/** 卡面变量模板（后端 GET .../cards/{cardId}/variables → variables.uiTemplates 数组元素） */
export interface 卡面变量模板 {
  id: string;
  name?: string;
  enabled?: boolean;
  scope?: unknown;
  order?: unknown;
  placement?: unknown;
  htmlTemplate?: unknown;
  initialVariableState?: unknown;
  variableState?: unknown;
  /** 变量说明：对象（含 _update_rules）或整段规则字符串（真实世界模拟器V2.1 等卡形态） */
  variableSchema?: Record<string, unknown> | string;
  updateMode?: unknown;
}

/**
 * 取模板的变量更新提示词：
 *   - variableSchema 为对象 → 取 _update_rules 字段；
 *   - variableSchema 为字符串 → 整段即提示词（真实世界模拟器V2.1 等卡把规则直接写在字符串里）；
 * 无则返回空串。
 */
export function 取更新提示词(模板: 卡面变量模板 | undefined): string {
  if (!模板) return '';
  const schema = 模板.variableSchema;
  if (typeof schema === 'string') return schema.trim();
  if (schema && typeof schema === 'object') {
    const 规则 = (schema as Record<string, unknown>)._update_rules;
    if (typeof 规则 === 'string') return 规则;
  }
  return '';
}

/** 严格整数段（允许前导负号） */
const 整数段 = /^-?\d+$/;

/**
 * 解析 Python range 语法得到索引序列（纯函数）。
 * @param spec `:` 分隔的 1~3 段字符串（不含前缀 `_`），如 `1:5`、`:5`、`5:`、`5:11:2`、`::2`、`5:0:-2`
 * @param len 模板总数（数组长度）
 * @returns 索引数组；无效或 len<=0 返回 []
 */
export function parseRanges(spec: string, len: number): number[] {
  if (len <= 0) return [];
  const 段 = spec.split(':');
  if (段.length < 1 || 段.length > 3) return [];

  let start = 0;
  let stop = len;
  let step = 1;

  if (段.length === 1) {
    if (段[0] === '') {
      // 空 spec = range(0, len)，全部
      return Array.from({ length: len }, (_, i) => i);
    }
    // 单段 = range(stop)：`5` → range(0, 5)
    if (!整数段.test(段[0])) return [];
    stop = Number(段[0]);
  } else {
    if (段[0] !== '') {
      if (!整数段.test(段[0])) return [];
      start = Number(段[0]);
    }
    if (段[1] !== '') {
      if (!整数段.test(段[1])) return [];
      stop = Number(段[1]);
    }
    if (段.length === 3 && 段[2] !== '') {
      if (!整数段.test(段[2])) return [];
      step = Number(段[2]);
    }
  }

  if (step === 0) return [];

  const out: number[] = [];
  if (step > 0) {
    for (let i = start; i < stop; i += step) {
      if (i >= 0 && i < len) out.push(i);
    }
  } else {
    for (let i = start; i > stop; i += step) {
      if (i >= 0 && i < len) out.push(i);
    }
  }
  return out;
}

/** 占位符整体匹配：`{{rpcard_update_rules}}` / `_all` 别名 / `_<range 段>` */
const 占位符模式 = /\{\{rpcard_update_rules(?:_all)?(?:_[^{}]*)?\}\}/g;

/** 一条模板的「标题 + 提示词」段落（含换行），无提示词返回空串 */
function 拼一段(模板: 卡面变量模板, 索引: number): string {
  const 提示词 = 取更新提示词(模板);
  if (!提示词) return '';
  const 名称 = 模板.name?.trim() ?? '';
  const 标题 = 名称 && 模板.id ? `【${名称} · ${模板.id}】` : `【${名称 || 模板.id || `#${索引}`}】`;
  return `${标题}\n${提示词}\n`;
}

/**
 * 把模板文本中的卡面提示词占位符替换为对应模板 variableSchema（或 _update_rules）的拼接。
 * 命中的多个模板提示词每段带模板名标题；全部取不到 / 越界 → 空字符串。
 * 无模板列表时保留占位符原样（预览/注入不应把 {{rpcard_update_rules}} 替换成空）。
 * 只处理本组占位符，不触碰 {{char}} 等酒馆宏。
 */
export function 替换卡面提示词(模板: string, 模板列表: 卡面变量模板[]): string {
  if (!模板) return 模板;
  const 列表 = Array.isArray(模板列表) ? 模板列表 : [];
  if (列表.length === 0) return 模板; // 无模板 → 保留占位符原样（不替换成空）
  return 模板.replace(占位符模式, match => {
    const 核心 = match.slice(2, -2);
    const 后缀 = 核心.startsWith('rpcard_update_rules') ? 核心.slice('rpcard_update_rules'.length) : '';
    let 索引: number[];
    if (后缀 === '' || 后缀 === '_all') {
      索引 = 列表.map((_, i) => i);
    } else if (后缀.startsWith('_')) {
      索引 = parseRanges(后缀.slice(1), 列表.length);
    } else {
      索引 = [];
    }
    let 拼接 = '';
    for (const i of 索引) {
      拼接 += 拼一段(列表[i], i);
    }
    return 拼接;
  });
}
