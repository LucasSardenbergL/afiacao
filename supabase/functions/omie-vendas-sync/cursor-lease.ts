// Cursor + lease CERCADO do backfill de pedidos (tabela vendas_sync_cursor).
//
// Espelha o state-machine SQL de 20260617133633 + o fencing de 20261015221600:
// o acquire emite um `lease_token` NOVO a cada tomada (inclusive no roubo de lease morto) e
// heartbeat/finish/release só agem com o token igual — o BANCO recusa o worker que perdeu o
// lease (o "zumbi" que ficou >3 min sem heartbeat e acordou depois de outro tomar a janela).
// Antes, essas três RPCs filtravam só pela PK e o zumbi rebobinava o next_page do sucessor,
// soltava o lease dele no meio do run ou fechava a janela com o estado errado.
//
// Separado do index.ts para ser testável no Deno sem o resto da edge (cursor-lease_test.ts).
// Os nomes de RPC ficam LITERAIS: o pré-flight de deploy (`scripts/lib/edge-rpcs.ts`) os extrai
// do fecho de imports para conferir que existem em prod antes da colagem.
// O lease atômico tem que ser RPC: `.or()` em UPDATE do PostgREST quebra (42703, CLAUDE.md).

/** O subconjunto do SupabaseClient que este módulo usa — facilita o duplo de teste. */
export interface ClienteRpc {
  rpc(
    nome: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface LeaseCursor {
  resumePage: number;
  leaseToken: string;
}

/**
 * Desfecho de uma operação cercada:
 *  - `dono`    — o banco confirmou que este worker ainda segura o lease (e aplicou);
 *  - `perdido` — o banco RECUSOU: outro worker tomou o lease, ou a janela foi liberada/fechada;
 *  - `erro`    — não deu para saber (erro de RPC/rede, ou resposta fora do contrato).
 * `erro` ≠ `perdido`: só `perdido` é prova de que outro worker manda agora.
 */
export type DesfechoCercado = "dono" | "perdido" | "erro";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Interpreta a resposta de `vendas_sync_lease_acquire_fenced`. Fail-closed: qualquer coisa fora
 * do contrato `{resume_page: inteiro ≥ 1, lease_token: uuid}` vira `null` (sem lease ⇒ no-op),
 * nunca um lease com token inventado — rodar sem token válido seria rodar sem cerca.
 */
export function interpretarAcquire(data: unknown): LeaseCursor | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const { resume_page, lease_token } = data as Record<string, unknown>;
  if (typeof resume_page !== "number" || !Number.isInteger(resume_page) || resume_page < 1) return null;
  if (typeof lease_token !== "string" || !UUID.test(lease_token)) return null;
  return { resumePage: resume_page, leaseToken: lease_token };
}

/** Lê o boolean "eu ainda era o dono" das RPCs cercadas. Fora do contrato ⇒ `erro`. */
export function interpretarCercado(data: unknown, error: { message: string } | null): DesfechoCercado {
  if (error) return "erro";
  if (data === true) return "dono";
  if (data === false) return "perdido";
  return "erro";
}

/**
 * Toma o lease ATOMICAMENTE. `null` = não conseguiu (outra invocação viva / janela completa /
 * inexistente / RPC ausente) ⇒ o caller sai no-op. Degradação segura: sem a migration
 * 20261015221600 aplicada, a RPC não existe e o backfill fica parado (não roda sem cerca).
 */
export async function acquireVendasLease(
  db: ClienteRpc, account: string, dfIso: string, dtIso: string,
): Promise<LeaseCursor | null> {
  const { data, error } = await db.rpc("vendas_sync_lease_acquire_fenced", {
    p_account: account, p_date_from: dfIso, p_date_to: dtIso,
  });
  if (error) {
    console.error(`[sync_pedidos][${account}] lease_acquire falhou (no-op):`, error.message);
    return null;
  }
  const lease = interpretarAcquire(data);
  if (data !== null && lease === null) {
    console.error(`[sync_pedidos][${account}] lease_acquire devolveu fora do contrato (no-op):`, JSON.stringify(data));
  }
  return lease;
}

/**
 * Renova o lease E persiste o progresso (next_page := página EM CURSO) — crash retoma daqui.
 * `perdido` ⇒ o caller PARA o laço (outro worker manda na janela). `erro` segue best-effort
 * (como antes): uma falha transitória de heartbeat não derruba o sync, e o finish é cercado.
 */
export async function heartbeatVendasCursor(
  db: ClienteRpc, account: string, dfIso: string, dtIso: string, lease: LeaseCursor, page: number,
): Promise<DesfechoCercado> {
  const { data, error } = await db.rpc("vendas_sync_heartbeat_fenced", {
    p_account: account, p_date_from: dfIso, p_date_to: dtIso, p_lease_token: lease.leaseToken, p_page: page,
  });
  const desfecho = interpretarCercado(data, error);
  if (desfecho === "erro") {
    console.warn(`[sync_pedidos][${account}] heartbeat sem confirmacao (segue):`, error?.message ?? JSON.stringify(data));
  } else if (desfecho === "perdido") {
    console.warn(`[sync_pedidos][${account}] lease PERDIDO na pagina ${page} — outro worker tomou a janela; parando`);
  }
  return desfecho;
}

/** Encerra e LIBERA o lease. complete=true fecha completed_at (fim real); false pausa no nextPage. */
export async function finishVendasCursor(
  db: ClienteRpc, account: string, dfIso: string, dtIso: string, lease: LeaseCursor,
  complete: boolean, nextPage: number | null, lastErrorKind: string | null,
): Promise<DesfechoCercado> {
  const { data, error } = await db.rpc("vendas_sync_finish_fenced", {
    p_account: account, p_date_from: dfIso, p_date_to: dtIso, p_lease_token: lease.leaseToken,
    p_complete: complete,
    p_next_page: complete ? null : nextPage,
    p_last_error_kind: complete ? null : lastErrorKind,
  });
  const desfecho = interpretarCercado(data, error);
  if (desfecho === "erro") console.error(`[sync_pedidos][${account}] finish falhou:`, error?.message ?? JSON.stringify(data));
  if (desfecho === "perdido") console.warn(`[sync_pedidos][${account}] finish RECUSADO — o lease ja era de outro worker`);
  return desfecho;
}

/** LIBERA o lease preservando o next_page (erro inesperado escapado do syncPedidos). */
export async function releaseVendasCursor(
  db: ClienteRpc, account: string, dfIso: string, dtIso: string, lease: LeaseCursor, lastErrorKind: string,
): Promise<DesfechoCercado> {
  const { data, error } = await db.rpc("vendas_sync_release_fenced", {
    p_account: account, p_date_from: dfIso, p_date_to: dtIso, p_lease_token: lease.leaseToken,
    p_last_error_kind: lastErrorKind,
  });
  const desfecho = interpretarCercado(data, error);
  if (desfecho === "erro") console.error(`[sync_pedidos][${account}] release falhou:`, error?.message ?? JSON.stringify(data));
  if (desfecho === "perdido") console.warn(`[sync_pedidos][${account}] release RECUSADO — o lease ja era de outro worker`);
  return desfecho;
}

// ─── Falha honesta (migration 20261015221700) ───────────────────────────────────────────────
// criar_pedidos_com_itens devolve em `failed[]` os pedidos que NÃO gravou (subtransação desfeita —
// o pedido não existe no banco depois). Antes isso só virava log e a janela fechava "completa" com
// pedido perdido. Agora cada página registra os seus falhos na janela; o finish cercado só completa
// sem falhos (1ª vez re-arma a janela sozinho; 2ª vez vira terminal com a lista, para o staff ver).

export interface PedidoFalho {
  codigo_pedido: number | string | null;
  hash: string | null;
  sqlstate: string | null;
  erro: string | null;
  pagina: number;
}

const MAX_ERRO = 200;

/** Normaliza o `failed[]` da RPC para o que a janela guarda (só o necessário, mensagem truncada). */
export function falhasDaPagina(fails: unknown[], pagina: number): PedidoFalho[] {
  return fails.map((f) => {
    const o = (f !== null && typeof f === "object" ? f : {}) as Record<string, unknown>;
    const codigo = o.codigo_pedido;
    return {
      codigo_pedido: typeof codigo === "number" || typeof codigo === "string" ? codigo : null,
      hash: typeof o.hash === "string" ? o.hash : null,
      sqlstate: typeof o.sqlstate === "string" ? o.sqlstate : null,
      erro: typeof o.erro === "string" ? o.erro.slice(0, MAX_ERRO) : null,
      pagina,
    };
  });
}

/** Registra os falhos da página na janela, SÓ se este worker ainda for o dono do lease. */
export async function registrarFalhasVendasCursor(
  db: ClienteRpc, account: string, dfIso: string, dtIso: string, lease: LeaseCursor, falhas: PedidoFalho[],
): Promise<DesfechoCercado> {
  const { data, error } = await db.rpc("vendas_sync_registrar_falhas_fenced", {
    p_account: account, p_date_from: dfIso, p_date_to: dtIso, p_lease_token: lease.leaseToken, p_falhas: falhas,
  });
  const desfecho = interpretarCercado(data, error);
  if (desfecho === "erro") console.error(`[sync_pedidos][${account}] registrar falhos falhou:`, error?.message ?? JSON.stringify(data));
  if (desfecho === "perdido") console.warn(`[sync_pedidos][${account}] registrar falhos RECUSADO — o lease ja era de outro worker`);
  return desfecho;
}

/**
 * PRÉ-REGISTRO (2º challenge Codex, P2): a identidade de cada pedido do lote entra na janela ANTES de
 * criar_pedidos_com_itens. Só os que a RPC PODE criar — espelho do G7 dela (`it->>'omie_codigo_produto'
 * IS NOT NULL` em `itens`): pedido sem item válido nunca vira pai, e ficaria pendente para sempre.
 * O banco poda pela existência em sales_orders; o que gravou sai da lista sozinho.
 */
export function pendenciasDoLote(lote: unknown[], pagina: number): PedidoFalho[] {
  const out: PedidoFalho[] = [];
  for (const p of lote) {
    if (p === null || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const itens = Array.isArray(o.itens) ? o.itens : [];
    const criavel = itens.some((it) =>
      it !== null && typeof it === "object" && (it as Record<string, unknown>).omie_codigo_produto != null
    );
    if (!criavel) continue;
    const codigo = o.omie_pedido_id;
    out.push({
      codigo_pedido: typeof codigo === "number" || typeof codigo === "string" ? codigo : null,
      hash: typeof o.hash_payload === "string" ? o.hash_payload : null,
      sqlstate: null,
      erro: null,
      pagina,
    });
  }
  return out;
}
