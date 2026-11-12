// Para quem vai cada alerta de `fornecedor_alerta` — e com que corpo.
//
// Até o Radar D1 (2026-11-06) todo alerta ia para o MESMO endereço (`NOTIFICATION_EMAIL_TO`, o gestor). O e-mail
// semanal de leads vai para o VENDEDOR. O destinatário NÃO vem de coluna de `fornecedor_alerta` (staff escreve nela;
// virar campo livre faria do Gmail da casa um relay): vem de `radar_email_vendedor_envios`, tabela fechada ao JWT cujo
// único escritor é `radar_avisar_vendedores()` (migration 20261106181000), que resolve o e-mail do `profiles` do
// vendedor ou o `email_teste` da config. Alerta sem envio → endereço padrão, como sempre foi.
//
// Venda R2 · Entrega 1 (2026-11-12): o RESUMO DIÁRIO de venda segue a mesma régua, com a tabela própria
// `venda_resumo_envio` (fechada ao JWT; escritor único `venda_resumo_preparar()`, migration 20261113110100), que traz
// também o token do pixel de abertura (`abertura.ts`). Os dois mapas se juntam em `mapaDestinatarios`.
//
// Módulo PURO: a edge decide com ele e o `destinatario_test.ts` prova a régua.

export interface EnvioVendedor {
  alerta_id: number;
  destinatario_email: string | null;
}

export interface Destino {
  to: string;
  /** true = e-mail de leads ao vendedor: corpo próprio, sem o cabeçalho técnico (empresa/tipo/metadata). */
  doVendedor: boolean;
  /** Só no resumo de venda: token do pixel de abertura do envio. */
  pixel?: string;
}

/** Linha de `venda_resumo_envio` que a edge lê: destinatário e token do pixel. */
export interface EnvioResumo {
  alerta_id: number;
  destinatario_email: string | null;
  token_abertura: string | null;
}

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Índice alerta → destinatário. Linha com e-mail vazio/malformado é ignorada (o alerta cai no padrão). */
export function mapaDestinatarios(envios: readonly EnvioVendedor[]): Map<number, string> {
  const mapa = new Map<number, string>();
  for (const e of envios) {
    const email = typeof e.destinatario_email === "string" ? e.destinatario_email.trim() : "";
    if (Number.isFinite(e.alerta_id) && EMAIL_OK.test(email)) mapa.set(Number(e.alerta_id), email);
  }
  return mapa;
}

/** Índice alerta → token do pixel, só dos envios do resumo de venda com destinatário válido (o e-mail entra no mapa
 * de destinatários por `mapaDestinatarios(radar.concat(resumos))`). */
export function mapaPixels(resumos: readonly EnvioResumo[]): Map<number, string> {
  const mapa = new Map<number, string>();
  for (const e of resumos) {
    const email = typeof e.destinatario_email === "string" ? e.destinatario_email.trim() : "";
    const token = typeof e.token_abertura === "string" ? e.token_abertura.trim() : "";
    if (Number.isFinite(e.alerta_id) && EMAIL_OK.test(email) && token) mapa.set(Number(e.alerta_id), token);
  }
  return mapa;
}

export function destinatarioDe(
  alertaId: number,
  mapa: ReadonlyMap<number, string>,
  padrao: string,
  pixels?: ReadonlyMap<number, string>,
): Destino {
  const doVendedor = mapa.get(alertaId);
  if (!doVendedor) return { to: padrao, doVendedor: false };
  const pixel = pixels?.get(alertaId);
  return pixel ? { to: doVendedor, doVendedor: true, pixel } : { to: doVendedor, doVendedor: true };
}

/**
 * A leitura do envio falhou: aborta o dispatch ou segue sem destinos de vendedor?
 * Tabela AUSENTE (edge publicada antes da migration) não pode derrubar os avisos do gestor — sem a tabela não existe
 * alerta de vendedor. Qualquer outra falha aborta: mandar o e-mail do vendedor para o gestor e marcá-lo `notificado`
 * contaria um envio que ninguém recebeu.
 */
export function falhaDeLeituraAborta(erro: { code?: string | null; message?: string | null } | null): boolean {
  if (!erro) return false;
  const code = String(erro.code ?? "");
  if (code === "42P01" || code === "PGRST205") return false;
  return true;
}

function escapar(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Corpo do e-mail do vendedor: o texto do SQL, escapado, com os links clicáveis (+ o pixel, se houver). */
export function htmlDoVendedor(titulo: string, mensagem: string | null, urlPixel?: string | null): string {
  const corpo = escapar(mensagem ?? "")
    .replace(/https:\/\/[^\s<>"'&]+/g, (url) => `<a href="${url}">${url}</a>`)
    .replace(/\n/g, "<br/>");
  const pixel = urlPixel ? `<img src="${escapar(urlPixel)}" width="1" height="1" alt="" style="display:none"/>` : "";
  return `<h2>${escapar(titulo)}</h2><p>${corpo}</p>${pixel}`;
}
