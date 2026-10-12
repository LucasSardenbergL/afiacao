import { useEffect } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { contadorDeEnqueues, flush, subscribeToOfflineQueue, type QueuedMutation } from '@/lib/offline-queue';
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import {
  credencialDaSessao,
  criarClienteDoDono,
  type ClienteSupabase,
  type CredencialDoDono,
} from '@/lib/offline-cliente-do-dono';
import { mensagemDeErro } from '@/lib/erro-mensagem';

/**
 * `cliente` assina com o token do DONO do item (conferido pelo `flush`) — o handler deve usar
 * ESTE cliente, nunca o singleton `supabase`: o singleton relê a sessão do aparelho a cada
 * requisição e pode sair com a identidade de outra pessoa.
 */
type Handler = (variables: unknown, cliente: ClienteSupabase) => Promise<boolean>;

interface HandlerEntry {
  handler: Handler;
  /** Query keys (prefixos) a invalidar quando um item deste kind drena com sucesso. */
  invalidateKeys?: readonly QueryKey[];
}

/** Registry global de handlers por kind. */
const handlers = new Map<string, HandlerEntry>();

/** Espera antes de tentar de novo uma rodada que não atendeu o pedido (ver `reagendado`). */
export const REAGENDAR_EM_CURSO_MS = 3000;

/**
 * Registra um handler que processará mutations enfileiradas de um determinado kind.
 * Chamar uma única vez (e.g. no mount da página que faz a mutação).
 *
 * Handler retorna:
 *  - true: mutação aplicou; item é removido da fila
 *  - false: mutação ainda falha; item fica na fila com attempts++
 *  - throw: idem
 *
 * `invalidateKeys`: quando o flush drena um item deste kind com sucesso, estas
 * query keys são invalidadas — sem isso, o cache do React Query fica com o estado
 * pré-sync (unidade conferida offline "some" até um refetch natural). Prefixo:
 * ['nfe_conferencia'] casa ['nfe_conferencia', id].
 */
export function registerOfflineHandler<TVars>(
  kind: string,
  handler: (variables: TVars, cliente: ClienteSupabase) => Promise<boolean>,
  invalidateKeys?: readonly QueryKey[],
): () => void {
  handlers.set(kind, { handler: handler as Handler, invalidateKeys });
  return () => handlers.delete(kind);
}

/**
 * Hook montado uma vez (no AppShell). Escuta 'online' event e dispara flush
 * que despacha cada item da fila pro handler registrado pra aquele kind.
 * Kinds sem handler registrado ficam na fila (não-destrutivo).
 */
export function useOfflineFlush(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    // Guard de re-entrância: flush() chama writeQueue(), que re-emite pra fila.
    // Sem isso, um item que FALHA persistentemente (ex. RLS) fica na fila → o re-emit
    // re-dispara o flush → loop infinito martelando o backend. O guard garante que o
    // re-emit disparado pelo próprio flush seja ignorado enquanto ele roda.
    let flushing = false;
    // O pedido de drenar não pode morrer quando a rodada não o atende: (a) recusada porque outra
    // (desta aba ou de outra) estava em curso — essa trabalha sobre o snapshot DELA; (b) item
    // enfileirado DURANTE a própria rodada (o re-emit dele caiu no guard `flushing`). Tenta de
    // novo; a tentativa recusada é local (Web Lock), sem rede. Item que só FALHA não reagenda
    // (nem emCurso nem enqueue novo) — sem loop martelando o backend.
    let reagendado: ReturnType<typeof setTimeout> | null = null;
    const runFlush = async () => {
      if (flushing) return;
      flushing = true;
      // Kinds que drenaram nesta rodada → suas query keys são revalidadas ao fim,
      // pra UI refletir a verdade do servidor após a fila esvaziar.
      const succeededKinds = new Set<string>();
      // Um cliente por token: a credencial muda (refresh, outra pessoa) → cliente novo.
      let clienteDoDono: { token: string; cliente: ClienteSupabase } | null = null;
      const dispatcher = async (m: QueuedMutation, credencial: CredencialDoDono): Promise<boolean> => {
        const entry = handlers.get(m.kind);
        if (!entry) {
          logger.warn('Offline flush: nenhum handler para kind', { kind: m.kind });
          return false;
        }
        if (clienteDoDono?.token !== credencial.accessToken) {
          clienteDoDono = { token: credencial.accessToken, cliente: criarClienteDoDono(credencial.accessToken) };
        }
        try {
          const ok = await entry.handler(m.variables, clienteDoDono.cliente);
          if (ok) succeededKinds.add(m.kind);
          return ok;
        } catch (e) {
          logger.warn('Offline flush: handler throw', {
            kind: m.kind,
            error: mensagemDeErro(e) ?? '(sem mensagem)',
          });
          return false;
        }
      };
      try {
        // Só os itens do dono da credencial atual saem, assinados com ELA — o resto fica retido.
        const enqueuesAntes = contadorDeEnqueues();
        const resultado = await flush(dispatcher, credencialDaSessao);
        const chegouDurante = contadorDeEnqueues() !== enqueuesAntes;
        if ((resultado.emCurso || chegouDurante) && reagendado === null) {
          reagendado = setTimeout(() => {
            reagendado = null;
            void runFlush();
          }, REAGENDAR_EM_CURSO_MS);
        }
        // Revalidação pós-flush (non-blocking): reconcilia o cache com o servidor
        // pros kinds que efetivamente drenaram. Sem isto, o que foi confirmado
        // offline só aparecia no próximo refetch natural (dívida corrigida).
        for (const kind of succeededKinds) {
          for (const key of handlers.get(kind)?.invalidateKeys ?? []) {
            void queryClient.invalidateQueries({ queryKey: key });
          }
        }
      } finally {
        flushing = false;
      }
    };

    const onOnline = () => {
      void runFlush();
    };

    window.addEventListener('online', onOnline);

    // Quem volta a entrar no aparelho drena os itens DELE que ficaram retidos enquanto outra
    // pessoa estava logada (a fila não emite nada no login — sem isto, só no próximo 'online').
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' && typeof navigator !== 'undefined' && navigator.onLine) {
        // Fora do callback: chamar o client de dentro do onAuthStateChange trava o auth-js.
        setTimeout(() => void runFlush(), 0);
      }
    });

    // Ao montar, se já tem itens E está online, tenta flush imediatamente.
    const unsub = subscribeToOfflineQueue((depth) => {
      if (depth > 0 && typeof navigator !== 'undefined' && navigator.onLine) {
        void runFlush();
      }
    });

    return () => {
      window.removeEventListener('online', onOnline);
      subscription.unsubscribe();
      unsub();
      if (reagendado !== null) clearTimeout(reagendado);
    };
  }, [queryClient]);
}

/** Helper de teste — não exportar via barrel. */
export function __clearHandlersForTest(): void {
  handlers.clear();
}
