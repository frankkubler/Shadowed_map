/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Clé des fonds CARTO, lue depuis `.env` (ou l'environnement du job de publication).
   * Sans elle, CARTO sert ses tuiles barrées d'un filigrane « API KEY REQUIRED ».
   * Le préfixe `CARTO_` est déclaré dans `vite.config.ts`, Vite n'exposant par défaut
   * que les variables `VITE_`.
   */
  readonly CARTO_BASEMAPS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
