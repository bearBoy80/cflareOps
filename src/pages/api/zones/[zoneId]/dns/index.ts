import type { APIRoute } from 'astro';
import { t } from '../../../../../i18n';
import { DNS_VALIDATION_MESSAGES, validateDnsRecord } from '../../../../../lib/dnsRecordValidation';
import type { CfDnsRecordInput } from '../../../../../server/cf/types';
import { appContext, handleCfError, jsonError } from '../../../../../server/context';
import { clientForZone } from '../../../../../server/zones';

export const GET: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  try {
    const client = await clientForZone(db, key, userEmail, params.zoneId!);
    return Response.json({ records: await client.listDnsRecords(params.zoneId!) });
  } catch (e) {
    return handleCfError(e);
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as CfDnsRecordInput | null;
  if (!body?.type || !body?.name || !body?.content) return jsonError('type/name/content are required', 400);
  const invalid = validateDnsRecord(body);
  if (invalid) return jsonError(t('en', DNS_VALIDATION_MESSAGES[invalid]), 400);
  try {
    const client = await clientForZone(db, key, userEmail, params.zoneId!);
    const record = await client.createDnsRecord(params.zoneId!, {
      type: body.type,
      name: body.name,
      content: body.content,
      ttl: body.ttl ?? 1,
      proxied: body.proxied ?? false,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    });
    return Response.json({ record }, { status: 201 });
  } catch (e) {
    return handleCfError(e);
  }
};
