import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';

/** Push API disponível neste navegador? */
export function suportaPush(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Teto de tempo do best-effort de logout. Rede de balcão (3G) resolve bem
 * antes; o teto só existe pra um await pendurado não travar o logout. */
const TETO_LIMPEZA_MS = 2_000;

/** Corre uma promessa com teto de tempo; rejeita se estourar. Necessário porque
 * `try/catch` só protege contra THROW — um `await` que nunca resolve (ex.:
 * `serviceWorker.ready` num preview/iframe sem SW ativo, ou uma RPC sem rede)
 * fica pendurado pra sempre e trava quem deu `await`. */
function comTeto<T>(p: Promise<T>, ms: number, rotulo: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms: ${rotulo}`)), ms)
    ),
  ]);
}

/**
 * Limpeza no LOGOUT (chamada pelo AuthContext, best-effort): desinscreve o
 * device e apaga a linha — senão a próxima pessoa que logar neste device
 * recebe os pushes de quem saiu (device compartilhado de balcão). Vive em
 * lib/ (não no hook) pra não criar ciclo AuthContext → hook → AuthContext.
 * Nunca lança E nunca trava (o logout não pode depender de SW/rede) — daí o teto.
 */
export async function limparPushDoDevice(): Promise<void> {
  try {
    if (!suportaPush()) return;
    await comTeto(
      (async () => {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        // RPC antes do unsubscribe (precisa da sessão ainda válida).
        await supabase.rpc('delete_push_subscription', { p_endpoint: sub.endpoint });
        await sub.unsubscribe();
      })(),
      TETO_LIMPEZA_MS,
      'limparPushDoDevice',
    );
  } catch (error) {
    logger.warn('Falha ao limpar push no logout (best-effort)', { stage: 'push_logout', error });
  }
}
