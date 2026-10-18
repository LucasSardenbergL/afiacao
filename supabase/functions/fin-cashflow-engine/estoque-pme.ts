// PME honesto: estoque e CMV ausentes viram null + motivo, nunca 0.
// Spec: docs/superpowers/specs/2026-10-18-ciclo-giro-sku-design.md §5.1 e §5.4 (6, 7, 9).
//
// Antes: `Number(fin_estoque_valor?.valor ?? 0)` — a tabela nunca foi escrita em prod, então o
// PME saía 0d e a NCG omitia o estoque nas 3 empresas; e o CMV somava o que houvesse na janela
// (6 meses da oben, CMV gravado 0 da colacor_sc) como se fossem 12.
import { somarDias } from "../_shared/hoje-sp.ts";

/** Inventário manual (fonte='manual') vale por este tempo; depois o Omie volta a mandar. */
export const MANUAL_VALIDADE_DIAS = 45;
/** Abaixo disto (% dos SKUs de giro com custo) o numerador não sustenta um PME. */
export const COBERTURA_CUSTO_MIN_PCT = 95;

export type EstoqueManual = { valor: number; data_ref: string } | null;
export type EstoqueOmie = {
  valor_giro: number | null;
  skus_giro: number;
  cobertura_pct: number | null;
  valor_sem_classificacao: number | null;
} | null;
export type EstoqueResolvido = {
  valor: number | null;
  fonte: "manual" | "omie" | null;
  data_ref: string | null;
  /** false ⇒ o valor (se houver) é subtotal: serve à NCG, não ao PME. */
  cobertura_ok: boolean;
  motivos: string[];
};

const brl = (v: number) => `R$ ${Math.round(v).toLocaleString("pt-BR")}`;

export function resolverEstoque(manual: EstoqueManual, omie: EstoqueOmie, hojeSP: string): EstoqueResolvido {
  if (manual && manual.data_ref <= hojeSP && manual.data_ref >= somarDias(hojeSP, -MANUAL_VALIDADE_DIAS)) {
    return { valor: manual.valor, fonte: "manual", data_ref: manual.data_ref, cobertura_ok: true, motivos: [] };
  }
  if (omie && omie.valor_giro != null && omie.skus_giro > 0) {
    const motivos: string[] = [];
    const cobertura_ok = omie.cobertura_pct != null && omie.cobertura_pct >= COBERTURA_CUSTO_MIN_PCT;
    if (!cobertura_ok) {
      motivos.push(`Estoque Omie: só ${omie.cobertura_pct ?? "?"}% dos SKUs de giro têm custo (sem custo no restante) — PME indisponível.`);
    }
    if (omie.valor_sem_classificacao != null && omie.valor_sem_classificacao > 0) {
      motivos.push(`Estoque Omie: ${brl(omie.valor_sem_classificacao)} sem tipo de item no cadastro ficam fora da conta.`);
    }
    return { valor: omie.valor_giro, fonte: "omie", data_ref: hojeSP, cobertura_ok, motivos };
  }
  return {
    valor: null, fonte: null, data_ref: null, cobertura_ok: false,
    motivos: ["Estoque indisponível: sem inventário manual recente nem estoque de giro com custo no Omie — PME indisponível e NCG parcial."],
  };
}

/** Σ CMV dos 12 meses FECHADOS anteriores ao mês corrente de SP; exige os 12, distintos, não-null, Σ > 0. */
export function cmvTtmFechado(
  linhas: Array<{ ano: number; mes: number; cmv?: number | null }>,
  hojeSP: string,
): { valor: number | null; motivo: string | null } {
  const [ano, mes] = hojeSP.split("-").map(Number);
  const atual = ano * 12 + (mes - 1);
  const porMes = new Map<number, Array<number | null>>();
  let ultimo = -1;
  for (const l of linhas) {
    const idx = l.ano * 12 + (l.mes - 1);
    if (idx > ultimo && idx < atual) ultimo = idx;
    if (idx < atual - 12 || idx >= atual) continue;
    porMes.set(idx, [...(porMes.get(idx) ?? []), l.cmv == null ? null : Number(l.cmv)]);
  }
  let presentes = 0;
  let soma = 0;
  for (let idx = atual - 12; idx < atual; idx++) {
    const vs = porMes.get(idx);
    if (!vs || vs.length !== 1 || vs[0] == null || !Number.isFinite(vs[0])) continue;
    presentes++;
    soma += vs[0];
  }
  if (presentes < 12) {
    const ult = ultimo < 0 ? "nenhum" : `${Math.floor(ultimo / 12)}-${String((ultimo % 12) + 1).padStart(2, "0")}`;
    return { valor: null, motivo: `CMV do DRE cobre ${presentes}/12 meses fechados (último: ${ult}) — PME indisponível.` };
  }
  if (soma <= 0) return { valor: null, motivo: "CMV do DRE zerado nos 12 meses fechados — PME indisponível." };
  return { valor: soma, motivo: null };
}

export function calcularPme(estoque: number | null, cmvTtm: number | null, coberturaOk: boolean): number | null {
  if (estoque == null || cmvTtm == null || !coberturaOk) return null;
  return (estoque / cmvTtm) * 365;
}
