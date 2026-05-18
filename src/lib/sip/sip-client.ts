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
    });

    this.ua.on('registered', () => this.setState('registered'));
    this.ua.on('unregistered', () => this.setState('idle'));
    // JsSIP event payload typed loosely — only `cause` is consumed here
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ua.on('registrationFailed', (e: any) => {
      this.setState('register_failed');
      this.emit('error', new Error(`SIP registration failed: ${e.cause}`));
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

      this.emit('incomingCall', {
        phone,
        displayName,
        receivedAt: Date.now(),
      });

      // Caller cancelou antes do answer
      session.on('failed', () => {
        if (this.pendingIncoming === session) {
          this.pendingIncoming = null;
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
      this.setState('failed');
      this.emit('error', new Error(`Call failed: ${e.cause}`));
    });
    this.currentSession.on('ended', () => {
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

    session.on('confirmed', () => this.extractRemoteStream());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.on('failed', (e: any) => {
      this.setState('failed');
      this.emit('error', new Error(`Inbound call failed: ${e?.cause ?? 'unknown'}`));
    });
    session.on('ended', () => {
      this.setState('ended');
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
    this.muted = false; // reset pra próxima chamada
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
