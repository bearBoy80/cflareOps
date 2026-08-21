export type EmailFormat = 'markdown' | 'html' | 'text';

export interface EmailMessage {
  from: string; // 完整发件地址 local@domain
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  format: EmailFormat;
  content: string;
}

export interface SendResult {
  logId: string;
  status: 'sent' | 'partial' | 'failed';
  messageId: string | null;
  error: string | null;
  delivered: string[];
  queued: string[];
  permanentBounces: string[];
  logged: boolean;
}

/** provider 无关的发送参数：正文已由 renderBody 展开为 html/text */
export interface ProviderSendParams {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
}

export interface ProviderSendOk {
  messageId: string | null;
  delivered?: string[];
  queued?: string[];
  permanentBounces?: string[];
}

export class EmailSendConflictError extends Error {
  constructor(public code: 'sendInProgress' | 'sendAlreadyFailed') {
    super(
      code === 'sendInProgress'
        ? 'an email send with this request ID is still in progress'
        : 'this request ID already failed',
    );
    this.name = 'EmailSendConflictError';
  }
}

/** 发送前校验失败（from 域名不符 / 渲染异常）：路由映射 400，不调 provider、不写 log */
export class EmailValidationError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = 'EmailValidationError';
  }
}
