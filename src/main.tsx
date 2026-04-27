import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

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

createRoot(document.getElementById("root")!).render(<App />);
