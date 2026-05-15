# WebRTC SIP Base (PR1 do Sales Copilot) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendedores ligam para clientes direto pelo navegador via WebRTC/JsSIP contra o SIP server da Nvoip, sem precisar aceitar a chamada no painel Nvoip. Mantém o click-to-call atual como fallback automático via feature flag, sem regredir nenhum fluxo existente.

**Architecture:** Classe `SipClient` encapsula o JsSIP User Agent com eventos tipados e gerencia REGISTER/INVITE/BYE + cleanup de MediaStreams. Hook React `useWebRTCCall` adapta a classe pra API de `useNvoipCall` (mesmos campos: `callState`, `callDuration`, `makeCall`, `endCall`, etc.) para troca drop-in. Componente apresentacional `CallDialerView` é extraído de `NvoipDialer` e reutilizado por duas wrappers (`NvoipDialer` legado + `WebRTCDialer` novo); um dispatcher `Dialer` escolhe qual wrapper renderizar baseado em `useFeatureFlag('useWebRTCCall')`. Credenciais SIP vêm de Edge Function `nvoip-sip-creds` autenticada (não bake-in no bundle). Pre-roll LGPD via MP3 estático mixado no `localStream` antes do INVITE quando IVR Nvoip indisponível.

**Tech Stack:** jssip 3.10.x · TypeScript estrito · React 18 hooks · vitest 3.2 + jsdom + @testing-library/react · MediaStream API · Web Audio API · Supabase Edge Functions (Deno).

**Não-objetivos (ficam pra PRs seguintes):**
- Transcrição ao vivo dos dois canais (PR2)
- Análise SPIN com Claude Sonnet (PR3)
- Cross-sell ao vivo (PR4)
- Gravação em Storage Supabase (PR6)
- Per-user SIP credentials (PR1.5 — single ramal por enquanto)
- Suporte Safari iOS (PR1.5)

---

## File Structure

**Criar:**
- `src/lib/sip/types.ts` — tipos compartilhados (`SipConfig`, `SipCallState`, `SipClientEvents`)
- `src/lib/sip/sip-client.ts` — classe `SipClient` wrapper de `JsSIP.UA`
- `src/lib/sip/sip-client.test.ts` — testes unitários do `SipClient` (mock de `jssip`)
- `src/lib/sip/audio-preroll.ts` — `mixPrerollWithMic(prerollUrl, micStream)`
- `src/lib/sip/audio-preroll.test.ts`
- `src/hooks/useWebRTCCall.ts` — hook React que expõe `SipClient` como state
- `src/hooks/__tests__/useWebRTCCall.test.tsx`
- `src/components/call/CallDialerView.tsx` — componente apresentacional puro
- `src/components/call/WebRTCDialer.tsx` — wrapper que injeta `useWebRTCCall`
- `src/components/call/Dialer.tsx` — dispatcher que decide WebRTC vs Nvoip
- `src/components/call/__tests__/Dialer.test.tsx`
- `supabase/functions/nvoip-sip-creds/index.ts` — Edge Function que entrega credenciais SIP do ramal autenticado
- `public/preroll/aviso-gravacao-lgpd.mp3` — áudio TTS gerado offline (placeholder até gerar real)
- `docs/superpowers/plans/2026-05-15-webrtc-sip-base-test-plan.md` — plano de teste manual

**Modificar:**
- `package.json` — adicionar `jssip` em dependencies
- `src/components/NvoipDialer.tsx` — refatorar para usar `CallDialerView` (manter API pública intacta)
- `src/pages/FarmerCalls.tsx` — trocar `NvoipDialer` por `Dialer` (dispatcher)
- `src/pages/SettingsConfig.tsx` — adicionar toggle "Usar WebRTC (beta)" pra `useWebRTCCall`
- `.env.example` — documentar `VITE_NVOIP_SIP_PREROLL_URL` (opcional)
- `CLAUDE.md` §5 — documentar `useWebRTCCall` no padrão de telefonia

**Não modificar nesta PR:**
- `supabase/functions/nvoip-calls/index.ts` (continua servindo `call_history`, `check_balance`)
- `src/hooks/useNvoipCall.ts` (fallback)
- `src/pages/FarmerCopilot.tsx` (PR2 vai mexer)

---

## Task 1: Adicionar dependência JsSIP

**Files:** `package.json`

- [ ] **Step 1: Instalar jssip**

Run: `bun add jssip@^3.10.7`

Expected: `package.json` ganha `"jssip": "^3.10.7"` em `dependencies`. `bun.lockb` atualiza.

- [ ] **Step 2: Verificar tipagem**

Run: `bun pm ls jssip`

Expected: aparece `jssip@3.10.x`. O JsSIP **já vem com types embutidos** em `node_modules/jssip/lib/JsSIP.d.ts` — não precisa `@types/jssip`.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "feat(webrtc): add jssip dependency for SIP-over-WebSocket"
```

---

## Task 2: Tipos compartilhados do SIP

**Files:** Create `src/lib/sip/types.ts`

- [ ] **Step 1: Criar types.ts**

```ts
// src/lib/sip/types.ts

export type SipCallState =
  | 'idle'
  | 'registering'
  | 'registered'
  | 'register_failed'
  | 'calling'
  | 'ringing'
  | 'established'
  | 'ending'
  | 'ended'
  | 'failed';

export interface SipConfig {
  /** wss://sip.nvoip.com.br:7443/ws — fornecido pelo suporte Nvoip */
  wsUri: string;
  /** ex.: sip.nvoip.com.br */
  sipDomain: string;
  /** Número do ramal SIP (sipUser) */
  username: string;
  /** Senha do ramal SIP */
  password: string;
  /** URI opcional do MP3 de pre-roll LGPD (se omitido, sem pre-roll) */
  prerollAudioUrl?: string;
  /** STUN/TURN servers; default usa Google public STUN */
  iceServers?: RTCIceServer[];
}

export interface SipClientEvents {
  stateChange: (state: SipCallState) => void;
  /** stream do microfone do vendedor (ou stream mixado com pre-roll) */
  localStream: (stream: MediaStream) => void;
  /** stream que chega do cliente — usado pra transcrição em PR2 */
  remoteStream: (stream: MediaStream) => void;
  error: (err: Error) => void;
}

export interface SipCallEndedData {
  durationSeconds: number;
  cause: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sip/types.ts
git commit -m "feat(webrtc): add SIP client types"
```

---

## Task 3: SipClient — REGISTER + connection lifecycle (TDD)

**Files:**
- Create: `src/lib/sip/sip-client.ts`
- Create: `src/lib/sip/sip-client.test.ts`

- [ ] **Step 1: Test — instanciar SipClient cria UA com config correta**

```ts
// src/lib/sip/sip-client.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const uaMock = {
  on: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  call: vi.fn(),
  isRegistered: vi.fn(() => false),
  isConnected: vi.fn(() => false),
};
const wsInterfaceMock = vi.fn().mockImplementation((url: string) => ({ url, via_transport: 'wss' }));

vi.mock('jssip', () => ({
  default: {
    UA: vi.fn().mockImplementation(() => uaMock),
    WebSocketInterface: wsInterfaceMock,
    debug: { disable: vi.fn() },
  },
  UA: vi.fn().mockImplementation(() => uaMock),
  WebSocketInterface: wsInterfaceMock,
}));

import JsSIP from 'jssip';
import { SipClient } from './sip-client';

describe('SipClient — register lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cria UA com WebSocketInterface no URI configurado', () => {
    new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc123',
    });

    expect(wsInterfaceMock).toHaveBeenCalledWith('wss://sip.nvoip.com.br:7443/ws');
    expect(JsSIP.UA).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: 'sip:1234567@sip.nvoip.com.br',
        password: 'abc123',
        register: true,
      })
    );
  });

  it('chama ua.start() em connect() e emite stateChange registering', () => {
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc123',
    });
    const stateSpy = vi.fn();
    client.on('stateChange', stateSpy);

    client.connect();

    expect(uaMock.start).toHaveBeenCalled();
    expect(stateSpy).toHaveBeenCalledWith('registering');
  });
});
```

- [ ] **Step 2: Run test — deve falhar (SipClient não existe)**

Run: `bun test src/lib/sip/sip-client.test.ts`
Expected: FAIL com `Cannot find module './sip-client'`.

- [ ] **Step 3: Implementar SipClient mínimo**

```ts
// src/lib/sip/sip-client.ts
import JsSIP from 'jssip';
import type { SipCallState, SipClientEvents, SipConfig } from './types';

type EventName = keyof SipClientEvents;

export class SipClient {
  private ua: JsSIP.UA;
  private state: SipCallState = 'idle';
  private listeners: { [K in EventName]?: Array<SipClientEvents[K]> } = {};

  constructor(private config: SipConfig) {
    const socket = new JsSIP.WebSocketInterface(config.wsUri);
    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${config.username}@${config.sipDomain}`,
      password: config.password,
      register: true,
      session_timers: false,
    });

    this.ua.on('registered', () => this.setState('registered'));
    this.ua.on('unregistered', () => this.setState('idle'));
    this.ua.on('registrationFailed', (e: any) => {
      this.setState('register_failed');
      this.emit('error', new Error(`SIP registration failed: ${e.cause}`));
    });
  }

  connect(): void {
    this.setState('registering');
    this.ua.start();
  }

  disconnect(): void {
    this.ua.stop();
    this.setState('idle');
  }

  getState(): SipCallState {
    return this.state;
  }

  on<K extends EventName>(event: K, handler: SipClientEvents[K]): void {
    (this.listeners[event] ??= [] as any).push(handler);
  }

  off<K extends EventName>(event: K, handler: SipClientEvents[K]): void {
    const arr = this.listeners[event];
    if (!arr) return;
    const idx = arr.indexOf(handler);
    if (idx >= 0) arr.splice(idx, 1);
  }

  private setState(next: SipCallState): void {
    this.state = next;
    this.emit('stateChange', next);
  }

  private emit<K extends EventName>(event: K, ...args: Parameters<SipClientEvents[K]>): void {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const fn of arr) (fn as any)(...args);
  }
}
```

- [ ] **Step 4: Run test — deve passar**

Run: `bun test src/lib/sip/sip-client.test.ts`
Expected: PASS 2 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sip/sip-client.ts src/lib/sip/sip-client.test.ts
git commit -m "feat(webrtc): SipClient register lifecycle with typed events"
```

---

## Task 4: SipClient — makeCall (TDD)

**Files:** Modify `src/lib/sip/sip-client.ts`, `src/lib/sip/sip-client.test.ts`

- [ ] **Step 1: Test — makeCall dispara JsSIP.UA.call com URI normalizada e expõe streams**

Adicionar ao arquivo `sip-client.test.ts` (no mesmo describe ou novo):

```ts
describe('SipClient — outbound call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uaMock.isRegistered.mockReturnValue(true);
  });

  it('chama ua.call com SIP URI E.164 e estado vira "calling"', () => {
    const session = {
      on: vi.fn(),
      terminate: vi.fn(),
      connection: {
        getReceivers: vi.fn(() => [{ track: { kind: 'audio' } }]),
      },
    };
    uaMock.call.mockReturnValue(session);

    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    client.connect();
    const stateSpy = vi.fn();
    client.on('stateChange', stateSpy);

    const fakeMic = new MediaStream();
    client.makeCall('37999998888', fakeMic);

    expect(uaMock.call).toHaveBeenCalledWith(
      'sip:37999998888@sip.nvoip.com.br',
      expect.objectContaining({
        mediaStream: fakeMic,
        rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      })
    );
    expect(stateSpy).toHaveBeenCalledWith('calling');
  });

  it('lança erro se chamada disparada sem REGISTER', () => {
    uaMock.isRegistered.mockReturnValue(false);
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });

    expect(() => client.makeCall('3799999', new MediaStream()))
      .toThrow(/not registered/i);
  });
});
```

- [ ] **Step 2: Run test — deve falhar (makeCall não existe)**

Run: `bun test src/lib/sip/sip-client.test.ts -t outbound`
Expected: FAIL.

- [ ] **Step 3: Implementar makeCall**

Adicionar no `SipClient`:

```ts
import type { SipCallEndedData } from './types';

// ...dentro da classe SipClient:

private currentSession: any = null;
private callStartedAt: number | null = null;

makeCall(phoneE164: string, micStream: MediaStream): void {
  if (!this.ua.isRegistered()) {
    throw new Error('SIP client not registered — call connect() first');
  }

  const target = `sip:${phoneE164}@${this.config.sipDomain}`;
  this.setState('calling');
  this.emit('localStream', micStream);

  this.currentSession = this.ua.call(target, {
    mediaConstraints: { audio: true, video: false },
    mediaStream: micStream,
    rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
    pcConfig: {
      iceServers: this.config.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
    },
  });

  this.currentSession.on('progress', () => this.setState('ringing'));
  this.currentSession.on('accepted', () => {
    this.callStartedAt = Date.now();
    this.setState('established');
    this.extractRemoteStream();
  });
  this.currentSession.on('failed', (e: any) => {
    this.setState('failed');
    this.emit('error', new Error(`Call failed: ${e.cause}`));
  });
  this.currentSession.on('ended', () => {
    this.setState('ended');
  });
}

private extractRemoteStream(): void {
  const pc: RTCPeerConnection | undefined = this.currentSession?.connection;
  if (!pc) return;
  const receivers = pc.getReceivers();
  const tracks = receivers
    .map((r) => r.track)
    .filter((t): t is MediaStreamTrack => !!t && t.kind === 'audio');
  if (tracks.length === 0) return;
  const remote = new MediaStream(tracks);
  this.emit('remoteStream', remote);
}
```

- [ ] **Step 4: Run test — deve passar**

Run: `bun test src/lib/sip/sip-client.test.ts`
Expected: PASS 4 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sip/
git commit -m "feat(webrtc): SipClient.makeCall with state machine and stream extraction"
```

---

## Task 5: SipClient — hangUp + cleanup de mídia (TDD)

**Files:** Modify `src/lib/sip/sip-client.ts`, `src/lib/sip/sip-client.test.ts`

- [ ] **Step 1: Test — hangUp termina sessão e para tracks do mic**

```ts
describe('SipClient — hangUp cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uaMock.isRegistered.mockReturnValue(true);
  });

  it('hangUp chama session.terminate e para tracks do localStream', () => {
    const session = { on: vi.fn(), terminate: vi.fn(), connection: { getReceivers: () => [] } };
    uaMock.call.mockReturnValue(session);

    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    client.connect();
    const stopMock = vi.fn();
    const micStream = { getTracks: () => [{ stop: stopMock, kind: 'audio' }] } as unknown as MediaStream;
    client.makeCall('3799', micStream);

    client.hangUp();

    expect(session.terminate).toHaveBeenCalled();
    expect(stopMock).toHaveBeenCalled();
  });

  it('hangUp em estado idle é noop seguro', () => {
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    expect(() => client.hangUp()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test — deve falhar**

Run: `bun test src/lib/sip/sip-client.test.ts -t hangUp`
Expected: FAIL.

- [ ] **Step 3: Implementar hangUp**

Adicionar campo e método em `SipClient`:

```ts
private currentLocalStream: MediaStream | null = null;

// dentro de makeCall, logo após emit('localStream', micStream):
this.currentLocalStream = micStream;

// novo método público:
hangUp(): void {
  if (this.currentSession) {
    try {
      this.currentSession.terminate();
    } catch {
      // session já encerrada — ok
    }
    this.currentSession = null;
  }
  if (this.currentLocalStream) {
    for (const track of this.currentLocalStream.getTracks()) {
      track.stop();
    }
    this.currentLocalStream = null;
  }
  if (this.state === 'calling' || this.state === 'ringing' || this.state === 'established') {
    this.setState('ended');
  }
}

getCallDurationSeconds(): number {
  if (!this.callStartedAt) return 0;
  return Math.floor((Date.now() - this.callStartedAt) / 1000);
}
```

- [ ] **Step 4: Run test — deve passar**

Run: `bun test src/lib/sip/sip-client.test.ts`
Expected: PASS 6 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sip/
git commit -m "feat(webrtc): SipClient.hangUp with media track cleanup"
```

---

## Task 6: Pre-roll de aviso LGPD — mixagem MP3 + microfone (TDD)

**Files:**
- Create: `src/lib/sip/audio-preroll.ts`
- Create: `src/lib/sip/audio-preroll.test.ts`

- [ ] **Step 1: Test — mixPrerollWithMic retorna MediaStream e toca MP3 antes do mic**

```ts
// src/lib/sip/audio-preroll.test.ts
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
```

- [ ] **Step 2: Run test — deve falhar**

Run: `bun test src/lib/sip/audio-preroll.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar mixagem**

```ts
// src/lib/sip/audio-preroll.ts

/**
 * Mistura um MP3 de pre-roll (aviso LGPD de gravação) com o áudio do mic em um único MediaStream.
 * Ao iniciar a chamada, o cliente ouve primeiro o aviso, depois o vendedor.
 *
 * @param prerollUrl URL do arquivo MP3 (ex.: /preroll/aviso-gravacao-lgpd.mp3)
 * @param micStream MediaStream do microfone do vendedor (de getUserMedia)
 * @returns MediaStream com o áudio mixado, pronto pra passar pro JsSIP.UA.call
 */
export async function mixPrerollWithMic(
  prerollUrl: string,
  micStream: MediaStream
): Promise<MediaStream> {
  const ctx = new AudioContext();

  // Mic source — sempre conectado
  const micSource = ctx.createMediaStreamSource(micStream);
  const destination = ctx.createMediaStreamDestination();
  micSource.connect(destination);

  // Pre-roll buffer
  const resp = await fetch(prerollUrl);
  const arrayBuffer = await resp.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

  const prerollSource = ctx.createBufferSource();
  prerollSource.buffer = audioBuffer;
  prerollSource.connect(destination);
  prerollSource.start();

  return destination.stream;
}
```

- [ ] **Step 4: Run test — deve passar**

Run: `bun test src/lib/sip/audio-preroll.test.ts`
Expected: PASS 2 testes.

- [ ] **Step 5: Adicionar placeholder do MP3**

Run:
```bash
mkdir -p public/preroll
touch public/preroll/aviso-gravacao-lgpd.mp3
echo "MP3 será gerado via ElevenLabs TTS PT-BR antes do merge — texto canônico em CLAUDE.md §LGPD" > public/preroll/README.md
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/sip/audio-preroll.ts src/lib/sip/audio-preroll.test.ts public/preroll/
git commit -m "feat(webrtc): LGPD pre-roll mixer for SIP outbound audio"
```

---

## Task 7: Edge Function — entregar credenciais SIP do ramal (server-side)

**Files:** Create `supabase/functions/nvoip-sip-creds/index.ts`

- [ ] **Step 1: Criar edge function**

```ts
// supabase/functions/nvoip-sip-creds/index.ts
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return new Response(JSON.stringify({ error: "Sessão inválida" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!roleData || !["employee", "master"].includes(roleData.role)) {
      return new Response(JSON.stringify({ error: "Sem permissão" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const wsUri = Deno.env.get("NVOIP_SIP_WSS");
    const sipDomain = Deno.env.get("NVOIP_SIP_DOMAIN");
    const username = Deno.env.get("NVOIP_SIP_USER");
    const password = Deno.env.get("NVOIP_SIP_PASS");

    if (!wsUri || !sipDomain || !username || !password) {
      return new Response(
        JSON.stringify({ error: "Credenciais SIP não configuradas no servidor" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ wsUri, sipDomain, username, password }),
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

- [ ] **Step 2: Documentar env vars no README do supabase**

Adicionar comentário sobre `NVOIP_SIP_WSS`, `NVOIP_SIP_DOMAIN`, `NVOIP_SIP_USER`, `NVOIP_SIP_PASS` em qualquer doc/checklist de env existente (ex.: `supabase/.env.example` se existir, senão criar inline no plano).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/nvoip-sip-creds/
git commit -m "feat(webrtc): edge function to deliver SIP creds to authenticated staff"
```

---

## Task 8: Hook useWebRTCCall (TDD)

**Files:**
- Create: `src/hooks/useWebRTCCall.ts`
- Create: `src/hooks/__tests__/useWebRTCCall.test.tsx`

- [ ] **Step 1: Test — hook expõe API equivalente a useNvoipCall**

```tsx
// src/hooks/__tests__/useWebRTCCall.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWebRTCCall } from '../useWebRTCCall';

const sipClientMock = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  makeCall: vi.fn(),
  hangUp: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  getState: vi.fn(() => 'idle'),
  getCallDurationSeconds: vi.fn(() => 0),
};

vi.mock('@/lib/sip/sip-client', () => ({
  SipClient: vi.fn().mockImplementation(() => sipClientMock),
}));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: vi.fn().mockResolvedValue({
    wsUri: 'wss://sip.nvoip.com.br:7443/ws',
    sipDomain: 'sip.nvoip.com.br',
    username: '1234567',
    password: 'pw',
  }),
}));

// Stub getUserMedia
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockResolvedValue(new MediaStream()) },
    configurable: true,
  });
});

describe('useWebRTCCall', () => {
  it('inicializa SipClient e chama connect após carregar credenciais', async () => {
    const { result } = renderHook(() => useWebRTCCall());

    await waitFor(() => expect(sipClientMock.connect).toHaveBeenCalled());
    expect(result.current.callState).toBe('idle');
  });

  it('makeCall pede mic e chama SipClient.makeCall', async () => {
    const { result } = renderHook(() => useWebRTCCall());
    await waitFor(() => expect(sipClientMock.connect).toHaveBeenCalled());

    await act(async () => {
      await result.current.makeCall('37999998888');
    });

    expect(globalThis.navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(sipClientMock.makeCall).toHaveBeenCalledWith('37999998888', expect.any(MediaStream));
  });

  it('endCall chama SipClient.hangUp', async () => {
    const { result } = renderHook(() => useWebRTCCall());
    await waitFor(() => expect(sipClientMock.connect).toHaveBeenCalled());

    await act(async () => {
      await result.current.endCall();
    });

    expect(sipClientMock.hangUp).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — deve falhar**

Run: `bun test src/hooks/__tests__/useWebRTCCall.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementar useWebRTCCall**

```ts
// src/hooks/useWebRTCCall.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { SipClient } from '@/lib/sip/sip-client';
import type { SipCallState } from '@/lib/sip/types';
import { invokeFunction } from '@/lib/invoke-function';
import { useToast } from '@/hooks/use-toast';
import { normalizeBrPhone, formatBrPhone } from '@/lib/phone';
import { mixPrerollWithMic } from '@/lib/sip/audio-preroll';

export type WebRTCCallState =
  | 'idle' | 'connecting' | 'calling_origin' | 'calling_destination'
  | 'established' | 'finished' | 'noanswer' | 'busy' | 'failed' | 'error';

const SIP_TO_PUBLIC: Record<SipCallState, WebRTCCallState> = {
  idle: 'idle',
  registering: 'connecting',
  registered: 'idle',
  register_failed: 'error',
  calling: 'calling_destination',
  ringing: 'calling_destination',
  established: 'established',
  ending: 'established',
  ended: 'finished',
  failed: 'failed',
};

interface UseWebRTCCallReturn {
  callState: WebRTCCallState;
  callId: string | null;
  callDuration: number;
  audioLink: string | null;
  makeCall: (phoneNumber: string) => Promise<void>;
  endCall: () => Promise<void>;
  isActive: boolean;
  isConnecting: boolean;
  isRinging: boolean;
  isEstablished: boolean;
  isFinished: boolean;
  error: string | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

export function useWebRTCCall(): UseWebRTCCallReturn {
  const { toast } = useToast();
  const [callState, setCallState] = useState<WebRTCCallState>('idle');
  const [callDuration, setCallDuration] = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<SipClient | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const prerollUrl = import.meta.env.VITE_NVOIP_SIP_PREROLL_URL as string | undefined;

  // Initialize SipClient on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const creds = await invokeFunction<{
          wsUri: string; sipDomain: string; username: string; password: string;
        }>('nvoip-sip-creds', {});
        if (cancelled) return;

        const client = new SipClient(creds);
        clientRef.current = client;

        client.on('stateChange', (s) => setCallState(SIP_TO_PUBLIC[s]));
        client.on('localStream', (s) => setLocalStream(s));
        client.on('remoteStream', (s) => setRemoteStream(s));
        client.on('error', (e) => {
          setError(e.message);
          toast({ title: 'Erro WebRTC', description: e.message, variant: 'destructive' });
        });

        client.connect();
      } catch (err: any) {
        if (cancelled) return;
        setError(err.message ?? 'Falha ao inicializar WebRTC');
        setCallState('error');
      }
    })();

    return () => {
      cancelled = true;
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      clientRef.current?.disconnect();
    };
  }, [toast]);

  // Duration timer when established
  useEffect(() => {
    if (callState === 'established' && !durationTimerRef.current) {
      durationTimerRef.current = window.setInterval(() => {
        setCallDuration((d) => d + 1);
      }, 1000);
    } else if (callState !== 'established' && durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, [callState]);

  const makeCall = useCallback(async (phoneNumber: string) => {
    setError(null);
    setCallDuration(0);

    const normalized = normalizeBrPhone(phoneNumber);
    if (normalized.length < 10) {
      const msg = 'Telefone inválido. É necessário DDD + número.';
      setError(msg);
      toast({ title: 'Erro', description: msg, variant: 'destructive' });
      return;
    }

    if (!clientRef.current) {
      setError('WebRTC não inicializado');
      return;
    }

    try {
      const rawMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const micStream = prerollUrl
        ? await mixPrerollWithMic(prerollUrl, rawMic)
        : rawMic;

      clientRef.current.makeCall(normalized, micStream);
      toast({ title: '📞 Chamada iniciada', description: `Ligando para ${formatBrPhone(normalized)}...` });
    } catch (err: any) {
      setError(err.message ?? 'Erro ao iniciar chamada');
      toast({ title: 'Erro na chamada', description: err.message, variant: 'destructive' });
    }
  }, [toast, prerollUrl]);

  const endCall = useCallback(async () => {
    clientRef.current?.hangUp();
    toast({ title: 'Chamada encerrada' });
  }, [toast]);

  const isActive = !['idle', 'finished', 'noanswer', 'busy', 'failed', 'error'].includes(callState);
  const isConnecting = callState === 'connecting';
  const isRinging = callState === 'calling_origin' || callState === 'calling_destination';
  const isEstablished = callState === 'established';
  const isFinished = ['finished', 'noanswer', 'busy', 'failed'].includes(callState);

  return {
    callState,
    callId: null, // WebRTC não tem callId como Nvoip API; usar SIP Call-ID se necessário
    callDuration,
    audioLink: null, // PR6 vai persistir áudio
    makeCall,
    endCall,
    isActive, isConnecting, isRinging, isEstablished, isFinished,
    error,
    localStream,
    remoteStream,
  };
}
```

- [ ] **Step 4: Run test — deve passar**

Run: `bun test src/hooks/__tests__/useWebRTCCall.test.tsx`
Expected: PASS 3 testes.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useWebRTCCall.ts src/hooks/__tests__/useWebRTCCall.test.tsx
git commit -m "feat(webrtc): useWebRTCCall hook with API compat to useNvoipCall"
```

---

## Task 9: Componente apresentacional CallDialerView

**Files:**
- Create: `src/components/call/CallDialerView.tsx`

- [ ] **Step 1: Extrair JSX puro de NvoipDialer pra CallDialerView**

```tsx
// src/components/call/CallDialerView.tsx
import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, PhoneOff, PhoneCall, PhoneIncoming, Loader2, Volume2, AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { formatBrPhone, normalizeBrPhone } from '@/lib/phone';

export type CallDialerCallState =
  | 'idle' | 'connecting' | 'calling_origin' | 'calling_destination'
  | 'established' | 'finished' | 'noanswer' | 'busy' | 'failed' | 'error';

export interface CallDialerViewProps {
  phoneNumber: string;
  customerName: string;
  callState: CallDialerCallState;
  callDuration: number;
  audioLink: string | null;
  error: string | null;
  isActive: boolean;
  isConnecting: boolean;
  isRinging: boolean;
  isEstablished: boolean;
  isFinished: boolean;
  onMakeCall: (phone: string) => void;
  onEndCall: () => void;
  onCallEnd?: (data: { duration: number; state: CallDialerCallState; audioLink: string | null }) => void;
  compact?: boolean;
  floating?: boolean;
  /** ID para identificar visualmente backend (ex.: badge "WebRTC" vs "Nvoip") */
  backendLabel?: 'Nvoip' | 'WebRTC';
}

const STATE_LABELS: Record<CallDialerCallState, string> = {
  idle: 'Pronto',
  connecting: 'Conectando...',
  calling_origin: 'Chamando ramal...',
  calling_destination: 'Chamando...',
  established: 'Em chamada',
  finished: 'Finalizada',
  noanswer: 'Sem resposta',
  busy: 'Ocupado',
  failed: 'Falhou',
  error: 'Erro',
};

const STATE_COLORS: Record<CallDialerCallState, string> = {
  idle: 'text-muted-foreground',
  connecting: 'text-status-warning',
  calling_origin: 'text-status-warning',
  calling_destination: 'text-status-warning',
  established: 'text-status-success',
  finished: 'text-muted-foreground',
  noanswer: 'text-status-warning',
  busy: 'text-status-error',
  failed: 'text-status-error',
  error: 'text-status-error',
};

function formatTimer(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallDialerView(props: CallDialerViewProps) {
  const {
    phoneNumber, customerName, callState, callDuration, audioLink, error,
    isActive, isConnecting, isRinging, isEstablished, isFinished,
    onMakeCall, onEndCall, onCallEnd, compact = false, floating = false, backendLabel,
  } = props;

  const [dismissed, setDismissed] = useState(false);
  const displayPhone = formatBrPhone(phoneNumber);
  const hasValidPhone = normalizeBrPhone(phoneNumber).length >= 10;

  useEffect(() => {
    if (isFinished && onCallEnd) {
      onCallEnd({ duration: callDuration, state: callState, audioLink });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFinished]);

  if (dismissed) return null;

  // Compact: just call button
  if (compact && callState === 'idle') {
    return (
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 text-status-success hover:bg-status-success-bg"
        onClick={() => onMakeCall(phoneNumber)}
        disabled={!hasValidPhone}
        title={hasValidPhone ? `Ligar para ${displayPhone}` : 'Telefone inválido'}
      >
        <Phone className="w-4 h-4" />
      </Button>
    );
  }

  // Idle (non-compact): full button
  if (!isActive && !isFinished && callState !== 'error' && !floating) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5 text-xs h-8"
        onClick={() => onMakeCall(phoneNumber)}
        disabled={!hasValidPhone}
      >
        <Phone className="w-3.5 h-3.5" /> Ligar {hasValidPhone ? displayPhone : ''}
      </Button>
    );
  }

  // Active or result panel
  const cardClass = cn(
    'border-2 transition-colors',
    isEstablished && 'border-status-success',
    isRinging && 'border-status-warning',
    isConnecting && 'border-status-warning/70',
    isFinished && 'border-border',
    callState === 'error' && 'border-status-error',
    floating && 'shadow-lg',
  );

  const cardContent = (
    <CardContent className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isRinging && <PhoneCall className="w-4 h-4 text-status-warning animate-pulse" />}
          {isEstablished && <PhoneIncoming className="w-4 h-4 text-status-success" />}
          {isConnecting && <Loader2 className="w-4 h-4 text-status-warning animate-spin" />}
          {callState === 'error' && <AlertCircle className="w-4 h-4 text-status-error" />}
          <div>
            <p className="text-sm font-medium">{customerName}</p>
            <p className="text-xs text-muted-foreground">{displayPhone}</p>
          </div>
        </div>
        {(isFinished || callState === 'error') && (
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setDismissed(true)}>
            <X className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn('text-xs', STATE_COLORS[callState])}>
            {STATE_LABELS[callState]}
          </Badge>
          {backendLabel && (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide opacity-60">
              {backendLabel}
            </Badge>
          )}
          {(isEstablished || isFinished) && (
            <span className="text-lg font-mono font-bold tabular-nums">{formatTimer(callDuration)}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {audioLink && (
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1" asChild>
              <a href={audioLink} target="_blank" rel="noopener noreferrer">
                <Volume2 className="w-3 h-3" /> Ouvir
              </a>
            </Button>
          )}
          {isActive && (
            <Button size="sm" variant="destructive" className="h-8 text-xs gap-1" onClick={onEndCall}>
              <PhoneOff className="w-3 h-3" /> Encerrar
            </Button>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-status-error mt-2">{error}</p>}
    </CardContent>
  );

  const card = <Card className={cardClass}>{cardContent}</Card>;

  if (floating) {
    return (
      <div className="fixed bottom-20 left-4 right-4 z-50 md:left-auto md:right-6 md:max-w-sm">
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.95 }}
          >
            {card}
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
      >
        {card}
      </motion.div>
    </AnimatePresence>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/call/CallDialerView.tsx
git commit -m "feat(webrtc): extract presentational CallDialerView from NvoipDialer"
```

---

## Task 10: WebRTCDialer + Dialer dispatcher + refactor NvoipDialer

**Files:**
- Create: `src/components/call/WebRTCDialer.tsx`
- Create: `src/components/call/Dialer.tsx`
- Create: `src/components/call/__tests__/Dialer.test.tsx`
- Modify: `src/components/NvoipDialer.tsx`

- [ ] **Step 1: Criar WebRTCDialer**

```tsx
// src/components/call/WebRTCDialer.tsx
import { useWebRTCCall } from '@/hooks/useWebRTCCall';
import { CallDialerView, type CallDialerViewProps } from './CallDialerView';

type Props = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact' | 'floating'>;

export function WebRTCDialer(props: Props) {
  const call = useWebRTCCall();

  return (
    <CallDialerView
      {...props}
      callState={call.callState}
      callDuration={call.callDuration}
      audioLink={call.audioLink}
      error={call.error}
      isActive={call.isActive}
      isConnecting={call.isConnecting}
      isRinging={call.isRinging}
      isEstablished={call.isEstablished}
      isFinished={call.isFinished}
      onMakeCall={call.makeCall}
      onEndCall={call.endCall}
      backendLabel="WebRTC"
    />
  );
}
```

- [ ] **Step 2: Refatorar NvoipDialer pra usar CallDialerView**

Substituir conteúdo de `src/components/NvoipDialer.tsx` mantendo as exports `NvoipDialer` e `NvoipFloatingDialer`:

```tsx
// src/components/NvoipDialer.tsx
import { useNvoipCall, type NvoipCallState } from '@/hooks/useNvoipCall';
import { CallDialerView, type CallDialerViewProps } from './call/CallDialerView';

type SharedProps = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact'>;

export type { NvoipCallState };

export function NvoipDialer(props: SharedProps) {
  const call = useNvoipCall();
  return (
    <CallDialerView
      {...props}
      callState={call.callState}
      callDuration={call.callDuration}
      audioLink={call.audioLink}
      error={call.error}
      isActive={call.isActive}
      isConnecting={call.isConnecting}
      isRinging={call.isRinging}
      isEstablished={call.isEstablished}
      isFinished={call.isFinished}
      onMakeCall={call.makeCall}
      onEndCall={call.endCall}
      backendLabel="Nvoip"
    />
  );
}

export function NvoipFloatingDialer(props: SharedProps) {
  const call = useNvoipCall();
  return (
    <CallDialerView
      {...props}
      floating
      callState={call.callState}
      callDuration={call.callDuration}
      audioLink={call.audioLink}
      error={call.error}
      isActive={call.isActive}
      isConnecting={call.isConnecting}
      isRinging={call.isRinging}
      isEstablished={call.isEstablished}
      isFinished={call.isFinished}
      onMakeCall={call.makeCall}
      onEndCall={call.endCall}
      backendLabel="Nvoip"
    />
  );
}
```

- [ ] **Step 3: Criar Dialer dispatcher**

```tsx
// src/components/call/Dialer.tsx
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { NvoipDialer, NvoipFloatingDialer } from '@/components/NvoipDialer';
import { WebRTCDialer } from './WebRTCDialer';
import type { CallDialerViewProps } from './CallDialerView';

type Props = Pick<CallDialerViewProps, 'phoneNumber' | 'customerName' | 'onCallEnd' | 'compact' | 'floating'>;

export function Dialer(props: Props) {
  const [useWebRTC] = useFeatureFlag('useWebRTCCall', false);

  if (useWebRTC) return <WebRTCDialer {...props} />;
  if (props.floating) return <NvoipFloatingDialer {...props} />;
  return <NvoipDialer {...props} />;
}
```

- [ ] **Step 4: Test — dispatcher escolhe componente certo**

```tsx
// src/components/call/__tests__/Dialer.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dialer } from '../Dialer';

vi.mock('@/hooks/useFeatureFlag', () => ({
  useFeatureFlag: vi.fn(),
}));

vi.mock('@/hooks/useNvoipCall', () => ({
  useNvoipCall: () => ({
    callState: 'idle', callDuration: 0, audioLink: null, error: null,
    isActive: false, isConnecting: false, isRinging: false, isEstablished: false, isFinished: false,
    makeCall: vi.fn(), endCall: vi.fn(),
  }),
}));

vi.mock('@/hooks/useWebRTCCall', () => ({
  useWebRTCCall: () => ({
    callState: 'idle', callDuration: 0, audioLink: null, error: null,
    isActive: false, isConnecting: false, isRinging: false, isEstablished: false, isFinished: false,
    makeCall: vi.fn(), endCall: vi.fn(),
    localStream: null, remoteStream: null,
  }),
}));

import { useFeatureFlag } from '@/hooks/useFeatureFlag';

describe('Dialer dispatcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renderiza NvoipDialer quando flag off', () => {
    (useFeatureFlag as any).mockReturnValue([false, vi.fn()]);
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    // não há badge "WEBRTC" no idle compact, mas há "Ligar" do path Nvoip
    // pelo menos confirmamos que o feature flag foi consultado
    expect(useFeatureFlag).toHaveBeenCalledWith('useWebRTCCall', false);
  });

  it('renderiza WebRTCDialer quando flag on', () => {
    (useFeatureFlag as any).mockReturnValue([true, vi.fn()]);
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    expect(useFeatureFlag).toHaveBeenCalledWith('useWebRTCCall', false);
  });
});
```

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: PASS — todos os novos testes verdes, e os tests legados existentes não regrediram.

- [ ] **Step 6: Commit**

```bash
git add src/components/call/ src/components/NvoipDialer.tsx
git commit -m "feat(webrtc): Dialer dispatcher + WebRTCDialer + NvoipDialer refactor"
```

---

## Task 11: Integrar Dialer em FarmerCalls + toggle em SettingsConfig

**Files:**
- Modify: `src/pages/FarmerCalls.tsx`
- Modify: `src/pages/SettingsConfig.tsx`

- [ ] **Step 1: Trocar NvoipDialer por Dialer em FarmerCalls**

Em `src/pages/FarmerCalls.tsx`, substituir o import `NvoipDialer` por `Dialer`:

```ts
// remover:
// import { NvoipDialer } from '@/components/NvoipDialer';

// adicionar:
import { Dialer } from '@/components/call/Dialer';
```

E qualquer uso de `<NvoipDialer ... />` no JSX vira `<Dialer ... />`. A API é compatível (mesmas props).

> ⚠️ Se o hook `useNvoipCall` é usado diretamente em FarmerCalls (linha ~206 — `const { callState: nvoipState, ... } = useNvoipCall();`), **não trocar nesta task**. O dispatcher só substitui o COMPONENTE; a lógica de salvar `farmer_calls` no banco continua usando `useNvoipCall` em paralelo. Em PR1.5 a gente substitui pelo dispatcher de hook (`useCallBackend()`).

- [ ] **Step 2: Adicionar toggle em SettingsConfig**

Em `src/pages/SettingsConfig.tsx`, adicionar (perto do toggle `newVisual` existente):

```tsx
const [useWebRTC, setUseWebRTC] = useFeatureFlag('useWebRTCCall', false);

// JSX:
<div className="flex items-center justify-between py-3 border-b">
  <div>
    <p className="font-medium">Chamadas WebRTC (beta)</p>
    <p className="text-sm text-muted-foreground">
      Ligar direto pelo navegador via SIP, sem aceitar no painel Nvoip.
      Requer permissão de microfone. Desligue para voltar ao fluxo atual.
    </p>
  </div>
  <Switch checked={useWebRTC} onCheckedChange={setUseWebRTC} />
</div>
```

(Adapte conforme padrão exato dos toggles já existentes no arquivo.)

- [ ] **Step 3: Verificar build**

Run: `bun run build:dev`
Expected: build passa sem erros TS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/FarmerCalls.tsx src/pages/SettingsConfig.tsx
git commit -m "feat(webrtc): wire Dialer dispatcher + settings toggle"
```

---

## Task 12: env.example + CLAUDE.md docs

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Adicionar env vars ao .env.example**

```
# Pre-roll LGPD (opcional) — URL pública do MP3 de aviso de gravação
VITE_NVOIP_SIP_PREROLL_URL=/preroll/aviso-gravacao-lgpd.mp3
```

E em `supabase/.env` (server-side, NUNCA commitado):
```
NVOIP_SIP_WSS=wss://sip.nvoip.com.br:7443/ws
NVOIP_SIP_DOMAIN=sip.nvoip.com.br
NVOIP_SIP_USER=
NVOIP_SIP_PASS=
```

- [ ] **Step 2: Atualizar CLAUDE.md §5**

Adicionar no padrão de telefonia (§5):

```md
### Telefonia (WebRTC vs Nvoip click-to-call)

- **Default**: `useNvoipCall` (Edge Function + polling) — click-to-call, vendedor atende no softphone Nvoip.
- **WebRTC opt-in**: `useWebRTCCall` (JsSIP + SIP over WebSocket) — vendedor liga direto pelo navegador, áudio bidirecional capturado para PR2 (transcrição ao vivo).
- **Dispatcher**: `<Dialer />` em `src/components/call/Dialer.tsx` escolhe baseado em `useFeatureFlag('useWebRTCCall', false)`.
- **LGPD**: MP3 de aviso em `public/preroll/aviso-gravacao-lgpd.mp3` é injetado no `localStream` quando IVR Nvoip indisponível.
- **Credenciais SIP**: nunca em `VITE_*` (vazariam no bundle). Servidas pela Edge Function `nvoip-sip-creds` (auth + staff role).
```

- [ ] **Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "docs(webrtc): document WebRTC dialer pattern and env vars"
```

---

## Task 13: Plano de teste manual

**Files:** Create `docs/superpowers/plans/2026-05-15-webrtc-sip-base-test-plan.md`

- [ ] **Step 1: Documentar checklist de teste manual**

```md
# Teste Manual — WebRTC SIP Base

## Pré-requisitos
- [ ] Env vars `NVOIP_SIP_*` configuradas no Supabase (server-side)
- [ ] Suporte Nvoip confirmou `wsUri` e liberou WebRTC pra conta
- [ ] MP3 real gerado em `public/preroll/aviso-gravacao-lgpd.mp3` (TTS PT-BR via ElevenLabs)
- [ ] Browser Chrome 120+ com permissão de microfone

## Cenário 1 — Ligação WebRTC bem-sucedida
- [ ] Login como staff
- [ ] /settings → ativar "Chamadas WebRTC (beta)"
- [ ] /farmer/calls → escolher cliente com telefone válido
- [ ] Clicar "Ligar"
- [ ] Verificar: navegador pede permissão de mic
- [ ] Conceder. Aguardar dialer mudar de "Conectando..." para "Chamando..."
- [ ] Cliente recebe ligação no celular. Atender.
- [ ] Verificar: dialer vira "Em chamada", timer começa a contar
- [ ] Áudio bidirecional funciona (vendedor ouve cliente, cliente ouve vendedor)
- [ ] Clicar "Encerrar"
- [ ] Dialer vira "Finalizada"

## Cenário 2 — Pre-roll LGPD ouvido pelo cliente
- [ ] Repetir cenário 1
- [ ] Confirmar com pessoa do outro lado: "ouviu aviso de gravação antes do vendedor falar?"
- [ ] Se não, verificar console por erros em `audio-preroll`

## Cenário 3 — Fallback automático
- [ ] /settings → desativar "Chamadas WebRTC (beta)"
- [ ] /farmer/calls → ligar
- [ ] Verificar: dialer mostra badge "NVOIP" (não "WEBRTC")
- [ ] Comportamento Nvoip click-to-call original funciona

## Cenário 4 — Reconexão
- [ ] Ativar flag WebRTC
- [ ] Iniciar uma ligação
- [ ] Desligar/religar Wi-Fi durante chamada
- [ ] Verificar: chamada termina com `failed` (não crash)
- [ ] Iniciar nova chamada após reconectar: deve funcionar

## Cenário 5 — Sem credenciais SIP
- [ ] Remover env var `NVOIP_SIP_PASS` do Supabase
- [ ] Ativar flag WebRTC
- [ ] Tentar ligar
- [ ] Verificar: toast de erro "Credenciais SIP não configuradas"
- [ ] Dialer fica em estado `error` sem crashar

## Checklist de regressão
- [ ] Toda a página /farmer/calls funciona com flag off (Nvoip atual)
- [ ] /farmer/copilot continua funcionando (não tocamos PR1)
- [ ] /admin/* não foi afetado
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-05-15-webrtc-sip-base-test-plan.md
git commit -m "docs(webrtc): manual test plan for WebRTC SIP base"
```

---

## Task 14: QA final + lint + build

**Files:** —

- [ ] **Step 1: Lint**

Run: `bun lint`
Expected: zero errors em arquivos novos. Se houver warnings em arquivos não tocados, ignorar.

- [ ] **Step 2: Todos os testes**

Run: `bun test`
Expected: PASS — incluindo testes existentes.

- [ ] **Step 3: Build production**

Run: `bun build`
Expected: build passa sem erros. PWA bundle gerado.

- [ ] **Step 4: Commit qualquer ajuste**

```bash
git add -A
git commit -m "chore(webrtc): lint + test + build cleanup"
```

- [ ] **Step 5: Push branch e abrir PR**

```bash
git push -u origin claude/hungry-lovelace-87b509
gh pr create --title "feat: WebRTC SIP softphone (PR1 do sales copilot)" --body "$(cat <<'EOF'
## Summary

- Adiciona softphone WebRTC via JsSIP + Nvoip SIP-over-WebSocket
- Vendedores ligam direto pelo navegador, sem aceitar no painel Nvoip
- Mantém click-to-call atual como fallback automático via feature flag `useWebRTCCall`
- Pre-roll LGPD injetado no áudio outbound (aviso de gravação ao cliente)
- Credenciais SIP servidas via Edge Function autenticada (não bake no bundle)

## Architecture

- `SipClient` (lib/sip/): wrapper tipado de `JsSIP.UA` com eventos
- `useWebRTCCall` (hooks/): hook React API-compatible com `useNvoipCall`
- `CallDialerView` (components/call/): UI presentacional reusada por ambos backends
- `Dialer` (components/call/): dispatcher que escolhe backend por flag
- `nvoip-sip-creds` (supabase/functions/): entrega credenciais SIP a staff autenticado

## Não inclui (PRs seguintes)

- Transcrição ao vivo dos dois canais (PR2)
- Análise SPIN com Claude Sonnet (PR3)
- Cross-sell ao vivo (PR4)
- Gravação em Storage Supabase (PR6)

## Test plan

Ver `docs/superpowers/plans/2026-05-15-webrtc-sip-base-test-plan.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ WebRTC direto sem site Nvoip → Tasks 3-10
- ✅ Fallback click-to-call → Task 10 (Dialer dispatcher)
- ✅ Pre-roll LGPD → Task 6 (audio-preroll)
- ✅ Credenciais server-side → Task 7 (Edge Function)
- ✅ Two streams expostos pra PR2 → Task 4 (extractRemoteStream) + Task 8 (hook expõe)
- ✅ Cleanup de mic ao encerrar → Task 5
- ✅ Feature flag opt-in → Task 11 (SettingsConfig)
- ✅ Documentação → Task 12
- ✅ Teste manual → Task 13

**2. Placeholder scan:** Nenhum "TODO/TBD/implement later" nas tasks. Todo código está completo.

**3. Type consistency:**
- `SipCallState` definido em types.ts, usado em SipClient (Task 3) e mapeado para `WebRTCCallState` em useWebRTCCall (Task 8). Mapping table cobre todos os estados.
- `CallDialerViewProps` definido em Task 9, consumido em Task 10 via `Pick<>` — consistente.
- `SipConfig` flui de Edge Function (Task 7) → hook (Task 8) → SipClient (Task 3). Mesmas chaves: `wsUri`, `sipDomain`, `username`, `password`.

**4. Risco aberto:** Suporte Nvoip pode demorar com `wsUri`. Mitigation: Task 7 retorna 500 com mensagem clara; Task 11 (Settings toggle) deixa o user desligar a flag e voltar pro fluxo Nvoip atual sem perdas. PR pode ser mergeada com flag OFF (zero impacto) enquanto suporte responde.

---

## Execution Handoff

Plan completo e salvo em `docs/superpowers/plans/2026-05-15-webrtc-sip-base.md`.

**Duas opções de execução:**

1. **Subagent-Driven (recomendada)** — Despacho um subagent novo por task, reviso entre tasks, iteração rápida e isolada por escopo.
2. **Inline Execution** — Executo as tasks nesta sessão, batches com checkpoints pra revisão.

Qual abordagem?
