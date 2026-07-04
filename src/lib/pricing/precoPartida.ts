/**
 * precoPartida — a precedência de NASCIMENTO do preço de um item novo no wizard.
 *
 * Fonte única da regra da spec "preço por tier" (§4). Função PURA e determinística:
 * recebe `hoje` injetado (nunca Date.now()) e roda sobre a TABELA, jamais sobre o
 * preço já no carrinho — por isso é idempotente por construção (re-hidratar o draft
 * não re-multiplica). Chamada UMA vez em getProductPrice/addProductToCart.
 *
 * Precedência:
 *   1. Último praticado do cliente (≤180d) — se > 0. Sem data → preserva o vigente
 *      (a janela só DERRUBA preço com data comprovadamente >180d; ausência de data
 *      ≠ velho — "cliente sem o dado novo mantém o comportamento de hoje").
 *   2. Tabela Omie × mult_partida(tier) — se tem tier E mult válido (conta ativa).
 *   3. Tabela Omie pura.
 *
 * NÃO cobre tint (selectTintPrice é intocado) nem o piso (cockpit/Fase B).
 */

export const JANELA_ULTIMO_PRATICADO_DIAS = 180;

export type Tier = 'A' | 'B' | 'C';

export interface PrecoPartidaInput {
  /** product.valor_unitario (tabela Omie) */
  tabela: number;
  /** último preço praticado (get_ultimos_precos_cliente) ou null */
  ultimoPraticado: number | null;
  /** data ISO 'yyyy-mm-dd' do último praticado (order_date_kpi) ou null */
  ultimoPraticadoEm: string | null;
  /** relógio injetado (determinismo/idempotência) */
  hoje: Date;
  /** tier do cliente NA CONTA do item, ou null */
  tier: Tier | null;
  /** tier_preco_config.mult_partida da conta×tier, ou null */
  mult: number | null;
}

/** Idade em dias-calendário (UTC puro dos componentes; sem ruído de hora/fuso). */
function idadeEmDias(dataIso: string, hoje: Date): number | null {
  const partes = dataIso.split('-').map(Number);
  if (partes.length !== 3 || partes.some(n => !Number.isFinite(n))) return null;
  const [y, m, d] = partes;
  const dataDia = Date.UTC(y, m - 1, d);
  const hojeDia = Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return Math.floor((hojeDia - dataDia) / 86_400_000);
}

export function precoPartida(input: PrecoPartidaInput): number {
  const { tabela, ultimoPraticado, ultimoPraticadoEm, hoje, tier, mult } = input;

  // 1) Último praticado válido e dentro da janela (ou sem data → mantém o vigente).
  if (ultimoPraticado != null && Number.isFinite(ultimoPraticado) && ultimoPraticado > 0) {
    const idade = ultimoPraticadoEm ? idadeEmDias(ultimoPraticadoEm, hoje) : null;
    // idade === null → sem data confiável → NÃO derruba (comportamento vigente).
    if (idade === null || idade <= JANELA_ULTIMO_PRATICADO_DIAS) {
      return ultimoPraticado;
    }
  }

  // 2) Partida por tier: tabela × mult (só com tier E mult válido E tabela positiva).
  const multValido = mult != null && Number.isFinite(mult) && mult > 0;
  if (tier != null && multValido && tabela > 0) {
    return tabela * mult;
  }

  // 3) Tabela pura (degradação honesta: sem os dados novos, comportamento de hoje).
  return tabela;
}
