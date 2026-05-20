import "@testing-library/jest-dom";

// jsdom não expõe localStorage/sessionStorage quando a origem do documento é opaca
// (sem URL com origem real). Polyfill in-memory equivalente ao browser, pra os testes
// que usam Storage (route-tracker, useLastVisit, useFinanceiroRegime) rodarem determinístico.
// Guardado: se o ambiente já tem Storage (jsdom com origem real), não sobrescreve.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}
for (const prop of ["localStorage", "sessionStorage"] as const) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g[prop]) {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, prop, { writable: true, configurable: true, value: storage });
    if (typeof g.window === "object" && g.window) {
      Object.defineProperty(g.window, prop, { writable: true, configurable: true, value: storage });
    }
  }
}

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
