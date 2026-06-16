import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

declare global {
  interface Window {
    /** Setado após o React montar; lido pelo watchdog de boot no index.html. */
    __APP_BOOTED__?: boolean;
  }
}

const isInLovablePreview =
  window.location.hostname.includes("id-preview--") ||
  window.location.hostname.includes("lovableproject.com");

const isInIframe = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

if (isInLovablePreview || isInIframe) {
  // Best-effort: unregister SWs and clear caches in background.
  // NEVER reload here — that can race with React mount and cause an infinite spinner.
  (async () => {
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      }
      if ("caches" in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map((n) => caches.delete(n)));
      }
    } catch {
      // ignore
    }
  })();
}

// Vite dispara este evento quando um dynamic import (chunk de rota lazy) falha
// ao carregar — causa #1 de tela branca/spinner pós-deploy (o chunk hash velho
// sumiu do servidor). Recarrega 1× pra buscar os chunks novos (guarda anti-loop).
window.addEventListener("vite:preloadError", () => {
  try {
    if (sessionStorage.getItem("__preload_error_reloaded__")) return;
    sessionStorage.setItem("__preload_error_reloaded__", "1");
  } catch {
    // sessionStorage indisponível: ainda assim recarrega (sem guarda).
  }
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(<App />);

// Sinaliza pro watchdog de boot (no index.html) que o bundle executou e o React
// montou. Limpar as guardas de recuperação permite que o watchdog/preloadError
// recuperem de novo caso uma falha POSTERIOR estrague o app na mesma sessão.
window.__APP_BOOTED__ = true;
try {
  sessionStorage.removeItem("__boot_recovery_attempted__");
  sessionStorage.removeItem("__preload_error_reloaded__");
} catch {
  // ignore
}
