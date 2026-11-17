// catalogo-staging.ts — builder PURO item→linha de staging da rota /catalogs (produtos, bases,
// embalagens, skus, corantes), com LISTA FECHADA de colunas por entidade.
//
// O que isto fecha (scanner Lovable, lote 6 — docs/historico/scanner-lovable-rescan-lote6.md):
// a rota copiava TODA propriedade do item para a linha ("Copy all item fields"). Quem tem o token
// de sync da loja escolhia, além do catálogo, as colunas de CONTROLE da tabela — e `created_at` e
// `id` são o critério de "mais recente" da promoção (`ORDER BY created_at DESC, id DESC` em
// tint_promote_sync_run) e da purga (`tint_staging_purge`). Um item com `created_at` no futuro
// vencia todo reenvio honesto dali em diante e nunca era purgado: o dado forjado ficava preso,
// inclusive depois de trocar o token.
//
// Contrato (money-path — cada linha abaixo tem teste em catalogo-staging_test.ts):
//   · o item só preenche as colunas de CATÁLOGO da sua entidade (COLUNAS abaixo). As cinco de
//     controle da linha (sync_run_id, account, store_code, raw_data, staging_status) vêm do
//     servidor; `id` e `created_at` ficam com o default do banco; `matched_id` não se preenche.
//   · item com QUALQUER campo fora da lista é RECUSADO inteiro: não vira linha, conta como erro e
//     a edge tenta registrar em tint_sync_errors. Não se "limpa e aceita": o conector só confirma
//     o lote com error_count = 0 e só então avança a marca da entidade (connector/sayersync/
//     sync.go), então a recusa segue barulhenta, como já era o PGRST204 da cópia cega para campo
//     que não é coluna. Limpar calado esconderia um campo novo (ou um nome digitado errado) que
//     nunca chegaria à coluna. Enquanto durar a incompatibilidade, a entidade é reenviada a cada
//     ciclo; as outras entidades seguem.
//   · valor de coluna é pass-through (null, 0 e '' preservados): validade é papel do banco.
//   · chave ausente ou falsy vira '' — como era.
//   · campo novo de catálogo exige entrar AQUI, depois da migration da coluna e antes do binário.
//
// Medido na PROD em 2026-11-17 (psql-ro), sobre toda a retenção do staging: 846.914 itens de 4
// versões do conector (0.2.3 a 0.2.6), 0 com campo fora desta lista. O conserto não recusa nada
// do tráfego real.
//
// Testável com `deno test --no-remote` — NÃO adicionar import remoto, NÃO reimplementar inline
// no index.

/** Tabela, coluna-chave e colunas de catálogo que o ITEM pode preencher, por entidade. */
export const STAGING_DO_CATALOGO = {
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
} as const;

export type EntidadeComLinhaDeCatalogo = keyof typeof STAGING_DO_CATALOGO;

/** A ordem em que a rota grava — a mesma de antes. */
export const ENTIDADES_COM_LINHA_DE_CATALOGO: readonly EntidadeComLinhaDeCatalogo[] = [
  "produtos",
  "bases",
  "embalagens",
  "skus",
  "corantes",
];

/** Teto do que a recusa carrega para o log: nomes distintos e tamanho de cada nome. */
export const TETO_CAMPOS_NO_LOG = 20;
export const TETO_NOME_DE_CAMPO = 60;

export interface ContextoDoRunDeCatalogo {
  runId: string;
  account: string;
  storeCode: string;
}

export interface LinhasDeCatalogoMontadas {
  /** Itens que vieram num array (o `received` da resposta). */
  recebidos: number;
  /** Linhas prontas para o insert, na ordem dos itens aceitos. */
  linhas: Record<string, unknown>[];
  /** Itens recusados (não viraram linha). Lote que não é array conta 1. */
  recusados: number;
  /** Nomes de campo fora do contrato vistos nos recusados: os primeiros até o teto, sem repetição, ordenados. */
  camposFora: string[];
  /** Quantos dos recusados não eram objeto. */
  naoObjeto: number;
  /** O valor da entidade no payload existia e não era array. */
  loteMalformado: boolean;
}

function ehObjetoDeItem(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Monta as linhas de staging de UMA entidade do catálogo.
 * `itens` é o valor cru de `body[entidade]`: ausente (undefined/null) é lote sem essa entidade.
 */
export function montarLinhasDeCatalogo(
  entidade: EntidadeComLinhaDeCatalogo,
  itens: unknown,
  ctx: ContextoDoRunDeCatalogo,
): LinhasDeCatalogoMontadas {
  const cfg = STAGING_DO_CATALOGO[entidade];
  const permitidas: readonly string[] = cfg.colunas;
  const saida: LinhasDeCatalogoMontadas = {
    recebidos: 0,
    linhas: [],
    recusados: 0,
    camposFora: [],
    naoObjeto: 0,
    loteMalformado: false,
  };
  if (itens === undefined || itens === null) return saida;
  if (!Array.isArray(itens)) {
    // Antes, com outra entidade do mesmo lote abrindo o run, isto estourava um TypeError no `.map`
    // e a rota respondia 500 com o run aberto. Sozinho no lote, o valor que não é lista segue caindo
    // no ack sem run de catalogo-vazio.ts, como antes.
    saida.loteMalformado = true;
    saida.recusados = 1;
    return saida;
  }

  saida.recebidos = itens.length;
  const fora = new Set<string>();
  for (const item of itens as unknown[]) {
    if (!ehObjetoDeItem(item)) {
      saida.recusados++;
      saida.naoObjeto++;
      continue;
    }
    const estranhos = Object.keys(item).filter((k) => !permitidas.includes(k));
    if (estranhos.length > 0) {
      saida.recusados++;
      // O teto vale DURANTE a coleta: um item com milhares de chaves não infla o conjunto.
      for (const k of estranhos) {
        if (fora.size >= TETO_CAMPOS_NO_LOG) break;
        fora.add(k.slice(0, TETO_NOME_DE_CAMPO));
      }
      continue;
    }
    // A linha nasce só com nomes LITERAIS: nenhuma chave do item vira nome de coluna.
    const linha: Record<string, unknown> = {
      sync_run_id: ctx.runId,
      account: ctx.account,
      store_code: ctx.storeCode,
      raw_data: item,
      staging_status: "pending",
    };
    for (const coluna of permitidas) {
      if (Object.prototype.hasOwnProperty.call(item, coluna)) linha[coluna] = item[coluna];
    }
    linha[cfg.chave] = item[cfg.chave] || "";
    saida.linhas.push(linha);
  }
  saida.camposFora = [...fora].sort();
  return saida;
}

/** Mensagem da recusa: vai para `errors[]` da resposta e para tint_sync_errors.error_message. */
export function mensagemDaRecusaDeCatalogo(m: LinhasDeCatalogoMontadas): string {
  if (m.loteMalformado) return "lote recusado: a entidade não veio como lista";
  const partes: string[] = [];
  if (m.camposFora.length > 0) partes.push(`campo fora do contrato do catálogo (${m.camposFora.join(", ")})`);
  if (m.naoObjeto > 0) partes.push(`${m.naoObjeto} item(ns) que não são objeto`);
  return `${m.recusados} item(ns) recusado(s): ${partes.join("; ")}`;
}

/** Detalhe da recusa para tint_sync_errors.error_details — sem o item cru (não vira depósito). */
export function detalheDaRecusaDeCatalogo(
  entidade: EntidadeComLinhaDeCatalogo,
  m: LinhasDeCatalogoMontadas,
): Record<string, unknown> {
  return {
    motivo: m.loteMalformado ? "lote_nao_e_lista" : "campo_fora_do_contrato",
    itens_recebidos: m.recebidos,
    itens_recusados: m.recusados,
    itens_nao_objeto: m.naoObjeto,
    campos_fora: m.camposFora,
    colunas_aceitas: [...STAGING_DO_CATALOGO[entidade].colunas],
  };
}
