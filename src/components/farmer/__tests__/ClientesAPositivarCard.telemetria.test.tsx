import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Guard money-path §2 (ausente ≠ zero) aplicado à TELEMETRIA.
 *
 * `churn_alto: (c.churn_risk ?? 0) >= 60` reportava risco DESCONHECIDO como risco BAIXO.
 * `churn_risk` é `number | null` (medido em @/lib/positivacao/types), então a ausência
 * chega mesmo — a correção não é inerte. O dano é de segunda ordem e por isso passa
 * despercebido: o evento sai plausível, e o denominador de "clientes de churn alto" fica
 * contaminado por linhas que NUNCA foram medidas. Quem depois lê a série não tem como
 * separar "risco baixo" de "nunca calculado" — o zero fabricado já não está mais na tela,
 * está no dado que vai fundamentar a próxima decisão.
 */
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { ClientesAPositivarCard } from '../ClientesAPositivarCard';

const cliente = (over: Record<string, unknown> = {}) => ({
  customer_user_id: 'c-1', nome: 'Marcenaria X', revenue_potential: 1000,
  churn_risk: 70, recover_score: 10, days_since_last_purchase: 30, priority_score: 5, ...over,
});

function abrirPrimeiro(clientes: ReturnType<typeof cliente>[]) {
  render(<MemoryRouter><ClientesAPositivarCard clientes={clientes} /></MemoryRouter>);
  fireEvent.click(screen.getByText(clientes[0].nome as string));
  return track.mock.calls.find((c) => c[0] === 'carteira.a_positivar_cliente_aberto')?.[1] as
    Record<string, unknown> | undefined;
}

beforeEach(() => track.mockClear());

describe('ClientesAPositivarCard — churn desconhecido não pode virar churn baixo', () => {
  it('churn alto medido: true', () => {
    expect(abrirPrimeiro([cliente({ churn_risk: 70 })])!.churn_alto).toBe(true);
  });

  it('churn baixo MEDIDO: false — o único false legítimo', () => {
    expect(abrirPrimeiro([cliente({ churn_risk: 10 })])!.churn_alto).toBe(false);
  });

  it('churn AUSENTE: null, nunca false — a asserção que separa ausência de medida', () => {
    const evento = abrirPrimeiro([cliente({ churn_risk: null })]);
    expect(evento!.churn_alto).toBeNull();
    // dente: `?? 0` devolveria exatamente `false` aqui, e o evento sairia plausível
    expect(evento!.churn_alto).not.toBe(false);
  });

  // Dois `render()` no mesmo `it` empilhariam o card no DOM e o getByText acharia dois —
  // a fronteira vira dois casos separados, cada um com o seu DOM limpo.
  it('fronteira 60: inclusiva (>= 60), a correção não mexeu no limiar', () => {
    expect(abrirPrimeiro([cliente({ churn_risk: 60 })])!.churn_alto).toBe(true);
  });

  it('fronteira 60: 59 continua abaixo', () => {
    expect(abrirPrimeiro([cliente({ churn_risk: 59 })])!.churn_alto).toBe(false);
  });
});
