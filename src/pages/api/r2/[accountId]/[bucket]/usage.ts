import type { APIRoute } from 'astro';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { classifyR2Action, getCachedR2Bucket } from '@/server/r2';
import { clientForAccount } from '@/server/workersPages';

const DAYS = 30;

export const GET: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const bucket = await getCachedR2Bucket(db, userEmail, params.accountId!, params.bucket!);
  if (!bucket) return jsonError('Bucket not found', 404);
  try {
    const client = await clientForAccount(db, key, userEmail, params.accountId!);
    const until = new Date();
    const since = new Date(until.getTime() - DAYS * 86_400_000);
    const [storage, ops] = await Promise.all([
      client.queryR2StorageDaily(bucket.cfAccountId, bucket.name, since.toISOString(), until.toISOString()),
      client.queryR2OperationsDaily(bucket.cfAccountId, bucket.name, since.toISOString(), until.toISOString()),
    ]);
    // 按日聚合 Class A/B（actionType → 类别映射在 server/r2.ts，前端只拿汇总）
    const byDate = new Map<string, { classA: number; classB: number }>();
    for (const o of ops) {
      const row = byDate.get(o.date) ?? { classA: 0, classB: 0 };
      if (classifyR2Action(o.actionType) === 'A') row.classA += o.requests;
      else row.classB += o.requests;
      byDate.set(o.date, row);
    }
    const operations = [...byDate.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return Response.json({ storage: storage.sort((a, b) => a.date.localeCompare(b.date)), operations });
  } catch (e) {
    return handleCfError(e);
  }
};
