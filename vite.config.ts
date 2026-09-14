import { defineConfig } from 'vite';

// Le site est publié sur GitHub Pages sous /Shadowed_map/. En dev on sert à la racine.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/Shadowed_map/' : '/',
  // La clé des fonds CARTO est nommée CARTO_BASEMAPS_API_KEY : sans ce préfixe
  // supplémentaire, Vite ne l'exposerait pas au client, qui ne voit que `VITE_*`.
  envPrefix: ['VITE_', 'CARTO_'],
  // Le worker de MapLibre v6 est importé via `?worker&url` : le pré-bundler de Vite
  // l'inscrit dans son cache de dépendances sans jamais l'y écrire, et se plaint ensuite
  // de son absence. Laisser ce fichier hors du pré-bundling suffit à le servir tel quel.
  optimizeDeps: {
    exclude: ['maplibre-gl/dist/maplibre-gl-worker.mjs'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}));
