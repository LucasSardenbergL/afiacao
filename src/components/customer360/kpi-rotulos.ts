// Rótulos da faixa de KPIs do Customer 360 — degradação HONESTA: valor que não foi lido é "—" com o
// motivo, nunca R$ 0 nem um número-sentinela exibido como se fosse medida.
import { formatBRL } from './format';
import type { CustomerMetrics, RevenueDerived } from './viewTypes';

/**
 * `customer_metrics_mv` grava `COALESCE(dias_desde_ultima_compra, 9999)`: 9999 é "nunca comprou", não
 * uma contagem de dias. Exibido cru, 4.470 de 5.665 clientes (79%, medido 2026-10-01) liam "9999d".
 */
export const DIAS_SEM_COMPRA = 9999;

type Rotulo = { value: string; hint?: string };

/** Faturamento 12m: o número só aparece LIDO; antes disso "carregando…", sob falha "indisponível". */
export function rotuloFaturamento12m(r: RevenueDerived): Rotulo {
  if (r.last12 === null || r.orderCount12m === null) {
    return { value: '—', hint: r.faturamentoIndisponivel ? 'indisponível' : 'carregando…' };
  }
  return { value: formatBRL(r.last12), hint: `${r.orderCount12m} pedidos` };
}

/**
 * Valor de um tile que vem do `customer_metrics_mv`. Leitura que falhou ou cliente FORA da MV (criado
 * depois do último refresh, 6/6h) não viram R$ 0: o `?? 0` antigo afirmava "não comprou em 90d" sem ter
 * lido nada.
 */
export function rotuloMetrica(
  m: CustomerMetrics,
  metricasIndisponiveis: boolean,
  ler: (m: NonNullable<CustomerMetrics>) => string,
): string {
  if (metricasIndisponiveis || !m) return '—';
  return ler(m);
}

/** Última compra pela MV — o mesmo universo e o mesmo eixo de data do tile "90d". */
export function rotuloUltimaCompra(m: CustomerMetrics, metricasIndisponiveis: boolean): string {
  return rotuloMetrica(m, metricasIndisponiveis, (x) => {
    const dias = x.dias_desde_ultima_compra;
    if (dias == null) return '—';
    if (dias >= DIAS_SEM_COMPRA) return 'Nunca';
    return `${dias}d`;
  });
}
