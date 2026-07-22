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
});
