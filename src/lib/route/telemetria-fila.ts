/**
 * Telemetria da fila de ligação por rota (/rota/ligacoes).
 *
 * PROBLEMA QUE ISTO RESOLVE: a tela tinha 4 desfechos que produziam o MESMO
 * pixel — "sem rota hoje". Com `route_contact_log` e `route_queue_snapshot`
 * zerados desde a origem, era impossível distinguir "a vendedora nunca abriu"
 * de "abriu e veio vazia" de "abriu e quebrou". O $pageview (PageViewTracker)
 * responde só a primeira; estes eventos respondem o resto.
 *
 * O MOTIVO É DECLARADO, NUNCA INFERIDO. Inferir dos totais erra: capacidade 0
 * e "nenhum candidato" produzem ambos `excluidos: []` — classificar um como o
 * outro é fabricar diagnóstico (money-path §2: ausente ≠ zero).
 */

export type MotivoFilaVazia =
  | 'sem_cidade'       // a rota D-1 não tem cidade programada (dia legítimo sem rota)
  | 'sem_candidato'    // há cidade, mas nenhum cliente da carteira mora nela
  | 'todos_excluidos'  // há candidatos, mas todos caíram num gate (opt-out/cadência/valor/jit)
  | 'sem_capacidade';  // candidatos passaram o gate e a fila AINDA saiu vazia (cap=0)

export interface ContagensFila {
  nCidades: number;
  nCandidatos: number;
  /** candidatos que sobreviveram aos gates de `buildContactList`. */
  nVivos: number;
  nFila: number;
}

/**
 * Classifica POR QUE a fila saiu vazia, a partir das contagens que o queryFn
 * tem em mãos no momento de cada saída. Ordem = da causa mais a montante para
 * a mais a jusante, para que o motivo aponte a origem e não o sintoma.
 */
export function classificarFilaVazia(c: ContagensFila): MotivoFilaVazia | null {
  if (c.nFila > 0) return null;
  if (c.nCidades === 0) return 'sem_cidade';
  if (c.nCandidatos === 0) return 'sem_candidato';
  if (c.nVivos === 0) return 'todos_excluidos';
  return 'sem_capacidade';
}

/** Recorte de `RouteContactListData` que a telemetria lê. Estrutural de propósito:
 *  não arrasta o client Supabase para o teste. */
export interface FilaObservada {
  callQueue: readonly unknown[];
  resolvidosQueue: readonly unknown[];
  excluidos: readonly unknown[];
  cidades: readonly string[];
  routeDate: string | null;
  dailyOnly: boolean;
  cadenciaIndisponivel: boolean;
  motivoFilaVazia: MotivoFilaVazia | null;
}

export interface EstadoConsultaFila {
  isLoading: boolean;
  isError: boolean;
  mensagemErro?: string | null;
  data: FilaObservada | undefined;
}

export interface EventoFila {
  evento: string;
  props: Record<string, string | number | boolean | null>;
  /** Identidade do DESFECHO — o chamador emite 1× por chave, não por render. */
  chave: string;
}

/**
 * Traduz o estado do useQuery no evento a emitir (ou null, quando ainda não há
 * desfecho). O erro vem ANTES do data porque o React Query preserva o `data` do
 * fetch anterior quando `isError` — sem esta ordem, uma query que PASSOU a
 * falhar seguiria reportando sucesso com o retrato velho.
 */
export function eventoDaFila(estado: EstadoConsultaFila): EventoFila | null {
  if (estado.isError) {
    const mensagem = estado.mensagemErro || '(sem mensagem)';
    return { evento: 'rota.fila_erro', props: { mensagem }, chave: `erro:${mensagem}` };
  }
  if (estado.isLoading) return null;
  const d = estado.data;
  if (!d) return null;

  const nFila = d.callQueue.length;
  const props = {
    n_fila: nFila,
    n_resolvidos: d.resolvidosQueue.length,
    n_excluidos: d.excluidos.length,
    n_cidades: d.cidades.length,
    route_date: d.routeDate,
    daily_only: d.dailyOnly,
    cadencia_indisponivel: d.cadenciaIndisponivel,
  };

  if (nFila === 0) {
    // Fila vazia SEM motivo declarado é um buraco de instrumentação, não um
    // motivo — reportá-lo como 'desconhecido' mantém o sinal honesto em vez de
    // escolher o palpite mais provável.
    const motivo = d.motivoFilaVazia ?? 'desconhecido';
    return {
      evento: 'rota.fila_vazia',
      props: { ...props, motivo },
      chave: `vazia:${d.routeDate}:${motivo}`,
    };
  }

  return { evento: 'rota.fila_carregada', props, chave: `carregada:${d.routeDate}:${nFila}` };
}
