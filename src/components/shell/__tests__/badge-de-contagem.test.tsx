import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BadgeIndisponivel } from '../BadgeDeContagem';
import { faceDoBadge, motivoDoBadgeIndisponivel } from '../badge-de-contagem';

/**
 * Plano v7, C11: o contrato de 3 faces do badge de contagem da navegação.
 * O defeito era a falha cair na MESMA face do zero (badge ausente = "nada aberto").
 */
describe('faceDoBadge — falha não pode cair na face do zero', () => {
  it('CONTROLE: lido 3 → número; lido 0 → oculto', () => {
    expect(faceDoBadge({ status: 'success', fetchStatus: 'idle', data: 3 })).toEqual({ tipo: 'numero', valor: 3 });
    expect(faceDoBadge({ status: 'success', fetchStatus: 'idle', data: 0 })).toEqual({ tipo: 'oculto' });
  });

  it('carregando e desabilitada → oculto (não fabrica alarme no 1º paint)', () => {
    expect(faceDoBadge({ status: 'pending', fetchStatus: 'fetching', data: undefined })).toEqual({ tipo: 'oculto' });
    expect(faceDoBadge({ status: 'pending', fetchStatus: 'idle', data: undefined })).toEqual({ tipo: 'oculto' });
  });

  it('ERRO sem dado → indisponível (não oculto)', () => {
    expect(faceDoBadge({ status: 'error', fetchStatus: 'idle', data: undefined })).toEqual({
      tipo: 'indisponivel', estado: 'erro', ultimo: null,
    });
  });

  it('SEM REDE (pending + paused) → indisponível sem-rede', () => {
    expect(faceDoBadge({ status: 'pending', fetchStatus: 'paused', data: undefined })).toEqual({
      tipo: 'indisponivel', estado: 'sem-rede', ultimo: null,
    });
  });

  it('ERRO com número antigo em cache → indisponível, com o último valor guardado', () => {
    expect(faceDoBadge({ status: 'error', fetchStatus: 'idle', data: 4 })).toEqual({
      tipo: 'indisponivel', estado: 'erro', ultimo: 4,
    });
  });
});

describe('BadgeIndisponivel', () => {
  it('desenha "?" com o motivo acessível', () => {
    const motivo = motivoDoBadgeIndisponivel('as melhorias abertas', 'erro', 4);
    render(<BadgeIndisponivel motivo={motivo} />);
    const el = screen.getByTestId('nav-badge-indisponivel');
    expect(el.textContent).toBe('?');
    expect(el.getAttribute('aria-label')).toBe(
      'Não foi possível contar as melhorias abertas (última leitura: 4)',
    );
  });
});
