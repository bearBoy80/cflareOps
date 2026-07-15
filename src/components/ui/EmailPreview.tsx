import { marked } from 'marked';
import { useMemo } from 'react';
import type { EmailFormat } from '@/server/email/types';

/**
 * 预览 = 回看共用组件。存储的用户内容（markdown 渲染产物 / 原样 HTML）一律装进
 * sandbox iframe（srcdoc + sandbox=""，禁脚本禁同源）展示，杜绝 dangerouslySetInnerHTML
 * 直接注入导致的存储型自 XSS。markdown 用与服务端 render.ts 同一版本 marked，
 * 预览所见即实际发出的 HTML 正文。
 */
export default function EmailPreview({ format, content }: { format: EmailFormat; content: string }) {
  const html = useMemo(() => {
    if (format === 'markdown') return marked.parse(content, { async: false }) as string;
    if (format === 'html') return content;
    return null;
  }, [format, content]);

  if (format === 'text') {
    return (
      <pre className="max-h-96 min-h-48 overflow-auto whitespace-pre-wrap rounded border border-base-300 bg-base-200/40 p-3 font-mono text-sm">
        {content}
      </pre>
    );
  }
  return (
    <iframe
      title="email-preview"
      sandbox=""
      srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:16px;font-family:system-ui,sans-serif;line-height:1.6;word-break:break-word">${html}</body>`}
      className="h-96 w-full rounded border border-base-300 bg-white"
    />
  );
}
