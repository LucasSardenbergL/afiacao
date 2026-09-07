import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Guard da FATIA DE GATILHO — `whatsapp_conversations` tem 0 linhas em prod
 * (psql-ro, 2026-09-06); com zero conversa não há badge de SLA para sumir. A partir da
 * primeira conversa, sim (docs/historico/a-forma-que-some-e-a-forma-que-mente.md).
 *
 * O sítio é `{sla && <SlaBadge …/>}` (WhatsappInbox:110). A página já separa erro de vazio
 * para as CONVERSAS — e não para o SLA: `const { data: slaRows = [] } = useWhatsappSla()`.
 * O default `= []` no binding é que converte a falha em vazio, e o `Map` vazio faz o badge
 * sumir de TODAS as linhas. A lista continua na tela, completa e sem nenhum aviso amarelo:
 * a leitura mais natural é "ninguém está estourando SLA" — sobre um relógio de 15/30 min.
 *
 * CORREÇÃO AO INVENTÁRIO: `useWhatsappSla` **não** engole o erro — `fetchWhatsappSla` faz
 * `if (res.error) throw new Error(res.error.message)`. O conserto é só na UI; medido ao ler
 * o hook, não pelo que o inventário registrou.
 *
 * Os hooks rodam de verdade; só o supabase é mockado, roteado por view para que a falha do
 * SLA não seja confundida com um apagão que qualquer asserção pegaria.
 */

type Resposta = { data: unknown; error: { message: string } | null };

const CONVERSAS = [
  { id: 'c1', phone_e164: '+5547999990000', contact_name: 'Marcenaria Alfa', status: 'aberta', customer_user_id: 'u1', last_message_at: '2026-09-06T12:00:00Z' },
  { id: 'c2', phone_e164: '+5547988880000', contact_name: 'Marcenaria Beta', status: 'aberta', customer_user_id: null, last_message_at: '2026-09-06T11:00:00Z' },
];
const SLA_VERMELHO = [
  { conversation_id: 'c1', customer_user_id: 'u1', phone_e164: '+5547999990000', contact_name: 'Marcenaria Alfa', owner_user_id: 'v1', aguardando_desde: '2026-09-06T11:00:00Z', minutos_uteis_aguardando: 42, nivel: 'vermelho' },
];

let respostaSla: Resposta = { data: [], error: null };

function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'eq', 'in', 'lt', 'gte']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta()).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) =>
      builder(() =>
        t === 'v_whatsapp_sla' ? respostaSla : { data: t === 'whatsapp_conversations' ? CONVERSAS : [], error: null },
      ),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
  },
}));

import WhatsappInbox from '../WhatsappInbox';

function renderInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <WhatsappInbox />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => { respostaSla = { data: [], error: null }; });
afterEach(() => { onlineManager.setOnline(true); vi.restoreAllMocks(); });

describe('WhatsappInbox — o SLA que não pôde ser lido não vira "ninguém esperando"', () => {
  it('ERRO no SLA: a tela FALA, e as conversas continuam na lista', async () => {
    respostaSla = { data: null, error: { message: 'timeout' } };
    renderInbox();

    // As conversas foram lidas — apagar a lista por causa do SLA trocaria um defeito por outro.
    expect(await screen.findByText('Marcenaria Alfa')).toBeTruthy();
    expect(await screen.findByTestId('aviso-sla-whatsapp')).toBeTruthy();
  });

  it('ERRO no SLA: o aviso desfaz a leitura errada, não só sinaliza um erro', async () => {
    respostaSla = { data: null, error: { message: 'timeout' } };
    const { container } = renderInbox();

    await screen.findByTestId('aviso-sla-whatsapp');
    expect(container.textContent).toMatch(/não quer dizer que está tudo certo/i);
  });

  it('SLA lido e vazio: nada de aviso — ninguém esperando é verdade', async () => {
    respostaSla = { data: [], error: null };
    renderInbox();

    await screen.findByText('Marcenaria Alfa');
    await waitFor(() => expect(screen.queryByTestId('aviso-sla-whatsapp')).toBeNull());
  });

  it('SLA com linha: o badge aparece e não há aviso', async () => {
    respostaSla = { data: SLA_VERMELHO, error: null };
    renderInbox();

    expect(await screen.findByText(/esperando há/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-sla-whatsapp')).toBeNull();
  });

  it('OFFLINE: diz que falta rede em vez de mostrar a lista sem badge', async () => {
    onlineManager.setOnline(false);
    respostaSla = { data: SLA_VERMELHO, error: null };
    renderInbox();

    const aviso = await screen.findByTestId('aviso-sla-whatsapp');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
  });
});
