import { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';
import { IncomingCallModal } from './call/IncomingCallModal';
import { useAuth } from '@/contexts/AuthContext';

/**
 * CallCopilotHud arrasta TranscriptionPanel → framer-motion (~41KB gzip) e o
 * restante do copiloto pro entry se importado estático — medido no build
 * (vendor-motion aparecia no modulepreload do index.html). Lazy + gate por
 * staff tira tudo do caminho crítico: não-staff nunca baixa; staff baixa no
 * idle pós-boot (bem antes de qualquer chamada — o próprio WebRTCCallProvider
 * é lazy e ainda precisa registrar no SIP).
 *
 * ⚠️ IncomingCallModal fica EAGER de propósito: é o caminho operacional de
 * ATENDER chamada (lazy frio em 4G = chamada tocando sem botão de atender).
 * Ele não importa framer-motion — o peso que importa sai pelo HUD/Spike.
 */
const CallCopilotHud = lazy(() =>
  import('./call/CallCopilotHud').then((m) => ({ default: m.CallCopilotHud }))
);
const TransferSpikePanel = lazy(() =>
  import('./call/TransferSpikePanel').then((m) => ({ default: m.TransferSpikePanel }))
);

/**
 * Limpa scroll-locks e pointer-events deixados por overlays Radix
 * (Dialog/Sheet/DropdownMenu/Select) que não foram fechados corretamente
 * — bug conhecido quando o usuário muda de rota com overlay aberto ou
 * quando vários overlays se fecham fora de ordem.
 *
 * Só Dialog/AlertDialog/Sheet bloqueiam scroll do body — popovers, tooltips
 * e dropdown menus não devem. Por isso só checamos role="dialog"/"alertdialog"
 * abertos antes de limpar, sem incluir [data-radix-popper-content-wrapper]
 * (que matchava tooltips em fade-out e fazia o cleanup ser pulado, deixando
 * a página com `body { overflow: hidden }` travada).
 */
function cleanupStuckScrollLock() {
  const body = document.body;
  const hasOpenLockingOverlay = document.querySelector(
    '[data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"]'
  );
  if (!hasOpenLockingOverlay) {
    body.style.pointerEvents = '';
    body.style.overflow = '';
    body.style.removeProperty('margin-right');
    body.removeAttribute('data-scroll-locked');
  }
}

function useRadixScrollLockCleanup() {
  const location = useLocation();

  // Cleanup ao trocar de rota
  useEffect(() => {
    const t = setTimeout(cleanupStuckScrollLock, 100);
    return () => clearTimeout(t);
  }, [location.pathname]);

  // Observa o body — se algo setar data-scroll-locked sem overlay aberto, limpa
  useEffect(() => {
    const observer = new MutationObserver(() => {
      // pequeno debounce para deixar Radix terminar
      requestAnimationFrame(() => setTimeout(cleanupStuckScrollLock, 150));
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-scroll-locked', 'style'],
    });
    return () => observer.disconnect();
  }, []);
}

/**
 * Extras de telefonia carregados fora do caminho crítico (ver comentário nos
 * lazy() acima). O gate por `ready` adia a montagem — e portanto o download do
 * chunk — pro idle do navegador, pra não competir com o first paint da rota.
 */
function LazyCallExtras() {
  const { isStaff } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isStaff) return;
    const go = () => setReady(true);
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(go, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    // Safari/iOS não tem requestIdleCallback
    const t = window.setTimeout(go, 1500);
    return () => window.clearTimeout(t);
  }, [isStaff]);

  if (!isStaff || !ready) return null;
  return (
    <Suspense fallback={null}>
      {/* Onda 1 / Fase 1: co-piloto flutuante global durante a ligação */}
      <CallCopilotHud />
      {/* SPIKE (flag telefoniaTransferSpike): painel de teste de transferência *2/REFER */}
      <TransferSpikePanel />
    </Suspense>
  );
}

export function AppShellLayout() {
  useRadixScrollLockCleanup();
  return (
    <AppShell>
      <Outlet />
      {/* PR-INBOUND-CALLS: modal global pra chamadas inbound em qualquer tela autenticada */}
      <IncomingCallModal />
      <LazyCallExtras />
    </AppShell>
  );
}
