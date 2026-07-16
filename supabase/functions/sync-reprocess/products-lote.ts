// Lógica PURA do reprocessProducts em LOTE (decisão isolada do I/O — testada em
// products-lote_test.ts, padrão inventory-lote.ts do PR #1341).
//
// Por quê (2026-07-17): o reprocessProducts N+1 fazia 2 round-trips PostgREST POR produto
// do ListarProdutos (1 SELECT maybeSingle + 1 upsert) → sob catálogo grande estourava o
// worker budget da edge no cron sync-reprocess-strategic (02:30 UTC) → HTTP 546
// WORKER_RESOURCE_LIMIT, morte SEM exceção (o catch não roda) e órfã `running` em
// sync_reprocess_log — 52 órfãs de products/oben desde 28/02 (~1 a cada 2,7 dias). Mesma
// assinatura do inventory, curada nos PRs #1341/#1344.
//
// Money-path (omie_products é o catálogo/preço que alimenta vendas e reposição):
// - filtros de exclusão FIÉIS ao N+1 (inativo, tipo K, famílias excluídas, jumbo, 810ml);
// - divergência = comparação ESTRITA do N+1: descricao com fallback "" e valor_unitario com
//   fallback 0 — assimetria com o row (que grava "Sem descrição") PRESERVADA de propósito,
//   senão mudaria o sinal divergences_found monitorado do strategic;
// - código ambíguo (2+ ids distintos) NÃO conta divergência (fiel ao maybeSingle→PGRST116→
//   existing null) — impossível pelo UNIQUE(omie_codigo_produto,account), defense-in-depth;
// - item com código inválido é descartado SOZINHO: em lote, um único item malformado
//   derrubaria o chunk inteiro de 500 no Postgres (no N+1 o dano era 1 produto).

export interface ProdutoCadastroOmie {
  codigo_produto?: number | string;
  codigo_produto_integracao?: string | null;
  codigo?: string;
  descricao?: string;
  unidade?: string;
  ncm?: string | null;
  valor_unitario?: number;
  quantidade_estoque?: number;
  descricao_familia?: string;
  inativo?: string;
  tipo?: string;
  imagens?: Array<{ url_imagem?: string }>;
  marca?: string;
  modelo?: string;
  peso_bruto?: number;
  peso_liq?: number;
  cfop?: string;
}

export interface LinhaProdutoCatalogo {
  id: string | null;
  omie_codigo_produto: number | string | null;
  descricao: string | null;
  valor_unitario: unknown;
}

export interface RowUpsertProduto {
  omie_codigo_produto: number;
  omie_codigo_produto_integracao: string | null;
  codigo: string;
  descricao: string;
  unidade: string;
  ncm: string | null;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  familia: string | null;
  imagem_url: string | null;
  metadata: Record<string, unknown>;
  account: string;
  updated_at: string;
}

export interface PlanoEscritaProdutos {
  rows: RowUpsertProduto[];
  divergences: number;
}

// Famílias fora do catálogo vendável (fiel ao N+1 — matching por INCLUDES na família
// normalizada lowercase/trim; 'jumbos de lixa para discos' também cai no startsWith('jumbo')).
export const EXCLUDED_FAMILIES = [
  "imobilizado",
  "uso e consumo",
  "matérias primas para conversão de cintas",
  "jumbos de lixa para discos",
  "material para tingimix",
];

// Guard anti-runaway: total_de_paginas lixo/gigante não pode girar a edge por horas.
// 500 páginas × 100 = 50k produtos ≈ ordens de grandeza acima do catálogo real.
export const MAX_PAGINAS_PRODUTOS = 500;

// Aplica os filtros de exclusão do N+1 e acumula os elegíveis no Map (dedupe last-wins por
// código — duplicata no MESMO statement de upsert daria 21000 "cannot affect row a second
// time"). Guarda o produto CRU do Omie; fallbacks de escrita ficam em planejarEscritaProdutos
// (chamado com o nowIso capturado APÓS a coleta — Codex P2 do #1341). Retorna quantos entraram.
export function acumularProdutosDaPagina(
  catalogo: Map<number, ProdutoCadastroOmie>,
  produtos: ProdutoCadastroOmie[],
): number {
  let elegiveis = 0;
  for (const prod of produtos) {
    if (prod.inativo === "S") continue;
    if (prod.tipo && prod.tipo.toUpperCase() === "K") continue;
    const familia = (prod.descricao_familia || "").toLowerCase().trim();
    if (EXCLUDED_FAMILIES.some((ex) => familia.includes(ex)) || familia.startsWith("jumbo")) continue;
    const descLower = (prod.descricao || "").toLowerCase();
    if (descLower.includes("810ml") || descLower.includes("810 ml")) continue;

    const codProd = Number(prod.codigo_produto); // Omie pode devolver string; chave do Map é number
    if (!Number.isSafeInteger(codProd) || codProd <= 0) continue; // Number(undefined)=NaN / Number("")=0 nunca viram entrada
    catalogo.set(codProd, prod);
    elegiveis++;
  }
  return elegiveis;
}

// Rows de upsert (payload COMPLETO — carrega as NOT NULL sem default codigo/descricao com os
// fallbacks do N+1, então não existe o 23502 do #1344 aqui) + divergências contra as linhas
// locais de omie_products. O upsert é INCONDICIONAL como no N+1 (divergência é métrica, nunca
// gate de escrita).
export function planejarEscritaProdutos(
  catalogo: Map<number, ProdutoCadastroOmie>,
  locais: LinhaProdutoCatalogo[],
  account: string,
  nowIso: string,
): PlanoEscritaProdutos {
  // Espelho local por código; ambíguo (2+ ids DISTINTOS — repetição de transporte da mesma
  // linha não conta) degrada para "sem local", fiel ao PGRST116→null do maybeSingle antigo.
  const localPorCod = new Map<number, LinhaProdutoCatalogo | null>();
  for (const l of locais) {
    if (l.omie_codigo_produto == null || l.id == null) continue;
    const cod = Number(l.omie_codigo_produto);
    if (!Number.isSafeInteger(cod) || cod <= 0) continue;
    const atual = localPorCod.get(cod);
    if (atual === undefined) {
      localPorCod.set(cod, l);
    } else if (atual !== null && String(atual.id) !== String(l.id)) {
      localPorCod.set(cod, null);
    }
  }

  const plano: PlanoEscritaProdutos = { rows: [], divergences: 0 };
  for (const [cod, prod] of catalogo) {
    const local = localPorCod.get(cod);
    if (local != null) {
      // Comparação ESTRITA fiel ao N+1 (fallback "" ≠ o "Sem descrição" do row — deliberado;
      // null local diverge de 0 — nada de coerção Number(null)===0).
      if (
        local.descricao !== (prod.descricao || "") ||
        local.valor_unitario !== (prod.valor_unitario || 0)
      ) {
        plano.divergences++;
      }
    }
    plano.rows.push({
      omie_codigo_produto: cod,
      omie_codigo_produto_integracao: prod.codigo_produto_integracao || null,
      codigo: prod.codigo || `PROD-${cod}`,
      descricao: prod.descricao || "Sem descrição",
      unidade: prod.unidade || "UN",
      ncm: prod.ncm || null,
      valor_unitario: prod.valor_unitario || 0,
      estoque: prod.quantidade_estoque || 0,
      ativo: true,
      familia: prod.descricao_familia || null,
      imagem_url: prod.imagens?.[0]?.url_imagem || null,
      metadata: {
        marca: prod.marca,
        modelo: prod.modelo,
        peso_bruto: prod.peso_bruto,
        peso_liq: prod.peso_liq,
        descricao_familia: prod.descricao_familia,
        cfop: prod.cfop,
      },
      account,
      updated_at: nowIso,
    });
  }
  return plano;
}
