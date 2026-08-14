/**
 * Telemetria da fila do Plano Tático (PTPL, `/farmer/tactical-plan`).
 *
 * PROBLEMA QUE ISTO RESOLVE: 533 planos gerados, ZERO desfecho registrado, e ZERO `track()`
 * na tela inteira (medido 2026-08-13 — docs/historico/fila-plano-tatico.md, errata). Sem
 * sensor não há como separar "não abrem a tela" de "abrem e não registram", e a fase N+1
 * dessa investigação depende exatamente dessa separação. Instalar o sensor É a fase N+1.
 *
 * A ABERTURA JÁ ESTÁ COBERTA. A rota vive dentro do `AppShellLayout` → `AppShell` →
 * `PageViewTracker`, que emite `$pageview` a cada mudança de rota. Duplicar isso criaria um
 * SEGUNDO denominador, divergente do primeiro, para a mesma pergunta. O que faltava — e o que
 * estes eventos entregam — é o DESFECHO da abertura: veio fila, veio vazia (por qual motivo),
 * ou quebrou.
 *
 * O MOTIVO É DECLARADO NO PONTO QUE SABE, NUNCA INFERIDO. `loadPlans` tem quatro saídas e
 * três delas produzem o MESMO pixel na tela ("Nenhum plano pendente"):
 *
 *   1. sem id efetivo    → sai antes de consultar qualquer coisa
 *                          (o identificador não é citado aqui de propósito: o gate
 *                           anti-write-leak o varre por TEXTO, e este módulo não tem
 *                           por que mencioná-lo nem em prosa)
 *   2. `error` da consulta → a lista MORREU (e o `error` era descartado no destructuring)
 *   3. `data` vazio        → o recorte respondeu e não tem plano
 *   4. `catch`             → exceção; a lista ANTIGA continua na tela
 *
 * Reconstruir o motivo a partir dos totais classificaria (2) como (3) — falha de consulta
 * lida como "não há plano" é fabricar diagnóstico (money-path §2: ausente ≠ zero).
 */

// `import type` de propósito: é apagado na compilação, então não cria ciclo em runtime com o
// hook (que importa este módulo). O tipo é do domínio da fila; o hook é só onde ele mora hoje.
import type { FiltroFila } from '@/hooks/useTacticalPlan';

// Não exportados: só `SaidaDaCarga` e `eventoDaCarga` atravessam a fronteira do módulo, e
// export sem consumidor quebra o gate de dead code (knip) — que é um gate à parte de
// typecheck/lint/test, com visão própria.
type MotivoFilaVazia =
  | 'sem_escopo'    // não havia id efetivo — a carga nem chegou a consultar
  | 'sem_resposta'  // sem `error` E sem `data`: indecidível, declarado como tal
  | 'recorte_vazio'; // a consulta RESPONDEU e o recorte não tem nenhum plano

/** De onde veio a falha. `consulta` = o PostgREST devolveu `error`; `excecao` = throw no try. */
type OrigemErroFila = 'consulta' | 'excecao';

/**
 * O que cada saída de `loadPlans` observa. Note que a variante de ERRO **não carrega tamanho
 * de lista** — e isso é a garantia estrutural da precedência do erro sobre `data`: no caminho
 * de exceção o `plans` do hook é o retrato do carregamento ANTERIOR, e uma carga que passou a
 * falhar seguiria reportando sucesso com o número velho se o tipo permitisse. Aqui não permite.
 */
export type SaidaDaCarga =
  | { tipo: 'vazia'; motivo: MotivoFilaVazia }
  | {
      tipo: 'erro';
      origem: OrigemErroFila;
      mensagem: string | null;
      /**
       * A tela ficou com a lista ANTIGA? Declarado pelo chamador porque só ele sabe: o ramo de
       * `error` faz `setPlans([])`, o `catch` não toca em `plans`. Sem este campo ninguém
       * distingue "quebrou e esvaziou" de "quebrou e está exibindo dado velho como se fosse atual".
       */
      manteveLista: boolean;
    }
  | { tipo: 'lista'; nExibidos: number };

export interface ContextoCarga {
  filtro: FiltroFila;
  /** Total sob o MESMO recorte da lista. `null` = não apurado (a contagem falhou ou nem rodou). */
  total: number | null;
}

export interface EventoFila {
  evento: string;
  props: Record<string, string | number | boolean | null>;
}

/**
 * Traduz a saída observada no evento a emitir. Chamado UMA vez por carga (dentro do
 * `loadPlans`, que roda por carregamento e não por render) — não precisa de dedupe por chave.
 */
export function eventoDaCarga(saida: SaidaDaCarga, ctx: ContextoCarga): EventoFila {
  // `total` viaja como `null` quando não apurado, nunca como 0: "0 pendentes" é
  // indistinguível de "a contagem morreu" — a mesma família do `Number(null) === 0`.
  const base = { filtro: ctx.filtro, total: ctx.total };

  if (saida.tipo === 'erro') {
    return {
      evento: 'plano_tatico.fila_erro',
      props: {
        ...base,
        origem: saida.origem,
        // Sem mensagem utilizável, admite a ausência em vez de inventar um diagnóstico.
        mensagem: saida.mensagem || '(sem mensagem)',
        manteve_lista: saida.manteveLista,
      },
    };
  }

  if (saida.tipo === 'vazia') {
    // Sem `n_exibidos` de propósito: nestas saídas o `plans` do hook não foi reescrito, então
    // afirmar "0 na tela" seria alegar um fato que este ponto do código não observou.
    return { evento: 'plano_tatico.fila_vazia', props: { ...base, motivo: saida.motivo } };
  }

  if (saida.nExibidos === 0) {
    return {
      evento: 'plano_tatico.fila_vazia',
      props: { ...base, motivo: 'recorte_vazio' satisfies MotivoFilaVazia, n_exibidos: 0 },
    };
  }

  return { evento: 'plano_tatico.fila_carregada', props: { ...base, n_exibidos: saida.nExibidos } };
}
