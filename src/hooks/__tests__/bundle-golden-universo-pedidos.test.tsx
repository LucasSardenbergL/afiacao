import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
 * GOLDEN do `useBundleEngine` — plano v4, lote 16 (C4′): "mesmo dado ⇒ mesmos bundles".
 *
 * Os JSON em `src/test/golden/universo-pedidos/` foram gravados com o motor ANTES da troca da
 * leitura de `sales_orders` (sequencial e própria → compartilhada e paralela). Exige igualdade
 * BIT-A-BIT das regras, dos bundles por cliente E do que o motor PERSISTE, com e sem a lente.
 * A ordem das cestas importa: regras empatadas, `relatedRules.slice(0,3)` e `recentProducts`.
 * Regravar (`GRAVAR_GOLDEN=1`) só quando o CÁLCULO muda de propósito.
 */

const estado = vi.hoisted(() => ({
  supabase: null as null | { from: (t: string) => unknown; rpc: (n: string, a?: Record<string, unknown>) => unknown },
  auth: { user: { id: 'farmer-1' }, isMaster: false, isStaff: true },
  lente: { effectiveUserId: 'farmer-1', isImpersonating: false },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => estado.supabase!.from(t),
    rpc: (n: string, a?: Record<string, unknown>) => estado.supabase!.rpc(n, a),
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => estado.auth }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => estado.lente }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useBundleEngine } from '../useBundleEngine';

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
  expect(atual).toEqual(canonico(JSON.parse(readFileSync(arquivo, 'utf8'))));
}

const universo = gerarUniversoGolden();
let reg = criarRegistroStub();

let qc: QueryClient;
function rodar() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useBundleEngine(), { wrapper });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA_GOLDEN);
  reg = criarRegistroStub();
  estado.supabase = criarSupabaseStub(() => universo, reg);
  // `runId` da geração: determinístico, senão o payload persistido nunca bate com o golden.
  let n = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

async function saidaDoMotor() {
  const { result } = rodar();
  await act(async () => { await result.current.calculateBundles(); });
  const { customerBundles, rules, erro, desatualizado, calculado } = result.current;
  expect(erro).toBeNull();
  // Controle positivo: um golden sem bundle aprovaria qualquer leitura quebrada.
  expect(rules.length).toBeGreaterThan(5);
  expect(customerBundles.length).toBeGreaterThan(5);
  // A FRONTEIRA também: o que o motor grava (RPC de substituição / registro de geração) entra no
  // golden — comparar só a tela deixaria a persistência sem prova.
  return { customerBundles, rules, erro, desatualizado, calculado, escritas: reg.escritas };
}

describe('useBundleEngine — mesmo universo de pedidos ⇒ mesma saída (golden)', () => {
  it('farmer na própria carteira (grava a geração)', async () => {
    estado.auth = { user: { id: FARMER_GOLDEN }, isMaster: false, isStaff: true };
    estado.lente = { effectiveUserId: FARMER_GOLDEN, isImpersonating: false };
    conferirGolden('bundle-farmer', await saidaDoMotor());
    await universoCompartilhadoIntacto();
  });

  it('lente "Ver como": master olhando o farmer (só leitura)', async () => {
    estado.auth = { user: { id: 'master-1' }, isMaster: true, isStaff: true };
    estado.lente = { effectiveUserId: FARMER_GOLDEN, isImpersonating: true };
    conferirGolden('bundle-lente', await saidaDoMotor());
    await universoCompartilhadoIntacto();
  });
});
