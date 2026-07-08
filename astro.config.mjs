import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// workerd 缺 MessageChannel，构建产物必须用 react-dom 的 edge SSR 入口；
// 但该入口是 CJS，dev 模式的 Vite module runner 无法加载（Node 下也不需要它）
const isBuild = process.argv[2] === 'build';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [react()],
  i18n: {
    defaultLocale: 'zh',
    locales: ['zh', 'en'],
    routing: { prefixDefaultLocale: false },
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: isBuild ? { 'react-dom/server': 'react-dom/server.edge' } : {},
    },
  },
});
