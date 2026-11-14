import { describe, expect, it } from 'vitest';
import type { Json } from '@/integrations/supabase/types';
import { metricasJson } from './contribuicao.fixture';
import {
  formatarCobertura, formatarPp, formatarTaxa, fracao, lerContribuicao, situacaoContribuicao,
  type MetricasContribuicao,
} from '../contribuicao';

function resposta(over: Record<string, Json> = {}): Json {
  return {
    janela: '12m', desde: '2025-11-13', ate: '2026-11-12', eixo: 'cliente', empresa: null,
    ordem: 'contribuicao_asc', limite: 50, offset: 0, indisponivel: false,
    taxa_capital: { oben: 0.1775, colacor: null },
    total: metricasJson(), por_empresa: { oben: metricasJson() }, total_linhas: 1,
    linhas: [{ chave: 'u1', rotulo: 'Marcenaria', detalhe: { empresas: 1 }, ...metricasJson() }],
    ...over,
  };
}

describe('lerContribuicao — borda do jsonb', () => {
  it('lê a forma completa, preservando null onde a RPC o produz', () => {
    const r = lerContribuicao(resposta());
    if (r.indisponivel) throw new Error('esperava disponível');
    expect(r.taxaCapital).toEqual({ oben: 0.1775, colacor: null });
    expect(r.linhas[0].receita_custo_atual).toBeNull();
    expect(r.linhas[0].contribuicao).toBe(529.9);
    expect(r.porEmpresa.oben.gap_piso).toBe(28);
  });

  it('chave AUSENTE lança (ausente ≠ null) — nunca vira 0', () => {
    const m = metricasJson();
    delete m.contribuicao;
    expect(() => lerContribuicao(resposta({ total: m }))).toThrow('total: sem "contribuicao"');
  });

  it('contagem null lança (contagem é count(*), nunca null)', () => {
    expect(() => lerContribuicao(resposta({ total: metricasJson({ itens: null }) }))).toThrow('"itens" não é número');
  });

  it('total null, contagem fracionária ou negativa lançam (resposta contraditória não vira "sem venda")', () => {
    expect(() => lerContribuicao(resposta({ total: null }))).toThrow('total: não é objeto');
    expect(() => lerContribuicao(resposta({ total: metricasJson({ itens: 1.5 }) }))).toThrow('"itens" não é contagem');
    expect(() => lerContribuicao(resposta({ total_linhas: -1 }))).toThrow('"total_linhas" não é contagem');
  });

  it('total legítimo SEM item (contagens 0, somas null) é aceito', () => {
    const vazio = metricasJson({ itens: 0, receita_liquida: null, contribuicao: null, margem_bruta_pct: null });
    const r = lerContribuicao(resposta({ total: vazio, por_empresa: {}, linhas: [], total_linhas: 0 }));
    if (r.indisponivel) throw new Error('esperava disponível');
    expect(r.total.itens).toBe(0);
    expect(r.total.receita_liquida).toBeNull();
  });

  it('valor fora do domínio lança', () => {
    expect(() => lerContribuicao(resposta({ eixo: 'regiao' }))).toThrow('valor fora do domínio');
  });

  it('eixo indisponível devolve o motivo', () => {
    const r = lerContribuicao({ janela: '12m', desde: '2025-11-13', ate: '2026-11-12', eixo: 'vendedor', indisponivel: true, motivo: 'Entrega 2' });
    expect(r).toMatchObject({ indisponivel: true, motivo: 'Entrega 2' });
  });
});

describe('regras de apresentação', () => {
  const base = lerContribuicao(resposta());
  if (base.indisponivel) throw new Error('fixture');
  const m: MetricasContribuicao = base.total;

  it('situação: completa / sem taxa / sem prazo / sem custo', () => {
    expect(situacaoContribuicao(m)).toBe('completa');
    expect(situacaoContribuicao({ ...m, contribuicao: null, pedidos_prazo_ok: 0, pedidos_taxa_ausente: 3 })).toBe('sem_taxa');
    expect(situacaoContribuicao({ ...m, contribuicao: null, pedidos_prazo_ok: 1, pedidos_taxa_ausente: 0 })).toBe('sem_intersecao');
    expect(situacaoContribuicao({ ...m, contribuicao: null, pedidos_prazo_ok: 0, pedidos_taxa_ausente: 0 })).toBe('sem_prazo');
    expect(situacaoContribuicao({ ...m, contribuicao: null, receita_com_custo: null })).toBe('sem_custo');
  });

  it('fração/cobertura: denominador ausente ou zero → null/"—", nunca 0%', () => {
    expect(fracao(null, 10)).toBeNull();
    expect(fracao(5, 0)).toBeNull();
    expect(fracao(5, null)).toBeNull();
    expect(fracao(5, 10)).toBe(0.5);
    expect(formatarCobertura(null, 100)).toBe('—');
    expect(formatarCobertura(0, 100)).toMatch(/^0\s?%$/);
  });

  it('formatadores: pontos percentuais e taxa; null → "—"', () => {
    expect(formatarPp(null)).toBe('—');
    expect(formatarPp(48.7)).toMatch(/^48,7\s?%$/);
    expect(formatarTaxa(0.1775)).toMatch(/^17,75\s?%$/);
    expect(formatarTaxa(null)).toBe('—');
  });
});
