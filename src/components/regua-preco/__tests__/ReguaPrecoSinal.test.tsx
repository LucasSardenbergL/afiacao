import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReguaPrecoSinal } from '../ReguaPrecoSinal';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';

const base: ReguaPrecoResult = {
  sinal: 'nenhum', confianca: 'oculto', precoReferencia: null, observedGapPct: null,
  suggestedGapPct: null, pisoMC: null, abaixoPiso: false, capLimitou: false,
  discordancia: false, recibos: [], disclaimers: [], reasonCodes: [],
};
const ctx = { produto: 'Verniz PU', cliente: 'Marcenaria Silva', qty: 2 };
const noop = () => {};

describe('ReguaPrecoSinal', () => {
  it('sinal nenhum → não renderiza nada', () => {
    const { container } = render(<ReguaPrecoSinal result={base} precoAtual={120} contexto={ctx} onAplicar={noop} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('piso com CMC confiável → badge vermelho com o piso (botão existe no popover)', () => {
    const r: ReguaPrecoResult = { ...base, sinal: 'piso', confianca: 'alta', abaixoPiso: true,
      precoReferencia: 106.29, pisoMC: 106.29, recibos: ['Custo+imposto ≈ piso R$ 106,29'] };
    render(<ReguaPrecoSinal result={r} precoAtual={100} contexto={ctx} onAplicar={noop} />);
    expect(screen.getByText(/MC<0/)).toBeInTheDocument();
  });
  it('folga baixa (sem precoReferencia) → não mostra número de ação', () => {
    const r: ReguaPrecoResult = { ...base, sinal: 'auto_ref', confianca: 'baixa',
      precoReferencia: null, recibos: ['Este cliente já pagou mais (amostra pequena).'] };
    render(<ReguaPrecoSinal result={r} precoAtual={100} contexto={ctx} onAplicar={noop} />);
    expect(screen.queryByText(/Aplicar/)).not.toBeInTheDocument();
  });
});
