// src/lib/tint/sync-promote.ts
// Oráculo puro da promoção staging→oficial do tint sync.
// ESPELHADO VERBATIM na migration tint_promote_sync_run (PG17 valida o espelho).
// Spec: docs/superpowers/specs/2026-06-09-tint-sync-sayersystem-design.md §6.2

export interface FormulaBase {
  volumeFormulacaoMl: number | null;
  itens: Array<{ id_corante: string; ordem: number; qtd_ml: number }>;
}
export interface EmbalagemVendavel { id_embalagem: string; volume_ml: number }
export interface FormulaExpandida {
  id_embalagem: string;
  volume_final_ml: number;
  itens: Array<{ id_corante: string; ordem: number; qtd_ml: number }>;
}
export interface InsumoPrecoBase { custo: number; imposto_pct: number; margem_pct: number }
export interface InsumoCorante { id_corante: string; custo: number; volume_ml: number }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Regra de 3: expande a fórmula (na embalagem de formulação) pra cada embalagem vendável. */
export function expandirFormula(f: FormulaBase, vendaveis: EmbalagemVendavel[]): FormulaExpandida[] {
  if (!f.volumeFormulacaoMl || f.volumeFormulacaoMl <= 0) return [];
  const volForm = f.volumeFormulacaoMl;
  const out: FormulaExpandida[] = [];
  for (const emb of vendaveis) {
    if (!emb.volume_ml || emb.volume_ml <= 0) continue;
    const fator = emb.volume_ml / volForm;
    out.push({
      id_embalagem: emb.id_embalagem,
      volume_final_ml: emb.volume_ml,
      itens: f.itens.map((it) => ({ ...it, qtd_ml: it.qtd_ml * fator })),
    });
  }
  return out;
}

/** Preço pág 9: base×(1+imp)×(1+marg) + Σ(qtd×custo/vol). Insumo faltando → null (nunca 0). */
export function precoFinalSayer(
  base: InsumoPrecoBase | null,
  itensExpandidos: Array<{ id_corante: string; qtd_ml: number }>,
  corantes: InsumoCorante[],
): number | null {
  if (base == null || !Number.isFinite(base.custo)) return null;
  const precoBase = base.custo * (1 + base.imposto_pct / 100) * (1 + base.margem_pct / 100);
  let somaCorantes = 0;
  for (const it of itensExpandidos) {
    const c = corantes.find((x) => x.id_corante === it.id_corante);
    if (!c || !Number.isFinite(c.custo) || !c.volume_ml || c.volume_ml <= 0) return null;
    somaCorantes += (c.custo / c.volume_ml) * it.qtd_ml;
  }
  return round2(precoBase + somaCorantes);
}

/** Guarda de blast radius da desativação por keys-snapshot (§11 P1-B). */
export function validarSnapshotKeys(p: {
  totalOficialAtivas: number;
  chavesNoSnapshot: number;
  desativariam: number;
}): { ok: boolean; motivo?: string } {
  if (p.totalOficialAtivas === 0) return { ok: true }; // primeira carga: nada a desativar
  if (p.chavesNoSnapshot < p.totalOficialAtivas * 0.5) {
    return { ok: false, motivo: "snapshot menor que 50% do oficial ativo (provável chunk perdido)" };
  }
  if (p.desativariam > p.totalOficialAtivas * 0.2) {
    return { ok: false, motivo: "blast radius: desativaria >20% das fórmulas ativas" };
  }
  return { ok: true };
}
