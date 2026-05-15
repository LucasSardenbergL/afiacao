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
