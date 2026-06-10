import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { montarMensagemOtimista } from '@/lib/whatsapp/thread-cache';
import type { WaMessage } from '@/queries/useWhatsappInbox';

/** Tenta ler o campo `error` do corpo JSON quando a edge responde não-2xx (invoke lança antes). */
async function extractEdgeErrorCode(error: unknown): Promise<string> {
  const ctx = (error as { context?: { json?: () => Promise<unknown> } })?.context;
  if (ctx?.json) {
    try {
      const body = await ctx.json();
      const code = (body as { error?: string })?.error;
      if (typeof code === 'string') return code;
    } catch { /* corpo não-JSON */ }
  }
  return (error as { message?: string })?.message ?? '';
}

export function useSendWhatsapp(conversationId: string | undefined) {
  const qc = useQueryClient();
  const threadKey = ['whatsapp', 'thread', conversationId] as const;
  return useMutation({
    mutationFn: async (text: string) => {
      const { data, error } = await supabase.functions.invoke('whatsapp-send', {
        body: { conversationId, text },
      });
      if (error) throw new Error(await extractEdgeErrorCode(error));
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data;
    },
    // Optimistic: a mensagem aparece na thread NO CLIQUE — antes ela só
    // surgia após edge (whatsapp-send → 360dialog, 1-3s+) + invalidate +
    // refetch, parecendo que o envio não funcionou (anti-padrão de chat).
    onMutate: async (text: string) => {
      if (!conversationId) return { otimistaId: null as string | null };
      await qc.cancelQueries({ queryKey: threadKey });
      const otimista = montarMensagemOtimista(conversationId, text, new Date().toISOString());
      qc.setQueryData<WaMessage[]>(threadKey, (old) => (old ? [...old, otimista] : [otimista]));
      return { otimistaId: otimista.id as string | null };
    },
    // Rollback CIRÚRGICO por id (NUNCA snapshot-restore): o cache da thread é
    // alimentado por realtime — restaurar um snapshot apagaria mensagens
    // INBOUND do cliente chegadas durante o send, e com 2 envios em voo
    // ressuscitaria a otimista do envio anterior (revisão adversarial).
    onError: (e: Error, _text, ctx) => {
      if (ctx?.otimistaId) {
        qc.setQueryData<WaMessage[]>(threadKey, (old) =>
          old ? old.filter((m) => m.id !== ctx.otimistaId) : old,
        );
      }
      toast.error(e.message === 'window_closed' ? 'Janela de 24h fechada — precisa de template (PR2).' : 'Falha ao enviar.');
    },
    onSuccess: (data) => {
      // A edge envia ao cliente ANTES de persistir e responde persisted:false
      // se só a persistência falhou — nesse caso NÃO invalidar (o refetch
      // apagaria a otimista e a vendedora re-enviaria → cliente recebe 2×).
      if ((data as { persisted?: boolean })?.persisted === false) {
        toast.warning('Mensagem enviada ao cliente, mas não registrada no histórico.');
        return;
      }
      // Reconciliação: o realtime já costuma trocar a otimista pela mensagem
      // real (append no cache); o invalidate é a rede pra qualquer divergência.
      qc.invalidateQueries({ queryKey: threadKey });
    },
  });
}
