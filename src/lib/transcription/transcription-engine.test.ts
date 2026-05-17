import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockDeepgramInstance = {
  connect: ReturnType<typeof vi.fn>;
  sendAudio: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _speaker: string;
  _triggerTranscript: (data: { text: string; isFinal: boolean }) => void;
};

const { deepgramClientCtor, deepgramInstances } = vi.hoisted(() => {
  const instances: MockDeepgramInstance[] = [];
  const ctor = vi.fn(() => {
    const handlers: Record<string, ((data: unknown) => void)[]> = {};
    const instance: MockDeepgramInstance = {
      connect: vi.fn((speaker: string) => {
        instance._speaker = speaker;
      }),
      sendAudio: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        (handlers[event] ??= []).push(handler);
      }),
      _speaker: 'vendedor',
      _triggerTranscript: (data: { text: string; isFinal: boolean }) => {
        for (const h of handlers['transcript'] ?? []) {
          h({ ...data, speaker: instance._speaker });
        }
      },
    };
    instances.push(instance);
    return instance;
  });
  return { deepgramClientCtor: ctor, deepgramInstances: instances };
});

vi.mock('@/lib/transcription/deepgram-client', () => ({
  DeepgramClient: deepgramClientCtor,
}));

// Mock MediaRecorder
class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  stream: MediaStream;
  ondataavailable: ((ev: BlobEvent) => void) | null = null;
  state = 'inactive';

  constructor(stream: MediaStream, _options?: MediaRecorderOptions) {
    this.stream = stream;
    MockMediaRecorder.instances.push(this);
  }

  start(_timeslice?: number) {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
  }

  _emitData(blob: Blob) {
    this.ondataavailable?.({ data: blob } as BlobEvent);
  }
}

import { TranscriptionEngine } from './transcription-engine';

// Compat shim so existing test bodies keep working
const deepgramClientMock = {
  DeepgramClient: deepgramClientCtor,
  _instances: deepgramInstances,
};

beforeEach(() => {
  deepgramClientCtor.mockClear();
  deepgramInstances.length = 0;
  MockMediaRecorder.instances = [];
  // @ts-expect-error stub global
  globalThis.MediaRecorder = MockMediaRecorder;
});

describe('TranscriptionEngine', () => {
  it('cria 2 DeepgramClients (vendedor + cliente) e os conecta no start()', () => {
    const engine = new TranscriptionEngine({ apiKey: 'k' });
    const vendorStream = new MediaStream();
    const clientStream = new MediaStream();

    engine.start({ vendorStream, clientStream });

    expect(deepgramClientMock.DeepgramClient).toHaveBeenCalledTimes(2);
    expect(deepgramClientMock._instances[0].connect).toHaveBeenCalledWith('vendedor');
    expect(deepgramClientMock._instances[1].connect).toHaveBeenCalledWith('cliente');
  });

  it('cria 2 MediaRecorders e roteia chunks pros DeepgramClients certos', () => {
    const engine = new TranscriptionEngine({ apiKey: 'k' });
    const vendorStream = new MediaStream();
    const clientStream = new MediaStream();

    engine.start({ vendorStream, clientStream });

    expect(MockMediaRecorder.instances).toHaveLength(2);
    const vendorRec = MockMediaRecorder.instances[0];
    const clientRec = MockMediaRecorder.instances[1];

    const vendorBlob = new Blob(['vendor-chunk']);
    vendorRec._emitData(vendorBlob);
    expect(deepgramClientMock._instances[0].sendAudio).toHaveBeenCalledWith(vendorBlob);
    expect(deepgramClientMock._instances[1].sendAudio).not.toHaveBeenCalled();

    const clientBlob = new Blob(['client-chunk']);
    clientRec._emitData(clientBlob);
    expect(deepgramClientMock._instances[1].sendAudio).toHaveBeenCalledWith(clientBlob);
  });

  it('eventos transcript de qualquer cliente disparam onTurn do engine', () => {
    const engine = new TranscriptionEngine({ apiKey: 'k' });
    const onTurn = vi.fn();
    engine.on('turn', onTurn);

    engine.start({ vendorStream: new MediaStream(), clientStream: new MediaStream() });

    deepgramClientMock._instances[0]._triggerTranscript({
      text: 'olá, sou Lucas',
      isFinal: false,
    });

    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: 'vendedor',
        text: 'olá, sou Lucas',
        isFinal: false,
      })
    );
  });

  it('interim updates do MESMO turno reutilizam o mesmo id; final fecha o turno', () => {
    const engine = new TranscriptionEngine({ apiKey: 'k' });
    const onTurn = vi.fn();
    engine.on('turn', onTurn);
    engine.start({ vendorStream: new MediaStream(), clientStream: new MediaStream() });

    // Primeiro interim
    deepgramClientMock._instances[0]._triggerTranscript({ text: 'olá', isFinal: false });
    const id1 = onTurn.mock.calls[0][0].id;

    // Segundo interim (mesmo turno)
    deepgramClientMock._instances[0]._triggerTranscript({ text: 'olá, sou', isFinal: false });
    const id2 = onTurn.mock.calls[1][0].id;

    expect(id1).toBe(id2); // mesmo turno

    // Final
    deepgramClientMock._instances[0]._triggerTranscript({ text: 'olá, sou Lucas', isFinal: true });
    expect(onTurn.mock.calls[2][0].isFinal).toBe(true);
    expect(onTurn.mock.calls[2][0].endedAt).not.toBeNull();

    // Próximo interim cria turno NOVO
    deepgramClientMock._instances[0]._triggerTranscript({ text: 'beleza', isFinal: false });
    const id3 = onTurn.mock.calls[3][0].id;
    expect(id3).not.toBe(id1);
  });

  it('stop() fecha os 2 DeepgramClients e para os 2 MediaRecorders', () => {
    const engine = new TranscriptionEngine({ apiKey: 'k' });
    engine.start({ vendorStream: new MediaStream(), clientStream: new MediaStream() });

    engine.stop();

    expect(deepgramClientMock._instances[0].close).toHaveBeenCalled();
    expect(deepgramClientMock._instances[1].close).toHaveBeenCalled();
    expect(MockMediaRecorder.instances[0].state).toBe('inactive');
    expect(MockMediaRecorder.instances[1].state).toBe('inactive');
  });
});
