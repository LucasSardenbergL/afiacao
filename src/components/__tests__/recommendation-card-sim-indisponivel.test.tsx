/**
 * O disjuntor do cluster (`truncado`) faz a edge `recommend` devolver `sim_score: null` —
 * é a distinção inteira daquela entrega: NULL é "não medi", 0 seria "medi e ninguém comprou"
 * (supabase/functions/recommend/index.ts:272 e :330).
 *
 * Mas o breakdown de admin chamava `item._admin.sim_score.toFixed(3)` sobre um tipo declarado
 * `number`, que MENTE: a edge manda `number | null`. Como o teto é 5.000 clientes e o maior
 * cluster medido tem 779, esse caminho NUNCA executou — o defeito só apareceria na primeira
 * vez que o disjuntor mordesse, derrubando o card com TypeError em vez de degradar.
 *
 * Achado pela 2ª opinião do Codex sobre docs/historico/recommend-teto-linhas-cluster.md
 * (2026-08-29), que nomeava justamente "a primeira execução real será a primeira vez que
 * alguém o vê funcionar".
 *
 * Os IRMÃOS do bloco (`assoc`, `ctx`, `pen`) seguem `number` de verdade e continuam exigidos
 * com número — se um deles virar null um dia, este teste NÃO cobre, de propósito: o contrato
 * que a edge quebra é só o de `sim_score`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RecommendationCard } from '@/components/RecommendationCard';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';

/** O card usa `Tooltip`, que exige o provider — envolver é harness, não parte da asserção. */
function renderCard(item: RecommendationItem) {
  return render(<TooltipProvider><RecommendationCard item={item} showAdminBreakdown /></TooltipProvider>);
}

function itemComSim(sim: number | null): RecommendationItem {
  return {
    product_id: 'p1',
    codigo: 'SKU-1',
    descricao: 'Verniz PU 900',
    price: 100,
    margin: 30,
    probability: 0.4,
    eip: 12,
    recommendation_type: 'cross_sell',
    explanation_text: 'porque sim',
    explanation_key: 'association',
    estoque: 5,
    _admin: {
      score_final: 0.5,
      cost_final: 70,
      estimated_cost_for_ranking: 70,
      cost_source: 'cmc',
      cost_confidence: 1,
      assoc_score: 0.25,
      // O campo sob teste: a edge manda NULL quando o cluster foi truncado.
      sim_score: sim as unknown as number,
      ctx_score: 0.125,
      penalties: 0,
      familia: 'PU',
      eiltv: null,
    },
  };
}

describe('RecommendationCard — breakdown admin com similaridade INDISPONÍVEL', () => {
  it('renderiza "—" para sim_score null, sem derrubar o card', () => {
    renderCard(itemComSim(null));

    // O rótulo do campo continua na tela: o breakdown não some, ele degrada.
    expect(screen.getByText('Sim')).toBeInTheDocument();

    // O valor é o travessão de "não medi" — NUNCA "0.000", que seria o zero fabricado.
    const bloco = screen.getByText('Sim').parentElement;
    expect(bloco?.textContent).toContain('—');
    expect(bloco?.textContent).not.toContain('0.000');
  });

  it('com similaridade MEDIDA segue mostrando o número com 3 casas', () => {
    renderCard(itemComSim(0.4212));

    const bloco = screen.getByText('Sim').parentElement;
    expect(bloco?.textContent).toContain('0.421');
  });

  it('os irmãos do bloco seguem exigidos como número', () => {
    renderCard(itemComSim(null));

    expect(screen.getByText('Assoc').parentElement?.textContent).toContain('0.250');
    expect(screen.getByText('Ctx').parentElement?.textContent).toContain('0.125');
  });
});
