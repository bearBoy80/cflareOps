import { describe, expect, it } from 'vitest';
import { isCronExpression, validateCrons } from '../../src/lib/cronValidation';

describe('isCronExpression', () => {
  it.each(['*/30 * * * *', '0 3 * * MON', '5 0 * 8 *', '0,30 1-5 * JAN-MAR SUN'])('accepts %s', (c) => {
    expect(isCronExpression(c)).toBe(true);
  });

  it.each([
    '', // 空串
    '   ', // 仅空白
    '* * * *', // 4 段
    '* * * * * *', // 6 段
    '@daily', // 宏写法不支持（1 段）
    '* * * * ?', // ? 不在字符集内
    '*/30 * * * *; rm -rf /', // 非法字符
  ])('rejects %s', (c) => {
    expect(isCronExpression(c)).toBe(false);
  });

  it('is deliberately loose: only field count + charset are checked (CF validates authoritatively)', () => {
    // 字母在月/星期名字段合法，校验器不做逐字段语义解析——'foo bar baz qux quux' 按字符集放行
    expect(isCronExpression('foo bar baz qux quux')).toBe(true);
    // 多余空白（含首尾）被归一化
    expect(isCronExpression('  */30   *  * * *  ')).toBe(true);
  });
});

describe('validateCrons', () => {
  it('returns indexes of invalid entries', () => {
    expect(validateCrons(['*/30 * * * *', '@daily', '0 3 * * MON', '* * * *'])).toEqual([1, 3]);
  });

  it('returns empty array when all entries are valid (or list is empty)', () => {
    expect(validateCrons(['*/30 * * * *', '5 0 * 8 *'])).toEqual([]);
    expect(validateCrons([])).toEqual([]);
  });
});
