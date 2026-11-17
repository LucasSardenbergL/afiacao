// catalogo-rows.ts — builder PURO item→linha de staging da rota /catalogs (produtos, bases,
// embalagens, skus, corantes). O index.ts importa daqui; NÃO adicionar imports remotos neste
// arquivo (roda no CI com `deno test --no-remote`, em catalogo-rows_test.ts).
//
// Por que existe (scanner Lovable Security, lote 6 — 2026-11-17, money-path):
// até a v1.3 a rota copiava TODA propriedade do item recebido para a linha
// (`for (const [k, v] of Object.entries(item)) row[k] = v`). Quem tem o token de sync da loja
// escolhia então colunas que são do SERVIDOR: `created_at`, `id` e `matched_id`. E `created_at` é a
// chave de ordenação que decide qual linha de staging VENCE — na promoção
// (`tint_promote_sync_run`: `ORDER BY created_at DESC, id DESC`), no preço
// (`tint_calc_preco_final` e `tint_recalc_preco_oficial` leem o custo do corante da linha mais
// recente) e na purga (`tint_staging_purge` só apaga o que tem mais de 30 dias E uma linha mais
// nova por cima). Uma linha de corante com `created_at` no futuro vencia toda sincronização
// legítima seguinte e nunca era purgada: o preço ficava preso nela mesmo depois de o token ser
// trocado. Medido na PROD em 2026-11-17 (psql-ro): nenhuma linha com data futura e nenhuma com
// chave de servidor no `raw_data` — o caminho nunca foi usado.
//
// Invariantes (cada uma tem teste em catalogo-rows_test.ts):
//   · Do item só saem as colunas de NEGÓCIO da entidade (STAGING_CATALOGO[entidade].colunas).
//     `id`, `created_at` e `matched_id` NUNCA entram na linha: ficam com o default do banco, que
//     é o relógio e o gerador do servidor.
//   · `sync_run_id`, `account`, `store_code` e `staging_status` são do servidor; `raw_data` é o
//     item INTEIRO como chegou — o que foi descartado continua lá, como evidência.
//   · Valor é pass-through: nada é convertido, defaultado nem inferido. Chave ausente no item
//     fica AUSENTE na linha (o banco grava NULL), nunca 0 nem ''.
//   · Chave da entidade: `item[chave] || item.id || ''`, como sempre foi.
//
// O que NÃO muda para o agente real: ele só envia colunas desta lista (medido nas 3.000 linhas
// mais recentes de cada tabela), então a linha gravada é a mesma. Muda para item com campo fora
// da lista: antes o PostgREST recusava o LOTE inteiro de até 500 linhas (coluna inexistente);
// agora o campo é ignorado e a linha entra.

/** Item bruto de catálogo enviado pelo agente (qualquer das 5 entidades). */
export interface TintCatalogItem {
  id?: string;
  cod_produto?: string;
  id_base?: string;
  id_embalagem?: string;
  id_base_sayersystem?: string;
  id_embalagem_sayersystem?: string;
  id_corante_sayersystem?: string;
  descricao?: string;
  volume_ml?: number;
  preco_litro?: number;
  /** Custo do corante (de PRECO_CORANTE) */
  custo?: number;
  [k: string]: unknown;
}

interface StagingCatalogoConfig {
  /** Tabela de staging que recebe a entidade. */
  readonly tabela: string;
  /** Coluna-chave da entidade (sempre gravada; '' quando o item não a traz). */
  readonly chave: string;
  /** Colunas de NEGÓCIO: as ÚNICAS que saem do item do agente. Inclui a chave. */
  readonly colunas: readonly string[];
}

/**
 * Lista FECHADA do que a rota /catalogs grava, na ordem em que grava. As colunas são as de
 * negócio de cada `tint_staging_*` (conferidas no `information_schema` da PROD em 2026-11-17).
 * Coluna nova de negócio entra AQUI, e só aqui.
 */
export const STAGING_CATALOGO = {
  produtos: {
    tabela: "tint_staging_produtos",
    chave: "cod_produto",
    colunas: ["cod_produto", "descricao"],
  },
  bases: {
    tabela: "tint_staging_bases",
    chave: "id_base_sayersystem",
    colunas: ["id_base_sayersystem", "descricao"],
  },
  embalagens: {
    tabela: "tint_staging_embalagens",
    chave: "id_embalagem_sayersystem",
    colunas: ["id_embalagem_sayersystem", "descricao", "volume_ml"],
  },
  skus: {
    tabela: "tint_staging_skus",
    chave: "cod_produto",
    colunas: ["cod_produto", "id_base", "id_embalagem"],
  },
  corantes: {
    tabela: "tint_staging_corantes",
    chave: "id_corante_sayersystem",
    colunas: ["id_corante_sayersystem", "descricao", "preco_litro", "custo", "volume_ml"],
  },
} as const satisfies Record<string, StagingCatalogoConfig>;

export type EntidadeStagingCatalogo = keyof typeof STAGING_CATALOGO;

/** As 5 entidades, na ordem de gravação. */
export const ENTIDADES_STAGING_CATALOGO = Object.keys(STAGING_CATALOGO) as EntidadeStagingCatalogo[];

/**
 * Colunas que são do SERVIDOR em toda tabela `tint_staging_*` de catálogo. Nenhuma delas pode
 * constar em `colunas` (o teste confere) — é o que impede a lista fechada de reabrir o furo.
 */
export const COLUNAS_DO_SERVIDOR_NO_STAGING = [
  "id",
  "sync_run_id",
  "account",
  "store_code",
  "raw_data",
  "staging_status",
  "matched_id",
  "created_at",
] as const;

/** Linha de `tint_staging_<entidade>` para UM item de catálogo. */
export function montarStagingCatalogoRow(
  entidade: EntidadeStagingCatalogo,
  item: TintCatalogItem,
  runId: string,
  account: string,
  storeCode: string,
): Record<string, unknown> {
  const config: StagingCatalogoConfig = STAGING_CATALOGO[entidade];
  const row: Record<string, unknown> = {
    sync_run_id: runId,
    account,
    store_code: storeCode,
    raw_data: item,
    staging_status: "pending",
  };
  for (const coluna of config.colunas) {
    // Só propriedade PRÓPRIA do item: ausente fica ausente (o banco grava NULL), nunca 0 nem ''.
    if (Object.prototype.hasOwnProperty.call(item, coluna)) row[coluna] = item[coluna];
  }
  row[config.chave] = (item[config.chave] as string | undefined) || item.id || "";
  return row;
}
