import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mixPrerollWithMic } from './audio-preroll';

describe('mixPrerollWithMic', () => {
  // Test mock — typing the AudioContext mock shape exhaustively adds noise without value
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let audioContextMock: any;
  let destinationStream: MediaStream;

  beforeEach(() => {
    destinationStream = new MediaStream();
    audioContextMock = {
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
      createMediaStreamDestination: vi.fn(() => ({ stream: destinationStream, connect: vi.fn() })),
      createBufferSource: vi.fn(() => ({
        connect: vi.fn(),
        start: vi.fn(),
        onended: null,
        buffer: null,
      })),
      decodeAudioData: vi.fn().mockResolvedValue({ duration: 5 }),
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('AudioContext', vi.fn(() => audioContextMock));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retorna MediaStream mixado e baixa o MP3 fornecido', async () => {
    const micStream = new MediaStream();
    const result = await mixPrerollWithMic('/preroll/aviso.mp3', micStream);

    expect(globalThis.fetch).toHaveBeenCalledWith('/preroll/aviso.mp3');
    expect(audioContextMock.createMediaStreamSource).toHaveBeenCalledWith(micStream);
    expect(result.stream).toBe(destinationStream);
  });

  it('NÃO inicia o source até play() ser chamado (timing fix)', async () => {
    const micStream = new MediaStream();
    const result = await mixPrerollWithMic('/preroll/aviso.mp3', micStream);

    const source = audioContextMock.createBufferSource.mock.results[0].value;
    // Antes de play(): source NÃO foi iniciado
    expect(source.start).not.toHaveBeenCalled();

    // Após play(): retoma o AudioContext (hardening iOS — pode ter suspendido entre
    // o gesto e o 'established') e inicia o source.
    result.play();
    expect(audioContextMock.resume).toHaveBeenCalledTimes(1);
    expect(source.start).toHaveBeenCalledTimes(1);
  });

  it('play() é idempotente — múltiplas chamadas só disparam start uma vez', async () => {
    const micStream = new MediaStream();
    const result = await mixPrerollWithMic('/preroll/aviso.mp3', micStream);

    const source = audioContextMock.createBufferSource.mock.results[0].value;

    result.play();
    result.play();
    result.play();

    expect(source.start).toHaveBeenCalledTimes(1);
  });

  it('expõe close() que invoca AudioContext.close', async () => {
    const micStream = new MediaStream();
    const result = await mixPrerollWithMic('/preroll/aviso.mp3', micStream);

    result.close();

    expect(audioContextMock.close).toHaveBeenCalled();
  });

  it('retorna durationSeconds do MP3 decodificado (para UI countdown)', async () => {
    audioContextMock.decodeAudioData.mockResolvedValue({ duration: 4.8 });
    const micStream = new MediaStream();
    const result = await mixPrerollWithMic('/preroll/aviso.mp3', micStream);

    expect(result.durationSeconds).toBe(4.8);
  });
});
