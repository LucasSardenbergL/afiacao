import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PositivacaoHero } from '../PositivacaoHero';
import type { PositivacaoKpis } from '@/hooks/useMyPositivacao';
import type { ClienteAPositivar } from '@/lib/positivacao/types';

/**
 * O placar só pode chamar um número pelo que ele CONTA.
 *
 * `novos_clientes_positivados` conta quem fez a 1ª compra DA VIDA no mês. O placar do farmer o
 * exibia como "Recuperados (win-back) — voltaram a comprar no mês": em set/2026 o card dizia 2,
 * e 39 clientes da carteira tinham voltado após ≥90 dias sem comprar (medido em 2026-09-30).
 * E "Clientes a positivar" era o `length` da lista que a RPC corta em 200: os 3 farmers liam
 * 200 com 1.179–2.388 clientes sem pedido. Ver docs/historico/positivacao-win-back-era-novos.md.
 */

// A lista chega no teto da RPC (`LIMIT 200`); o total sem pedido é outro número.
const TETO_DA_RPC = 200;
const lista = (n: number): ClienteAPositivar[] =>
  Array.from({ length: n }, (_, i) => ({
    customer_user_id: `c-${i}`, nome: `Cliente ${i}`, revenue_potential: null, churn_risk: 50,
    recover_score: null, days_since_last_purchase: 300, priority_score: 46,
  }));

const KPIS: PositivacaoKpis = {
  mes: '2026-09-01',
  totalEligible: 2399,
  positivados: 11,
  pctPositivacao: 0,
  ticketMedio: 1200,
  receitaMtd: 13_200,
  pctCobertura: 4,
  recenciaCritica: 37,
  novosPositivados: 2,
  aPositivarTotal: 2388,
  aPositivar: lista(TETO_DA_RPC),
};

function montar(isHunter: boolean) {
  render(<TooltipProvider><PositivacaoHero kpis={KPIS} isHunter={isHunter} /></TooltipProvider>);
}

/** O `KpiCard` põe rótulo, valor e sub como filhos diretos do card: o card é o pai do rótulo. */
function card(rotulo: string): HTMLElement {
  const el = screen.getByText(rotulo).parentElement;
  if (!el) throw new Error(`rótulo sem card: ${rotulo}`);
  return el;
}
const valor = (rotulo: string) => card(rotulo).querySelector('.kpi-value')?.textContent;

afterEach(cleanup);

describe('PositivacaoHero (farmer) — o rótulo diz o que o número conta', () => {
  it('novos_clientes_positivados aparece como NOVOS, nunca como win-back', () => {
    montar(false);
    expect(valor('Novos na carteira (MTD)')).toBe('2');
    expect(card('Novos na carteira (MTD)').textContent).toContain('1ª compra neste mês');
    expect(screen.queryByText('Recuperados (win-back)')).toBeNull();
    expect(screen.queryByText('voltaram a comprar no mês')).toBeNull();
  });

  it('"Clientes a positivar" é o total sem pedido, não o tamanho da lista cortada em 200', () => {
    montar(false);
    expect(valor('Clientes a positivar')).toBe('2388');
    // dente: o `length` da lista daria exatamente o teto
    expect(valor('Clientes a positivar')).not.toBe(String(TETO_DA_RPC));
  });
});

describe('PositivacaoHero — novos com o MESMO texto nos dois placares', () => {
  it.each([true, false])('isHunter=%s: mesmo rótulo, mesma sub, mesmo número', (isHunter) => {
    montar(isHunter);
    expect(valor('Novos na carteira (MTD)')).toBe('2');
    expect(card('Novos na carteira (MTD)').textContent).toContain('1ª compra neste mês');
  });
});
