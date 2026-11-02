import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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

function rodar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

async function saidaDoMotor() {
  // A config NÃO-padrão chega ANTES do papel comercial resolver: é a ordem em que o motor anterior
  // calculava com ela (no inverso ele calculava com o DEFAULT — a corrida que o lote 16 fecha, e
  // que tem teste próprio). Assim o golden congela a FÓRMULA, não o bug.
  const papelFinal = estado.papel;
  estado.papel = { ...papelFinal, loading: true };
  const { result, rerender } = rodar();
  await waitFor(() => expect(result.current.config?.k1).toBe(1.3));
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
  });

  it('vendedor: recortado pela carteira visível', async () => {
    estado.auth = { user: { id: FARMER_GOLDEN }, isMaster: false, isStaff: true };
    estado.papel = { canViewManagerial: false, loading: false };
    estado.lente = { effectiveUserId: FARMER_GOLDEN, isImpersonating: false };
    conferirGolden('scoring-vendedor', await saidaDoMotor());
  });

  it('lente "Ver como": master olhando o farmer', async () => {
    estado.auth = { user: { id: 'master-1' }, isMaster: true, isStaff: true };
    estado.papel = { canViewManagerial: true, loading: false };
    estado.lente = { effectiveUserId: FARMER_GOLDEN, isImpersonating: true };
    conferirGolden('scoring-lente', await saidaDoMotor());
  });
});
