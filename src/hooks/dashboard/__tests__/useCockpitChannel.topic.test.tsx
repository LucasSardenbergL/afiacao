import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { RealtimeClient } from '@supabase/supabase-js';

// Client REAL do realtime-js (não fake): é ele que deduplica canal por topic e
// lança "cannot add `postgres_changes` callbacks ... after `subscribe()`".
// Socket aponta para porta morta — a conexão falha em background, mas o canal
// já fica em 'joining', que é o estado do incidente.
const realtime = new RealtimeClient('ws://127.0.0.1:1/realtime/v1', {
  params: { apikey: 'teste' },
  reconnectAfterMs: () => 60_000,
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: (topic: string) => realtime.channel(topic),
    // removeChannel real é async (aguarda o phx_leave) — o canal continua na
    // lista até lá; não remover aqui reproduz a janela de corrida.
    removeChannel: vi.fn(),
  },
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { useCockpitChannel } from '../useCockpitChannel';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: new QueryClient() }, children);
}

const opts = { zone: 'vendas' as const, table: 'sales_orders', queryKeys: [['x']] as const };

afterEach(() => {
  cleanup();
  realtime.disconnect();
});

describe('useCockpitChannel — topic geracional', () => {
  it('dois mounts simultâneos da mesma zona não lançam', () => {
    renderHook(() => useCockpitChannel(opts), { wrapper });
    expect(() => renderHook(() => useCockpitChannel(opts), { wrapper })).not.toThrow();
  });

  it('remount antes do leave confirmar não lança', () => {
    const { unmount } = renderHook(() => useCockpitChannel(opts), { wrapper });
    unmount();
    expect(() => renderHook(() => useCockpitChannel(opts), { wrapper })).not.toThrow();
  });
});
