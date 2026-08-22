import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — os três estados do MixGap não podem colapsar numa tela em branco só.
 *
 * O card fazia `if (!data || data.totalComGap === 0) return null;` e só emitia
 * `carteira.mixgap_visto` quando `totalComGap > 0`. Como `useMyMixGap` LANÇA quando a RPC
 * falha, `data` fica `undefined` no erro — a MESMA condição do zero. Resultado: "não há
 * oportunidade", "não consegui ler" e "o vendedor nunca abriu a tela" produziam o mesmo
 * silêncio, na tela e no PostHog.
 *
 * Por que agora: o motor por trás do card saiu de 116 para ~84 clientes com gap (#1853,
 * medido em prod). Sem separar os estados não há como distinguir "caiu para 84" de "quebrou
 * e sumiu" — a fase seguinte nasceria sem o sinal que a julga
 * (`docs/historico/fase-sem-sinal.md`).
 *
 * O HOOK roda de verdade; só o supabase é mockado. Mockar `useMyMixGap` provaria apenas que
 * o card renderiza um estado que eu mesmo montei — e o defeito mora exatamente na tradução
 * "RPC falhou" → "data undefined" → "tela igual à do zero".
 */

const FARMER = 'farmer-a';

type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: { total_com_gap: 0, lista: [] }, error: null };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: () => Promise.resolve(resposta) },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: FARMER }, isStaff: true, loading: false }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/hooks/useMarkMixGapFeedback', () => ({
  useMarkMixGapFeedback: () => ({ mutate: vi.fn() }),
}));
vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));
const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { MixGapCard } from '../MixGapCard';

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MixGapCard />
    </QueryClientProvider>,
  );
}

/** O evento de `carteira.mixgap_visto`, ou undefined se ele nunca saiu. */
function eventoVisto(): Record<string, unknown> | undefined {
  const c = track.mock.calls.find((c) => c[0] === 'carteira.mixgap_visto');
  return c?.[1] as Record<string, unknown> | undefined;
}

const COM_GAP = {
  total_com_gap: 2,
  lista: [
    { customer_user_id: 'c1', nome: 'Marcenaria Alfa', familia_faltante: 'VERNIZ', confidence: 0.4, lift: 3.1, evidence_count: 2 },
    { customer_user_id: 'c2', nome: 'Marcenaria Beta', familia_faltante: 'SELADOR', confidence: 0.3, lift: 2.2, evidence_count: 1 },
  ],
};

beforeEach(() => {
  track.mockClear();
});

describe('MixGapCard — os três estados se separam', () => {
  it('ZERO real: mostra estado vazio explícito e emite o evento COM o zero', async () => {
    resposta = { data: { total_com_gap: 0, lista: [] }, error: null };
    renderCard();

    // Antes: `return null` — o vendedor não via nada e nada era registrado.
    expect(await screen.findByText(/Nenhuma oportunidade de cross-sell agora/i)).toBeTruthy();
    await waitFor(() => expect(eventoVisto()).toBeTruthy());
    expect(eventoVisto()).toMatchObject({ estado: 'zero', total_com_gap: 0 });
  });

  it('ERRO de leitura: diz que FALHOU e o evento leva total null — nunca 0', async () => {
    resposta = { data: null, error: { message: 'timeout' } };
    renderCard();

    expect(await screen.findByText(/Não consegui carregar as oportunidades/i)).toBeTruthy();
    await waitFor(() => expect(eventoVisto()).toBeTruthy());

    const ev = eventoVisto()!;
    expect(ev.estado).toBe('erro');
    // O assert que carrega o §2 (ausente ≠ zero): mandar `0` aqui somaria falha de leitura
    // à série de "carteiras sem oportunidade" e fabricaria o número que o sensor existe
    // para medir. `null` é a única resposta honesta.
    expect(ev.total_com_gap).toBeNull();
    expect(ev.total_com_gap).not.toBe(0);
  });

  it('ERRO e ZERO são telas DIFERENTES — é isto que o defeito colapsava', async () => {
    resposta = { data: { total_com_gap: 0, lista: [] }, error: null };
    const zero = renderCard();
    await screen.findByText(/Nenhuma oportunidade de cross-sell agora/i);
    const textoZero = zero.container.textContent ?? '';
    zero.unmount();

    resposta = { data: null, error: { message: 'timeout' } };
    const erro = renderCard();
    await screen.findByText(/Não consegui carregar as oportunidades/i);
    const textoErro = erro.container.textContent ?? '';

    expect(textoZero).not.toBe(textoErro);
    // E o texto do erro precisa desfazer ativamente a leitura errada, não só ser diferente.
    expect(textoErro).toMatch(/NÃO significa que não há oportunidades/i);
  });

  it('COM GAP: lista os clientes e o evento leva o total real', async () => {
    resposta = { data: COM_GAP, error: null };
    renderCard();

    expect(await screen.findByText('Marcenaria Alfa')).toBeTruthy();
    expect(screen.getByText('Marcenaria Beta')).toBeTruthy();
    await waitFor(() => expect(eventoVisto()).toBeTruthy());
    expect(eventoVisto()).toMatchObject({ estado: 'com_gap', total_com_gap: 2 });
  });

  it('SEM ACESSO (a RPC devolve NULL para não-staff): não renderiza e NÃO emite evento', async () => {
    resposta = { data: null, error: null };
    const { container } = renderCard();

    await waitFor(() => expect(container.textContent).toBe(''));
    // Ausência de acesso não é ausência de oportunidade: contá-la como "visto" poluiria o
    // denominador da adoção com quem nunca poderia ver o card.
    expect(eventoVisto()).toBeUndefined();
  });

  it('CARREGANDO não conta como visto — o evento espera o estado RESOLVER', async () => {
    let liberar: (r: Resposta) => void = () => {};
    const pendente = new Promise<Resposta>((res) => { liberar = res; });
    resposta = { data: { total_com_gap: 0, lista: [] }, error: null };
    vi.spyOn(await import('@/integrations/supabase/client'), 'supabase', 'get').mockReturnValue({
      rpc: () => pendente,
    } as never);

    renderCard();
    // Em voo: nada de evento. Emitir aqui inflaria a adoção com montagens que nunca viraram
    // um estado observável pelo vendedor.
    expect(eventoVisto()).toBeUndefined();

    liberar({ data: COM_GAP, error: null });
    await waitFor(() => expect(eventoVisto()).toBeTruthy());
    expect(eventoVisto()).toMatchObject({ estado: 'com_gap' });
  });
});
