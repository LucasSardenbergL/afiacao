// Resumo do ListarMovimentos (Omie) → colunas tipadas de fin_movimentacoes.
//
// Por que existe: o `resumo` traz o que o título rendeu de fato — nValPago (principal baixado),
// nValLiquido (o que entrou em caixa), nDesconto, nJuros, nMulta — e era lido e jogado fora. Sem
// ele não há como medir quanto da multa/juros cobrados nos boletos entra (migration
// 20261013094000, view v_titulo_encargos_cr).
//
// Contrato money-path: AUSENTE ≠ ZERO. Campo que não veio, que não é número, que não é finito ou
// que não cabe em numeric(15,2) vira `null` — nunca `?? 0`. O `0` só existe quando o Omie mandou 0.
// Valor inválido também vira null (e não lança): uma linha estranha do Omie não pode derrubar a
// página inteira do sync; quem consome a coluna degrada a confiança quando a identidade
// nValLiquido = nValPago − nDesconto + nJuros + nMulta não fecha.

export interface ResumoOmie {
  nValPago?: unknown;
  nValLiquido?: unknown;
  nDesconto?: unknown;
  nJuros?: unknown;
  nMulta?: unknown;
  nValAberto?: unknown;
  cLiquidado?: unknown;
}

export interface DetalhesOmieResumo {
  cTipo?: unknown;
  nCodBaixa?: unknown;
  nValorTitulo?: unknown;
  dDtPagamento?: unknown;
  dDtCredito?: unknown;
}

export interface ColunasResumo {
  resumo_val_pago: number | null;
  resumo_val_liquido: number | null;
  resumo_desconto: number | null;
  resumo_juros: number | null;
  resumo_multa: number | null;
  resumo_val_aberto: number | null;
  resumo_liquidado: boolean | null;
  valor_titulo: number | null;
  tipo_documento: string | null;
  omie_ncodbaixa: number | null;
  data_pagamento_omie: string | null;
  data_credito_omie: string | null;
}

// numeric(15,2): 13 dígitos inteiros. Acima disso o upsert recebe "numeric field overflow" e a
// página inteira LANÇA — melhor degradar só o campo.
const TETO_NUMERIC_15_2 = 1e13;

/**
 * Número monetário do Omie ou `null`. Só aceita `number` finito dentro do typmod da coluna — medido
 * DEPOIS do arredondamento a centavos, porque o Postgres arredonda antes de checar a precisão:
 * 9999999999999.998 vira 10000000000000.00 e estoura numeric(15,2) (achado Codex).
 */
export function valorOmie(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const centavos = Math.round(v * 100) / 100;
  if (!Number.isFinite(centavos) || Math.abs(centavos) >= TETO_NUMERIC_15_2) return null;
  return centavos;
}

/** cLiquidado "S"/"N" → boolean; qualquer outra coisa → null (não "não liquidado"). */
export function liquidadoOmie(v: unknown): boolean | null {
  if (v === "S") return true;
  if (v === "N") return false;
  return null;
}

/** Id do Omie (nCodBaixa): inteiro seguro e positivo, senão null. */
export function idOmie(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return null;
  return v;
}

/** cTipo (BOL, CHQ, PIX…) aparado; vazio/não-texto → null. */
export function tipoDocumentoOmie(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * "DD/MM/AAAA" do Omie → "AAAA-MM-DD", só se for data de CALENDÁRIO válida; senão null.
 * Estrito de propósito: o `parseOmieDate` legado aceita "45/13/2026" e devolve "2026-13-45", que o
 * Postgres recusa no upsert — a página inteira lançaria por um campo.
 */
export function dataOmie(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim());
  if (!m) return null;
  const [, dd, mm, aaaa] = m;
  const dia = Number(dd), mes = Number(mm), ano = Number(aaaa);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  return `${aaaa}-${mm}-${dd}`;
}

export function colunasResumo(
  resumo: ResumoOmie | null | undefined,
  detalhes: DetalhesOmieResumo | null | undefined,
): ColunasResumo {
  const r = resumo ?? {};
  const d = detalhes ?? {};
  return {
    resumo_val_pago: valorOmie(r.nValPago),
    resumo_val_liquido: valorOmie(r.nValLiquido),
    resumo_desconto: valorOmie(r.nDesconto),
    resumo_juros: valorOmie(r.nJuros),
    resumo_multa: valorOmie(r.nMulta),
    resumo_val_aberto: valorOmie(r.nValAberto),
    resumo_liquidado: liquidadoOmie(r.cLiquidado),
    valor_titulo: valorOmie(d.nValorTitulo),
    tipo_documento: tipoDocumentoOmie(d.cTipo),
    omie_ncodbaixa: idOmie(d.nCodBaixa),
    // Ótica do TÍTULO: dDtPagamento é a data da BAIXA (o que decide atraso). Ótica CC: dDtCredito
    // é a liquidação bancária, próximo dia útil (v_titulo_baixas_otica_canonica, 2026-09-09).
    data_pagamento_omie: dataOmie(d.dDtPagamento),
    data_credito_omie: dataOmie(d.dDtCredito),
  };
}
