"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.取更新提示词 = 取更新提示词;
exports.parseRanges = parseRanges;
exports.替换卡面提示词 = 替换卡面提示词;
/** 取模板的变量更新提示词（variableSchema._update_rules），无则返回空串 */
function 取更新提示词(模板) {
    var _a;
    const 规则 = (_a = 模板 === null || 模板 === void 0 ? void 0 : 模板.variableSchema) === null || _a === void 0 ? void 0 : _a._update_rules;
    return typeof 规则 === 'string' ? 规则 : '';
}
/** 严格整数段（允许前导负号） */
const 整数段 = /^-?\d+$/;
/**
 * 解析 Python range 语法得到索引序列（纯函数）。
 * @param spec `:` 分隔的 1~3 段字符串（不含前缀 `_`），如 `1:5`、`:5`、`5:`、`5:11:2`、`::2`、`5:0:-2`
 * @param len 模板总数（数组长度）
 * @returns 索引数组；无效或 len<=0 返回 []
 */
function parseRanges(spec, len) {
    if (len <= 0)
        return [];
    const 段 = spec.split(':');
    if (段.length < 1 || 段.length > 3)
        return [];
    let start = 0;
    let stop = len;
    let step = 1;
    if (段.length === 1) {
        if (段[0] === '') {
            // 空 spec = range(0, len)，全部
            return Array.from({ length: len }, (_, i) => i);
        }
        // 单段 = range(stop)：`5` → range(0, 5)
        if (!整数段.test(段[0]))
            return [];
        stop = Number(段[0]);
    }
    else {
        if (段[0] !== '') {
            if (!整数段.test(段[0]))
                return [];
            start = Number(段[0]);
        }
        if (段[1] !== '') {
            if (!整数段.test(段[1]))
                return [];
            stop = Number(段[1]);
        }
        if (段.length === 3 && 段[2] !== '') {
            if (!整数段.test(段[2]))
                return [];
            step = Number(段[2]);
        }
    }
    if (step === 0)
        return [];
    const out = [];
    if (step > 0) {
        for (let i = start; i < stop; i += step) {
            if (i >= 0 && i < len)
                out.push(i);
        }
    }
    else {
        for (let i = start; i > stop; i += step) {
            if (i >= 0 && i < len)
                out.push(i);
        }
    }
    return out;
}
/** 占位符整体匹配：`{{rpcard_update_rules}}` / `_all` 别名 / `_<range 段>` */
const 占位符模式 = /\{\{rpcard_update_rules(?:_all)?(?:_[^{}]*)?\}\}/g;
/** 一条模板的「标题 + 提示词」段落（含换行），无提示词返回空串 */
function 拼一段(模板, 索引) {
    var _a, _b;
    const 提示词 = 取更新提示词(模板);
    if (!提示词)
        return '';
    const 名称 = (_b = (_a = 模板.name) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : '';
    const 标题 = 名称 && 模板.id ? `【${名称} · ${模板.id}】` : `【${名称 || 模板.id || `#${索引}`}】`;
    return `${标题}\n${提示词}\n`;
}
/**
 * 把模板文本中的卡面提示词占位符替换为对应模板 variableSchema._update_rules 的拼接。
 * 命中的多个模板提示词每段带模板名标题；全部取不到 / 越界 / 无模板 → 空字符串。
 * 只处理本组占位符，不触碰 {{char}} 等酒馆宏。
 */
function 替换卡面提示词(模板, 模板列表) {
    if (!模板)
        return 模板;
    const 列表 = Array.isArray(模板列表) ? 模板列表 : [];
    return 模板.replace(占位符模式, match => {
        const 核心 = match.slice(2, -2);
        const 后缀 = 核心.startsWith('rpcard_update_rules') ? 核心.slice('rpcard_update_rules'.length) : '';
        let 索引;
        if (后缀 === '' || 后缀 === '_all') {
            索引 = 列表.map((_, i) => i);
        }
        else if (后缀.startsWith('_')) {
            索引 = parseRanges(后缀.slice(1), 列表.length);
        }
        else {
            索引 = [];
        }
        let 拼接 = '';
        for (const i of 索引) {
            拼接 += 拼一段(列表[i], i);
        }
        return 拼接;
    });
}
