import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

/** Carimbo de build: o Vite (`define`) substitui por uma string literal com o short SHA
 *  do commit, ou "dev" se o build não tiver git. O cron/verify-frontend.sh grepa o SHA
 *  da main nos bytes servidos → responde "o ar == origin/main?" sem adivinhar um ALVO. */
declare const __COMMIT_SHA__: string;
declare const __BUILD_ENV_KEYS__: string;
/** Constante de build: true só no build de produção non-preview (onde o VitePWA
 *  existe). Guarda o import de 'virtual:pwa-register' — quando false, o Vite DCE
 *  remove o bloco e o módulo virtual (ausente em dev/preview) nunca é referenciado. */
declare const __PWA_ENABLED__: boolean;

declare global {
  interface Window {
    /** Setado após o React montar; lido pelo watchdog de boot no index.html. */
    __APP_BOOTED__?: boolean;
    /** Short SHA do commit deste build (carimbo). Lido pela verificação de deploy. */
    __BUILD_SHA__?: string;
    /** PROBE temporário: nomes (sem valores) de env de build p/ achar a env de SHA do Lovable. */
    __BUILD_ENV_KEYS__?: string;
  }
}

// Carimba o SHA deste build no window logo no boot (side-effect — não é tree-shaken).
window.__BUILD_SHA__ = __COMMIT_SHA__;
window.__BUILD_ENV_KEYS__ = __BUILD_ENV_KEYS__;

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

// PWA em modo prompt: registra o SW e arma o toast de "atualização disponível"
// (substitui o injectRegister automático, agora `false`). Guardado por constante
// de build — em dev/preview o bloco some no DCE e nada importa virtual:pwa-register.
if (__PWA_ENABLED__) {
  import("./lib/pwa-update")
    .then((m) => m.setupPwaUpdatePrompt())
    .catch(() => {
      // Fallback offline-first: se o chunk do prompt falhar ao carregar (rede
      // instável no boot, chunk 404 pós-deploy), registra o SW direto — sem o
      // toast de update, mas o offline-first (não-negociável) é preservado.
      // Perder o SW porque um import lazy falhou seria uma regressão pior.
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {
          // best-effort: registro falhou de vez; não pode derrubar o app
        });
      }
    });
}

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
