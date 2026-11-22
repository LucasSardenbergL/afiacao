/**
 * Desde a `recommend` v1.9, estoque desconhecido (o Omie não mandou saldo — #4087) chega como
 * `estoque: null` e o produto CONTINUA recomendável. O card dizia "{estoque} em estoque": com null
 * viraria " em estoque", e antes da v1.9 a edge fabricava "0 em estoque". Ausente ≠ zero.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RecommendationCard } from '@/components/RecommendationCard';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';

function item(estoque: number | null): RecommendationItem {
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
    estoque,
  };
}

function renderCard(i: RecommendationItem) {
  return render(<TooltipProvider><RecommendationCard item={i} /></TooltipProvider>);
}

describe('RecommendationCard — estoque desconhecido', () => {
  it('null mostra "estoque desconhecido", nunca "0 em estoque"', () => {
    renderCard(item(null));
    expect(screen.getByText('estoque desconhecido')).toBeTruthy();
    expect(screen.queryByText(/em estoque/)).toBeNull();
  });

  it('número conhecido segue "N em estoque" (inclusive o zero real)', () => {
    renderCard(item(0));
    expect(screen.getByText('0 em estoque')).toBeTruthy();
  });
});
