import { describe, it, expect } from 'vitest';
import {
  isOpenTitleStatus,
  isOpenNotOverdueTitleStatus,
  classifyTituloStatus,
  OPEN_TITLE_STATUSES,
} from '../titulo-status';

describe('isOpenTitleStatus', () => {
  it('os status NATIVOS de aberto do Omie → true', () => {
    expect(isOpenTitleStatus('A VENCER')).toBe(true);
    expect(isOpenTitleStatus('ATRASADO')).toBe(true);
    expect(isOpenTitleStatus('VENCE HOJE')).toBe(true);
  });

  it('🔒 SEGURANÇA: liquidados (RECEBIDO/PAGO/LIQUIDADO) → false (saldo bogus #396 não pode inflar NCG)', () => {
    expect(isOpenTitleStatus('RECEBIDO')).toBe(false);
    expect(isOpenTitleStatus('PAGO')).toBe(false);
    expect(isOpenTitleStatus('LIQUIDADO')).toBe(false);
  });

  it('CANCELADO / nulo / desconhecido → false', () => {
    expect(isOpenTitleStatus('CANCELADO')).toBe(false);
    expect(isOpenTitleStatus(null)).toBe(false);
    expect(isOpenTitleStatus(undefined)).toBe(false);
    expect(isOpenTitleStatus('')).toBe(false);
    expect(isOpenTitleStatus('STATUS_NOVO_DO_OMIE')).toBe(false);
  });

  it('🔒 NÃO casa os valores LEGADO errados (ABERTO/PARCIAL/VENCIDO) — o bug que originou tudo', () => {
    expect(isOpenTitleStatus('ABERTO')).toBe(false);
    expect(isOpenTitleStatus('PARCIAL')).toBe(false);
    expect(isOpenTitleStatus('VENCIDO')).toBe(false);
  });
});

describe('isOpenNotOverdueTitleStatus (adiantamentos)', () => {
  it('aberto e não-vencido → true; ATRASADO (vencido) → false', () => {
    expect(isOpenNotOverdueTitleStatus('A VENCER')).toBe(true);
    expect(isOpenNotOverdueTitleStatus('VENCE HOJE')).toBe(true);
    expect(isOpenNotOverdueTitleStatus('ATRASADO')).toBe(false);
  });

  it('liquidado/cancelado/nulo → false', () => {
    expect(isOpenNotOverdueTitleStatus('RECEBIDO')).toBe(false);
    expect(isOpenNotOverdueTitleStatus('CANCELADO')).toBe(false);
    expect(isOpenNotOverdueTitleStatus(null)).toBe(false);
  });
});

describe('classifyTituloStatus (telemetria de qualidade de dado)', () => {
  it('open / settled / cancelled', () => {
    expect(classifyTituloStatus('A VENCER')).toBe('open');
    expect(classifyTituloStatus('ATRASADO')).toBe('open');
    expect(classifyTituloStatus('VENCE HOJE')).toBe('open');
    expect(classifyTituloStatus('RECEBIDO')).toBe('settled');
    expect(classifyTituloStatus('PAGO')).toBe('settled');
    expect(classifyTituloStatus('LIQUIDADO')).toBe('settled');
    expect(classifyTituloStatus('CANCELADO')).toBe('cancelled');
  });

  it('status novo do Omie / nulo → unknown (vira sinal de data-quality, não conta como aberto)', () => {
    expect(classifyTituloStatus('EM ANALISE')).toBe('unknown');
    expect(classifyTituloStatus('ABERTO')).toBe('unknown'); // valor legado: não existe nos dados
    expect(classifyTituloStatus(null)).toBe('unknown');
    expect(classifyTituloStatus('')).toBe('unknown');
  });
});

describe('invariantes do conjunto', () => {
  it('OPEN_TITLE_STATUSES é exatamente os 3 nativos de aberto', () => {
    expect([...OPEN_TITLE_STATUSES]).toEqual(['A VENCER', 'ATRASADO', 'VENCE HOJE']);
  });

  it('nenhum status liquidado é também aberto (disjunção)', () => {
    for (const s of ['RECEBIDO', 'PAGO', 'LIQUIDADO']) {
      expect(isOpenTitleStatus(s)).toBe(false);
      expect(classifyTituloStatus(s)).toBe('settled');
    }
  });
});
