// Baixa REAL derivada (v_titulo_baixas, tipo CR) numa ÚNICA leitura, via a RPC
// fin_titulo_baixas_cr_mapa (migration 20261019110100).
//
// Antes: fetchAll paginava a view com .range() — ~29 páginas para a colacor, e cada página
// reavaliava a view INTEIRA (CTE materializado sobre fin_movimentacoes, sem pushdown de
// company, ~0,65 s). Depois do backfill de 84.795 movimentos da colacor em 2026-10-13, com as
// 9 chamadas simultâneas do cron, a página estourava o statement_timeout de 8 s (57014) e o
// engine devolvia 500 em todos os cenários da colacor (2026-10-14 → 19). A RPC devolve o mesmo
// recorte (company + tipo='CR') como UM jsonb — uma avaliação, fora do cap de 1000 linhas.
//
// Fail-closed (money-path "ausente ≠ zero"): erro → FalhaLeituraCritica com o código real;
// data null, fora do envelope {total, pares}, pares.length ≠ total ou par fora de forma →
// MALFORMADA. O envelope existe porque o supabase-js converte HTTP 404 com corpo `[]` em
// {data: [], error: null} — um array cru vazio passaria por "empresa sem baixa". Nunca vira lista vazia, que
// derrubaria a cobertura da calibração em silêncio.
import { exigirLeitura, FalhaLeituraCritica, type RespostaLeitura } from "../_shared/leitura-critica.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

const FONTE_BAIXAS_CR = "fin_titulo_baixas_cr_mapa";

export type BaixaCr = { omie_codigo_lancamento: number; data_baixa_final: string };

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Valida o jsonb {total, pares: [[cod, 'YYYY-MM-DD'], …]} e devolve as linhas no formato da view. */
export function parsearMapaBaixasCr(res: RespostaLeitura<unknown>): BaixaCr[] {
  const dados = exigirLeitura(res, FONTE_BAIXAS_CR) as { total?: unknown; pares?: unknown } | null;
  if (
    dados == null || typeof dados !== "object" || Array.isArray(dados) ||
    !Array.isArray(dados.pares) || typeof dados.total !== "number" ||
    dados.pares.length !== dados.total
  ) {
    throw new FalhaLeituraCritica(FONTE_BAIXAS_CR, { code: "MALFORMADA" });
  }
  return dados.pares.map((par: unknown) => {
    if (
      !Array.isArray(par) || par.length !== 2 ||
      typeof par[0] !== "number" || !Number.isSafeInteger(par[0]) ||
      typeof par[1] !== "string" || !DATA_ISO.test(par[1])
    ) {
      throw new FalhaLeituraCritica(FONTE_BAIXAS_CR, { code: "MALFORMADA" });
    }
    return { omie_codigo_lancamento: par[0], data_baixa_final: par[1] };
  });
}

type ClienteRpc = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RespostaLeitura<unknown>>;
};

export async function carregarBaixasCr(supabase: ClienteRpc, company: string): Promise<BaixaCr[]> {
  let res: RespostaLeitura<unknown>;
  try {
    res = await supabase.rpc("fin_titulo_baixas_cr_mapa", { p_company: company });
  } catch (e) {
    // Rejeição crua chegaria ao catch do Deno.serve, que devolve `.message` no corpo (ver
    // _shared/paginate.ts): fecha em domínio, texto original só no `cause`.
    throw new FalhaLeituraCritica(FONTE_BAIXAS_CR, {
      code: "REJEITADA",
      message: mensagemDeErro(e) ?? "rejeição sem mensagem utilizável",
    });
  }
  return parsearMapaBaixasCr(res);
}
