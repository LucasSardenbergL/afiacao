// Sensor de ruptura / fill-rate da Oben (Frente A do plano PME/PMR, 2026-10-31) — regra PURA sobre as
// views semanais `v_reposicao_ruptura_pedidos_semana` e `v_reposicao_ruptura_prateleira_semana`
// (migration 20261031200000). Ausente ≠ zero: coluna ilegível vira `null`, nunca 0; semana sem as
// chaves (empresa, semana) é DESCARTADA.
//
// Duas leituras, dois denominadores:
//   • pedidos: itens de PV importado × estoque no instante da importação. fill_rate_pct já vem null da
//     view quando há < 20 itens decididos na semana; `cobertura_pct` = registrados / importados (o
//     trigger é fail-open — cobertura < 100% é perda do sensor, não ruptura).
//   • prateleira: % dos SKUs com venda em 90d (e leitura fresca) sem saldo, média dos dias lidos.
// Guardrail da Frente C ("segurar compra"): fill-rate cai > 1 p.p. entre semanas FECHADAS → pausa.
import { addDias } from '@/lib/time/sp-day';
import { num } from '@/lib/financeiro/ciclo-cliente-helpers';

export type SemanaPedidos = {
  semana: string; itensRegistrados: number; itensImportados: number | null; pedidos: number;
  atendiveis: number; ruptura: number; indeterminados: number; semLeitura: number;
  fillRatePct: number | null; coberturaPct: number | null;
};

export type SemanaPrateleira = {
  semana: string; diasLidos: number; ultimoDia: string | null;
  pctSkusSemSaldo: number | null; pctValorSemSaldo: number | null; pctSkusSemLeitura: number | null;
  skusComVenda90d: number | null;
};

export function normalizarSemanaPedidos(r: Record<string, unknown>): SemanaPedidos | null {
  const semana = typeof r.semana === 'string' ? r.semana : null;
  const itensRegistrados = num(r.itens_registrados);
  const pedidos = num(r.pedidos);
  const atendiveis = num(r.itens_atendiveis);
  const ruptura = num(r.itens_ruptura);
  const indeterminados = num(r.itens_indeterminados);
  const semLeitura = num(r.itens_sem_leitura);
  if (r.empresa !== 'oben' || semana === null || itensRegistrados === null || pedidos === null
    || atendiveis === null || ruptura === null || indeterminados === null || semLeitura === null) return null;
  return {
    semana, itensRegistrados, itensImportados: num(r.itens_importados), pedidos, atendiveis, ruptura, indeterminados, semLeitura,
    fillRatePct: num(r.fill_rate_pct), coberturaPct: num(r.cobertura_pct),
  };
}

export function normalizarSemanaPrateleira(r: Record<string, unknown>): SemanaPrateleira | null {
  const semana = typeof r.semana === 'string' ? r.semana : null;
  const diasLidos = num(r.dias_lidos);
  if (r.empresa !== 'oben' || semana === null || diasLidos === null) return null;
  return {
    semana, diasLidos, ultimoDia: typeof r.ultimo_dia === 'string' ? r.ultimo_dia : null,
    pctSkusSemSaldo: num(r.pct_skus_sem_saldo), pctValorSemSaldo: num(r.pct_valor_sem_saldo),
    pctSkusSemLeitura: num(r.pct_skus_sem_leitura), skusComVenda90d: num(r.skus_com_venda_90d),
  };
}

/** Segunda-feira (ISO) da semana de `hojeSp` (YYYY-MM-DD, calendário de SP). Semana = chave das views. */
export function semanaDe(hojeSp: string): string {
  const [a, m, d] = hojeSp.split('-').map(Number);
  const dow = (new Date(Date.UTC(a, m - 1, d)).getUTCDay() + 6) % 7; // segunda = 0
  return addDias(hojeSp, -dow); // aritmética de calendário, sem relógio (gate hoje-utc)
}

/**
 * Variação em p.p. do fill-rate entre as duas últimas semanas FECHADAS com fill-rate (a semana
 * corrente, parcial, fica fora). `null` sem duas semanas comparáveis — nunca "0 p.p." fabricado.
 */
export function variacaoFillRatePp(serie: SemanaPedidos[], hojeSp: string): { de: string; para: string; pp: number } | null {
  const corrente = semanaDe(hojeSp);
  const fechadas = serie.filter((s) => s.semana < corrente && s.fillRatePct !== null).sort((a, b) => a.semana.localeCompare(b.semana));
  if (fechadas.length < 2) return null;
  const ultima = fechadas[fechadas.length - 1];
  const anterior = fechadas[fechadas.length - 2];
  return { de: anterior.semana, para: ultima.semana, pp: (ultima.fillRatePct as number) - (anterior.fillRatePct as number) };
}

/** Guardrail da Frente C: queda > 1 p.p. entre semanas fechadas. `null` = sem base para dizer. */
export function guardrailFillRate(variacao: { pp: number } | null): 'estavel' | 'queda' | null {
  if (variacao === null) return null;
  return variacao.pp < -1 ? 'queda' : 'estavel';
}

export const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v.toFixed(1).replace('.', ',')}%`);
