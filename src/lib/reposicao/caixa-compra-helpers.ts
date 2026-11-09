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
  fluxo_liquido: number | null;
  semana_label: string | null;
}

/** Rótulo do ponto "hoje" quando ele é o piso. */
export const ROTULO_PISO_HOJE = "hoje";

/**
 * Piso da projeção: o MIN entre o saldo de HOJE e os fechamentos das 13 semanas encadeadas.
 *
 * O fechamento semanal sozinho não é piso de caixa (#3401): saldo R$100, compra à vista R$500 e
 * recebimento R$1.000 na sexta fecham a semana em R$600, mas o caixa vai a −R$400 hoje. A compra
 * à vista sai HOJE, então o saldo de hoje entra como ponto. Ele é exato pela RPC: a semana 0 parte
 * do saldo inicial, e `saldo_projetado[0] = saldo inicial + fluxo_liquido[0]`.
 *
 * Ainda NÃO é o mínimo do dia a dia dentro de cada semana (um pagamento antes de um recebimento da
 * mesma semana não aparece); a tela declara isso. Sem a semana 0 com saldo e fluxo numéricos não há
 * o ponto "hoje" → null (indisponível), nunca um piso só de fechamentos com cara de piso de caixa.
 * Semanas seguintes sem saldo numérico são ignoradas.
 */
export function pisoProjecao(semanas: SemanaProjecao[]): { pisoRs: number; semanaLabel: string | null } | null {
  const s0 = semanas[0];
  if (!s0) return null;
  const saldo0 = s0.saldo_projetado;
  const fluxo0 = s0.fluxo_liquido;
  if (saldo0 == null || fluxo0 == null || !Number.isFinite(saldo0) || !Number.isFinite(fluxo0)) return null;
  // Em centavos: 1100.10 − 1000 dá 100.09999999999991 em ponto flutuante, e a fila de R$100,10
  // "furaria" um caixa que zera (Codex, desenho do #3401).
  let piso = centavos(saldo0) - centavos(fluxo0);
  let label: string | null = ROTULO_PISO_HOJE;
  for (const s of semanas) {
    const v = s.saldo_projetado;
    if (v == null || !Number.isFinite(v)) continue;
    if (centavos(v) < piso) {
      piso = centavos(v);
      label = s.semana_label ?? null;
    }
  }
  return { pisoRs: piso / 100, semanaLabel: label };
}

function centavos(rs: number): number {
  return Math.round(rs * 100);
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
 * Impacto da fila, em centavos (à vista ⇒ saída hoje; a projeção é ENCADEADA, então subtrair
 * do piso vale para todas as semanas seguintes). Referência de veto: R$0 — o piso de runway do
 * dono não está configurado no app (declarado na UI como premissa).
 */
export function avaliarFilaNoCaixa(args: { pisoRs: number; filaRs: number }): {
  pisoDepoisRs: number;
  furaCaixa: boolean;
} {
  const depois = centavos(args.pisoRs) - centavos(args.filaRs);
  return { pisoDepoisRs: depois / 100, furaCaixa: depois < 0 };
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
