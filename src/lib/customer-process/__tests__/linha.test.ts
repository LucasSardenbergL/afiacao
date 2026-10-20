import { describe, expect, it } from 'vitest';
import type { Tables } from '@/integrations/supabase/types';
import { customerProcessDaLinha, etapasDeJson, porteDeTexto } from '../linha';

const etapa = {
  ordem: 1,
  nome: 'Aplicação primer',
  tipo: 'aplicacao',
  produtos: ['primer PU'],
  parametros: { tempo_minutos: 30, umidade_pct: null },
  equipamentos: ['pistola HVLP'],
  observacoes: '',
};

const linha: Tables<'customer_processes'> = {
  id: 'p1',
  customer_user_id: 'u1',
  descricao_livre: 'pinta móveis',
  etapas: [etapa],
  ia_confidence: 0.8,
  ia_gaps: null,
  ia_structured_at: null,
  is_current: true,
  parent_id: null,
  porte: 'medio',
  segmento: 'moveleiro',
  tags: null,
  version: 1,
  created_by: 'u0',
  created_at: '2026-10-19T00:00:00Z',
  updated_at: '2026-10-19T00:00:00Z',
};

describe('etapasDeJson', () => {
  it('NULL continua NULL (processo sem estruturação)', () => {
    expect(etapasDeJson(null)).toBeNull();
  });

  it('lê a etapa por forma; parâmetro null some, número fica', () => {
    const [e] = etapasDeJson([etapa]) ?? [];
    expect(e).toEqual({ ...etapa, parametros: { tempo_minutos: 30 } });
  });

  it('tipo fora do vocabulário LANÇA (não vira "outro")', () => {
    expect(() => etapasDeJson([{ ...etapa, tipo: 'pintura' }])).toThrow(/tipo fora do vocabul/);
  });

  it('não-lista e parâmetro não-numérico LANÇAM', () => {
    expect(() => etapasDeJson({ ordem: 1 })).toThrow(/n.o . lista/);
    expect(() => etapasDeJson([{ ...etapa, parametros: { tempo_minutos: '30' } }])).toThrow(/tempo_minutos/);
  });
});

describe('customerProcessDaLinha', () => {
  it('deriva da linha: tags/ia_gaps null → [], porte guardado', () => {
    const p = customerProcessDaLinha(linha);
    expect(p.tags).toEqual([]);
    expect(p.ia_gaps).toEqual([]);
    expect(p.porte).toBe('medio');
    expect(p.etapas?.[0].nome).toBe('Aplicação primer');
  });

  it('porte fora do vocabulário LANÇA (não vira "medio")', () => {
    expect(() => porteDeTexto('enorme')).toThrow(/porte fora/);
    expect(() => customerProcessDaLinha({ ...linha, porte: 'enorme' })).toThrow(/porte fora/);
    expect(porteDeTexto(null)).toBeNull();
  });
});
