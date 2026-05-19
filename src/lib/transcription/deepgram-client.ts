import type { DeepgramConfig, Speaker } from './types';

type TranscriptEvent = {
  speaker: Speaker;
  text: string;
  isFinal: boolean;
};

type EventMap = {
  transcript: (data: TranscriptEvent) => void;
  error: (err: Error) => void;
  close: () => void;
};

type EventName = keyof EventMap;

/**
 * Wrapper de WebSocket pra Deepgram Nova-3 streaming.
 * Cada instância gerencia UM canal (vendedor ou cliente).
 * Audio chunks enviados antes do socket abrir são buffered + flushed no open.
 */
export class DeepgramClient {
  private ws: WebSocket | null = null;
  private speaker: Speaker = 'vendedor';
  private pendingAudio: (ArrayBufferLike | Blob)[] = [];
  private listeners: { [K in EventName]?: Array<EventMap[K]> } = {};
  private isOpen = false;

  constructor(private config: DeepgramConfig) {}

  connect(speaker: Speaker): void {
    this.speaker = speaker;

    const endpoint = this.config.endpoint ?? 'wss://api.deepgram.com/v1/listen';
    const params = new URLSearchParams({
      model: this.config.model ?? 'nova-3',
      language: this.config.language ?? 'pt-BR',
      interim_results: 'true',
      endpointing: String(this.config.endpointingMs ?? 300),
      encoding: 'opus',
    });

    // Deepgram aceita Sec-WebSocket-Protocol pra Authorization: ['token', '<key>']
    const url = `${endpoint}?${params.toString()}`;
    const ws = new WebSocket(url, ['token', this.config.apiKey]);
    this.ws = ws;

    ws.onopen = () => {
      this.isOpen = true;
      for (const chunk of this.pendingAudio) {
        ws.send(chunk as ArrayBuffer | Blob);
      }
      this.pendingAudio = [];
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'Results') {
          const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
          if (!text.trim()) return;
          this.emit('transcript', {
            speaker: this.speaker,
            text,
            isFinal: msg.is_final ?? false,
          });
        }
      } catch {
        // Mensagem não-JSON ou shape inesperada; ignora silenciosamente
      }
    };

    ws.onerror = () => {
      this.emit('error', new Error('Deepgram WebSocket error'));
    };

    ws.onclose = () => {
      this.isOpen = false;
      this.emit('close');
    };
  }

  sendAudio(chunk: ArrayBufferLike | Blob): void {
    if (this.isOpen && this.ws) {
      this.ws.send(chunk as ArrayBuffer | Blob);
    } else {
      this.pendingAudio.push(chunk);
    }
  }

  close(): void {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        // ignore
      }
    }
    this.ws?.close();
    this.ws = null;
    this.isOpen = false;
  }

  on<K extends EventName>(event: K, handler: EventMap[K]): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.listeners[event] ??= [] as any).push(handler);
  }

  private emit<K extends EventName>(event: K, ...args: Parameters<EventMap[K]>): void {
    const arr = this.listeners[event];
    if (!arr) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const fn of arr) (fn as any)(...args);
  }
}
