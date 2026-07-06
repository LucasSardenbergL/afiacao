// Layout das colunas do CSV de fórmulas do Sayersystem (import tintométrico).
// Fonte única do mapeamento de índices, compartilhada pelo PREFLIGHT e pelos
// processadores (hook direto, RPC, edge) — para o preflight validar EXATAMENTE
// as mesmas células que a escrita consome (senão os dois divergem: o preflight
// aprova uma coluna e a escrita lê outra). Achado Codex 2026-07-05 [P1#4].
//
// Layout (o `offset` desloca as fórmulas padrão, que têm 2 colunas de subcoleção
// a mais que as personalizadas):
//   cols[0]=id_seq [1]=cor_id [2]=nome_cor [3]=id_base [4]=base [5]=id_embalagem
//   [6]=embalagem [7]=cod_produto [8]=produto
//   (padrão: [9]=subcolecao [10]=sub_colecao)
//   corantes:   coranteStart .. coranteStart+5   (coranteStart = 9 + offset)
//   qtd (ml):   qtdStart     .. qtdStart+5       (qtdStart = coranteStart + 6)
//   volume_final_ml = qtdStart + 6
//   preco_final     = qtdStart + 7
//   data_geracao    = qtdStart + 8

export interface FormulaColumnLayout {
  /** Índices das 6 colunas de corante (id do corante). */
  corante: readonly [number, number, number, number, number, number];
  /** Índices das 6 colunas de quantidade (ml) — pareadas 1:1 com `corante`. */
  qtd: readonly [number, number, number, number, number, number];
  /** Índice da coluna volume_final_ml. */
  volumeFinal: number;
  /** Índice da coluna preço final (Sayersystem). */
  precoFinal: number;
  /** Índice da coluna data de geração. */
  dataGeracao: number;
}

export function formulaColumnLayout(personalizada: boolean): FormulaColumnLayout {
  const offset = personalizada ? 0 : 2;
  const coranteStart = 9 + offset;
  const qtdStart = coranteStart + 6;
  const six = (start: number) =>
    [start, start + 1, start + 2, start + 3, start + 4, start + 5] as const;
  return {
    corante: six(coranteStart),
    qtd: six(qtdStart),
    volumeFinal: qtdStart + 6,
    precoFinal: qtdStart + 7,
    dataGeracao: qtdStart + 8,
  };
}
