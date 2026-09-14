/**
 * Shaders GLSL ES 3.00 du moteur d'ombre.
 *
 * Conventions d'orientation, valables dans toutes les passes :
 *   - le champ de hauteur est carré en Mercator, ce qui rend l'espace texel isotrope
 *     et permet de raisonner en distances sans correction d'aspect ;
 *   - la ligne 0 de la texture correspond au **nord** de la région ;
 *   - donc, en coordonnées texel, +y va vers le **sud** et le vecteur vers le soleil
 *     s'écrit `vec2(est, -nord)`.
 */

/** Altitude marquant l'absence de donnée. Plus basse que la fosse des Mariannes. */
export const NO_DATA_SENTINEL = -10000.0;

/** Quad unité projeté dans un sous-rectangle de la cible de rendu. */
export const RECT_VERT = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_pos;              // quad unité, [0,1]²
uniform vec4 u_rect;        // (x0, y0, x1, y1) en coordonnées région normalisées

out vec2 v_uv;

void main() {
  vec2 p = mix(u_rect.xy, u_rect.zw, a_pos);
  // y = 0 (nord de la région) doit tomber sur la ligne 0 de la texture, donc en ndc -1.
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  v_uv = a_pos;
}
`;

/**
 * Report d'une tuile DEM dans le champ de hauteur.
 *
 * L'interpolation bilinéaire est faite à la main : la tuile est une texture R32F
 * échantillonnée en NEAREST, ce qui évite de dépendre de OES_texture_float_linear
 * (absent sur une partie des GPU mobiles).
 */
export const DEM_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_tile;
uniform float u_tileSize;

out vec4 fragColor;

float bilinear(vec2 uv) {
  vec2 t = uv * u_tileSize - 0.5;
  vec2 base = floor(t);
  vec2 f = t - base;
  vec2 maxIndex = vec2(u_tileSize - 1.0);

  ivec2 i00 = ivec2(clamp(base, vec2(0.0), maxIndex));
  ivec2 i11 = ivec2(clamp(base + 1.0, vec2(0.0), maxIndex));

  float h00 = texelFetch(u_tile, ivec2(i00.x, i00.y), 0).r;
  float h10 = texelFetch(u_tile, ivec2(i11.x, i00.y), 0).r;
  float h01 = texelFetch(u_tile, ivec2(i00.x, i11.y), 0).r;
  float h11 = texelFetch(u_tile, ivec2(i11.x, i11.y), 0).r;

  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

void main() {
  fragColor = vec4(bilinear(v_uv), 0.0, 0.0, 1.0);
}
`;

/**
 * Rasterisation des bâtiments dans le champ de hauteur.
 *
 * Les polygones sont triangulés côté CPU et fournis directement en coordonnées
 * région normalisées. Ils sont dessinés du plus bas au plus haut, sans mélange :
 * en cas de recouvrement, c'est donc le plus haut qui subsiste — l'équivalent d'un
 * blending MAX, mais sans dépendre de EXT_float_blend.
 */
export const BUILDING_VERT = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_pos;        // coordonnées région normalisées, [0,1]²
in float a_height;    // altitude absolue du sommet du bâtiment, en mètres

out float v_height;

void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  v_height = a_height;
}
`;

export const BUILDING_FRAG = /* glsl */ `#version 300 es
precision highp float;

in float v_height;
out vec4 fragColor;

void main() {
  fragColor = vec4(v_height, 0.0, 0.0, 1.0);
}
`;

/** Quad plein écran, sans transformation. */
export const FULLSCREEN_VERT = /* glsl */ `#version 300 es
precision highp float;

in vec2 a_pos;
out vec2 v_uv;

void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  v_uv = a_pos;
}
`;

/**
 * Corps commun du lancer de rayon, partagé par la passe d'ombre instantanée et par
 * la passe d'accumulation d'ensoleillement.
 *
 * Le pas croît géométriquement : fin près du point de départ (où se jouent les ombres
 * de bâtiments, de l'ordre de quelques texels) et grossier au loin (où seules comptent
 * les crêtes, larges de centaines de texels). Un pas constant obligerait à choisir
 * entre rater les bâtiments et faire des milliers d'itérations.
 */
const RAYMARCH_BODY = /* glsl */ `
const int MAX_STEPS = 512;
const float NO_DATA = ${NO_DATA_SENTINEL.toFixed(1)};

uniform sampler2D u_field;
uniform vec2 u_fieldSize;
uniform float u_metersPerTexel;
uniform float u_maxFieldHeight;
uniform int u_steps;
uniform float u_stepGrowth;

float sampleField(vec2 texel) {
  vec2 t = texel - 0.5;
  vec2 base = floor(t);
  vec2 f = t - base;
  vec2 maxIndex = u_fieldSize - 1.0;

  ivec2 i0 = ivec2(clamp(base, vec2(0.0), maxIndex));
  ivec2 i1 = ivec2(clamp(base + 1.0, vec2(0.0), maxIndex));

  float h00 = texelFetch(u_field, ivec2(i0.x, i0.y), 0).r;
  float h10 = texelFetch(u_field, ivec2(i1.x, i0.y), 0).r;
  float h01 = texelFetch(u_field, ivec2(i0.x, i1.y), 0).r;
  float h11 = texelFetch(u_field, ivec2(i1.x, i1.y), 0).r;

  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

/**
 * 1.0 si le texel est à l'ombre, 0.0 s'il est au soleil.
 * sunDir est unitaire en espace texel, tanAltitude la tangente de la hauteur du soleil.
 */
float marchShadow(vec2 origin, float originHeight, vec2 sunDir, float tanAltitude) {
  float dist = 0.0;
  float stride = 1.0;   // en texels ; « step » est un nom réservé par GLSL

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= u_steps) break;

    dist += stride;
    stride *= u_stepGrowth;

    vec2 p = origin + sunDir * dist;
    if (p.x < 0.0 || p.y < 0.0 || p.x > u_fieldSize.x || p.y > u_fieldSize.y) break;

    float rayHeight = originHeight + dist * u_metersPerTexel * tanAltitude;
    // Au-dessus du point culminant du champ : plus rien ne peut intercepter le rayon.
    if (rayHeight > u_maxFieldHeight) break;

    if (sampleField(p) > rayHeight) return 1.0;
  }
  return 0.0;
}
`;

/** Passe d'ombre instantanée : r = ombre (0 ou 1), g = 1 si la donnée existe. */
export const SHADOW_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform vec4 u_maskRect;    // emprise du masque dans le champ, en région normalisée
uniform vec2 u_sunDir;      // unitaire, espace texel
uniform float u_tanAltitude;
uniform float u_night;      // 1.0 quand le soleil est sous l'horizon

${RAYMARCH_BODY}

void main() {
  vec2 fieldUv = mix(u_maskRect.xy, u_maskRect.zw, v_uv);
  vec2 texel = fieldUv * u_fieldSize;

  float h0 = sampleField(texel);
  if (h0 <= NO_DATA + 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);  // pas de donnée : on n'ombre rien
    return;
  }
  if (u_night > 0.5) {
    fragColor = vec4(1.0, 1.0, 0.0, 1.0);
    return;
  }

  float shadow = marchShadow(texel, h0, u_sunDir, u_tanAltitude);
  fragColor = vec4(shadow, 1.0, 0.0, 1.0);
}
`;

/**
 * Passe d'accumulation d'ensoleillement.
 *
 * Chaque exécution traite un lot de positions solaires et ajoute la durée ensoleillée
 * au contenu de la passe précédente (ping-pong entre deux cibles R32F). Un blending
 * additif serait plus court à écrire mais imposerait EXT_float_blend, et la même chose
 * en RGBA8 perdrait trop de précision sur une cinquantaine d'additions.
 */
export const EXPOSURE_FRAG = /* glsl */ `#version 300 es
precision highp float;

const int MAX_BATCH = 16;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_previous;
uniform vec4 u_maskRect;
uniform int u_batchCount;
uniform vec2 u_sunDirs[MAX_BATCH];
uniform float u_tanAltitudes[MAX_BATCH];
uniform float u_minutesPerSample;

${RAYMARCH_BODY}

void main() {
  float accumulated = texture(u_previous, v_uv).r;

  vec2 fieldUv = mix(u_maskRect.xy, u_maskRect.zw, v_uv);
  vec2 texel = fieldUv * u_fieldSize;
  float h0 = sampleField(texel);

  if (h0 > NO_DATA + 1.0) {
    for (int i = 0; i < MAX_BATCH; i++) {
      if (i >= u_batchCount) break;
      if (marchShadow(texel, h0, u_sunDirs[i], u_tanAltitudes[i]) < 0.5) {
        accumulated += u_minutesPerSample;
      }
    }
  }

  fragColor = vec4(accumulated, 0.0, 0.0, 1.0);
}
`;

/**
 * Dessin du résultat sur la carte.
 *
 * La projection passe par `projectTile()`, la fonction que MapLibre injecte via
 * `shaderData.vertexShaderPrelude` et qui attend des coordonnées Mercator dans [0,1].
 * Utiliser directement `modelViewProjectionMatrix` serait une impasse : cette matrice
 * attend des coordonnées « monde » en pixels (Mercator × 512 × 2^zoom), une convention
 * interne qui ne vaut que pour la projection Mercator — la couche cesserait de
 * fonctionner en projection globe.
 *
 * Le prélude dépend de la projection courante : le programme doit donc être compilé
 * par variante, d'où l'assemblage à l'exécution plutôt qu'une constante.
 */
export function buildOverlayVertexSource(prelude: string, define: string): string {
  return `#version 300 es
precision highp float;

${prelude}
${define}

in vec2 a_pos;
uniform vec4 u_region;   // (x0, y0, x1, y1) en Mercator normalisé

out vec2 v_uv;

void main() {
  vec2 merc = mix(u_region.xy, u_region.zw, a_pos);
  gl_Position = projectTile(merc);
  v_uv = a_pos;
}
`;
}

/**
 * Colorisation.
 *
 * `u_mode` 0 = ombre instantanée, 1 = heures d'ensoleillement.
 * Les couleurs sont écrites en alpha prémultiplié, comme l'attend le mélange que
 * MapLibre configure pour les couches personnalisées.
 */
export const OVERLAY_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_mask;
uniform int u_mode;
uniform vec3 u_shadowColor;
uniform float u_opacity;
uniform float u_maxHours;

// Rampe séquentielle sombre -> clair, lisible sur fond clair comme sur fond sombre.
vec3 exposureRamp(float t) {
  const vec3 c0 = vec3(0.106, 0.129, 0.267);  // nuit
  const vec3 c1 = vec3(0.325, 0.235, 0.482);
  const vec3 c2 = vec3(0.694, 0.322, 0.408);
  const vec3 c3 = vec3(0.949, 0.557, 0.216);
  const vec3 c4 = vec3(0.988, 0.894, 0.478);  // plein soleil

  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
  vec4 mask = texture(u_mask, v_uv);

  if (u_mode == 1) {
    float hours = mask.r / 60.0;
    vec3 color = exposureRamp(hours / max(u_maxHours, 0.001));
    // La rampe porte ici une donnée, pas une simple teinte d'ombre : elle doit rester
    // lisible. On remonte donc l'opacité, tout en laissant le réglage jouer.
    float alpha = mix(0.55, 1.0, u_opacity);
    fragColor = vec4(color * alpha, alpha);
    return;
  }

  float shadow = mask.r * mask.g;   // g = 0 là où le relief est inconnu
  float alpha = shadow * u_opacity;
  fragColor = vec4(u_shadowColor * alpha, alpha);
}
`;
