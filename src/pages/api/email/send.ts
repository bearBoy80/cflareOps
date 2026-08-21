import type { APIRoute } from 'astro';
import { CfApiError } from '@/server/cf/client';
import { appContext, handleCfError, jsonError } from '@/server/context';
import { type SendDeps, sendEmail } from '@/server/email';
import { type EmailFormat, EmailSendConflictError, EmailValidationError } from '@/server/email/types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FORMATS: readonly string[] = ['markdown', 'html', 'text'];

/** 仅测试用：注入假 provider（生产代码不调用）。Astro 路由没有构造注入点，用模块级钩子。 */
let testDeps: SendDeps | undefined;
export function __setSendDeps(deps: SendDeps | undefined): void {
  testDeps = deps;
}

interface SendBody {
  domainId?: string;
  from?: string;
  fromName?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  format?: string;
  content?: string;
  requestId?: string;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => null)) as SendBody | null;
  const to = Array.isArray(body?.to) ? body.to : [];
  const cc = Array.isArray(body?.cc) ? body.cc : [];
  const bcc = Array.isArray(body?.bcc) ? body.bcc : [];
  if (
    !body?.domainId ||
    !body.from?.trim() ||
    to.length === 0 ||
    !body.subject?.trim() ||
    !body.content?.trim() ||
    !FORMATS.includes(body.format ?? '')
  ) {
    return jsonError('domainId, from, to, subject, format and content are required', 400, 'fieldsRequired');
  }
  const bad = [body.from, ...to, ...cc, ...bcc].find((r) => !EMAIL_RE.test(r));
  if (bad !== undefined) return jsonError(`invalid email address: ${bad}`, 400, 'invalidRecipient');
  if (to.length + cc.length + bcc.length > 50) {
    return jsonError('at most 50 combined recipients are allowed', 400, 'tooManyRecipients');
  }
  const requestId =
    typeof body.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(body.requestId) ? body.requestId : undefined;

  const ctx = await appContext(locals);
  try {
    const result = await sendEmail(
      ctx,
      body.domainId,
      {
        from: body.from.trim(),
        fromName: body.fromName?.trim() || undefined,
        to,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        subject: body.subject.trim(),
        format: body.format as EmailFormat,
        content: body.content,
      },
      testDeps ?? {},
      requestId,
    );
    return Response.json(result);
  } catch (e) {
    if (e instanceof EmailValidationError) return jsonError(e.message, 400, e.code);
    if (e instanceof EmailSendConflictError) return jsonError(e.message, 409, e.code);
    // CF token 缺 Email Sending 权限等 403：仅该动作失败，带稳定 code 供前端本地化提示
    if (e instanceof CfApiError && e.status === 403) return jsonError(e.message, 403, 'emailSendForbidden');
    return handleCfError(e);
  }
};
