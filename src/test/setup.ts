import "@testing-library/jest-dom";

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
