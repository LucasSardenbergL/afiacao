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

  it('🔒 casa também os FALLBACKS do ingest (ABERTO/VENCIDO/PARCIAL) — defesa em profundidade', () => {
    // Decisão revisada no retroativo Codex 2026-06-11: o ingest grava
    // `status_titulo || 'ABERTO'` (e 'VENCIDO' quando já venceu) — sem
    // incluí-los, título sem status some do KPI/DSO/capital de giro em
    // silêncio. O bug HISTÓRICO era filtrar SÓ por eles (0 match) — o guard
    // que permanece é a disjunção com liquidados (teste abaixo).
    expect(isOpenTitleStatus('ABERTO')).toBe(true);
    expect(isOpenTitleStatus('PARCIAL')).toBe(true);
    expect(isOpenTitleStatus('VENCIDO')).toBe(true);
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
    expect(classifyTituloStatus('ABERTO')).toBe('open'); // fallback do ingest: conta como aberto
    expect(classifyTituloStatus(null)).toBe('unknown');
    expect(classifyTituloStatus('')).toBe('unknown');
  });
});

describe('invariantes do conjunto', () => {
  it('OPEN_TITLE_STATUSES = 3 nativos + 3 fallbacks do ingest', () => {
    expect([...OPEN_TITLE_STATUSES]).toEqual(['A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL']);
  });

  it('nenhum status liquidado é também aberto (disjunção)', () => {
    for (const s of ['RECEBIDO', 'PAGO', 'LIQUIDADO']) {
      expect(isOpenTitleStatus(s)).toBe(false);
      expect(classifyTituloStatus(s)).toBe('settled');
    }
  });
});
