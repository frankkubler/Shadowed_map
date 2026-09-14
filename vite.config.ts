import { defineConfig } from 'vite';

// Le site est publié sur GitHub Pages sous /Shadowed_map/. En dev on sert à la racine.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/Shadowed_map/' : '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}));
