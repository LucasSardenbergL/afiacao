// Tetos de tamanho do gmail-webhook-receiver (scanner Lovable Security `03689f08`, lote 3).
//
// Antes, o corpo era lido inteiro e cada anexo era decodificado e salvo no storage sem nenhum
// limite. Quem tivesse o segredo, ou um e-mail de remetente mapeado com anexo enorme, enchia o
// bucket e a memória da edge. Agora há quatro tetos, todos FAIL-CLOSED: estourou um, a mensagem
// inteira é recusada antes do primeiro upload. Não se salva só "o que coube", porque meia campanha
// extraída parece campanha inteira na reposição.
//
// Os tetos medem o BASE64 (o que chega no fio), sem decodificar: a checagem não aloca o arquivo.
// PURO e sem import remoto: `test:edges` roda com `--no-remote`.

/** Teto por anexo, em base64. É o mesmo do extrator (`LIMITE_BASE64_BYTES` de
 *  promocao-extrair-via-vision/vision-helpers.ts): um anexo maior que isso o extrator recusaria de
 *  qualquer jeito, depois de já ter ido para o storage. */
export const TETO_ANEXO_BASE64 = 30 * 1024 * 1024;

/** Teto da soma dos anexos da mensagem (todos, inclusive os não processáveis), em base64. */
export const TETO_MENSAGEM_BASE64 = 40 * 1024 * 1024;

/** Teto de anexos por mensagem. O maior e-mail registrado até 2026-11-15 tinha 11. */
export const TETO_ANEXOS = 20;

/** Teto do corpo HTTP inteiro, lido em stream: a soma dos anexos mais 2 MB para o envelope JSON. */
export const TETO_CORPO_BYTES = TETO_MENSAGEM_BASE64 + 2 * 1024 * 1024;

export type LeituraCorpo =
  | { ok: true; texto: string }
  | { ok: false; motivo: "corpo_grande" | "corpo_ilegivel" };

/**
 * Lê o corpo em stream e para no teto. Não confia no `Content-Length`, que o cliente pode omitir
 * ou mentir: conta os bytes que de fato chegam.
 */
export async function lerCorpoComTeto(
  corpo: ReadableStream<Uint8Array> | null,
  teto: number = TETO_CORPO_BYTES,
): Promise<LeituraCorpo> {
  if (!corpo) return { ok: true, texto: "" };
  const leitor = corpo.getReader();
  const pedacos: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > teto) {
        await leitor.cancel().catch(() => {});
        return { ok: false, motivo: "corpo_grande" };
      }
      pedacos.push(value);
    }
  } catch {
    return { ok: false, motivo: "corpo_ilegivel" };
  }
  const junto = new Uint8Array(total);
  let pos = 0;
  for (const p of pedacos) {
    junto.set(p, pos);
    pos += p.byteLength;
  }
  return { ok: true, texto: new TextDecoder().decode(junto) };
}

export interface AnexoMedido {
  filename?: unknown;
  contentBase64?: unknown;
}

export type VereditoAnexos = { ok: true } | { ok: false; erro: string };

/**
 * Confere os tetos da lista de anexos. `attachments` ausente é lista vazia. Um item que não é
 * objeto, ou cujo `contentBase64` não é string, é recusado: tamanho desconhecido não passa.
 */
export function conferirTetosAnexos(attachments: unknown): VereditoAnexos {
  if (attachments === undefined || attachments === null) return { ok: true };
  if (!Array.isArray(attachments)) return { ok: false, erro: "attachments não é uma lista" };
  if (attachments.length > TETO_ANEXOS) {
    return {
      ok: false,
      erro: `mensagem com ${attachments.length} anexos; o teto é ${TETO_ANEXOS}`,
    };
  }
  let soma = 0;
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i] as AnexoMedido | null;
    if (!a || typeof a !== "object" || typeof a.contentBase64 !== "string") {
      return { ok: false, erro: `anexo ${i + 1} sem conteúdo base64 legível` };
    }
    const tamanho = a.contentBase64.length;
    if (tamanho > TETO_ANEXO_BASE64) {
      const nome = typeof a.filename === "string" ? a.filename.slice(0, 80) : `#${i + 1}`;
      return {
        ok: false,
        erro: `anexo ${nome} com ${mb(tamanho)} MB em base64; o teto por anexo é ${mb(TETO_ANEXO_BASE64)} MB`,
      };
    }
    soma += tamanho;
  }
  if (soma > TETO_MENSAGEM_BASE64) {
    return {
      ok: false,
      erro: `anexos somam ${mb(soma)} MB em base64; o teto por mensagem é ${mb(TETO_MENSAGEM_BASE64)} MB`,
    };
  }
  return { ok: true };
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
