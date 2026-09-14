/**
 * Pont vers le système de projection de MapLibre pour les couches personnalisées.
 *
 * MapLibre fournit à chaque frame un prélude de shader (`projectTile`) et un jeu
 * d'uniformes décrivant la projection courante. S'appuyer dessus, plutôt que sur une
 * matrice brute, est ce qui permet à la couche de rester correcte si la carte passe
 * en projection globe — et évite de dépendre de conventions internes de MapLibre.
 */
import type { CustomRenderMethodInput } from 'maplibre-gl';
import { createProgram, UniformCache } from './glUtils';

export interface ProjectionProgram {
  program: WebGLProgram;
  uniforms: UniformCache;
}

/**
 * Compile et met en cache un programme par variante de projection.
 *
 * `variantName` change dès que le prélude change, ce qui en fait exactement la bonne
 * clé de cache : on ne recompile que lors d'un vrai changement de projection.
 */
export class ProjectionProgramCache {
  private programs = new Map<string, ProjectionProgram | null>();
  private lastError: string | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly buildVertexSource: (prelude: string, define: string) => string,
    private readonly fragmentSource: string,
  ) {}

  /** Message de la dernière compilation échouée, s'il y en a eu une. */
  get error(): string | null {
    return this.lastError;
  }

  /**
   * Renvoie `null` si la compilation a échoué.
   *
   * L'échec est mémorisé : `get` est appelé à chaque frame, et laisser l'exception
   * remonter dans la boucle de rendu de MapLibre bloquerait la page au lieu de
   * dégrader proprement l'affichage.
   */
  get(shaderData: CustomRenderMethodInput['shaderData']): ProjectionProgram | null {
    const cached = this.programs.get(shaderData.variantName);
    if (cached !== undefined) return cached;

    try {
      const program = createProgram(
        this.gl,
        this.buildVertexSource(shaderData.vertexShaderPrelude, shaderData.define),
        this.fragmentSource,
      );
      const entry: ProjectionProgram = { program, uniforms: new UniformCache(this.gl, program) };
      this.programs.set(shaderData.variantName, entry);
      return entry;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.programs.set(shaderData.variantName, null);
      return null;
    }
  }

  dispose(): void {
    for (const entry of this.programs.values()) {
      if (entry) this.gl.deleteProgram(entry.program);
    }
    this.programs.clear();
  }
}

/**
 * Renseigne les uniformes que `projectTile` attend.
 *
 * Les noms sont ceux que MapLibre déclare dans son prélude ; ils sont documentés dans
 * le type `ProjectionData`.
 */
export function setProjectionUniforms(
  gl: WebGL2RenderingContext,
  uniforms: UniformCache,
  projection: CustomRenderMethodInput['defaultProjectionData'],
): void {
  gl.uniformMatrix4fv(
    uniforms.at('u_projection_matrix'),
    false,
    new Float32Array(projection.mainMatrix),
  );
  gl.uniform4fv(uniforms.at('u_projection_tile_mercator_coords'), projection.tileMercatorCoords);
  gl.uniform4fv(uniforms.at('u_projection_clipping_plane'), projection.clippingPlane);
  gl.uniform1f(uniforms.at('u_projection_transition'), projection.projectionTransition);
  gl.uniformMatrix4fv(
    uniforms.at('u_projection_fallback_matrix'),
    false,
    new Float32Array(projection.fallbackMatrix),
  );
}
