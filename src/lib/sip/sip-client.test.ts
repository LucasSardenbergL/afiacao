import { describe, it, expect, beforeEach, vi } from 'vitest';

const { uaMock, wsInterfaceMock } = vi.hoisted(() => {
  const uaMock = {
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    call: vi.fn(),
    isRegistered: vi.fn(() => false),
    isConnected: vi.fn(() => false),
  };
  const wsInterfaceMock = vi.fn().mockImplementation((url: string) => ({ url, via_transport: 'wss' }));
  return { uaMock, wsInterfaceMock };
});

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

  it('emite stateChange("registered") quando UA dispara evento "registered"', () => {
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc123',
    });
    const stateSpy = vi.fn();
    client.on('stateChange', stateSpy);

    const registeredHandler = uaMock.on.mock.calls.find((c) => c[0] === 'registered')?.[1];
    expect(registeredHandler).toBeDefined();

    registeredHandler();

    expect(stateSpy).toHaveBeenCalledWith('registered');
  });

  it('emite stateChange("idle") quando UA dispara evento "unregistered"', () => {
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc123',
    });
    const stateSpy = vi.fn();
    client.on('stateChange', stateSpy);

    const unregisteredHandler = uaMock.on.mock.calls.find((c) => c[0] === 'unregistered')?.[1];
    expect(unregisteredHandler).toBeDefined();

    unregisteredHandler();

    expect(stateSpy).toHaveBeenCalledWith('idle');
  });

  it('emite stateChange("register_failed") e error quando UA dispara "registrationFailed"', () => {
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc123',
    });
    const stateSpy = vi.fn();
    const errorSpy = vi.fn();
    client.on('stateChange', stateSpy);
    client.on('error', errorSpy);

    const failedHandler = uaMock.on.mock.calls.find((c) => c[0] === 'registrationFailed')?.[1];
    expect(failedHandler).toBeDefined();

    failedHandler({ cause: 'rejected' });

    expect(stateSpy).toHaveBeenCalledWith('register_failed');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const errArg = errorSpy.mock.calls[0][0];
    expect(errArg).toBeInstanceOf(Error);
    expect(errArg.message).toContain('rejected');
  });
});

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

  it('emite localStream antes de chamar ua.call (ordering invariant)', () => {
    const session = {
      on: vi.fn(),
      terminate: vi.fn(),
      connection: { getReceivers: vi.fn(() => []) },
    };
    uaMock.call.mockReturnValue(session);

    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    client.connect();

    const callOrder: string[] = [];
    client.on('localStream', () => callOrder.push('localStream'));
    uaMock.call.mockImplementation(() => {
      callOrder.push('ua.call');
      return session;
    });

    const fakeMic = new MediaStream();
    client.makeCall('3799999', fakeMic);

    expect(callOrder).toEqual(['localStream', 'ua.call']);
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

// Incidente 2026-06-09 (Regina): eventos de REGISTRO compartilhavam a state machine
// da CHAMADA — um 'unregistered' (queda do WSS / re-REGISTER falho) no meio da
// conversa estampava o estado pra 'idle', a UI desmontava o <audio> e a vendedora
// parava de ouvir, enquanto a sessão SIP + mic continuavam vivos (cliente seguia
// ouvindo ela). Estes testes garantem que registro NUNCA mexe no estado da chamada.
describe('SipClient — eventos de registro durante chamada ativa (anti-stomp)', () => {
  const cfg = {
    wsUri: 'wss://sip.nvoip.com.br:7443/ws',
    sipDomain: 'sip.nvoip.com.br',
    username: '1234567',
    password: 'abc',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    uaMock.isRegistered.mockReturnValue(true);
  });

  const uaHandler = (name: string) =>
    uaMock.on.mock.calls.find((c) => c[0] === name)?.[1];

  function setupEstablishedCall() {
    const session = {
      on: vi.fn(),
      terminate: vi.fn(),
      connection: { getReceivers: vi.fn(() => []) },
    };
    uaMock.call.mockReturnValue(session);
    const client = new SipClient(cfg);
    client.connect();
    const states: string[] = [];
    client.on('stateChange', (s) => states.push(s));
    const errorSpy = vi.fn();
    client.on('error', errorSpy);
    const stopMock = vi.fn();
    const mic = { getTracks: () => [{ kind: 'audio', stop: stopMock }] } as unknown as MediaStream;
    client.makeCall('37999998888', mic);
    const accepted = session.on.mock.calls.find((c) => c[0] === 'accepted')?.[1];
    accepted();
    expect(states.at(-1)).toBe('established');
    return { client, session, states, errorSpy, stopMock };
  }

  it("'unregistered' no meio da chamada NÃO derruba o estado pra idle", () => {
    const { states } = setupEstablishedCall();
    uaHandler('unregistered')();
    expect(states.at(-1)).toBe('established');
    expect(states).not.toContain('idle');
  });

  it("'registered' (re-REGISTER pós-reconexão) no meio da chamada não mexe no estado", () => {
    const { states } = setupEstablishedCall();
    uaHandler('registered')();
    expect(states.at(-1)).toBe('established');
  });

  it("'registrationFailed' no meio da chamada não estampa estado nem emite error", () => {
    const { states, errorSpy } = setupEstablishedCall();
    uaHandler('registrationFailed')({ cause: 'Connection Error' });
    expect(states.at(-1)).toBe('established');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('eventos de registro voltam ao normal depois do hangUp', () => {
    const { client, states } = setupEstablishedCall();
    client.hangUp();
    uaHandler('unregistered')();
    expect(states.at(-1)).toBe('idle');
  });
});

describe('SipClient — duração não vaza entre chamadas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uaMock.isRegistered.mockReturnValue(true);
  });

  // Incidente 2026-06-09: rediscagens NÃO atendidas eram logadas como 'ended' com
  // duração fantasma (130s/155s) medida do accept da chamada ANTERIOR.
  it('getCallDurationSeconds zera ao iniciar nova chamada (sem accept ainda)', () => {
    const session = { on: vi.fn(), terminate: vi.fn(), connection: { getReceivers: () => [] } };
    uaMock.call.mockReturnValue(session);
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    client.connect();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const mic = { getTracks: () => [{ kind: 'audio', stop: vi.fn() }] } as unknown as MediaStream;
    client.makeCall('37999998888', mic);
    session.on.mock.calls.find((c) => c[0] === 'accepted')?.[1]();

    nowSpy.mockReturnValue(1_130_000); // +130s de conversa
    expect(client.getCallDurationSeconds()).toBe(130);
    client.hangUp();

    // Nova chamada, ainda NÃO atendida: duração deve ser 0, não 130
    client.makeCall('37999998888', mic);
    expect(client.getCallDurationSeconds()).toBe(0);
    nowSpy.mockRestore();
  });
});

describe('SipClient — fim remoto libera recursos da chamada', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uaMock.isRegistered.mockReturnValue(true);
  });

  function setupCall() {
    const session = {
      on: vi.fn(),
      terminate: vi.fn(),
      connection: { getReceivers: vi.fn(() => []) },
    };
    uaMock.call.mockReturnValue(session);
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    client.connect();
    const stopMock = vi.fn();
    const mic = { getTracks: () => [{ kind: 'audio', stop: stopMock }] } as unknown as MediaStream;
    client.makeCall('37999998888', mic);
    const fire = (ev: string, arg?: unknown) =>
      session.on.mock.calls.find((c) => c[0] === ev)?.[1](arg);
    return { client, fire, stopMock };
  }

  it("'ended' remoto (cliente desligou) para as tracks do stream da chamada", () => {
    const { fire, stopMock } = setupCall();
    fire('accepted');
    fire('ended');
    expect(stopMock).toHaveBeenCalled();
  });

  it("'failed' (não atendida/ocupado) também libera o stream", () => {
    const { fire, stopMock } = setupCall();
    fire('failed', { cause: 'Busy' });
    expect(stopMock).toHaveBeenCalled();
  });
});

describe('SipClient — queda do WebSocket SIP (sinalização)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uaMock.isRegistered.mockReturnValue(true);
  });

  const uaHandler = (name: string) =>
    uaMock.on.mock.calls.find((c) => c[0] === name)?.[1];

  it("avisa (error) quando o WSS cai DURANTE uma chamada ativa", () => {
    const session = { on: vi.fn(), terminate: vi.fn(), connection: { getReceivers: () => [] } };
    uaMock.call.mockReturnValue(session);
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    client.connect();
    const errorSpy = vi.fn();
    client.on('error', errorSpy);
    const mic = { getTracks: () => [{ kind: 'audio', stop: vi.fn() }] } as unknown as MediaStream;
    client.makeCall('37999998888', mic);

    const disconnected = uaHandler('disconnected');
    expect(disconnected).toBeDefined();
    disconnected!();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0].message).toMatch(/conexão sip caiu/i);
  });

  it("'disconnected' SEM chamada ativa não emite error (reconexão silenciosa)", () => {
    const client = new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    client.connect();
    const errorSpy = vi.fn();
    client.on('error', errorSpy);

    uaHandler('disconnected')?.();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('SipClient — keepalive de registro (anti idle-timeout do WSS)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Durante chamada estabelecida ZERO tráfego SIP flui; com o register_expires
  // default do JsSIP (600s) o 1º re-REGISTER só viria aos ~5-9min — middlebox com
  // idle-timeout de ~100-120s matava o socket aos ~2min de conversa.
  it('configura register_expires curto (90s) pra manter o WSS vivo', () => {
    new SipClient({
      wsUri: 'wss://sip.nvoip.com.br:7443/ws',
      sipDomain: 'sip.nvoip.com.br',
      username: '1234567',
      password: 'abc',
    });
    expect(JsSIP.UA).toHaveBeenCalledWith(
      expect.objectContaining({ register_expires: 90 })
    );
  });
});

describe('SipClient — mute control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uaMock.isRegistered.mockReturnValue(true);
  });

  it('mute() desabilita todas as audio tracks do localStream', () => {
    const session = { on: vi.fn(), terminate: vi.fn(), connection: { getReceivers: () => [] } };
    uaMock.call.mockReturnValue(session);

    const client = new SipClient({
      wsUri: 'wss://app.nvoip.com.br:7443',
      sipDomain: '54.233.253.44',
      username: '137973001',
      password: 'pw',
    });
    client.connect();

    const track1 = { kind: 'audio', enabled: true };
    const track2 = { kind: 'audio', enabled: true };
    const micStream = { getTracks: () => [track1, track2] } as unknown as MediaStream;

    client.makeCall('3799', micStream);
    expect(client.isMuted()).toBe(false);

    client.mute();
    expect(track1.enabled).toBe(false);
    expect(track2.enabled).toBe(false);
    expect(client.isMuted()).toBe(true);
  });

  it('unmute() reabilita todas as audio tracks', () => {
    const session = { on: vi.fn(), terminate: vi.fn(), connection: { getReceivers: () => [] } };
    uaMock.call.mockReturnValue(session);

    const client = new SipClient({
      wsUri: 'wss://app.nvoip.com.br:7443',
      sipDomain: '54.233.253.44',
      username: '137973001',
      password: 'pw',
    });
    client.connect();

    const track = { kind: 'audio', enabled: true };
    const micStream = { getTracks: () => [track] } as unknown as MediaStream;
    client.makeCall('3799', micStream);
    client.mute();

    client.unmute();
    expect(track.enabled).toBe(true);
    expect(client.isMuted()).toBe(false);
  });

  it('mute() sem chamada ativa é noop seguro', () => {
    const client = new SipClient({
      wsUri: 'wss://app.nvoip.com.br:7443',
      sipDomain: '54.233.253.44',
      username: '137973001',
      password: 'pw',
    });
    expect(() => client.mute()).not.toThrow();
    expect(client.isMuted()).toBe(false);
  });

  it('hangUp() reseta muted pra false', () => {
    const session = { on: vi.fn(), terminate: vi.fn(), connection: { getReceivers: () => [] } };
    uaMock.call.mockReturnValue(session);

    const client = new SipClient({
      wsUri: 'wss://app.nvoip.com.br:7443',
      sipDomain: '54.233.253.44',
      username: '137973001',
      password: 'pw',
    });
    client.connect();
    const track = { kind: 'audio', enabled: true, stop: vi.fn() };
    const micStream = { getTracks: () => [track] } as unknown as MediaStream;
    client.makeCall('3799', micStream);
    client.mute();
    expect(client.isMuted()).toBe(true);

    client.hangUp();
    expect(client.isMuted()).toBe(false);
  });
});
