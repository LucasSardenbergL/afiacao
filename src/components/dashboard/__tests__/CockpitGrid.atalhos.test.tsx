import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShortcutsRegistryProvider } from '@/components/shell/ShortcutsRegistry';
import { CockpitGrid } from '../CockpitGrid';

const { zona, editMode } = vi.hoisted(() => ({
  zona: (nome: string) => ({ [nome]: () => <div data-testid={nome} /> }),
  editMode: { isEditMode: false, exit: vi.fn() },
}));
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

const scroll = vi.fn();

function montar() {
  render(
    <ShortcutsRegistryProvider>
      <input aria-label="busca" />
      <CockpitGrid />
    </ShortcutsRegistryProvider>,
  );
}

const zonaDe = (testId: string) => screen.getByTestId(testId).parentElement as HTMLElement;

describe('CockpitGrid — atalhos pelo registry', () => {
  beforeEach(() => {
    editMode.isEditMode = false;
    editMode.exit.mockClear();
    scroll.mockClear();
    HTMLElement.prototype.scrollIntoView = scroll;
  });

  it('tecla 2 rola até a 2ª zona e a destaca', () => {
    montar();
    act(() => {
      fireEvent.keyDown(document.body, { key: '2' });
    });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(zonaDe('EstoqueZone'));
    expect(zonaDe('EstoqueZone').classList.contains('ring-2')).toBe(true);
  });

  it('tecla de zona sem zona montada não faz nada', () => {
    montar();
    act(() => {
      fireEvent.keyDown(document.body, { key: '5' });
    });
    expect(scroll).not.toHaveBeenCalled();
  });

  it('digitando num input não dispara', () => {
    montar();
    fireEvent.keyDown(screen.getByLabelText('busca'), { key: '2' });
    expect(scroll).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl+2 é do navegador (troca de aba), não do cockpit', () => {
    montar();
    fireEvent.keyDown(document.body, { key: '2', metaKey: true });
    fireEvent.keyDown(document.body, { key: '2', ctrlKey: true });
    expect(scroll).not.toHaveBeenCalled();
  });

  it('Esc fora do edit mode não chama exit', () => {
    montar();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(editMode.exit).not.toHaveBeenCalled();
  });

  it('em edit mode: Esc sai e as teclas de zona ficam desligadas', () => {
    editMode.isEditMode = true;
    montar();
    fireEvent.keyDown(document.body, { key: '2' });
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(editMode.exit).toHaveBeenCalledTimes(1);
  });
});
