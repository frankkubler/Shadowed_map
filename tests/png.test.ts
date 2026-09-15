import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePngRgb8 } from '../src/shadow/png';

/**
 * Le décodeur est comparé à des tuiles terrarium réelles, dont les valeurs de référence
 * ont été établies hors navigateur. C'est l'exactitude octet par octet qui compte ici :
 * une unité de rouge vaut 256 mètres d'altitude.
 */
describe('décodage PNG des tuiles d’élévation', () => {
  const tuile = readFileSync(new URL('./fixtures/terrarium-15-17009-11667.png', import.meta.url));
  const buffer = tuile.buffer.slice(tuile.byteOffset, tuile.byteOffset + tuile.byteLength);

  it('restitue la géométrie de la tuile', async () => {
    const png = await decodePngRgb8(buffer as ArrayBuffer);
    expect(png).not.toBeNull();
    expect(png?.width).toBe(256);
    expect(png?.height).toBe(256);
    expect(png?.rgb.length).toBe(256 * 256 * 3);
  });

  it('restitue exactement le canal rouge, qui pèse 256 m par unité', async () => {
    const png = await decodePngRgb8(buffer as ArrayBuffer);
    const rouges = new Set<number>();
    for (let i = 0; i < png!.rgb.length; i += 3) rouges.add(png!.rgb[i]!);
    // Cette tuile est uniforme sur le rouge : tout autre valeur serait un pic de 256 m.
    expect([...rouges]).toEqual([132]);
  });

  it('retrouve les altitudes attendues', async () => {
    const png = await decodePngRgb8(buffer as ArrayBuffer);
    let min = Infinity;
    let max = -Infinity;
    let somme = 0;
    const n = 256 * 256;
    for (let i = 0; i < n; i++) {
      const h = png!.rgb[i * 3]! * 256 + png!.rgb[i * 3 + 1]! + png!.rgb[i * 3 + 2]! / 256 - 32768;
      somme += h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    expect(Math.round(min)).toBe(1033);
    expect(Math.round(max)).toBe(1087);
    expect(somme / n).toBeCloseTo(1042.942, 2);
  });

  it('renvoie null sur une entrée qui n’est pas un PNG', async () => {
    expect(await decodePngRgb8(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer)).toBeNull();
  });
});
