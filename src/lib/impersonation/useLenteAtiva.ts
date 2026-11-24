// "A lente 'Ver como' está ativa?" — reativo e SEM o contexto (lê o mesmo flag do write-guard, que o
// ImpersonationProvider liga antes de publicar o alvo). Para UI que só desliga uma ação externa na lente
// (WhatsApp na lista e na 360) e roda também fora do provider. É cosmético: a fronteira é o write-guard
// e o gate na fonte (o dialer), nunca este botão desligado.
import { useSyncExternalStore } from 'react';
import { assinarLente, isLensActive } from './lens-write-guard';

export function useLenteAtiva(): boolean {
  return useSyncExternalStore(assinarLente, isLensActive, () => false);
}
