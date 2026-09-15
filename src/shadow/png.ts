/**
 * Décodage PNG exact, sans passer par le canvas.
 *
 * Un PNG terrarium n'est pas une image : c'est un tableau de nombres où le canal rouge
 * pèse 256 mètres par unité. Or le chemin `createImageBitmap` + `drawImage` +
 * `getImageData` ne garantit pas la valeur exacte des octets — mesuré sur la tuile
 * 15/17009/11667, qui ne contient que du rouge à 132 : le navigateur en rend 78 à 133,
 * soit 78 pics de 256 m plantés dans le terrain, chacun projetant sa propre ombre sur
 * des centaines de mètres. Ni `colorSpaceConversion: 'none'` ni `willReadFrequently`
 * n'y changent quoi que ce soit, et le fichier ne porte aucun profil colorimétrique.
 *
 * On décode donc nous-mêmes : les tuiles sont toutes en 8 bits, RVB, non entrelacées,
 * ce qui tient en un inflate (fourni par la plateforme) et le défiltrage PNG.
 */

interface PngRgb8 {
  width: number;
  height: number;
  /** Trois octets par pixel, ligne par ligne. */
  rgb: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Reconstruit un octet filtré. Les noms suivent la spécification PNG. */
function unfilter(type: number, raw: Uint8Array, previous: Uint8Array, bpp: number): void {
  const n = raw.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) raw[i] = (raw[i]! + raw[i - bpp]!) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) raw[i] = (raw[i]! + previous[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const gauche = i >= bpp ? raw[i - bpp]! : 0;
        raw[i] = (raw[i]! + ((gauche + previous[i]!) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? raw[i - bpp]! : 0;
        const b = previous[i]!;
        const c = i >= bpp ? previous[i - bpp]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        raw[i] = (raw[i]! + pred) & 0xff;
      }
      return;
    default:
      throw new Error(`Filtre PNG inconnu : ${type}`);
  }
}

/**
 * Renvoie `null` si le fichier n'est pas un PNG 8 bits RVB non entrelacé — l'appelant
 * retombe alors sur le décodage par canvas.
 */
export async function decodePngRgb8(buffer: ArrayBuffer): Promise<PngRgb8 | null> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;

  const vue = new DataView(buffer);
  let offset = 8;
  let width = 0;
  let height = 0;
  const morceaux: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const taille = vue.getUint32(offset);
    const nom = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const debut = offset + 8;

    if (nom === 'IHDR') {
      width = vue.getUint32(debut);
      height = vue.getUint32(debut + 4);
      const profondeur = bytes[debut + 8];
      const typeCouleur = bytes[debut + 9];
      const entrelacement = bytes[debut + 12];
      if (profondeur !== 8 || typeCouleur !== 2 || entrelacement !== 0) return null;
    } else if (nom === 'IDAT') {
      morceaux.push(bytes.subarray(debut, debut + taille));
    } else if (nom === 'IEND') {
      break;
    }
    offset = debut + taille + 4; // + CRC
  }

  if (!width || !height || morceaux.length === 0) return null;
  if (typeof DecompressionStream === 'undefined') return null;

  const compresse = new Blob(morceaux as unknown as BlobPart[]);
  const flux = compresse.stream().pipeThrough(new DecompressionStream('deflate'));
  const brut = new Uint8Array(await new Response(flux).arrayBuffer());

  const bpp = 3;
  const parLigne = width * bpp;
  if (brut.length < height * (parLigne + 1)) return null;

  const rgb = new Uint8Array(width * height * bpp);
  let precedente = new Uint8Array(parLigne);
  for (let y = 0; y < height; y++) {
    const source = y * (parLigne + 1);
    const ligne = brut.subarray(source + 1, source + 1 + parLigne);
    unfilter(brut[source]!, ligne, precedente, bpp);
    rgb.set(ligne, y * parLigne);
    precedente = ligne;
  }
  return { width, height, rgb };
}
