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
  const clearPreviewCaches = async () => {
    const registrations = "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : [];

    await Promise.all(registrations.map((registration) => registration.unregister()));

    if ("caches" in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
    }

    if (navigator.serviceWorker?.controller && !sessionStorage.getItem("preview-sw-cleaned")) {
      sessionStorage.setItem("preview-sw-cleaned", "true");
      window.location.reload();
    }
  };

  clearPreviewCaches().catch(() => {
    // Preview cache cleanup is best-effort only.
  });
}

createRoot(document.getElementById("root")!).render(<App />);
