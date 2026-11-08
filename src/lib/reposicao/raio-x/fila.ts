// Fila de decisão do Top 61 (UX 3 da 2ª revisão) e a linha histórica do membro da coorte que zerou (bug 2).
// Lógica pura. A fila só ORDENA e escolhe o próximo — decidir continua sendo um toque humano por item, nunca lote.
import { sugestaoConfirmavel } from './decisao';
import type { CoorteTop, DecisaoRow, ItemRaioX } from './tipos';

/** Valor que ordena a fila: o de hoje; na linha histórica (saiu do estoque), o congelado na coorte. */
const valorDaFila = (i: ItemRaioX): number | null => (i.fora_do_estoque ? (i.valor_coorte ?? null) : i.valor);

/**
 * Pendentes do Top 61 (coorte). Primeiro as sugestões fáceis de confirmar (1 toque — `sugestaoConfirmavel`), depois o
 * resto; dentro de cada bloco, R$ desc, sem custo ao fim, desempate por SKU (ordem estável). Só ORDENA: a regra de
 * quem pode ser confirmado é a mesma do botão, e liquidar sem veredito inequívoco nunca entra no 1º bloco.
 */
export function filaTop(itens: ItemRaioX[], decisoes: Map<number, DecisaoRow>): ItemRaioX[] {
  const facil = (i: ItemRaioX) => sugestaoConfirmavel(i, decisoes.get(i.sku_codigo_omie)) !== null;
  return itens
    .filter((i) => i.top && !decisoes.get(i.sku_codigo_omie)?.destino)
    .map((i) => ({ i, f: facil(i) }))
    .sort((x, y) => {
      if (x.f !== y.f) return x.f ? -1 : 1;
      const a = x.i;
      const b = y.i;
      const va = valorDaFila(a);
      const vb = valorDaFila(b);
      if (va === null && vb === null) return a.sku_codigo_omie - b.sku_codigo_omie;
      if (va === null) return 1;
      if (vb === null) return -1;
      return vb - va || a.sku_codigo_omie - b.sku_codigo_omie;
    })
    .map((x) => x.i);
}

/**
 * Próximo SKU da fila depois de `atual`, circular (o "Pular" volta ao começo depois do último). `excluir` = SKUs já
 * salvos nesta sessão: o cache de decisões pode ainda não ter voltado do servidor. `null` = fila zerada.
 */
export function proximoDaFila(fila: Pick<ItemRaioX, 'sku_codigo_omie'>[], atual: number | null, excluir: ReadonlySet<number>): number | null {
  const skus = fila.map((i) => i.sku_codigo_omie).filter((s) => s !== atual && !excluir.has(s));
  if (skus.length === 0) return null;
  const pos = atual === null ? -1 : fila.findIndex((i) => i.sku_codigo_omie === atual);
  if (pos < 0) return skus[0];
  const depois = fila.slice(pos + 1).find((i) => i.sku_codigo_omie !== atual && !excluir.has(i.sku_codigo_omie));
  return depois ? depois.sku_codigo_omie : skus[0];
}

/** Origens de visita aceitas no sensor `reposicao.raio_x_aberta` (allowlist: texto livre da URL nunca vai ao ledger). */
const ORIGENS_VISITA = ['email'] as const;
export type OrigemVisita = (typeof ORIGENS_VISITA)[number];

/** `?origem=` da URL → origem conhecida, ou `null` (ausente/desconhecida = visita sem origem, como antes). */
export function origemDaVisita(bruto: string | null): OrigemVisita | null {
  return (ORIGENS_VISITA as readonly string[]).includes(bruto ?? '') ? (bruto as OrigemVisita) : null;
}

export interface ProdutoCadastro {
  codigo: string | null;
  descricao: string | null;
}

/**
 * Membros da coorte que saíram dos fatos (saldo zerado): sem esta linha, o pendente ficaria sem onde decidir e a meta
 * de 100% seria impossível pela tela (o SKU segue no denominador — nunca sai da coorte); o decidido segue visível e
 * editável. A linha é só para a decisão humana explícita: saldo 0,
 * sem custo de hoje (`valor` null — nunca R$ 0 fabricado), o valor da FOTO da coorte em `valor_coorte`, sem sugestão
 * (não há fato de hoje para sugerir) e fora do motor por desconhecimento (`no_motor` false → nada a desligar).
 */
export function linhasForaDoEstoque(
  coorte: CoorteTop | null,
  presentes: ReadonlySet<number>,
  cadastro: Map<number, ProdutoCadastro>,
): ItemRaioX[] {
  if (!coorte) return [];
  const linhas: ItemRaioX[] = [];
  for (const [sku, m] of coorte.itens) {
    if (presentes.has(sku)) continue;
    const p = cadastro.get(sku);
    linhas.push({
      sku_codigo_omie: sku, codigo: p?.codigo ?? String(sku), descricao: p?.descricao ?? null,
      familia: null, tipo_produto: null, ativo: true, saldo: 0, cmc: null, unidade_estoque: null, unidades_venda: null,
      no_motor: false, tipo_reposicao: null, classe_abc: null, cadastro_em: null, ult_entrada: null, fornecedor: null,
      q12: null, ncli: null, ult_venda: null, preco_medio_12m: null, clientes: null, synced_at: null,
      habilitado_reposicao_automatica: null,
      valor: null, cobertura: null, categoria: 'mercadoria', motivo_categoria: 'membro da coorte do Top 61',
      parado: true, destino_sugerido: null,
      motivo_destino: 'saiu do estoque (saldo zerado) antes de uma decisão — registre o que aconteceu',
      alerta_recompra: null, top: true, top_atual: false, entrou_no_top: false,
      inequivoco: null, motivos_espera: [], qtd_liquidavel: null, ultima_entrada: null,
      fora_do_estoque: true, valor_coorte: m.valor,
    });
  }
  return linhas;
}
