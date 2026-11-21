import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { publicarRodape, VAR_RODAPE_FIXO } from '../reserva-rodape';
import { BarraEnvioPedido, type BarraEnvioPedidoProps } from '../BarraEnvioPedido';

const raiz = () => document.documentElement;
const ler = (p: string) => readFileSync(resolve(__dirname, '../../../..', p), 'utf8');

afterEach(() => { raiz().style.removeProperty(VAR_RODAPE_FIXO); vi.restoreAllMocks(); });

describe('publicarRodape — a barra reserva o rodapé para os painéis', () => {
  it('altura positiva → variável em px (arredondada para cima)', () => {
    publicarRodape(raiz(), 72.2);
    expect(raiz().style.getPropertyValue(VAR_RODAPE_FIXO)).toBe('73px');
  });
  it.each([[null], [0], [Number.NaN]])('altura %s → variável removida (painéis voltam ao lugar)', (h) => {
    publicarRodape(raiz(), 50);
    publicarRodape(raiz(), h as number | null);
    expect(raiz().style.getPropertyValue(VAR_RODAPE_FIXO)).toBe('');
  });
});

describe('BarraEnvioPedido publica a altura enquanto está montada', () => {
  const props: BarraEnvioPedidoProps = {
    temCliente: true, carregandoCliente: false, obenProductItems: [], colacorProductItems: [], serviceItems: [],
    vendedorDivergencias: [], loadingFormas: false, exigeCondicao: true,
    selectedParcelaOben: '999', selectedParcelaColacor: '999',
    submitting: false, totalEstimated: 0, servicosAOrcar: 0, onSubmit: vi.fn(),
  };

  it('monta → --rodape-fixo; desmonta → some', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 88 } as DOMRect);
    const { unmount } = render(<BarraEnvioPedido {...props} />);
    expect(raiz().style.getPropertyValue(VAR_RODAPE_FIXO)).toBe('88px');
    unmount();
    expect(raiz().style.getPropertyValue(VAR_RODAPE_FIXO)).toBe('');
  });
});

describe('fiação: painéis da ligação e viewport-fit=cover', () => {
  it('o HUD da ligação sobe acima da barra e cabe em 360px', () => {
    const hud = ler('src/components/call/CallCopilotHud.tsx');
    expect(hud).toContain('bottom-[calc(1rem+max(var(--rodape-fixo,0px),env(safe-area-inset-bottom)))]');
    expect(hud).toContain('w-[min(320px,calc(100vw-2rem))]');
    expect(hud).not.toContain('fixed bottom-4 left-4');
  });
  it('o painel de transferência também sobe', () => {
    expect(ler('src/components/call/TransferSpikePanel.tsx')).toContain('var(--rodape-fixo,0px)');
  });
  it('viewport-fit=cover + topbar que cresce pela área segura do topo', () => {
    expect(ler('index.html')).toContain('viewport-fit=cover');
    expect(ler('tailwind.config.ts')).toContain('"topbar": "calc(48px + env(safe-area-inset-top, 0px))"');
    const shell = ler('src/components/AppShell.tsx');
    expect(shell).toContain("'pt-[env(safe-area-inset-top)] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]'");
    expect(shell).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
  });
});
