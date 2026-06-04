// src/lib/tarefas/voz/__tests__/match.test.ts
import { describe, it, expect } from 'vitest';
import { normalizarNome, casarCliente, casarVendedora } from '../match';

describe('normalizarNome', () => {
  it('tira acento, caixa, pontuação', () => {
    expect(normalizarNome('Padaria do Zé!')).toBe('padaria do ze');
  });
});

describe('casarVendedora', () => {
  const vends = [{ user_id: 'r', nome: 'Regina Silva' }, { user_id: 't', nome: 'Tatyana Souza' }];
  it('nome exato/primeiro nome → unico', () => {
    expect(casarVendedora('Regina', vends)).toMatchObject({ user_id: 'r', status: 'unico' });
  });
  it('apelido por prefixo (Tati → Tatyana) → unico', () => {
    expect(casarVendedora('Tati', vends)).toMatchObject({ user_id: 't', status: 'unico' });
  });
  it('nome desconhecido → sem_match', () => {
    expect(casarVendedora('Maria', vends).status).toBe('sem_match');
  });
  it('nome falado nulo → sem_match', () => {
    expect(casarVendedora(null, vends).status).toBe('sem_match');
  });
});

describe('casarCliente', () => {
  const cands = [
    { customer_user_id: 'a', nome: 'Padaria do Zé' },
    { customer_user_id: 'b', nome: 'Marmoraria Central' },
  ];
  it('match forte e isolado → unico', () => {
    expect(casarCliente('Padaria do Zé', cands)).toMatchObject({ customer_user_id: 'a', status: 'unico' });
  });
  it('dois candidatos parecidos → ambiguo (não auto-seleciona)', () => {
    const ambg = [
      { customer_user_id: 'a', nome: 'Padaria do Zé' },
      { customer_user_id: 'c', nome: 'Padaria do José' },
    ];
    expect(casarCliente('Padaria do Zé', ambg).status).toBe('ambiguo');
  });
  it('sem candidato → sem_match', () => {
    expect(casarCliente('Padaria do Zé', []).status).toBe('sem_match');
  });
  it('melhor candidato sem user_id resolvido → não é unico (cai pra ambiguo)', () => {
    const semId = [{ customer_user_id: '', nome: 'Padaria do Zé' }];
    expect(casarCliente('Padaria do Zé', semId).status).toBe('ambiguo');
  });
});
