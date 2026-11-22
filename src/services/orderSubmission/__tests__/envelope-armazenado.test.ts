import { describe, expect, it } from 'vitest';
import {
  CHAVE_ENVELOPE_LEGADA,
  assinaturaItens,
  chaveClienteEnvelope,
  chaveEnvelope,
  classificarMudancaOutraAba,
  comTravaEntreAbas,
  concluirEnvio,
  descartarLegadoDoCliente,
  gravarSeAindaFor,
  idDoEnvio,
  lerEnvelope,
  lerEnvelopeEstrito,
  mesmoCliente,
  moverEnvelope,
  nonceParaAssumir,
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

const VEND_A = 'user-a';
const VEND_B = 'user-b';
const K = chaveEnvelope(VEND_A, 'oben:123');
const FP1 = '123#oben:1:2:10.00';
const FP2 = '123#oben:1:3:10.00';
const criar = (id: string): CheckoutEnvelope => ({ checkoutId: id, fingerprint: '', committed: true });

/** Uma "aba": o nonce da cópia (o hook guarda em `nonceRef` e no rascunho em disco). */
function aba(arm: ArmazemEnvelope, nonce: string, chave = K) {
  return {
    async enviar(fp: string): Promise<ReservaEnvio> {
      const idCalculado = await idDoEnvio(nonce, fp);
      return reservarEnvio(arm, { chave, fingerprint: fp, idCalculado, prefixosLegado: ['123'] }, criar);
    },
    concluir(r: ReservaEnvio) { if (r.decisao === 'new' || r.decisao === 'reuse') concluirEnvio(arm, chave, r.envelope.checkoutId); },
  };
}
const idDe = (r: ReservaEnvio) => (r.decisao === 'new' || r.decisao === 'reuse' ? r.envelope.checkoutId : null);

describe('idDoEnvio: o id deriva da cópia (nonce) + itens', () => {
  it('determinístico, formato UUID, e muda com o nonce ou com os itens', async () => {
    const a = await idDoEnvio('n1', FP1);
    expect(a).toBe(await idDoEnvio('n1', FP1));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await idDoEnvio('n2', FP1)).not.toBe(a);
    expect(await idDoEnvio('n1', FP2)).not.toBe(a);
  });
  it('o prefixo do cliente NÃO entra (o cliente ganhar usuário local não troca o id — Codex P1)', async () => {
    expect(await idDoEnvio('n1', 'uuid-local#oben:1:2:10.00')).toBe(await idDoEnvio('n1', FP1));
    expect(assinaturaItens(FP1)).toBe('oben:1:2:10.00');
  });
  it('nonce vazio lança (nunca deriva id de nada)', async () => {
    await expect(idDoEnvio('', FP1)).rejects.toThrow(/^idDoEnvio: nonce vazio$/);
  });
});

describe('duas abas / refresh com a MESMA cópia do pedido (o P0)', () => {
  it('as duas abas enviam o mesmo carrinho → o MESMO id (o servidor diz "já enviado")', async () => {
    const arm = armazem();
    const ra = await aba(arm, 'N').enviar(FP1);
    const rb = await aba(arm, 'N').enviar(FP1);
    expect(idDe(rb)).toBe(idDe(ra));
  });

  it('A conclui e LIMPA; B (ou um refresh que restaurou a cópia) envia o mesmo carrinho → mesmo id (Codex P0)', async () => {
    const arm = armazem();
    const a = aba(arm, 'N');
    const ra = await a.enviar(FP1);
    a.concluir(ra);
    expect(lerEnvelope(arm, K)).toBeNull();
    const rb = await aba(arm, 'N').enviar(FP1);
    expect(rb.decisao).toBe('new');
    expect(idDe(rb)).toBe(idDe(ra)); // mesmo id → dedup do servidor, sem 2º PV
  });

  it('A conclui 1 unidade; B, com a mesma cópia, envia 2 → id DIFERENTE (pedido novo, não "já enviado" — Codex P1)', async () => {
    const arm = armazem();
    const a = aba(arm, 'N');
    const ra = await a.enviar(FP1);
    a.concluir(ra);
    const rb = await aba(arm, 'N').enviar(FP2);
    expect(rb.decisao).toBe('new');
    expect(idDe(rb)).not.toBe(idDe(ra));
  });

  it('depois do sucesso, o nonce gira: o próximo pedido IDÊNTICO é NOVO', async () => {
    const arm = armazem();
    const a1 = aba(arm, 'N1');
    const r1 = await a1.enviar(FP1); a1.concluir(r1);
    const r2 = await aba(arm, 'N2').enviar(FP1);
    expect(idDe(r2)).not.toBe(idDe(r1));
  });

  it('envio PARCIAL pendente + outro carrinho na outra aba → conflito (a conta já enviada não sai de novo)', async () => {
    const arm = armazem();
    const ra = await aba(arm, 'N').enviar(FP1);
    const rb = await aba(arm, 'N').enviar(FP2);
    expect(rb.decisao).toBe('conflict');
    expect(lerEnvelope(arm, K)?.checkoutId).toBe(idDe(ra));
  });

  it('envio pendente + mesmo carrinho de OUTRA cópia → outra_copia: nem engole (pedido novo idêntico) nem duplica (Codex P0)', async () => {
    const arm = armazem();
    const ra = await aba(arm, 'N1').enviar(FP1);
    const rb = await aba(arm, 'N2').enviar(FP1);
    expect(rb.decisao).toBe('outra_copia');
    expect(rb.decisao === 'outra_copia' && rb.envelope.checkoutId).toBe(idDe(ra));
    expect(lerEnvelope(arm, K)?.checkoutId).toBe(idDe(ra)); // nada gravado por cima
  });

  it('"É o mesmo pedido": B assume o nonce do pendente → mesmo id; e depois que A limpa, continua o MESMO id (Codex P0)', async () => {
    const arm = armazem();
    const a = aba(arm, 'N1');
    const ra = await a.enviar(FP1);
    const pendente = lerEnvelope(arm, K) as CheckoutEnvelope;
    const nonceAssumido = nonceParaAssumir({ ...pendente, nonce: 'N1' });
    const rb = await aba(arm, nonceAssumido).enviar(FP1);
    expect(rb.decisao).toBe('reuse');
    expect(idDe(rb)).toBe(idDe(ra));
    a.concluir(ra);
    expect(idDe(await aba(arm, nonceAssumido).enviar(FP1))).toBe(idDe(ra)); // servidor: "já enviado"
  });

  it('remoção que falha no sucesso: o próximo pedido idêntico (nonce novo) cai em outra_copia, nunca "já enviado" calado', async () => {
    const arm = armazem();
    const a = aba(arm, 'N1');
    const ra = await a.enviar(FP1);
    const removeItem = arm.removeItem;
    arm.removeItem = () => { throw new Error('falhou'); };
    expect(concluirEnvio(arm, K, idDe(ra) as string)).toBe(false);
    arm.removeItem = removeItem;
    expect((await aba(arm, 'N2').enviar(FP1)).decisao).toBe('outra_copia');
  });

  it('o sucesso de uma aba não apaga o envelope que OUTRA aba comprometeu depois', async () => {
    const arm = armazem();
    const velho = await aba(arm, 'N1').enviar(FP1);
    concluirEnvio(arm, K, idDe(velho) as string);
    const novo = await aba(arm, 'N2').enviar(FP2);
    expect(concluirEnvio(arm, K, idDe(velho) as string)).toBe(true);
    expect(lerEnvelope(arm, K)?.checkoutId).toBe(idDe(novo));
  });

  it('gravarSeAindaFor: a marca da OS de uma aba não atropela o commit de outra', async () => {
    const arm = armazem();
    const ra = await aba(arm, 'N').enviar(FP1);
    expect(gravarSeAindaFor(arm, K, 'outro', { checkoutId: 'outro', fingerprint: FP1, committed: true })).toBe(false);
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
    const [i1, i2] = [await idDoEnvio('N1', FP1), await idDoEnvio('N1', FP1)]; // a mesma cópia em duas abas
    const res = (id: string) => reservarEnvio(arm, { chave: K, fingerprint: FP1, idCalculado: id, prefixosLegado: [] }, criar);
    const [a, b] = await Promise.all([comTravaEntreAbas('t', () => res(i1), travas), comTravaEntreAbas('t', () => res(i2), travas)]);
    expect([a.decisao, b.decisao]).toEqual(['new', 'reuse']);
    expect(idDe(b)).toBe(idDe(a));
  });

  it('sem Web Locks, a trava roda a seção direto (jsdom/navegador antigo)', async () => {
    expect(await comTravaEntreAbas('t', () => 42, undefined)).toBe(42);
  });
});

describe('chave por usuário + cliente', () => {
  it('vendedores diferentes no MESMO computador não compartilham envelope (o B herdava o do A)', async () => {
    const arm = armazem();
    await aba(arm, 'N', chaveEnvelope(VEND_A, 'oben:123')).enviar(FP1);
    expect(lerEnvelope(arm, chaveEnvelope(VEND_B, 'oben:123'))).toBeNull();
    expect((await aba(arm, 'M', chaveEnvelope(VEND_B, 'oben:123')).enviar(FP2)).decisao).toBe('new');
  });
  it('identidade do cliente: usuário local (mais estável), senão Oben, senão Colacor, senão nenhuma', () => {
    expect(chaveClienteEnvelope({ local_user_id: 'u', codigo_cliente: 9 })).toBe('local:u');
    expect(chaveClienteEnvelope({ codigo_cliente: 9, codigo_cliente_colacor: 8 })).toBe('oben:9');
    expect(chaveClienteEnvelope({ codigo_cliente: null, codigo_cliente_colacor: 8 })).toBe('colacor:8');
    expect(chaveClienteEnvelope({})).toBeNull();
  });
  it('mesmoCliente: compartilha um código não-vazio; vazio/zero-string não identifica', () => {
    expect(mesmoCliente({ codigo_cliente_colacor: 7 }, { codigo_cliente: 5, codigo_cliente_colacor: 7 })).toBe(true);
    expect(mesmoCliente({ codigo_cliente: 5 }, { codigo_cliente: 6 })).toBe(false);
    expect(mesmoCliente({ local_user_id: '' }, { local_user_id: '' })).toBe(false);
    expect(mesmoCliente(null, { codigo_cliente: 5 })).toBe(false);
    // código Omie 0 = sem cadastro naquela conta: não identifica (Codex P1)
    expect(mesmoCliente({ local_user_id: 'a', codigo_cliente: 0 }, { local_user_id: 'b', codigo_cliente: 0 })).toBe(false);
    expect(mesmoCliente({ codigo_cliente: '0' }, { codigo_cliente: 0 })).toBe(false);
  });
});

describe('leitura que falha NÃO libera o envio (Codex P0)', () => {
  it('envelope ilegível ou sem campos → indeterminado', async () => {
    const arm = armazem();
    arm.setItem(K, '{nao json');
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('indeterminado');
    arm.setItem(K, JSON.stringify({ checkoutId: '', fingerprint: 'x', committed: true }));
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('indeterminado');
  });
  it('getItem que lança → indeterminado', async () => {
    const arm = armazem();
    arm.getItem = () => { throw new Error('SecurityError'); };
    expect(lerEnvelopeEstrito(arm, K).estado).toBe('ilegivel');
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('indeterminado');
  });
  it('quota cheia: a reserva devolve gravou=false (o hook não chama a edge)', async () => {
    const arm = armazem();
    arm.setItem = () => { throw new Error('QuotaExceededError'); };
    const r = await aba(arm, 'N').enviar(FP1);
    expect(r.decisao).toBe('new');
    expect(r.decisao === 'new' && r.gravou).toBe(false);
  });
});

describe('chave que muda no meio do pedido (autocadastro trouxe código — Codex P0)', () => {
  const kVelha = chaveEnvelope(VEND_A, 'colacor:7');
  const kNova = chaveEnvelope(VEND_A, 'oben:7');
  it('moverEnvelope leva a trava do carrinho para o par novo', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N', kVelha).enviar(FP1);
    expect(moverEnvelope(arm, kVelha, kNova)).toBe(true);
    expect(lerEnvelope(arm, kVelha)).toBeNull();
    expect((await aba(arm, 'N', kNova).enviar(FP2)).decisao).toBe('conflict');
    expect(idDe(await aba(arm, 'N', kNova).enviar(FP1))).toBe(idDe(r1));
  });
  it('não sobrescreve OUTRO envio comprometido no par novo', async () => {
    const arm = armazem();
    await aba(arm, 'N', kVelha).enviar(FP1);
    const ocupado = await aba(arm, 'M', kNova).enviar(FP2);
    expect(moverEnvelope(arm, kVelha, kNova)).toBe(false);
    expect(lerEnvelope(arm, kNova)?.checkoutId).toBe(idDe(ocupado));
  });
  it('mesmo sem mover, o retry da MESMA cópia na chave nova deriva o mesmo id', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N', kVelha).enviar(FP1);
    expect(idDe(await aba(arm, 'N', kNova).enviar(FP1))).toBe(idDe(r1));
  });
});

describe('envelope legado (chave fixa de antes do PR 2.2)', () => {
  const legado: CheckoutEnvelope = { checkoutId: 'L', fingerprint: FP1, committed: true };
  it('retry do mesmo carrinho com legado pendente → outra_copia; assumido ("id:L") → reuse do id legado', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    const r = await aba(arm, 'N').enviar(FP1);
    expect(r.decisao).toBe('outra_copia');
    expect(nonceParaAssumir(legado)).toBe('id:L');
    expect(await idDoEnvio('id:L', FP1)).toBe('L');
    const r2 = await aba(arm, 'id:L').enviar(FP1);
    expect(r2.decisao).toBe('reuse');
    expect(idDe(r2)).toBe('L');
  });
  it('outro carrinho do mesmo cliente NÃO é absorvido e o legado não é apagado de carona', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    expect(idDe(await aba(arm, 'N').enviar(FP2))).not.toBe('L');
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).not.toBeNull();
  });
  it('legado de OUTRO cliente com os mesmos itens não é reaproveitado (prefixo exato: 12 ≠ 123)', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify({ ...legado, fingerprint: '12#oben:1:2:10.00' }));
    expect(idDe(await aba(arm, 'N').enviar(FP1))).not.toBe('L');
  });
  it('concluir o envio do id legado solta o legado', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    const a = aba(arm, 'id:L');
    a.concluir(await a.enviar(FP1));
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).toBeNull();
  });
  it('descartar o rascunho solta o legado SÓ do mesmo cliente E carrinho', () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    descartarLegadoDoCliente(arm, ['123'], FP2);
    descartarLegadoDoCliente(arm, ['12'], FP1);
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).not.toBeNull();
    descartarLegadoDoCliente(arm, ['123'], FP1);
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).toBeNull();
  });
});

describe('aviso de outra aba (evento storage)', () => {
  it('commit na outra aba = enviou; remoção do que eu conhecia = liberou; resto = nada', () => {
    expect(classificarMudancaOutraAba(JSON.stringify({ checkoutId: 'x', fingerprint: 'f', committed: true }), null)).toBe('enviou');
    expect(classificarMudancaOutraAba(null, 'x')).toBe('liberou');
    expect(classificarMudancaOutraAba(null, null)).toBeNull();
    expect(classificarMudancaOutraAba('{lixo', 'x')).toBeNull();
  });
});
