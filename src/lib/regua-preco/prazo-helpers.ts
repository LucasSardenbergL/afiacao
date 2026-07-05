// src/lib/regua-preco/prazo-helpers.ts
// F2 — Custo do prazo de recebimento no PISO da régua de preço (PEGN erro 6).
// Helpers PUROS (vitest). Espelham a spec docs/superpowers/specs/2026-07-04-custo-prazo-regua-design.
// Money-path: precisão > recall — QUALQUER ambiguidade degrada para null; NUNCA fabrica prazo/custo.
// Fórmula (Candidato A, imposto na saída/faturamento — LC 87/96): piso = cmc/(S − aliquota),
// S = média dos fatores de desconto das parcelas (parcelas iguais, validado 99,8% na prod).

/** Piso ajustado ao prazo + memória de cálculo. */
export interface PisoPrazoResult {
  piso: number; // piso ajustado ao prazo (≥ piso à vista)
  custoRs: number; // quanto o prazo somou ao piso à vista: piso − cmc/(1−aliquota)
  prazoMedio: number; // média dos dias das parcelas (para copy/recibo)
  S: number; // fator presente médio Σ(1/n)·(1+r)^(−diasᵢ/365)
}

const DIA_MAX = 180; // §0.2: p95 real OBEN = 60d; teto 180 (perde 0,07% dos títulos) — acima disso, degrada
const MAX_PARCELAS = 12;
const EPS_DENOM = 1e-6; // gate de denominador: S − aliquota tem de superar isto (senão piso explode/negativa)

/**
 * Extrai os dias de vencimento (desde a emissão) de cada parcela a partir da descrição
 * de texto livre da condição de pagamento (§0.1: `dias_parcelas` vem VAZIO na prod).
 * Ex.: "A Vista/30/60" → [0,30,60]; "30/60/90" → [30,60,90]; "Para 45 dias" → [45].
 * Retorna null (degrada, NUNCA adivinha) se: token não reconhecido; `tokens.length !== numParcelas`;
 * numParcelas ∉ [1..12]; algum dia < 0 ou > 180; lista não-monotônica não-decrescente.
 */
export function parsePrazoRecebimento(
  descricao: string | null | undefined,
  numParcelas: number | null | undefined,
): number[] | null {
  if (descricao == null || numParcelas == null) return null;
  if (!Number.isInteger(numParcelas) || numParcelas < 1 || numParcelas > MAX_PARCELAS) return null;

  const tokens = descricao.trim().toLowerCase().split('/').map((t) => t.trim());
  if (tokens.length !== numParcelas) return null; // o texto tem de bater com a contagem de parcelas

  const dias: number[] = [];
  for (const tok of tokens) {
    if (tok === 'a vista' || tok === 'à vista' || tok === 'avista') {
      dias.push(0);
      continue;
    }
    const para = tok.match(/^para\s+(\d+)\s*dias?$/); // "para 30 dias"
    if (para) {
      dias.push(Number(para[1]));
      continue;
    }
    if (/^\d+$/.test(tok)) {
      dias.push(Number(tok));
      continue;
    }
    return null; // token não reconhecido → degrada
  }

  for (let i = 0; i < dias.length; i++) {
    if (!Number.isFinite(dias[i]) || dias[i] < 0 || dias[i] > DIA_MAX) return null;
    if (i > 0 && dias[i] < dias[i - 1]) return null; // não-monotônico → texto suspeito, degrada
  }
  return dias;
}

/**
 * Taxa anual (fração) do custo de capital do prazo, a partir dos componentes de
 * `empresa_configuracao_custos` (em %). EXCLUI armazenagem física (§0.4: custo de estocar,
 * não de financiar duplicata). Unit gate (§4): componentes ∈ [0,100]; taxa final ∈ (0,1); senão null.
 */
export function custoCapitalPrazo(
  selicAnual: number | null | undefined,
  spreadOportunidade: number | null | undefined,
): number | null {
  if (selicAnual == null || spreadOportunidade == null) return null;
  if (!Number.isFinite(selicAnual) || !Number.isFinite(spreadOportunidade)) return null;
  if (selicAnual < 0 || selicAnual > 100) return null;
  if (spreadOportunidade < 0 || spreadOportunidade > 100) return null;
  const r = (selicAnual + spreadOportunidade) / 100;
  if (!(r > 0 && r < 1)) return null; // rejeita ≥100% a.a. (erro de unidade) e ≤0
  return r;
}

/**
 * Piso ajustado ao prazo (Candidato A). Parcelas iguais (wᵢ=1/n): S = média (1+r)^(−dias/365).
 * Retorna null se qualquer guard falhar (§5) — inclui o gate de denominador (S − aliquota > ε),
 * que impede piso negativo/explosivo por prazo absurdo (Codex P1-D1). À vista pura (todos 0)
 * degenera para o piso à vista com custoRs ≈ 0 (não é degradação).
 */
export function pisoComPrazo(
  cmc: number,
  aliquota: number,
  dias: number[],
  taxaAnual: number,
): PisoPrazoResult | null {
  if (!Number.isFinite(cmc) || cmc <= 0) return null;
  if (!(aliquota >= 0 && aliquota < 1)) return null;
  if (!(taxaAnual > 0 && taxaAnual < 1)) return null;
  if (!Array.isArray(dias) || dias.length === 0) return null;
  for (const d of dias) {
    if (!Number.isFinite(d) || d < 0 || d > DIA_MAX) return null;
  }

  const n = dias.length;
  const S = dias.reduce((acc, d) => acc + Math.pow(1 + taxaAnual, -d / 365), 0) / n;
  if (!(S - aliquota > EPS_DENOM)) return null; // denominador não-positivo/ínfimo → degrada

  const piso = cmc / (S - aliquota);
  if (!Number.isFinite(piso) || piso <= 0) return null;

  const pisoAVista = cmc / (1 - aliquota);
  const custoRs = piso - pisoAVista;
  const prazoMedio = dias.reduce((a, d) => a + d, 0) / n;
  return { piso, custoRs, prazoMedio, S };
}
