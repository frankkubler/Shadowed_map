/**
 * Construction du champ de hauteur : une texture R32F contenant, pour chaque texel,
 * l'altitude du sommet de ce qui s'y trouve — terrain nu, ou toit du bâtiment.
 *
 * Fusionner relief et bâtiments dans une seule surface permet ensuite de tout ombrer
 * avec un unique lancer de rayon, au lieu de traiter les deux cas séparément puis de
 * combiner les résultats (ce qui donnerait de mauvais résultats là où un immeuble est
 * à l'ombre d'une montagne).
 */
import type { DemTileCache } from './demTiles';
import { NO_DATA_ELEVATION } from './demTiles';
import {
  createFloatTexture,
  createProgram,
  createRenderTarget,
  deleteRenderTarget,
  UniformCache,
  type RenderTarget,
} from './glUtils';
import { regionHeight, regionWidth, type MercatorRegion } from './region';
import { BUILDING_FRAG, BUILDING_VERT, DEM_FRAG, RECT_VERT } from './shaders';
import type { BuildingMesh } from './buildings';
import { lngToMercatorX, latToMercatorY } from '../sun/mercator';

/** Nombre de textures de tuiles DEM conservées sur le GPU. */
const MAX_GPU_TILES = 192;

export interface HeightFieldBuildInput {
  region: MercatorRegion;
  demZoom: number;
  demCache: DemTileCache;
  buildings: BuildingMesh;
}

export interface HeightFieldStats {
  /** Altitude la plus haute présente dans le champ, en mètres. Sert à couper le lancer de rayon. */
  maxHeight: number;
  /** Altitude la plus basse, utile pour dimensionner la marge de la région. */
  minHeight: number;
  tilesDrawn: number;
  buildingVertices: number;
}

export class HeightField {
  readonly size: number;
  private target: RenderTarget;
  private demProgram: WebGLProgram;
  private demUniforms: UniformCache;
  private buildingProgram: WebGLProgram;
  private buildingVbo: WebGLBuffer;
  private gpuTiles = new Map<string, WebGLTexture>();
  private stats: HeightFieldStats = {
    maxHeight: 0,
    minHeight: 0,
    tilesDrawn: 0,
    buildingVertices: 0,
  };
  /** Réutilisé d'une construction à l'autre pour éviter de réallouer à chaque frame. */
  private vertexScratch = new Float32Array(0);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly quad: WebGLBuffer,
    size: number,
  ) {
    this.size = size;
    this.target = createRenderTarget(gl, size, size, gl.R32F, gl.RED, gl.FLOAT, gl.NEAREST);
    this.demProgram = createProgram(gl, RECT_VERT, DEM_FRAG);
    this.demUniforms = new UniformCache(gl, this.demProgram);
    this.buildingProgram = createProgram(gl, BUILDING_VERT, BUILDING_FRAG);

    const vbo = gl.createBuffer();
    if (!vbo) throw new Error('Création du buffer de bâtiments impossible.');
    this.buildingVbo = vbo;
  }

  get texture(): WebGLTexture {
    return this.target.texture;
  }

  getStats(): Readonly<HeightFieldStats> {
    return this.stats;
  }

  build(input: HeightFieldBuildInput): HeightFieldStats {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.framebuffer);
    gl.viewport(0, 0, this.size, this.size);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(NO_DATA_ELEVATION, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const terrain = this.drawTerrain(input);
    const buildings = this.drawBuildings(input, terrain.maxHeight);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.stats = {
      maxHeight: Math.max(terrain.maxHeight, buildings.maxHeight),
      minHeight: terrain.minHeight,
      tilesDrawn: terrain.tilesDrawn,
      buildingVertices: buildings.vertexCount,
    };
    return this.stats;
  }

  /**
   * Reporte les tuiles DEM disponibles. Les tuiles manquantes sont simplement ignorées :
   * elles laissent la valeur « pas de donnée », et la zone correspondante ne sera pas
   * ombrée plutôt que de l'être à tort.
   */
  private drawTerrain({ region, demZoom, demCache }: HeightFieldBuildInput) {
    const { gl } = this;
    const scale = Math.pow(2, demZoom);
    const width = regionWidth(region);
    const height = regionHeight(region);

    const minTileX = Math.floor(region.x0 * scale);
    const maxTileX = Math.floor(region.x1 * scale);
    const minTileY = Math.max(0, Math.floor(region.y0 * scale));
    const maxTileY = Math.min(scale - 1, Math.floor(region.y1 * scale));

    gl.useProgram(this.demProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const posLoc = gl.getAttribLocation(this.demProgram, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.demUniforms.at('u_tile'), 0);

    let maxHeight = -Infinity;
    let minHeight = Infinity;
    let tilesDrawn = 0;

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        // La carte est cyclique en longitude : l'indice de tuile se replie, mais la
        // position géométrique, elle, garde la valeur non repliée.
        const wrappedX = ((tx % scale) + scale) % scale;
        const tile = demCache.get(demZoom, wrappedX, ty);
        if (!tile) continue;

        const texture = this.gpuTileTexture(demZoom, wrappedX, ty, tile.elevations, tile.size);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1f(this.demUniforms.at('u_tileSize'), tile.size);
        gl.uniform4f(
          this.demUniforms.at('u_rect'),
          (tx / scale - region.x0) / width,
          (ty / scale - region.y0) / height,
          ((tx + 1) / scale - region.x0) / width,
          ((ty + 1) / scale - region.y0) / height,
        );
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        if (tile.maxElevation > maxHeight) maxHeight = tile.maxElevation;
        if (tile.minElevation < minHeight) minHeight = tile.minElevation;
        tilesDrawn++;
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disableVertexAttribArray(posLoc);

    return {
      maxHeight: Number.isFinite(maxHeight) ? maxHeight : 0,
      minHeight: Number.isFinite(minHeight) ? minHeight : 0,
      tilesDrawn,
    };
  }

  /**
   * Rasterise les bâtiments par-dessus le terrain.
   *
   * L'altitude du toit est calculée comme « altitude du terrain au centre du bâtiment
   * + hauteur du bâtiment ». Supposer le terrain plat sous une emprise est sans
   * conséquence à cette échelle — une emprise fait quelques dizaines de mètres.
   *
   * Les bâtiments sont dessinés du plus bas au plus haut : en cas de recouvrement,
   * le plus haut écrase les autres, ce qui reproduit un blending MAX sans dépendre de
   * l'extension EXT_float_blend.
   */
  private drawBuildings(
    { region, buildings, demCache, demZoom }: HeightFieldBuildInput,
    terrainMax: number,
  ) {
    const { gl } = this;
    if (buildings.anchors.length === 0) {
      return { maxHeight: terrainMax, vertexCount: 0 };
    }

    const width = regionWidth(region);
    const height = regionHeight(region);

    // Ne garder que les bâtiments dont l'ancre tombe dans la région élargie d'une
    // marge : les autres seraient de toute façon clippés par le viewport.
    const visible = buildings.anchors.filter((a) => {
      const mx = lngToMercatorX(a.lng);
      const my = latToMercatorY(a.lat);
      return mx >= region.x0 - width * 0.1 && mx <= region.x1 + width * 0.1 &&
        my >= region.y0 - height * 0.1 && my <= region.y1 + height * 0.1;
    });
    if (visible.length === 0) {
      return { maxHeight: terrainMax, vertexCount: 0 };
    }

    const roofs = visible.map((anchor) => {
      const ground = demCache.elevationAt(anchor.lng, anchor.lat, demZoom) ?? 0;
      return { anchor, roof: ground + anchor.height };
    });
    roofs.sort((a, b) => a.roof - b.roof);

    let vertexCount = 0;
    for (const { anchor } of roofs) vertexCount += anchor.vertexCount;

    // 3 flottants par sommet : x, y (région normalisée) et altitude du toit.
    const needed = vertexCount * 3;
    if (this.vertexScratch.length < needed) {
      this.vertexScratch = new Float32Array(Math.ceil(needed * 1.5));
    }
    const data = this.vertexScratch;

    let offset = 0;
    let maxHeight = terrainMax;
    for (const { anchor, roof } of roofs) {
      if (roof > maxHeight) maxHeight = roof;
      const end = anchor.firstVertex + anchor.vertexCount;
      for (let v = anchor.firstVertex; v < end; v++) {
        data[offset++] = ((buildings.positions[v * 2] ?? 0) - region.x0) / width;
        data[offset++] = ((buildings.positions[v * 2 + 1] ?? 0) - region.y0) / height;
        data[offset++] = roof;
      }
    }

    gl.useProgram(this.buildingProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buildingVbo);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, needed), gl.DYNAMIC_DRAW);

    const posLoc = gl.getAttribLocation(this.buildingProgram, 'a_pos');
    const heightLoc = gl.getAttribLocation(this.buildingProgram, 'a_height');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(heightLoc);
    gl.vertexAttribPointer(heightLoc, 1, gl.FLOAT, false, 12, 8);

    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

    gl.disableVertexAttribArray(posLoc);
    gl.disableVertexAttribArray(heightLoc);

    return { maxHeight, vertexCount };
  }

  private gpuTileTexture(
    z: number,
    x: number,
    y: number,
    elevations: Float32Array,
    size: number,
  ): WebGLTexture {
    const key = `${z}/${x}/${y}`;
    const existing = this.gpuTiles.get(key);
    if (existing) {
      this.gpuTiles.delete(key);
      this.gpuTiles.set(key, existing);
      return existing;
    }

    const texture = createFloatTexture(this.gl, elevations, size);
    this.gpuTiles.set(key, texture);
    while (this.gpuTiles.size > MAX_GPU_TILES) {
      const oldest = this.gpuTiles.keys().next();
      if (oldest.done) break;
      const victim = this.gpuTiles.get(oldest.value);
      if (victim) this.gl.deleteTexture(victim);
      this.gpuTiles.delete(oldest.value);
    }
    return texture;
  }

  dispose(): void {
    deleteRenderTarget(this.gl, this.target);
    this.gl.deleteProgram(this.demProgram);
    this.gl.deleteProgram(this.buildingProgram);
    this.gl.deleteBuffer(this.buildingVbo);
    for (const texture of this.gpuTiles.values()) this.gl.deleteTexture(texture);
    this.gpuTiles.clear();
  }
}
