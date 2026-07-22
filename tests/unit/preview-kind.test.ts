import { describe, expect, it } from 'vitest';
import { previewKind } from '@/lib/previewKind';

describe('previewKind', () => {
  it.each([
    ['photo.jpg', 'image'],
    ['a/b/pic.WEBP', 'image'],
    ['icon.svg', 'image'],
    ['README.md', 'markdown'],
    ['notes.markdown', 'markdown'],
    ['app.ts', 'text'],
    ['config.YAML', 'text'],
    ['.env', 'text'],
    ['data.csv', 'text'],
    ['doc.pdf', 'pdf'],
    ['clip.mp4', 'video'],
    ['song.mp3', 'audio'],
    ['voice.M4A', 'audio'],
  ] as const)('%s → %s', (key, kind) => {
    expect(previewKind(key)).toBe(kind);
  });

  it.each(['archive.zip', 'binary.bin', 'noext', 'weird.', 'dir/noext'])('%s → null', (key) => {
    expect(previewKind(key)).toBeNull();
  });

  // 全列表扫描（与规格逐字一致的六类扩展名表）：防止将来误删/误改单个扩展名而无测试报警
  const FULL_LISTS = [
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
  ];
  it.each(FULL_LISTS)('full-list sweep: .%s → %s', (ext, kind) => {
    expect(previewKind(`file.${ext}`)).toBe(kind);
  });
});
