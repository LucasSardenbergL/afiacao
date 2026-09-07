import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

/**
 * Guard da classe "erro colapsado em vazio" no placar do Radar.
 *
 * Fazia `const { data, isLoading } = useRadarKpis(); if (!data) return null`. O hook LANÇA
 * quando a RPC `radar_kpis` falha ⇒ `data` fica `undefined` no erro, no offline e na 1ª
 * carga: os três colapsavam no mesmo sumiço, e o resumo de 526.176 empresas (523.180
 * `a_contatar` — psql-ro, 2026-08-23) desaparecia sem rastro com a lista ainda na tela.
 *
 * O HOOK roda de verdade; só o supabase e o auth são mockados. Mockar `useRadarKpis`
 * provaria apenas que o card renderiza um estado que eu mesmo montei — e o defeito mora
 * exatamente na tradução "RPC falhou" → "data undefined" → "tela idêntica à do lote vazio".
 */
type Resposta = { data: unknown; error: { message: string } | null };
let resposta: Resposta = { data: null, error: null };
let auth = { isMaster: true, isGestorComercial: false };
const track = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: () => Promise.resolve(resposta) },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { RadarKpis } from '../RadarKpis';

const kpis = (over: Record<string, unknown> = {}) => ({
  lote: '2026-05', novos: 526176, a_contatar: 523180, em_conversa: 1, virou_cliente_mes: 0, ...over,
});

/** A frase do aviso — o que separa "não consegui" de "não há nada no lote". */
const AVISO = /não quer dizer que está tudo certo/i;
const A_CONTATAR = /523\.180/;

let qc: QueryClient;
function renderKpis() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <RadarKpis />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  onlineManager.setOnline(true);
  auth = { isMaster: true, isGestorComercial: false };
  track.mockClear();
});
afterEach(() => { onlineManager.setOnline(true); });

describe('RadarKpis — erro NÃO pode virar "lote vazio"', () => {
  it('leitura OK: os números do lote', async () => {
    resposta = { data: kpis(), error: null };
    renderKpis();
    expect(await screen.findByText(A_CONTATAR)).toBeTruthy();
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  it('ERRO de leitura: avisa, não some — este é o defeito da classe', async () => {
    resposta = { data: null, error: { message: 'forbidden: gestor/master only' } };
    renderKpis();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('OFFLINE (pending+paused): também avisa — isLoading é FALSE e data undefined', async () => {
    onlineManager.setOnline(false);
    resposta = { data: kpis(), error: null };
    renderKpis();
    expect(await screen.findByText(AVISO)).toBeTruthy();
  });

  it('refetch falha COM os KPIs no cache: os números FICAM e o aviso vem JUNTO', async () => {
    // O erro nº1 que o #1886 cometeu e corrigiu: sair pelo aviso ANTES de olhar o cache
    // apaga o conteúdo que o usuário já tinha. Estado COMPOSTO.
    resposta = { data: kpis(), error: null };
    renderKpis();
    expect(await screen.findByText(A_CONTATAR)).toBeTruthy();

    resposta = { data: null, error: { message: 'connection failure' } };
    await qc.refetchQueries();

    await waitFor(() => expect(screen.queryByText(AVISO)).toBeTruthy());
    expect(
      screen.queryByText(A_CONTATAR),
      'os KPIs sumiram quando o refetch falhou — o erro não pode ter precedência sobre o dado em mãos',
    ).toBeTruthy();
  });

  it('SEM ACESSO (staff não-gestor): não renderiza, não avisa e NÃO emite evento', async () => {
    // A RPC faz RAISE 'forbidden' para quem não é gestor/master, e /radar só exige
    // RequireStaff. Aviso aqui seria alarme fabricado; evento aqui poluiria o denominador
    // de adoção com quem nunca poderia ver a tela.
    auth = { isMaster: false, isGestorComercial: false };
    resposta = { data: kpis(), error: null };
    const { container } = renderKpis();
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByText(AVISO)).toBeNull();
    expect(track, 'evento emitido para quem não tem acesso — polui o denominador').not.toHaveBeenCalled();
  });

  it('telemetria: emite no erro e leva `null` — nunca 0 — no lugar do número', async () => {
    resposta = { data: null, error: { message: 'boom' } };
    renderKpis();
    await screen.findByText(AVISO);
    await waitFor(() => expect(track).toHaveBeenCalled());
    const [nome, props] = track.mock.calls.at(-1) as [string, { estado: string; a_contatar: number | null }];
    expect(nome).toBe('radar.kpis_vistos');
    expect(props.estado).toBe('erro');
    expect(props.a_contatar, 'falha de leitura virou 0 — a série somaria erro a "lote vazio"').toBeNull();
  });

  it('erro e lote-vazio NÃO produzem a mesma tela (o colapso, medido)', async () => {
    resposta = { data: kpis({ novos: 0, a_contatar: 0, em_conversa: 0, virou_cliente_mes: 0, lote: null }), error: null };
    const vazio = renderKpis();
    await waitFor(() => expect(vazio.container.textContent).toContain('A contatar'));
    const telaVazia = vazio.container.textContent;
    vazio.unmount();

    resposta = { data: null, error: { message: 'boom' } };
    const erro = renderKpis();
    await waitFor(() => expect(erro.container.textContent).not.toBe(''));
    expect(erro.container.textContent).not.toBe(telaVazia);
  });
});

/**
 * O alfabeto do evento não muda por refactor.
 *
 * `radar.kpis_vistos` sai com `estado` no vocabulário da SÉRIE (underscore) — não no do
 * helper, que é hifenizado. Deixar o literal do helper passar não quebra a tela e, antes do
 * gate de tipo em `track()`, não movia o `tsc`: quebrava a CONTINUIDADE da série, calada.
 *
 * A varredura é sobre o payload INTEIRO, e não `toMatchObject`: aquele ignora chave EXTRA,
 * que é justamente por onde um vazamento NOVO entra sem ninguém ver.
 */
describe('o alfabeto do evento não muda por refactor', () => {
  const ESTADOS = ['pronta', 'erro', 'sem_rede'];

  function conferirAlfabeto(ev: Record<string, unknown>) {
    expect(ESTADOS, `estado fora do alfabeto congelado: ${String(ev.estado)}`).toContain(ev.estado);
    for (const [chave, valor] of Object.entries(ev)) {
      if (typeof valor === 'string') {
        expect(
          valor,
          `valor hifenizado em '${chave}' — o vocabulário do helper vazou para a série`,
        ).not.toMatch(/-/);
      }
    }
  }

  it('offline emite `sem_rede` — nunca o `sem-rede` do helper', async () => {
    onlineManager.setOnline(false);
    resposta = { data: null, error: null };
    renderKpis();
    await waitFor(() => expect(track).toHaveBeenCalled());
    const [nome, props] = track.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(nome).toBe('radar.kpis_vistos');
    expect(props.estado).toBe('sem_rede');
    conferirAlfabeto(props);
  });

  it('no erro, o payload inteiro passa pela varredura', async () => {
    resposta = { data: null, error: { message: 'boom' } };
    renderKpis();
    await waitFor(() => expect(track).toHaveBeenCalled());
    const [, props] = track.mock.calls.at(-1) as [string, Record<string, unknown>];
    conferirAlfabeto(props);
  });
});
