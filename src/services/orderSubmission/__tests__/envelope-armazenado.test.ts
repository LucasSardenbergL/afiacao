import { describe, expect, it } from 'vitest';
import {
  CHAVE_ENVELOPE_LEGADA,
  MAX_CONCLUIDOS,
  chaveClienteEnvelope,
  chaveEnvelope,
  classificarMudancaOutraAba,
  comTravaEntreAbas,
  concluirEnvio,
  descartarLegadoDoCliente,
  estaConcluido,
  garantirIdentidadeRascunho,
  gravarSeAindaFor,
  lerEnvelope,
  lerEnvelopeEstrito,
  marcarConcluido,
  moverEnvelope,
  reservarEnvio,
  type ArmazemEnvelope,
  type ReservaEnvio,
} from '../envelope-armazenado';
import type { CheckoutEnvelope } from '../checkout-envelope';

// Um localStorage só, compartilhado pelas "abas" — é exatamente o que duas abas da mesma origem veem.
function armazem(): ArmazemEnvelope {
  const m = new Map<string, string>();
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: k => { m.delete(k); },
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
const K = chaveEnvelope(VEND_A, CLI);

/** Uma "aba": o id da cópia que ela carrega (rascunho), como o hook guarda em `idDaAbaRef`. */
function aba(arm: ArmazemEnvelope, userId = VEND_A, chave = K) {
  let id: string | null = null;
  return {
    get id() { return id; },
    abrirRascunho() { id = garantirIdentidadeRascunho(arm, userId, chave, id, gerarId)?.checkoutId ?? id; return id; },
    restaurar(x: string | null) { id = x; },
    enviar(fp: string): ReservaEnvio {
      const r = reservarEnvio(arm, { userId, chave, fingerprint: fp, idDaAba: id }, criarCom);
      if (r.decisao === 'new' || r.decisao === 'reuse') id = r.envelope.checkoutId;
      return r;
    },
    concluir() { if (id) concluirEnvio(arm, userId, chave, id); id = null; },
  };
}
const idDe = (r: ReservaEnvio) => (r.decisao === 'new' || r.decisao === 'reuse' ? r.envelope.checkoutId : null);

describe('chave por usuário + cliente', () => {
  it('vendedores diferentes no MESMO computador não compartilham envelope (o B herdava o do A)', () => {
    const arm = armazem();
    const a = aba(arm, VEND_A, chaveEnvelope(VEND_A, CLI)).enviar(FP1);
    expect(lerEnvelope(arm, chaveEnvelope(VEND_B, CLI))).toBeNull();
    const b = aba(arm, VEND_B, chaveEnvelope(VEND_B, CLI)).enviar(FP1);
    expect(b.decisao).toBe('new');
    expect(idDe(b)).not.toBe(idDe(a));
  });

  it('clientes diferentes do mesmo vendedor não se atropelam (o slot único era sobrescrito)', () => {
    const arm = armazem();
    const k1 = chaveEnvelope(VEND_A, 'oben:1');
    const r1 = aba(arm, VEND_A, k1).enviar(FP1);
    aba(arm, VEND_A, chaveEnvelope(VEND_A, 'oben:2')).enviar(FP2);
    expect(lerEnvelope(arm, k1)?.checkoutId).toBe(idDe(r1));
  });

  it('identidade do cliente: usuário local (mais estável), senão Oben, senão Colacor, senão nenhuma', () => {
    expect(chaveClienteEnvelope({ local_user_id: 'u', codigo_cliente: 9 })).toBe('local:u');
    expect(chaveClienteEnvelope({ codigo_cliente: 9, codigo_cliente_colacor: 8 })).toBe('oben:9');
    expect(chaveClienteEnvelope({ codigo_cliente: null, codigo_cliente_colacor: 8 })).toBe('colacor:8');
    expect(chaveClienteEnvelope({})).toBeNull();
    expect(chaveClienteEnvelope(null)).toBeNull();
  });
});

describe('duas abas, mesmo vendedor e cliente (o P0)', () => {
  it('o id nasce no rascunho e o envio REAPROVEITA esse id', () => {
    const arm = armazem();
    const a = aba(arm);
    const id = a.abrirRascunho();
    const r = a.enviar(FP1);
    expect(r.decisao).toBe('new');
    expect(idDe(r)).toBe(id);
    expect(lerEnvelope(arm, K)).toMatchObject({ checkoutId: id, fingerprint: FP1, committed: true });
  });

  it('a aba B, com a memória velha, envia o MESMO carrinho → reusa o checkoutId da A (não cria 2º PV)', () => {
    const arm = armazem();
    const a = aba(arm); const b = aba(arm);
    a.abrirRascunho(); b.abrirRascunho();
    const ra = a.enviar(FP1);
    const rb = b.enviar(FP1);
    expect(rb.decisao).toBe('reuse');
    expect(idDe(rb)).toBe(idDe(ra));
  });

  it('a A conclui e LIMPA; a B, minutos depois, envia a mesma cópia → recusada, nunca id novo (Codex P0)', () => {
    const arm = armazem();
    const a = aba(arm); const b = aba(arm);
    a.abrirRascunho(); b.abrirRascunho();
    a.enviar(FP1);
    a.concluir();
    expect(lerEnvelope(arm, K)).toBeNull();
    expect(b.enviar(FP1).decisao).toBe('ja_concluido');
    // ...mesmo que outra cópia tenha aberto um rascunho novo no par depois disso
    aba(arm).abrirRascunho();
    expect(b.enviar(FP1).decisao).toBe('ja_concluido');
  });

  it('refresh na B depois do sucesso da A: o rascunho restaurado traz o id e a lápide barra', () => {
    const arm = armazem();
    const a = aba(arm);
    const id = a.abrirRascunho();
    a.enviar(FP1); a.concluir();
    const bDepoisDoRefresh = aba(arm);
    bDepoisDoRefresh.restaurar(id);
    expect(bDepoisDoRefresh.enviar(FP1).decisao).toBe('ja_concluido');
  });

  it('a aba B com OUTRO carrinho cai em conflito, sem gravar por cima do envelope da A', () => {
    const arm = armazem();
    const ra = aba(arm).enviar(FP1);
    expect(aba(arm).enviar(FP2).decisao).toBe('conflict');
    expect(lerEnvelope(arm, K)?.checkoutId).toBe(idDe(ra));
  });

  it('o rascunho de uma aba NÃO troca o id que a outra já comprometeu', () => {
    const arm = armazem();
    const ra = aba(arm).enviar(FP1);
    const b = aba(arm);
    expect(b.abrirRascunho()).toBe(idDe(ra));
    expect(lerEnvelope(arm, K)?.committed).toBe(true);
  });

  it('depois do sucesso, o próximo pedido IDÊNTICO desta aba é NOVO (não vira "já enviado")', () => {
    const arm = armazem();
    const a = aba(arm);
    const r1 = a.enviar(FP1); a.concluir();
    const r2 = a.enviar(FP1);
    expect(r2.decisao).toBe('new');
    expect(idDe(r2)).not.toBe(idDe(r1));
  });

  it('remoção que falha no sucesso: a lápide manda e o próximo pedido idêntico é NOVO (Codex P1)', () => {
    const arm = armazem();
    const a = aba(arm);
    const r1 = a.enviar(FP1);
    const removeItem = arm.removeItem;
    arm.removeItem = () => { throw new Error('falhou'); };
    a.concluir();
    arm.removeItem = removeItem;
    expect(lerEnvelope(arm, K)?.checkoutId).toBe(idDe(r1)); // ficou lá
    const r2 = aba(arm).enviar(FP1);
    expect(r2.decisao).toBe('new');
    expect(idDe(r2)).not.toBe(idDe(r1));
  });

  it('o sucesso de uma aba não apaga o envelope NOVO que outra aba gravou depois', () => {
    const arm = armazem();
    const velho = idDe(aba(arm).enviar(FP1)) as string;
    marcarConcluido(arm, VEND_A, velho);
    const novo = idDe(aba(arm).enviar(FP2));
    concluirEnvio(arm, VEND_A, K, velho);
    expect(lerEnvelope(arm, K)?.checkoutId).toBe(novo);
  });

  it('gravarSeAindaFor: marca da OS de uma aba não atropela o commit de outra', () => {
    const arm = armazem();
    const ra = aba(arm).enviar(FP1);
    const alheio: CheckoutEnvelope = { checkoutId: 'outro', fingerprint: FP1, committed: true };
    expect(gravarSeAindaFor(arm, K, 'outro', alheio)).toBe(false);
    expect(lerEnvelope(arm, K)?.checkoutId).toBe(idDe(ra));
  });

  it('a trava entre abas serializa ler→gravar: a 2ª reserva enxerga o commit da 1ª', async () => {
    const arm = armazem();
    let fila: Promise<unknown> = Promise.resolve();
    const travas = {
      request<T>(_n: string, _o: { mode: 'exclusive' }, fn: () => T | Promise<T>): Promise<T> {
        const r = fila.then(() => fn());
        fila = r.catch(() => undefined);
        return r;
      },
    };
    const res = (fp: string) => reservarEnvio(arm, { userId: VEND_A, chave: K, fingerprint: fp, idDaAba: null }, criarCom);
    const [a, b] = await Promise.all([
      comTravaEntreAbas('t', () => res(FP1), travas),
      comTravaEntreAbas('t', () => res(FP1), travas),
    ]);
    expect([a.decisao, b.decisao]).toEqual(['new', 'reuse']);
    expect(idDe(a)).toBe(idDe(b));
  });

  it('sem Web Locks, a trava roda a seção direto (jsdom/navegador antigo)', async () => {
    expect(await comTravaEntreAbas('t', () => 42, undefined)).toBe(42);
  });
});

describe('leitura que falha NÃO autoriza id novo (Codex P0)', () => {
  it('envelope ilegível → indeterminado (era "new" com id novo)', () => {
    const arm = armazem();
    arm.setItem(K, '{nao json');
    expect(aba(arm).enviar(FP1).decisao).toBe('indeterminado');
    arm.setItem(K, JSON.stringify({ checkoutId: '', fingerprint: 'x', committed: true }));
    expect(aba(arm).enviar(FP1).decisao).toBe('indeterminado');
  });
  it('getItem que lança → indeterminado', () => {
    const arm = armazem();
    arm.getItem = () => { throw new Error('SecurityError'); };
    expect(lerEnvelopeEstrito(arm, K).estado).toBe('ilegivel');
    expect(aba(arm).enviar(FP1).decisao).toBe('indeterminado');
  });
  it('lápide ilegível → indeterminado (não dá para provar que a cópia não foi concluída)', () => {
    const arm = armazem();
    const a = aba(arm); a.abrirRascunho();
    arm.setItem(`unified_order_checkout_concluidos:v2:${VEND_A}`, '{quebrado');
    expect(estaConcluido(arm, VEND_A, 'x')).toBe('ilegivel');
    expect(a.enviar(FP1).decisao).toBe('indeterminado');
  });
  it('quota cheia: a reserva devolve gravou=false (o hook não chama a edge)', () => {
    const arm = armazem();
    arm.setItem = () => { throw new Error('QuotaExceededError'); };
    const r = aba(arm).enviar(FP1);
    expect(r.decisao === 'new' && r.gravou).toBe(false);
    expect(r.decisao).toBe('new');
  });
});

describe('lápide', () => {
  it('guarda só as MAX_CONCLUIDOS mais recentes e é idempotente', () => {
    const arm = armazem();
    for (let i = 0; i < MAX_CONCLUIDOS + 5; i++) marcarConcluido(arm, VEND_A, `c${i}`);
    marcarConcluido(arm, VEND_A, `c${MAX_CONCLUIDOS + 4}`);
    expect(estaConcluido(arm, VEND_A, 'c0')).toBe(false);
    expect(estaConcluido(arm, VEND_A, `c${MAX_CONCLUIDOS + 4}`)).toBe(true);
    expect(estaConcluido(arm, VEND_B, `c${MAX_CONCLUIDOS + 4}`)).toBe(false);
  });
  it('rascunho restaurado com id CONCLUÍDO não volta a ser identidade: nasce id novo', () => {
    const arm = armazem();
    marcarConcluido(arm, VEND_A, 'velho');
    expect(garantirIdentidadeRascunho(arm, VEND_A, K, 'velho', gerarId)?.checkoutId).not.toBe('velho');
  });
});

describe('chave que muda no meio do pedido (autocadastro trouxe código — Codex P0)', () => {
  it('moverEnvelope leva o envelope ao par novo e o retry reusa o id', () => {
    const arm = armazem();
    const kVelha = chaveEnvelope(VEND_A, 'colacor:7');
    const kNova = chaveEnvelope(VEND_A, 'oben:7');
    const r1 = aba(arm, VEND_A, kVelha).enviar(FP1);
    expect(moverEnvelope(arm, kVelha, kNova)).toBe(true);
    expect(lerEnvelope(arm, kVelha)).toBeNull();
    const r2 = aba(arm, VEND_A, kNova).enviar(FP1); // refresh: a aba não tem id em memória
    expect(r2.decisao).toBe('reuse');
    expect(idDe(r2)).toBe(idDe(r1));
  });
  it('não sobrescreve um par novo ocupado', () => {
    const arm = armazem();
    const kVelha = chaveEnvelope(VEND_A, 'colacor:7');
    const kNova = chaveEnvelope(VEND_A, 'oben:7');
    aba(arm, VEND_A, kVelha).enviar(FP1);
    const ocupado = idDe(aba(arm, VEND_A, kNova).enviar(FP2));
    expect(moverEnvelope(arm, kVelha, kNova)).toBe(false);
    expect(lerEnvelope(arm, kNova)?.checkoutId).toBe(ocupado);
  });
});

describe('envelope legado (chave fixa de antes do PR 2.2)', () => {
  const legado: CheckoutEnvelope = { checkoutId: 'L', fingerprint: '123#oben:1:2:10.00', committed: true };
  it('retry EXATO do mesmo carrinho reaproveita o id legado (envio em voo no dia do deploy)', () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    const r = aba(arm).enviar(legado.fingerprint);
    expect(r.decisao).toBe('reuse');
    expect(idDe(r)).toBe('L');
  });
  it('outro carrinho do mesmo cliente NÃO é absorvido pelo legado (outro vendedor no mesmo PC)', () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    const r = aba(arm).enviar('123#oben:1:9:10.00');
    expect(r.decisao).toBe('new');
    expect(idDe(r)).not.toBe('L');
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).not.toBeNull(); // nunca migrado/apagado de carona
  });
  it('legado já concluído não é reaproveitado', () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    marcarConcluido(arm, VEND_A, 'L');
    expect(idDe(aba(arm).enviar(legado.fingerprint))).not.toBe('L');
  });
  it('descartar o rascunho do cliente solta o legado dele (prefixo exato: 12 ≠ 123)', () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    descartarLegadoDoCliente(arm, ['12']);
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).not.toBeNull();
    descartarLegadoDoCliente(arm, ['123']);
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).toBeNull();
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
