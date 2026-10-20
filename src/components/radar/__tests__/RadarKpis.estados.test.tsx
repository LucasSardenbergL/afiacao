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

/**
 * Builder FALSO do PostgREST para as duas leituras novas do placar: `radar_ingest_state` (lote
 * vigente) e o count `head:true` de inéditos em `radar_empresas`. Grava a cadeia por tabela e
 * resolve com a resposta configurada — a forma da query é o que se prova, não o banco.
 */
type RespostaTabela = { data: unknown; count?: number | null; error: { message: string } | null };
let respostasTabela: Record<string, RespostaTabela> = {};
const chamadas: Record<string, unknown[][]> = {};
function builder(tabela: string) {
  chamadas[tabela] = chamadas[tabela] ?? [];
  const cadeia: unknown[][] = [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit', 'is', 'or', 'filter', 'not']) {
    b[m] = (...args: unknown[]) => { chamadas[tabela].push([m, ...args]); cadeia.push([m, ...args]); return b; };
  }
  // `radar_empresas` recebe DUAS leituras (count de inéditos e count de sugeridos): a resposta é
  // escolhida pela FORMA da cadeia, para cada card ter o seu dado.
  // Decidido NO `then` (a cadeia só existe depois que o hook encadeou) — na criação ela é vazia e
  // todo count cairia na resposta de inéditos.
  const tem = (c: unknown[]) => cadeia.some((x) => JSON.stringify(x) === JSON.stringify(c));
  b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
    const chave = tem(['eq', 'prospeccao_status', 'em_conversa']) ? `${tabela}:sugeridos` : tabela;
    return Promise.resolve(respostasTabela[chave] ?? respostasTabela[tabela] ?? { data: null, error: { message: `sem resposta p/ ${chave}` } }).then(res, rej);
  };
  return b;
}
const LOTE_VIGENTE = {
  mes_referencia: '2026-08', status: 'complete', total_recebido: 501380, novos: 27466, iniciado_em: '2026-10-19T16:31:08.593+00:00',
};
const LOTE_RODANDO = { mes_referencia: '2026-10', status: 'running', total_recebido: 0, novos: null, iniciado_em: '2026-11-02T03:00:00+00:00' };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: () => Promise.resolve(resposta), from: (t: string) => builder(t) },
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
const onSoIneditos = vi.fn();
const onSoSugeridos = vi.fn();
function renderKpis(props: { soIneditos?: boolean; soSugeridos?: boolean } = {}) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <RadarKpis
        soIneditos={props.soIneditos ?? false}
        onSoIneditos={onSoIneditos}
        soSugeridos={props.soSugeridos ?? false}
        onSoSugeridos={onSoSugeridos}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  onlineManager.setOnline(true);
  auth = { isMaster: true, isGestorComercial: false };
  track.mockClear();
  onSoIneditos.mockClear();
  onSoSugeridos.mockClear();
  for (const k of Object.keys(chamadas)) delete chamadas[k];
  respostasTabela = {
    radar_ingest_state: { data: [LOTE_RODANDO, LOTE_VIGENTE], error: null },
    radar_empresas: { data: null, count: 27466, error: null },
    'radar_empresas:sugeridos': { data: null, count: 12, error: null },
    // ledger: a última rodada `sucesso` do score cobriu o lote vigente
    acoes_execucoes: { data: [{ detalhes: { lote_vigente: '2026-08' } }], error: null },
  };
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

  /**
   * Kebab-case de VOCABULÁRIO — e não "qualquer hífen". A varredura larga (`/-/`) reprovava
   * `mes: '2026-08-01'`: data ISO tem hífen e não é vocabulário nenhum. Falso-positivo em guard
   * é caro — é o que treina todo mundo a afrouxar o guard. A âncora em LETRA é o que exclui a
   * data; `sem-rede`, `sales-order` e `painel-carteira` seguem sendo pegos.
   */
  const KEBAB_VOCABULARIO = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

  function conferirAlfabeto(ev: Record<string, unknown>) {
    expect(ESTADOS, `estado fora do alfabeto congelado: ${String(ev.estado)}`).toContain(ev.estado);
    for (const [chave, valor] of Object.entries(ev)) {
      if (typeof valor === 'string') {
        expect(
          valor,
          `valor em kebab-case em '${chave}' — o vocabulário do helper vazou para a série`,
        ).not.toMatch(KEBAB_VOCABULARIO);
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

/**
 * Card "Inéditos do lote YYYY-MM: N de T" — N = count de `primeira_vista_em >= iniciado_em` E
 * `ultimo_lote = vigente` (o MESMO predicado do selo da linha), T = `total_recebido` do lote.
 * Medido em prod 2026-10-19: 27.466 de 501.380 no lote 2026-08.
 *
 * Ausente ≠ zero: sem lote `complete` o card diz "sem dado"; count que falhou vira aviso.
 * Um `0` fabricado aqui diria ao gestor "nenhuma empresa nova este mês" — a mentira que o
 * placar existe para não contar.
 */
describe('RadarKpis — card "Inéditos do lote"', () => {
  it('com lote vigente: "N de T" com o lote no rótulo, e o count tem o predicado do selo', async () => {
    resposta = { data: kpis(), error: null };
    renderKpis();
    expect(await screen.findByText(/27\.466/)).toBeTruthy();
    // "de 501.380" também aparece no card de sugeridos (bloco 5) — escopo no card de inéditos.
    expect(screen.getByTestId('radar-kpi-ineditos').textContent).toMatch(/de 501\.380/);
    expect(screen.getByText(/Inéditos do lote 2026-08/)).toBeTruthy();
    const c = chamadas.radar_empresas;
    expect(c).toContainEqual(['eq', 'ultimo_lote', '2026-08']);
    expect(c).toContainEqual(['gte', 'primeira_vista_em', LOTE_VIGENTE.iniciado_em]);
    expect(c.find((x) => x[0] === 'select')?.[2], 'count precisa ser exact + head (PostgREST capa em 1.000 linhas)').toMatchObject({ count: 'exact', head: true });
  });

  it('SEM lote complete (só running): card em "sem dado" — nunca 0', async () => {
    respostasTabela.radar_ingest_state = { data: [LOTE_RODANDO], error: null };
    resposta = { data: kpis(), error: null };
    renderKpis();
    const card = await screen.findByTestId('radar-kpi-ineditos');
    await waitFor(() => expect(card.textContent).toMatch(/sem lote/i));
    expect(card.textContent, 'ausente virou zero').not.toMatch(/\b0\b/);
    expect(chamadas.radar_empresas ?? [], 'contou inéditos sem saber o lote').toEqual([]);
  });

  it('count de inéditos FALHOU: aviso no card, não 0', async () => {
    respostasTabela.radar_empresas = { data: null, count: null, error: { message: 'boom' } };
    resposta = { data: kpis(), error: null };
    renderKpis();
    const card = await screen.findByTestId('radar-kpi-ineditos');
    await waitFor(() => expect(card.textContent).toMatch(/não consegui/i));
    expect(card.textContent).not.toMatch(/\b0 de/);
  });

  it('1 clique no card liga o filtro "só inéditos" e emite o sensor com denominador', async () => {
    resposta = { data: kpis(), error: null };
    renderKpis();
    // O gestor vê o número e DEPOIS clica: é o clique com N em mãos que prova o denominador no
    // sensor. Clicar antes do count resolver leva `ineditos: null` (ausente, não 0) — correto, mas
    // não é o que este teste mede.
    await screen.findByText(/27\.466/);
    const botao = screen.getByRole('button', { name: /só inéditos/i });
    botao.click();
    expect(onSoIneditos).toHaveBeenCalledWith(true);
    const ev = track.mock.calls.find(([n]) => n === 'radar.ineditos_filtro') as [string, Record<string, unknown>] | undefined;
    expect(ev, 'sensor radar.ineditos_filtro não emitiu').toBeTruthy();
    expect(ev?.[1]).toMatchObject({ ativo: true, ineditos: 27466, total: 501380 });
  });

  it('com o filtro ligado, o clique DESLIGA (toggle) e o sensor diz ativo=false', async () => {
    resposta = { data: kpis(), error: null };
    renderKpis({ soIneditos: true });
    await screen.findByText(/27\.466/);
    const botao = screen.getByRole('button', { name: /só inéditos/i });
    botao.click();
    expect(onSoIneditos).toHaveBeenCalledWith(false);
    const ev = track.mock.calls.find(([n]) => n === 'radar.ineditos_filtro') as [string, Record<string, unknown>] | undefined;
    expect(ev?.[1]).toMatchObject({ ativo: false });
  });
});

describe('RadarKpis — card "Sugeridos para cadastro" (bloco 5)', () => {
  const sugeridos = () => chamadas.radar_empresas.filter((c) => c[0] === 'eq' && c[1] === 'prospeccao_status' && c[2] === 'em_conversa');

  it('com lote e score calculado: "N de T", e o count tem o predicado inteiro do helper puro', async () => {
    resposta = { data: kpis(), error: null };
    renderKpis();
    const card = await screen.findByTestId('radar-kpi-sugeridos');
    await waitFor(() => expect(card.textContent).toMatch(/\b12\b/));
    expect(card.textContent).toMatch(/de 501\.380/);
    expect(sugeridos()).toHaveLength(1);
    const c = chamadas.radar_empresas;
    for (const esperado of [
      ['eq', 'ultimo_lote', '2026-08'], ['eq', 'ja_cliente', false], ['is', 'omie_codigo_cliente', null],
      ['or', 'rfb_situacao.is.null,rfb_situacao.eq.02'], ['filter', 'cnpj', 'match', '^[0-9]{14}$'], ['gte', 'score', 70],
    ]) expect(c, `faltou ${JSON.stringify(esperado)}`).toContainEqual(esperado);
  });

  it('score calculado e NENHUM sugerido: mostra "0 de T" — zero legítimo', async () => {
    respostasTabela['radar_empresas:sugeridos'] = { data: null, count: 0, error: null };
    resposta = { data: kpis(), error: null };
    renderKpis();
    const card = await screen.findByTestId('radar-kpi-sugeridos');
    await waitFor(() => expect(card.textContent).toMatch(/\b0 de 501\.380/));
  });

  it('rodada de score ainda não cobriu o lote vigente (ledger na foto anterior): "sem score" — nunca 0', async () => {
    respostasTabela.acoes_execucoes = { data: [{ detalhes: { lote_vigente: '2026-05' } }], error: null };
    respostasTabela['radar_empresas:sugeridos'] = { data: null, count: 0, error: null };
    resposta = { data: kpis(), error: null };
    renderKpis();
    const card = await screen.findByTestId('radar-kpi-sugeridos');
    await waitFor(() => expect(card.textContent).toMatch(/sem score/i));
    expect(card.textContent, 'ausente virou zero').not.toMatch(/\b0\b/);
    expect(screen.queryByRole('button', { name: /só sugeridos/i }), 'filtro sem efeito ofertado').toBeNull();
  });

  it('SEM lote complete: "sem lote", sem count', async () => {
    respostasTabela.radar_ingest_state = { data: [LOTE_RODANDO], error: null };
    resposta = { data: kpis(), error: null };
    renderKpis();
    const card = await screen.findByTestId('radar-kpi-sugeridos');
    await waitFor(() => expect(card.textContent).toMatch(/sem lote/i));
    expect(card.textContent).not.toMatch(/\b0\b/);
    expect(sugeridos()).toHaveLength(0);
  });

  it('count FALHOU: "não consegui", não 0', async () => {
    respostasTabela['radar_empresas:sugeridos'] = { data: null, count: null, error: { message: 'boom' } };
    resposta = { data: kpis(), error: null };
    renderKpis();
    const card = await screen.findByTestId('radar-kpi-sugeridos');
    await waitFor(() => expect(card.textContent).toMatch(/não consegui/i));
    expect(card.textContent).not.toMatch(/\b0 de/);
  });

  it('1 clique liga "só sugeridos" e o sensor leva N, T e o limiar', async () => {
    resposta = { data: kpis(), error: null };
    renderKpis();
    const card = await screen.findByTestId('radar-kpi-sugeridos');
    await waitFor(() => expect(card.textContent).toMatch(/\b12\b/));
    screen.getByRole('button', { name: /só sugeridos/i }).click();
    expect(onSoSugeridos).toHaveBeenCalledWith(true);
    const ev = track.mock.calls.find(([n]) => n === 'radar.sugeridos_filtro') as [string, Record<string, unknown>] | undefined;
    expect(ev, 'sensor radar.sugeridos_filtro não emitiu').toBeTruthy();
    expect(ev?.[1]).toMatchObject({ ativo: true, origem: 'card', sugeridos: 12, total: 501380, limiar: 70, lote: '2026-08' });
  });
});
