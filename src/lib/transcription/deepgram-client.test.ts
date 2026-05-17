import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepgramClient } from './deepgram-client';

// Mock global WebSocket
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  sent: (string | ArrayBufferLike | Blob)[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.(new CloseEvent('close'));
  }

  _open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  _message(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  // @ts-expect-error stub global
  globalThis.WebSocket = MockWebSocket;
});

describe('DeepgramClient', () => {
  it('abre WebSocket com URL contendo modelo, idioma e query params corretos', () => {
    const client = new DeepgramClient({
      apiKey: 'temp_key_abc',
      model: 'nova-3',
      language: 'pt-BR',
      endpointingMs: 300,
    });
    client.connect('vendedor');

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain('wss://api.deepgram.com/v1/listen');
    expect(ws.url).toContain('model=nova-3');
    expect(ws.url).toContain('language=pt-BR');
    expect(ws.url).toContain('interim_results=true');
    expect(ws.url).toContain('endpointing=300');
  });

  it('envia chunks de áudio via send() após open', () => {
    const client = new DeepgramClient({ apiKey: 'k' });
    client.connect('vendedor');
    const ws = MockWebSocket.instances[0];
    ws._open();

    const chunk = new ArrayBuffer(1024);
    client.sendAudio(chunk);

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBe(chunk);
  });

  it('audio enviado ANTES de open() fica em buffer e flush no open', () => {
    const client = new DeepgramClient({ apiKey: 'k' });
    client.connect('vendedor');
    const ws = MockWebSocket.instances[0];

    const chunk1 = new ArrayBuffer(512);
    const chunk2 = new ArrayBuffer(512);
    client.sendAudio(chunk1);
    client.sendAudio(chunk2);

    expect(ws.sent).toHaveLength(0);

    ws._open();

    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]).toBe(chunk1);
    expect(ws.sent[1]).toBe(chunk2);
  });

  it('emite onTranscript com texto + isFinal ao receber mensagem do Deepgram', () => {
    const client = new DeepgramClient({ apiKey: 'k' });
    const onTranscript = vi.fn();
    client.on('transcript', onTranscript);
    client.connect('cliente');
    const ws = MockWebSocket.instances[0];
    ws._open();

    const msg = JSON.stringify({
      type: 'Results',
      channel: {
        alternatives: [{ transcript: 'olá, posso ajudar?', confidence: 0.95 }],
      },
      is_final: false,
      start: 0.5,
      duration: 1.2,
    });
    ws._message(msg);

    expect(onTranscript).toHaveBeenCalledWith({
      speaker: 'cliente',
      text: 'olá, posso ajudar?',
      isFinal: false,
    });
  });

  it('ignora mensagens com transcript vazio', () => {
    const client = new DeepgramClient({ apiKey: 'k' });
    const onTranscript = vi.fn();
    client.on('transcript', onTranscript);
    client.connect('cliente');
    const ws = MockWebSocket.instances[0];
    ws._open();

    const msg = JSON.stringify({
      type: 'Results',
      channel: { alternatives: [{ transcript: '', confidence: 0 }] },
      is_final: true,
    });
    ws._message(msg);

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('close() fecha o WebSocket', () => {
    const client = new DeepgramClient({ apiKey: 'k' });
    client.connect('vendedor');
    const ws = MockWebSocket.instances[0];
    ws._open();

    client.close();

    expect(ws.readyState).toBe(3);
  });
});
