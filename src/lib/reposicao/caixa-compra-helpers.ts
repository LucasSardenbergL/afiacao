/**
 * P4 do programa de ciclo financeiro — a COMPRA enxerga o CAIXA (advisory).
 *
 * Fato estrutural (mapeado 2026-07-29): não existe ponte reposição→financeiro. Um pedido
 * aprovado é invisível para a fin_projecao_13_semanas até virar título no Omie — e a Oben paga
 * a maioria dos fornecedores À VISTA, então a compra sai do caixa quase imediatamente. Estes
 * helpers somam a camada que ninguém somava: o que a fila de compras faz com o piso de caixa
 * projetado. ADVISORY — informa a decisão humana, nunca bloqueia aprovação (lição N3: aprovação
 * de compra é decisão humana).
 *
 * Regras money-path: projeção ausente/degradada → null ("indisponível"), nunca zero; custo de
 * capital sem config → null, nunca fabricado.
 */

/** Reposição fala 'OBEN' (maiúsculo); o financeiro fala 'oben' (minúsculo). Gotcha documentado. */
export function companyDoFinanceiro(empresa: string): string {
  return empresa.toLowerCase();
}

export interface SemanaProjecao {
  saldo_projetado: number | null;
  semana_label: string | null;
}

/**
 * Piso da projeção (o MIN encadeado das 13 semanas). Linhas sem saldo numérico são ignoradas;
 * nenhuma linha válida → null (projeção indisponível ≠ piso zero).
 */
export function pisoProjecao(semanas: SemanaProjecao[]): { pisoRs: number; semanaLabel: string | null } | null {
  let piso: number | null = null;
  let label: string | null = null;
  for (const s of semanas) {
    const v = s.saldo_projetado;
    if (v == null || !Number.isFinite(v)) continue;
    if (piso == null || v < piso) {
      piso = v;
      label = s.semana_label ?? null;
    }
  }
  return piso == null ? null : { pisoRs: piso, semanaLabel: label };
}

/**
 * Fila de compras que ainda VAI sair do caixa: pendentes de aprovação + aprovados aguardando
 * disparo. Pais de split ('split_em_filhos') ficam de fora por construção (o valor deles é a
 * soma dos filhos — contá-los dobraria a fila, lição da própria tela de pedidos).
 */
export function somarFilaCompras(
  pedidos: Array<{ status: string | null; valor_total: number | null }>,
): { pendentesRs: number; aprovadosRs: number; totalRs: number } {
  let pendentesRs = 0, aprovadosRs = 0;
  for (const p of pedidos) {
    const v = p.valor_total;
    if (v == null || !Number.isFinite(v) || v <= 0) continue;
    if (p.status === "pendente_aprovacao") pendentesRs += v;
    else if (p.status === "aprovado_aguardando_disparo") aprovadosRs += v;
  }
  return { pendentesRs, aprovadosRs, totalRs: pendentesRs + aprovadosRs };
}

/**
 * Impacto da fila (à vista ⇒ saída na semana corrente; a projeção é ENCADEADA, então subtrair
 * do piso vale para todas as semanas seguintes). Referência de veto: R$0 — o piso de runway do
 * dono não está configurado no app (declarado na UI como premissa).
 */
export function avaliarFilaNoCaixa(args: { pisoRs: number; filaRs: number }): {
  pisoDepoisRs: number;
  furaCaixa: boolean;
} {
  const pisoDepoisRs = args.pisoRs - args.filaRs;
  return { pisoDepoisRs, furaCaixa: pisoDepoisRs < 0 };
}

/**
 * Custo de capital MENSAL de carregar `valorRs` de estoque, pela taxa anual da config
 * (selic + spread + armazenagem, % a.a. — a MESMA que alimenta o EOQ do motor).
 * Config ausente/inválida → null (nunca fabrica).
 */
export function custoCapitalMensal(valorRs: number, cmAnualPerc: number | null): number | null {
  if (cmAnualPerc == null || !Number.isFinite(cmAnualPerc) || cmAnualPerc <= 0) return null;
  if (!Number.isFinite(valorRs) || valorRs <= 0) return 0;
  return valorRs * (cmAnualPerc / 100) / 12;
}
