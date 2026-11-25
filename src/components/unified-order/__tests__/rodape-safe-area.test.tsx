import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { publicarRodape, reservaDaBarra, VAR_RODAPE_FIXO } from '../reserva-rodape';
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

describe('reservaDaBarra — do topo da barra ao fim da tela (Codex P2)', () => {
  it('barra presa ao fim: reserva = altura', () => expect(reservaDaBarra(700, 800)).toBe(100));
  it('fim da rolagem: a barra subiu 74px → a reserva cresce junto', () => expect(reservaDaBarra(626, 800)).toBe(174));
  it('barra abaixo da tela → não reserva', () => expect(reservaDaBarra(900, 800)).toBeNull());
  it('medida inválida → não reserva', () => expect(reservaDaBarra(Number.NaN, 800)).toBeNull());
});

describe('BarraEnvioPedido publica a reserva enquanto está montada', () => {
  const props: BarraEnvioPedidoProps = {
    temCliente: true, carregandoCliente: false, obenProductItems: [], colacorProductItems: [], serviceItems: [],
    vendedorDivergencias: [], estadoVendedor: 'nao_verificado', loadingFormas: false, exigeCondicao: true,
    selectedParcelaOben: '999', selectedParcelaColacor: '999',
    submitting: false, totalEstimated: 0, servicosAOrcar: 0, onSubmit: vi.fn(),
  };

  it('monta → --rodape-fixo; desmonta → some', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: window.innerHeight - 88, height: 88 } as DOMRect);
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
    expect(shell).toContain("'pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]'");
    expect(shell).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
  });
  it('sheets que encostam no topo: X abaixo da barra de status; o de baixo fica onde estava (Codex P1)', () => {
    const sheet = ler('src/components/ui/sheet.tsx');
    expect(sheet).toContain('side === "bottom" ? "right-4 top-4" : "right-[calc(1rem+env(safe-area-inset-right))] top-[calc(1rem+env(safe-area-inset-top))]"');
    expect(sheet.match(/pt-\[calc\(1\.5rem\+env\(safe-area-inset-top\)\)\]/g)?.length).toBe(3);
  });
  it('faixa "Ver como": a área segura entra UMA vez (topbar de 48px abaixo da faixa) — Codex P2', () => {
    const shell = ler('src/components/AppShell.tsx');
    expect(shell).toContain("isImpersonating ? 'faixa-ver-como-top h-12' : 'top-0 h-topbar pt-[env(safe-area-inset-top)]'");
    // pt-7 = a faixa; a mesma classe publica --faixa-ver-como (token topo-conteudo).
    expect(shell).toContain("isImpersonating && 'pt-7 [--faixa-ver-como:1.75rem]'");
  });
});
