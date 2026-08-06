// src/lib/regua-preco/prazo-helpers.ts
// F2 — Custo do prazo de recebimento no PISO da régua de preço (PEGN erro 6).
// Helper PURO (vitest). Espelha a spec docs/superpowers/specs/2026-07-04-custo-prazo-regua-design.
// Money-path: precisão > recall — QUALQUER ambiguidade degrada para null; NUNCA fabrica prazo.
//
// ⚠️ FU4-F fase 2: a FÓRMULA do piso (`pisoComPrazo`) e a taxa (`custoCapitalPrazo`) saíram daqui
// para `private.regua_piso_calc` no servidor — no cliente elas precisavam do cmc, e é justamente
// o cmc que a vendedora deixou de receber. Sobra o PARSE do texto da condição, que não é custo:
// "A Vista/30/60" → [0,30,60]. Os dias vão como argumento da RPC; o piso volta pronto.

const DIA_MAX = 180; // §0.2: p95 real OBEN = 60d; teto 180 (perde 0,07% dos títulos) — acima disso, degrada
const MAX_PARCELAS = 12;

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
