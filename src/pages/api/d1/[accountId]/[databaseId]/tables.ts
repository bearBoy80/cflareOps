import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { getCachedD1Database } from '@/server/d1';
import { clientForAccount } from '@/server/workersPages';

/** 单次列出的表数上限:每表 2 条语句(PRAGMA + COUNT),100 表 = 200 语句,已远超常规库 */
const MAX_TABLES = 100;

/** SQLite 标识符引用:双引号包裹,内部双引号翻倍 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const GET: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const cached = await getCachedD1Database(db, userEmail, params.accountId!, params.databaseId!);
  if (!cached) return jsonError('Database not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    // sqlite_% 为 SQLite 内部表、_cf_% 为 D1 平台内部表(_cf_KV 等),都不展示
    const listed = await client.queryD1Raw(
      cached.cfAccountId,
      cached.uuid,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`,
    );
    const allNames = (listed[0]?.rows ?? []).map((r) => String(r[0]));
    const names = allNames.slice(0, MAX_TABLES);
    if (names.length === 0) return Response.json({ tables: [], truncated: false });

    // 每表两条语句拼成一个分号批:结果集顺序与语句顺序一致(raw 端点契约)
    const batchSql = names
      .map((n) => `PRAGMA table_info(${quoteIdent(n)}); SELECT COUNT(*) FROM ${quoteIdent(n)};`)
      .join(' ');
    const results = await client.queryD1Raw(cached.cfAccountId, cached.uuid, batchSql);

    const tables = names.map((name, i) => {
      const info = results[i * 2];
      const count = results[i * 2 + 1];
      // PRAGMA table_info 列序:cid, name, type, notnull, dflt_value, pk
      const col = (label: string) => info?.columns.indexOf(label) ?? -1;
      const [cName, cType, cNotnull, cDflt, cPk] = [
        col('name'),
        col('type'),
        col('notnull'),
        col('dflt_value'),
        col('pk'),
      ];
      return {
        name,
        rowCount: Number(count?.rows[0]?.[0] ?? 0),
        columns: (info?.rows ?? []).map((r) => ({
          name: String(r[cName] ?? ''),
          type: String(r[cType] ?? ''),
          notnull: Number(r[cNotnull] ?? 0) === 1,
          pk: Number(r[cPk] ?? 0) > 0,
          dflt_value: r[cDflt] == null ? null : String(r[cDflt]),
        })),
      };
    });
    return Response.json({ tables, truncated: allNames.length > names.length });
  } catch (e) {
    return handleCfError(e);
  }
};
