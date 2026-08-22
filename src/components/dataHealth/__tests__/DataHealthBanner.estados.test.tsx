import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard money-path — o banner de saúde de dados não pode SUMIR quando não consegue ler.
 *
 * Ele fazia `const { data } = useDataHealth()` + `if (!check || check.status === 'ok')
 * return null`. Como o hook lança quando `get_data_health` falha, `data` fica `undefined`
 * no erro e o banner desaparecia do dashboard financeiro e do cockpit de reposição — as
 * duas telas de money-path onde ele existe para dizer "não decida por aqui". Ausência
 * afirmando segurança (docs/historico/fase-sem-sinal.md).
 *
 * O HOOK roda de verdade; só o supabase é mockado. Mockar `useDataHealth` provaria apenas
 * que o banner renderiza um estado que eu mesmo montei — e o defeito mora exatamente na
 * tradução "RPC falhou" → "data undefined" → "tela idêntica à da fonte saudável".
 */
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: [], error: null };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: () => Promise.resolve(resposta) },
}));

import { DataHealthBanner } from '../DataHealthBanner';

const check = (over: Record<string, unknown> = {}) => ({
  source: 'saldo_bancario', domain: 'financeiro', status: 'ok',
  age_seconds: 10, expected_max_age_seconds: 3600, freshness_basis: 'x',
  message: 'Saldo bancário desatualizado', last_error: null, probable_cause: null,
  how_to_fix: null, severity: 'warning', ...over,
});

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <DataHealthBanner source="saldo_bancario" />
    </QueryClientProvider>,
  );
}

/** A frase do aviso de leitura falha — o que separa "não consegui" de "está tudo bem". */
const AVISO = /não quer dizer que está tudo certo/i;

beforeEach(() => { onlineManager.setOnline(true); });
afterEach(() => { onlineManager.setOnline(true); });

describe('DataHealthBanner — erro NÃO pode virar silêncio', () => {
  it('fonte saudável: silêncio (o único silêncio legítimo)', async () => {
    resposta = { data: [check({ status: 'ok' })], error: null };
    const { container } = renderBanner();
    await waitFor(() => expect(container.querySelector('span')).toBeNull());
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('fonte doente: o banner de sempre', async () => {
    resposta = { data: [check({ status: 'broken' })], error: null };
    renderBanner();
    expect(await screen.findByText(/Saldo bancário desatualizado/)).toBeTruthy();
    // e NÃO é o aviso de leitura — os dois textos não podem se confundir
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa, não some — este é o defeito da classe', async () => {
    resposta = { data: null, error: { message: 'permission denied' } };
    renderBanner();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    resposta = { data: [check({ status: 'ok' })], error: null };
    renderBanner();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('leitura OK mas a fonte não é monitorada: avisa em vez de afirmar saúde', async () => {
    resposta = { data: [check({ source: 'outra_fonte', status: 'ok' })], error: null };
    renderBanner();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('erro e fonte-saudável NÃO produzem a mesma tela (o colapso, medido)', async () => {
    resposta = { data: [check({ status: 'ok' })], error: null };
    const saudavel = renderBanner();
    await waitFor(() => expect(saudavel.container.textContent).toBe(''));
    const telaSaudavel = saudavel.container.textContent;
    saudavel.unmount();

    resposta = { data: null, error: { message: 'boom' } };
    const erro = renderBanner();
    await waitFor(() => expect(erro.container.textContent).not.toBe(''));
    expect(erro.container.textContent).not.toBe(telaSaudavel);
  });
});
