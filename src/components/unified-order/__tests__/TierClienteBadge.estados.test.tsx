import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard MONEY-PATH da classe "erro colapsado em vazio" no badge de tier comercial.
 *
 * Aqui a classe tinha a variante mais cara: a falha de leitura não só escondia o badge de
 * quem não edita (`semTier && !podeEditar → null`) como AFIRMAVA "Definir tier" a quem
 * edita — e o dialog abria com os selects vazios, de onde um Salvar sobrescreveria, por
 * upsert, o tier vigente que o componente não conseguiu ler. Como o tier orienta o preço
 * de PARTIDA, fabricar "não há tier" a partir de "não consegui ler" é o §2 do money-path
 * (ausente ≠ zero) na UI. Correção fail-CLOSED: sem leitura não se edita.
 *
 * O HOOK roda de verdade; só o supabase e o auth são mockados.
 */
const CLIENTE = 'cliente-1';
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: [], error: null };
let auth = { isMaster: true, isGestorComercial: false, user: { id: 'u1' } };

function builder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'upsert', 'gte', 'order', 'limit']) b[m] = () => b;
  b.then = (ok: (v: Resposta) => unknown, no?: (e: unknown) => unknown) => Promise.resolve(resposta).then(ok, no);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { TierClienteBadge } from '../TierClienteBadge';

const AVISO = /Tier indisponível/i;
const DEFINIR = /Definir tier/i;

let qc: QueryClient;
function renderBadge() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <TierClienteBadge customerUserId={CLIENTE} customerName="Marcenaria X" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  onlineManager.setOnline(true);
  auth = { isMaster: true, isGestorComercial: false, user: { id: 'u1' } };
});
afterEach(() => { onlineManager.setOnline(true); });

describe('TierClienteBadge — "não consegui ler" NÃO pode virar "sem tier"', () => {
  it('com tier: mostra o tier vigente', async () => {
    resposta = { data: [{ company: 'oben', tier: 'A' }], error: null };
    renderBadge();
    expect(await screen.findByText(/Oben A/)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('SEM tier de verdade + pode editar: convida a definir', async () => {
    resposta = { data: [], error: null };
    renderBadge();
    expect(await screen.findByText(DEFINIR)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('SEM tier de verdade + NÃO pode editar: silêncio (o único legítimo)', async () => {
    auth = { isMaster: false, isGestorComercial: false, user: { id: 'u1' } };
    resposta = { data: [], error: null };
    const { container } = renderBadge();
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('ERRO de leitura + pode editar: NÃO afirma "Definir tier" — avisa e bloqueia a edição', async () => {
    // O dano money-path: com os selects vazios, um Salvar sobrescreveria o tier vigente.
    resposta = { data: null, error: { message: 'permission denied for table cliente_tier_preco' } };
    renderBadge();
    expect(await screen.findByText(AVISO)).toBeTruthy();
    expect(screen.queryByText(DEFINIR), 'a falha de leitura virou "sem tier"').toBeNull();
    expect(
      screen.queryByRole('button', { name: /Editar tier/i }),
      'a edição continuou aberta sobre uma leitura que falhou',
    ).toBeNull();
  });

  it('ERRO de leitura + NÃO pode editar: avisa em vez de sumir', async () => {
    auth = { isMaster: false, isGestorComercial: false, user: { id: 'u1' } };
    resposta = { data: null, error: { message: 'boom' } };
    renderBadge();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    resposta = { data: [{ company: 'oben', tier: 'A' }], error: null };
    renderBadge();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('refetch falha COM o tier no cache: o tier FICA (não vira "indisponível" nem some)', async () => {
    resposta = { data: [{ company: 'colacor', tier: 'B' }], error: null };
    renderBadge();
    expect(await screen.findByText(/Colacor B/)).toBeTruthy();

    resposta = { data: null, error: { message: 'connection failure' } };
    await qc.refetchQueries();

    await waitFor(() => expect(screen.queryByText(/Colacor B/)).toBeTruthy());
    expect(screen.queryByText(AVISO), 'apagou o tier que já estava em mãos').toBeNull();
  });

  it('erro e sem-tier NÃO produzem a mesma tela (o colapso, medido)', async () => {
    resposta = { data: [], error: null };
    const vazio = renderBadge();
    await waitFor(() => expect(vazio.container.textContent).toContain('Definir tier'));
    const telaVazia = vazio.container.textContent;
    vazio.unmount();

    resposta = { data: null, error: { message: 'boom' } };
    const erro = renderBadge();
    // Esperar o ESTADO FINAL, não "container não-vazio": era assim que este teste pegava o
    // texto do `carregando` e comparava o transitório com o vazio.
    await screen.findByText(AVISO);
    expect(erro.container.textContent).not.toBe(telaVazia);
  });
});
