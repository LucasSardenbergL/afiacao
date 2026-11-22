import { describe, it, expect, vi, beforeEach } from 'vitest';

// Onda 2, item 9: a ligação que sai da ficha de um cliente leva o id dele como CANDIDATO a dono.
// O candidato só vence quando o vínculo cliente × telefone × carteira se confirma; divergência
// continua indo para a conferência (/farmer/calls/pending-link), nunca para o cliente errado.

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  contatos: { data: [] as { phone: string }[] | null, error: null as unknown },
  perfil: { data: null as { phone: string | null } | null, error: null as unknown },
  carteira: { data: [] as { customer_user_id: string }[] | null, error: null as unknown },
  chamadas: [] as { tabela: string; ops: [string, unknown[]][] }[],
  user: { id: 'vendedora-1' } as { id: string } | null,
}));

function chain(tabela: string) {
  const registro = { tabela, ops: [] as [string, unknown[]][] };
  h.chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'limit', 'maybeSingle']) {
    c[m] = (...args: unknown[]) => { registro.ops.push([m, args]); return c; };
  }
  c.then = (resolve: (v: unknown) => void) => {
    if (tabela === 'customer_contacts') return resolve(h.contatos);
    if (tabela === 'profiles') return resolve(h.perfil);
    return resolve(h.carteira);
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: h.rpc,
    from: (t: string) => chain(t),
    auth: { getUser: async () => ({ data: { user: h.user } }) },
  },
}));

import { decidirDonoComOrigem, resolveCustomerByPhone, type ResolvedCustomer } from './resolve-customer';

const CAND = 'cliente-da-ficha';
const OUTRO = 'outro-cliente';
const base = (over: Partial<ResolvedCustomer> = {}): ResolvedCustomer => ({
  customerUserId: null, phoneDialed: '31999991234', reconhecido: true, candidatos: 2, ...over,
});
const linha = (over: Record<string, unknown> = {}) => ({
  customer_user_id: null, contato_nome: null, contato_cargo: null, fonte: 'perfil', candidatos: 2, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.chamadas.length = 0;
  h.user = { id: 'vendedora-1' };
  h.contatos = { data: [], error: null };
  h.perfil = { data: { phone: '(31) 99999-1234' }, error: null };
  h.carteira = { data: [{ customer_user_id: CAND }], error: null };
});

describe('decidirDonoComOrigem (regra pura)', () => {
  const ok = { telefoneDoCandidato: true, naCarteiraDeQuemLiga: true };

  it('sem candidato: o que o número disse', () => {
    expect(decidirDonoComOrigem(base(), null, ok)).toEqual(base());
  });

  it('número desconhecido não vira cliente só porque saiu de uma ficha', () => {
    const desc = base({ reconhecido: false, candidatos: 0 });
    expect(decidirDonoComOrigem(desc, CAND, ok).customerUserId).toBeNull();
  });

  it('dono único = candidato: mantém', () => {
    expect(decidirDonoComOrigem(base({ customerUserId: CAND, candidatos: 1 }), CAND, null).customerUserId).toBe(CAND);
  });

  it('dono único DIFERENTE do candidato: divergência → sem dono (conferência), sem o contato do outro', () => {
    const r = decidirDonoComOrigem(base({ customerUserId: OUTRO, candidatos: 1, contactName: 'Zé' }), CAND, ok);
    expect(r).toMatchObject({ customerUserId: null, reconhecido: true });
    expect(r.contactName).toBeUndefined();
  });

  it('compartilhado + telefone do candidato + na carteira: o candidato', () => {
    expect(decidirDonoComOrigem(base(), CAND, ok).customerUserId).toBe(CAND);
  });

  it('compartilhado, mas fora da carteira de quem liga: conferência', () => {
    expect(decidirDonoComOrigem(base(), CAND, { telefoneDoCandidato: true, naCarteiraDeQuemLiga: false }).customerUserId).toBeNull();
  });

  it('compartilhado, mas o número não é do candidato: conferência', () => {
    expect(decidirDonoComOrigem(base(), CAND, { telefoneDoCandidato: false, naCarteiraDeQuemLiga: true }).customerUserId).toBeNull();
  });

  it('compartilhado e evidência indisponível (leitura falhou): conferência', () => {
    expect(decidirDonoComOrigem(base(), CAND, null).customerUserId).toBeNull();
  });
});

describe('resolveCustomerByPhone com clienteOrigemId', () => {
  it('compartilhado: lê o telefone e a carteira do candidato (de quem liga, elegível) e o confirma', async () => {
    h.rpc.mockResolvedValue({ data: [linha()], error: null });
    const r = await resolveCustomerByPhone('31999991234', { clienteOrigemId: CAND });
    expect(r).toMatchObject({ customerUserId: CAND, reconhecido: true, candidatos: 2 });
    const cart = h.chamadas.find((c) => c.tabela === 'carteira_assignments')!;
    expect(cart.ops).toContainEqual(['eq', ['customer_user_id', CAND]]);
    expect(cart.ops).toContainEqual(['eq', ['owner_user_id', 'vendedora-1']]);
    expect(cart.ops).toContainEqual(['eq', ['eligible', true]]);
  });

  it('o número casa pelo contato do candidato (só dígitos, sufixo de 8)', async () => {
    h.rpc.mockResolvedValue({ data: [linha({ fonte: 'contato' })], error: null });
    h.perfil = { data: { phone: null }, error: null };
    h.contatos = { data: [{ phone: '9999-1234' }], error: null };
    const r = await resolveCustomerByPhone('31999991234', { clienteOrigemId: CAND });
    expect(r.customerUserId).toBe(CAND);
  });

  it('compartilhado e o candidato não tem este número: segue sem dono', async () => {
    h.rpc.mockResolvedValue({ data: [linha()], error: null });
    h.perfil = { data: { phone: '31988887777' }, error: null };
    const r = await resolveCustomerByPhone('31999991234', { clienteOrigemId: CAND });
    expect(r).toMatchObject({ customerUserId: null, reconhecido: true });
  });

  it('compartilhado e o candidato é de outra carteira: segue sem dono', async () => {
    h.rpc.mockResolvedValue({ data: [linha()], error: null });
    h.carteira = { data: [], error: null };
    const r = await resolveCustomerByPhone('31999991234', { clienteOrigemId: CAND });
    expect(r.customerUserId).toBeNull();
  });

  it('falha ao ler a evidência: segue sem dono e loga a mensagem', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.rpc.mockResolvedValue({ data: [linha()], error: null });
    h.carteira = { data: null, error: { message: 'permission denied for table carteira_assignments' } };
    const r = await resolveCustomerByPhone('31999991234', { clienteOrigemId: CAND });
    expect(r.customerUserId).toBeNull();
    expect(spy.mock.calls.flat().join(' ')).toContain('permission denied');
    spy.mockRestore();
  });

  it('dono único já é o candidato: não lê evidência', async () => {
    h.rpc.mockResolvedValue({ data: [linha({ customer_user_id: CAND, candidatos: 1 })], error: null });
    const r = await resolveCustomerByPhone('31999991234', { clienteOrigemId: CAND });
    expect(r.customerUserId).toBe(CAND);
    expect(h.chamadas).toHaveLength(0);
  });

  it('dono único é OUTRO cliente: divergência vai para conferência', async () => {
    h.rpc.mockResolvedValue({ data: [linha({ customer_user_id: OUTRO, candidatos: 1 })], error: null });
    const r = await resolveCustomerByPhone('31999991234', { clienteOrigemId: CAND });
    expect(r).toMatchObject({ customerUserId: null, reconhecido: true });
  });

  it('sem candidato: comportamento de antes (dono único do número), sem leituras extras', async () => {
    h.rpc.mockResolvedValue({ data: [linha({ customer_user_id: OUTRO, candidatos: 1 })], error: null });
    const r = await resolveCustomerByPhone('31999991234');
    expect(r.customerUserId).toBe(OUTRO);
    expect(h.chamadas).toHaveLength(0);
  });
});
