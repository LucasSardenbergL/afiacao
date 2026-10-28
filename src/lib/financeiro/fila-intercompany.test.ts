import { describe, expect, it } from 'vitest';
import { acoesDaLinhaIc } from './fila-intercompany';

const cpSo = { status: 'sem_contrapartida', cr_id: null, cp_id: 'cp1' };
const crSo = { status: 'sem_contrapartida', cr_id: 'cr1', cp_id: null };
const candidato = { status: 'sem_contrapartida', cr_id: 'cr1', cp_id: 'cp1' };

describe('acoesDaLinhaIc', () => {
  it('CP sem CR: o master pode marcar venda sem cobrança; ninguém aprova um lado só', () => {
    expect(acoesDaLinhaIc(cpSo, true)).toEqual(['ignorar', 'sem_cobranca']);
    expect(acoesDaLinhaIc(cpSo, false)).toEqual(['ignorar']);
  });

  it('candidato com os dois lados: aprovar e ignorar, nunca sem cobrança (tem CR)', () => {
    expect(acoesDaLinhaIc(candidato, true)).toEqual(['aprovar', 'ignorar']);
    expect(acoesDaLinhaIc({ ...candidato, status: 'divergencia_valor' }, false)).toEqual(['aprovar', 'ignorar']);
  });

  it('CR sem CP: só ignorar (sem cobrança é do lado do CP)', () => {
    expect(acoesDaLinhaIc(crSo, true)).toEqual(['ignorar']);
  });

  it('CP sem CR fora de sem_contrapartida: o banco recusa marcar, a tela não oferece', () => {
    expect(acoesDaLinhaIc({ ...cpSo, status: 'divergencia_valor' }, true)).toEqual(['ignorar']);
  });

  it('linha marcada: só o master desfaz; resolvidas não oferecem nada', () => {
    const marcada = { ...cpSo, status: 'intragrupo_sem_cobranca' };
    expect(acoesDaLinhaIc(marcada, true)).toEqual(['desfazer_sem_cobranca']);
    expect(acoesDaLinhaIc(marcada, false)).toEqual([]);
    expect(acoesDaLinhaIc({ ...candidato, status: 'manual_matched' }, true)).toEqual([]);
    expect(acoesDaLinhaIc({ ...cpSo, status: 'desconsiderado' }, true)).toEqual([]);
  });
});
