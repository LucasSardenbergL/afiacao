// Helpers PUROS de imagem — sem import remoto, para rodar sob `deno test --no-remote`
// (o `test:edges` do CI). A edge (index.ts) importa daqui; o SDK da Anthropic e o
// supabase-js ficam de fora deste módulo.
//
// Por que existe: o frontend aceita QUALQUER `image/*` e envia o base64 cru do
// arquivo (useUnifiedAIAssistant faz `readAsDataURL` + split, sem converter).
// O gateway antigo sniffava o conteúdo e tolerava rótulo errado; a API da
// Anthropic valida o `media_type` DECLARADO e responde 400 quando ele não bate
// com os bytes. Print de tela (PNG) e foto de iPhone (HEIC) são o caso comum.
//
// Disciplina money-path: imagem ilegível ou grande demais é REJEITADA e o
// motivo sobe para quem está montando o pedido — nunca some calada, porque
// pedido montado a partir de 3 de 5 fotos parece completo e não é.

/** Media types que a API da Anthropic aceita como imagem. */
export const MEDIA_TYPES_IMAGEM = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** Union literal — o SDK da Anthropic tipa `media_type` assim, `string` não casa. */
export type MediaTypeImagem = (typeof MEDIA_TYPES_IMAGEM)[number];

export interface BlocoImagem {
  type: "image";
  source: { type: "base64"; media_type: MediaTypeImagem; data: string };
}

export type ResultadoImagem =
  | { ok: true; bloco: BlocoImagem; mediaType: MediaTypeImagem }
  | { ok: false; erro: string };

/**
 * Teto de request da Anthropic (32 MB) com folga para o envelope JSON — que
 * aqui não é pequeno: o system prompt carrega o catálogo de produtos.
 * O frontend permite 5 fotos de 5 MB, e 25 MB de binário viram ~33 MB em
 * base64: sem este guard o request estoura o limite e volta 413/400 opaco.
 */
export const LIMITE_TOTAL_BASE64_BYTES = 28 * 1024 * 1024;

/** Aceita base64 puro ou data-URI inteiro (defensivo: nem todo caller tira o prefixo). */
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
  // WebP = "RIFF" + 4 bytes de tamanho + "WEBP" — os dois pedaços são necessários,
  // senão qualquer container RIFF (AVI, WAV) passaria por imagem.
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

/** Monta o content block de UMA imagem, com o media type real detectado. */
export function montarBlocoImagem(base64: string): ResultadoImagem {
  const limpo = limparBase64(base64);
  if (!limpo) return { ok: false, erro: "imagem vazia" };

  // A detecção só lê o cabeçalho; sem esta checagem, arquivo truncado ou
  // corrompido DEPOIS dos magic bytes passaria e só viraria 400 na API, com a
  // análise já perdida. Valida o formato inteiro sem decodificar 28 MB.
  if (limpo.length % 4 !== 0 || !BASE64_BEM_FORMADO.test(limpo)) {
    return {
      ok: false,
      erro: "arquivo corrompido ou incompleto (base64 malformado). Reenvie a foto.",
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

export interface ImagemRejeitada {
  indice: number;
  motivo: string;
}

export interface ImagensPreparadas {
  blocos: BlocoImagem[];
  rejeitadas: ImagemRejeitada[];
}

/**
 * Prepara o lote inteiro respeitando o teto de request. A imagem que não cabe
 * (ou não é legível) sai da chamada e vira `rejeitadas` — o caller devolve isso
 * ao vendedor, porque análise feita sobre um subconjunto das fotos não pode
 * chegar com cara de análise completa.
 */
export function prepararImagens(
  brutas: readonly string[],
  orcamentoJaUsadoBytes = 0,
): ImagensPreparadas {
  const blocos: BlocoImagem[] = [];
  const rejeitadas: ImagemRejeitada[] = [];
  // O teto de 32 MB vale para o CORPO INTEIRO do request — o system prompt
  // carrega o catálogo e conta junto. Começar do zero aqui superestimaria a
  // folga e o request estouraria com 413.
  let acumulado = Math.max(0, orcamentoJaUsadoBytes);

  for (let i = 0; i < brutas.length; i++) {
    const r = montarBlocoImagem(brutas[i]);
    if (!r.ok) {
      rejeitadas.push({ indice: i, motivo: r.erro });
      continue;
    }
    const tamanho = r.bloco.source.data.length;
    if (acumulado + tamanho > LIMITE_TOTAL_BASE64_BYTES) {
      const mb = (tamanho / (1024 * 1024)).toFixed(1);
      rejeitadas.push({
        indice: i,
        motivo:
          `não coube no limite de ~28 MB por análise (${mb} MB somados às anteriores). Envie em duas levas.`,
      });
      continue;
    }
    acumulado += tamanho;
    blocos.push(r.bloco);
  }

  return { blocos, rejeitadas };
}

/** Aviso legível para o vendedor quando alguma foto ficou de fora. */
export function avisoImagensRejeitadas(rejeitadas: readonly ImagemRejeitada[]): string {
  if (rejeitadas.length === 0) return "";
  const lista = rejeitadas
    .map((r) => `foto ${r.indice + 1} (${r.motivo})`)
    .join("; ");
  return `${rejeitadas.length} foto(s) NÃO analisada(s): ${lista}`;
}
