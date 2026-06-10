// src/lib/melhorias/__tests__/prompt-claude.test.ts
import { describe, it, expect } from 'vitest';
import { montarPromptClaudeCode } from '../prompt-claude';
import type { MelhoriaItem, MelhoriaMensagem } from '../types';

const item: MelhoriaItem = {
  id: 'abc12345-0000-0000-0000-000000000000',
  autor_user_id: 'u1', empresa: 'oben', rota_origem: '/admin/estoque/picking',
  tipo: 'problema', urgencia: 'alta', modulo: 'estoque',
  titulo: 'Picking trava ao bipar duas vezes',
  status: 'aberto', triagem_status: 'ok',
  avaliacao_founder: 'Provável replay sem idempotência no confirmPickItem.',
  resposta_founder: null, resolvido_em: null,
  created_at: '2026-06-10T15:30:00Z', updated_at: '2026-06-10T15:30:00Z',
};
const mensagens: MelhoriaMensagem[] = [
  { id: 'm1', item_id: item.id, autor_user_id: 'u1', papel: 'funcionario', conteudo: 'O picking trava quando bipo duas vezes seguidas', dados: null, created_at: '2026-06-10T15:30:00Z' },
  { id: 'm2', item_id: item.id, autor_user_id: null, papel: 'ia', conteudo: 'Entendi: problema no picking.', dados: { tools: [{ tool: 'clientes_por_produto', input: { p_termo: 'x' }, resultado: { clientes: [] } }] }, created_at: '2026-06-10T15:30:05Z' },
];

describe('montarPromptClaudeCode', () => {
  it('inclui contexto, relato, avaliação e pedido', () => {
    const p = montarPromptClaudeCode(item, mensagens, 'Regina');
    expect(p).toContain('abc12345'); // id curto
    expect(p).toContain('Regina');
    expect(p).toContain('/admin/estoque/picking');
    expect(p).toContain('oben');
    expect(p).toContain('O picking trava quando bipo duas vezes seguidas');
    expect(p).toContain('Provável replay sem idempotência');
    expect(p).toContain('causa raiz');
  });

  it('marca mensagens da IA que consultaram dados, sem despejar a tabela', () => {
    const p = montarPromptClaudeCode(item, mensagens, 'Regina');
    expect(p).toContain('[ia — consultou clientes_por_produto]');
    expect(p).not.toContain('"clientes":');
  });

  it('degrada honesto sem triagem', () => {
    const semTriagem = { ...item, tipo: null, urgencia: null, modulo: null, titulo: null, avaliacao_founder: null };
    const p = montarPromptClaudeCode(semTriagem, [mensagens[0]], 'Regina');
    expect(p).toContain('não triado');
    expect(p).toContain('(triagem indisponível)');
  });

  it('rota nula vira "não informada"', () => {
    const p = montarPromptClaudeCode({ ...item, rota_origem: null }, mensagens, 'Regina');
    expect(p).toContain('não informada');
  });
});
