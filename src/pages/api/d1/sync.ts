import type { APIRoute } from 'astro';
import { appContext } from '@/server/context';
import { syncD1Databases } from '@/server/d1';

export const POST: APIRoute = async ({ locals, request }) => {
  const { db, key, userEmail } = await appContext(locals);
  const accountId = new URL(request.url).searchParams.get('accountId') ?? undefined;
  return Response.json(await syncD1Databases(db, key, userEmail, undefined, accountId));
};
