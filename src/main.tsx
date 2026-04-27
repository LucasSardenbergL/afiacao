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

if ((isInLovablePreview || isInIframe) && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => registration.unregister());
  });

  window.addEventListener("load", () => {
    caches.keys().then((cacheNames) => {
      cacheNames
        .filter((cacheName) => cacheName.includes("workbox") || cacheName.includes("supabase"))
        .forEach((cacheName) => caches.delete(cacheName));
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
