import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — o painel de SAÚDE da carteira não pode desaparecer quando não lê.
 *
 * Gêmeo exato do MixGap do #1859, com um agravante: este painel É o alarme. Ele fazia
 * `if (!data) return null` e só emitia `carteira.saude_vista` quando havia `data`. Como
 * `useCarteiraSaude` lança quando a RPC falha, erro e "nunca carregou" caíam no mesmo
 * silêncio — e a série de adoção somava falha de leitura a "ninguém abriu"
 * (docs/historico/fase-sem-sinal.md). Denominador medido: 3 vendedores.
 *
 * O HOOK roda de verdade; só o supabase é mockado.
 */
const STAFF = 'staff-1';
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: null, error: null };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: () => Promise.resolve(resposta) },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: STAFF }, isStaff: true, loading: false }),
}));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { CarteiraSaudePanel } from '../CarteiraSaudePanel';

const RESUMO = {
  crons: [{ jobname: 'carteira-nightly', last_run_at: '2026-08-22T03:00:00Z', last_status: 'succeeded', age_hours: 2 }],
  sync: { age_hours: 1, stale_count: 0 },
  score_coverage: { carteira: 100, fcs_clientes: 90, cvs_clientes: 80 },
};

function renderPainel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <CarteiraSaudePanel />
    </QueryClientProvider>,
  );
}

/** O evento de adoção, ou undefined se ele nunca saiu. */
const evento = () => track.mock.calls.find((c) => c[0] === 'carteira.saude_vista')?.[1] as
  Record<string, unknown> | undefined;

const AVISO = /não quer dizer que está tudo certo/i;

beforeEach(() => { track.mockClear(); onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('CarteiraSaudePanel — o painel de saúde não pode se apagar por não conseguir ler', () => {
  it('leitura OK: renderiza o semáforo e emite o nível', async () => {
    resposta = { data: RESUMO, error: null };
    renderPainel();
    expect(await screen.findByText(/Saúde da carteira/)).toBeTruthy();
    await waitFor(() => expect(evento()).toBeTruthy());
    expect(evento()!.estado).toBe('pronta');
    expect(evento()!.nivel).toBeTruthy();
  });

  it('ERRO: avisa na tela em vez de sumir', async () => {
    resposta = { data: null, error: { message: 'permission denied' } };
    renderPainel();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('ERRO: o evento SAI, e leva nivel NULL — nunca um nível fabricado', async () => {
    resposta = { data: null, error: { message: 'boom' } };
    renderPainel();
    await waitFor(() => expect(evento()).toBeTruthy());
    expect(evento()!.estado).toBe('erro');
    // §2 do money-path: ausente ≠ zero. Mandar 'green' aqui inventaria exatamente o
    // número que o sensor existe para medir.
    expect(evento()!.nivel).toBeNull();
    expect(evento()!.nivel).not.toBe('green');
  });

  it('OFFLINE: avisa também — o quarto estado (pending+paused)', async () => {
    onlineManager.setOnline(false);
    resposta = { data: RESUMO, error: null };
    renderPainel();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('erro e ausência-de-acesso NÃO produzem a mesma tela', async () => {
    resposta = { data: null, error: null };            // RPC devolve NULL = sem acesso
    const semAcesso = renderPainel();
    await waitFor(() => expect(semAcesso.container.textContent).toBe(''));
    semAcesso.unmount();

    resposta = { data: null, error: { message: 'boom' } };
    const erro = renderPainel();
    await waitFor(() => expect(erro.container.textContent).not.toBe(''));
  });
});
