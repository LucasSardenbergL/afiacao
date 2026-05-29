import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export function useSendWhatsapp(conversationId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const { data, error } = await supabase.functions.invoke('whatsapp-send', {
        body: { conversationId, text },
      });
      if (error) throw error;
      if ((data as { error?: string })?.error) throw new Error((data as { error: string; detail?: string }).error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'thread', conversationId] }),
    onError: (e: Error) => {
      toast.error(e.message === 'window_closed' ? 'Janela de 24h fechada — precisa de template (PR2).' : 'Falha ao enviar.');
    },
  });
}
