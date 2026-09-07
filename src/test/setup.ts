import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// Budget dos utilitários ASSÍNCRONOS do testing-library (`findBy*`, `waitFor`).
// Irmão esquecido do `testTimeout: 20000` do vitest.config.ts (#271): aquele PR subiu o teto do
// vitest 5s→20s porque o cold-start sob CPU saturada (M2 8GB) estourava o default — mas
// `findBy*`/`waitFor` NÃO são governados pelo testTimeout. Eles têm budget PRÓPRIO, o
// `asyncUtilTimeout` do @testing-library/dom, que seguiu no default de 1000ms. O resultado é uma
// armadilha de leitura: um `it(..., 15000)` aparenta 15s de folga enquanto o `findByRole` dentro
// dele morre em 1s — e o erro sai como "Unable to find role=..." (parece elemento ausente), não
// como timeout. Foi assim que SalesQuotes.accountGuard (money-path P0-B) piscou sob carga: medido,
// o caminho até a asserção levou 5.894ms sob load 59, contra um budget de 1s.
// O budget é WALL-CLOCK, mas o trabalho (render + varredura a11y) é CPU-bound: com a máquina
// dividida entre dezenas de processos, 1000ms não compra nem as primeiras tentativas do retry.
// 5000ms = 5× o default e ainda 4× ABAIXO do testTimeout de 20s — a folga importa nos dois
// sentidos: quem nunca resolve continua falhando, e falha COM o dump de DOM do testing-library
// em vez do timeout opaco do vitest, que é o que torna o vermelho diagnosticável.
configure({ asyncUtilTimeout: 5000 });

// Newer Node (22+) ships an experimental global `localStorage` that is
// non-functional without `--localstorage-file`, and it can shadow jsdom's
// implementation under vitest. The supabase client references `localStorage`
// at module top-level, so any test importing it crashes. Install a working
// in-memory Storage shim whenever the ambient storage is missing OR broken
// (a `typeof === "undefined"` guard is insufficient: Node's is defined-but-broken).
function installStorageShim(name: "localStorage" | "sessionStorage") {
  try {
    const existing = (globalThis as unknown as Record<string, Storage | undefined>)[name];
    if (existing) {
      existing.setItem("__probe__", "1");
      existing.removeItem("__probe__");
      return; // already functional — leave it alone
    }
  } catch {
    // fall through and install the shim
  }
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, name, {
    value: shim,
    writable: true,
    configurable: true,
  });
}
installStorageShim("localStorage");
installStorageShim("sessionStorage");

// jsdom doesn't ship WebRTC primitives — polyfill bare-minimum constructors
// so SipClient tests can `new MediaStream()` without pulling in a heavy mock lib.
if (typeof globalThis.MediaStream === "undefined") {
  class MediaStreamPolyfill {
    private tracks: MediaStreamTrack[];
    constructor(tracks: MediaStreamTrack[] = []) {
      this.tracks = [...tracks];
    }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t.kind === "audio");
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t.kind === "video");
    }
    addTrack(t: MediaStreamTrack) {
      this.tracks.push(t);
    }
  }
  // @ts-expect-error - shim
  globalThis.MediaStream = MediaStreamPolyfill;
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
