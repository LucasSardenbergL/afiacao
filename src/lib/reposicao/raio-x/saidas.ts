// Saídas do Raio-X: lista de troca, venda dirigida por cliente e diferença de contagem. Lógica pura.
import type { DecisaoRow, ItemRaioX } from './tipos';

export const SEM_COMPRADOR = 'sem comprador em 12m';

export interface LinhaTroca {
  sku_codigo_omie: number;
  codigo: string;
  descricao: string | null;
  saldo: number;
  valor: number | null;
  fornecedor: string;
}

export function listaTroca(itens: ItemRaioX[], decisoes: Map<number, DecisaoRow>): LinhaTroca[] {
  const linhas: LinhaTroca[] = [];
  for (const i of itens) {
    const d = decisoes.get(i.sku_codigo_omie);
    if (d?.destino !== 'trocar') continue;
    linhas.push({
      sku_codigo_omie: i.sku_codigo_omie,
      codigo: i.codigo,
      descricao: i.descricao,
      saldo: i.saldo,
      valor: i.valor,
      fornecedor: d.fornecedor_informado || i.fornecedor || '?',
    });
  }
  return linhas.sort((a, b) =>
    a.fornecedor.localeCompare(b.fornecedor) || (b.valor ?? -Infinity) - (a.valor ?? -Infinity));
}

export interface GrupoCliente {
  cliente: string;
  valor: number;
  itens: ItemRaioX[];
}

export function vendaDirigidaPorCliente(itens: ItemRaioX[], decisoes: Map<number, DecisaoRow>): GrupoCliente[] {
  const grupos = new Map<string, GrupoCliente>();
  for (const i of itens) {
    if (decisoes.get(i.sku_codigo_omie)?.destino !== 'venda_dirigida') continue;
    const nomes = i.clientes?.length ? i.clientes.map((c) => c.nome) : [SEM_COMPRADOR];
    for (const nome of nomes) {
      const g = grupos.get(nome) ?? { cliente: nome, valor: 0, itens: [] };
      g.itens.push(i);
      if (i.valor !== null) g.valor += i.valor; // sem custo: o item aparece, mas não soma R$ 0 fabricado
      grupos.set(nome, g);
    }
  }
  return [...grupos.values()].sort((a, b) => b.valor - a.valor);
}

export function diffContagem(
  item: Pick<ItemRaioX, 'saldo' | 'cmc'>,
  qtd: number | null,
): { dif_un: number; dif_valor: number | null } | null {
  if (qtd === null || qtd === undefined || !Number.isFinite(qtd)) return null;
  const dif = qtd - item.saldo;
  return { dif_un: dif, dif_valor: item.cmc === null ? null : dif * item.cmc };
}
