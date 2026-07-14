import type { APIRoute } from 'astro';
import { appContext } from '@/server/context';
import { countAccounts } from '@/server/db/accounts';
import { workersStats } from '@/server/workersPages';
import { zoneStats } from '@/server/zones';

export const GET: APIRoute = async ({ locals }) => {
  const { db, userEmail } = await appContext(locals);
  const [accounts, zones, workers] = await Promise.all([
    countAccounts(db, userEmail),
    zoneStats(db, userEmail),
    workersStats(db, userEmail),
  ]);
  return Response.json({ accounts, zones, workers });
};
