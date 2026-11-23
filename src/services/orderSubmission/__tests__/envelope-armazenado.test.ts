import { describe, expect, it } from 'vitest';
import {
  CHAVE_ENVELOPE_LEGADA,
  assinaturaItens,
  chaveClienteDaChave,
  chaveClienteEnvelope,
  chaveEnvelope,
  chavesClienteEnvelope,
  classificarMudancaOutraAba,
  comTravaEntreAbas,
  concluirEnvio,
  gravarSeAindaFor,
  idDoEnvio,
  lerEnvelopeEstrito,
  limparIlegiveis,
  mesmoCliente,
  nonceParaAssumir,
  pendenteDoCliente,
  perguntaAindaVale,
  prefixosLegadoDoCliente,
  reservarEnvio,
  type ArmazemEnvelope,
  type PerguntaOutraCopia,
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
function lerEnvelope(arm: ArmazemEnvelope, k: string): CheckoutEnvelope | null {
  const l = lerEnvelopeEstrito(arm, k);
  return l.estado === 'presente' && l.envelope.committed ? l.envelope : null;
}

const VEND_A = 'user-a';
const VEND_B = 'user-b';
const K = chaveEnvelope(VEND_A, 'oben:123');
const FP1 = '123#oben:1:2:10.00';
const FP2 = '123#oben:1:3:10.00';
const criar = (id: string): CheckoutEnvelope => ({ checkoutId: id, fingerprint: '', committed: true });

/** Uma "aba": o nonce da cópia (o hook guarda em `nonceRef` e no rascunho em disco). `chaves[0]` = gravação. */
function aba(arm: ArmazemEnvelope, nonce: string, chaves: string[] = [K], prefixosLegado: string[] = ['123']) {
  return {
    async enviar(fp: string, ignorarPendente: string | null = null): Promise<ReservaEnvio> {
      const idCalculado = await idDoEnvio(nonce, fp);
      return reservarEnvio(arm, { chaves, prefixosLegado, fingerprint: fp, idCalculado, ignorarPendente }, criar);
    },
    concluir(r: ReservaEnvio) { if (r.decisao === 'new' || r.decisao === 'reuse') concluirEnvio(arm, chaves, r.envelope.checkoutId); },
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

describe('nonce LITERAL preso à assinatura (Codex P0 #2, rodada 4)', () => {
  const legado: CheckoutEnvelope = { checkoutId: 'L', fingerprint: FP1, committed: true };
  it('o literal assume o id SÓ com os mesmos itens', async () => {
    expect(nonceParaAssumir(legado)).toBe('id:L:oben:1:2:10.00');
    expect(await idDoEnvio(nonceParaAssumir(legado), FP1)).toBe('L');
  });
  it('outra quantidade com o literal → id DERIVADO novo (pedido novo, nunca "já enviado" falso)', async () => {
    const outro = await idDoEnvio(nonceParaAssumir(legado), FP2);
    expect(outro).not.toBe('L');
    expect(outro).toMatch(/^[0-9a-f]{8}-/);
  });
  it('literal sem assinatura (formato solto `id:L`) nunca vale como literal', async () => {
    expect(await idDoEnvio('id:L', FP1)).not.toBe('L');
  });
});

describe('duas abas / refresh com a MESMA cópia do pedido (o P0)', () => {
  it('as duas abas enviam o mesmo carrinho → o MESMO id (o servidor diz "já enviado")', async () => {
    const arm = armazem();
    const ra = await aba(arm, 'N').enviar(FP1);
    const rb = await aba(arm, 'N').enviar(FP1);
    expect(rb.decisao).toBe('reuse');
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
    expect(rb.decisao === 'outra_copia' && rb.pendente.envelope.checkoutId).toBe(idDe(ra));
    expect(rb.decisao === 'outra_copia' && rb.pendente.chave).toBe(K);
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

  it('"É outro pedido": só o pendente MOSTRADO é ignorado → pedido NOVO com o id desta cópia', async () => {
    const arm = armazem();
    const ra = await aba(arm, 'N1').enviar(FP1);
    const rb = await aba(arm, 'N2').enviar(FP1, idDe(ra));
    expect(rb.decisao).toBe('new');
    expect(idDe(rb)).toBe(await idDoEnvio('N2', FP1));
    expect(idDe(rb)).not.toBe(idDe(ra));
    // ignorar um id que NÃO é o pendente não libera nada
    expect((await aba(arm, 'N3').enviar(FP1, 'outro-id')).decisao).toBe('outra_copia');
  });

  it('remoção que falha no sucesso: o próximo pedido idêntico (nonce novo) cai em outra_copia, nunca "já enviado" calado', async () => {
    const arm = armazem();
    const ra = await aba(arm, 'N1').enviar(FP1);
    const removeItem = arm.removeItem;
    arm.removeItem = () => { throw new Error('falhou'); };
    expect(concluirEnvio(arm, [K], idDe(ra) as string)).toBe(false);
    arm.removeItem = removeItem;
    expect((await aba(arm, 'N2').enviar(FP1)).decisao).toBe('outra_copia');
  });

  it('o sucesso de uma aba não apaga o envelope que OUTRA aba comprometeu depois', async () => {
    const arm = armazem();
    const velho = await aba(arm, 'N1').enviar(FP1);
    concluirEnvio(arm, [K], idDe(velho) as string);
    const novo = await aba(arm, 'N2').enviar(FP2);
    expect(concluirEnvio(arm, [K], idDe(velho) as string)).toBe(true);
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
    const res = (id: string) => reservarEnvio(arm, { chaves: [K], fingerprint: FP1, idCalculado: id, prefixosLegado: [] }, criar);
    const [a, b] = await Promise.all([comTravaEntreAbas('t', () => res(i1), travas), comTravaEntreAbas('t', () => res(i2), travas)]);
    expect([a.decisao, b.decisao]).toEqual(['new', 'reuse']);
    expect(idDe(b)).toBe(idDe(a));
  });

  it('sem Web Locks, a trava roda a seção direto (jsdom/navegador antigo)', async () => {
    expect(await comTravaEntreAbas('t', () => 42, undefined)).toBe(42);
  });
});

describe('a pergunta "é o mesmo pedido?" fica pendente até a escolha (Codex P0 #1 e #3, rodada 4)', () => {
  const pend = { chave: K, envelope: { checkoutId: 'P', fingerprint: FP1, committed: true } };
  const q: PerguntaOutraCopia = { pendente: pend, cliente: { codigo_cliente: 123 }, nonce: 'N2', assinatura: assinaturaItens(FP1) };
  it('vale no mesmo contexto, mesmo que o pendente tenha SUMIDO do armazém (não cai em new)', () => {
    expect(perguntaAindaVale(q, { cliente: { codigo_cliente: 123, local_user_id: 'u' }, nonce: 'N2', fingerprint: 'u#oben:1:2:10.00' })).toBe(true);
  });
  it('caduca com OUTRO cliente, outra cópia (nonce) ou outros itens — a ação não leva o nonce para outro cliente', () => {
    expect(perguntaAindaVale(q, { cliente: { codigo_cliente: 999 }, nonce: 'N2', fingerprint: FP1 })).toBe(false);
    expect(perguntaAindaVale(q, { cliente: { codigo_cliente: 123 }, nonce: 'N9', fingerprint: FP1 })).toBe(false);
    expect(perguntaAindaVale(q, { cliente: { codigo_cliente: 123 }, nonce: null, fingerprint: FP1 })).toBe(false);
    expect(perguntaAindaVale(q, { cliente: { codigo_cliente: 123 }, nonce: 'N2', fingerprint: FP2 })).toBe(false);
    expect(perguntaAindaVale(null, { cliente: { codigo_cliente: 123 }, nonce: 'N2', fingerprint: FP1 })).toBe(false);
  });
});

describe('chave por usuário + cliente', () => {
  it('vendedores diferentes no MESMO computador não compartilham envelope (o B herdava o do A)', async () => {
    const arm = armazem();
    await aba(arm, 'N', [chaveEnvelope(VEND_A, 'oben:123')]).enviar(FP1);
    expect(lerEnvelope(arm, chaveEnvelope(VEND_B, 'oben:123'))).toBeNull();
    expect((await aba(arm, 'M', [chaveEnvelope(VEND_B, 'oben:123')], []).enviar(FP2)).decisao).toBe('new');
  });
  it('identidade do cliente: usuário local (mais estável), senão Oben, senão Colacor, senão nenhuma; 0 não identifica', () => {
    expect(chaveClienteEnvelope({ local_user_id: 'u', codigo_cliente: 9 })).toBe('local:u');
    expect(chaveClienteEnvelope({ codigo_cliente: 9, codigo_cliente_colacor: 8 })).toBe('oben:9');
    expect(chaveClienteEnvelope({ codigo_cliente: 0, codigo_cliente_colacor: 8 })).toBe('colacor:8');
    expect(chaveClienteEnvelope({})).toBeNull();
    expect(chavesClienteEnvelope({ local_user_id: 'u', codigo_cliente: 9, codigo_cliente_colacor: '0' })).toEqual(['local:u', 'oben:9']);
    expect(prefixosLegadoDoCliente({ local_user_id: 'u', codigo_cliente: 9 })).toEqual(['u', '9']);
    expect(chaveClienteDaChave(chaveEnvelope(VEND_A, 'oben:9'), VEND_A)).toBe('oben:9');
    expect(chaveClienteDaChave(chaveEnvelope(VEND_B, 'oben:9'), VEND_A)).toBeNull();
    expect(chaveClienteDaChave(CHAVE_ENVELOPE_LEGADA, VEND_A)).toBeNull();
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
  it('ilegível em OUTRA chave do cliente (ou no legado) também barra; "Trocar e limpar" remove o ilegível', async () => {
    const arm = armazem();
    const kLocal = chaveEnvelope(VEND_A, 'local:u');
    arm.setItem(kLocal, '{lixo');
    expect((await aba(arm, 'N', [K, kLocal]).enviar(FP1)).decisao).toBe('indeterminado');
    expect(pendenteDoCliente(arm, { chaves: [K, kLocal], prefixosLegado: [] })).toBeUndefined();
    limparIlegiveis(arm, { chaves: [K, kLocal], prefixosLegado: [] });
    expect((await aba(arm, 'N', [K, kLocal]).enviar(FP1)).decisao).toBe('new');
    arm.setItem(CHAVE_ENVELOPE_LEGADA, '{lixo');
    expect((await aba(arm, 'M', [K]).enviar(FP2)).decisao).toBe('indeterminado');
  });
  it('quota cheia: a reserva devolve gravou=false (o hook não chama a edge)', async () => {
    const arm = armazem();
    arm.setItem = () => { throw new Error('QuotaExceededError'); };
    const r = await aba(arm, 'N').enviar(FP1);
    expect(r.decisao).toBe('new');
    expect(r.decisao === 'new' && r.gravou).toBe(false);
  });
});

describe('cliente que ganha código no meio do pedido — sem mover chave (Codex P0 #5, rodada 4)', () => {
  const kColacor = chaveEnvelope(VEND_A, 'colacor:7');
  const kOben = chaveEnvelope(VEND_A, 'oben:7');
  it('a cópia que nasceu em colacor:7 segue gravando lá; a aba com a chave nova LÊ as duas e vê o pendente', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N', [kColacor], []).enviar(FP1);
    // outra aba, o cliente já com Oben: grava em oben:7, mas lê colacor:7 também
    expect((await aba(arm, 'M', [kOben, kColacor], []).enviar(FP2)).decisao).toBe('conflict');
    expect((await aba(arm, 'M', [kOben, kColacor], []).enviar(FP1)).decisao).toBe('outra_copia');
    // a mesma cópia, relida na chave nova: o MESMO id (reuse) — e o original continua lá (nada destravou)
    expect(idDe(await aba(arm, 'N', [kOben, kColacor], []).enviar(FP1))).toBe(idDe(r1));
    expect(lerEnvelope(arm, kColacor)?.checkoutId).toBe(idDe(r1));
  });
  it('concluir solta o id em TODAS as chaves do cliente', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N', [kColacor], []).enviar(FP1);
    await aba(arm, 'N', [kOben, kColacor], []).enviar(FP1); // cópia em oben:7
    expect(concluirEnvio(arm, [kOben, kColacor], idDe(r1) as string)).toBe(true);
    expect(lerEnvelope(arm, kColacor)).toBeNull();
    expect(lerEnvelope(arm, kOben)).toBeNull();
  });
});

describe('envelope legado (chave fixa de antes do PR 2.2) — lido como pendente, nunca migrado', () => {
  const legado: CheckoutEnvelope = { checkoutId: 'L', fingerprint: FP1, committed: true };
  it('retry do mesmo carrinho com legado pendente → outra_copia; assumido → reuse do id legado', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    const r = await aba(arm, 'N').enviar(FP1);
    expect(r.decisao).toBe('outra_copia');
    expect(r.decisao === 'outra_copia' && r.pendente.chave).toBe(CHAVE_ENVELOPE_LEGADA);
    const r2 = await aba(arm, nonceParaAssumir(legado)).enviar(FP1);
    expect(r2.decisao).toBe('reuse');
    expect(idDe(r2)).toBe('L');
  });
  it('parcial legado + carrinho EDITADO (só a Colacor mudou) → conflict, a Oben não sai de novo (Codex P0 #4)', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify({ ...legado, fingerprint: '123#colacor:5:1:3.00|oben:1:2:10.00' }));
    const r = await aba(arm, 'N').enviar('123#colacor:5:2:3.00|oben:1:2:10.00');
    expect(r.decisao).toBe('conflict');
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).not.toBeNull();
  });
  it('legado gravado com o código Oben, cliente que GANHOU usuário local: o prefixo antigo ainda casa (Codex P0 #4)', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado)); // prefixo "123" (código Oben)
    const prefixos = prefixosLegadoDoCliente({ local_user_id: 'uuid-novo', codigo_cliente: 123 });
    const r = await aba(arm, 'N', [chaveEnvelope(VEND_A, 'local:uuid-novo')], prefixos).enviar('uuid-novo#oben:1:3:10.00');
    expect(r.decisao).toBe('conflict');
  });
  it('legado de OUTRO cliente com os mesmos itens não conta (prefixo exato: 12 ≠ 123)', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify({ ...legado, fingerprint: '12#oben:1:2:10.00' }));
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('new');
  });
  it('o guard do ORÇAMENTO enxerga o parcial legado (Codex P0 #6)', () => {
    const arm = armazem();
    expect(pendenteDoCliente(arm, { chaves: [K], prefixosLegado: ['123'] })).toBeNull();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    expect(pendenteDoCliente(arm, { chaves: [K], prefixosLegado: ['123'] })?.chave).toBe(CHAVE_ENVELOPE_LEGADA);
    expect(pendenteDoCliente(arm, { chaves: [K], prefixosLegado: ['999'] })).toBeNull();
  });
  it('concluir o envio do id legado solta o legado', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify(legado));
    const a = aba(arm, nonceParaAssumir(legado));
    a.concluir(await a.enviar(FP1));
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).toBeNull();
  });
  it('o retry do PRÓPRIO parcial não é travado por um legado de outro carrinho', async () => {
    const arm = armazem();
    const ra = await aba(arm, 'N').enviar(FP1);
    arm.setItem(CHAVE_ENVELOPE_LEGADA, JSON.stringify({ ...legado, fingerprint: FP2 }));
    const rb = await aba(arm, 'N').enviar(FP1);
    expect(rb.decisao).toBe('reuse');
    expect(idDe(rb)).toBe(idDe(ra));
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
