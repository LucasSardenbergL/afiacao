import "@testing-library/jest-dom";

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
