// As leituras que MONTAM a fila — todas paginadas.
//
// O PostgREST corta CADA resposta em 1.000 linhas, em SILÊNCIO (CLAUDE.md → PostgREST; o cabeçalho
// de `_shared/paginate.ts`). Até a v1.4 a montagem da fila lia `sku_leadtime_history` com um
// `.in("tracking_id", ids)` cru: com a janela de 215 dias (2026-10-08, OBEN) eram 2.962 linhas de
// histórico, voltavam 1.000, e os trackings cuja linha caiu na cauda viravam "sem linha" — logo
// PENDENTES pela regra legada de `pendenteNaFila`. O run dirigido das 00:58Z viu `fila_pendente`
// 228 em vez de 18, fechou `error` no guard de 50s e gastou 5 consultas Omie em recebimentos que já
// tinham leadtime (docs/historico/sku-items-cte-fora-da-fila.md §10). No cron (30 dias, 178 linhas)
// a folga é de ~5x: latente, e cresce com o volume.
//
// O conserto vale para as QUATRO leituras da montagem, não só a que estourou — a janela de NF-e, o
// controle e as irmãs estão abaixo do teto hoje (423 / 97 / irmãs da fila, medido) por acaso de
// volume, e nada vigiava isso. As irmãs já tinham um fail-closed no teto (lançavam em ≥1.000); agora
// leem tudo.
//
// DOIS cortes, não um:
//   · KEYSET (`fetchAllKeyset`) pela chave ÚNICA do recorte (`id`, ou a PK `tracking_id` do
//     controle), não offset: outro run da MESMA edge (o cron das 2h com um dirigido em paralelo)
//     insere em `sku_leadtime_history` durante a leitura, e com offset um INSERT antes da posição
//     desloca as páginas — uma linha que JÁ EXISTIA seria pulada e o tracking dela leria "sem
//     linha", o mesmo defeito por outra porta. O keyset garante não pular nem duplicar as linhas
//     pré-existentes; a linha inserida DURANTE a leitura (uuid aleatório) pode ou não ser vista —
//     não há snapshot, como antes.
//   · LOTES no `.in()`: a lista de valores vai na URL (~37 bytes por UUID). Com a janela máxima
//     (365 dias, 423 trackings) são ~16 KB de querystring — perto do que proxy costuma aceitar.
//     Os lotes são DISJUNTOS em valor, então as linhas de lotes distintos também são.
//
// Erro sai como `FalhaLeituraCritica` (mensagem em domínio fechado — o `catch` do `Deno.serve`
// devolve `.message` no corpo). Fail-closed como antes: sem a fila inteira, o run não começa.
//
// Módulo sem `npm:` (a suíte roda `--no-remote`): o `SupabaseClient` entra por cast no call-site.
import { type BancoPostgrest, fetchAllKeyset, type QueryPostgrest } from "../_shared/paginate.ts";
import type { ControleFila } from "./recebimento.ts";

/** Valores por `.in()`. 150 UUIDs ≈ 5,5 KB de querystring. */
export const LOTE_IN = 150;

export function emLotes<T>(valores: readonly T[], tamanho: number = LOTE_IN): T[][] {
  if (!Number.isInteger(tamanho) || tamanho < 1) throw new Error(`emLotes: tamanho inválido (${tamanho})`);
  const unicos = [...new Set(valores)];
  const lotes: T[][] = [];
  for (let i = 0; i < unicos.length; i += tamanho) lotes.push(unicos.slice(i, i + tamanho));
  return lotes;
}

/**
 * Lê TODAS as linhas de `tabela` com `colunaIn` em `valores`: lotes no `.in()`, keyset por `chave`
 * dentro de cada lote. `filtro` aplica os predicados fixos (ex.: `empresa`).
 */
async function lerEmLotes<T>(
  db: BancoPostgrest,
  opts: {
    tabela: string;
    colunas: string;
    colunaIn: string;
    valores: readonly unknown[];
    chave: keyof T & string;
    label: string;
    filtro?: (q: QueryPostgrest<T>) => QueryPostgrest<T>;
  },
): Promise<T[]> {
  const out: T[] = [];
  for (const lote of emLotes(opts.valores)) {
    const linhas = await fetchAllKeyset<T, string>(
      (cursor, limite) => {
        let q = db.from<T>(opts.tabela).select(opts.colunas);
        if (opts.filtro) q = opts.filtro(q);
        q = q.in(opts.colunaIn, lote);
        if (cursor !== null) q = q.gt(opts.chave, cursor);
        return q.order(opts.chave, { ascending: true }).limit(limite);
      },
      (linha) => linha[opts.chave] as unknown as string,
      opts.label,
    );
    out.push(...linhas);
  }
  return out;
}

/**
 * As NF-e da janela (t2 ≥ `cutoffIso`, com chave de acesso), opcionalmente de um fornecedor.
 * Volta na ordem de antes — t2 DESC, desempate por `id` — embora a fila seja reordenada depois pelo
 * comparador (`skuItemsCompararFila`); a ordem aqui só não pode depender da paginação.
 */
export async function carregarNfesDaJanela<T extends { id: string; t2_data_faturamento: string }>(
  db: BancoPostgrest,
  opts: { empresa: string; cutoffIso: string; fornecedor: number | null; colunas: string },
): Promise<T[]> {
  const linhas = await fetchAllKeyset<T, string>(
    (cursor, limite) => {
      let q = db.from<T>("purchase_orders_tracking")
        .select(opts.colunas)
        .eq("empresa", opts.empresa)
        .gte("t2_data_faturamento", opts.cutoffIso)
        .not("t2_data_faturamento", "is", null)
        .not("nfe_chave_acesso", "is", null);
      if (opts.fornecedor !== null) q = q.eq("fornecedor_codigo_omie", opts.fornecedor);
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite);
    },
    (linha) => linha.id,
    "purchase_orders_tracking (janela da fila)",
  );
  return linhas.sort((a, b) =>
    a.t2_data_faturamento < b.t2_data_faturamento ? 1
    : a.t2_data_faturamento > b.t2_data_faturamento ? -1
    : a.id < b.id ? -1
    : a.id > b.id ? 1
    : 0
  );
}

/** Os trackings que JÁ têm ao menos uma linha em `sku_leadtime_history`. */
export async function carregarTrackingsComLinha(db: BancoPostgrest, trackingIds: readonly string[]): Promise<Set<string>> {
  const linhas = await lerEmLotes<{ id: string; tracking_id: string | null }>(db, {
    tabela: "sku_leadtime_history",
    colunas: "id, tracking_id",
    colunaIn: "tracking_id",
    valores: trackingIds,
    chave: "id",
    label: "sku_leadtime_history (trackings com linha)",
  });
  const out = new Set<string>();
  for (const l of linhas) if (l.tracking_id) out.add(l.tracking_id);
  return out;
}

/**
 * O controle de tentativas dos trackings. A ausência da tabela/coluna (edge antes da migration)
 * LANÇA — sem o controle não há backoff e o poison voltaria em silêncio.
 */
export async function carregarControleDaFila(
  db: BancoPostgrest,
  trackingIds: readonly string[],
): Promise<Map<string, ControleFila>> {
  const linhas = await lerEmLotes<{
    tracking_id: string;
    tentativas: number | null;
    ultima_tentativa: string | null;
    itens_pendentes: number | null;
  }>(db, {
    tabela: "sku_items_sync_controle",
    colunas: "tracking_id, tentativas, ultima_tentativa, itens_pendentes",
    colunaIn: "tracking_id",
    valores: trackingIds,
    chave: "tracking_id",
    label: "sku_items_sync_controle (migration aplicada? cache do PostgREST?)",
  });
  const out = new Map<string, ControleFila>();
  for (const row of linhas) {
    if (!row?.tracking_id) continue;
    out.set(row.tracking_id, {
      tentativas: row.tentativas ?? 0,
      ultima_tentativa: row.ultima_tentativa,
      itens_pendentes: row.itens_pendentes ?? null,
    });
  }
  return out;
}

/**
 * TODAS as linhas de `purchase_orders_tracking` dos recebimentos (mesma `nid_receb`), dentro ou fora
 * da janela. Cada recebimento cai num lote só, então a lista dele sai em ordem de `id`.
 */
export async function carregarIrmas<T extends { id: string; nid_receb: number | string | null }>(
  db: BancoPostgrest,
  opts: { empresa: string; recebimentos: readonly string[]; colunas: string },
): Promise<T[]> {
  return await lerEmLotes<T>(db, {
    tabela: "purchase_orders_tracking",
    colunas: opts.colunas,
    colunaIn: "nid_receb",
    valores: opts.recebimentos,
    chave: "id",
    label: "purchase_orders_tracking (irmãs do recebimento)",
    filtro: (q) => q.eq("empresa", opts.empresa),
  });
}
