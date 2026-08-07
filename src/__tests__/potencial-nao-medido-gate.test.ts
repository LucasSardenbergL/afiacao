/**
 * Gate de REGRESSÃO (lado `src/`): `revenue_potential` e `expansion_score` não voltam a ser
 * coagidos a 0 no caminho do front que alimenta o prompt da IA.
 *
 * Irmão de `supabase/functions/_shared/potencial-nao-medido_test.ts`, que vigia a edge. Os dois
 * existem porque o plano tático tem DUAS portas para o mesmo prompt — o cron (self-contained,
 * na edge) e o botão da tela (`useTacticalPlan.generatePlan`, aqui) — e corrigir uma só deixa a
 * fabricação viva pela outra. O gate de edge não alcança este arquivo: `test:edges` roda com
 * `--allow-read=supabase/functions`.
 *
 * O DADO que torna isto money-path, medido em prod via psql-ro em 2026-07-29 (6.633 linhas de
 * farmer_client_scores):
 *   revenue_potential → 6.633 NULL / 0 zeros / 0 positivos   (column_default removido)
 *   expansion_score   → 6.633 NULL / 0 zeros / 0 positivos   (column_default removido)
 * A migration 20260727130000_farmer_scores_colunas_orfas_null nulou as duas de propósito —
 * nenhum writer as calcula. Com `|| 0`, o prompt recebia "revenuePotential: 0" para 100% da
 * base, e o system prompt instrui a IA a ler número como MEDIDO.
 *
 * Por que um gate de FONTE e não só teste de comportamento: o helper (`valorMedido`) já é
 * testado; o defeito desta família nunca esteve no helper, e sim em NÃO CHAMÁ-LO no call-site
 * (docs/agent/money-path.md §7). Só quem olha o call-site pega a reintrodução.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Neutraliza comentário antes do predicado. Sem isto o gate mede PROSA: o arquivo vigiado
 * EXPLICA em comentário o `|| 0` que removeu, e a explicação dispararia o teste com o código
 * íntegro — o falso-VERMELHO que money-path.md §"O ALVO mente" manda prevenir.
 */
function semComentario(linha: string): string {
  const t = linha.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  return linha.replace(/\/\/.*$/, '');
}

const CAMPOS = [
  'expansion_score',
  'revenue_potential',
  'expansion_potential',
  // Nomes pt-BR das mesmas 3 colunas sem produtor, como saem de customer_visit_scores
  // (useMyVisitSuggestions.ts) — sem estes, o predicado nunca casa nada naquele arquivo e a
  // entrada em VIGIADOS é decorativa.
  'expansao_score',
  'recuperacao_score',
  'relacionamento_score',
  'prospeccao_score',
];

/**
 * Coerção a zero aplicada a um dos campos, ancorada no NOME da coluna e não na forma do
 * fallback — `Number(x || 0)`, `x ?? 0` e `Number(x ?? 0)` são a mesma fabricação, e uma regex
 * por forma vira corrida entre o gate e a criatividade de quem escreve (money-path.md §"O GATE
 * mente quando a regex não conhece a forma REAL do repo": lá o `\s*` não atravessava um cast e
 * o gate media 0 em arquivos com sites vivos).
 *
 * `[^;\n]{0,80}?` aceita cast e parênteses no meio sem atravessar statement.
 */
function coercoes(codigo: string): string[] {
  const achados: string[] = [];
  for (const campo of CAMPOS) {
    for (const m of codigo.matchAll(new RegExp(`${campo}[^;\\n]{0,80}?(\\?\\?|\\|\\|)\\s*0`, 'g'))) {
      achados.push(m[0]);
    }
  }
  return achados;
}

const VIGIADOS = [
  'src/hooks/useTacticalPlan.ts',
  'src/lib/scoring/agenda.ts',
  'src/lib/carteira/escopo-clientes.ts',
  'src/lib/positivacao/ranking.ts',
  'src/hooks/useMyVisitSuggestions.ts',
  'src/lib/visit-scoring/missions.ts',
];

describe('gate: potencial sem writer não é coagido a 0 (src/)', () => {
  it('nenhum call-site do front coage expansion_score/revenue_potential', () => {
    const ofensas: string[] = [];

    for (const rel of VIGIADOS) {
      const fonte = readFileSync(resolve(process.cwd(), rel), 'utf8');
      fonte.split('\n').forEach((linha, i) => {
        for (const trecho of coercoes(semComentario(linha))) {
          ofensas.push(`${rel}:${i + 1}: ${trecho.trim()}`);
        }
      });
    }

    expect(
      ofensas,
      'Campo sem writer coagido a 0 no caminho do prompt da IA — "ausente != zero".\n' +
        'revenue_potential e expansion_score sao NULL em 6.633/6.633 linhas em prod.\n' +
        'Use valorMedido de @/lib/scoring/margin:\n  ' +
        ofensas.join('\n  '),
    ).toEqual([]);
  });

  it('o DETECTOR enxerga a coerção quando ela existe (par obrigatório)', () => {
    // Sem este par, "nenhuma ofensa" e "o predicado está quebrado" têm o mesmo output — um
    // seletor morto passa sempre (money-path.md §"O DETECTOR mente" e a versão UI dele).
    const formasReais = [
      'const revenuePotential = Number(score.revenue_potential || 0);',
      'const expansionPotential = Number(score.expansion_score || 0);',
      'expansionPotential: Number(d.expansion_potential || 0),',
      'revenuePotential: Number(score.revenue_potential ?? 0),',
      'const rev = (score.revenue_potential as number) || 0;',
      // Forma pt-BR real: a reescrita hipotética de useMyVisitSuggestions.ts que este gate existe
      // pra pegar (linhas ~142-145 coagindo o score de volta a 0 no caminho do tooltip).
      'expansao: { score: s.expansao_score ?? 0, insumosAusentes: [] },',
    ];
    for (const forma of formasReais) {
      expect(coercoes(forma).length, `o detector NÃO pegou: ${forma}`).toBeGreaterThan(0);
    }
  });

  it('não acusa o código correto nem o comentário que cita o bug', () => {
    const corretas = [
      'const revenuePotential = valorMedido(score.revenue_potential);',
      'const expansionPotential = valorMedido(score.expansion_score);',
      'expansionPotential: valorMedido(d.expansion_potential),',
    ];
    for (const forma of corretas) {
      expect(coercoes(forma), `falso-VERMELHO em código correto: ${forma}`).toEqual([]);
    }

    const prosa = '      // Com `|| 0` o revenue_potential || 0 chegava como 0 para toda a base';
    expect(semComentario(prosa)).toBe('');
    expect(coercoes(semComentario(prosa))).toEqual([]);
  });
});
