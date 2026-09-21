# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Étage 1 — build
# ---------------------------------------------------------------------------
# Node 22, comme la CI (.github/workflows/ci.yml) : le build ne doit pas passer
# ici sur une version que le dépôt ne vérifie jamais.
FROM node:22-alpine AS build

WORKDIR /app

# Les dépendances sont installées avant de copier les sources : le cache de cet
# étage ne tombe alors que si package-lock.json change, pas à chaque édition de
# src/.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Le site est entièrement statique : la clé CARTO est résolue au build et se
# retrouve en clair dans le bundle. C'est inhérent à ce type de site (cf. le
# commentaire de .github/workflows/pages.yml) ; un secret monté ne changerait
# rien puisque la valeur finit dans le JavaScript livré. Le quota gratuit de
# CARTO (5 M tuiles/mois) est la seule protection. Sans clé, le site fonctionne
# mais les fonds clair et sombre reviennent filigranés.
ARG CARTO_BASEMAPS_API_KEY=""
ENV CARTO_BASEMAPS_API_KEY=${CARTO_BASEMAPS_API_KEY}

# vite.config.ts fixe `base` à /Shadowed_map/ pour GitHub Pages. Servi par ce
# conteneur, le site est à la racine : sans cette bascule, index.html demande
# /Shadowed_map/assets/… et la page reste blanche. À changer uniquement si un
# reverse proxy en amont expose le site sous un sous-chemin (valeur avec les
# deux slashes, ex. /shadows/).
ARG BASE_PATH="/"

# Mêmes contrôles que la CI, dans le même ordre, avant de produire le bundle :
# un typage cassé ou un test rouge doit arrêter la construction de l'image, pas
# se découvrir en production.
RUN npm run typecheck \
 && npm run lint \
 && npm test \
 && npx vite build --base="${BASE_PATH}"

# ---------------------------------------------------------------------------
# Étage 2 — service
# ---------------------------------------------------------------------------
FROM nginx:1.29-alpine AS runtime

# Remplace le server block par défaut. Le script d'entrée
# 10-listen-on-ipv6-by-default.sh n'existe que pour ajouter `listen [::]:80` au
# fichier livré par le paquet : notre configuration le porte déjà, et le script
# se contenterait de journaliser qu'il ne peut pas écrire sur un système de
# fichiers en lecture seule. Le retirer évite cette ligne trompeuse au
# démarrage.
RUN rm /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# Contrôle de santé sans curl (absent de l'image) : busybox wget suffit.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --spider --tries=1 http://127.0.0.1/ || exit 1
