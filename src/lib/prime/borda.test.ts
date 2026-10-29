import { describe, expect, it } from 'vitest';
import type { Tables } from '@/integrations/supabase/types';
import { paraPrimeAssinatura, paraPrimeBeneficioUso, paraPrimeExtrato, paraPrimePlano } from './borda';

const extrato: Tables<'v_prime_extrato_mensal'> = {
  assinatura_id: 'a1', customer_user_id: 'c1', status: 'ativa', competencia: '2026-10-01',
  mensalidade_contratada: 199, monetizado_total: null, dentes_usados: null, dentes_bonus: null,
  franquia_total: 100, dentes_restantes: 100, dentes_excedentes: 0, usos_operacionais: 0, n_registros: 0,
};

describe('paraPrimeExtrato — v_prime_extrato_mensal (money-path)', () => {
  it('preserva os NULL de contrato (mês sem registro ≠ 0)', () => {
    const e = paraPrimeExtrato(extrato);
    expect(e.monetizado_total).toBeNull();
    expect(e.dentes_usados).toBeNull();
    expect(e.mensalidade_contratada).toBe(199);
  });

  it('coluna garantida NULL lança — a franquia nunca vira 0 inventado', () => {
    expect(() => paraPrimeExtrato({ ...extrato, franquia_total: null })).toThrow('coluna "franquia_total" veio nula');
    expect(() => paraPrimeExtrato({ ...extrato, mensalidade_contratada: null })).toThrow('coluna "mensalidade_contratada"');
  });

  it('status fora do CHECK lança', () => {
    expect(() => paraPrimeExtrato({ ...extrato, status: 'pausada' })).toThrow('"status" = "pausada" fora do vocabulário');
  });
});

describe('demais bordas do Prime', () => {
  it('assinatura: status conferido', () => {
    const base = {
      id: 'a1', customer_user_id: 'c1', plano_id: 'p1', preco_contratado: 199, franquia_dentes_contratada: 100,
      status: 'suspensa', data_inicio: '2026-10-01', data_fim: null, suspensa_em: '2026-10-15', observacao: null,
      created_by: 'm1', created_at: 'x', updated_at: 'x',
    } satisfies Tables<'prime_assinaturas'>;
    expect(paraPrimeAssinatura(base).status).toBe('suspensa');
    expect(() => paraPrimeAssinatura({ ...base, status: 'x' })).toThrow('"status" = "x"');
  });

  it('uso: tipo conferido', () => {
    const base = {
      id: 'u1', assinatura_id: 'a1', tipo: 'afiacao_dentes', quantidade: 10, valor_tabela: 50,
      preco_unitario_snapshot: 5, competencia: '2026-10-01', referencia: 'NF1', descricao: null,
      created_by: 'm1', created_at: 'x', estornado_em: null, estornado_por: null,
    } satisfies Tables<'prime_beneficio_uso'>;
    expect(paraPrimeBeneficioUso(base).tipo).toBe('afiacao_dentes');
    expect(() => paraPrimeBeneficioUso({ ...base, tipo: 'brinde' })).toThrow('"tipo" = "brinde"');
  });

  it('plano: benefícios = só os textos da lista (copy, não sinal money-path)', () => {
    const p = paraPrimePlano({
      id: 'p1', nome: 'Prime', preco_mensal: 199, franquia_dentes: 100, beneficios: ['coleta', 3, null],
      ativo: true, created_at: 'x', updated_at: 'x',
    });
    expect(p.beneficios).toEqual(['coleta']);
  });
});
