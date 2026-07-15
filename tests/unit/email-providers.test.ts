import { describe, expect, it } from 'vitest';
import { CfApiError } from '@/server/cf/client';
import { sendViaCloudflare } from '@/server/email/providers/cloudflare';
import { sendViaResend } from '@/server/email/providers/resend';
import type { ProviderSendParams } from '@/server/email/types';

const PARAMS: ProviderSendParams = {
  from: 'no-reply@mail.example.com',
  fromName: 'Ops',
  to: ['a@b.co'],
  cc: ['c@d.co'],
  subject: 'Hi',
  html: '<p>hi</p>',
  text: 'hi',
};

describe('sendViaResend', () => {
  it('assembles the payload (display-name from, omits empty bcc) and returns the message id', async () => {
    let seen: Record<string, unknown> = {};
    const r = await sendViaResend('key-1', PARAMS, () => ({
      emails: {
        async send(payload) {
          seen = payload;
          return { data: { id: 'rid-1' }, error: null };
        },
      },
    }));
    expect(r.messageId).toBe('rid-1');
    expect(seen.from).toBe('Ops <no-reply@mail.example.com>');
    expect(seen.to).toEqual(['a@b.co']);
    expect(seen.cc).toEqual(['c@d.co']);
    expect('bcc' in seen).toBe(false);
    expect(seen.html).toBe('<p>hi</p>');
    expect(seen.text).toBe('hi');
  });

  it('uses the bare address when no display name is given', async () => {
    let seen: Record<string, unknown> = {};
    await sendViaResend('key-1', { ...PARAMS, fromName: undefined }, () => ({
      emails: {
        async send(payload) {
          seen = payload;
          return { data: { id: 'rid-2' }, error: null };
        },
      },
    }));
    expect(seen.from).toBe('no-reply@mail.example.com');
  });

  it('normalizes {data:null, error} into CfApiError with a mapped status', async () => {
    const call = sendViaResend('bad-key', PARAMS, () => ({
      emails: {
        async send() {
          return { data: null, error: { name: 'invalid_api_key', message: 'API key is invalid' } };
        },
      },
    }));
    await expect(call).rejects.toThrow(CfApiError);
    await expect(
      sendViaResend('bad-key', PARAMS, () => ({
        emails: {
          async send() {
            return { data: null, error: { name: 'invalid_api_key', message: 'API key is invalid' } };
          },
        },
      })),
    ).rejects.toMatchObject({ status: 403, messages: ['API key is invalid'] });
  });

  it('defaults unknown resend error names to 502', async () => {
    await expect(
      sendViaResend('k', PARAMS, () => ({
        emails: {
          async send() {
            return { data: null, error: { name: 'something_new', message: 'boom' } };
          },
        },
      })),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('sendViaCloudflare', () => {
  it('passes an address object when fromName is set and returns the message id', async () => {
    let seenAccount = '';
    let seenParams: Record<string, unknown> = {};
    const client = {
      async sendEmail(accountId: string, params: Record<string, unknown>) {
        seenAccount = accountId;
        seenParams = params;
        return { messageId: 'mid-9' };
      },
    };
    const r = await sendViaCloudflare(client, 'cf-tag-1', PARAMS);
    expect(r.messageId).toBe('mid-9');
    expect(seenAccount).toBe('cf-tag-1');
    expect(seenParams.from).toEqual({ address: 'no-reply@mail.example.com', name: 'Ops' });
    expect(seenParams.to).toEqual(['a@b.co']);
  });

  it('passes a plain string from when no display name is given', async () => {
    let seenParams: Record<string, unknown> = {};
    const client = {
      async sendEmail(_accountId: string, params: Record<string, unknown>) {
        seenParams = params;
        return { messageId: 'mid-10' };
      },
    };
    await sendViaCloudflare(client, 'cf-tag-1', { ...PARAMS, fromName: undefined });
    expect(seenParams.from).toBe('no-reply@mail.example.com');
  });
});
