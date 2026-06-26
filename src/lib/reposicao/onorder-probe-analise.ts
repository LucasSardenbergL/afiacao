// Análise PURA de cobertura do "a caminho" (on-order). Espelhado VERBATIM em
// supabase/functions/omie-onorder-probe/index.ts (Deno não importa de @/).
// READ-ONLY / diagnóstico: não decide compra, só mede cobertura.

export type SubClasse =
  | "dentro_janela"
  | "previsao_nula"
  | "futura_alem_janela"
  | "atrasada_alem_janela";

/** Dias entre duas datas ISO (b - a), por UTC (sem fuso/DST). NaN se inválida. */
function diffDiasISO(aISO: string, bISO: string): number {
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Classifica uma PO aberta pela sua previsão de entrega, relativa à janela
 * [hoje-passadoDias, hoje+futuroDias]. Previsão nula OU malformada → previsao_nula
 * (fail-safe: tratamos como invisível ao filtro-por-previsão, que é o pior caso honesto).
 */
export function classificarCobertura(
  previsaoISO: string | null,
  hojeISO: string,
  passadoDias: number,
  futuroDias: number,
): SubClasse {
  if (!previsaoISO) return "previsao_nula";
  const d = diffDiasISO(hojeISO, previsaoISO); // >0 futuro, <0 passado
  if (!Number.isFinite(d)) return "previsao_nula";
  if (d > futuroDias) return "futura_alem_janela";
  if (d < -passadoDias) return "atrasada_alem_janela";
  return "dentro_janela";
}

export interface POIndependente { previsao: string | null; saldo: number }
export interface DiferencaCobertura {
  escapam: Array<{ nCodPed: string; subClasse: SubClasse; saldo: number }>;
  totalUnidadesEscapam: number;
  porSubClasse: Record<SubClasse, number>;
}

/**
 * Dado o conjunto de POs vistas pela janela-por-previsão (por nCodPed) e um conjunto
 * INDEPENDENTE da janela (nCodPed → previsão/saldo), retorna as POs do independente
 * AUSENTES da janela (= escapam do "a caminho"), classificadas. Money-path: a direção
 * do erro dessas é SUBESTIMAR → compra dupla.
 */
export function diferencaCobertura(
  vistosJanela: ReadonlySet<string>,
  independente: ReadonlyMap<string, POIndependente>,
  hojeISO: string,
  passadoDias: number,
  futuroDias: number,
): DiferencaCobertura {
  const escapam: DiferencaCobertura["escapam"] = [];
  const porSubClasse: Record<SubClasse, number> = {
    dentro_janela: 0, previsao_nula: 0, futura_alem_janela: 0, atrasada_alem_janela: 0,
  };
  let totalUnidadesEscapam = 0;
  for (const [nCodPed, po] of independente) {
    if (vistosJanela.has(nCodPed)) continue;
    const subClasse = classificarCobertura(po.previsao, hojeISO, passadoDias, futuroDias);
    escapam.push({ nCodPed, subClasse, saldo: po.saldo });
    porSubClasse[subClasse] += 1;
    totalUnidadesEscapam += Number.isFinite(po.saldo) ? po.saldo : 0;
  }
  return { escapam, totalUnidadesEscapam, porSubClasse };
}
