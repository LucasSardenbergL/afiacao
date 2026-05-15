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
