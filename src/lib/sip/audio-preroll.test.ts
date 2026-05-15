import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mixPrerollWithMic } from './audio-preroll';

describe('mixPrerollWithMic', () => {
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
    };
    // @ts-expect-error stub global
    globalThis.AudioContext = vi.fn(() => audioContextMock);
    // @ts-expect-error stub fetch
    globalThis.fetch = vi.fn().mockResolvedValue({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
  });

  it('retorna MediaStream mixado e baixa o MP3 fornecido', async () => {
    const micStream = new MediaStream();
    const result = await mixPrerollWithMic('/preroll/aviso.mp3', micStream);

    expect(globalThis.fetch).toHaveBeenCalledWith('/preroll/aviso.mp3');
    expect(audioContextMock.createMediaStreamSource).toHaveBeenCalledWith(micStream);
    expect(result).toBe(destinationStream);
  });

  it('inicia o source do pre-roll', async () => {
    const micStream = new MediaStream();
    await mixPrerollWithMic('/preroll/aviso.mp3', micStream);

    const source = audioContextMock.createBufferSource.mock.results[0].value;
    expect(source.start).toHaveBeenCalled();
  });
});
