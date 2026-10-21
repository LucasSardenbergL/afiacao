import { describe, expect, it } from 'vitest';
import type { Database } from '@/integrations/supabase/types';
import { paraTarefaEstado, paraTarefaInstancia, paraTarefaTemplate } from '../borda';

type LinhaView = Database['public']['Views']['v_tarefas_estado']['Row'];
type LinhaTemplate = Database['public']['Tables']['tarefa_templates']['Row'];

function linha(extra: Partial<LinhaView> = {}): LinhaView {
  return {
    id: 't1', descricao: 'Ligar', categoria: 'ligar', customer_user_id: 'c1', assigned_to: 'v1',
    created_by: 'm1', empresa: 'oben', modo: 'data', due_date: '2026-10-21', interacao_tipo: null,
    backstop_days: 7, tolerancia_dias: 0, adiada_para: null, motivo_adiamento: null,
    auto_satisfy_mode: 'off', target_produto_id: null, target_texto: null, target_preco_centavos: null,
    target_tags: null, status: 'aberta', concluida_em: null, concluida_por: null, conclusao_origem: null,
    nota_conclusao: null, escalado_em: null, effective_due: '2026-10-21', responsavel_efetivo: 'v1',
    atrasada: false, escalavel: false, tem_sugestao_pendente: false, created_at: null, updated_at: null,
    template_id: null, requer_comprovacao: false, requer_auditoria: false, auditoria_status: 'nao_requer',
    auditoria_motivo: null, auditada_em: null, auditada_por: null, tipo_comprovacao: null,
    leitura_min: null, leitura_max: null, leitura_unidade: null, comprovacao_leitura: null,
    comprovacao_em: null, comprovacao_url: null, janela_fim: null, supervisor_user_id: null,
    ...extra,
  };
}

describe('paraTarefaEstado — borda de v_tarefas_estado', () => {
  it('linha válida vira TarefaEstado com o vocabulário estreitado', () => {
    const t = paraTarefaEstado(linha());
    expect(t.categoria).toBe('ligar');
    expect(t.status).toBe('aberta');
    expect(t.effective_due).toBe('2026-10-21');
  });

  it('customer_user_id NULL passa (instância recorrente sem cliente; nullable na base)', () => {
    expect(paraTarefaEstado(linha({ customer_user_id: null })).customer_user_id).toBeNull();
  });

  it("conclusao_origem 'comprovacao' passa (está no CHECK da prod; o tipo antigo não tinha)", () => {
    expect(paraTarefaEstado(linha({ conclusao_origem: 'comprovacao' })).conclusao_origem).toBe('comprovacao');
  });

  it('vocabulário fora do CHECK lança com a coluna', () => {
    expect(() => paraTarefaEstado(linha({ categoria: 'visitar' }))).toThrow('"categoria" = "visitar" fora do vocabulário');
    expect(() => paraTarefaEstado(linha({ status: 'pausada' }))).toThrow('"status" = "pausada" fora do vocabulário');
  });

  it('coluna garantida NULL lança (a view perde o NOT NULL; a borda não inventa)', () => {
    expect(() => paraTarefaEstado(linha({ id: null }))).toThrow('coluna "id" veio nula');
    expect(() => paraTarefaEstado(linha({ atrasada: null }))).toThrow('coluna "atrasada" veio nula');
  });
});

describe('paraTarefaInstancia — campos da Fase 2', () => {
  it('lê auditoria e comprovação', () => {
    const t = paraTarefaInstancia(linha({ auditoria_status: 'pendente', requer_auditoria: true, tipo_comprovacao: 'foto' }));
    expect(t.auditoria_status).toBe('pendente');
    expect(t.tipo_comprovacao).toBe('foto');
  });

  it('auditoria_status fora do CHECK lança', () => {
    expect(() => paraTarefaInstancia(linha({ auditoria_status: 'talvez' }))).toThrow('"auditoria_status" = "talvez"');
  });
});

describe('paraTarefaTemplate — borda de tarefa_templates', () => {
  const tpl: LinhaTemplate = {
    id: 'tp1', descricao: 'Checklist', categoria: 'outro', area: 'loja', empresa: 'oben', assigned_to: 'v1',
    customer_user_id: null, cadencia: 'semanal', dias_semana: [1], janela_inicio: null, janela_fim: null,
    tolerancia_dias: 0, requer_comprovacao: true, tipo_comprovacao: 'foto', leitura_min: null, leitura_max: null,
    leitura_unidade: null, alto_risco: false, amostra_auditoria_pct: 10, reincidente_limite: 3,
    supervisor_user_id: null, ativo: true, created_by: 'm1', created_at: 'x', updated_at: 'x',
  };

  it('template válido passa', () => {
    expect(paraTarefaTemplate(tpl).cadencia).toBe('semanal');
  });

  it('cadência fora do CHECK lança', () => {
    expect(() => paraTarefaTemplate({ ...tpl, cadencia: 'mensal' })).toThrow('"cadencia" = "mensal"');
  });
});
