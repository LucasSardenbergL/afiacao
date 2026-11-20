// Lógica PURA da edge `email-crs-ajuste-lote` (Fase 2a do lote mínimo Sayerlack).
// Sem IO: template fixo (sem LLM), montagem RFC 2822 e a classificação da resposta do Gmail.
// Spec: docs/superpowers/specs/2026-11-18-sayerlack-lote-minimo-portal-design.md §Fase 2.

export const CRS_PARA = "crs@sayerlack.com.br";

export type ItemAjuste = {
  skuPortal: string;
  descricao: string | null;
  qtdeLancada: number; // Qtd UN lançada no portal (= lote mínimo)
  qtdeNecessaria: number; // Qtd UN que de fato precisamos
};

/** "Re: " uma vez só — o Gmail agrupa no thread pelo threadId + assunto compatível. */
export function assuntoResposta(assunto: string): string {
  return /^re:\s/i.test(assunto) ? assunto : `Re: ${assunto}`;
}

function linhaItem(i: ItemAjuste): string {
  const desc = i.descricao && i.descricao.trim() ? ` (${i.descricao.trim()})` : "";
  return `- ${i.skuPortal}${desc}: lançado ${i.qtdeLancada} UN pelo lote mínimo, precisamos de ${i.qtdeNecessaria} UN`;
}

/** Corpo do 1º e-mail. Texto puro, template fixo. Lança se não houver item (nunca e-mail vazio). */
export function montarCorpoInicial(protocolo: string, itens: ItemAjuste[]): string {
  if (itens.length === 0) throw new Error("montarCorpoInicial: sem itens");
  for (const i of itens) {
    if (!(Number.isInteger(i.qtdeLancada) && Number.isInteger(i.qtdeNecessaria) && i.qtdeLancada > i.qtdeNecessaria &&
      i.qtdeNecessaria > 0)) {
      throw new Error(`montarCorpoInicial: quantidades incoerentes em ${i.skuPortal}`);
    }
  }
  const umItem = itens.length === 1;
  return [
    "Bom dia,",
    "",
    `No pedido Sayerlack ${protocolo}, o portal só aceitou ${umItem ? "o item abaixo" : "os itens abaixo"} pelo lote mínimo:`,
    "",
    ...itens.map(linhaItem),
    "",
    `Conseguem alterar para a quantidade que precisamos? Por favor, confirmem a alteração respondendo este e-mail.`,
    `Se não for possível, pedimos o cancelamento ${umItem ? "desse item" : "desses itens"} do pedido.`,
    "",
    "Obrigado.",
  ].join("\r\n");
}

/** Corpo da cobrança (resposta no MESMO thread). Texto decidido pelo founder. */
export function montarCorpoCobranca(protocolo: string): string {
  return `Bom dia, conseguem confirmar a alteração do pedido ${protocolo}?`;
}

function b64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64Url(s: string): string {
  return b64Utf8(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * RFC 2822 em texto puro UTF-8 (corpo em base64, assunto em RFC 2047). Sem `From`: o Gmail usa a conta
 * do token (o Gmail do founder). `inReplyTo` presente ⇒ resposta: grava In-Reply-To + References.
 */
export function montarRfc2822(p: {
  para: string;
  assunto: string;
  corpo: string;
  messageId: string;
  inReplyTo?: string | null;
}): string {
  const cab = [
    `To: ${p.para}`,
    `Subject: =?UTF-8?B?${b64Utf8(p.assunto)}?=`,
    `Message-ID: ${p.messageId}`,
  ];
  if (p.inReplyTo) {
    cab.push(`In-Reply-To: ${p.inReplyTo}`, `References: ${p.inReplyTo}`);
  }
  cab.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  );
  const corpo64 = (b64Utf8(p.corpo).match(/.{1,76}/g) ?? []).join("\r\n");
  return [...cab, "", corpo64].join("\r\n");
}

/**
 * Classifica o desfecho do POST `users/me/messages/send`. Precisão > recall: só é `nao_enviado` quando o
 * Gmail RESPONDEU recusando (4xx, inclusive 429). 5xx, rede, timeout e 2xx sem `id`/`threadId` são
 * `indeterminado` — pode ter saído; nunca se reenvia sozinho.
 */
export type DesfechoEnvio =
  | { tipo: "enviado"; id: string; threadId: string }
  | { tipo: "nao_enviado"; motivo: string }
  | { tipo: "indeterminado"; motivo: string };

export function classificarEnvioGmail(r: { status: number; corpo: string } | { erroRede: string }): DesfechoEnvio {
  if ("erroRede" in r) return { tipo: "indeterminado", motivo: `rede: ${r.erroRede}`.slice(0, 500) };
  if (r.status >= 200 && r.status < 300) {
    try {
      const j = JSON.parse(r.corpo) as { id?: unknown; threadId?: unknown };
      if (typeof j.id === "string" && j.id && typeof j.threadId === "string" && j.threadId) {
        return { tipo: "enviado", id: j.id, threadId: j.threadId };
      }
    } catch { /* cai no indeterminado */ }
    return { tipo: "indeterminado", motivo: `HTTP ${r.status} sem id/threadId` };
  }
  if (r.status >= 400 && r.status < 500) {
    return { tipo: "nao_enviado", motivo: `HTTP ${r.status}: ${r.corpo}`.slice(0, 500) };
  }
  return { tipo: "indeterminado", motivo: `HTTP ${r.status}: ${r.corpo}`.slice(0, 500) };
}

/** `Retry-After` do 429 (segundos ou data HTTP). Ilegível → null (o SQL aplica o backoff próprio). */
export function segundosRetryAfter(valor: string | null, agoraMs: number): number | null {
  if (!valor) return null;
  const v = valor.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), 86400);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.min(Math.ceil((t - agoraMs) / 1000), 86400));
}

/** Message-ID RFC do `messages.get?format=metadata`. Só aceita `<a@b>`; qualquer outra forma → null. */
export function extrairMessageIdRfc(corpo: unknown): string | null {
  const headers = (corpo as { payload?: { headers?: unknown } } | null)?.payload?.headers;
  if (!Array.isArray(headers)) return null;
  for (const h of headers) {
    const nome = (h as { name?: unknown })?.name;
    const valor = (h as { value?: unknown })?.value;
    if (typeof nome === "string" && nome.toLowerCase() === "message-id" && typeof valor === "string") {
      const v = valor.trim();
      return /^<[^<>\s]+@[^<>\s]+>$/.test(v) ? v : null;
    }
  }
  return null;
}
