// `objetivoFinal` — reconciliação do objetivo da IA com o derivado por regra medida.
//
// Espelhado em `supabase/functions/generate-tactical-plan/plano-helpers.ts` (Deno
// não importa de src/). Os CASOS abaixo são os mesmos do teste do edge: se os dois
// lados divergirem, o plano gravado pelo cron e o gravado pela tela passam a
// contar histórias diferentes sobre o mesmo cliente.
//
// O que se prova aqui não é o enum (esse já barra texto inventado), e sim o
// objetivo VÁLIDO e ERRADO — o que passa na validação e mesmo assim contradiz um
// fato medido.
import { describe, it, expect } from 'vitest';
import { objetivoFinal, selectObjective } from '../objective';

/** Tabela ÚNICA de casos — espelhada no teste do edge. */
const CASOS: Array<{
  nome: string;
  daIA: string | null;
  doServidor: string | null;
  objetivo: string | null;
  sobrescrito: boolean;
}> = [
  {
    nome: 'sem_historico: servidor vence "recuperacao" da IA',
    daIA: 'recuperacao',
    doServidor: 'ativacao',
    objetivo: 'ativacao',
    sobrescrito: true,
  },
  {
    nome: 'sem_historico: servidor vence "reativacao" da IA',
    daIA: 'reativacao',
    doServidor: 'ativacao',
    objetivo: 'ativacao',
    sobrescrito: true,
  },
  {
    nome: 'faixa heurística: leitura da IA prevalece',
    daIA: 'upsell_premium',
    doServidor: 'expansao_mix',
    objetivo: 'upsell_premium',
    sobrescrito: false,
  },
  {
    nome: 'IA nula cai no derivado',
    daIA: null,
    doServidor: 'ativacao',
    objetivo: 'ativacao',
    sobrescrito: false,
  },
  {
    nome: 'IA concordando com ativacao não é sobrescrita',
    daIA: 'ativacao',
    doServidor: 'ativacao',
    objetivo: 'ativacao',
    sobrescrito: false,
  },
  {
    nome: 'ambos nulos',
    daIA: null,
    doServidor: null,
    objetivo: null,
    sobrescrito: false,
  },
];

describe('objetivoFinal — objetivo VÁLIDO porém contraditório', () => {
  it.each(CASOS)('$nome', ({ daIA, doServidor, objetivo, sobrescrito }) => {
    expect(objetivoFinal(daIA, doServidor)).toEqual({ objetivo, sobrescrito });
  });

  it('o caminho completo: cliente sem venda válida NÃO recebe plano de recuperação', () => {
    // selectObjective é a fonte do derivado; sem_historico precede tudo (#1026).
    const derivado = selectObjective(
      95, // churnRisk altíssimo — sozinho pediria "recuperacao"
      5,
      null,
      null,
      400, // dormência longa — sozinha pediria "reativacao"
      180,
      'sem_historico',
    );
    expect(derivado).toBe('ativacao');

    // A IA, olhando churn 95 e 400 dias, "conclui" recuperação. Passa no enum.
    const { objetivo, sobrescrito } = objetivoFinal('recuperacao', derivado);
    expect(objetivo).toBe('ativacao');
    expect(sobrescrito).toBe(true);
  });

  it('entrada suja da IA não vira objetivo: espaço/caixa são normalizados', () => {
    expect(objetivoFinal('  RECUPERACAO  ', 'ativacao')).toEqual({
      objetivo: 'ativacao',
      sobrescrito: true,
    });
    // String vazia é ausência, não objetivo — cai no derivado sem marcar sobrescrita.
    expect(objetivoFinal('   ', 'expansao_mix')).toEqual({
      objetivo: 'expansao_mix',
      sobrescrito: false,
    });
  });

  it('undefined (campo ausente na resposta) se comporta como null', () => {
    expect(objetivoFinal(undefined, 'ativacao')).toEqual({
      objetivo: 'ativacao',
      sobrescrito: false,
    });
  });
});
