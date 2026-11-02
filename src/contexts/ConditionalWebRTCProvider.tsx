import { lazy, Suspense, type ReactNode } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { rotaCongelada } from '@/lib/modulos/congelamento';
import { MODULOS } from '@/lib/modulos/manifesto';

/**
 * Lazy-load do WebRTCCallProvider — importa SipClient (e transitivamente jssip)
 * apenas quando o Provider monta. Sem isso, jssip (~250KB) vai pro main bundle.
 *
 * O `.then((m) => ({ default: m.WebRTCCallProvider }))` é necessário porque
 * React.lazy espera default export, mas WebRTCCallProvider é named export.
 */
const WebRTCCallProvider = lazy(() =>
  import('./WebRTCCallContext').then((m) => ({ default: m.WebRTCCallProvider }))
);

/**
 * Monta o WebRTCCallProvider apenas para usuários staff (employee/master).
 *
 * Por quê: o Provider instancia um SipClient na hora do mount e tenta
 * REGISTER imediatamente via Edge Function `nvoip-sip-creds` (que rejeita
 * customers com 403). Para customers/anonymous, montar é desperdício +
 * polui logs com erros 403 esperados. E jssip (~250KB) fica fora do
 * bundle inicial pra todo mundo.
 *
 * Para staff, monta normalmente via Suspense — uma única instância
 * compartilhada via Context entre todos os <WebRTCDialer> da árvore.
 *
 * Módulo Telefonia congelado (M-41): não monta para NINGUÉM — sem o `import()`
 * do chunk (jssip), sem pedir credencial SIP e sem REGISTER do ramal. Os
 * consumidores leem o contexto opcional (null) e degradam: o dialer avisa,
 * o modal de entrada some, o FarmerCalls cai no cronômetro manual
 * (useCallBackendOpcional). Só a /telefonia exige o Provider — e ela própria
 * está congelada (rota redireciona).
 */
export function ConditionalWebRTCProvider({ children }: { children: ReactNode }) {
  const { isStaff } = useAuth();

  if (!isStaff || rotaCongelada('/telefonia', MODULOS)) {
    return <>{children}</>;
  }

  // Suspense fallback={children} mantém a árvore renderizada enquanto
  // o Provider carrega — sem flash de tela em branco. Os consumers que
  // tentarem useWebRTCCall() ANTES do Provider carregar vão lançar
  // (esperado — eles têm que estar dentro do Provider). Mas na prática
  // os consumers só rodam após a UI principal, então o lazy é transparente.
  return (
    <Suspense fallback={<>{children}</>}>
      <WebRTCCallProvider>{children}</WebRTCCallProvider>
    </Suspense>
  );
}
