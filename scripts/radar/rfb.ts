/**
 * Onde a Receita Federal publica o dump de CNPJ — compartilhado por carga.ts (baixa) e mes-alvo.ts (sonda).
 *
 * ⚠️ A RFB mudou layout/URLs em jan/2026 — o caminho VIVO (descoberto na 1ª carga, 2026-06-11) é o share
 * Nextcloud público via WebDAV: `public.php/webdav/<YYYY-MM>/<arquivo>`. O token identifica o SHARE
 * público (é o mesmo link aberto da página de dados abertos do gov.br), não é credencial.
 *
 * Cadência medida em 2026-10-18 (PROPFIND no share): a pasta do mês M aparece na 2ª semana de M —
 * 2026-08 em 09/08, 2026-09 em 14/09, 2026-10 em 13/10. Tamanho de 2026-10: ~7,4 GB comprimidos
 * (Estabelecimentos0 sozinho 2,1 GB; os outros 9 ~330 MB; Empresas ~1,3 GB; Socios ~0,7 GB).
 */
export const RFB_SHARE_TOKEN = "YggdBLfdninEJX9";

export const basesCandidatas = (mes: string): string[] => [
  `https://arquivos.receitafederal.gov.br/public.php/webdav/${mes}`,
  `https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj/${mes}`,
  `https://dadosabertos.rfb.gov.br/CNPJ/dados_abertos_cnpj/${mes}`,
];

/** WebDAV de share Nextcloud exige basic auth "<token>:" — as outras bases, não. */
export const precisaDeAuth = (base: string): boolean => base.includes("public.php/webdav");

/** Header Authorization para `fetch` (o curl do carga.ts usa `-u` com o mesmo par). */
export const authorizationDe = (base: string): Record<string, string> =>
  precisaDeAuth(base) ? { Authorization: `Basic ${Buffer.from(`${RFB_SHARE_TOKEN}:`).toString("base64")}` } : {};

/** Arquivo pequeno que existe em toda pasta mensal — sonda de "o mês está publicado?". */
export const ARQUIVO_SONDA = "Cnaes.zip";
