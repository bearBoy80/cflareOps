/**
 * 用临时 <a> 触发浏览器下载（URL 需自带 Content-Disposition: attachment）。
 * 不用 window.open：Safari 会拦截 await 之后的 window.open，锚点点击不受弹窗拦截影响。
 */
export function triggerDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
