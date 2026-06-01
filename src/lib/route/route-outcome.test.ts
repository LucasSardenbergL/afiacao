import { describe, it, expect } from 'vitest';
import { derivarSinaisContato, diasEntreIso, type ContatoLog } from './route-outcome';

const HOJE = '2026-05-31';
const ROTA = '2026-06-01'; // fila D-1: liga hoje p/ rota de amanhã
const reg = (status: ContatoLog['status'], dataNegocio: string, dataRota = ROTA): ContatoLog =>
  ({ status, dataNegocio, dataRota });

describe('diasEntreIso', () => {
  it('conta dias de calendário (a − b), imune a fuso', () => {
    expect(diasEntreIso('2026-05-31', '2026-05-29')).toBe(2);
    expect(diasEntreIso('2026-05-31', '2026-05-31')).toBe(0);
    expect(diasEntreIso('2026-05-31', '2026-06-01')).toBe(-1);
  });
});

describe('derivarSinaisContato', () => {
  it('lista vazia → defaults seguros', () => {
    const s = derivarSinaisContato([], HOJE, ROTA);
    expect(s).toMatchObject({
      optOut: false, jaConvertidoNaRota: false, contatadoHaDiasParaGate: null,
      ultimoContatoRealHaDias: null, semRespostaRecenteN: 0, ultimaSemRespostaHaDias: null,
      cadenciaBloqueadaPor: null,
    });
  });

  it('opt_out é sticky SEM janela (100d atrás ainda bloqueia)', () => {
    const s = derivarSinaisContato([reg('opt_out', '2026-02-20')], HOJE, ROTA);
    expect(s.optOut).toBe(true);
  });

  it('jaConvertidoNaRota casa por data_rota (não created_at) — convertido p/ a rota da fila', () => {
    const s = derivarSinaisContato([reg('convertido', HOJE, ROTA)], HOJE, ROTA);
    expect(s.jaConvertidoNaRota).toBe(true);
  });

  // Codex: convertido de OUTRA rota não marca jaConvertidoNaRota, mas AINDA conta como contato real.
  it('convertido de outra rota não marca jaConvertidoNaRota, mas conta como contato real', () => {
    const s = derivarSinaisContato([reg('convertido', HOJE, '2026-05-31')], HOJE, ROTA);
    expect(s.jaConvertidoNaRota).toBe(false);
    expect(s.ultimoContatoRealHaDias).toBe(0);
    expect(s.contatadoHaDiasParaGate).toBe(0);
    expect(s.cadenciaBloqueadaPor).toBe('real');
  });

  it('contato real → contatadoHaDiasParaGate = dias do mais recente', () => {
    const s = derivarSinaisContato([reg('respondido', '2026-05-29')], HOJE, ROTA); // 2 dias
    expect(s.ultimoContatoRealHaDias).toBe(2);
    expect(s.contatadoHaDiasParaGate).toBe(2);
    expect(s.cadenciaBloqueadaPor).toBe('real');
  });

  it('sem_resposta ISOLADO (N<3) NÃO bloqueia — só badge', () => {
    const s = derivarSinaisContato([reg('sem_resposta', '2026-05-30')], HOJE, ROTA); // ontem
    expect(s.semRespostaRecenteN).toBe(1);
    expect(s.contatadoHaDiasParaGate).toBeNull();
    expect(s.cadenciaBloqueadaPor).toBeNull();
  });

  it('3 linhas sem_resposta no MESMO dia = N=1 (conta DIAS, não linhas)', () => {
    const s = derivarSinaisContato(
      [reg('sem_resposta', '2026-05-30'), reg('sem_resposta', '2026-05-30'), reg('sem_resposta', '2026-05-30')],
      HOJE, ROTA);
    expect(s.semRespostaRecenteN).toBe(1);
    expect(s.contatadoHaDiasParaGate).toBeNull();
  });

  it('sem_resposta em ≥3 DIAS distintos (janela 7d) bloqueia', () => {
    const s = derivarSinaisContato(
      [reg('sem_resposta', '2026-05-29'), reg('sem_resposta', '2026-05-28'), reg('sem_resposta', '2026-05-27')],
      HOJE, ROTA);
    expect(s.semRespostaRecenteN).toBe(3);
    expect(s.contatadoHaDiasParaGate).toBe(2); // mais recente dos 3
    expect(s.cadenciaBloqueadaPor).toBe('sem_resposta_esgotada');
  });

  it('respondido há 10d + sem_resposta ontem (N=1) → gate=10 (real manda; não bloqueia retry curto)', () => {
    const s = derivarSinaisContato([reg('respondido', '2026-05-21'), reg('sem_resposta', '2026-05-30')], HOJE, ROTA);
    expect(s.contatadoHaDiasParaGate).toBe(10);
    expect(s.semRespostaRecenteN).toBe(1);
    expect(s.cadenciaBloqueadaPor).toBe('real');
  });

  it('sem_resposta fora da janela (8d) não conta', () => {
    const s = derivarSinaisContato([reg('sem_resposta', '2026-05-23')], HOJE, ROTA); // 8 dias
    expect(s.semRespostaRecenteN).toBe(0);
  });

  // Codex: real antigo (10d) + sem_resposta esgotada recente (1d) → gate usa o MENOR (1) e motivo sem_resposta.
  it('real-antigo + sem_resposta-esgotada-recente → gate=1, motivo sem_resposta_esgotada (pega Math.max)', () => {
    const s = derivarSinaisContato([
      reg('respondido', '2026-05-21'),   // 10d
      reg('sem_resposta', '2026-05-30'), // 1d
      reg('sem_resposta', '2026-05-29'), // 2d
      reg('sem_resposta', '2026-05-28'), // 3d
    ], HOJE, ROTA);
    expect(s.contatadoHaDiasParaGate).toBe(1);
    expect(s.cadenciaBloqueadaPor).toBe('sem_resposta_esgotada');
  });

  // Codex: 2 dentro da janela + 1 fora não completa o limiar de 3 → não bloqueia.
  it('sem_resposta fora da janela não completa limiar com 2 recentes', () => {
    const s = derivarSinaisContato([
      reg('sem_resposta', '2026-05-30'),
      reg('sem_resposta', '2026-05-29'),
      reg('sem_resposta', '2026-05-23'), // 8d, fora
    ], HOJE, ROTA);
    expect(s.semRespostaRecenteN).toBe(2);
    expect(s.contatadoHaDiasParaGate).toBeNull();
    expect(s.cadenciaBloqueadaPor).toBeNull();
  });

  // Codex: off-by-one da janela — 7d conta, 8d não.
  it('sem_resposta no limite de 7d conta; 8d não conta', () => {
    const s = derivarSinaisContato([
      reg('sem_resposta', '2026-05-24'), // 7d
      reg('sem_resposta', '2026-05-23'), // 8d
    ], HOJE, ROTA);
    expect(s.semRespostaRecenteN).toBe(1);
    expect(s.ultimaSemRespostaHaDias).toBe(7);
  });

  // Codex: datas futuras (negativo) são ignoradas — não bloqueiam tudo.
  it('registros no futuro são ignorados para cadência', () => {
    const s = derivarSinaisContato([
      reg('respondido', '2026-06-01'),
      reg('sem_resposta', '2026-06-01'),
    ], HOJE, ROTA);
    expect(s.ultimoContatoRealHaDias).toBeNull();
    expect(s.semRespostaRecenteN).toBe(0);
    expect(s.contatadoHaDiasParaGate).toBeNull();
  });
});
