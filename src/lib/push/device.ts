import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';

/** Push API disponível neste navegador? */
export function suportaPush(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Limpeza no LOGOUT (chamada pelo AuthContext, best-effort): desinscreve o
 * device e apaga a linha — senão a próxima pessoa que logar neste device
 * recebe os pushes de quem saiu (device compartilhado de balcão). Vive em
 * lib/ (não no hook) pra não criar ciclo AuthContext → hook → AuthContext.
 * Nunca lança (logout não pode travar).
 */
export async function limparPushDoDevice(): Promise<void> {
  try {
    if (!suportaPush()) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    // RPC antes do unsubscribe (precisa da sessão ainda válida).
    await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  } catch (error) {
    logger.warn('Falha ao limpar push no logout (best-effort)', { stage: 'push_logout', error });
  }
}
