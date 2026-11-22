import { describe, it, expect } from 'vitest';
import { rotuloUltimoContato, ultimoPorCliente, type RegistroContato } from '../ultimoContato';

const HOJE = new Date(2026, 10, 22, 15, 0); // 22/11/2026 local

describe('ultimoPorCliente', () => {
  it('fica com o registro mais recente de cada cliente, somando as duas fontes', () => {
    const regs: RegistroContato[] = [
      { clienteId: 'a', em: '2026-11-10T12:00:00Z', desfecho: 'sem_resposta' },
      { clienteId: 'a', em: '2026-11-20T12:00:00Z', desfecho: 'vai_pedir' },
      { clienteId: 'b', em: '2026-11-01T12:00:00Z', desfecho: 'vendeu' },
      { clienteId: 'a', em: '2026-11-15T12:00:00Z', desfecho: 'nao_atendeu' },
    ];
    const m = ultimoPorCliente(regs);
    expect(m.get('a')?.desfecho).toBe('vai_pedir');
    expect(m.get('b')?.desfecho).toBe('vendeu');
  });

  it('data inválida não vira "último contato"', () => {
    const m = ultimoPorCliente([
      { clienteId: 'a', em: 'lixo', desfecho: 'vendeu' },
      { clienteId: 'a', em: '2026-11-01T12:00:00Z', desfecho: 'nao_atendeu' },
    ]);
    expect(m.get('a')?.desfecho).toBe('nao_atendeu');
  });
});

describe('rotuloUltimoContato — ausente ≠ zero', () => {
  const reg = (em: string, desfecho: string | null = null): RegistroContato => ({ clienteId: 'a', em, desfecho });

  it('carregando: não afirma nada (não pisca "sem contato")', () => {
    expect(rotuloUltimoContato(undefined, 'carregando', HOJE)).toBeNull();
  });

  it('falha: indisponível, nunca "sem contato"', () => {
    expect(rotuloUltimoContato(undefined, 'falha', HOJE)).toBe('último contato indisponível');
  });

  it('lido e sem registro: "sem contato registrado em 180d", nunca "há 0 dias"', () => {
    expect(rotuloUltimoContato(undefined, 'ok', HOJE)).toBe('sem contato registrado em 180d');
  });

  it('dias de calendário + desfecho legível', () => {
    expect(rotuloUltimoContato(reg(new Date(2026, 10, 22, 9).toISOString(), 'vendeu'), 'ok', HOJE)).toBe('contato hoje · vendeu');
    expect(rotuloUltimoContato(reg(new Date(2026, 10, 21, 23).toISOString()), 'ok', HOJE)).toBe('contato ontem');
    expect(rotuloUltimoContato(reg(new Date(2026, 10, 2, 10).toISOString(), 'opt_out'), 'ok', HOJE))
      .toBe('contato há 20d · pediu para não ligar');
  });

  it('desfecho desconhecido não inventa rótulo', () => {
    expect(rotuloUltimoContato(reg(new Date(2026, 10, 12).toISOString(), 'xyz'), 'ok', HOJE)).toBe('contato há 10d');
  });
});
