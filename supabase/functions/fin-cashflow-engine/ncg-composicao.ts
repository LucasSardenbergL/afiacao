// Composição da NCG em colunas DEDICADAS do snapshot (engine v2.5, Fase 5 da Visão do CEO).
//
// Antes o snapshot só gravava `ncg` (o total): o leitor via QUANTO capital de giro a empresa precisa,
// nunca DE ONDE ele vem (recebível × estoque × fornecedor × folha × tributo). Este helper traduz o
// `NCG` calculado por `calcularNCG` nas 6 colunas `ncg_*` — 1 writer (o cron diário, `save_snapshot`);
// sinal money-path nunca em `premissas` (jsonb multi-chave).
//
// Ausente ≠ zero:
//   - snapshot anterior à v2.5 → as 6 colunas NULL ("—" no leitor, nunca 0);
//   - estoque sem fonte → `ncg_estoque` NULL com o CR presente = NCG PARCIAL (o total soma só o que
//     existe — é exatamente o `ncg.parcial` da engine);
//   - empresa sem categoria de adiantamento configurada → `ncg_adiantamentos` NULL ("não segregado": o
//     adiantamento, se houver, está dentro de `ncg_cp_fornecedor`) — nunca um 0 com cara de medido;
//   - leitor: `ncg_cr_aberto IS NULL` = não medido; só com ele presente o estoque NULL quer dizer parcial.
//   - composição incoerente (não finita, negativa, acima do teto, ou que não fecha com o total) → as 6
//     NULL: "não medido" em vez de um número que não bate. O CHECK da tabela espelha isto, então ele
//     nunca derruba o snapshot.

/** Teto de negócio por componente (o mesmo das colunas `cp_vencido_fora_*`). */
const TETO = 1e10;
/**
 * Folga de arredondamento entre Σ componentes (cada um em centavos) e o total gravado em `ncg`. O CHECK
 * do banco aceita 0,05; o helper exige 0,04 — o float do JS e o numeric exato do banco discordam na
 * FRONTEIRA (0,35000000000000003 − 0,3), e quem recusa tem de ser o helper, nunca o CHECK (achado Codex).
 * O erro legítimo é ≤ 3 centavos (6 parcelas arredondadas a ±0,005).
 */
const NCG_TOLERANCIA_FECHAMENTO = 0.04;

export type ComposicaoNcgEntrada = {
  aco: { cr_aberto: number; estoque: number | null; adiantamentos: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number };
  valor: number;
};

export type ColunasComposicaoNcg = {
  ncg_cr_aberto: number | null;
  ncg_estoque: number | null;
  ncg_adiantamentos: number | null;
  ncg_cp_fornecedor: number | null;
  ncg_folha_30d: number | null;
  ncg_tributos_a_pagar: number | null;
};

const VAZIO: ColunasComposicaoNcg = {
  ncg_cr_aberto: null, ncg_estoque: null, ncg_adiantamentos: null,
  ncg_cp_fornecedor: null, ncg_folha_30d: null, ncg_tributos_a_pagar: null,
};

const centavos = (v: number) => Math.round(v * 100) / 100;
const valido = (v: number) => Number.isFinite(v) && v >= 0 && v < TETO;

export function colunasComposicaoNcg(ncg: ComposicaoNcgEntrada, adiantamentoSegregado: boolean): ColunasComposicaoNcg {
  const { cr_aberto, estoque, adiantamentos } = ncg.aco;
  const { cp_fornecedor, folha_30d, tributos_a_pagar } = ncg.pco;
  const obrigatorios = [cr_aberto, adiantamentos, cp_fornecedor, folha_30d, tributos_a_pagar];
  if (!obrigatorios.every(valido) || (estoque !== null && !valido(estoque)) || !Number.isFinite(ncg.valor)) {
    console.error("[fin-cashflow] composição da NCG fora de faixa — gravada como não medida");
    return { ...VAZIO };
  }
  const c = {
    cr: centavos(cr_aberto), est: estoque === null ? null : centavos(estoque), ad: centavos(adiantamentos),
    cp: centavos(cp_fornecedor), fo: centavos(folha_30d), tr: centavos(tributos_a_pagar),
  };
  // A faixa vale DEPOIS do arredondamento: 9999999999,999 vira 1e10 e violaria o CHECK (achado Codex P1).
  if (![c.cr, c.ad, c.cp, c.fo, c.tr].every(valido) || (c.est !== null && !valido(c.est))) {
    console.error("[fin-cashflow] composição da NCG fora de faixa após arredondar — gravada como não medida");
    return { ...VAZIO };
  }
  const soma = c.cr + (c.est ?? 0) + c.ad - c.cp - c.fo - c.tr;
  if (Math.abs(soma - ncg.valor) > NCG_TOLERANCIA_FECHAMENTO) {
    console.error("[fin-cashflow] composição da NCG não fecha com o total — gravada como não medida");
    return { ...VAZIO };
  }
  const col: ColunasComposicaoNcg = {
    ncg_cr_aberto: c.cr, ncg_estoque: c.est, ncg_adiantamentos: adiantamentoSegregado ? c.ad : null,
    ncg_cp_fornecedor: c.cp, ncg_folha_30d: c.fo, ncg_tributos_a_pagar: c.tr,
  };
  return col;
}
