// src/lib/melhorias/__tests__/triagem-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { validarTriagem, podeReplicar } from '../triagem-helpers';
import type { MelhoriaItem, MelhoriaMensagem } from '../types';

const base = {
  tipo: 'problema',
  urgencia: 'alta',
  modulo: 'estoque',
  titulo: 'Picking trava ao bipar duas vezes',
  resposta_ao_funcionario: 'Entendi: problema no picking. Vai pra fila do Lucas.',
  avaliacao_founder: 'Provável replay do evento de scan sem guard de idempotência.',
};

describe('validarTriagem', () => {
  it('aceita payload válido e devolve normalizado', () => {
    const r = validarTriagem(base);
    expect(r).not.toBeNull();
    expect(r!.tipo).toBe('problema');
    expect(r!.modulo).toBe('estoque');
  });

  it('normaliza caixa/espaços nos enums', () => {
    const r = validarTriagem({ ...base, tipo: ' Problema ', urgencia: 'ALTA', modulo: 'Estoque' });
    expect(r).not.toBeNull();
    expect(r!.tipo).toBe('problema');
    expect(r!.urgencia).toBe('alta');
    expect(r!.modulo).toBe('estoque');
  });

  it('módulo desconhecido vira "outro" (lista evolui, não rejeita)', () => {
    const r = validarTriagem({ ...base, modulo: 'modulo-inventado' });
    expect(r).not.toBeNull();
    expect(r!.modulo).toBe('outro');
  });

  it('rejeita tipo fora do enum', () => {
    expect(validarTriagem({ ...base, tipo: 'reclamacao' })).toBeNull();
  });

  it('rejeita urgência fora do enum', () => {
    expect(validarTriagem({ ...base, urgencia: 'urgentissima' })).toBeNull();
  });

  it('rejeita título vazio e resposta vazia', () => {
    expect(validarTriagem({ ...base, titulo: '  ' })).toBeNull();
    expect(validarTriagem({ ...base, resposta_ao_funcionario: '' })).toBeNull();
  });

  it('trunca título em 120 chars', () => {
    const r = validarTriagem({ ...base, titulo: 'x'.repeat(300) });
    expect(r!.titulo.length).toBe(120);
  });

  it('avaliacao_founder ausente vira string vazia (não rejeita — campo pro founder é best-effort)', () => {
    const r = validarTriagem({ ...base, avaliacao_founder: undefined });
    expect(r).not.toBeNull();
    expect(r!.avaliacao_founder).toBe('');
  });

  it('rejeita não-objeto', () => {
    expect(validarTriagem(null)).toBeNull();
    expect(validarTriagem('texto')).toBeNull();
    expect(validarTriagem(42)).toBeNull();
  });
});

function item(status: MelhoriaItem['status']): MelhoriaItem {
  return {
    id: 'i1', autor_user_id: 'u1', empresa: 'oben', rota_origem: '/sales/new',
    tipo: 'problema', urgencia: 'media', modulo: 'vendas', titulo: 't',
    status, triagem_status: 'ok', avaliacao_founder: null, resposta_founder: null,
    resolvido_em: null, created_at: '2026-06-10T12:00:00Z', updated_at: '2026-06-10T12:00:00Z',
  };
}
function msgs(nFuncionario: number): MelhoriaMensagem[] {
  const out: MelhoriaMensagem[] = [];
  for (let i = 0; i < nFuncionario; i++) {
    out.push({ id: `f${i}`, item_id: 'i1', autor_user_id: 'u1', papel: 'funcionario', conteudo: 'm', dados: null, created_at: '2026-06-10T12:00:00Z' });
    out.push({ id: `a${i}`, item_id: 'i1', autor_user_id: null, papel: 'ia', conteudo: 'r', dados: null, created_at: '2026-06-10T12:00:01Z' });
  }
  return out;
}

describe('podeReplicar', () => {
  it('permite em item aberto com 1 mensagem', () => {
    expect(podeReplicar(item('aberto'), msgs(1)).ok).toBe(true);
  });
  it('permite em item em_andamento', () => {
    expect(podeReplicar(item('em_andamento'), msgs(2)).ok).toBe(true);
  });
  it('bloqueia em resolvido e descartado', () => {
    expect(podeReplicar(item('resolvido'), msgs(1)).ok).toBe(false);
    expect(podeReplicar(item('descartado'), msgs(1)).ok).toBe(false);
  });
  it('bloqueia na 6ª mensagem do funcionário (cap = 1 inicial + 5 réplicas)', () => {
    expect(podeReplicar(item('aberto'), msgs(5)).ok).toBe(true);
    const r = podeReplicar(item('aberto'), msgs(6));
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('Limite');
  });
  it('mensagens da IA/founder não contam pro cap', () => {
    const extras: MelhoriaMensagem[] = [
      { id: 'x1', item_id: 'i1', autor_user_id: 'mast', papel: 'founder', conteudo: 'ok', dados: null, created_at: '2026-06-10T13:00:00Z' },
    ];
    expect(podeReplicar(item('aberto'), [...msgs(5), ...extras]).ok).toBe(true);
  });
});
