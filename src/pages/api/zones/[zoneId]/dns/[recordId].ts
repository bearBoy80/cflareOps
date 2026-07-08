import type { APIRoute } from 'astro';
import { t } from '../../../../../i18n';
import { DNS_VALIDATION_MESSAGES, validateDnsRecord } from '../../../../../lib/dnsRecordValidation';
import type { CfDnsRecordInput } from '../../../../../server/cf/types';
import { appContext, handleCfError, jsonError } from '../../../../../server/context';
import { clientForZone } from '../../../../../server/zones';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  const body = (await request.json().catch(() => null)) as CfDnsRecordInput | null;
  if (!body?.type || !body?.name || !body?.content) return jsonError('type/name/content are required', 400);
  const invalid = validateDnsRecord(body);
  if (invalid) return jsonError(t('en', DNS_VALIDATION_MESSAGES[invalid]), 400);
  try {
    const client = await clientForZone(db, key, userEmail, params.zoneId!);
    const record = await client.updateDnsRecord(params.zoneId!, params.recordId!, {
      type: body.type,
      name: body.name,
      content: body.content,
      ttl: body.ttl ?? 1,
      proxied: body.proxied ?? false,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    });
    return Response.json({ record });
  } catch (e) {
    return handleCfError(e);
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  const { db, key, userEmail } = await appContext(locals);
  try {
    const client = await clientForZone(db, key, userEmail, params.zoneId!);
    await client.deleteDnsRecord(params.zoneId!, params.recordId!);
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleCfError(e);
  }
};
