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

  it('ausência de ACESSO não emite — é a única ausência de evento legítima', async () => {
    // `get_carteira_saude` devolve NULL sem role (conferido em prod). Contar isso como
    // "visto" encheria o denominador de adoção de quem nunca poderia ver a tela.
    resposta = { data: null, error: null };
    const { container } = renderPainel();
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(evento(), 'sem acesso emitiu evento — o denominador foi poluído').toBeUndefined();
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

/**
 * FRONTEIRA DE TELEMETRIA — o alfabeto do evento é CONGELADO aqui, e de propósito.
 *
 * Este painel adotou `estadoDeLeitura` e mandou o retorno CRU para dentro do `track()`:
 * `track('carteira.saude_vista', { estado, nivel })`. O helper devolve `'sem-rede'` — com HÍFEN —
 * e a série `carteira.*` fala `sem_rede`, que o `carteira.mixgap_visto` já emitia 27 MINUTOS
 * antes desse commit. Nada disso é visível: a tela fica idêntica e o `tsc` ficava verde porque
 * `track(event, properties?: Record<string, unknown>)` não tipava o payload. O que quebra é a
 * SÉRIE — um breakdown por `estado = sem_rede` passou a enxergar 1 dos 3 eventos da carteira.
 *
 * E aqui não há volume que conserte: são 3 vendedores em `commercial_roles`. Série que reinicia
 * não se recupera pela lei dos grandes números (`docs/historico/fase-sem-sinal.md`).
 *
 * A asserção é sobre o LITERAL e não sobre o comportamento — o comportamento sobreviveria à
 * troca. A regra mecânica varre o payload INTEIRO e pega o vazamento de uma chave que ainda não
 * existe: `toMatchObject`, usado pelos testes acima, ignora chave EXTRA.
 */
describe('CarteiraSaudePanel — o alfabeto do evento não muda por refactor', () => {
  const ESTADOS = ['pronta', 'erro', 'sem_rede'];

  function conferirAlfabeto(ev: Record<string, unknown>) {
    expect(ESTADOS, `estado fora do alfabeto congelado: ${String(ev.estado)}`).toContain(ev.estado);
    for (const [chave, v] of Object.entries(ev)) {
      if (typeof v === 'string') {
        expect(v, `\`${chave}\` veio hifenizado (\`${v}\`) — é o vocabulário de ` +
          '`estadoDeLeitura` vazando para o PostHog: a tela continua certa e a série QUEBRA')
          .not.toMatch(/-/);
      }
    }
  }

  it('OFFLINE: o evento diz `sem_rede`, nunca o `sem-rede` do helper', async () => {
    onlineManager.setOnline(false);
    resposta = { data: RESUMO, error: null };

    renderPainel();

    await waitFor(() => expect(evento()).toBeTruthy());
    const ev = evento()!;
    expect(ev.estado, 'o literal do helper escorreu para a série').toBe('sem_rede');
    conferirAlfabeto(ev);
  });

  it('ERRO e leitura OK também saem sob o alfabeto da série', async () => {
    resposta = { data: null, error: { message: 'timeout' } };
    const { unmount } = renderPainel();
    await waitFor(() => expect(evento()).toBeTruthy());
    expect(evento()!.estado).toBe('erro');
    conferirAlfabeto(evento()!);
    unmount();

    track.mockClear();
    resposta = { data: RESUMO, error: null };
    renderPainel();
    await waitFor(() => expect(evento()).toBeTruthy());
    expect(evento()!.estado).toBe('pronta');
    conferirAlfabeto(evento()!);
  });
});
