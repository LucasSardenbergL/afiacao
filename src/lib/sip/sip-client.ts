import JsSIP from 'jssip';
import type { SipCallState, SipClientEvents, SipConfig } from './types';

type EventName = keyof SipClientEvents;

export class SipClient {
  private ua: JsSIP.UA;
  private state: SipCallState = 'idle';
  private listeners: { [K in EventName]?: Array<SipClientEvents[K]> } = {};
  // JsSIP's RTCSession surface used here is narrow (on/terminate/connection.getReceivers); full type import isn't worth the coupling
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private currentSession: any = null;
  // PR-INBOUND-CALLS: sessão entrante aguardando answer pelo vendedor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingIncoming: any = null;
  private callStartedAt: number | null = null;
  private currentLocalStream: MediaStream | null = null;
  private muted = false;

  constructor(private config: SipConfig) {
    const socket = new JsSIP.WebSocketInterface(config.wsUri);
    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${config.username}@${config.sipDomain}`,
      password: config.password,
      register: true,
      // RFC 4028 session timers off — Nvoip server doesn't require them and they add re-INVITE churn
      session_timers: false,
      // Keepalive: durante chamada estabelecida ZERO tráfego SIP flui no WSS; com o
      // default do JsSIP (600s) o 1º re-REGISTER só viria aos ~5-9min e middleboxes
      // com idle-timeout (~100-120s) matavam o socket aos ~2min de conversa
      // (incidente 2026-06-09). O servidor pode sobrescrever via expires da resposta.
      register_expires: 90,
    });

    // ⚠️ Eventos de REGISTRO nunca tocam o estado quando há CHAMADA ativa: a sessão
    // SIP estabelecida sobrevive à perda de registro/transporte (JsSIP não a termina),
    // e estampar 'idle'/'register_failed' aqui desmontava o <audio> da UI no meio da
    // conversa — a vendedora parava de ouvir com o mic ainda aberto (LGPD).
    this.ua.on('registered', () => {
      if (this.hasActiveCall()) return;
      this.setState('registered');
    });
    this.ua.on('unregistered', () => {
      if (this.hasActiveCall()) return;
      this.setState('idle');
    });
    // JsSIP event payload typed loosely — only `cause` is consumed here
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ua.on('registrationFailed', (e: any) => {
      if (this.hasActiveCall()) {
        console.warn('[sip] registro falhou durante chamada ativa — estado da chamada preservado:', e?.cause);
        return;
      }
      this.setState('register_failed');
      this.emit('error', new Error(`SIP registration failed: ${e.cause}`));
    });
    // Queda do WebSocket de sinalização: o JsSIP reconecta sozinho e a mídia
    // (RTCPeerConnection) costuma continuar — só avisa quando há chamada em curso.
    this.ua.on('disconnected', () => {
      if (this.hasActiveCall()) {
        this.emit('error', new Error('Conexão SIP caiu durante a chamada — reconectando. O áudio pode continuar; se ficar mudo, encerre e religue.'));
      }
    });

    // PR-INBOUND-CALLS: handler de chamada inbound
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ua.on('newRTCSession', (e: any) => {
      const session = e.session;
      if (e.originator !== 'remote') {
        // Outbound — lifecycle já tratado em makeCall via this.currentSession
        return;
      }
      // Ocupado? Auto-rejeita (busy)
      if (this.currentSession || this.pendingIncoming) {
        try { session.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch { /* noop */ }
        return;
      }

      this.pendingIncoming = session;

      const fromUri = session.remote_identity?.uri;
      const displayName = session.remote_identity?.display_name ?? null;
      const phone = fromUri?.user ?? 'desconhecido';
      const sipCallId: string = session.id;

      this.emit('incomingCall', {
        phone,
        displayName,
        receivedAt: Date.now(),
        sipCallId,
      });

      // Caller cancelou antes do answer → missed
      session.on('failed', () => {
        if (this.pendingIncoming === session) {
          this.pendingIncoming = null;
          this.emit('incomingClosed', { sipCallId, answered: false, durationSeconds: 0 });
          this.emit('stateChange', 'idle');
        }
      });
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

  makeCall(phoneE164: string, micStream: MediaStream): void {
    if (!this.ua.isRegistered()) {
      throw new Error('SIP client not registered — call connect() first');
    }

    const target = `sip:${phoneE164}@${this.config.sipDomain}`;
    // Zera a âncora de duração da chamada ANTERIOR: sem isso, uma rediscagem que
    // falha antes do accept reportava duração fantasma (medida do accept antigo)
    // e era logada como 'ended' atendida no call_log (incidente 2026-06-09).
    this.callStartedAt = null;
    this.setState('calling');
    this.emit('localStream', micStream);
    this.currentLocalStream = micStream;

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
    // JsSIP event payload typed loosely — only `cause` is consumed here
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.currentSession.on('failed', (e: any) => {
      this.releaseCallResources();
      this.setState('failed');
      this.emit('error', new Error(`Call failed: ${e.cause}`));
    });
    this.currentSession.on('ended', () => {
      // Fim REMOTO (cliente desligou): libera o stream da chamada na hora — sem
      // isso as tracks seguiam transmitindo até a próxima ação do vendedor.
      this.releaseCallResources();
      this.setState('ended');
    });
  }

  /** PR-INBOUND-CALLS: atende chamada inbound pendente com mediaStream do vendedor (mic + preroll mixed) */
  acceptIncoming(micStream: MediaStream): void {
    if (!this.pendingIncoming) {
      throw new Error('Nenhuma chamada inbound pendente');
    }
    const session = this.pendingIncoming;
    this.pendingIncoming = null;
    this.currentSession = session;
    this.currentLocalStream = micStream;
    this.setState('established');
    this.emit('localStream', micStream);

    session.answer({
      mediaStream: micStream,
      rtcOfferConstraints: { offerToReceiveAudio: true, offerToReceiveVideo: false },
      pcConfig: {
        iceServers: this.config.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
      },
    });

    this.callStartedAt = Date.now();
    const sipCallId: string = session.id;

    session.on('confirmed', () => this.extractRemoteStream());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.on('failed', (e: any) => {
      const durationSeconds = this.getCallDurationSeconds();
      this.releaseCallResources();
      this.setState('failed');
      this.emit('incomingClosed', { sipCallId, answered: true, durationSeconds });
      this.emit('error', new Error(`Inbound call failed: ${e?.cause ?? 'unknown'}`));
    });
    session.on('ended', () => {
      const durationSeconds = this.getCallDurationSeconds();
      this.releaseCallResources();
      this.setState('ended');
      this.emit('incomingClosed', { sipCallId, answered: true, durationSeconds });
    });
  }

  /** PR-INBOUND-CALLS: rejeita chamada inbound pendente */
  rejectIncoming(): void {
    if (!this.pendingIncoming) return;
    try {
      this.pendingIncoming.terminate({ status_code: 603, reason_phrase: 'Decline' });
    } catch { /* noop */ }
    this.pendingIncoming = null;
    this.setState('idle');
  }

  hangUp(): void {
    if (this.currentSession) {
      try {
        this.currentSession.terminate();
      } catch {
        // session já encerrada — ok
      }
    }
    this.releaseCallResources();
    if (this.state === 'calling' || this.state === 'ringing' || this.state === 'established') {
      this.setState('ended');
    }
  }

  /** Libera os recursos da chamada corrente (stream local + slot da sessão).
   *  Chamado no hangUp local E nos fins remotos ('ended'/'failed'). NÃO zera
   *  callStartedAt — a duração ainda é lida pelos consumidores no estado terminal. */
  private releaseCallResources(): void {
    if (this.currentLocalStream) {
      for (const track of this.currentLocalStream.getTracks()) {
        track.stop();
      }
      this.currentLocalStream = null;
    }
    this.currentSession = null;
    this.muted = false; // reset pra próxima chamada
  }

  private hasActiveCall(): boolean {
    return !!(this.currentSession || this.pendingIncoming);
  }

  /**
   * SPIKE (descartável — flag telefoniaTransferSpike): tenta transferência via
   * feature-code DTMF do Nvoip (`*2` + ramal). O Nvoip documenta "*2 + ramal".
   * Requer chamada established. NÃO confirma a transferência — só envia os tons;
   * a validação é observar o ramal destino tocar (ver runbook do spike).
   */
  transferViaDtmf(extension: string): void {
    if (!this.currentSession) {
      console.warn('[transfer-spike] DTMF abortado: sem sessão ativa');
      return;
    }
    const tones = `*2${extension}`;
    console.info('[transfer-spike] enviando DTMF', { tones, sipCallId: this.currentSession.id });
    try {
      // JsSIP RTCSession.sendDTMF — RFC2833 por padrão (transport pode precisar de ajuste no spike)
      this.currentSession.sendDTMF(tones, { duration: 160, interToneGap: 120 });
      console.info('[transfer-spike] DTMF despachado (despacho OK ≠ transferência concluída — observe o ramal destino)');
    } catch (e) {
      console.error('[transfer-spike] falha ao despachar DTMF', e);
    }
  }

  /**
   * SPIKE (descartável): tenta transferência cega via SIP REFER p/ o ramal interno.
   * Instrumentado: loga a resposta ao REFER (202 vs 4xx/5xx) e os NOTIFY de
   * progresso (sipfrag 100/180/200/4xx). Requer chamada established.
   */
  transferViaRefer(extension: string): void {
    if (!this.currentSession) {
      console.warn('[transfer-spike] REFER abortado: sem sessão ativa');
      return;
    }
    const target = `sip:${extension}@${this.config.sipDomain}`;
    console.info('[transfer-spike] enviando REFER', { target, sipCallId: this.currentSession.id });
    try {
      this.currentSession.refer(target, {
        eventHandlers: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          requestSucceeded: (e: any) => console.info('[transfer-spike] REFER aceito (2xx)', e?.response?.status_code),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          requestFailed: (e: any) => console.warn('[transfer-spike] REFER RECUSADO', { cause: e?.cause, status: e?.response?.status_code }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          accepted: (e: any) => console.info('[transfer-spike] NOTIFY: transferência aceita', e?.request?.body),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          failed: (e: any) => console.warn('[transfer-spike] NOTIFY: transferência FALHOU', e?.request?.body),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          progress: (e: any) => console.info('[transfer-spike] NOTIFY: progresso', e?.request?.body),
        },
      });
      console.info('[transfer-spike] REFER despachado (aguardando NOTIFYs do Nvoip)');
    } catch (e) {
      console.error('[transfer-spike] falha ao despachar REFER', e);
    }
  }

  getCallDurationSeconds(): number {
    if (!this.callStartedAt) return 0;
    return Math.floor((Date.now() - this.callStartedAt) / 1000);
  }

  mute(): void {
    if (!this.currentLocalStream) return;
    for (const track of this.currentLocalStream.getTracks()) {
      if (track.kind === 'audio') {
        track.enabled = false;
      }
    }
    this.muted = true;
  }

  unmute(): void {
    if (!this.currentLocalStream) return;
    for (const track of this.currentLocalStream.getTracks()) {
      if (track.kind === 'audio') {
        track.enabled = true;
      }
    }
    this.muted = false;
  }

  isMuted(): boolean {
    return this.muted;
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

  on<K extends EventName>(event: K, handler: SipClientEvents[K]): void {
    // Mapped-type array narrowing fights `push` here; the runtime push is sound
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // Variadic call across a mapped union of handler signatures — TS can't prove the arg shape, runtime is sound
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const fn of arr) (fn as any)(...args);
  }
}
