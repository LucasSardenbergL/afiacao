// Recomendações consultivas DETERMINÍSTICAS para o cliente (PR2 do benchmark #13).
// Regra de ouro (money-path): só regras determinísticas sobre dado confiável.
// Ausente ≠ zero — na dúvida a recomendação NÃO é gerada (degradação honesta),
// nunca se fabrica um número. Ver docs/historico/benchmark-concorrentes-marcenaria-2026-07.md.
import { parseISO, addDays, differenceInCalendarDays } from 'date-fns';

/**
 * Custo médio ESTIMADO de uma ferramenta nova (R$). É uma estimativa de negócio,
 * não um dado do cliente — espelha o AVG_NEW_TOOL_COST de SavingsDashboard.tsx.
 * Sempre exibido ao cliente com o rótulo "estimativa".
 */
export const CUSTO_MEDIO_FERRAMENTA_NOVA_BRL = 250;

export interface ToolInput {
  id: string;
  nome: string;
  /** Vencimento AGENDADO da próxima afiação (ISO) ou null se não agendada. */
  next_sharpening_due: string | null;
  /** Data da última afiação (ISO) ou null. */
  last_sharpened_at: string | null;
  /** Intervalo de afiação da própria ferramenta (dias) ou null. */
  sharpening_interval_days: number | null;
  /** Intervalo sugerido pela categoria (dias) ou null — fallback do anterior. */
  suggested_interval_days: number | null;
}

/** Agregados REAIS derivados dos pedidos entregues (nunca estimados). */
export interface EconomiaInput {
  /** Total de afiações realizadas (soma das quantidades dos itens entregues). */
  totalAfiacoes: number;
  /** Total efetivamente pago em afiação (R$, soma dos totais dos pedidos). */
  totalGastoReal: number;
}

export interface FerramentaAfetada {
  id: string;
  nome: string;
}

export type Recomendacao =
  | { tipo: 'possivelmente_atrasada'; ferramentas: FerramentaAfetada[] }
  | { tipo: 'nunca_afiada'; ferramentas: FerramentaAfetada[] }
  | { tipo: 'sem_programacao'; ferramentas: FerramentaAfetada[] }
  | {
      tipo: 'economia';
      /** Economia já realizada vs. comprar novas (R$). Sempre > 0 quando presente. */
      economiaComprovada: number;
      /** Projeção de afiar (em vez de trocar) as atrasadas (R$), ou null se indeterminável. */
      economiaPotencial: number | null;
      /** Nº de ferramentas atualmente atrasadas (agendadas-vencidas + possivelmente-atrasadas). */
      nAtrasadas: number;
    };

export interface GerarRecomendacoesInput {
  tools: ToolInput[];
  economia: EconomiaInput | null;
  /** Custo de ferramenta nova (R$). Default: CUSTO_MEDIO_FERRAMENTA_NOVA_BRL. */
  custoNovaEstimado?: number;
  /** "Hoje" injetável para testes determinísticos. Default: new Date(). */
  hoje?: Date;
}

/** Pedido entregue cru (items é jsonb → unknown; total pode faltar). */
export interface PedidoEntregueInput {
  items: unknown;
  total: number | null;
}

/** Intervalo de afiação efetivo (dias): o da ferramenta ou, na falta, o da categoria. */
function intervaloEfetivo(t: ToolInput): number | null {
  const dias = t.sharpening_interval_days ?? t.suggested_interval_days;
  return dias != null && dias > 0 ? dias : null;
}

/**
 * Ferramenta NÃO-agendada que já passou do ponto pela projeção última-afiação + intervalo.
 * Exige last_sharpened_at E intervalo — sem qualquer um, degrada (ausente ≠ atrasada).
 * Ferramenta agendada (com next_due) fica de fora: já é coberta pelo PriorityCard.
 */
function ehPossivelmenteAtrasada(t: ToolInput, hoje: Date): boolean {
  if (t.next_sharpening_due) return false;
  if (!t.last_sharpened_at) return false;
  const intervalo = intervaloEfetivo(t);
  if (intervalo == null) return false;
  const projetada = addDays(parseISO(t.last_sharpened_at), intervalo);
  return differenceInCalendarDays(hoje, projetada) > 0;
}

/**
 * Cadastrada mas SEM nenhuma afiação: não-agendada E nunca afiada. Independe do
 * intervalo — ter cadência não substitui a 1ª afiação, e sem `last` não há data
 * alguma para projetar. Fato verificável (não inferência). Atinge o cliente novo,
 * onde o empurrão mais importa. Precede `sem_programacao` (que exige já ter afiado).
 */
export function ehNuncaAfiada(t: Pick<ToolInput, 'next_sharpening_due' | 'last_sharpened_at'>): boolean {
  return t.next_sharpening_due == null && t.last_sharpened_at == null;
}

/**
 * JÁ afiou antes (last set), mas sem next_due E sem intervalo → sem base para o
 * próximo lembrete. O recorte `last != null` cede o caso "nunca afiada" à regra
 * `nunca_afiada` (baldes exclusivos: nenhuma ferramenta gera dois cards).
 */
function ehSemProgramacao(t: ToolInput): boolean {
  return t.last_sharpened_at != null && t.next_sharpening_due == null && intervaloEfetivo(t) == null;
}

/** Atrasada de fato: agendada-vencida OU possivelmente-atrasada (não-agendada projetada). */
function estaAtrasada(t: ToolInput, hoje: Date): boolean {
  if (t.next_sharpening_due) {
    return differenceInCalendarDays(hoje, parseISO(t.next_sharpening_due)) > 0;
  }
  return ehPossivelmenteAtrasada(t, hoje);
}

function calcularEconomia(
  tools: ToolInput[],
  economia: EconomiaInput,
  custoNova: number,
  hoje: Date,
): Extract<Recomendacao, { tipo: 'economia' }> | null {
  const { totalAfiacoes, totalGastoReal } = economia;
  // Sem histórico real não há base — nunca dividir 0/0 nem inflar com gasto zero.
  if (totalAfiacoes <= 0 || totalGastoReal <= 0) return null;

  const economiaComprovada = totalAfiacoes * custoNova - totalGastoReal;
  if (economiaComprovada <= 0) return null; // não anuncia economia ≤ 0

  const custoMedioAfiacaoReal = totalGastoReal / totalAfiacoes;
  const nAtrasadas = tools.filter((t) => estaAtrasada(t, hoje)).length;
  const economiaPotencial =
    nAtrasadas > 0 && custoNova > custoMedioAfiacaoReal
      ? nAtrasadas * (custoNova - custoMedioAfiacaoReal)
      : null;

  return { tipo: 'economia', economiaComprovada, economiaPotencial, nAtrasadas };
}

/**
 * Recomendações consultivas determinísticas, na ordem de prioridade:
 * possivelmente_atrasada → nunca_afiada → sem_programacao → economia.
 * Só entra o que o dado sustenta.
 */
export function gerarRecomendacoes(input: GerarRecomendacoesInput): Recomendacao[] {
  const { tools, economia } = input;
  const hoje = input.hoje ?? new Date();
  const custoNova = input.custoNovaEstimado ?? CUSTO_MEDIO_FERRAMENTA_NOVA_BRL;

  const recs: Recomendacao[] = [];

  const atrasadas = tools.filter((t) => ehPossivelmenteAtrasada(t, hoje));
  if (atrasadas.length > 0) {
    recs.push({ tipo: 'possivelmente_atrasada', ferramentas: atrasadas.map((t) => ({ id: t.id, nome: t.nome })) });
  }

  const nuncaAfiadas = tools.filter(ehNuncaAfiada);
  if (nuncaAfiadas.length > 0) {
    recs.push({ tipo: 'nunca_afiada', ferramentas: nuncaAfiadas.map((t) => ({ id: t.id, nome: t.nome })) });
  }

  const semProgramacao = tools.filter(ehSemProgramacao);
  if (semProgramacao.length > 0) {
    recs.push({ tipo: 'sem_programacao', ferramentas: semProgramacao.map((t) => ({ id: t.id, nome: t.nome })) });
  }

  if (economia) {
    const eco = calcularEconomia(tools, economia, custoNova, hoje);
    if (eco) recs.push(eco);
  }

  return recs;
}

/**
 * Corte de APRESENTAÇÃO por tela: remove os tipos em `ocultarTipos`, preservando
 * a ordem dos demais. Ex.: a Central da Ferramenta já exibe um herói de economia,
 * então oculta ali o card 'economia' (não duplicar). Puro — não muta a entrada;
 * se o resultado ficar vazio, o consumidor não renderiza a seção (sem header órfão).
 */
export function filtrarRecomendacoes(
  recs: Recomendacao[],
  ocultarTipos: Recomendacao['tipo'][],
): Recomendacao[] {
  if (ocultarTipos.length === 0) return recs;
  return recs.filter((r) => !ocultarTipos.includes(r.tipo));
}

/**
 * Agrega pedidos entregues em totais REAIS. Parse defensivo do jsonb `items`:
 * item sem quantidade conta como 1 (espelha o SavingsDashboard); items não-array
 * e total nulo viram 0 — nunca quebram nem fabricam número.
 */
export function resumirEconomia(orders: PedidoEntregueInput[]): EconomiaInput {
  let totalAfiacoes = 0;
  let totalGastoReal = 0;

  for (const order of orders) {
    const items = Array.isArray(order.items) ? order.items : [];
    for (const item of items) {
      const q = Number((item as { quantity?: unknown } | null)?.quantity);
      totalAfiacoes += Number.isFinite(q) && q > 0 ? q : 1;
    }
    totalGastoReal += Number(order.total) || 0;
  }

  return { totalAfiacoes, totalGastoReal };
}
