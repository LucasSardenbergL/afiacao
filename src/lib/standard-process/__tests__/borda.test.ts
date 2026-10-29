import { describe, expect, it } from 'vitest';
import type { Json, Tables } from '@/integrations/supabase/types';
import { paraStandardProcess } from '../borda';

const etapa: Json = {
  ordem: 1, nome: 'Aplicação primer', tipo: 'aplicacao', produtos: ['primer'],
  parametros: { tempo_minutos: 30 }, equipamentos: ['pistola'], observacoes: '',
  produtos_kb: ['FO20.6827.00'], rationale: 'base de aderência',
};

function linha(extra: Partial<Tables<'standard_processes'>> = {}): Tables<'standard_processes'> {
  return {
    id: 'sp1', name: 'Padrão móveis', slug: 'padrao-moveis', description: null, segmento: 'moveleiro',
    porte_alvo: null, tags: ['nitro'], etapas: [etapa], expected_outcomes: null, target_audience: null,
    prerequisites: null, status: 'draft', status_notes: null, version: 1, parent_id: null,
    created_by: 'm1', reviewed_by: null, reviewed_at: null, created_at: 'x', updated_at: 'x',
    ...extra,
  };
}

describe('paraStandardProcess — borda de standard_processes', () => {
  it('lê etapas por forma e preserva as listas NULL (não vira lista vazia)', () => {
    const p = paraStandardProcess(linha());
    expect(p.etapas[0].produtos_kb).toEqual(['FO20.6827.00']);
    expect(p.etapas[0].parametros).toEqual({ tempo_minutos: 30 });
    expect(p.porte_alvo).toBeNull();
    expect(p.status).toBe('draft');
  });

  it('status fora do CHECK lança', () => {
    expect(() => paraStandardProcess(linha({ status: 'apagado' }))).toThrow('"status" = "apagado" fora do vocabulário');
  });

  it('etapa com tipo fora do vocabulário lança com a posição', () => {
    expect(() => paraStandardProcess(linha({ etapas: [{ ...(etapa as object), tipo: 'voar' }] })))
      .toThrow('standard_processes.etapas[0]: "tipo" fora do vocabulário');
  });

  it('etapa sem produtos_kb lança (a forma do processo padrão exige o vínculo com o KB)', () => {
    const { produtos_kb: _p, ...semKb } = etapa as Record<string, Json>;
    expect(() => paraStandardProcess(linha({ etapas: [semKb] }))).toThrow('produtos_kb: esperava array');
  });

  it('etapas que não são lista lançam', () => {
    expect(() => paraStandardProcess(linha({ etapas: {} }))).toThrow('esperava array');
  });
});
