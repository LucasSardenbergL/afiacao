import { describe, it, expect } from 'vitest';
import { classifyOmieFault } from '../omie-fault';

describe('classifyOmieFault', () => {
  it('classifica a causa-raiz observada (SOAP broken response) como transient', () => {
    // String exata vista em fin_sync_log nas linhas error de 27-28/05.
    expect(
      classifyOmieFault('SOAP-ERROR: Broken response from Application Server (BG)'),
    ).toBe('transient');
  });

  it('classifica outras falhas de infra do servidor como transient', () => {
    expect(classifyOmieFault('ERROR_INTERNAL: algo deu errado')).toBe('transient');
    expect(classifyOmieFault('500 Internal Server Error')).toBe('transient');
    expect(classifyOmieFault('503 Service Unavailable')).toBe('transient');
    expect(classifyOmieFault('Service Temporarily Unavailable')).toBe('transient');
  });

  it('classifica rate-limit do Omie como rate_limit (não transient)', () => {
    expect(
      classifyOmieFault('Já existe uma requisição desse método. Aguarde 1 segundos.'),
    ).toBe('rate_limit');
    expect(classifyOmieFault('Consumo redundante detectado')).toBe('rate_limit');
    expect(classifyOmieFault('consumo redundante')).toBe('rate_limit');
    expect(classifyOmieFault('ERROR: REDUNDANT call')).toBe('rate_limit');
  });

  it('classifica erro de contrato/negócio como fatal (retry não ajuda)', () => {
    expect(classifyOmieFault('Parâmetro [nPagina] inválido')).toBe('fatal');
    expect(classifyOmieFault('Cliente não cadastrado')).toBe('fatal');
    expect(classifyOmieFault('App Key inválida')).toBe('fatal');
  });

  it('NÃO trata SOAP-ERROR genérico (sem sinal de servidor) como transient', () => {
    // SOAP fault também cobre erro de contrato/cliente → fatal sem sinal de infra.
    expect(classifyOmieFault('SOAP-ERROR: Encoding: string is not UTF-8')).toBe('fatal');
    expect(classifyOmieFault('SOAP-ENV:Client validation failed')).toBe('fatal');
  });

  it('é tolerante a entrada vazia/nula → fatal (não retry à toa)', () => {
    expect(classifyOmieFault('')).toBe('fatal');
    expect(classifyOmieFault(null)).toBe('fatal');
    expect(classifyOmieFault(undefined)).toBe('fatal');
  });

  it('rate-limit tem precedência sobre transient quando ambos aparecem', () => {
    // Defesa: se uma string contiver os dois sinais, rate_limit ganha (a espera
    // pedida pelo Omie é a política correta).
    expect(
      classifyOmieFault('Consumo redundante - SOAP-ERROR interno'),
    ).toBe('rate_limit');
  });
});
