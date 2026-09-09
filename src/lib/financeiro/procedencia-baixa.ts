/**
 * Procedência das colunas de BAIXA do financeiro — `valor_pago` (CP), `valor_recebido` (CR) e o
 * `saldo` que o banco GERA a partir delas (`valor_documento - COALESCE(valor_pago, 0)`).
 *
 * ⚠️ POR QUE EXISTE (issue #396 · PR #2409): o endpoint LIST do Omie
 * (`financas/conta{pagar,receber}/ListarContas…`) NÃO devolve a baixa — a sub-tag `pagamento` só
 * aparece nos métodos de escrita, e `valor_pag` é *a pagar* (saldo), não *pago*. O sync grava as
 * colunas no default 0 e o banco leva o 0 adiante. Medido em prod (psql-ro, 2026-09-09):
 * **16.125/16.125 CP e 44.524/44.524 CR com baixa = 0** — inclusive os R$ 27,8M de títulos com
 * status RECEBIDO e os R$ 28,9M com status PAGO. O `saldo` herda o defeito: com o subtraendo
 * sempre 0, `saldo == valor_documento` até para título liquidado.
 *
 * Somar essas colunas não devolve "zero": devolve um número FABRICADO com aparência de fato. É o
 * `ausente ≠ zero` de `docs/agent/money-path.md` um andar acima do `|| 0` — a fabricação nasce no
 * ingest e a agregação apenas a reveste da autoridade de um total.
 *
 * ⚠️ O GATILHO É A FONTE, NUNCA O VALOR. Degradar por `soma === 0` inverteria a mentira: um mês em
 * que nada foi recebido é um FATO, e escondê-lo atrás de "—" mentiria no outro sentido. Por isso a
 * decisão mora numa declaração sobre DE ONDE a coluna veio, e não numa inspeção do que ela vale.
 *
 * O guard por STATUS (`titulo-status.ts`) é irmão, não substituto: ele protege quem soma `saldo`
 * filtrando status; aqui o consumidor exibe a coluna crua, e nenhum filtro de status a conserta.
 *
 * Quando a ingestão existir — a rota `mf`/movimentações já traz a baixa e hoje a descarta, ver
 * `docs/historico/valor-pag-nao-e-valor-pago-e-a-baixa-ja-chega-em-mf.md` — o conserto é declarar
 * a nova procedência no consumidor; nenhuma outra linha muda.
 */

export interface ProcedenciaBaixa {
  /** De onde a coluna de baixa veio. Para o leitor do código — não é texto de UI. */
  readonly fonte: string;
  /** `false` = a fonte não ingere a baixa; toda soma dela é 0 POR CONSTRUÇÃO, não por medição. */
  readonly ingereBaixa: boolean;
  /** Texto exibível quando `ingereBaixa` é `false`; `null` quando o dado é confiável. */
  readonly motivo: string | null;
}

/** Motivo exibido ao usuário. Sem vírgula: vai para célula/cabeçalho de CSV sem quebrar a coluna. */
export const MOTIVO_BAIXA_NAO_INGERIDA =
  'valores de pagamento e saldo indisponíveis nesta fonte';

/**
 * O que as matviews `fin_analise_c{r,p}_dimensoes` agregam hoje: `fin_contas_{pagar,receber}`,
 * alimentadas pelo LIST do Omie — sem baixa.
 */
export const BAIXA_OMIE_LIST: ProcedenciaBaixa = {
  fonte: 'omie/ListarContas{Pagar,Receber} → fin_contas_{pagar,receber}',
  ingereBaixa: false,
  motivo: MOTIVO_BAIXA_NAO_INGERIDA,
};

/**
 * Soma de uma coluna de baixa (ou do saldo derivado dela): o número quando a fonte ingere a baixa
 * — INCLUSIVE `0`, que aí é um fato medido — e `null` quando não ingere.
 */
export function baixaOuIndisponivel(
  soma: number,
  procedencia: ProcedenciaBaixa,
): number | null {
  return procedencia.ingereBaixa ? soma : null;
}
