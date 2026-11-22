import { describe, expect, it } from 'vitest';
import {
  CHAVE_ENVELOPE_LEGADA,
  chaveClienteEnvelope,
  chaveEnvelope,
  classificarMudancaOutraAba,
  comTravaEntreAbas,
  garantirIdentidadeRascunho,
  gravarEnvelope,
  lerEnvelope,
  migrarEnvelopeLegado,
  removerEnvelopeSeFor,
  reservarEnvio,
  type ArmazemEnvelope,
} from '../envelope-armazenado';
import type { CheckoutEnvelope } from '../checkout-envelope';

// Um localStorage só, compartilhado pelas "abas" — é exatamente o que duas abas da mesma origem veem.
function armazem(): ArmazemEnvelope & { dump: () => Record<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: k => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

let seq = 0;
const gerarId = () => `id-${++seq}`;
const criarCom = (id: string | null): CheckoutEnvelope => ({ checkoutId: id ?? gerarId(), fingerprint: '', committed: false });

const VEND_A = 'user-a';
const VEND_B = 'user-b';
const CLI = 'oben:123';
const FP1 = 'cli#oben:1:2:10.00';
const FP2 = 'cli#oben:1:3:10.00';

describe('chave por usuário + cliente', () => {
  it('vendedores diferentes no MESMO computador não compartilham envelope (o B herdava o do A)', () => {
    const arm = armazem();
    const a = reservarEnvio(arm, chaveEnvelope(VEND_A, CLI), FP1, criarCom);
    expect(a.decisao).toBe('new');
    expect(lerEnvelope(arm, chaveEnvelope(VEND_B, CLI))).toBeNull();
    const b = reservarEnvio(arm, chaveEnvelope(VEND_B, CLI), FP1, criarCom);
    expect(b.decisao).toBe('new');
    expect(b.envelope.checkoutId).not.toBe(a.envelope.checkoutId);
  });

  it('clientes diferentes do mesmo vendedor não se atropelam (o slot único era sobrescrito)', () => {
    const arm = armazem();
    const k1 = chaveEnvelope(VEND_A, 'oben:1');
    const k2 = chaveEnvelope(VEND_A, 'oben:2');
    const r1 = reservarEnvio(arm, k1, FP1, criarCom);
    reservarEnvio(arm, k2, FP2, criarCom);
    expect(lerEnvelope(arm, k1)?.checkoutId).toBe(r1.envelope.checkoutId);
  });

  it('identidade do cliente: Oben, senão Colacor, senão usuário local, senão nenhuma', () => {
    expect(chaveClienteEnvelope({ codigo_cliente: 9, codigo_cliente_colacor: 8 })).toBe('oben:9');
    expect(chaveClienteEnvelope({ codigo_cliente: null, codigo_cliente_colacor: 8 })).toBe('colacor:8');
    expect(chaveClienteEnvelope({ local_user_id: 'u' })).toBe('local:u');
    expect(chaveClienteEnvelope({})).toBeNull();
    expect(chaveClienteEnvelope(null)).toBeNull();
  });
});

describe('duas abas, mesmo vendedor e cliente (o P0)', () => {
  const k = chaveEnvelope(VEND_A, CLI);

  it('o id nasce no rascunho e o envio REAPROVEITA esse id', () => {
    const arm = armazem();
    const rascunho = garantirIdentidadeRascunho(arm, k, gerarId);
    expect(rascunho?.committed).toBe(false);
    const r = reservarEnvio(arm, k, FP1, criarCom);
    expect(r.decisao).toBe('new');
    expect(r.envelope.checkoutId).toBe(rascunho?.checkoutId);
    expect(r.envelope.committed).toBe(true);
    expect(r.envelope.fingerprint).toBe(FP1);
  });

  it('a aba B, com a memória velha, envia o MESMO carrinho → reusa o checkoutId da aba A (não cria 2º PV)', () => {
    const arm = armazem();
    garantirIdentidadeRascunho(arm, k, gerarId); // as duas abas abriram o mesmo rascunho
    const abaA = reservarEnvio(arm, k, FP1, criarCom);
    const abaB = reservarEnvio(arm, k, FP1, criarCom); // B nunca viu o commit de A em memória
    expect(abaB.decisao).toBe('reuse');
    expect(abaB.envelope.checkoutId).toBe(abaA.envelope.checkoutId);
  });

  it('a aba B com OUTRO carrinho cai em conflito, sem gravar por cima do envelope da aba A', () => {
    const arm = armazem();
    const abaA = reservarEnvio(arm, k, FP1, criarCom);
    const abaB = reservarEnvio(arm, k, FP2, criarCom);
    expect(abaB.decisao).toBe('conflict');
    expect(lerEnvelope(arm, k)).toEqual(abaA.envelope);
  });

  it('o rascunho de uma aba NÃO troca o id que a outra já comprometeu', () => {
    const arm = armazem();
    const abaA = reservarEnvio(arm, k, FP1, criarCom);
    const abaB = garantirIdentidadeRascunho(arm, k, gerarId);
    expect(abaB?.checkoutId).toBe(abaA.envelope.checkoutId);
    expect(abaB?.committed).toBe(true);
  });

  it('o sucesso de uma aba não apaga o envelope NOVO que outra aba gravou depois', () => {
    const arm = armazem();
    const velho = reservarEnvio(arm, k, FP1, criarCom).envelope;
    gravarEnvelope(arm, k, null);
    const novo = reservarEnvio(arm, k, FP2, criarCom).envelope;
    expect(removerEnvelopeSeFor(arm, k, velho.checkoutId)).toBe(true);
    expect(lerEnvelope(arm, k)?.checkoutId).toBe(novo.checkoutId);
    expect(removerEnvelopeSeFor(arm, k, novo.checkoutId)).toBe(true);
    expect(lerEnvelope(arm, k)).toBeNull();
  });

  it('a trava entre abas serializa ler→gravar: a 2ª reserva enxerga o commit da 1ª', async () => {
    const arm = armazem();
    // Web Locks de mentira, mas com a semântica real: uma seção por vez, na ordem de chegada.
    let fila: Promise<unknown> = Promise.resolve();
    const travas = {
      request<T>(_n: string, _o: { mode: 'exclusive' }, fn: () => T | Promise<T>): Promise<T> {
        const r = fila.then(() => fn());
        fila = r.catch(() => undefined);
        return r;
      },
    };
    const [a, b] = await Promise.all([
      comTravaEntreAbas('t', () => reservarEnvio(arm, k, FP1, criarCom), travas),
      comTravaEntreAbas('t', () => reservarEnvio(arm, k, FP1, criarCom), travas),
    ]);
    expect([a.decisao, b.decisao]).toEqual(['new', 'reuse']);
    expect(a.envelope.checkoutId).toBe(b.envelope.checkoutId);
  });

  it('sem Web Locks, a trava roda a seção direto (jsdom/navegador antigo)', async () => {
    expect(await comTravaEntreAbas('t', () => 42, undefined)).toBe(42);
  });
});

describe('armazém que falha e envelope corrompido', () => {
  const k = chaveEnvelope(VEND_A, CLI);
  it('quota cheia: a reserva devolve gravou=false (o hook não chama a edge)', () => {
    const arm = armazem();
    arm.setItem = () => { throw new Error('QuotaExceededError'); };
    const r = reservarEnvio(arm, k, FP1, criarCom);
    expect(r.decisao).toBe('new');
    expect(r.decisao !== 'conflict' && r.gravou).toBe(false);
  });
  it('JSON inválido ou sem campos obrigatórios = sem envelope', () => {
    const arm = armazem();
    arm.setItem(k, '{nao json');
    expect(lerEnvelope(arm, k)).toBeNull();
    arm.setItem(k, JSON.stringify({ checkoutId: '', fingerprint: 'x', committed: true }));
    expect(lerEnvelope(arm, k)).toBeNull();
  });
});

describe('migração da chave legada (envelope em voo no dia do deploy)', () => {
  const k = chaveEnvelope(VEND_A, CLI);
  it('envelope legado DESTE cliente vai para a chave do par e sai da legada', () => {
    const arm = armazem();
    const env: CheckoutEnvelope = { checkoutId: 'L', fingerprint: '123#oben:1:2:10.00', committed: true };
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(env));
    migrarEnvelopeLegado(arm, k, '123');
    expect(lerEnvelope(arm, k)).toEqual(env);
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).toBeNull();
  });
  it('envelope legado de OUTRO cliente fica na legada (prefixo exato: 12 ≠ 123)', () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify({ checkoutId: 'L', fingerprint: '123#x', committed: true }));
    migrarEnvelopeLegado(arm, k, '12');
    expect(lerEnvelope(arm, k)).toBeNull();
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).not.toBeNull();
  });
  it('par que já tem envelope não é sobrescrito pela legada', () => {
    const arm = armazem();
    const meu = reservarEnvio(arm, k, FP1, criarCom).envelope;
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify({ checkoutId: 'L', fingerprint: '123#x', committed: true }));
    migrarEnvelopeLegado(arm, k, '123');
    expect(lerEnvelope(arm, k)?.checkoutId).toBe(meu.checkoutId);
  });
});

describe('aviso de outra aba (evento storage)', () => {
  it('commit na outra aba = enviou; rascunho = editando; remoção do que eu conhecia = liberou', () => {
    expect(classificarMudancaOutraAba(JSON.stringify({ checkoutId: 'x', fingerprint: 'f', committed: true }), null)).toBe('enviou');
    expect(classificarMudancaOutraAba(JSON.stringify({ checkoutId: 'x', fingerprint: '', committed: false }), 'x')).toBe('editando');
    expect(classificarMudancaOutraAba(null, 'x')).toBe('liberou');
    expect(classificarMudancaOutraAba(null, null)).toBeNull();
    expect(classificarMudancaOutraAba('{lixo', 'x')).toBeNull();
  });
});
