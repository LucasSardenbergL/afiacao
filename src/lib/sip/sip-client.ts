import JsSIP from 'jssip';
import type { SipCallState, SipClientEvents, SipConfig } from './types';

type EventName = keyof SipClientEvents;

export class SipClient {
  private ua: JsSIP.UA;
  private state: SipCallState = 'idle';
  private listeners: { [K in EventName]?: Array<SipClientEvents[K]> } = {};
  private currentSession: any = null;
  private callStartedAt: number | null = null;

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
