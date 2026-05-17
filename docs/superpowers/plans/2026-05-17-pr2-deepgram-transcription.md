# PR2 — Transcrição ao vivo Deepgram Nova-3 (2 canais separados) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capturar áudio bidirecional da chamada WebRTC e transcrever ao vivo via Deepgram Nova-3 com dois canais SEPARADOS (vendedor / cliente), exibido em painel lateral slide-in na `/farmer/calls`. Fundação pro copilot SPIN do PR3.

**Architecture:** Edge Function `deepgram-token` gera key temporária (TTL 300s) via Deepgram Management API — master key nunca sai do servidor. `DeepgramClient` é um WebSocket wrapper single-channel (1 conexão por canal). `TranscriptionEngine` orquestra 2 `DeepgramClient`s (vendedor=rawMic / cliente=remoteStream), usa `MediaRecorder` com `audio/webm;codecs=opus` pra chunks de ~250ms. Hook `useTranscription` consome do engine e expõe `turns: TranscriptTurn[]` reativo. `WebRTCCallContext` instancia engine quando call reaches `'established'`, destrói no `hangUp`. `TranscriptionPanel` é slide-in da direita em /farmer/calls com bolhas alternadas estilo chat. Graceful degradation: sem `DEEPGRAM_API_KEY` configurado, transcrição não ativa (chamada funciona normal).

**Tech Stack:** Deepgram Nova-3 streaming (WebSocket) · MediaRecorder API (Opus codec) · React 18 hooks · Vitest 3.2 · TypeScript estrito · Supabase Edge Functions (Deno) · shadcn/ui Card/Badge.

**Não-objetivos (ficam pra PRs seguintes):**
- Análise SPIN com Claude — PR3
- Cross-sell ao vivo — PR4
- Persistência do transcript no banco (`farmer_copilot_sessions.transcript_full`) — PR6 (junto com gravação)
- Edição manual do transcript pelo vendedor — pós-PR8
- Export pra texto — pós-PR8

---

## File Structure

**Criar:**
- `supabase/functions/deepgram-token/index.ts` — gera temp key via Deepgram Management API
- `src/lib/transcription/types.ts` — TranscriptTurn, TranscriptionStatus, DeepgramConfig
- `src/lib/transcription/deepgram-client.ts` — single-channel WebSocket wrapper
- `src/lib/transcription/deepgram-client.test.ts`
- `src/lib/transcription/transcription-engine.ts` — orquestra 2 DeepgramClients
- `src/lib/transcription/transcription-engine.test.ts`
- `src/hooks/useTranscription.ts` — hook que consome state do TranscriptionEngine
- `src/hooks/__tests__/useTranscription.test.tsx`
- `src/components/call/TranscriptionPanel.tsx` — UI slide-in lateral

**Modificar:**
- `src/contexts/WebRTCCallContext.tsx` — expor `vendorMicStream` (rawMic) + `transcription` state; iniciar/parar engine na transição established/ended
- `src/contexts/__tests__/WebRTCCallContext.test.tsx`
- `src/pages/FarmerCalls.tsx` — renderizar TranscriptionPanel quando WebRTC call ativa

**Não modificar:**
- `src/pages/FarmerCopilot.tsx` (legacy Scribe — fica pra deprecation futura)
- `src/lib/sip/*` (estável)

---

## Task 1: Edge Function `deepgram-token`

**Files:** Create `supabase/functions/deepgram-token/index.ts`

- [ ] **Step 1: Criar a edge function**

Criar `supabase/functions/deepgram-token/index.ts`:

```ts
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const DEEPGRAM_API_BASE = "https://api.deepgram.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const apiKey = Deno.env.get("DEEPGRAM_API_KEY");
    const projectId = Deno.env.get("DEEPGRAM_PROJECT_ID");

    if (!apiKey || !projectId) {
      return new Response(
        JSON.stringify({
          error: "Deepgram não configurado (DEEPGRAM_API_KEY ou DEEPGRAM_PROJECT_ID ausente)",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Gera key temporária scoped a usage:write, TTL 300s
    const resp = await fetch(`${DEEPGRAM_API_BASE}/v1/projects/${projectId}/keys`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        comment: `Temp key for staff user ${auth.userId ?? "unknown"} (${new Date().toISOString()})`,
        scopes: ["usage:write"],
        time_to_live_in_seconds: 300,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Deepgram key creation failed:", resp.status, errText);
      return new Response(
        JSON.stringify({ error: `Deepgram retornou ${resp.status}`, details: errText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await resp.json();
    // data: { api_key_id, key, comment, scopes, expiration_date, ... }
    return new Response(
      JSON.stringify({
        key: data.key,
        expiresAt: data.expiration_date, // ISO timestamp
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/deepgram-token/index.ts
git commit -m "feat(transcription): edge function generates Deepgram temp key (TTL 300s)"
```

---

## Task 2: Types da transcrição

**Files:** Create `src/lib/transcription/types.ts`

- [ ] **Step 1: Criar arquivo**

```ts
// src/lib/transcription/types.ts

export type Speaker = 'vendedor' | 'cliente';

export interface TranscriptTurn {
  /** Identificador único do turno (gerado client-side) */
  id: string;
  speaker: Speaker;
  /** Texto do turno (pode crescer enquanto interim, congela no final) */
  text: string;
  /** True se ainda é interim (parcial); false após Deepgram confirmar como final */
  isFinal: boolean;
  /** Timestamp (Date.now()) do primeiro chunk recebido */
  startedAt: number;
  /** Timestamp do final do turno; null se ainda interim */
  endedAt: number | null;
}

export type TranscriptionStatus = 'idle' | 'connecting' | 'active' | 'error';

export interface TranscriptionState {
  status: TranscriptionStatus;
  /** Turnos em ordem cronológica (oldest first) */
  turns: TranscriptTurn[];
  error: string | null;
}

export interface DeepgramConfig {
  /** Key temporária do Deepgram (vinda da edge function) */
  apiKey: string;
  /** WebSocket endpoint (default: wss://api.deepgram.com/v1/listen) */
  endpoint?: string;
  /** Modelo Deepgram (default: nova-3) */
  model?: string;
  /** Idioma (default: pt-BR) */
  language?: string;
  /** Endpointing em ms (default: 300 — Deepgram emite final após 300ms de silêncio) */
  endpointingMs?: number;
  /** Encoding dos chunks de áudio (default: audio/webm;codecs=opus) */
  encoding?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/transcription/types.ts
git commit -m "feat(transcription): shared types for Deepgram streaming"
```

---

## Task 3: DeepgramClient — WebSocket wrapper single-channel (TDD)

**Files:**
- Create: `src/lib/transcription/deepgram-client.ts`
- Create: `src/lib/transcription/deepgram-client.test.ts`

- [ ] **Step 1: Escrever testes**

Create `src/lib/transcription/deepgram-client.test.ts`:

```ts
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

  // helpers pros tests
  _open() {
    this.readyState = 1; // OPEN
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

  it('envia chunks de áudio via send() após open', async () => {
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

    expect(ws.sent).toHaveLength(0); // ainda não abriu

    ws._open();

    expect(ws.sent).toHaveLength(2); // flush
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

    // Formato típico de resposta Deepgram streaming:
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

  it('ignora mensagens com transcript vazio (Deepgram emite no inicio do stream)', () => {
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

    expect(ws.readyState).toBe(3); // CLOSED
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `bun run vitest run src/lib/transcription/deepgram-client.test.ts`
Expected: FAIL (`Cannot find module './deepgram-client'`).

- [ ] **Step 3: Implementar**

Create `src/lib/transcription/deepgram-client.ts`:

```ts
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

/**
 * Wrapper de WebSocket pra Deepgram Nova-3 streaming.
 * Cada instância gerencia UM canal (vendedor ou cliente).
 * Audio chunks enviados antes do socket abrir são buffered + flushed no open.
 */
export class DeepgramClient {
  private ws: WebSocket | null = null;
  private speaker: Speaker = 'vendedor';
  private pendingAudio: (ArrayBufferLike | Blob)[] = [];
  private listeners: { [K in keyof EventMap]?: Array<EventMap[K]> } = {};
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
      // Encoding hint pro Deepgram. Se omitido ele auto-detecta, mas explícito é mais rápido.
      encoding: 'opus',
    });

    // Deepgram aceita Sec-WebSocket-Protocol pra Authorization
    // Padrão: ['token', '<key>']
    const url = `${endpoint}?${params.toString()}`;
    const ws = new WebSocket(url, ['token', this.config.apiKey]);
    this.ws = ws;

    ws.onopen = () => {
      this.isOpen = true;
      // Flush pending audio
      for (const chunk of this.pendingAudio) {
        ws.send(chunk);
      }
      this.pendingAudio = [];
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'Results') {
          const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
          if (!text.trim()) return; // ignora vazios
          this.emit('transcript', {
            speaker: this.speaker,
            text,
            isFinal: msg.is_final ?? false,
          });
        }
      } catch (err) {
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
      this.ws.send(chunk);
    } else {
      this.pendingAudio.push(chunk);
    }
  }

  close(): void {
    if (this.ws && this.ws.readyState === 1) {
      // Manda "CloseStream" message pro Deepgram processar últimos chunks
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

  on<K extends keyof EventMap>(event: K, handler: EventMap[K]): void {
    (this.listeners[event] ??= [] as Array<EventMap[K]>).push(handler);
  }

  private emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const fn of arr) (fn as (...a: unknown[]) => void)(...args);
  }
}
```

- [ ] **Step 4: Rodar testes**

Run: `bun run vitest run src/lib/transcription/deepgram-client.test.ts`
Expected: PASS 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/transcription/deepgram-client.ts src/lib/transcription/deepgram-client.test.ts
git commit -m "feat(transcription): DeepgramClient WebSocket wrapper for single channel"
```

---

## Task 4: TranscriptionEngine — orquestra 2 DeepgramClients (TDD)

**Files:**
- Create: `src/lib/transcription/transcription-engine.ts`
- Create: `src/lib/transcription/transcription-engine.test.ts`

- [ ] **Step 1: Escrever testes**

```ts
// src/lib/transcription/transcription-engine.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { deepgramClientMock } = vi.hoisted(() => {
  const mockInstances: Array<{
    connect: ReturnType<typeof vi.fn>;
    sendAudio: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    _triggerTranscript: (data: { text: string; isFinal: boolean }) => void;
  }> = [];
  return {
    deepgramClientMock: {
      DeepgramClient: vi.fn().mockImplementation(() => {
        const handlers: Record<string, ((data: unknown) => void)[]> = {};
        const instance = {
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
        mockInstances.push(instance);
        return instance;
      }),
      _instances: mockInstances,
    },
  };
});

vi.mock('./deepgram-client', () => ({
  DeepgramClient: deepgramClientMock.DeepgramClient,
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

beforeEach(() => {
  vi.clearAllMocks();
  MockMediaRecorder.instances = [];
  deepgramClientMock._instances.length = 0;
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

    // Simula chunk do vendor
    const vendorBlob = new Blob(['vendor-chunk']);
    vendorRec._emitData(vendorBlob);
    expect(deepgramClientMock._instances[0].sendAudio).toHaveBeenCalledWith(vendorBlob);
    expect(deepgramClientMock._instances[1].sendAudio).not.toHaveBeenCalled();

    // Simula chunk do cliente
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
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `bun run vitest run src/lib/transcription/transcription-engine.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

Create `src/lib/transcription/transcription-engine.ts`:

```ts
import { DeepgramClient } from './deepgram-client';
import type { DeepgramConfig, TranscriptTurn } from './types';

interface EngineStartOptions {
  vendorStream: MediaStream;
  clientStream: MediaStream;
}

type EngineEventMap = {
  turn: (turn: TranscriptTurn) => void;
  error: (err: Error) => void;
};

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
  private listeners: { [K in keyof EngineEventMap]?: Array<EngineEventMap[K]> } = {};
  // Track current interim turn IDs per speaker (resetam após final)
  private currentTurnIds: { vendedor: string | null; cliente: string | null } = {
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
  }

  on<K extends keyof EngineEventMap>(event: K, handler: EngineEventMap[K]): void {
    (this.listeners[event] ??= [] as Array<EngineEventMap[K]>).push(handler);
  }

  private handleTranscript(data: { speaker: 'vendedor' | 'cliente'; text: string; isFinal: boolean }): void {
    const now = Date.now();
    let id = this.currentTurnIds[data.speaker];
    if (!id) {
      // Novo turno
      id = `${data.speaker}-${now}-${Math.random().toString(36).slice(2, 8)}`;
      this.currentTurnIds[data.speaker] = id;
    }

    const turn: TranscriptTurn = {
      id,
      speaker: data.speaker,
      text: data.text,
      isFinal: data.isFinal,
      startedAt: now, // consumer mantém startedAt original via Map<id>
      endedAt: data.isFinal ? now : null,
    };

    this.emit('turn', turn);

    if (data.isFinal) {
      this.currentTurnIds[data.speaker] = null;
    }
  }

  private emit<K extends keyof EngineEventMap>(event: K, ...args: Parameters<EngineEventMap[K]>): void {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const fn of arr) (fn as (...a: unknown[]) => void)(...args);
  }
}
```

- [ ] **Step 4: Rodar testes**

Run: `bun run vitest run src/lib/transcription/transcription-engine.test.ts`
Expected: PASS 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/transcription/transcription-engine.ts src/lib/transcription/transcription-engine.test.ts
git commit -m "feat(transcription): TranscriptionEngine orchestrates 2 channels (vendor + client)"
```

---

## Task 5: Hook useTranscription (TDD)

**Files:**
- Create: `src/hooks/useTranscription.ts`
- Create: `src/hooks/__tests__/useTranscription.test.tsx`

- [ ] **Step 1: Escrever testes**

```tsx
// src/hooks/__tests__/useTranscription.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { engineMock, invokeMock } = vi.hoisted(() => {
  const handlers: Record<string, ((data: unknown) => void)[]> = {};
  return {
    engineMock: {
      TranscriptionEngine: vi.fn().mockImplementation(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          (handlers[event] ??= []).push(handler);
        }),
        _trigger: (event: string, data: unknown) => {
          for (const h of handlers[event] ?? []) h(data);
        },
      })),
      _handlers: handlers,
    },
    invokeMock: vi.fn(),
  };
});

vi.mock('@/lib/transcription/transcription-engine', () => ({
  TranscriptionEngine: engineMock.TranscriptionEngine,
}));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: invokeMock,
}));

import { useTranscription } from '../useTranscription';

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(engineMock._handlers).forEach((k) => delete engineMock._handlers[k]);
  invokeMock.mockResolvedValue({ key: 'temp_key_abc', expiresAt: '2026-12-31T00:00:00Z' });
});

describe('useTranscription', () => {
  it('estado inicial é idle, turns vazio', () => {
    const { result } = renderHook(() =>
      useTranscription({ vendorStream: null, clientStream: null, enabled: false })
    );
    expect(result.current.status).toBe('idle');
    expect(result.current.turns).toEqual([]);
  });

  it('quando enabled+streams disponíveis: fetcha token e inicia engine', async () => {
    const { result } = renderHook(() =>
      useTranscription({
        vendorStream: new MediaStream(),
        clientStream: new MediaStream(),
        enabled: true,
      })
    );

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('deepgram-token', {}));
    await waitFor(() => expect(engineMock.TranscriptionEngine).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status).toBe('active'));
  });

  it('eventos turn do engine atualizam turns array', async () => {
    const { result } = renderHook(() =>
      useTranscription({
        vendorStream: new MediaStream(),
        clientStream: new MediaStream(),
        enabled: true,
      })
    );

    await waitFor(() => expect(result.current.status).toBe('active'));

    act(() => {
      const handlers = engineMock._handlers['turn'] ?? [];
      handlers[0]?.({
        id: 'vendedor-1',
        speaker: 'vendedor',
        text: 'olá',
        isFinal: false,
        startedAt: Date.now(),
        endedAt: null,
      });
    });

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].text).toBe('olá');
  });

  it('quando enabled=false: status fica idle, engine não inicia', () => {
    renderHook(() =>
      useTranscription({
        vendorStream: new MediaStream(),
        clientStream: new MediaStream(),
        enabled: false,
      })
    );
    expect(engineMock.TranscriptionEngine).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `bun run vitest run src/hooks/__tests__/useTranscription.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/hooks/useTranscription.ts
import { useEffect, useRef, useState } from 'react';
import { TranscriptionEngine } from '@/lib/transcription/transcription-engine';
import type { TranscriptTurn, TranscriptionStatus } from '@/lib/transcription/types';
import { invokeFunction } from '@/lib/invoke-function';

interface UseTranscriptionOptions {
  vendorStream: MediaStream | null;
  clientStream: MediaStream | null;
  /** Quando false, hook fica idle (não inicia engine, não consome créditos Deepgram) */
  enabled: boolean;
}

export interface UseTranscriptionReturn {
  status: TranscriptionStatus;
  turns: TranscriptTurn[];
  error: string | null;
}

/**
 * Hook React que gerencia transcrição ao vivo via TranscriptionEngine.
 *
 * Quando `enabled=true` E ambos os streams existem: fetcha token Deepgram,
 * inicia o engine e popula `turns` em tempo real.
 *
 * Quando `enabled=false` OU algum stream ausente: noop.
 *
 * Cleanup: `stop()` do engine roda em unmount ou quando enabled volta a false.
 */
export function useTranscription(opts: UseTranscriptionOptions): UseTranscriptionReturn {
  const { vendorStream, clientStream, enabled } = opts;
  const [status, setStatus] = useState<TranscriptionStatus>('idle');
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const engineRef = useRef<TranscriptionEngine | null>(null);

  useEffect(() => {
    if (!enabled || !vendorStream || !clientStream) {
      // Cleanup se estava ativo
      if (engineRef.current) {
        engineRef.current.stop();
        engineRef.current = null;
      }
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setStatus('connecting');
    setError(null);

    (async () => {
      try {
        const { key } = await invokeFunction<{ key: string; expiresAt: string }>(
          'deepgram-token',
          {}
        );
        if (cancelled) return;

        const engine = new TranscriptionEngine({ apiKey: key });
        engineRef.current = engine;

        engine.on('turn', (turn) => {
          setTurns((prev) => {
            // Se já existe turno com mesmo id → update; senão append
            const idx = prev.findIndex((t) => t.id === turn.id);
            if (idx >= 0) {
              const next = [...prev];
              // Preserva startedAt original
              next[idx] = { ...turn, startedAt: prev[idx].startedAt };
              return next;
            }
            return [...prev, turn];
          });
        });

        engine.on('error', (err) => {
          setError(err.message);
          setStatus('error');
        });

        engine.start({ vendorStream, clientStream });
        setStatus('active');
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Erro na transcrição';
        setError(msg);
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (engineRef.current) {
        engineRef.current.stop();
        engineRef.current = null;
      }
    };
  }, [enabled, vendorStream, clientStream]);

  return { status, turns, error };
}
```

- [ ] **Step 4: Rodar testes**

Run: `bun run vitest run src/hooks/__tests__/useTranscription.test.tsx`
Expected: PASS 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTranscription.ts src/hooks/__tests__/useTranscription.test.tsx
git commit -m "feat(transcription): useTranscription hook with engine lifecycle"
```

---

## Task 6: Wire transcription into WebRTCCallContext

**Files:**
- Modify: `src/contexts/WebRTCCallContext.tsx`
- Modify: `src/contexts/__tests__/WebRTCCallContext.test.tsx`

- [ ] **Step 1: Expor vendorMicStream + transcription state via context**

Em `src/contexts/WebRTCCallContext.tsx`, estender a interface:

```ts
import type { TranscriptTurn, TranscriptionStatus } from '@/lib/transcription/types';
import { useTranscription } from '@/hooks/useTranscription';

export interface WebRTCCallContextValue {
  // ... campos existentes ...
  /** Stream raw do mic do vendedor (sem preroll mixado).
   *  Exposto pra TranscriptionEngine usar como canal "vendedor". */
  vendorMicStream: MediaStream | null;
  // Transcrição
  transcriptionStatus: TranscriptionStatus;
  transcriptionTurns: TranscriptTurn[];
  transcriptionError: string | null;
}
```

- [ ] **Step 2: Adicionar state e expor rawMic**

Dentro do `WebRTCCallProvider`, adicionar state pra vendorMicStream:

```tsx
const [vendorMicStream, setVendorMicStream] = useState<MediaStream | null>(null);
```

E no `makeCall`, depois de `rawMicRef.current = rawMic;`, adicionar:
```tsx
setVendorMicStream(rawMic);
```

E em `cleanupAudioResources()`, adicionar no início:
```tsx
setVendorMicStream(null);
```

- [ ] **Step 3: Chamar useTranscription dentro do Provider**

Logo após os outros `useState`/`useEffect`, adicionar:

```tsx
const transcription = useTranscription({
  vendorStream: vendorMicStream,
  clientStream: remoteStream,
  enabled: callState === 'established',
});
```

- [ ] **Step 4: Adicionar campos ao `value`**

```tsx
const value: WebRTCCallContextValue = {
  // ... campos existentes ...
  vendorMicStream,
  transcriptionStatus: transcription.status,
  transcriptionTurns: transcription.turns,
  transcriptionError: transcription.error,
};
```

- [ ] **Step 5: Atualizar testes do Context**

Em `src/contexts/__tests__/WebRTCCallContext.test.tsx`, adicionar mock pro hook useTranscription:

No topo, junto com os outros mocks:
```ts
vi.mock('@/hooks/useTranscription', () => ({
  useTranscription: () => ({
    status: 'idle' as const,
    turns: [],
    error: null,
  }),
}));
```

E adicionar 1 teste no describe:
```tsx
  it('expõe campos de transcrição (inicialmente idle/empty)', async () => {
    const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
    await waitFor(() => expect(SipClient).toHaveBeenCalled());

    expect(result.current.transcriptionStatus).toBe('idle');
    expect(result.current.transcriptionTurns).toEqual([]);
    expect(result.current.transcriptionError).toBeNull();
    expect(result.current.vendorMicStream).toBeNull();
  });
```

- [ ] **Step 6: Rodar tudo**

Run: `bun run vitest run`
Expected: tudo verde (+1 novo teste).

Run: `bun run tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/contexts/WebRTCCallContext.tsx src/contexts/__tests__/WebRTCCallContext.test.tsx
git commit -m "feat(transcription): wire useTranscription into WebRTCCallContext"
```

---

## Task 7: TranscriptionPanel UI component

**Files:** Create `src/components/call/TranscriptionPanel.tsx`

- [ ] **Step 1: Criar componente**

```tsx
// src/components/call/TranscriptionPanel.tsx
import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, AlertCircle, X, Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { TranscriptTurn, TranscriptionStatus } from '@/lib/transcription/types';

interface TranscriptionPanelProps {
  status: TranscriptionStatus;
  turns: TranscriptTurn[];
  error: string | null;
  open: boolean;
  onClose: () => void;
}

export function TranscriptionPanel({ status, turns, error, open, onClose }: TranscriptionPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll pro final quando turns mudam
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: '100%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '100%', opacity: 0 }}
          transition={{ type: 'tween', duration: 0.2 }}
          className="fixed right-0 top-topbar bottom-0 w-full md:w-[400px] bg-card border-l border-border z-40 flex flex-col"
        >
          {/* Header */}
          <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">Transcrição ao vivo</h2>
              <StatusBadge status={status} />
            </div>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} title="Fechar">
              <X className="w-4 h-4" />
            </Button>
          </header>

          {/* Body */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {status === 'connecting' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Conectando ao Deepgram...
              </div>
            )}
            {status === 'error' && (
              <div className="flex items-start gap-2 rounded-md border border-status-error bg-status-error-bg p-3 text-xs">
                <AlertCircle className="w-4 h-4 text-status-error shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-status-error">Erro na transcrição</div>
                  {error && <div className="text-muted-foreground mt-1">{error}</div>}
                </div>
              </div>
            )}
            {status === 'active' && turns.length === 0 && (
              <div className="text-sm text-muted-foreground text-center pt-12">
                Aguardando fala...
              </div>
            )}
            {turns.map((turn) => (
              <TurnBubble key={turn.id} turn={turn} />
            ))}
          </div>

          {/* Footer */}
          <footer className="p-3 border-t border-border text-2xs text-muted-foreground text-center shrink-0">
            Transcrição via Deepgram Nova-3. Não armazenada (PR6 vai persistir).
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function StatusBadge({ status }: { status: TranscriptionStatus }) {
  if (status === 'idle') return <Badge variant="outline" className="text-2xs">Idle</Badge>;
  if (status === 'connecting')
    return (
      <Badge variant="outline" className="text-2xs text-status-warning gap-1">
        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Conectando
      </Badge>
    );
  if (status === 'active')
    return (
      <Badge variant="outline" className="text-2xs text-status-success gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" /> Ao vivo
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-2xs text-status-error gap-1">
      <AlertCircle className="w-2.5 h-2.5" /> Erro
    </Badge>
  );
}

function TurnBubble({ turn }: { turn: TranscriptTurn }) {
  const isVendor = turn.speaker === 'vendedor';
  return (
    <div className={cn('flex flex-col gap-1', isVendor ? 'items-end' : 'items-start')}>
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        {isVendor ? <Mic className="w-3 h-3" /> : <MicOff className="w-3 h-3" />}
        <span>{isVendor ? 'Vendedor' : 'Cliente'}</span>
        {!turn.isFinal && (
          <span className="text-status-warning">• digitando...</span>
        )}
      </div>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm',
          isVendor
            ? 'bg-foreground text-background'
            : 'bg-muted text-foreground border border-border',
          !turn.isFinal && 'opacity-70'
        )}
      >
        {turn.text}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verificar build**

Run: `bun run tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/call/TranscriptionPanel.tsx
git commit -m "feat(transcription): TranscriptionPanel UI with chat-style turn bubbles"
```

---

## Task 8: Integrar TranscriptionPanel em FarmerCalls

**Files:** Modify `src/pages/FarmerCalls.tsx`

- [ ] **Step 1: Adicionar imports**

No topo de `src/pages/FarmerCalls.tsx`, adicionar:
```ts
import { useState } from 'react'; // já existe — só adicionar useState se ainda não tiver
import { TranscriptionPanel } from '@/components/call/TranscriptionPanel';
import { useWebRTCCall } from '@/hooks/useWebRTCCall';
```

(`useWebRTCCall` é importado pra acessar o transcription state diretamente do Context.)

- [ ] **Step 2: Pegar transcription state + toggle do painel**

Dentro do componente FarmerCalls, depois de `useCallBackend()`:

```tsx
const webrtc = useWebRTCCall();
const [transcriptionOpen, setTranscriptionOpen] = useState(true); // aberto por padrão
```

> NOTA: `useWebRTCCall()` SÓ retorna shape válido quando `WebRTCCallProvider` está montado (staff user). Em FarmerCalls, sempre staff (já protegido pela rota). OK.

- [ ] **Step 3: Renderizar TranscriptionPanel**

No JSX do FarmerCalls, no final do return (antes do `</div>` mais externo), adicionar:

```tsx
{webrtc.callState === 'established' && (
  <TranscriptionPanel
    status={webrtc.transcriptionStatus}
    turns={webrtc.transcriptionTurns}
    error={webrtc.transcriptionError}
    open={transcriptionOpen}
    onClose={() => setTranscriptionOpen(false)}
  />
)}
```

Se necessário, adicionar um botão pequeno no header da página pra reabrir o painel quando fechado (caso o usuário feche acidentalmente):

```tsx
{webrtc.callState === 'established' && !transcriptionOpen && (
  <Button
    size="sm"
    variant="outline"
    className="fixed right-4 top-20 z-30 gap-1"
    onClick={() => setTranscriptionOpen(true)}
  >
    Mostrar transcrição
  </Button>
)}
```

- [ ] **Step 4: Verificar tudo**

Run: `bun run tsc --noEmit`
Expected: clean.

Run: `bun run vitest run`
Expected: tudo verde.

Run: `bun run build:dev`
Expected: build passa.

- [ ] **Step 5: Commit**

```bash
git add src/pages/FarmerCalls.tsx
git commit -m "feat(transcription): slide-in TranscriptionPanel in /farmer/calls"
```

---

## Task 9: QA + PR

**Files:** —

- [ ] **Step 1: Lint**

Run: `bun lint 2>&1 | grep -E "src/(lib/transcription|hooks/useTranscription|contexts/WebRTC|components/call/Transcription|pages/FarmerCalls)" | head -10`
Expected: zero errors em arquivos novos. Anotar com `eslint-disable-next-line` se houver `any` necessários.

- [ ] **Step 2: Suite completa**

Run: `bun run vitest run`
Expected: ~120 tests (was 109 + ~14 novos do PR2).

- [ ] **Step 3: TypeScript**

Run: `bun run tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Build production**

Run: `bun build`
Expected: passa. Verificar bundle isolation:
```bash
grep -l "DeepgramClient\|TranscriptionEngine" dist/assets/index-*.js
```
Expected: zero (deveria estar em chunk do FarmerCalls ou um chunk próprio).

- [ ] **Step 5: Pre-deploy checklist**

Confirmar com o usuário:
- [ ] `DEEPGRAM_API_KEY` configurada no Lovable Cloud Secrets
- [ ] `DEEPGRAM_PROJECT_ID` configurada no Lovable Cloud Secrets (achável em https://console.deepgram.com → Settings → Project)
- [ ] Edge function `deepgram-token` deployada (Lovable detecta automaticamente)

- [ ] **Step 6: Smoke test manual**

1. Logout + login
2. /settings → flag WebRTC ON
3. /farmer/calls → ligar pra você mesmo
4. Atender no celular
5. Falar uma frase no microfone do laptop
6. Verificar: painel lateral abre, bolha "Vendedor" aparece com o texto
7. Falar no celular ("teste teste teste")
8. Verificar: bolha "Cliente" aparece com texto
9. Encerrar
10. Painel some

- [ ] **Step 7: Push + PR**

```bash
git push -u origin claude/pr2-deepgram-transcription
gh pr create --base main --head claude/pr2-deepgram-transcription \
  --title "feat: live transcription Deepgram Nova-3 (PR2)" \
  --body "..."
```

(Conteúdo do PR description — adapte com base no resultado final, mencionando: depende de PR1.5 + PR1.6 estar mergeados, requer DEEPGRAM_API_KEY + DEEPGRAM_PROJECT_ID, etc.)

---

## Self-Review

**1. Spec coverage:**

| Spec | Task |
|---|---|
| Deepgram Nova-3 streaming | Task 3 (DeepgramClient) |
| 2 canais separados | Task 4 (TranscriptionEngine) |
| Temp token (server-side master key) | Task 1 (Edge Function) |
| Side panel em /farmer/calls | Tasks 7 + 8 |
| Bolhas alternadas estilo chat | Task 7 (TurnBubble) |
| Graceful degradation sem key | Coberto pelo erro 500 da edge → hook entra em status 'error' visível |
| Cost control | Engine só inicia quando `callState === 'established'` (não desperdiça em ringing) |

Cobertura completa.

**2. Placeholder scan:** Sem "TBD". Todo código completo.

**3. Type consistency:**

- `TranscriptTurn`, `Speaker`, `TranscriptionStatus`, `DeepgramConfig` definidos em Task 2, consumidos em Tasks 3, 4, 5, 6, 7.
- `TranscriptionEngine.start({ vendorStream, clientStream })` — assinatura consistente em Tasks 4, 5.
- Hook `useTranscription({ vendorStream, clientStream, enabled })` — consistente entre Task 5 (definição) e Task 6 (uso).
- Context fields `vendorMicStream`, `transcriptionStatus`, `transcriptionTurns`, `transcriptionError` — definidos em Task 6.

**4. Riscos abertos:**

- **MediaRecorder em ambientes onde o browser não suporta `audio/webm;codecs=opus`** (Safari iOS < 14.5): cai pra default. Pra PR2, foco Chrome desktop/Android. Safari iOS é gap conhecido pra PR1.5+.
- **Deepgram temp key TTL 300s**: chamadas > 5 min vão precisar de re-fetch. Não tratado em PR2 (fica pra PR2.5 ou PR3) — call típica vendedor-cliente raramente passa de 5 min, mas vale flag.
- **Custo**: ~$0.077/call (10min) × 2 canais = $0.15/call. 1000 calls/mês = $150. Monitorar.
- **Persistência**: NÃO faz. Footer do panel avisa "PR6 vai persistir".

---

## Execution Handoff

Plan completo e salvo em `docs/superpowers/plans/2026-05-17-pr2-deepgram-transcription.md`.

**Duas opções de execução:**

1. **Subagent-Driven (recomendada)** — igual PR1, 1.5, 1.6
2. **Inline Execution** — com checkpoints

Qual abordagem?
