import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Db, DbStatement } from '@/server/db/types';

/** Internal shape that carries the sync run for use inside batch transactions. */
interface InternalDbStatement extends DbStatement {
  _runSync(): Database.RunResult;
}

function makeStatement(stmt: Database.Statement, params: unknown[]): InternalDbStatement {
  return {
    _runSync() {
      return stmt.run(...params);
    },
    bind(...values: unknown[]) {
      return makeStatement(stmt, values);
    },
    async first<T>() {
      return ((stmt.get(...params) as T | undefined) ?? null) as T | null;
    },
    async all<T>() {
      return { results: stmt.all(...params) as T[] };
    },
    async run() {
      return stmt.run(...params);
    },
  };
}

export function createTestDb(migrationsDir = 'migrations'): Db {
  const sqlite = new Database(':memory:');
  // D1 默认开启外键约束，替身需对齐（better-sqlite3 默认关闭）
  sqlite.pragma('foreign_keys = ON');
  // 按 wrangler 迁移文件命名序依次执行，测试库始终与线上迁移链一致
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(join(migrationsDir, file), 'utf-8'));
  }
  return {
    prepare(sql: string): DbStatement {
      const stmt = sqlite.prepare(sql);
      return makeStatement(stmt, []);
    },
    // Mirrors D1 batch semantics: all statements run inside a single transaction —
    // either all commit or none do (all-or-nothing atomicity).
    async batch<T = unknown>(statements: DbStatement[]): Promise<{ results: T[] }[]> {
      const tx = sqlite.transaction(() => {
        for (const s of statements) {
          (s as InternalDbStatement)._runSync();
        }
      });
      tx();
      return statements.map(() => ({ results: [] as T[] }));
    },
  };
}
