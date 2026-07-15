import type { APIRoute } from 'astro';
import { appContext, jsonError } from '@/server/context';
import { getEmailLog } from '@/server/db/emailLog';

export const GET: APIRoute = async ({ params, locals }) => {
  const { db, userEmail } = await appContext(locals);
  const log = await getEmailLog(db, userEmail, params.id!);
  if (!log) return jsonError('Log not found', 404, 'logNotFound');
  return Response.json({ log });
};
