/**
 * Import de clientes NO SERVIDOR — regras puras, sem I/O (migration 20261101200000_clientes_import_servidor).
 *
 * POR QUE EXISTE (2026-11-01): o "Importar Clientes (3 Contas Omie)" era um laço no navegador com o
 * cursor só na memória da aba; no mesmo dia morreu 3 vezes no meio (preview recarregou, falha de rede)
 * e cada clique recomeçava da página 1. Agora o cursor mora em `clientes_import_rodada` e o cron de
 * 1 min chama a ação `continuar_import_clientes`, que reaproveita o MESMO bloco do `sync_all_clients`.
 *
 * O que fica aqui é a tradução entre o cursor PERSISTIDO (slug da conta) e o contrato do bloco
 * (account_index), e a leitura fail-closed do que o bloco devolve.
 */

/** Cursor como o lease o entrega (`clientes_import_lease_acquire`). */
export interface CursorRodada {
  rodada_id: string;
  lease_token: string;
  conta_slug: string | null;
  start_page: number;
  total_paginas: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * NULL = nenhuma rodada para esta invocação (sem rodada aberta, lease de outro worker, ou terminal).
 * Qualquer outra forma fora do contrato LANÇA: tratar lixo como "sem rodada" esconderia uma rodada
 * travada; tratá-lo como cursor processaria a conta errada.
 */
export function interpretarAcquire(data: unknown): CursorRodada | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`clientes_import_lease_acquire fora do contrato: ${JSON.stringify(data)?.slice(0, 120)}`);
  }
  const d = data as Record<string, unknown>;
  const pagina = Number(d.start_page);
  const teto = Number(d.total_paginas);
  if (
    typeof d.rodada_id !== "string" || !UUID.test(d.rodada_id) ||
    typeof d.lease_token !== "string" || !UUID.test(d.lease_token) ||
    !(d.conta_slug === null || typeof d.conta_slug === "string") ||
    !Number.isInteger(pagina) || pagina < 1 || !Number.isInteger(teto) || teto < 0
  ) {
    throw new Error(`clientes_import_lease_acquire fora do contrato: ${JSON.stringify(d).slice(0, 200)}`);
  }
  return {
    rodada_id: d.rodada_id,
    lease_token: d.lease_token,
    conta_slug: d.conta_slug as string | null,
    start_page: pagina,
    total_paginas: teto,
  };
}

/**
 * De slug persistido para o índice da lista de contas COM credencial desta invocação.
 * `ordem` é a ordem fixa de varredura (CONTAS_ESPERADAS). Se a conta do cursor perdeu a credencial,
 * a varredura segue para a próxima da ordem fixa — e a página volta a 1 (a página e o teto eram DELA).
 * Índice igual a `disponiveis.length` = nada mais a varrer (o bloco devolve `done`).
 */
export function resolverConta(
  slug: string | null,
  disponiveis: readonly string[],
  ordem: readonly string[],
): { indice: number; mesmaConta: boolean } {
  if (slug === null) return { indice: 0, mesmaConta: true };
  const direto = disponiveis.indexOf(slug);
  if (direto >= 0) return { indice: direto, mesmaConta: true };
  const posicao = ordem.indexOf(slug);
  if (posicao < 0) throw new Error(`conta do cursor desconhecida: ${slug}`);
  for (let i = 0; i < disponiveis.length; i++) {
    if (ordem.indexOf(disponiveis[i]) > posicao) return { indice: i, mesmaConta: false };
  }
  return { indice: disponiveis.length, mesmaConta: false };
}

/** O que a RPC `clientes_import_avancar` recebe. */
export interface AvancoRodada {
  conta_slug: string | null;
  start_page: number;
  total_paginas: number;
  importados: number;
  pulados: number;
  erros: number;
  telefones_repostos: number;
  falha: Record<string, unknown> | null;
  contas_sem_credencial: unknown[];
  concluida: boolean;
}

function contador(v: unknown, nome: string): number {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`resultado do lote com ${nome} inválido: ${String(v)}`);
  return n;
}

/**
 * Lê o resultado do bloco `sync_all_clients` e decide o próximo cursor. Fim SÓ com o contrato
 * validado: `done === true` ou `hasMore === false` (achado Codex P1 — "não sei" nunca é "acabou").
 */
export function planejarAvanco(resultado: Record<string, unknown>, disponiveis: readonly string[]): AvancoRodada {
  const semCredencial = Array.isArray(resultado.contas_sem_credencial) ? resultado.contas_sem_credencial : [];
  if (resultado.done === true) {
    return {
      conta_slug: null, start_page: 1, total_paginas: 0,
      importados: 0, pulados: 0, erros: 0, telefones_repostos: 0,
      falha: null, contas_sem_credencial: semCredencial, concluida: true,
    };
  }
  if (typeof resultado.hasMore !== "boolean") {
    throw new Error("resultado do lote sem hasMore booleano — malformado, não é fim");
  }
  const deltas = {
    importados: contador(resultado.imported, "imported"),
    pulados: contador(resultado.skipped, "skipped"),
    erros: contador(resultado.errors, "errors"),
    telefones_repostos: contador(resultado.telefones_repostos, "telefones_repostos"),
  };
  const falha = resultado.falha && typeof resultado.falha === "object" && !Array.isArray(resultado.falha)
    ? resultado.falha as Record<string, unknown>
    : null;
  if (!resultado.hasMore) {
    return { conta_slug: null, start_page: 1, total_paginas: 0, ...deltas, falha, contas_sem_credencial: semCredencial, concluida: true };
  }
  const next = resultado.next as Record<string, unknown> | undefined;
  const indice = Number(next?.account_index);
  const pagina = Number(next?.start_page);
  const teto = Number(next?.total_paginas ?? 0);
  if (!Number.isInteger(indice) || indice < 0 || !Number.isInteger(pagina) || pagina < 1 || !Number.isInteger(teto) || teto < 0) {
    throw new Error(`resultado do lote com next inválido: ${JSON.stringify(next)?.slice(0, 120)}`);
  }
  if (indice >= disponiveis.length) {
    // hasMore=true apontando além da última conta: contrato quebrado — o bloco devolve hasMore=false nesse caso.
    throw new Error(`resultado do lote com hasMore e next além da última conta (${indice}/${disponiveis.length})`);
  }
  return {
    conta_slug: disponiveis[indice], start_page: pagina, total_paginas: teto,
    ...deltas, falha, contas_sem_credencial: semCredencial, concluida: false,
  };
}

/** Teto de páginas por lote no servidor: quem limita de verdade é o orçamento de tempo (orcamento.ts). */
export const MAX_PAGINAS_LOTE_SERVIDOR = 40;
