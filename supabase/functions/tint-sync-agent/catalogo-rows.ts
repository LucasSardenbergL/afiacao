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
// mais recentes de cada tabela e lido nos mapeadores do conector), então a linha gravada é a mesma.
//
// Item com campo fora da lista é RECUSADO inteiro (`separarLoteDeCatalogo`): não vira linha, conta
// em `error_count`/`errors[]` e fica em `tint_sync_errors`. O conector só confirma o lote com
// `error_count == 0`, então reenvia a entidade no ciclo seguinte. É o que a v1.3 já fazia, por
// outro caminho: a coluna inexistente derrubava o lote de até 500 linhas (visto em campo em
// 12/06, com o campo `ativo`). A diferença é a granularidade — agora só o item ofensor fica de
// fora — e a mensagem, que nomeia o campo. Limpar o item e confirmar o lote descartaria em
// silêncio o que o conector acredita ter entregue, e ele não reenvia depois.
// A lista fechada do builder segue valendo por baixo: mesmo que alguém tire a recusa, coluna do
// servidor não entra na linha.
//
// Muda para o item que traz `id` no lugar da chave da entidade: antes o `id` ia junto para a
// coluna `id` (uuid) e derrubava o lote se não fosse uuid; agora ele só vira a chave. Não é
// autoridade nova: o agente já podia mandar o mesmo valor na chave da entidade.

import { ENTIDADES_CATALOGO } from "./catalogo-vazio.ts";

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

/** Tamanho máximo, em PONTOS DE CÓDIGO, de cada nome devolvido por `chavesDescartadas` (o nome vem do agente). */
export const MAX_TAMANHO_DE_CHAVE_NO_AVISO = 60;

/**
 * O nome do campo vem do agente e vai para `errors[]`, para `tint_sync_errors` e para a resposta
 * guardada do run (jsonb). Controle, separador de linha (inclusive U+2028/U+2029) e substituto
 * isolado viram `?`, e o corte é por ponto de código: cortar por unidade UTF-16 parte um emoji ao
 * meio e deixa um substituto isolado, que o `jsonb` do Postgres recusa — o fechamento do run
 * falharia por causa do nome de um campo.
 */
function nomeSeguro(chave: string): string {
  let saida = "";
  let pontos = 0;
  for (const c of chave) {
    if (pontos >= MAX_TAMANHO_DE_CHAVE_NO_AVISO) break;
    const cp = c.codePointAt(0) ?? 0;
    const inseguro = cp < 0x20 || cp === 0x7f || cp === 0x2028 || cp === 0x2029 || (cp >= 0xd800 && cp <= 0xdfff);
    saida += inseguro ? "?" : c;
    pontos += 1;
  }
  return saida;
}

/**
 * Nomes das chaves que os itens trouxeram e que NÃO estão na lista fechada da entidade (as do
 * servidor inclusive), sem repetição, em ordem, saneados e truncados. É o que decide a recusa do
 * item em `separarLoteDeCatalogo` e o que a mensagem de erro nomeia.
 *
 * `id` só conta quando o item também traz a chave da entidade — sem ela, o `id` é usado como chave.
 */
export function chavesDescartadas(
  entidade: EntidadeStagingCatalogo,
  itens: readonly TintCatalogItem[],
): string[] {
  const config: StagingCatalogoConfig = STAGING_CATALOGO[entidade];
  const gravadas = new Set<string>(config.colunas);
  const descartadas = new Set<string>();
  for (const item of itens) {
    const idViraChave = !item[config.chave];
    for (const chave of Object.keys(item)) {
      if (gravadas.has(chave)) continue;
      if (chave === "id" && idViraChave) continue;
      descartadas.add(nomeSeguro(chave));
    }
  }
  return [...descartadas].sort();
}

function ehObjetoSimples(v: unknown): v is TintCatalogItem {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** O lote de UMA entidade, separado em linhas a gravar e itens recusados. */
export interface LoteDeCatalogo {
  /** Linhas dos itens aceitos, na ordem em que vieram. */
  linhas: Record<string, unknown>[];
  /** Quantos itens NÃO viraram linha (campo fora da lista, ou item que não é objeto). */
  recusados: number;
  /** Nomes dos campos fora da lista que causaram recusa, sem repetição e em ordem. */
  camposRecusados: string[];
  /** Dos recusados, quantos não eram um objeto (texto, número, lista, null). */
  naoObjetos: number;
}

/**
 * Separa o lote de uma entidade. O item só vira linha se for um objeto e não trouxer campo fora
 * da lista fechada; senão é recusado INTEIRO. Recusar o campo e gravar o resto confirmaria ao
 * conector uma entrega que não aconteceu.
 */
export function separarLoteDeCatalogo(
  entidade: EntidadeStagingCatalogo,
  itens: readonly unknown[],
  runId: string,
  account: string,
  storeCode: string,
): LoteDeCatalogo {
  const linhas: Record<string, unknown>[] = [];
  const campos = new Set<string>();
  let recusados = 0;
  let naoObjetos = 0;
  for (const item of itens) {
    if (!ehObjetoSimples(item)) {
      recusados += 1;
      naoObjetos += 1;
      continue;
    }
    const fora = chavesDescartadas(entidade, [item]);
    if (fora.length > 0) {
      recusados += 1;
      for (const campo of fora) campos.add(campo);
      continue;
    }
    linhas.push(montarStagingCatalogoRow(entidade, item, runId, account, storeCode));
  }
  return { linhas, recusados, camposRecusados: [...campos].sort(), naoObjetos };
}

/** Quantos nomes de campo a mensagem e o registro da recusa carregam (o resto vira "+N"). */
export const MAX_CAMPOS_NA_RECUSA = 20;

/** Mensagem da recusa: vai em `errors[]` da resposta ao conector e em `tint_sync_errors`. */
export function mensagemDeRecusa(lote: LoteDeCatalogo): string {
  const partes: string[] = [];
  if (lote.camposRecusados.length > 0) {
    const nomes = lote.camposRecusados.slice(0, MAX_CAMPOS_NA_RECUSA).join(", ");
    const outros = lote.camposRecusados.length - MAX_CAMPOS_NA_RECUSA;
    partes.push(`campo(s) fora da lista da entidade: ${nomes}${outros > 0 ? ` (+${outros})` : ""}`);
  }
  if (lote.naoObjetos > 0) partes.push(`${lote.naoObjetos} item(ns) que não são objeto`);
  return `${lote.recusados} item(ns) recusado(s): ${partes.join("; ")}`;
}

/**
 * Forma do lote de /catalogs, conferida ANTES de qualquer atalho: o corpo tem de ser um objeto e
 * toda entidade gravável presente tem de ser uma lista. `null` e ausente valem como "não veio".
 * Sem isto, `{"corantes": {...}}` sozinho contava zero item gravável e recebia o ack limpo do lote
 * sem run — o conector confirmava um lote que ninguém gravou.
 */
export function erroDeFormaDoLote(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  for (const entidade of ENTIDADES_CATALOGO) {
    const valor = (body as Record<string, unknown>)[entidade];
    if (valor !== undefined && valor !== null && !Array.isArray(valor)) return `${entidade}: must be an array`;
  }
  return null;
}

/**
 * Espera `promessa` por no máximo `ms`. Devolve true se ela terminou a tempo. Serve ao registro da
 * recusa: ele é auxiliar (a recusa já vai em `errors[]` da resposta), então não pode segurar a
 * resposta ao conector além de um teto. O timer é sempre desarmado.
 */
export async function comLimite(promessa: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const estourou = Symbol("estourou");
  try {
    const vencedor = await Promise.race([
      promessa.then(() => null),
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(estourou), ms);
      }),
    ]);
    return vencedor !== estourou;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
