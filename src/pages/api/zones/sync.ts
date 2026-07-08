import type { APIRoute } from 'astro';
import { appContext } from '../../../server/context';
import { syncAllZones } from '../../../server/zones';

export const POST: APIRoute = async ({ locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const accountId = new URL(request.url).searchParams.get('accountId') ?? undefined;
  return Response.json(await syncAllZones(db, key, userEmail, undefined, accountId));
};
