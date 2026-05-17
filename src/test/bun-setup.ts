// Preload para `bun test` (runner nativo do bun). Espelha o que `src/test/setup.ts`
// faz pro vitest, já que o bun não usa vitest.config.ts e não roda em jsdom.
//
// Sem isso, qualquer test que importa (direta ou indiretamente) o supabase client
// quebra porque `src/integrations/supabase/client.ts` referencia `localStorage`
// no top-level.

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const localStorageShim: Storage = {
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
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageShim,
    writable: true,
    configurable: true,
  });
}

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

if (typeof globalThis.matchMedia === "undefined") {
  Object.defineProperty(globalThis, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
