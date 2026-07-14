// Travas da proposta 1-toque (PR-4): avalia a RECOTAÇÃO Omie (RPC get_whatsapp_proposta_cotacao)
// contra a cesta que o preview mostrou. PURO/testável. Money-path: linha sem preço/estoque/
// unidade/ativo/encontrada — ou com QUANTIDADE inválida (Codex P0: qtd 0/NaN derivada de
// histórico zerado virava "0× PRODUTO" na mensagem) — TRAVA A PROPOSTA INTEIRA (não sai
// parcial, não vira zero); total é NULL quando travada (nunca soma parcial). O render da
// mensagem nasce AQUI (corpo de referência do template + params) — template ilegível/inativo
// ou corpo >1024 chars (limite Meta) também travam (Codex P1/P2: a UI não pode habilitar
// envio de mensagem que a vendedora não viu ou que a Meta vai rejeitar). Cross-sell é
// RECOMENDAÇÃO (não promessa): item indisponível é removido com aviso — não cita preço
// nem entra no orçamento.

import { isValidUnitPrice } from '@/lib/pricing/mergeCustomerPrices';
import { fmtQty } from './proposta-format';
import { renderTemplatePreview } from './template-payload';
import { addDaysIso } from './route-schedule';
import type { CestaItem, CestaResult } from './cesta-recompra';
import type { CrossSellCand } from './cross-sell';

/** Limite do body de template da Meta (corpo renderizado, incluindo params). */
export const MAX_BODY_TEMPLATE_META = 1024;

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
  | 'qtd_invalida'          // qtd sugerida 0/negativa/NaN (histórico zerado não é proposta)
  | 'sem_estoque_info'      // estoque NULL/NaN/Inf = desconhecido ou não-confiável (≠ zero)
  | 'estoque_insuficiente'; // estoque < qtd sugerida

export type MotivoTravaGeral =
  | 'sem_prazo' | 'sem_nome' | 'sem_telefone' | 'cesta_vazia'
  | 'template_indisponivel' // corpo de referência ilegível → a vendedora não vê a mensagem exata
  | 'template_inativo'      // Meta ainda não aprovou → a edge recusaria (travar antes é honesto)
  | 'mensagem_longa'        // corpo renderizado > limite Meta
  | 'conversa_de_outro_cliente'; // telefone aponta conversa de OUTRO cliente (elo erraria)

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
  total: number | null;   // NULL quando travada — nunca soma parcial
  render: string | null;  // mensagem EXATA (corpo do template + params) — NULL quando travada
}

function estoqueConfiavel(estoque: number | null | undefined): estoque is number {
  return typeof estoque === 'number' && Number.isFinite(estoque);
}

/** Motivo de trava de uma linha da CESTA (precedência: identidade → catálogo → preço → qtd → estoque). */
function motivoTravaLinha(row: CotacaoRow | undefined, qtd: number): MotivoTravaLinha | null {
  if (!row) return 'nao_encontrado';
  if (!row.ativo) return 'inativo';
  if (!row.unidade || row.unidade.trim() === '') return 'sem_unidade';
  if (!isValidUnitPrice(row.preco)) return 'sem_preco';
  if (!(Number.isFinite(qtd) && qtd > 0)) return 'qtd_invalida';
  if (!estoqueConfiavel(row.estoque)) return 'sem_estoque_info';
  if (row.estoque < qtd) return 'estoque_insuficiente';
  return null;
}

/** Disponibilidade de um item de CROSS-SELL (não exige preço — a mensagem não o cita). */
function motivoRemocaoCrossSell(row: CotacaoRow | undefined): MotivoTravaLinha | null {
  if (!row) return 'nao_encontrado';
  if (!row.ativo) return 'inativo';
  if (!estoqueConfiavel(row.estoque)) return 'sem_estoque_info';
  if (row.estoque <= 0) return 'estoque_insuficiente';
  return null;
}

export function avaliarCotacaoProposta(input: {
  cesta: CestaResult;
  maxSecundarios?: number; // MESMA janela do texto do preview (default 3) — cota-se o que se envia
  crossSell: CrossSellCand[];
  cotacao: CotacaoRow[];
  nomesPorSku: Record<number, string>;
  prazoEntrega: { iso: string; label: string } | null;
  primeiroNome: string | null;
  telefone: string | null;
  /** Template lido do banco no clique; null = ilegível (trava — sem "mensagem exata" não há envio). */
  template: { corpoReferencia: string; ativo: boolean } | null;
  /** Travas detectadas pelo orquestrador (ex.: conversa pertence a outro cliente). */
  travasExtras?: MotivoTravaGeral[];
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

  const travasGerais: MotivoTravaGeral[] = [...(input.travasExtras ?? [])];
  if (linhas.length === 0) travasGerais.push('cesta_vazia');
  if (!input.prazoEntrega) travasGerais.push('sem_prazo');
  if (!input.primeiroNome || input.primeiroNome.trim() === '') travasGerais.push('sem_nome');
  if (!input.telefone || input.telefone.trim() === '') travasGerais.push('sem_telefone');
  if (!input.template) travasGerais.push('template_indisponivel');
  else if (!input.template.ativo) travasGerais.push('template_inativo');

  let travada = travasGerais.length > 0 || linhas.some(l => l.motivoTrava !== null);

  // render da mensagem EXATA — só computável sem travas (params completos)
  let render: string | null = null;
  if (!travada && input.template && input.prazoEntrega && input.primeiroNome) {
    render = renderTemplatePreview(input.template.corpoReferencia, montarParamsProposta({
      primeiroNome: input.primeiroNome,
      prazoLabel: input.prazoEntrega.label,
      linhas,
      crossSellOk,
    }));
    if (render.length > MAX_BODY_TEMPLATE_META) {
      travasGerais.push('mensagem_longa');
      travada = true;
      render = null;
    }
  }

  // total só quando NADA travou — soma parcial seria número fabricado
  const totalBruto = travada ? null : linhas.reduce((acc, l) => acc + l.qtd * (l.preco as number), 0);
  const total = totalBruto !== null && Number.isFinite(totalBruto) && totalBruto > 0 ? totalBruto : null;
  if (totalBruto !== null && total === null) travada = true; // defesa: total não-finito/≤0 jamais sai

  return { linhas, crossSellOk, crossSellRemovidos, travasGerais, travada, total, render };
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
