import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AGORA_GOLDEN,
  FARMER_GOLDEN,
  canonico,
  criarRegistroStub,
  criarSupabaseStub,
  gerarUniversoGolden,
} from '@/test/universo-pedidos-golden';
import { chaveUniversoPedidos, lerUniversoPedidos } from '@/lib/farmer/universo-pedidos-query';

/**
 * GOLDEN do `useFarmerScoring` — plano v4, lote 16 (C4′): "mesmo dado ⇒ mesmo score".
 *
 * Os JSON em `src/test/golden/universo-pedidos/` foram gravados com o motor ANTES da troca da
 * leitura de `sales_orders` (sequencial e própria → compartilhada e paralela). Este teste exige
 * igualdade BIT-A-BIT de clientScores (health/priority e todos os componentes), agenda e resumo,
 * em três recortes: gestor (`cap_carteira_ler`, sem recorte), vendedor (recortado pela carteira
 * que a RLS de `carteira_assignments` devolve) e a lente "Ver como" (master olhando o farmer).
 * Regravar (`GRAVAR_GOLDEN=1`) só quando o CÁLCULO muda de propósito.
 */

const estado = vi.hoisted(() => ({
  supabase: null as null | { from: (t: string) => unknown; rpc: (n: string, a?: Record<string, unknown>) => unknown },
  auth: { user: { id: 'farmer-1' }, isMaster: false, isStaff: true },
  papel: { canViewManagerial: false, loading: false },
  lente: { effectiveUserId: 'farmer-1', isImpersonating: false },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => estado.supabase!.from(t),
    rpc: (n: string, a?: Record<string, unknown>) => estado.supabase!.rpc(n, a),
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => estado.auth }));
vi.mock('@/hooks/useCommercialRole', () => ({ useCommercialRole: () => estado.papel }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => estado.lente }));

import { useFarmerScoring } from '../useFarmerScoring';
import { useBundleEngine } from '../useBundleEngine';
import { FARMER_ALGORITHM_CONFIG_KEY } from '../useFarmerAlgorithmConfig';

const PASTA = resolve(process.cwd(), 'src/test/golden/universo-pedidos');

function conferirGolden(nome: string, saida: unknown) {
  const arquivo = resolve(PASTA, `${nome}.json`);
  const atual = canonico(saida);
  if (process.env.GRAVAR_GOLDEN === '1') {
    mkdirSync(dirname(arquivo), { recursive: true });
    writeFileSync(arquivo, `${JSON.stringify(atual, null, 1)}\n`);
    return;
  }
  expect(existsSync(arquivo), `golden ausente: ${arquivo}`).toBe(true);
  expect(atual).toEqual(JSON.parse(readFileSync(arquivo, 'utf8')));
}

const universo = gerarUniversoGolden();
let reg = criarRegistroStub();

let qc: QueryClient;
function rodar(clienteExistente?: QueryClient) {
  qc = clienteExistente ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useFarmerScoring(), { wrapper });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA_GOLDEN);
  reg = criarRegistroStub();
  estado.supabase = criarSupabaseStub(() => universo, reg);
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * O universo de pedidos fica no cache para os OUTROS motores: se este o mutou (ordenou, alterou
 * linha ou item), o próximo leria dado diferente. O que está no cache tem de ser igual a uma
 * releitura fresca do mesmo banco — e tem de existir (senão a comparação é com nada).
 */
async function universoCompartilhadoIntacto() {
  const emCache = qc.getQueryData(chaveUniversoPedidos(estado.auth.user.id));
  expect(emCache, 'o motor não leu pelo universo compartilhado').toBeDefined();
  expect(emCache).toEqual(await lerUniversoPedidos());
}

async function saidaDoMotor(clienteExistente?: QueryClient) {
  // A config NÃO-padrão chega ANTES do papel comercial resolver: é a ordem em que o motor anterior
  // calculava com ela (no inverso ele calculava com o DEFAULT — a corrida que o lote 16 fecha, e
  // que tem teste próprio). Assim o golden congela a FÓRMULA, não o bug.
  const papelFinal = estado.papel;
  estado.papel = { ...papelFinal, loading: true };
  const { result, rerender } = rodar(clienteExistente);
  await waitFor(() => expect(qc.getQueryState(FARMER_ALGORITHM_CONFIG_KEY)?.status).toBe('success'));
  estado.papel = papelFinal;
  rerender();
  await waitFor(() => {
    expect(result.current.loading).toBe(false);
    expect(result.current.calculating).toBe(false);
  });
  const { clientScores, agenda, summary, config, erro } = result.current;
  expect(erro).toBeNull();
  // Controle positivo: um golden de carteira VAZIA aprovaria qualquer leitura quebrada.
  expect(clientScores.length).toBeGreaterThan(50);
  expect(agenda.length).toBe(20);
  return { clientScores, agenda, summary, config };
}

describe('useFarmerScoring — mesmo universo de pedidos ⇒ mesmo score (golden)', () => {
  it('gestor (cap_carteira_ler): base inteira', async () => {
    estado.auth = { user: { id: 'gestor-1' }, isMaster: true, isStaff: true };
    estado.papel = { canViewManagerial: true, loading: false };
    estado.lente = { effectiveUserId: 'gestor-1', isImpersonating: false };
    conferirGolden('scoring-gestor', await saidaDoMotor());
    await universoCompartilhadoIntacto();
  });

  it('vendedor: recortado pela carteira visível', async () => {
    estado.auth = { user: { id: FARMER_GOLDEN }, isMaster: false, isStaff: true };
    estado.papel = { canViewManagerial: false, loading: false };
    estado.lente = { effectiveUserId: FARMER_GOLDEN, isImpersonating: false };
    conferirGolden('scoring-vendedor', await saidaDoMotor());
    await universoCompartilhadoIntacto();
  });

  it('lente "Ver como": master olhando o farmer', async () => {
    estado.auth = { user: { id: 'master-1' }, isMaster: true, isStaff: true };
    estado.papel = { canViewManagerial: true, loading: false };
    estado.lente = { effectiveUserId: FARMER_GOLDEN, isImpersonating: true };
    conferirGolden('scoring-lente', await saidaDoMotor());
    await universoCompartilhadoIntacto();
  });

  it('o bundle PUBLICA e o scoring, na sequência e no mesmo cache, reusa o universo sem reler — e o score não muda', async () => {
    estado.auth = { user: { id: FARMER_GOLDEN }, isMaster: false, isStaff: true };
    estado.papel = { canViewManagerial: false, loading: false };
    estado.lente = { effectiveUserId: FARMER_GOLDEN, isImpersonating: false };
    const compartilhado = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: compartilhado }, children);
    const bundle = renderHook(() => useBundleEngine(), { wrapper });
    await act(async () => { await bundle.result.current.calculateBundles(); });
    expect(bundle.result.current.erro).toBeNull();
    const lidasPeloBundle = reg.leiturasPedidos.length;
    expect(lidasPeloBundle).toBeGreaterThan(0); // controle: o bundle leu (fresco), não achou cache

    const saida = await saidaDoMotor(compartilhado);
    expect(reg.leiturasPedidos.length, 'o scoring releu sales_orders em vez de reusar o universo').toBe(lidasPeloBundle);
    // Mesmo golden do vendedor gravado com o motor ANTERIOR: o dado que o bundle deixou no cache
    // (e por onde ele passou) produz o MESMO score.
    conferirGolden('scoring-vendedor', saida);
  });
});

describe('useFarmerScoring — a config do algoritmo é lida com honestidade (lote 16, mudança INTENCIONAL)', () => {
  beforeEach(() => {
    estado.auth = { user: { id: FARMER_GOLDEN }, isMaster: false, isStaff: true };
    estado.papel = { canViewManagerial: false, loading: false };
    estado.lente = { effectiveUserId: FARMER_GOLDEN, isImpersonating: false };
  });

  it('config chegando DEPOIS do papel: calcula com a config LIDA (antes saía com o DEFAULT e ficava)', async () => {
    // O papel já está resolvido no 1º render e a config ainda está em voo — a ordem em que o motor
    // anterior calculava com o DEFAULT. Agora o resultado é o MESMO golden da config lida.
    const { result } = rodar();
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.calculating).toBe(false);
    });
    expect(result.current.erro).toBeNull();
    expect(result.current.config?.k1).toBe(1.3);
    const { clientScores, agenda, summary, config } = result.current;
    conferirGolden('scoring-vendedor', { clientScores, agenda, summary, config });
  });

  it('config que NÃO pôde ser lida ⇒ `erro` do motor, nada calculado, e nenhum DEFAULT exibido como vigente', async () => {
    reg.falharTabelas = ['farmer_algorithm_config'];
    const { result } = rodar();
    await waitFor(() => expect(result.current.erro).toMatch(/configuração do algoritmo/));
    expect(result.current.loading).toBe(false);
    expect(result.current.clientScores).toEqual([]);
    expect(result.current.config).toBeNull();
    expect(reg.leiturasPedidos.length, 'calculou (leu pedidos) com config desconhecida').toBe(0);
  });

  it('execução ANTIGA que termina depois não sobrescreve a atual (config trocada pela Governança no meio)', async () => {
    // 1ª execução (k1 = 1,3) fica presa na leitura de `farmer_calls`; a config muda para k1 = 2,
    // a Governança invalida, a 2ª execução termina ANTES — e a 1ª, ao terminar, não pode publicar.
    reg.atrasoLeitura = (tabela, n) => (tabela === 'farmer_calls' && n === 0 ? 400 : 0);
    const { result } = rodar();
    await waitFor(() => expect(reg.leiturasPorTabela.farmer_calls ?? 0).toBe(1));
    const tabelas = { ...universo.tabelas, farmer_algorithm_config: [{ key: 'k1', value: 2 }] };
    estado.supabase = criarSupabaseStub(() => ({ ...universo, tabelas }), reg);
    await act(async () => { await qc.invalidateQueries({ queryKey: FARMER_ALGORITHM_CONFIG_KEY }); });
    await waitFor(() => expect(result.current.config?.k1).toBe(2));
    // Deixa a execução antiga terminar e confere que ela NÃO publicou por cima.
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(result.current.config?.k1).toBe(2);
    expect(result.current.erro).toBeNull();
  });

  it('releitura da config que FALHA no meio de uma execução: o `erro` fica — a execução antiga não o apaga', async () => {
    reg.atrasoLeitura = (tabela, n) => (tabela === 'farmer_calls' && n === 0 ? 400 : 0);
    const { result } = rodar();
    await waitFor(() => expect(reg.leiturasPorTabela.farmer_calls ?? 0).toBe(1));
    reg.falharTabelas = ['farmer_algorithm_config'];
    await act(async () => { await qc.invalidateQueries({ queryKey: FARMER_ALGORITHM_CONFIG_KEY }); });
    await waitFor(() => expect(result.current.erro).toMatch(/configuração do algoritmo/));
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(result.current.erro).toMatch(/configuração do algoritmo/);
    expect(result.current.clientScores).toEqual([]);
  });

  it('Recalcular depois de a config FALHAR relê a config — e, de volta, o motor calcula', async () => {
    reg.falharTabelas = ['farmer_algorithm_config'];
    const { result } = rodar();
    await waitFor(() => expect(result.current.erro).toMatch(/configuração do algoritmo/));
    reg.falharTabelas = [];
    await act(async () => { await result.current.recalculate(); });
    await waitFor(() => expect(result.current.erro).toBeNull());
    expect(result.current.config?.k1).toBe(1.3);
    expect(result.current.clientScores.length).toBeGreaterThan(50);
  });

  it('OFFLINE na 1ª carga: a config é tentada (não pausa) e o motor sai do loading', async () => {
    onlineManager.setOnline(false);
    try {
      const { result } = rodar();
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(reg.leiturasPorTabela.farmer_algorithm_config ?? 0).toBeGreaterThan(0);
    } finally {
      onlineManager.setOnline(true);
    }
  });
});
