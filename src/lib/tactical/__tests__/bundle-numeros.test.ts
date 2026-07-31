import { describe, it, expect } from 'vitest';
import { numerosDoBundle, type NumerosDoBundle } from '../bundle-numeros';

/**
 * Guard money-path — "ausente ≠ zero" nos quatro números do bundle gravados no plano tático.
 *
 * Espelho de `numerosDoBundle` em
 * `supabase/functions/generate-tactical-plan/plano-helpers.ts` (Deno não importa de `src/`).
 * Os DOIS lados precisam do mesmo comportamento: o plano é gravado pelo cron (edge, modo
 * self-contained) E pela vendedora clicando "Gerar plano" (front, via RPC). Corrigir só um
 * deixa o bug voltar pelo outro caminho.
 *
 * O que estava errado: `topBundle ? Number(topBundle.lie_bundle) : 0` fabricava 0 em DOIS
 * cenários — sem bundle nenhum, e com bundle cujo `p_bundle`/`m_bundle` é null (as três
 * colunas de `farmer_bundle_recommendations` são nullable). O 0 chega à vendedora como
 * "Ganho esperado R$ 0,00" e "Probabilidade 0,0%", que são afirmações — *não vale a pena
 * vender este bundle* — que ninguém mediu.
 *
 * Medido em prod via psql-ro (2026-07-31): 339 de 339 planos com os três campos = 0 e
 * NENHUM com `bundle_recommendation_id`.
 */
const VAZIO: NumerosDoBundle = {
  bundle_lie: null,
  bundle_probability: null,
  bundle_incremental_margin: null,
  best_individual_lie: null,
};

describe('numerosDoBundle', () => {
  it('sem bundle os quatro campos são null, nunca 0', () => {
    // "não há bundle" ≠ "o bundle vale R$ 0,00".
    expect(numerosDoBundle(null)).toEqual(VAZIO);
    expect(numerosDoBundle(undefined)).toEqual(VAZIO);
  });

  it('bundle com campo nulo degrada só aquele campo', () => {
    expect(numerosDoBundle({ lie_bundle: 1250.5, p_bundle: null, m_bundle: null })).toEqual({
      bundle_lie: 1250.5,
      bundle_probability: null,
      bundle_incremental_margin: null,
      best_individual_lie: null,
    });
  });

  it('aceita numeric como string (PostgREST) e preserva o zero MEDIDO', () => {
    // numeric do Postgres chega como string no supabase-js; e `0` vindo da coluna é
    // veredito apurado — degradá-lo para null seria o erro simétrico.
    expect(numerosDoBundle({ lie_bundle: '0', p_bundle: '12.5', m_bundle: '-3' })).toEqual({
      bundle_lie: 0,
      bundle_probability: 12.5,
      bundle_incremental_margin: -3,
      best_individual_lie: null,
    });
  });

  it('string vazia e lixo NÃO viram zero', () => {
    // `Number('') === 0` e `Number([]) === 0` — a coerção fabricaria o número antes do guard.
    expect(numerosDoBundle({ lie_bundle: '', p_bundle: [], m_bundle: {} })).toEqual(VAZIO);
    expect(numerosDoBundle({ lie_bundle: NaN, p_bundle: Infinity, m_bundle: '  ' })).toEqual(VAZIO);
  });

  it('best_individual_lie é SEMPRE null — ninguém o calcula', () => {
    // Era `0` hardcoded nos dois writers. Nem o valor vindo da linha vale: não existe
    // writer no repo que compute este número.
    const r = numerosDoBundle({ lie_bundle: 10, p_bundle: 20, m_bundle: 30, best_individual_lie: 99 });
    expect(r.best_individual_lie).toBeNull();
  });

  it('paridade com a edge: mesmo objeto para as mesmas entradas', () => {
    // O contrato é o CONJUNTO das quatro chaves — o payload da RPC é montado por spread,
    // então uma chave a menos aqui deixaria a coluna cair no `DEFAULT` da tabela.
    expect(Object.keys(numerosDoBundle(null)).sort()).toEqual([
      'best_individual_lie',
      'bundle_incremental_margin',
      'bundle_lie',
      'bundle_probability',
    ]);
  });
});
