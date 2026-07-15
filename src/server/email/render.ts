import { marked } from 'marked';
import type { EmailFormat } from './types';

/**
 * 三格式 → 邮件正文。markdown 的纯文本副本即原文（markdown 本身可读，零成本降级）；
 * html / text 原样透传不做转换。marked 不 sanitize：发出的邮件由收件方客户端处理；
 * 本项目 UI 内的预览/回看一律走 sandbox iframe（EmailPreview），不直接注入 DOM。
 */
export function renderBody(format: EmailFormat, content: string): { html?: string; text?: string } {
  switch (format) {
    case 'markdown':
      // async: false 保证同步返回 string（marked 默认开启 GFM）
      return { html: marked.parse(content, { async: false }) as string, text: content };
    case 'html':
      return { html: content };
    case 'text':
      return { text: content };
  }
}
