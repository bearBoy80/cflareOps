import { describe, expect, it } from 'vitest';
import { isWriteSql } from '@/lib/sqlWrite';

describe('isWriteSql', () => {
  it.each([
    'SELECT * FROM users',
    '  select 1',
    'PRAGMA table_info("users")',
    'EXPLAIN QUERY PLAN SELECT * FROM t',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    "SELECT * FROM logs WHERE msg = 'please update me'", // 字符串字面量里的写关键词不算
    '-- delete everything\nSELECT 1', // 注释里的写关键词不算
    '/* drop table? no */ SELECT 2',
    'PRAGMA table_info(users)', // 查询型 PRAGMA(无赋值)不算写
    'PRAGMA foreign_key_list(`t`)',
  ])('read-only: %s', (sql) => {
    expect(isWriteSql(sql)).toBe(false);
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'update t set a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'ALTER TABLE t ADD COLUMN c TEXT',
    'CREATE TABLE t (id INTEGER)',
    'REPLACE INTO t VALUES (1)',
    'WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM doomed)', // CTE 后接写语句
    'SELECT 1; DROP TABLE t', // 多语句批中的写语句
    'VACUUM',
    'ANALYZE', // 写 sqlite_stat 统计表
    'analyze main.t',
    'PRAGMA defer_foreign_keys = on', // 带赋值的 PRAGMA 改设置,按写对待
    'PRAGMA optimize', // 隐式 ANALYZE
  ])('write: %s', (sql) => {
    expect(isWriteSql(sql)).toBe(true);
  });

  it('treats empty/whitespace input as read-only (no confirm popup on empty run)', () => {
    expect(isWriteSql('')).toBe(false);
    expect(isWriteSql('   \n ')).toBe(false);
  });

  it.each([
    "SELECT * FROM t WHERE name = 'unterminated; DROP TABLE t; --",
    'SELECT `col FROM t; DROP TABLE t;',
    'SELECT * FROM users WHERE email = "foo@bar.com; DELETE FROM users;',
    'SELECT 1 /* ; DROP TABLE t;', // 未闭合块注释吞掉剩余输入,同引号 fail closed(SQL 由 D1 服务端切分执行,本地不假设其注释语义)
    '/* DELETE FROM t */ SELECT 2 /* drop',
  ])('fail closed on unterminated quote/comment: %s', (sql) => {
    expect(isWriteSql(sql)).toBe(true);
  });
});
