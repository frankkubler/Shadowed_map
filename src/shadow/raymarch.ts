/**
 * Passes de lancer de rayon : ombre instantanée et accumulation d'ensoleillement.
 *
 * Les deux partagent le même corps de shader (`RAYMARCH_BODY`) et le même champ de
 * hauteur ; seule diffère la manière dont le résultat est écrit.
 */
import { createProgram, createRenderTarget, deleteRenderTarget, UniformCache, type RenderTarget } from './glUtils';
import { EXPOSURE_FRAG, FULLSCREEN_VERT, SHADOW_FRAG } from './shaders';
import { regionHeight, regionWidth, type MercatorRegion } from './region';

/** Taille du lot de positions solaires traité en une passe d'accumulation. Doit valoir MAX_BATCH côté GLSL. */
export const EXPOSURE_BATCH_SIZE = 16;

/**
 * Facteur de croissance du pas de marche.
 *
 * On cherche `g` tel que la somme géométrique `1 + g + g² + ... + g^(n-1)` couvre la
 * distance voulue en `n` pas. Il n'y a pas de forme close ; une dichotomie sur une
 * fonction monotone converge en une trentaine d'itérations, pour un coût négligeable
 * puisque le calcul se fait une fois par construction du champ.
 */
export function solveStepGrowth(maxDistanceTexels: number, steps: number): number {
  if (steps <= 1 || maxDistanceTexels <= steps) return 1;

  const total = (g: number) => (g === 1 ? steps : (Math.pow(g, steps) - 1) / (g - 1));

  let low = 1;
  let high = 2;
  while (total(high) < maxDistanceTexels && high < 4) high *= 1.5;

  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (total(mid) < maxDistanceTexels) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Emprise du masque dans le champ de hauteur, en coordonnées normalisées du champ. */
function maskRectInField(field: MercatorRegion, mask: MercatorRegion): [number, number, number, number] {
  const w = regionWidth(field);
  const h = regionHeight(field);
  return [
    (mask.x0 - field.x0) / w,
    (mask.y0 - field.y0) / h,
    (mask.x1 - field.x0) / w,
    (mask.y1 - field.y0) / h,
  ];
}

export interface MarchParams {
  fieldTexture: WebGLTexture;
  fieldSize: number;
  fieldRegion: MercatorRegion;
  maskRegion: MercatorRegion;
  /** Taille au sol d'un texel du champ, en mètres. */
  metersPerTexel: number;
  /** Point culminant du champ, pour couper la marche dès que le rayon le dépasse. */
  maxFieldHeight: number;
  /** Nombre de pas et croissance, issus de `solveStepGrowth`. */
  steps: number;
  stepGrowth: number;
}

export interface SunSample {
  /** Direction vers le soleil en espace texel : (est, -nord). */
  dir: [number, number];
  tanAltitude: number;
}

export class ShadowPass {
  private shadowProgram: WebGLProgram;
  private shadowUniforms: UniformCache;
  private exposureProgram: WebGLProgram;
  private exposureUniforms: UniformCache;

  private mask: RenderTarget;
  private exposure: [RenderTarget, RenderTarget];
  private exposureIndex = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly quad: WebGLBuffer,
    maskSize: number,
    exposureSize: number,
  ) {
    this.shadowProgram = createProgram(gl, FULLSCREEN_VERT, SHADOW_FRAG);
    this.shadowUniforms = new UniformCache(gl, this.shadowProgram);
    this.exposureProgram = createProgram(gl, FULLSCREEN_VERT, EXPOSURE_FRAG);
    this.exposureUniforms = new UniformCache(gl, this.exposureProgram);

    this.mask = createRenderTarget(
      gl, maskSize, maskSize, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR,
    );
    this.exposure = [
      createRenderTarget(gl, exposureSize, exposureSize, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST),
      createRenderTarget(gl, exposureSize, exposureSize, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST),
    ];
  }

  get maskTexture(): WebGLTexture {
    return this.mask.texture;
  }

  get exposureTexture(): WebGLTexture {
    return (this.exposure[this.exposureIndex] as RenderTarget).texture;
  }

  get maskSize(): number {
    return this.mask.width;
  }

  /** Prépare les états GL communs et lie le quad plein écran. */
  private beginPass(program: WebGLProgram, target: RenderTarget): number {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    return posLoc;
  }

  private setMarchUniforms(uniforms: UniformCache, params: MarchParams): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, params.fieldTexture);
    gl.uniform1i(uniforms.at('u_field'), 0);
    gl.uniform2f(uniforms.at('u_fieldSize'), params.fieldSize, params.fieldSize);
    gl.uniform1f(uniforms.at('u_metersPerTexel'), params.metersPerTexel);
    gl.uniform1f(uniforms.at('u_maxFieldHeight'), params.maxFieldHeight);
    gl.uniform1i(uniforms.at('u_steps'), params.steps);
    gl.uniform1f(uniforms.at('u_stepGrowth'), params.stepGrowth);
    gl.uniform4fv(
      uniforms.at('u_maskRect'),
      maskRectInField(params.fieldRegion, params.maskRegion),
    );
  }

  /** Ombre à un instant donné. `night` force l'ombre totale quand le soleil est couché. */
  renderShadow(params: MarchParams, sun: SunSample, night: boolean): void {
    const { gl } = this;
    const posLoc = this.beginPass(this.shadowProgram, this.mask);
    this.setMarchUniforms(this.shadowUniforms, params);
    gl.uniform2f(this.shadowUniforms.at('u_sunDir'), sun.dir[0], sun.dir[1]);
    gl.uniform1f(this.shadowUniforms.at('u_tanAltitude'), sun.tanAltitude);
    gl.uniform1f(this.shadowUniforms.at('u_night'), night ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(posLoc);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Remet l'accumulation d'ensoleillement à zéro. */
  resetExposure(): void {
    const { gl } = this;
    for (const target of this.exposure) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.exposureIndex = 0;
  }

  /**
   * Ajoute un lot de positions solaires à l'accumulation.
   * `minutesPerSample` est l'intervalle entre deux échantillons, en minutes.
   */
  accumulateExposure(params: MarchParams, samples: SunSample[], minutesPerSample: number): void {
    const { gl } = this;
    if (samples.length === 0) return;

    const source = this.exposure[this.exposureIndex] as RenderTarget;
    const destination = this.exposure[1 - this.exposureIndex] as RenderTarget;

    const posLoc = this.beginPass(this.exposureProgram, destination);
    this.setMarchUniforms(this.exposureUniforms, params);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(this.exposureUniforms.at('u_previous'), 1);

    const count = Math.min(samples.length, EXPOSURE_BATCH_SIZE);
    const dirs = new Float32Array(EXPOSURE_BATCH_SIZE * 2);
    const tans = new Float32Array(EXPOSURE_BATCH_SIZE);
    for (let i = 0; i < count; i++) {
      const sample = samples[i] as SunSample;
      dirs[i * 2] = sample.dir[0];
      dirs[i * 2 + 1] = sample.dir[1];
      tans[i] = sample.tanAltitude;
    }
    gl.uniform2fv(this.exposureUniforms.at('u_sunDirs'), dirs);
    gl.uniform1fv(this.exposureUniforms.at('u_tanAltitudes'), tans);
    gl.uniform1i(this.exposureUniforms.at('u_batchCount'), count);
    gl.uniform1f(this.exposureUniforms.at('u_minutesPerSample'), minutesPerSample);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.disableVertexAttribArray(posLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.exposureIndex = 1 - this.exposureIndex;
  }

  /**
   * Lit une valeur du masque d'ombre. `u` et `v` sont dans [0, 1] sur la région du masque,
   * v = 0 au nord.
   */
  readMask(u: number, v: number): { shadow: number; hasData: boolean } | null {
    const { gl } = this;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    const x = Math.min(this.mask.width - 1, Math.max(0, Math.floor(u * this.mask.width)));
    const y = Math.min(this.mask.height - 1, Math.max(0, Math.floor(v * this.mask.height)));

    const pixel = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mask.framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { shadow: (pixel[0] ?? 0) / 255, hasData: (pixel[1] ?? 0) > 127 };
  }

  /** Lit l'ensoleillement cumulé en un point, en minutes. */
  readExposure(u: number, v: number): number | null {
    const { gl } = this;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    const target = this.exposure[this.exposureIndex] as RenderTarget;
    const x = Math.min(target.width - 1, Math.max(0, Math.floor(u * target.width)));
    const y = Math.min(target.height - 1, Math.max(0, Math.floor(v * target.height)));

    const pixel = new Float32Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixel[0] ?? null;
  }

  dispose(): void {
    deleteRenderTarget(this.gl, this.mask);
    for (const target of this.exposure) deleteRenderTarget(this.gl, target);
    this.gl.deleteProgram(this.shadowProgram);
    this.gl.deleteProgram(this.exposureProgram);
  }
}
