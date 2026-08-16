const assert = require('node:assert');
const { parseRanges, 替换卡面提示词, 取更新提示词 } = require('./lib/card-prompt.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

// ---------- parseRanges：range 语义各形态 ----------
const len = 8; // 模板总数 8，索引 0..7

t('无后缀全部 = range(0,8)', () => assert.deepStrictEqual(parseRanges('', len), [0,1,2,3,4,5,6,7]));
t('1:5 = range(1,5)', () => assert.deepStrictEqual(parseRanges('1:5', len), [1,2,3,4]));
t(':5 = range(0,5)', () => assert.deepStrictEqual(parseRanges(':5', len), [0,1,2,3,4]));
t('5: = range(5,8)', () => assert.deepStrictEqual(parseRanges('5:', len), [5,6,7]));
t('5:11:2 = range(5,11,2)', () => assert.deepStrictEqual(parseRanges('5:11:2', len), [5,7]));
t('::2 = range(0,8,2)', () => assert.deepStrictEqual(parseRanges('::2', len), [0,2,4,6]));
t('5:0:-2 = range(5,0,-2)', () => assert.deepStrictEqual(parseRanges('5:0:-2', len), [5,3,1]));
t('::-1 = range(0,8,-1) 按 Python range 为空', () => assert.deepStrictEqual(parseRanges('::-1', len), []));
t('7:-1:-1 = range(7,-1,-1) 倒序全部', () => assert.deepStrictEqual(parseRanges('7:-1:-1', len), [7,6,5,4,3,2,1,0]));
t('7:0:-3 倒序隔位', () => assert.deepStrictEqual(parseRanges('7:0:-3', len), [7,4,1]));
t('单段 3 = range(0,3)', () => assert.deepStrictEqual(parseRanges('3', len), [0,1,2]));
t('空段 step=1 : = range(0,8)', () => assert.deepStrictEqual(parseRanges(':', len), [0,1,2,3,4,5,6,7]));
t('start 空 stop 空 step 空 = range(0,8)', () => assert.deepStrictEqual(parseRanges('::', len), [0,1,2,3,4,5,6,7]));

// 越界：索引过滤到 [0, len)
t('负 start 越界被过滤', () => assert.deepStrictEqual(parseRanges('-5:3', len), [0,1,2]));
t('stop 超出 len 被截断', () => assert.deepStrictEqual(parseRanges('5:100', len), [5,6,7]));
t('stop<start 正向为空', () => assert.deepStrictEqual(parseRanges('5:2', len), []));
t('start>=len 为空', () => assert.deepStrictEqual(parseRanges('8:9', len), []));
t('负 stop 正向为空', () => assert.deepStrictEqual(parseRanges('2:-5', len), []));

// 无效输入
t('step=0 无效', () => assert.deepStrictEqual(parseRanges('0:5:0', len), []));
t('非整数段无效', () => assert.deepStrictEqual(parseRanges('a:b', len), []));
t('3.5 非整数无效', () => assert.deepStrictEqual(parseRanges('1:3.5', len), []));
t('超 3 段无效', () => assert.deepStrictEqual(parseRanges('1:2:3:4', len), []));
t('空 spec 单段空串无效', () => assert.deepStrictEqual(parseRanges('', 0), []));

// len=0 / len 边界
t('len=0 空数组', () => assert.deepStrictEqual(parseRanges('0:5', 0), []));
t('len=0 无后缀', () => assert.deepStrictEqual(parseRanges('', 0), []));
t('len 负值空数组', () => assert.deepStrictEqual(parseRanges('', -3), []));

// ---------- 替换卡面提示词 ----------
const 模板 = [
  { id: 'NC-MAP', name: '夜之城交互地图', variableSchema: { _update_rules: '只更新地图剧情变量，不改HTML' } },
  { id: 'INV', name: '背包', variableSchema: { _update_rules: '背包规则' } },
  { id: 'Q', name: '任务', variableSchema: { _update_rules: '任务规则' } },
];
const NO_RULES = { id: 'EMPTY', name: '无规则', variableSchema: {} };

t('全部替换：每段带标题', () => {
  const out = 替换卡面提示词('{{rpcard_update_rules}}', 模板);
  assert.ok(out.includes('【夜之城交互地图 · NC-MAP】\n只更新地图剧情变量，不改HTML\n'), out);
  assert.ok(out.includes('【背包 · INV】\n背包规则\n'), out);
  assert.ok(out.includes('【任务 · Q】\n任务规则\n'), out);
});

t('_all 别名等价全部', () => {
  assert.strictEqual(替换卡面提示词('{{rpcard_update_rules_all}}', 模板), 替换卡面提示词('{{rpcard_update_rules}}', 模板));
});

t('1:3 → 索引 1,2', () => {
  const out = 替换卡面提示词('{{rpcard_update_rules_1:3}}', 模板);
  assert.ok(out.includes('背包规则'), out);
  assert.ok(out.includes('任务规则'), out);
  assert.ok(!out.includes('地图剧情变量'), out);
});

t(':2 → 索引 0,1', () => {
  const out = 替换卡面提示词('{{rpcard_update_rules_:2}}', 模板);
  assert.ok(out.includes('地图剧情变量') && out.includes('背包规则'), out);
  assert.ok(!out.includes('任务规则'), out);
});

t('2: → 索引 2', () => {
  const out = 替换卡面提示词('{{rpcard_update_rules_2:}}', 模板);
  assert.ok(out.includes('任务规则'), out);
  assert.ok(!out.includes('背包规则'), out);
});

t('::2 → 索引 0,2', () => {
  const out = 替换卡面提示词('{{rpcard_update_rules_::2}}', 模板);
  assert.ok(out.includes('地图剧情变量') && out.includes('任务规则'), out);
  assert.ok(!out.includes('背包规则'), out);
});

t('倒序 2:0:-1 → 索引 2,1', () => {
  const out = 替换卡面提示词('{{rpcard_update_rules_2:0:-1}}', 模板);
  assert.ok(out.includes('任务规则') && out.includes('背包规则'), out);
  assert.ok(!out.includes('地图剧情变量'), out);
});

t('越界 → 空', () => {
  assert.strictEqual(替换卡面提示词('{{rpcard_update_rules_5:9}}', 模板), '');
});

t('无模板列表 → 空', () => {
  assert.strictEqual(替换卡面提示词('{{rpcard_update_rules}}', []), '');
});

t('模板无提示词 → 空', () => {
  assert.strictEqual(替换卡面提示词('{{rpcard_update_rules}}', [NO_RULES]), '');
});

t('混合：卡面占位符 + 酒馆宏互不干扰', () => {
  const out = 替换卡面提示词('{{char}} {{rpcard_update_rules_1:2}} {{user}}', 模板);
  assert.strictEqual(out, '{{char}} 【背包 · INV】\n背包规则\n {{user}}');
});

t('无效语法占位符 → 空', () => {
  assert.strictEqual(替换卡面提示词('{{rpcard_update_rules_1:2:0}}', 模板), '');
});

t('无占位符原样返回', () => {
  const s = '你好 {{char}} 世界';
  assert.strictEqual(替换卡面提示词(s, 模板), s);
});

t('取更新提示词：字符串返回 / 非字符串空', () => {
  assert.strictEqual(取更新提示词(模板[0]), '只更新地图剧情变量，不改HTML');
  assert.strictEqual(取更新提示词(undefined), '');
  assert.strictEqual(取更新提示词(NO_RULES), '');
});

// 混合替换顺序稳定性：文本中多个占位符全部替换（用唯一标记检验顺序）
t('文本内多个不同占位符全部替换', () => {
  const out = 替换卡面提示词('{{rpcard_update_rules_0:1}}\n---\n{{rpcard_update_rules_1:2}}\n---\n{{rpcard_update_rules}}', 模板);
  assert.ok(out.includes('【夜之城交互地图 · NC-MAP】'), out);
  assert.ok(out.includes('【背包 · INV】'), out);
  assert.ok(out.includes('【任务 · Q】'), out);
  const a = out.indexOf('---');
  const b = out.indexOf('---', a + 1);
  const c = out.indexOf('---', b + 1);
  assert.ok(out.slice(0, a).includes('夜之城'), out);
  assert.ok(out.slice(a, b).includes('背包') && !out.slice(a, b).includes('任务'), out);
  assert.ok(out.slice(b, c).includes('任务'), out);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
