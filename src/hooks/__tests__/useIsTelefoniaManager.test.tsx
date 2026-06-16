import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// A aba "Time" deve seguir o acesso de EXIBIÇÃO (lente-aware), não o papel real do
// master logado: na lente "Ver como" um farmer impersonado não pode ver a aba Time.
const displayMock = vi.fn();
vi.mock('@/hooks/useDisplayAccess', () => ({ useDisplayAccess: () => displayMock() }));

import { useIsTelefoniaManager } from '@/hooks/useIsTelefoniaManager';

beforeEach(() => vi.clearAllMocks());

describe('useIsTelefoniaManager — aba "Time" lente-aware', () => {
  it('gestor comercial (display) → true', () => {
    displayMock.mockReturnValue({ displayIsMaster: false, displayIsGestorComercial: true });
    const { result } = renderHook(() => useIsTelefoniaManager());
    expect(result.current).toBe(true);
  });

  it('master (display) → true', () => {
    displayMock.mockReturnValue({ displayIsMaster: true, displayIsGestorComercial: false });
    const { result } = renderHook(() => useIsTelefoniaManager());
    expect(result.current).toBe(true);
  });

  it('farmer/não-gestor (display) → false, sem aba Time', () => {
    displayMock.mockReturnValue({ displayIsMaster: false, displayIsGestorComercial: false });
    const { result } = renderHook(() => useIsTelefoniaManager());
    expect(result.current).toBe(false);
  });
});
