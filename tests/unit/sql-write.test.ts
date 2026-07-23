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
    'SELECT 1 /* ; DROP TABLE t;', // 未闭合块注释:SQLite 视为注释延伸到 EOF,不会执行其中内容
    '/* DELETE FROM t */ SELECT 2 /* drop', // 已闭合注释 + 未闭合注释吞到 EOF,均不算写
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
  ])('fail closed on unterminated quote: %s', (sql) => {
    expect(isWriteSql(sql)).toBe(true);
  });
});
