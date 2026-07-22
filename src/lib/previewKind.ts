export type PreviewKind = 'image' | 'text' | 'markdown' | 'pdf' | 'video' | 'audio';

const KIND_BY_EXT: Record<string, PreviewKind> = Object.fromEntries([
  ...['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp'].map((e) => [e, 'image'] as const),
  ...['md', 'markdown'].map((e) => [e, 'markdown'] as const),
  ...[
    'txt',
    'json',
    'js',
    'ts',
    'jsx',
    'tsx',
    'css',
    'html',
    'xml',
    'yaml',
    'yml',
    'toml',
    'csv',
    'log',
    'sh',
    'py',
    'go',
    'rs',
    'java',
    'sql',
    'env',
    'conf',
    'ini',
  ].map((e) => [e, 'text'] as const),
  ['pdf', 'pdf'] as const,
  ...['mp4', 'webm', 'mov', 'm4v'].map((e) => [e, 'video'] as const),
  ...['mp3', 'wav', 'ogg', 'm4a', 'flac'].map((e) => [e, 'audio'] as const),
]);

/** 对象 key → 预览类型；按小写扩展名判断，无扩展名或未知类型返回 null（不可预览，点击直接下载） */
export function previewKind(key: string): PreviewKind | null {
  const base = key.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return KIND_BY_EXT[ext] ?? null;
}
