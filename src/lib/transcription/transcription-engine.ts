import { DeepgramClient } from '@/lib/transcription/deepgram-client';
import type { DeepgramConfig, TranscriptTurn, Speaker } from '@/lib/transcription/types';

interface EngineStartOptions {
  vendorStream: MediaStream;
  clientStream: MediaStream;
}

type EngineEventMap = {
  turn: (turn: TranscriptTurn) => void;
  error: (err: Error) => void;
};

type EngineEventName = keyof EngineEventMap;

/**
 * Orquestra 2 DeepgramClients (vendedor + cliente) e 2 MediaRecorders pra
 * capturar e transmitir áudio bidirecional em tempo real.
 *
 * Chunks de ~250ms (timeslice MediaRecorder) são enviados via WebSocket.
 * Transcripts vindos do Deepgram são emitidos como `TranscriptTurn` events.
 *
 * IMPORTANTE: cada turno tem um ID único client-side. Interim updates do mesmo
 * turno reutilizam o ID (consumer pode fazer Map<id, turn>). Final emit fecha
 * o turno (isFinal=true) — próximo interim cria turno novo.
 */
export class TranscriptionEngine {
  private vendorClient: DeepgramClient | null = null;
  private clientClient: DeepgramClient | null = null;
  private vendorRecorder: MediaRecorder | null = null;
  private clientRecorder: MediaRecorder | null = null;
  private listeners: { [K in EngineEventName]?: Array<EngineEventMap[K]> } = {};
  // Track current interim turn IDs per speaker (resetam após final)
  private currentTurnIds: { vendedor: string | null; cliente: string | null } = {
    vendedor: null,
    cliente: null,
  };
  // Track startedAt do turno corrente por speaker
  private currentTurnStartedAt: { vendedor: number | null; cliente: number | null } = {
    vendedor: null,
    cliente: null,
  };

  constructor(private config: DeepgramConfig) {}

  start(opts: EngineStartOptions): void {
    // Vendor channel
    this.vendorClient = new DeepgramClient(this.config);
    this.vendorClient.on('transcript', (data) => this.handleTranscript(data));
    this.vendorClient.on('error', (err) => this.emit('error', err));
    this.vendorClient.connect('vendedor');

    this.vendorRecorder = new MediaRecorder(opts.vendorStream, {
      mimeType: 'audio/webm;codecs=opus',
    });
    this.vendorRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.vendorClient?.sendAudio(ev.data);
    };
    this.vendorRecorder.start(250);

    // Client channel
    this.clientClient = new DeepgramClient(this.config);
    this.clientClient.on('transcript', (data) => this.handleTranscript(data));
    this.clientClient.on('error', (err) => this.emit('error', err));
    this.clientClient.connect('cliente');

    this.clientRecorder = new MediaRecorder(opts.clientStream, {
      mimeType: 'audio/webm;codecs=opus',
    });
    this.clientRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.clientClient?.sendAudio(ev.data);
    };
    this.clientRecorder.start(250);
  }

  stop(): void {
    try { this.vendorRecorder?.stop(); } catch { /* noop */ }
    try { this.clientRecorder?.stop(); } catch { /* noop */ }
    this.vendorClient?.close();
    this.clientClient?.close();
    this.vendorClient = null;
    this.clientClient = null;
    this.vendorRecorder = null;
    this.clientRecorder = null;
    this.currentTurnIds = { vendedor: null, cliente: null };
    this.currentTurnStartedAt = { vendedor: null, cliente: null };
  }

  on<K extends EngineEventName>(event: K, handler: EngineEventMap[K]): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.listeners[event] ??= [] as any).push(handler);
  }

  private handleTranscript(data: { speaker: Speaker; text: string; isFinal: boolean }): void {
    const now = Date.now();
    let id = this.currentTurnIds[data.speaker];
    let startedAt = this.currentTurnStartedAt[data.speaker];
    if (!id || !startedAt) {
      id = `${data.speaker}-${now}-${Math.random().toString(36).slice(2, 8)}`;
      startedAt = now;
      this.currentTurnIds[data.speaker] = id;
      this.currentTurnStartedAt[data.speaker] = startedAt;
    }

    const turn: TranscriptTurn = {
      id,
      speaker: data.speaker,
      text: data.text,
      isFinal: data.isFinal,
      startedAt,
      endedAt: data.isFinal ? now : null,
    };

    this.emit('turn', turn);

    if (data.isFinal) {
      this.currentTurnIds[data.speaker] = null;
      this.currentTurnStartedAt[data.speaker] = null;
    }
  }

  private emit<K extends EngineEventName>(event: K, ...args: Parameters<EngineEventMap[K]>): void {
    const arr = this.listeners[event];
    if (!arr) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const fn of arr) (fn as any)(...args);
  }
}
