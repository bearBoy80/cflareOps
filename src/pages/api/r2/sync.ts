import type { APIRoute } from 'astro';
import { appContext } from '@/server/context';
import { syncR2Buckets } from '@/server/r2';

export const POST: APIRoute = async ({ locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const accountId = new URL(request.url).searchParams.get('accountId') ?? undefined;
  return Response.json(await syncR2Buckets(db, key, userEmail, undefined, accountId));
};
