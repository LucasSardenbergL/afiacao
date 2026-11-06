import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutsRegistryProvider } from '@/components/shell/ShortcutsRegistry';
import { CockpitGrid } from '../CockpitGrid';

// F13 (plano v7): o @hello-pangea/dnd só entra quando a edição é aberta.
const { zona, editMode, carga } = vi.hoisted(() => ({
  zona: (nome: string) => ({ [nome]: () => <div data-testid={nome} /> }),
  editMode: { isEditMode: false, exit: vi.fn() },
  carga: { vezes: 0 },
}));
vi.mock('../CockpitGridArrastavel', async (importOriginal) => {
  carga.vezes += 1;
  return importOriginal();
});
vi.mock('../zones/VendasZone', () => zona('VendasZone'));
vi.mock('../zones/EstoqueZone', () => zona('EstoqueZone'));
vi.mock('../zones/ReposicaoZone', () => zona('ReposicaoZone'));
vi.mock('../zones/FinanceiroZone', () => zona('FinanceiroZone'));
vi.mock('../zones/TintometricoZone', () => zona('TintometricoZone'));
vi.mock('../zones/SistemaZone', () => zona('SistemaZone'));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/contexts/DashboardPersonaContext', () => ({ useDashboardPersonaContext: () => ({ persona: 'founder' }) }));
vi.mock('@/contexts/DashboardEditModeContext', () => ({ useDashboardEditMode: () => editMode }));
vi.mock('@/hooks/useDashboardLayout', () => ({
  useDashboardLayout: () => ({
    visibleZones: ['vendas', 'estoque', 'financeiro'],
    hiddenZones: [],
    isCustomized: false,
    reorder: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    reset: vi.fn(),
  }),
}));

const arvore = () => (
  <ShortcutsRegistryProvider>
    <CockpitGrid />
  </ShortcutsRegistryProvider>
);
const zonaDe = (testId: string) => screen.getByTestId(testId).parentElement as HTMLElement;

describe('CockpitGrid — DND sob demanda (F13)', () => {
  beforeEach(() => {
    editMode.isEditMode = false;
  });

  it('fora da edição: renderiza as zonas sem baixar o módulo do DND', () => {
    render(arvore());
    expect(screen.getByTestId('EstoqueZone')).toBeTruthy();
    expect(carga.vezes).toBe(0);
    expect(zonaDe('EstoqueZone').hasAttribute('data-rfd-draggable-id')).toBe(false);
    expect(screen.queryByLabelText('Arrastar Estoque')).toBeNull();
  });

  it('entrar na edição carrega o DND e liga as alças; sair mantém a grade arrastável, travada', async () => {
    const { rerender } = render(arvore());
    expect(carga.vezes).toBe(0);

    editMode.isEditMode = true;
    rerender(arvore());
    // Enquanto o chunk baixa, a grade estática (fallback) já mostra a edição;
    // a alça só ganha os props do DND quando a variante arrastável monta.
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Arrastar Estoque').getAttribute('data-rfd-drag-handle-draggable-id')).toBe('estoque'),
    );
    expect(carga.vezes).toBe(1);
    expect(zonaDe('EstoqueZone').getAttribute('data-rfd-draggable-id')).toBe('estoque');

    editMode.isEditMode = false;
    rerender(arvore());
    expect(screen.queryByLabelText('Arrastar Estoque')).toBeNull();
    expect(zonaDe('EstoqueZone').getAttribute('data-rfd-draggable-id')).toBe('estoque');
    expect(carga.vezes).toBe(1);
  });
});
