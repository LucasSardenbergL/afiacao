// src/lib/tarefas/voz/__tests__/validacao.test.ts
import { describe, it, expect } from 'vitest';
import { validarRascunho } from '../validacao';
import type { RascunhoVoz } from '../types';

const HOJE = '2026-06-04';
const base: RascunhoVoz = {
  evidence_text: 'liga pro Zé amanhã',
  descricao: 'Ligar pro Zé',
  categoria: 'ligar',
  cliente_nome_falado: 'Zé',
  cliente: { customer_user_id: 'a', nome: 'Padaria do Zé', status: 'unico', candidatos: [] },
  vendedora: { user_id: 'r', nome: 'Regina', status: 'unico' },
  data: { modo: 'data', due_date: '2026-06-05', interacao_tipo: null, status: 'resolvida' },
  target_texto: null,
  empresa: 'oben',
};

describe('validarRascunho', () => {
  it('rascunho completo → ok', () => {
    expect(validarRascunho(base, HOJE)).toEqual({ ok: true, erros: [] });
  });
  it('sem cliente resolvido → erro', () => {
    const r = { ...base, cliente: { customer_user_id: null, nome: null, status: 'ambiguo' as const, candidatos: [] } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('sem vendedora → erro', () => {
    const r = { ...base, vendedora: { user_id: null, nome: null, status: 'sem_match' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('prazo ambíguo → erro', () => {
    const r = { ...base, data: { modo: 'data' as const, due_date: null, interacao_tipo: null, status: 'ambigua' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('modo=data sem due_date → erro', () => {
    const r = { ...base, data: { modo: 'data' as const, due_date: null, interacao_tipo: null, status: 'resolvida' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('modo=data com data no passado → erro', () => {
    const r = { ...base, data: { modo: 'data' as const, due_date: '2026-06-01', interacao_tipo: null, status: 'resolvida' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('modo=interacao sem interacao_tipo → erro', () => {
    const r = { ...base, data: { modo: 'interacao' as const, due_date: null, interacao_tipo: null, status: 'sem_data' as const } };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
  it('oferecer sem target_texto → erro', () => {
    const r = { ...base, categoria: 'oferecer' as const, target_texto: null };
    expect(validarRascunho(r, HOJE).ok).toBe(false);
  });
});
