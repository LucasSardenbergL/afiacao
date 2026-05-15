import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';

/**
 * Limpa scroll-locks e pointer-events deixados por overlays Radix
 * (Dialog/Sheet/DropdownMenu/Select) que não foram fechados corretamente
 * — bug conhecido quando o usuário muda de rota com overlay aberto ou
 * quando vários overlays se fecham fora de ordem.
 */
function useRadixScrollLockCleanup() {
  const location = useLocation();
  useEffect(() => {
    const cleanup = () => {
      const body = document.body;
      // Só limpa se não houver overlay Radix realmente aberto
      const hasOpenOverlay = document.querySelector(
        '[data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"], [data-radix-popper-content-wrapper]'
      );
      if (!hasOpenOverlay) {
        body.style.pointerEvents = '';
        body.style.overflow = '';
        body.style.removeProperty('margin-right');
        body.removeAttribute('data-scroll-locked');
      }
    };
    // Pequeno delay para deixar Radix terminar suas próprias animações de fechamento
    const t = setTimeout(cleanup, 100);
    return () => clearTimeout(t);
  }, [location.pathname]);
}

export function AppShellLayout() {
  useRadixScrollLockCleanup();
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
