import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

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
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MixGapCard />
      </QueryClientProvider>,
    ),
  };
}

/** TODOS os `carteira.mixgap_visto`, na ordem — a ORDEM separa transição de re-emissão. */
function eventosVistos(): Record<string, unknown>[] {
  return track.mock.calls
    .filter((c) => c[0] === 'carteira.mixgap_visto')
    .map((c) => c[1] as Record<string, unknown>);
}

/** O PRIMEIRO evento de `carteira.mixgap_visto`, ou undefined se ele nunca saiu. */
function eventoVisto(): Record<string, unknown> | undefined {
  return eventosVistos()[0];
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

/**
 * QUARTO estado — OFFLINE (revisão adversária retroativa do #1859, duas análises independentes).
 *
 * Com `networkMode:'online'` (default do QueryClient global, sem `persistQueryClient` no repo) e o
 * navegador offline, a query fica `status:'pending'` / `fetchStatus:'paused'` / `data:undefined` /
 * `error:null`. Em v5 `isLoading = isPending && isFetching` — pausada NÃO está fetching, logo
 * `isLoading` é **false**. O predicado `!isLoading && !error && data === undefined` casava, e o card
 * devolvia `null`: tela em branco e silêncio no PostHog, exatamente a classe que o #1859 corrigiu —
 * agora pelo balde "não é staff". Num PWA de vendedor em campo isso não é hipotético.
 *
 * `data === null` só quer dizer "não é staff" DEPOIS de a query RESOLVER; `undefined` é pendente,
 * pausado ou desabilitado — três coisas diferentes que o predicado antigo fundia numa só.
 */

afterEach(() => {
  // `onlineManager` é estado GLOBAL do react-query: deixar offline vazaria para os outros arquivos.
  onlineManager.setOnline(true);
  // E o `spyOn(supabase)` do teste de CARREGANDO sobrevive ao teste que o criou: sem restaurar,
  // os casos seguintes recebem a promise DAQUELE teste (já resolvida com sucesso) e ficam verdes
  // sem nunca exercitar o ramo de erro — um mock vazado é gate que mente.
  vi.restoreAllMocks();
});

describe('MixGapCard — offline é um estado, não ausência de acesso', () => {
  it('OFFLINE sem cache: fica na tela dizendo que falta REDE — não some', async () => {
    onlineManager.setOnline(false);
    resposta = { data: COM_GAP, error: null }; // a RPC responderia; é a rede que não deixa sair
    const { container } = renderCard();

    expect(await screen.findByText(/sem conexão/i)).toBeTruthy();
    expect(container.textContent).not.toBe('');
    // A tela do erro de LEITURA é outra: confundir as duas manda o vendedor avisar o suporte
    // por um problema que é do celular dele.
    expect(screen.queryByText(/Não consegui carregar as oportunidades/i)).toBeNull();
  });

  it('OFFLINE emite evento PRÓPRIO com total null — nem silêncio, nem 0, nem "erro"', async () => {
    onlineManager.setOnline(false);
    resposta = { data: COM_GAP, error: null };
    renderCard();

    await waitFor(() => expect(eventoVisto()).toBeTruthy());
    const ev = eventoVisto()!;
    expect(ev.estado).toBe('aguardando_rede');
    // §2 (ausente ≠ zero): não há número honesto a mandar quando a request nem saiu.
    expect(ev.total_com_gap).toBeNull();
    expect(ev.total_com_gap).not.toBe(0);
    // Distinguível NA SÉRIE — é o que impede a contaminação do denominador de adoção, que se
    // calcula sobre os estados com número honesto (`com_gap`/`zero`).
    expect(ev.estado).not.toBe('erro');
    expect(ev.estado).not.toBe('zero');
    expect(ev.estado).not.toBe('com_gap');
  });

  it('OFFLINE e SEM ACESSO são desfechos DIFERENTES — o defeito os fundia', async () => {
    resposta = { data: null, error: null };
    const semAcesso = renderCard();
    await waitFor(() => expect(semAcesso.container.textContent).toBe(''));
    expect(eventosVistos()).toHaveLength(0);
    semAcesso.unmount();
    track.mockClear();

    onlineManager.setOnline(false);
    resposta = { data: COM_GAP, error: null };
    const offline = renderCard();
    await screen.findByText(/sem conexão/i);
    expect(offline.container.textContent).not.toBe('');
    await waitFor(() => expect(eventosVistos()).toHaveLength(1));
  });

  it('erro E DEPOIS queda de rede: a tela passa a falar de conexão, não de suporte', async () => {
    resposta = { data: null, error: { message: 'timeout' } };
    const { qc } = renderCard();
    await screen.findByText(/Não consegui carregar as oportunidades/i);

    onlineManager.setOnline(false);
    await act(async () => { void qc.invalidateQueries({ queryKey: ['my-mixgap'] }); });

    // Sem dado no cache quem troca o estado é o próprio react-query: `fetchState` zera
    // `error`/`status` ao (re)iniciar o fetch quando `data === undefined`. O que este caso fixa é
    // o COMPORTAMENTO — mandar o vendedor "avisar o suporte" quando o problema é o sinal do
    // celular dele queima o canal de incidente. A precedência de verdade se decide COM dado no
    // cache, no caso abaixo.
    expect(await screen.findByText(/sem conexão/i)).toBeTruthy();
    expect(screen.queryByText(/avise o suporte/i)).toBeNull();
    await waitFor(() =>
      expect(eventosVistos().map((e) => e.estado)).toEqual(['erro', 'aguardando_rede']),
    );
  });

  it('quando a rede VOLTA, o estado real sai DEPOIS do aguardando_rede, nesta ordem', async () => {
    onlineManager.setOnline(false);
    resposta = { data: COM_GAP, error: null };
    renderCard();
    await waitFor(() => expect(eventosVistos()).toHaveLength(1));

    await act(async () => { onlineManager.setOnline(true); });

    expect(await screen.findByText('Marcenaria Alfa')).toBeTruthy();
    await waitFor(() => expect(eventosVistos()).toHaveLength(2));
    expect(eventosVistos().map((e) => e.estado)).toEqual(['aguardando_rede', 'com_gap']);
    expect(eventosVistos()[1].total_com_gap).toBe(2);
  });
});

/**
 * O erro tinha precedência sobre o dado STALE, e isso custava a lista inteira: com `com_gap` já na
 * tela, um refetch que falha levava a `erro` e as oportunidades sumiam, embora o cache ainda as
 * tivesse. Honesto para o sensor, regressão para quem está na rua. O desenho que serve aos dois é
 * composto — lista PRESERVADA + aviso de que o número está velho — com o evento marcando o motivo,
 * senão "vi a carteira fresca" e "agi sobre número velho" viram a mesma linha na série.
 */
describe('MixGapCard — dado bom no cache sobrevive à atualização que falha', () => {
  it('refetch que FALHA não apaga a lista já na tela — avisa que está desatualizada', async () => {
    resposta = { data: COM_GAP, error: null };
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Alfa');

    resposta = { data: null, error: { message: 'timeout' } };
    await act(async () => { await qc.refetchQueries({ queryKey: ['my-mixgap'] }).catch(() => {}); });

    // A lista não pode nem PISCAR para fora: já está na tela no repaint seguinte à falha...
    expect(screen.getByText('Marcenaria Alfa')).toBeTruthy();
    // ...e continua depois que o aviso de desatualização entra (o re-render do erro é assíncrono).
    expect(await screen.findByText(/desatualizada/i)).toBeTruthy();
    expect(screen.getByText('Marcenaria Alfa')).toBeTruthy();
    // A tela de erro TOTAL (a que troca a lista por um aviso) não deve aparecer aqui.
    expect(screen.queryByText(/Não consegui carregar as oportunidades/i)).toBeNull();
  });

  it('o evento separa o número FRESCO do número desatualizado', async () => {
    resposta = { data: COM_GAP, error: null };
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Alfa');
    await waitFor(() => expect(eventosVistos()).toHaveLength(1));
    expect(eventosVistos()[0]).toMatchObject({ estado: 'com_gap', total_com_gap: 2, desatualizado: null });

    resposta = { data: null, error: { message: 'timeout' } };
    await act(async () => { await qc.refetchQueries({ queryKey: ['my-mixgap'] }).catch(() => {}); });

    await waitFor(() => expect(eventosVistos()).toHaveLength(2));
    // Mesmo estado visível, motivo novo: a dedup por estado PURO engoliria esta transição, que é
    // justamente o sinal de leitura falhando em campo.
    expect(eventosVistos()[1]).toMatchObject({ estado: 'com_gap', total_com_gap: 2, desatualizado: 'erro' });
  });

  it('com a LISTA no cache, erro e queda de rede COEXISTEM — vence o motivo ATUAL', async () => {
    resposta = { data: COM_GAP, error: null };
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Alfa');

    // 1) refetch falha com o dado ainda no cache: aqui o `error` é PRESERVADO (`fetchState` só
    //    zera `error`/`status` quando `data === undefined`).
    resposta = { data: null, error: { message: 'timeout' } };
    await act(async () => { await qc.refetchQueries({ queryKey: ['my-mixgap'] }).catch(() => {}); });
    await waitFor(() => expect(eventosVistos()).toHaveLength(2));
    expect(eventosVistos()[1]).toMatchObject({ desatualizado: 'erro' });

    // 2) agora a rede cai: `status:'error'` e `fetchStatus:'paused'` ao MESMO tempo — o único
    //    ponto do card em que a precedência decide algo. "Recarregue a página" seria conselho
    //    inútil para quem está sem sinal.
    onlineManager.setOnline(false);
    await act(async () => { void qc.invalidateQueries({ queryKey: ['my-mixgap'] }); });

    await waitFor(() => expect(eventosVistos()).toHaveLength(3));
    expect(eventosVistos()[2]).toMatchObject({ estado: 'com_gap', desatualizado: 'sem_rede' });
    expect(screen.getByText('Marcenaria Alfa')).toBeTruthy();
  });

  it('OFFLINE com dado no cache: mantém a lista e marca o motivo como falta de REDE', async () => {
    resposta = { data: COM_GAP, error: null };
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Alfa');

    onlineManager.setOnline(false);
    await act(async () => { void qc.invalidateQueries({ queryKey: ['my-mixgap'] }); });

    expect(screen.getByText('Marcenaria Alfa')).toBeTruthy();
    await waitFor(() => expect(eventosVistos()).toHaveLength(2));
    expect(eventosVistos()[1]).toMatchObject({ estado: 'com_gap', desatualizado: 'sem_rede' });
  });
});

/**
 * FRONTEIRA DE TELEMETRIA — o alfabeto do evento é CONGELADO aqui, e de propósito.
 *
 * O card fala DUAS línguas que se parecem o bastante para serem trocadas sem ninguém ver:
 *
 *   `estadoDeLeitura` (@/lib/leitura/estado-de-leitura) devolve `'sem-rede'` — com HÍFEN;
 *   o evento `carteira.mixgap_visto` emite `'sem_rede'`/`'aguardando_rede'` — com UNDERSCORE.
 *
 * Enquanto o card derivava a máquina de estados à mão os dois nunca se encontravam. Desde o
 * #1904 ele CONSOME o helper, e os dois passaram a ficar a um `?:` de distância. O #1904 fez a
 * tradução certa (`MOTIVO_NA_SERIE`, com `satisfies`), mas o `satisfies` protege o mapa — não
 * protege quem decidir mandar o estado do helper adiante por FORA dele. E esse desvio não
 * quebra nada que o compilador veja: `track(event, properties?: Record<string, unknown>)` não
 * tipa o payload, então o `tsc` fica verde e a tela continua idêntica. O que quebra é a
 * SÉRIE — os eventos passariam a sair sob um literal novo e a continuidade morreria no meio.
 *
 * E aqui não há volume que conserte: são 3 vendedores em `commercial_roles`. Uma série que
 * reinicia não se recupera pela lei dos grandes números — é a mesma poluição de denominador
 * que o #1859 existe para impedir (`docs/historico/fase-sem-sinal.md`).
 *
 * Por isso a asserção é sobre o LITERAL, não sobre o comportamento: o comportamento
 * sobreviveria à troca. A regra mecânica — nenhum valor do payload contém hífen — pega
 * qualquer vazamento do vocabulário do helper, inclusive um que ainda não existe.
 */
describe('MixGapCard — o alfabeto do evento não muda por refactor', () => {
  const ESTADOS = ['com_gap', 'zero', 'erro', 'aguardando_rede'];
  const MOTIVOS = ['erro', 'sem_rede'];

  /** O literal do helper vaza com HÍFEN; o do evento é sempre underscore. */
  function conferirAlfabeto(ev: Record<string, unknown>) {
    expect(ESTADOS, `estado fora do alfabeto congelado: ${String(ev.estado)}`)
      .toContain(ev.estado);
    if (ev.desatualizado !== null && ev.desatualizado !== undefined) {
      expect(MOTIVOS, `motivo fora do alfabeto congelado: ${String(ev.desatualizado)}`)
        .toContain(ev.desatualizado);
    }
    // Rede de segurança genérica, e ela varre o payload INTEIRO — não as duas chaves que
    // hoje conhecemos. É o único assert aqui que pega o vazamento que ninguém fixou, e isso
    // foi MEDIDO contra o card do #1904: acrescentar `leitura` ao payload (o estado do helper,
    // `'sem-rede'` quando offline) deixa os 15 testes originais VERDES — eles usam
    // `toMatchObject`, que ignora chave extra. O vocabulário do helper é hifenizado e o do
    // evento nunca é; a regra mecânica vale inclusive para o literal que ainda não existe.
    for (const [chave, v] of Object.entries(ev)) {
      if (typeof v === 'string') {
        expect(v, `\`${chave}\` veio hifenizado (\`${v}\`) — é o vocabulário de ` +
          '`estadoDeLeitura` vazando para o PostHog: a tela continua certa e a série QUEBRA')
          .not.toMatch(/-/);
      }
    }
  }

  it('OFFLINE sem cache: o estado é `aguardando_rede`, nunca o `sem-rede` do helper', async () => {
    onlineManager.setOnline(false);
    resposta = { data: COM_GAP, error: null };
    renderCard();

    await waitFor(() => expect(eventoVisto()).toBeTruthy());
    const ev = eventoVisto()!;
    expect(ev.estado).toBe('aguardando_rede');
    expect(ev.estado).not.toBe('sem-rede');
    conferirAlfabeto(ev);
  });

  it('OFFLINE com cache: o motivo é `sem_rede`, nunca o `sem-rede` do helper', async () => {
    resposta = { data: COM_GAP, error: null };
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Alfa');

    onlineManager.setOnline(false);
    await act(async () => { void qc.invalidateQueries({ queryKey: ['my-mixgap'] }); });

    await waitFor(() => expect(eventosVistos()).toHaveLength(2));
    const ev = eventosVistos()[1];
    expect(ev.desatualizado).toBe('sem_rede');
    expect(ev.desatualizado).not.toBe('sem-rede');
    conferirAlfabeto(ev);
  });

  it('a máquina INTEIRA percorrida: todo evento sai no alfabeto congelado', async () => {
    // fresco → refetch que falha (desatualizado:'erro') → rede cai (desatualizado:'sem_rede').
    resposta = { data: COM_GAP, error: null };
    const { qc } = renderCard();
    await screen.findByText('Marcenaria Alfa');

    resposta = { data: null, error: { message: 'timeout' } };
    await act(async () => { await qc.refetchQueries({ queryKey: ['my-mixgap'] }).catch(() => {}); });
    await waitFor(() => expect(eventosVistos()).toHaveLength(2));

    onlineManager.setOnline(false);
    await act(async () => { void qc.invalidateQueries({ queryKey: ['my-mixgap'] }); });
    await waitFor(() => expect(eventosVistos()).toHaveLength(3));

    // Controle POSITIVO: sem isto o `forEach` abaixo passaria de graça numa lista vazia —
    // "nenhum evento fora do alfabeto" é verdade trivial quando não houve evento nenhum.
    const vistos = eventosVistos();
    expect(vistos.length, 'a fixture parou de produzir eventos — o sweep viraria teatro')
      .toBeGreaterThanOrEqual(3);
    expect(vistos.map((e) => e.desatualizado)).toEqual([null, 'erro', 'sem_rede']);
    vistos.forEach(conferirAlfabeto);
  });
});
