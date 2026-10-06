// As candidatas ao casamento de frete: as linhas do rastreio que um CT-e pode receber. Separado do
// index.ts para ser testado no runtime real (candidatas_test.ts, Deno `--no-remote`): o index.ts
// importa `npm:@supabase/supabase-js@2` e nunca roda sob `--no-remote`.
//
// ── Por que a linha modelo 57 sai daqui (parte B, 2026-10-05) ────────────────────────────────
// O `omie-sync-nfes-recebidas` gravava o CT-e no rastreio como linha órfã, igual a uma NF-e, e a
// janela de candidatas o aceitava: mesmo fornecedor, chave não nula, `t3_data_cte` nulo e t2 dentro
// de [emissão − 3 dias, emissão]. A linha do PRÓPRIO CT-e satisfaz tudo isso, com t2 = emissão —
// no CONECT (só data) ela vencia sempre. Medido (psql-ro, OBEN): 13 dos 82 vínculos em linha 57
// (11 na própria, 2 em outro CT-e). Parar a fonte não basta: as 135 linhas 57 antigas continuam no
// rastreio, e um run com `dias` largo as alcança. A decisão é a mesma da fonte e da fila do leadtime
// (`_shared/modelo-documento-fiscal.ts`): DENYLIST do 57 legível; chave ilegível segue candidata.
import { ehCte } from "../_shared/modelo-documento-fiscal.ts";
import { exigirLeitura } from "../_shared/leitura-critica.ts";

/** A linha do rastreio, como o casamento a enxerga. */
export interface NFeCandidata {
  id: string;
  numero_pedido: string | null;
  t2_data_faturamento: string;
  valor_nfe: number;
}

interface LinhaCandidata {
  id: string;
  numero_pedido: string | null;
  t2_data_faturamento: string;
  nfe_chave_acesso: string | null;
  raw_data: { cabec?: { nValorNFe?: number } } | null;
}

/** O pedaço do cliente PostgREST que esta leitura usa. Estrutural: o teste passa um double. */
export interface ConsultaCandidatas
  extends PromiseLike<{ data: unknown[] | null; error: { message?: string | null; code?: string | null } | null }> {
  select(colunas: string): ConsultaCandidatas;
  eq(coluna: string, valor: unknown): ConsultaCandidatas;
  not(coluna: string, operador: string, valor: unknown): ConsultaCandidatas;
  is(coluna: string, valor: unknown): ConsultaCandidatas;
  gte(coluna: string, valor: unknown): ConsultaCandidatas;
  lte(coluna: string, valor: unknown): ConsultaCandidatas;
  order(coluna: string, opts?: { ascending?: boolean }): ConsultaCandidatas;
}

export interface BancoCandidatas {
  from(tabela: string): ConsultaCandidatas;
}

/**
 * As linhas que podem receber este CT-e, na ordem da consulta (t2 decrescente), sem as linhas
 * modelo 57. `ctesExcluidas` é quantas linhas 57 a janela trazia e saíram — o caller o soma no
 * resumo do run, para a defesa ficar VISÍVEL enquanto houver linha 57 antiga ao alcance.
 *
 * Falha de leitura LANÇA (`FalhaLeituraCritica`): "não consegui ler a janela" não é "não havia
 * NF-e na janela". Antes ela virava `[]`, o CT-e era contado como órfão e o run seguia sem erro;
 * agora o try/catch do item conta `erros` e nada é gravado.
 */
export async function buscarCandidatas(
  db: BancoCandidatas,
  empresa: string,
  fornecedorCodigo: number,
  dataEmissaoCte: Date,
): Promise<{ candidatas: NFeCandidata[]; ctesExcluidas: number }> {
  const dataFim = dataEmissaoCte;
  const dataInicio = new Date(dataFim.getTime() - 3 * 24 * 60 * 60 * 1000);

  const resposta = await db
    .from("purchase_orders_tracking")
    .select("id, numero_pedido, t2_data_faturamento, raw_data, nfe_chave_acesso")
    .eq("empresa", empresa)
    .eq("fornecedor_codigo_omie", fornecedorCodigo)
    .not("nfe_chave_acesso", "is", null)
    .is("t3_data_cte", null)
    .gte("t2_data_faturamento", dataInicio.toISOString())
    .lte("t2_data_faturamento", dataFim.toISOString())
    .order("t2_data_faturamento", { ascending: false });

  const linhas = (exigirLeitura(resposta, "purchase_orders_tracking (candidatas ao frete)") ?? []) as LinhaCandidata[];
  const naoCte = linhas.filter((linha) => !ehCte(linha.nfe_chave_acesso));
  return {
    candidatas: naoCte.map((row) => ({
      id: row.id,
      numero_pedido: row.numero_pedido,
      t2_data_faturamento: row.t2_data_faturamento,
      valor_nfe: Number(row?.raw_data?.cabec?.nValorNFe ?? 0),
    })),
    ctesExcluidas: linhas.length - naoCte.length,
  };
}
