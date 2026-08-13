// Detecção de media type de imagem por MAGIC BYTES — puro, sem import remoto
// (roda sob `deno test --no-remote`, o `test:edges` do CI).
//
// Por que existe: as telas mandam o base64 CRU do arquivo escolhido pelo usuário
// e o código antigo rotulava tudo como `data:image/jpeg;base64,...` fixo. O
// gateway antigo sniffava o conteúdo e tolerava o rótulo errado; a API da
// Anthropic valida o `media_type` DECLARADO e responde 400 quando não bate.
// Print de tela (PNG) e foto de iPhone (HEIC) são o caso comum.
//
// ⚠️ `analyze-unified-order/imagem-helpers.ts` tem uma cópia local desta lógica
// (mais o empacotamento de LOTE, que só ele usa). Aquela edge já está mergeada
// aguardando deploy manual — trocar o import dela agora obrigaria a redeployá-la
// só por refactor. Consolidar quando ela for deployada.

/** Media types que a API da Anthropic aceita como imagem. */
const MEDIA_TYPES_IMAGEM = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** Union literal — o SDK da Anthropic tipa `media_type` assim; `string` não casa. */
export type MediaTypeImagem = (typeof MEDIA_TYPES_IMAGEM)[number];

interface BlocoImagem {
  type: "image";
  source: { type: "base64"; media_type: MediaTypeImagem; data: string };
}

export type ResultadoImagem =
  | { ok: true; bloco: BlocoImagem; mediaType: MediaTypeImagem }
  | { ok: false; erro: string };

/** Aceita base64 puro ou data-URI inteiro (nem todo caller tira o prefixo). */
function limparBase64(bruto: string): string {
  return (bruto ?? "").replace(/^data:[^,]*,/, "").replace(/\s/g, "");
}

/** Decodifica só o cabeçalho — nunca a imagem inteira. */
function primeirosBytes(base64: string, quantos: number): Uint8Array | null {
  // 4 chars base64 = 3 bytes; `atob` exige comprimento múltiplo de 4.
  const desejado = Math.ceil(quantos / 3) * 4;
  const disponivel = Math.min(base64.length, desejado);
  const alinhado = disponivel - (disponivel % 4);
  if (alinhado < 4) return null;
  try {
    const bin = atob(base64.slice(0, alinhado));
    const out = new Uint8Array(Math.min(bin.length, quantos));
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function assinaturaBate(
  bytes: Uint8Array,
  assinatura: readonly number[],
  deslocamento = 0,
): boolean {
  if (bytes.length < deslocamento + assinatura.length) return false;
  return assinatura.every((b, i) => bytes[deslocamento + i] === b);
}

/**
 * Detecta o media type pelos MAGIC BYTES do conteúdo — nunca pelo rótulo do
 * caller. Devolve `null` para formato que a Anthropic não aceita (HEIC, BMP,
 * TIFF, SVG) ou base64 ilegível: fail-closed, para não declarar tipo errado.
 */
export function detectarMediaTypeImagem(base64: string): MediaTypeImagem | null {
  const limpo = limparBase64(base64);
  if (!limpo) return null;
  const b = primeirosBytes(limpo, 16);
  if (!b) return null;

  if (assinaturaBate(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (assinaturaBate(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (assinaturaBate(b, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // GIF87a/GIF89a
  // WebP = "RIFF" + 4 bytes de tamanho + "WEBP". Os dois pedaços são
  // necessários, senão qualquer container RIFF (AVI, WAV) passaria por imagem.
  if (
    assinaturaBate(b, [0x52, 0x49, 0x46, 0x46]) &&
    assinaturaBate(b, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

/** Alfabeto base64 padrão + padding só no fim. */
const BASE64_BEM_FORMADO = /^[A-Za-z0-9+/]+={0,2}$/;

/** Monta o content block de UMA imagem com o media type real detectado. */
export function montarBlocoImagem(base64: string): ResultadoImagem {
  const limpo = limparBase64(base64);
  if (!limpo) return { ok: false, erro: "imagem vazia" };

  // A detecção só lê o cabeçalho; sem esta checagem, arquivo truncado ou
  // corrompido DEPOIS dos magic bytes passaria e só viraria 400 na API, com a
  // tentativa já gasta. Valida o formato inteiro sem decodificar tudo.
  if (limpo.length % 4 !== 0 || !BASE64_BEM_FORMADO.test(limpo)) {
    return {
      ok: false,
      erro: "arquivo corrompido ou incompleto (base64 malformado). Tire a foto de novo.",
    };
  }

  const mediaType = detectarMediaTypeImagem(limpo);
  if (!mediaType) {
    return {
      ok: false,
      erro:
        "formato não suportado pela IA (aceitos: JPEG, PNG, GIF, WebP). Foto de iPhone em HEIC precisa virar JPEG — tire um print ou reenvie pela galeria.",
    };
  }

  return {
    ok: true,
    mediaType,
    bloco: {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: limpo },
    },
  };
}
