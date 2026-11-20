/**
 * Fila do dia em "Gerir pedidos": a ORDEM é a do que falta fazer, não a alfabética.
 *
 * Quem abre a tela quer decidir o que dispara — então primeiro o que espera decisão humana,
 * depois o que falhou (re-disparar), depois o aprovado que ainda não saiu, e por último o que
 * já foi. Dentro do mesmo grupo, o pedido mais caro primeiro (é onde o erro custa mais).
 */

type PedidoDaFila = { status: string; valor_total: number | null; fornecedor_nome?: string | null };

const PRIORIDADE: Record<string, number> = {
  pendente_aprovacao: 0,
  bloqueado_guardrail: 0,
  falha_envio: 1,
  aprovado_aguardando_disparo: 2,
  disparado: 3,
  disparado_simulado: 3,
};
const SEM_PRIORIDADE = 4;

function prioridadeDaFila(status: string): number {
  return PRIORIDADE[status] ?? SEM_PRIORIDADE;
}

export function ordenarFilaDoDia<T extends PedidoDaFila>(lista: readonly T[]): T[] {
  return [...lista].sort((a, b) => {
    const pa = prioridadeDaFila(a.status);
    const pb = prioridadeDaFila(b.status);
    if (pa !== pb) return pa - pb;
    // valor ausente vai para o fim do grupo — não é "zero", é "não sei" (não ganha nem perde de ninguém).
    const va = a.valor_total ?? Number.NEGATIVE_INFINITY;
    const vb = b.valor_total ?? Number.NEGATIVE_INFINITY;
    if (va !== vb) return vb - va;
    return (a.fornecedor_nome ?? '').localeCompare(b.fornecedor_nome ?? '', 'pt-BR');
  });
}

export type ResumoDoDia = {
  aAprovar: number;
  falhou: number;
  aguardandoDisparo: number;
  disparados: number;
  /** Soma do valor do que está a aprovar. `null` quando NENHUM tem valor (ausente ≠ R$ 0). */
  valorAAprovar: number | null;
  /** Algum pedido a aprovar veio sem valor → a soma é um piso, não o total. */
  valorAAprovarParcial: boolean;
};

export function resumirFilaDoDia(lista: readonly PedidoDaFila[]): ResumoDoDia {
  let aAprovar = 0;
  let falhou = 0;
  let aguardandoDisparo = 0;
  let disparados = 0;
  let soma = 0;
  let comValor = 0;
  for (const p of lista) {
    const prio = prioridadeDaFila(p.status);
    if (prio === 0) {
      aAprovar++;
      if (p.valor_total != null && Number.isFinite(p.valor_total)) {
        soma += p.valor_total;
        comValor++;
      }
    } else if (prio === 1) falhou++;
    else if (prio === 2) aguardandoDisparo++;
    else if (prio === 3) disparados++;
  }
  return {
    aAprovar,
    falhou,
    aguardandoDisparo,
    disparados,
    valorAAprovar: comValor > 0 ? soma : aAprovar === 0 ? 0 : null,
    valorAAprovarParcial: comValor > 0 && comValor < aAprovar,
  };
}

/**
 * Aprovado que ainda não saiu NÃO pertence ao dia em que foi gerado: some da lista no dia
 * seguinte e o contador "aprovados sem disparo" mente (4505, 2026-11-20 — aprovado no ciclo de
 * 18/11, reenviado pelo founder, invisível em "Ciclo de hoje"). Junta à lista de hoje os
 * aprovados sem disparo de ciclos ANTERIORES, sem duplicar o que já veio no ciclo de hoje.
 */
export function mesclarAprovadosSemDisparo<
  T extends { id: number; status: string; data_ciclo: string },
>(hoje: readonly T[], anteriores: readonly T[], dataHoje: string): T[] {
  const ids = new Set(hoje.map((p) => p.id));
  const pendentes = anteriores.filter(
    (p) => p.status === 'aprovado_aguardando_disparo' && p.data_ciclo < dataHoje && !ids.has(p.id),
  );
  return [...hoje, ...pendentes];
}

/**
 * "Aprovar e disparar" só com os itens LIDOS: aprova-se o que se conferiu. Antes o botão só
 * exigia a condição de pagamento — com a leitura dos itens falhando a tabela ficava vazia e o
 * pedido podia ser disparado sem ninguém ter visto o que ia sair. Devolve o motivo do bloqueio
 * (texto para o title/aviso) ou `null` quando pode aprovar.
 */
export function motivoBloqueioAprovacao(m: {
  itensEstado: 'carregando' | 'erro' | 'ok';
  nItens: number;
  condicaoSelecionada: boolean;
}): string | null {
  if (m.itensEstado === 'carregando') return 'Carregando os itens do pedido…';
  if (m.itensEstado === 'erro') return 'Não consegui carregar os itens — tente de novo antes de aprovar';
  if (m.nItens === 0) return 'Pedido sem itens — nada a aprovar';
  if (!m.condicaoSelecionada) return 'Selecione a condição de pagamento antes de aprovar';
  return null;
}
