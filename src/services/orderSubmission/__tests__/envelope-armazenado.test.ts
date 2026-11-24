import { describe, expect, it } from 'vitest';
import {
  CHAVE_ENVELOPE_LEGADA,
  chaveEnvelope,
  classificarMudancaOutraAba,
  comTravaEntreAbas,
  concluirEnvio,
  gravarSeAindaFor,
  clienteParaAdotarNonce,
  idDoEnvio,
  idsDoEnvelope,
  idsDoEnvio,
  lerEnvelopeEstrito,
  lerPendente,
  limparSeIlegivel,
  mesmoCliente,
  prefixoCliente,
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
function lerEnvelope(arm: ArmazemEnvelope, k: string): CheckoutEnvelope | null {
  const l = lerEnvelopeEstrito(arm, k);
  return l.estado === 'presente' && l.envelope.committed ? l.envelope : null;
}

const VEND_A = 'user-a';
const VEND_B = 'user-b';
const KA = chaveEnvelope(VEND_A);
const KB = chaveEnvelope(VEND_B);
const FP1 = '123#oben:1:2:10.00';
const FP2 = '123#oben:1:3:10.00';
const FP_OUTRO_CLIENTE = '999#oben:1:2:10.00';
const criar = (id: string): CheckoutEnvelope => ({ checkoutId: id, fingerprint: '', committed: true, origem: 'web_staff' });

/** Uma "aba" do vendedor `user`: o nonce da cópia (o hook guarda em `nonceRef` e no rascunho em disco). */
function aba(arm: ArmazemEnvelope, nonce: string, user = VEND_A) {
  const chave = chaveEnvelope(user);
  return {
    async enviar(fp: string): Promise<ReservaEnvio> {
      return reservarEnvio(arm, {
        chave, fingerprint: fp, idCalculado: await idDoEnvio(nonce, fp), idsCalculados: await idsDoEnvio(nonce, fp, ''),
      }, criar);
    },
    concluir(r: ReservaEnvio) { if (r.decisao === 'new' || r.decisao === 'reuse') concluirEnvio(arm, chave, r.envelope.checkoutId); },
  };
}
const idDe = (r: ReservaEnvio) => (r.decisao === 'new' || r.decisao === 'reuse' ? r.envelope.checkoutId : null);

describe('idDoEnvio — o checkoutId DERIVA do nonce da cópia + itens', () => {
  it('determinístico, formato UUID (versão 8, variante RFC)', async () => {
    const a = await idDoEnvio('N', FP1);
    expect(a).toBe(await idDoEnvio('N', FP1));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('outro carrinho ou outra cópia → outro id', async () => {
    const a = await idDoEnvio('N', FP1);
    expect(await idDoEnvio('N', FP2)).not.toBe(a);
    expect(await idDoEnvio('M', FP1)).not.toBe(a);
  });
  it('o prefixo do cliente não entra (o cliente ganhar usuário local não muda o id)', async () => {
    expect(await idDoEnvio('N', 'uuid-local#oben:1:2:10.00')).toBe(await idDoEnvio('N', FP1));
  });
  it('nonce vazio é erro (nunca um id "de ninguém")', async () => {
    await expect(idDoEnvio('', FP1)).rejects.toThrow('idDoEnvio: nonce vazio');
  });
});

describe('reservarEnvio — a regra da main, lida do ARMAZÉM do usuário', () => {
  it('sem envio pendente → new com o id derivado, gravado comprometido na chave do usuário', async () => {
    const arm = armazem();
    const r = await aba(arm, 'N').enviar(FP1);
    expect(r.decisao).toBe('new');
    expect(idDe(r)).toBe(await idDoEnvio('N', FP1));
    expect(lerEnvelope(arm, KA)).toMatchObject({ checkoutId: idDe(r), fingerprint: FP1, committed: true, origem: 'web_staff' });
  });

  it('duas abas, cópias DIFERENTES, mesmo carrinho → a 2ª REUSA o id da 1ª (um PV só)', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N1').enviar(FP1);
    const r2 = await aba(arm, 'N2').enviar(FP1);
    expect(r2.decisao).toBe('reuse');
    expect(idDe(r2)).toBe(idDe(r1));
  });

  it('reuse mantém a metadata da ponte CONGELADA na criação', async () => {
    const arm = armazem();
    await aba(arm, 'N1').enviar(FP1);
    const r2 = await aba(arm, 'N2').enviar(FP1);
    expect(r2.decisao === 'reuse' && r2.envelope.origem).toBe('web_staff');
  });

  it('envio pendente com OUTRO carrinho → conflict (a conta já enviada não sai de novo)', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N').enviar(FP1);
    const r2 = await aba(arm, 'N').enviar(FP2);
    expect(r2.decisao).toBe('conflict');
    expect(r2.decisao === 'conflict' && r2.envelope.checkoutId).toBe(idDe(r1));
    expect(lerEnvelope(arm, KA)?.fingerprint).toBe(FP1); // o pendente ficou intacto
  });

  it('o envelope perdido (armazém limpo) com o mesmo rascunho e carrinho deriva o MESMO id', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N').enviar(FP1);
    arm.removeItem(KA);
    const r2 = await aba(arm, 'N').enviar(FP1);
    expect(r2.decisao).toBe('new');
    expect(idDe(r2)).toBe(idDe(r1)); // o servidor deduplica
  });

  it('depois do sucesso total o mesmo carrinho é pedido NOVO (com o nonce girado)', async () => {
    const arm = armazem();
    const a = aba(arm, 'N');
    const r1 = await a.enviar(FP1);
    a.concluir(r1);
    const r2 = await aba(arm, 'N-girado').enviar(FP1);
    expect(r2.decisao).toBe('new');
    expect(idDe(r2)).not.toBe(idDe(r1));
  });

  it('o vendedor B NUNCA herda o envelope do vendedor A (o defeito da chave fixa)', async () => {
    const arm = armazem();
    await aba(arm, 'N', VEND_A).enviar(FP1);
    const rb = await aba(arm, 'M', VEND_B).enviar(FP2);
    expect(rb.decisao).toBe('new');
    expect(lerEnvelope(arm, KA)?.fingerprint).toBe(FP1);
    expect(lerEnvelope(arm, KB)?.fingerprint).toBe(FP2);
  });

  it('chave do usuário ilegível → indeterminado (nunca "não há pendente")', async () => {
    const arm = armazem();
    arm.setItem(KA, '{lixo');
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('indeterminado');
    arm.setItem(KA, JSON.stringify({ checkoutId: '', fingerprint: FP1, committed: true }));
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('indeterminado');
  });

  it('getItem que lança → indeterminado', async () => {
    const arm = { ...armazem(), getItem: () => { throw new Error('SecurityError'); } };
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('indeterminado');
  });

  it('o armazém recusa gravar (quota) → gravou=false (quem chama não envia)', async () => {
    const base = armazem();
    const arm = { ...base, setItem: () => { throw new Error('QuotaExceededError'); } };
    const r = await aba(arm, 'N').enviar(FP1);
    expect(r.decisao === 'new' && r.gravou).toBe(false);
  });

  it('envelope NÃO comprometido não trava nada', async () => {
    const arm = armazem();
    arm.setItem(KA, JSON.stringify({ checkoutId: 'x', fingerprint: FP2, committed: false }));
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('new');
  });
});

describe('o legado (chave fixa de antes do PR 2.2) — pendente SÓ do cliente dele', () => {
  const legado = (fp: string, id = 'id-legado') => JSON.stringify({ checkoutId: id, fingerprint: fp, committed: true, origem: 'web_staff' });

  it('mesmo cliente, mesmo carrinho → reuse com o id LEGADO (o parcial em voo no deploy não duplica)', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, legado(FP1));
    const r = await aba(arm, 'N').enviar(FP1);
    expect(r.decisao).toBe('reuse');
    expect(idDe(r)).toBe('id-legado');
    expect(lerEnvelope(arm, KA)?.checkoutId).toBe('id-legado');
  });

  it('mesmo cliente, outro carrinho → conflict', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, legado(FP1));
    expect((await aba(arm, 'N').enviar(FP2)).decisao).toBe('conflict');
  });

  it('OUTRO cliente → o legado não trava (não é dele)', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, legado(FP1));
    expect((await aba(arm, 'N').enviar(FP_OUTRO_CLIENTE)).decisao).toBe('new');
  });

  it('legado ilegível conta como ausente (como a main lia) — não trava o autoatendimento', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, '{lixo');
    expect((await aba(arm, 'N').enviar(FP1)).decisao).toBe('new');
  });

  it('a chave do usuário tem precedência sobre o legado', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N').enviar(FP2);
    arm.setItem(CHAVE_ENVELOPE_LEGADA, legado(FP1));
    const r2 = await aba(arm, 'N').enviar(FP2);
    expect(r2.decisao).toBe('reuse');
    expect(idDe(r2)).toBe(idDe(r1));
  });

  it('concluir o envio do legado solta o legado e a cópia na chave do usuário', async () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, legado(FP1));
    const a = aba(arm, 'N');
    a.concluir(await a.enviar(FP1));
    expect(arm.getItem(CHAVE_ENVELOPE_LEGADA)).toBeNull();
    expect(arm.getItem(KA)).toBeNull();
  });

  it('lerPendente sem cliente (prefixo vazio) ignora o legado', () => {
    const arm = armazem();
    arm.setItem(CHAVE_ENVELOPE_LEGADA, legado(FP1));
    expect(lerPendente(arm, KA, '')).toEqual({ estado: 'ok', pendente: null });
    expect(lerPendente(arm, KA, '123')).toMatchObject({ estado: 'ok', pendente: { chave: CHAVE_ENVELOPE_LEGADA } });
  });
});

describe('concluir, limpar e gravar sem atropelar outra aba', () => {
  it('concluirEnvio só solta o envelope com ESTE id (o commit novo de outra aba fica)', async () => {
    const arm = armazem();
    const r1 = await aba(arm, 'N1').enviar(FP1);
    arm.setItem(KA, JSON.stringify({ checkoutId: 'de-outra-aba', fingerprint: FP2, committed: true }));
    expect(concluirEnvio(arm, KA, idDe(r1) as string)).toBe(true);
    expect(lerEnvelope(arm, KA)?.checkoutId).toBe('de-outra-aba');
  });

  it('gravarSeAindaFor recusa quando o guardado já é outro envelope', async () => {
    const arm = armazem();
    const r = await aba(arm, 'N').enviar(FP1);
    expect(gravarSeAindaFor(arm, KA, 'outro', null)).toBe(false);
    expect(lerEnvelope(arm, KA)?.checkoutId).toBe(idDe(r));
    expect(gravarSeAindaFor(arm, KA, idDe(r) as string, null)).toBe(true);
    expect(arm.getItem(KA)).toBeNull();
  });

  it('limparSeIlegivel apaga SÓ a chave ilegível (nunca um envelope legível)', async () => {
    const arm = armazem();
    arm.setItem(KA, '{lixo');
    limparSeIlegivel(arm, KA);
    expect(arm.getItem(KA)).toBeNull();
    const r = await aba(arm, 'N').enviar(FP1);
    limparSeIlegivel(arm, KA);
    expect(lerEnvelope(arm, KA)?.checkoutId).toBe(idDe(r));
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
    const [i1, i2] = [await idDoEnvio('N1', FP1), await idDoEnvio('N2', FP1)]; // duas cópias, mesmo carrinho
    const res = async (id: string) => reservarEnvio(arm, { chave: KA, fingerprint: FP1, idCalculado: id, idsCalculados: await idsDoEnvio(id, FP1, '') }, criar);
    const [a, b] = await Promise.all([comTravaEntreAbas('t', () => res(i1), travas), comTravaEntreAbas('t', () => res(i2), travas)]);
    expect([a.decisao, b.decisao]).toEqual(['new', 'reuse']);
    expect(idDe(b)).toBe(idDe(a));
  });

  it('sem Web Locks, a trava roda a seção direto (jsdom/navegador antigo)', async () => {
    expect(await comTravaEntreAbas('t', () => 42, undefined)).toBe(42);
  });
});

describe('auxiliares', () => {
  it('prefixoCliente', () => {
    expect(prefixoCliente(FP1)).toBe('123');
    expect(prefixoCliente('#oben:1:2:10.00')).toBe('');
    expect(prefixoCliente('sem-cerquilha')).toBe('');
  });
  it('mesmoCliente: compartilhar uma identidade não-vazia; código 0 não identifica', () => {
    expect(mesmoCliente({ codigo_cliente: 123 }, { codigo_cliente: '123', local_user_id: 'u' })).toBe(true);
    expect(mesmoCliente({ codigo_cliente: 123 }, { codigo_cliente: 124 })).toBe(false);
    expect(mesmoCliente({ codigo_cliente: 0 }, { codigo_cliente: 0 })).toBe(false);
    expect(mesmoCliente(null, { codigo_cliente: 1 })).toBe(false);
  });
  it('classificarMudancaOutraAba', () => {
    expect(classificarMudancaOutraAba(JSON.stringify({ checkoutId: 'x', fingerprint: 'f', committed: true }), null)).toBe('enviou');
    expect(classificarMudancaOutraAba(null, 'x')).toBe('liberou');
    expect(classificarMudancaOutraAba(null, null)).toBeNull();
    expect(classificarMudancaOutraAba('{lixo', 'x')).toBeNull();
  });
});

// ─── P0 do Codex no PR 2.2: um id POR CONTA + o nonce que sobrevive à restauração sem cliente ───
// O "servidor": `sales_orders` com UNIQUE (checkout_id, account) e `pedido_por_checkout` — o mesmo id na
// mesma conta devolve o PV que já existe (nunca um 2º); id novo cria PV novo.
function servidor() {
  const pvs = new Map<string, { account: string; itens: string }>();
  return {
    enviar(r: ReservaEnvio, fp: string) {
      if (r.decisao !== 'new' && r.decisao !== 'reuse') throw new Error(`não enviou: ${r.decisao}`);
      const ids = idsDoEnvelope(r.envelope);
      for (const conta of ['oben', 'colacor'] as const) {
        const itens = fp.slice(fp.indexOf('#') + 1).split('|').filter(l => l.startsWith(`${conta}:`)).join('|');
        if (!itens) continue;
        const k = `${ids[conta]}|${conta}`;
        if (!pvs.has(k)) pvs.set(k, { account: conta, itens });
      }
    },
    pvsDa(conta: string) { return [...pvs.values()].filter(p => p.account === conta); },
  };
}

describe('P0 Codex 2.2 — id por conta: mudar uma conta não muda o id da outra', () => {
  const FP_AB = '123#oben:1:2:10.00|colacor:7:1:5.00';
  const FP_AB_COLACOR_MUDOU = '123#oben:1:2:10.00|colacor:7:2:5.00';
  const FP_AB_OBEN_MUDOU = '123#oben:1:3:10.00|colacor:7:1:5.00';

  it('cenário 2: a aba B muda só a quantidade Colacor depois de A concluir → NÃO nasce 2º PV Oben', async () => {
    const arm = armazem();
    const srv = servidor();
    const a = aba(arm, 'nonce-rascunho');
    const b = aba(arm, 'nonce-rascunho'); // B restaurou o MESMO rascunho (mesmo nonce)
    const ra = await a.enviar(FP_AB);
    srv.enviar(ra, FP_AB);
    a.concluir(ra); // sucesso TOTAL de A: o envelope sai do armazém
    const rb = await b.enviar(FP_AB_COLACOR_MUDOU);
    expect(rb.decisao).toBe('new');
    srv.enviar(rb, FP_AB_COLACOR_MUDOU);
    expect(srv.pvsDa('oben')).toHaveLength(1); // a Oben de B achou a de A (mesmo id) — sem duplicar
    expect(srv.pvsDa('colacor')).toHaveLength(2); // a Colacor mudou de verdade: é outro pedido
  });

  it('mudar só a Oben não muda o id Colacor nem o da OS; mudar a OS não muda os de produto', async () => {
    const base = await idsDoEnvio('n', FP_AB, 'os-x');
    const obenMudou = await idsDoEnvio('n', FP_AB_OBEN_MUDOU, 'os-x');
    expect(obenMudou.oben).not.toBe(base.oben);
    expect(obenMudou.colacor).toBe(base.colacor);
    expect(obenMudou.afiacao).toBe(base.afiacao);
    const osMudou = await idsDoEnvio('n', FP_AB, 'os-y');
    expect(osMudou.afiacao).not.toBe(base.afiacao);
    expect(osMudou.oben).toBe(base.oben);
    expect(osMudou.colacor).toBe(base.colacor);
  });

  it('os três ids são distintos entre si, independem do cliente e da ordem, e outro nonce dá outros ids', async () => {
    const ids = await idsDoEnvio('n', FP_AB, '');
    expect(new Set([ids.oben, ids.colacor, ids.afiacao]).size).toBe(3);
    expect(await idsDoEnvio('n', '456#colacor:7:1:5.00|oben:1:2:10.00', '')).toEqual(ids);
    const outro = await idsDoEnvio('outro-nonce', FP_AB, '');
    expect(outro.oben).not.toBe(ids.oben);
    expect(outro.colacor).not.toBe(ids.colacor);
    expect(outro.afiacao).not.toBe(ids.afiacao);
    await expect(idsDoEnvio('', FP_AB, '')).rejects.toThrow('idsDoEnvio: nonce vazio');
  });

  it('o envelope novo CONGELA os ids; o reuse devolve os MESMOS; o legado usa o checkoutId em todas', async () => {
    const arm = armazem();
    const a = aba(arm, 'n');
    const r1 = await a.enviar(FP_AB);
    const r2 = await a.enviar(FP_AB); // reenvio (falha parcial): reuse
    expect(r2.decisao).toBe('reuse');
    if ((r1.decisao !== 'new') || r2.decisao !== 'reuse') throw new Error('decisões');
    expect(idsDoEnvelope(r2.envelope)).toEqual(await idsDoEnvio('n', FP_AB, ''));
    expect(idsDoEnvelope(r2.envelope)).toEqual(idsDoEnvelope(r1.envelope));
    const legado: CheckoutEnvelope = { checkoutId: 'id-da-main', fingerprint: FP_AB, committed: true };
    expect(idsDoEnvelope(legado)).toEqual({ oben: 'id-da-main', colacor: 'id-da-main', afiacao: 'id-da-main' });
    expect(idsDoEnvelope({ ...legado, idsPorConta: { oben: 'x', colacor: '', afiacao: 'z' } }).colacor).toBe('id-da-main');
  });
});

describe('P0 Codex 2.2 — o nonce sobrevive à restauração antes de o cliente carregar', () => {
  // Cliente do cenário: só tem cadastro na Colacor (código Oben 0 não identifica ninguém).
  const DONO = { local_user_id: null, codigo_cliente: 0, codigo_cliente_colacor: 55 };

  it('cenário 1: código Oben 0, rascunho restaurado SEM cliente na tela → adota o nonce e NÃO nasce 2º PV Colacor', async () => {
    const arm = armazem();
    const srv = servidor();
    const FP_C = '#colacor:7:1:5.00'; // customerKey '' (sem usuário local, código Oben 0)
    const ra = await aba(arm, 'nonce-de-A').enviar(FP_C);
    srv.enviar(ra, FP_C);
    aba(arm, 'nonce-de-A').concluir(ra);
    // A aba B restaura o rascunho de A antes de o cliente carregar (identidade atual = null).
    const dono = clienteParaAdotarNonce('nonce-de-A', DONO, null);
    expect(dono).not.toBeNull();
    // O cliente chega: o efeito de troca de cliente mantém o nonce (é o MESMO cliente).
    expect(mesmoCliente(dono, { local_user_id: null, codigo_cliente: 0, codigo_cliente_colacor: 55 })).toBe(true);
    const rb = await aba(arm, 'nonce-de-A').enviar(FP_C);
    srv.enviar(rb, FP_C);
    expect(srv.pvsDa('colacor')).toHaveLength(1);
  });

  it('o cliente que chega é OUTRO → o efeito derruba o nonce (nunca "já enviado" com o PV de outro cliente)', () => {
    const dono = clienteParaAdotarNonce('n', DONO, null);
    expect(mesmoCliente(dono, { codigo_cliente: 0, codigo_cliente_colacor: 99 })).toBe(false);
  });

  it('com cliente na tela: adota se for o dono (mesclando), recusa se for outro; rascunho sem dono → o da tela', () => {
    expect(clienteParaAdotarNonce('n', DONO, { local_user_id: 'u1', codigo_cliente: 0, codigo_cliente_colacor: 55 }))
      .toEqual({ local_user_id: 'u1', codigo_cliente: 0, codigo_cliente_colacor: 55 });
    expect(clienteParaAdotarNonce('n', DONO, { codigo_cliente: 0, codigo_cliente_colacor: 99 })).toBeNull();
    expect(clienteParaAdotarNonce('n', null, { codigo_cliente: 123 })).toEqual({ codigo_cliente: 123 });
  });

  it('sem dono gravado e sem cliente na tela, nonce inválido ou dono ilegível → não adota', () => {
    expect(clienteParaAdotarNonce('n', null, null)).toBeNull();
    expect(clienteParaAdotarNonce('n', { codigo_cliente: 0, codigo_cliente_colacor: '0' }, null)).toBeNull();
    expect(clienteParaAdotarNonce('n', 'lixo', null)).toBeNull();
    expect(clienteParaAdotarNonce('', DONO, null)).toBeNull();
    expect(clienteParaAdotarNonce(42, DONO, null)).toBeNull();
  });
});
