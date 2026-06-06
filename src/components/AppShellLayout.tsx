import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';
import { IncomingCallModal } from './call/IncomingCallModal';
import { TransferSpikePanel } from './call/TransferSpikePanel';

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

export function AppShellLayout() {
  useRadixScrollLockCleanup();
  return (
    <AppShell>
      <Outlet />
      {/* PR-INBOUND-CALLS: modal global pra chamadas inbound em qualquer tela autenticada */}
      <IncomingCallModal />
      {/* SPIKE (flag telefoniaTransferSpike): painel de teste de transferência *2/REFER */}
      <TransferSpikePanel />
    </AppShell>
  );
}
