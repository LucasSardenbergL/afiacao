// src/lib/tarefas/voz/__tests__/montar-rascunhos.test.ts
import { describe, it, expect } from 'vitest';
import { montarRascunhos } from '../montar-rascunhos';
import type { ExtracaoVozIA } from '../types';

const HOJE = '2026-06-04';
const vends = [{ user_id: 'r', nome: 'Regina Silva' }, { user_id: 't', nome: 'Tatyana Souza' }];

const extracao: ExtracaoVozIA = {
  detectei_n: 2,
  texto_nao_coberto: null,
  tarefas: [
    { evidence_text: 'Regina liga pra Padaria do Zé amanhã', descricao: 'Ligar pra Padaria do Zé', categoria_palpite: 'ligar', cliente_nome_falado: 'Padaria do Zé', vendedora_nome_falado: 'Regina', raw_date_text: 'amanhã', target_texto: null },
    { evidence_text: 'whatsapp pra Maria sexta', descricao: 'WhatsApp pra Maria', categoria_palpite: null, cliente_nome_falado: 'Maria', vendedora_nome_falado: null, raw_date_text: 'sexta', target_texto: null },
  ],
};

describe('montarRascunhos', () => {
  it('resolve data + vendedora; cliente fica null carregando o nome falado; empresa = empresaPadrao', () => {
    const r = montarRascunhos(extracao, { hojeSP: HOJE, vendedoras: vends, empresaPadrao: 'oben' });
    expect(r).toHaveLength(2);
    expect(r[0].vendedora).toMatchObject({ user_id: 'r', status: 'unico' });
    expect(r[0].data.due_date).toBe('2026-06-05');
    expect(r[0].categoria).toBe('ligar');
    expect(r[0].cliente).toBeNull();
    expect(r[0].cliente_nome_falado).toBe('Padaria do Zé');
    expect(r[0].empresa).toBe('oben');
    // categoria nula → 'outro'; vendedora não falada → sem_match
    expect(r[1].categoria).toBe('outro');
    expect(r[1].vendedora.status).toBe('sem_match');
    expect(r[1].data.due_date).toBe('2026-06-05');
    expect(r[1].empresa).toBe('oben');
  });

  it('propaga empresaPadrao alternativo (colacor_sc)', () => {
    const r = montarRascunhos(extracao, { hojeSP: HOJE, vendedoras: vends, empresaPadrao: 'colacor_sc' });
    expect(r[0].empresa).toBe('colacor_sc');
    expect(r[1].empresa).toBe('colacor_sc');
  });
});
