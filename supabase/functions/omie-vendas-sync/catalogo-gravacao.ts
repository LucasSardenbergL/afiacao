// Gravação por página do catálogo (`sync_products` → `omie_products`) e o DESFECHO da action.
//
// Defeito que isto fecha (N2, plano v4 lote 6): o upsert de uma página que falhava só fazia
// `console.error`, o loop avançava, o run terminava `complete` e a action respondia
// `success: true` com HTTP 200 — e o `fin_sync_log` gravava 'complete'. `omie_products` guarda
// PREÇO (`valor_unitario`) e o `updated_at` é frescor no `_data_health_compute`: falha de
// gravação virava "sincronizei", e o sensor de frescor seguia verde se outra página gravou.
//
// Agora: a falha é CONTADA (páginas + linhas) e o run com qualquer linha não gravada NÃO é
// sucesso — HTTP 500 + `success: false`. Por que 500 e não 200 com `success: false`: os dois
// consumidores do front (SalesProducts e useProductCatalog) só enxergam falha por
// `res.error`, que o supabase-js só põe em HTTP não-2xx; um 200 viraria toast de sucesso.
//
// O caminho feliz é byte-idêntico ao de antes: mesmo payload, mesmo `onConflict`, mesmo corpo
// `{ success: true, ...resultado }`.
//
// Separado do index.ts para ser testável no Deno sem o resto da edge (catalogo-gravacao_test.ts).

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

/** O subconjunto do SupabaseClient que este módulo usa — facilita o duplo de teste. */
export interface ClienteUpsert {
  from(tabela: string): {
    upsert(
      linhas: Record<string, unknown>[],
      opcoes: { onConflict: string },
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}

/** Acumulador das falhas de gravação de um run — mutado por `gravarPaginaCatalogo`. */
export interface FalhasCatalogo {
  paginas: number[];
  linhas: number;
  primeiraMensagem: string | null;
}

export function novasFalhasCatalogo(): FalhasCatalogo {
  return { paginas: [], linhas: 0, primeiraMensagem: null };
}

/** Marca ASCII estável do ramo de falha — o teste e o operador casam por ela. */
export const MARCA_FALHA_GRAVACAO = "FALHA_GRAVACAO_CATALOGO";

/**
 * Upsert de uma página do catálogo. Devolve quantas linhas GRAVOU (0 em falha) e o erro da
 * página, e registra a falha em `falhas` — nunca a engole.
 */
export async function gravarPaginaCatalogo(
  db: ClienteUpsert,
  linhas: Record<string, unknown>[],
  pagina: number,
  falhas: FalhasCatalogo,
): Promise<{ gravadas: number; erro: string | null }> {
  if (linhas.length === 0) return { gravadas: 0, erro: null };
  const { error } = await db.from("omie_products").upsert(linhas, { onConflict: "omie_codigo_produto,account" });
  if (error) {
    falhas.paginas.push(pagina);
    falhas.linhas += linhas.length;
    falhas.primeiraMensagem ??= error.message;
    return { gravadas: 0, erro: error.message };
  }
  return { gravadas: linhas.length, erro: null };
}

function resumoFalhas(falhas: FalhasCatalogo): string {
  return `${MARCA_FALHA_GRAVACAO}: ${falhas.linhas} linha(s) em ${falhas.paginas.length} pagina(s) `
    + `[${falhas.paginas.join(",")}] nao gravada(s) em omie_products: ${falhas.primeiraMensagem ?? "erro sem mensagem"}`;
}

/**
 * Exceção que interrompe o run (Omie transitório, página anômala) DEPOIS de uma falha de
 * gravação: o catch global da edge grava só a mensagem no `fin_sync_log` — sem isto, a contagem
 * das linhas não gravadas sumia atrás do erro do Omie. Sem falha acumulada, devolve o MESMO erro.
 */
export function erroComFalhasAcumuladas(erro: unknown, falhas: FalhasCatalogo): unknown {
  if (falhas.paginas.length === 0) return erro;
  const mensagem = mensagemDeErro(erro) ?? "erro sem mensagem";
  return new Error(`${resumoFalhas(falhas)} — e o run abortou depois: ${mensagem}`);
}

/** O que `syncProducts` devolve (forma de antes, sem as falhas). */
export interface ResultadoSyncProdutos {
  totalSynced: number;
  totalPaginas: number;
  lastPage: number;
  nextPage: number | null;
  complete: boolean;
}

export type DesfechoSyncProdutos =
  | { ok: true; status: 200; corpo: Record<string, unknown> }
  | { ok: false; status: 500; erro: string; corpo: Record<string, unknown> };

/**
 * Decide a resposta da action `sync_products`. Sem falha: o corpo de sempre. Com falha: 500,
 * `success: false`, `complete: false` e `nextPage` na PRIMEIRA página que falhou — retomar dali
 * refaz a falha e as seguintes (o upsert é idempotente), em vez de o cursor pular a página.
 */
export function desfechoSyncProdutos(
  resultado: ResultadoSyncProdutos,
  falhas: FalhasCatalogo,
): DesfechoSyncProdutos {
  if (falhas.paginas.length === 0) {
    return { ok: true, status: 200, corpo: { success: true, ...resultado } };
  }
  const primeiraFalha = Math.min(...falhas.paginas);
  const erro = resumoFalhas(falhas);
  return {
    ok: false,
    status: 500,
    erro,
    corpo: {
      success: false,
      error: erro,
      ...resultado,
      complete: false,
      nextPage: primeiraFalha,
      paginasFalhas: [...falhas.paginas],
      linhasFalhas: falhas.linhas,
    },
  };
}

/**
 * Fronteira da action: com falha, FINALIZA o log como erro (`finalizarLog` com a mensagem —
 * vira `fin_sync_log.status='error'`) antes de devolver o 500, para o epílogo da edge não
 * fechá-lo como 'complete'. Sem falha, não finaliza: o epílogo comum das actions de sync fecha.
 */
export async function concluirSyncProdutos(
  resultado: ResultadoSyncProdutos,
  falhas: FalhasCatalogo,
  finalizarLog: (corpo: Record<string, unknown>, erro: string) => Promise<void>,
): Promise<{ status: 200 | 500; corpo: Record<string, unknown> }> {
  const desfecho = desfechoSyncProdutos(resultado, falhas);
  if (!desfecho.ok) await finalizarLog(desfecho.corpo, desfecho.erro);
  return { status: desfecho.status, corpo: desfecho.corpo };
}
