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
  /** null = todos os itens do grupo sem custo (não avaliado, nunca R$ 0). */
  valor: number | null;
  itens: ItemRaioX[];
}

export function vendaDirigidaPorCliente(itens: ItemRaioX[], decisoes: Map<number, DecisaoRow>): GrupoCliente[] {
  const grupos = new Map<string, GrupoCliente>();
  for (const i of itens) {
    if (decisoes.get(i.sku_codigo_omie)?.destino !== 'venda_dirigida') continue;
    const nomes = i.clientes?.length ? i.clientes.map((c) => c.nome) : [SEM_COMPRADOR];
    for (const nome of nomes) {
      const g = grupos.get(nome) ?? { cliente: nome, valor: null, itens: [] };
      g.itens.push(i);
      if (i.valor !== null) g.valor = (g.valor ?? 0) + i.valor; // sem custo: o item aparece, mas não soma R$ 0 fabricado
      grupos.set(nome, g);
    }
  }
  return [...grupos.values()].sort((a, b) => (b.valor ?? -Infinity) - (a.valor ?? -Infinity));
}

export function diffContagem(
  item: Pick<ItemRaioX, 'saldo' | 'cmc'>,
  qtd: number | null,
): { dif_un: number; dif_valor: number | null } | null {
  if (qtd === null || qtd === undefined || !Number.isFinite(qtd)) return null;
  const dif = qtd - item.saldo;
  return { dif_un: dif, dif_valor: item.cmc === null ? null : dif * item.cmc };
}

// ── Exportação da lista de troca (o app não envia nada: o usuário copia ou baixa o CSV) ──────────────────
const num2 = (n: number) => n.toFixed(2).replace('.', ',');
/** Célula de texto: aspas/`;`/quebra escapados e fórmula (`= + - @`) neutralizada. */
function celula(t: string): string {
  const seguro = /^[=+\-@]/.test(t) ? `'${t}` : t;
  return /[;"\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

/** CSV `;` (Excel pt-BR). Valor null → célula vazia: ausente ≠ zero. */
export function csvTroca(linhas: LinhaTroca[]): string {
  const corpo = linhas.map((l) =>
    [celula(l.codigo), celula(l.descricao ?? ''), num2(l.saldo), l.valor === null ? '' : num2(l.valor), celula(l.fornecedor)].join(';'));
  return ['codigo;descricao;saldo;valor;fornecedor', ...corpo].join('\n');
}

/** Texto para colar (e-mail/WhatsApp), agrupado por fornecedor. Sem custo: omite o R$ do item. */
export function textoTroca(linhas: LinhaTroca[]): string {
  const porForn = new Map<string, LinhaTroca[]>();
  for (const l of linhas) porForn.set(l.fornecedor, [...(porForn.get(l.fornecedor) ?? []), l]);
  return [...porForn.entries()].map(([forn, ls]) =>
    [forn, ...ls.map((l) => `- ${l.codigo}${l.descricao ? ` ${l.descricao}` : ''}: ${l.saldo} un${l.valor === null ? '' : ` · R$ ${num2(l.valor)}`}`)].join('\n'),
  ).join('\n\n');
}
