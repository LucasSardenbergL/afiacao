import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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
  return useMutation({
    mutationFn: async (text: string) => {
      const { data, error } = await supabase.functions.invoke('whatsapp-send', {
        body: { conversationId, text },
      });
      if (error) throw new Error(await extractEdgeErrorCode(error));
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'thread', conversationId] }),
    onError: (e: Error) => {
      toast.error(e.message === 'window_closed' ? 'Janela de 24h fechada — precisa de template (PR2).' : 'Falha ao enviar.');
    },
  });
}
