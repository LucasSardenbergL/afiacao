// staging-rows.ts — builders PUROS payload→linhas de staging do handler /formulas.
// Extraído do index.ts na FASE 1d para o contrato ser testável com `deno test
// --no-remote` (sem supabase-js/serve). O index.ts importa daqui; NÃO adicionar
// imports remotos neste arquivo.
//
// Invariantes de contrato (money-path — cada uma tem teste em staging-rows_test.ts):
//   · expected_item_count = f.itens.length quando `itens` é ARRAY (conta TODAS as
//     linhas, inclusive as inválidas que o conector 1d passou a preservar);
//     AUSÊNCIA de `itens` NUNCA vira 0 — grava null (protocolo ambíguo, o banco
//     barra fail-closed). Codex P1 da Fase 1c.
//   · is_base_pura: só o literal true entra; qualquer outra coisa (string "true",
//     1, undefined) vira null — sinal semântico não se infere, se declara.
//   · id do header PRÉ-GERADO aqui (associação header→itens não depende da ordem
//     de retorno do insert). Codex P2 da Fase 1c.
//   · item: id_corante ausente vira '' PRESERVANDO a dose (órfão é corrupção que
//     o Guard 4b do banco barra); qtd_ml é pass-through (null preservado — o
//     banco decide, nunca fabricar 0).

/** Item bruto enviado pelo agente (fórmulas e preparações) */
export interface TintFormulaItem {
  id_corante?: string;
  ordem?: number;
  qtd_ml?: number | null;
}

/** Fórmula bruta enviada pelo agente */
export interface TintFormulaPayload {
  cor_id?: string;
  nome_cor?: string;
  cod_produto?: string;
  id_base?: string;
  id_embalagem?: string;
  subcolecao?: string | null;
  volume_final_ml?: number;
  preco_final?: number;
  personalizada?: boolean;
  itens?: TintFormulaItem[];
  is_base_pura?: boolean;
}

/** Linha de tint_staging_formulas para UMA fórmula válida (id pré-gerado). */
export function montarStagingFormulaRow(
  f: TintFormulaPayload,
  runId: string,
  account: string,
  storeCode: string,
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    sync_run_id: runId,
    account,
    store_code: storeCode,
    cor_id: f.cor_id,
    nome_cor: f.nome_cor,
    cod_produto: f.cod_produto,
    id_base: f.id_base,
    id_embalagem: f.id_embalagem,
    subcolecao: f.subcolecao || null,
    volume_final_ml: f.volume_final_ml,
    preco_final: f.preco_final,
    personalizada: f.personalizada || false,
    raw_data: f,
    staging_status: "pending",
    // Fase 1c — protocolo de staging como UNIDADE: declara quantas linhas de item a edge
    // RECEBEU e vai inserir p/ este header. A promoção só aceita a fórmula quando o COUNT
    // bruto ingerido bate. `itens` AUSENTE nunca vira 0 — NULL barra fail-closed.
    expected_item_count: Array.isArray(f.itens) ? f.itens.length : null,
    // Fase 1d — sinal SEMÂNTICO da fonte: true = o conector CONFIRMOU fórmula sem corante.
    // Só o literal true entra; com a tríade (true + expected=0 + COUNT=0) a promoção aceita
    // a fórmula vazia (transição legítima p/ base pura limpa a receita). Nunca inferir.
    is_base_pura: f.is_base_pura === true ? true : null,
  };
}

/** Linhas de tint_staging_formula_itens de uma fórmula já inserida (id conhecido). */
export function montarStagingItemRows(
  f: TintFormulaPayload,
  formulaId: string,
  runId: string,
): Record<string, unknown>[] {
  const itens: TintFormulaItem[] = f.itens || [];
  return itens.map((item) => ({
    sync_run_id: runId,
    staging_formula_id: formulaId,
    // ID ausente vira '' PRESERVANDO a dose — o órfão é corrupção que o Guard 4b barra;
    // omitir a linha perderia um componente da receita (C17).
    id_corante: item.id_corante || "",
    ordem: item.ordem,
    // Pass-through: null/0/negativo preservados — validade é papel dos guards do banco.
    qtd_ml: item.qtd_ml,
  }));
}
