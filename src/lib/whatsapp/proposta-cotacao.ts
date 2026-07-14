// Travas da proposta 1-toque (PR-4): avalia a RECOTAÇÃO Omie (RPC get_whatsapp_proposta_cotacao)
// contra a cesta que o preview mostrou. PURO/testável. Money-path: linha sem preço/estoque/
// unidade/ativo/encontrada TRAVA A PROPOSTA INTEIRA (não sai parcial, não vira zero); total é
// NULL quando travada (nunca soma parcial). Cross-sell é RECOMENDAÇÃO (não promessa): item
// indisponível é removido com aviso — não cita preço nem entra no orçamento.

import { isValidUnitPrice } from '@/lib/pricing/mergeCustomerPrices';
import { fmtQty } from './proposta-format';
import { addDaysIso } from './route-schedule';
import type { CestaItem, CestaResult } from './cesta-recompra';
import type { CrossSellCand } from './cross-sell';

/** Uma linha do retorno da RPC de recotação (preco NULL = sem preço válido — NUNCA 0). */
export interface CotacaoRow {
  omie_codigo_produto: number;
  product_id: string | null;
  codigo: string | null;
  descricao: string | null;
  unidade: string | null;
  ativo: boolean;
  estoque: number | null;
  preco: number | null;
  fonte_preco: 'praticado' | 'tabela' | null;
}

export type MotivoTravaLinha =
  | 'nao_encontrado'        // SKU fora do catálogo da conta
  | 'inativo'
  | 'sem_unidade'
  | 'sem_preco'             // nem praticado nem tabela válidos (ausente ≠ zero)
  | 'sem_estoque_info'      // estoque NULL = desconhecido (≠ zero)
  | 'estoque_insuficiente'; // estoque < qtd sugerida

export type MotivoTravaGeral = 'sem_prazo' | 'sem_nome' | 'sem_telefone' | 'cesta_vazia';

export interface LinhaCotada {
  omie_codigo_produto: number;
  nome: string;
  qtd: number;
  preco: number | null;
  fonte: 'praticado' | 'tabela' | null;
  estoque: number | null;
  unidade: string | null;
  motivoTrava: MotivoTravaLinha | null;
  // dados pro payload do orçamento (paridade com submitQuote):
  product_id: string | null;
  codigo: string | null;
  descricao: string | null;
}

export interface CotacaoProposta {
  linhas: LinhaCotada[];
  crossSellOk: { omie_codigo_produto: number; nome: string }[];
  crossSellRemovidos: { nome: string; motivo: MotivoTravaLinha }[];
  travasGerais: MotivoTravaGeral[];
  travada: boolean;
  total: number | null; // NULL quando travada — nunca soma parcial
}

/** Motivo de trava de uma linha da CESTA (precedência: identidade → catálogo → preço → estoque). */
function motivoTravaLinha(row: CotacaoRow | undefined, qtd: number): MotivoTravaLinha | null {
  if (!row) return 'nao_encontrado';
  if (!row.ativo) return 'inativo';
  if (!row.unidade || row.unidade.trim() === '') return 'sem_unidade';
  if (!isValidUnitPrice(row.preco)) return 'sem_preco';
  if (row.estoque === null || row.estoque === undefined) return 'sem_estoque_info';
  if (row.estoque < qtd) return 'estoque_insuficiente';
  return null;
}

/** Disponibilidade de um item de CROSS-SELL (não exige preço — a mensagem não o cita). */
function motivoRemocaoCrossSell(row: CotacaoRow | undefined): MotivoTravaLinha | null {
  if (!row) return 'nao_encontrado';
  if (!row.ativo) return 'inativo';
  if (row.estoque === null || row.estoque === undefined) return 'sem_estoque_info';
  if (row.estoque <= 0) return 'estoque_insuficiente';
  return null;
}

export function avaliarCotacaoProposta(input: {
  cesta: CestaResult;
  maxSecundarios?: number; // MESMA janela do texto do preview (default 3) — cota-se o que se envia
  crossSell: CrossSellCand[];
  cotacao: CotacaoRow[];
  nomesPorSku: Record<number, string>;
  prazoEntrega: string | null;
  primeiroNome: string | null;
  telefone: string | null;
}): CotacaoProposta {
  const maxSec = input.maxSecundarios ?? 3;
  const enviaveis: CestaItem[] = [...input.cesta.principal, ...input.cesta.secundarios.slice(0, maxSec)];
  const porSku = new Map(input.cotacao.map(r => [r.omie_codigo_produto, r]));

  const linhas: LinhaCotada[] = enviaveis.map(item => {
    const row = porSku.get(item.omie_codigo_produto);
    return {
      omie_codigo_produto: item.omie_codigo_produto,
      nome: input.nomesPorSku[item.omie_codigo_produto] ?? row?.descricao ?? `Cód. ${item.omie_codigo_produto}`,
      qtd: item.qtdSugerida,
      preco: row?.preco ?? null,
      fonte: row?.fonte_preco ?? null,
      estoque: row?.estoque ?? null,
      unidade: row?.unidade ?? null,
      motivoTrava: motivoTravaLinha(row, item.qtdSugerida),
      product_id: row?.product_id ?? null,
      codigo: row?.codigo ?? null,
      descricao: row?.descricao ?? null,
    };
  });

  const crossSellOk: CotacaoProposta['crossSellOk'] = [];
  const crossSellRemovidos: CotacaoProposta['crossSellRemovidos'] = [];
  for (const cand of input.crossSell) {
    const motivo = motivoRemocaoCrossSell(porSku.get(cand.omie_codigo_produto));
    if (motivo) crossSellRemovidos.push({ nome: cand.nome, motivo });
    else crossSellOk.push({ omie_codigo_produto: cand.omie_codigo_produto, nome: cand.nome });
  }

  const travasGerais: MotivoTravaGeral[] = [];
  if (linhas.length === 0) travasGerais.push('cesta_vazia');
  if (!input.prazoEntrega) travasGerais.push('sem_prazo');
  if (!input.primeiroNome || input.primeiroNome.trim() === '') travasGerais.push('sem_nome');
  if (!input.telefone || input.telefone.trim() === '') travasGerais.push('sem_telefone');

  const travada = travasGerais.length > 0 || linhas.some(l => l.motivoTrava !== null);
  // total só quando NADA travou — soma parcial seria número fabricado
  const total = travada ? null : linhas.reduce((acc, l) => acc + l.qtd * (l.preco as number), 0);

  return { linhas, crossSellOk, crossSellRemovidos, travasGerais, travada, total };
}

/** Params do template colacor_proposta_recompra: {{1}} nome · {{2}} prazo · {{3}} cesta compacta.
 * O {{3}} é COMPACTO (a edge achataria \n em ", " de qualquer forma) e NÃO repete a saudação
 * (o corpo do template já tem "Olá, {{1}}!"). */
export function montarParamsProposta(input: {
  primeiroNome: string;
  prazoLabel: string;
  linhas: LinhaCotada[];
  crossSellOk: { nome: string }[];
}): [string, string, string] {
  const itens = input.linhas.map(l => `${fmtQty(l.qtd)}× ${l.nome}`);
  const partes = [itens.join('; ')];
  if (input.crossSellOk.length === 1) partes.push(`sugestão: ${input.crossSellOk[0].nome}`);
  else if (input.crossSellOk.length > 1) partes.push(`sugestões: ${input.crossSellOk.map(x => x.nome).join(', ')}`);
  return [input.primeiroNome, input.prazoLabel, partes.join('; ')];
}

function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Data de entrega determinística da fila: rota de amanhã (routeDate) ou, em dia só-diárias,
 * amanhã (a diária entrega todo dia). Não derivável → null (trava sem_prazo — nunca fabricar). */
export function formatarPrazoEntrega(
  workdayIso: string,
  routeDate: string | null,
  dailyOnly: boolean,
): { iso: string; label: string } | null {
  const amanha = addDaysIso(workdayIso, 1);
  if (routeDate) {
    return { iso: routeDate, label: routeDate === amanha ? `amanhã (${ddmm(routeDate)})` : ddmm(routeDate) };
  }
  if (dailyOnly) return { iso: amanha, label: `amanhã (${ddmm(amanha)})` };
  return null;
}
