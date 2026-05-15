import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';

/**
 * Limpa scroll-locks e pointer-events deixados por overlays Radix
 * (Dialog/Sheet/DropdownMenu/Select) que não foram fechados corretamente
 * — bug conhecido quando o usuário muda de rota com overlay aberto ou
 * quando vários overlays se fecham fora de ordem.
 */
function cleanupStuckScrollLock() {
  const body = document.body;
  const hasOpenOverlay = document.querySelector(
    '[data-state="open"][role="dialog"], [data-state="open"][role="alertdialog"], [data-radix-popper-content-wrapper]'
  );
  if (!hasOpenOverlay) {
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
    </AppShell>
  );
}
