// Pixel de ABERTURA do resumo diário de venda (venda R2 · Entrega 1, 2026-11-12).
//
// O e-mail do resumo leva `<img src=".../dispatch-notifications?abertura=<token>">`. O cliente de e-mail busca a imagem
// SEM sessão — por isso este é o único caminho anônimo da edge, e ele é ESTREITO: só `GET` com `abertura` = um uuid.
// O que ele faz é só `venda_resumo_registrar_abertura(token)` (service_role; primeira abertura vence): o token é um
// uuid aleatório por envio, sem oráculo (a resposta é o mesmo GIF exista o token ou não) e nunca vai para o log.
// Qualquer outra requisição segue para o gate `authorizeCronOrStaff`, como sempre. Abertura é sinal FRACO (imagem
// bloqueada não marca; proxy que pré-carrega marca sem leitura) — o painel não a trata como uso.
//
// Módulo PURO: a edge decide com ele e o `abertura_test.ts` prova a régua.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** O token de abertura de uma requisição de pixel, ou null se ela não é uma (aí segue o fluxo autenticado). */
export function tokenDeAbertura(metodo: string, url: string): string | null {
  if (metodo !== "GET") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const t = (u.searchParams.get("abertura") ?? "").trim().toLowerCase();
  return UUID.test(t) ? t : null;
}

/** URL do pixel para o corpo do e-mail. `base` = SUPABASE_URL da edge. Token fora da forma → sem pixel. */
export function urlDoPixel(base: string, token: string | null | undefined): string | null {
  const t = typeof token === "string" ? token.trim().toLowerCase() : "";
  if (!UUID.test(t) || !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(base.replace(/\/+$/, ""))) return null;
  return `${base.replace(/\/+$/, "")}/functions/v1/dispatch-notifications?abertura=${t}`;
}

/** GIF transparente 1×1 (42 bytes). */
export const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0),
);

/** Cabeçalhos do pixel: nunca em cache (cada abertura tem de chegar aqui). */
export const CABECALHOS_PIXEL: Record<string, string> = {
  "Content-Type": "image/gif",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};
