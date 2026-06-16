import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReguaPrecoSinal } from '../ReguaPrecoSinal';
import type { ReguaPrecoResult } from '@/lib/regua-preco/types';

// Radix Popover usa APIs de pointer capture ausentes no jsdom — polyfill p/ abrir o content.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

const base: ReguaPrecoResult = {
  sinal: 'nenhum', confianca: 'oculto', precoReferencia: null, observedGapPct: null,
  suggestedGapPct: null, pisoMC: null, abaixoPiso: false, capLimitou: false,
  discordancia: false, recibos: [], disclaimers: [], reasonCodes: [],
};
const ctx = { produto: 'Verniz PU', cliente: 'Marcenaria Silva', qty: 2 };
const noop = () => {};
const abrir = () => fireEvent.click(screen.getByLabelText('Detalhes da Régua de Preço'));

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

  // ─── modo readonly (Customer 360) ───
  const piso: ReguaPrecoResult = { ...base, sinal: 'piso', confianca: 'alta', abaixoPiso: true,
    precoReferencia: 125, pisoMC: 125, observedGapPct: 0.38, suggestedGapPct: 0.38,
    recibos: ['Custo+imposto ≈ piso R$ 125,00; seu preço R$ 90,00 (MC negativa).'] };

  it('readonly + piso → badge "abaixo do piso" SEM o valor (não vaza custo no badge)', () => {
    render(<ReguaPrecoSinal result={piso} precoAtual={90} contexto={ctx} mode="readonly" />);
    expect(screen.getByText('abaixo do piso')).toBeInTheDocument();
    expect(screen.queryByText(/MC<0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/125/)).not.toBeInTheDocument();
  });
  it('readonly + piso → popover NÃO mostra "Custo+imposto", valor do piso nem botão Aplicar', () => {
    render(<ReguaPrecoSinal result={piso} precoAtual={90} contexto={ctx} mode="readonly" />);
    abrir();
    expect(screen.getByText(/abaixo do piso comercial/i)).toBeInTheDocument();
    expect(screen.queryByText(/Custo\+imposto/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/125/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Aplicar/)).not.toBeInTheDocument();
  });
  it('readonly + folga → nunca mostra Aplicar, mas a referência (não vaza custo) aparece', () => {
    const folga: ReguaPrecoResult = { ...base, sinal: 'auto_ref', confianca: 'media',
      precoReferencia: 130, suggestedGapPct: 0.08, recibos: ['Você já cobrou ~R$ 130,00 deste cliente neste item.'] };
    render(<ReguaPrecoSinal result={folga} precoAtual={120} contexto={ctx} mode="readonly" />);
    expect(screen.getByText(/💰/)).toBeInTheDocument();
    abrir();
    expect(screen.queryByText(/Aplicar/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/130/).length).toBeGreaterThan(0);
  });
  it('carrinho (default) + piso → mantém valor do piso e botão Aplicar (regressão)', () => {
    render(<ReguaPrecoSinal result={piso} precoAtual={90} contexto={ctx} onAplicar={noop} />);
    expect(screen.getByText(/MC<0 · piso/)).toBeInTheDocument();
    abrir();
    expect(screen.getByText(/Aplicar piso/)).toBeInTheDocument();
  });
  it('readonly + desde → popover mostra a data do último preço (calibração b)', () => {
    render(<ReguaPrecoSinal result={piso} precoAtual={90} contexto={{ ...ctx, desde: '06/06/2026' }} mode="readonly" />);
    abrir();
    expect(screen.getByText(/Último preço: 06\/06\/2026/)).toBeInTheDocument();
  });
});
