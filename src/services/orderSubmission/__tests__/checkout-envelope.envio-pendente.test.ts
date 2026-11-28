import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  carrinhoEhEnvioPendente, itensDaFingerprintDoCarrinho, decidirEnvelopeDoCliente, type CheckoutEnvelope,
  gravarEnvelopeNoDisco, lerEnvelopeDoDisco, envioJaProtegidoNoDisco, CHECKOUT_ENV_KEY,
} from '../checkout-envelope';

// P0-5 (follow-up Codex do #4271): a reprecificação automática não pode mexer no carrinho do envio pendente.
const produto = (account: string, codigo: number, quantity: number, unit_price: number) => ({
  type: 'product', account, quantity, unit_price, product: { omie_codigo_produto: codigo },
});
const CARRINHO = [produto('oben', 11, 2, 10), produto('colacor', 22, 1, 7.5)];
const UUID_A = '6f1c2a9e-0000-4000-8000-00000000000a';

function envelopeDe(cart: typeof CARRINHO, committed = true): CheckoutEnvelope {
  const { fingerprint } = decidirEnvelopeDoCliente(null, { customerUserId: UUID_A, localUserId: UUID_A, codigoCliente: 173 }, itensDaFingerprintDoCarrinho(cart));
  return { checkoutId: 'ck-1', fingerprint, committed, customerUserId: UUID_A, origem: 'web_staff', atendimentoId: null } as CheckoutEnvelope;
}

describe('itensDaFingerprintDoCarrinho', () => {
  it('só produto Oben/Colacor entra (serviço e tinta de outra conta ficam fora)', () => {
    const itens = itensDaFingerprintDoCarrinho([
      ...CARRINHO,
      { type: 'service', quantity: 1, unit_price: 50 },
      produto('afiacao', 33, 1, 1),
    ]);
    expect(itens).toEqual([
      { account: 'oben', omie_codigo_produto: 11, quantity: 2, unit_price: 10 },
      { account: 'colacor', omie_codigo_produto: 22, quantity: 1, unit_price: 7.5 },
    ]);
  });
});

describe('carrinhoEhEnvioPendente', () => {
  const env = envelopeDe(CARRINHO);

  it('CONTROLE: o carrinho idêntico ao enviado É o envio pendente (e o submit o reusaria)', () => {
    expect(carrinhoEhEnvioPendente(env, itensDaFingerprintDoCarrinho(CARRINHO))).toBe(true);
    expect(decidirEnvelopeDoCliente(env, { customerUserId: UUID_A, localUserId: UUID_A, codigoCliente: 173 },
      itensDaFingerprintDoCarrinho(CARRINHO)).decision).toBe('reuse');
  });

  it('a ordem dos itens não importa', () => {
    expect(carrinhoEhEnvioPendente(env, itensDaFingerprintDoCarrinho([...CARRINHO].reverse()))).toBe(true);
  });

  it('preço reprecificado em 1 centavo já NÃO é o mesmo envio (é exatamente o que a trava impede)', () => {
    const repreciado = [produto('oben', 11, 2, 10.01), CARRINHO[1]];
    expect(carrinhoEhEnvioPendente(env, itensDaFingerprintDoCarrinho(repreciado))).toBe(false);
    expect(decidirEnvelopeDoCliente(env, { customerUserId: UUID_A, localUserId: UUID_A, codigoCliente: 173 },
      itensDaFingerprintDoCarrinho(repreciado)).decision).toBe('conflict');
  });

  it('envelope NÃO comprometido não congela nada', () => {
    expect(carrinhoEhEnvioPendente(envelopeDe(CARRINHO, false), itensDaFingerprintDoCarrinho(CARRINHO))).toBe(false);
  });

  it('sem envelope, carrinho vazio ou outros itens → não congela', () => {
    expect(carrinhoEhEnvioPendente(null, itensDaFingerprintDoCarrinho(CARRINHO))).toBe(false);
    expect(carrinhoEhEnvioPendente(env, [])).toBe(false);
    expect(carrinhoEhEnvioPendente(env, itensDaFingerprintDoCarrinho([CARRINHO[0]]))).toBe(false);
    expect(carrinhoEhEnvioPendente(env, itensDaFingerprintDoCarrinho([produto('oben', 11, 3, 10), CARRINHO[1]]))).toBe(false);
  });

  it('não depende do usuário selecionado: na (re)seleção o usuário fica nulo e a trava não pisca', () => {
    // A chave do cliente não entra na comparação — só os itens.
    const envOutraChave = { ...env, fingerprint: `999#${env.fingerprint.split('#')[1]}` };
    expect(carrinhoEhEnvioPendente(envOutraChave, itensDaFingerprintDoCarrinho(CARRINHO))).toBe(true);
  });

  it('envelope SÓ de serviço (itens vazios na fp) não congela o carrinho vazio', () => {
    expect(carrinhoEhEnvioPendente(envelopeDe([]), [])).toBe(false);
  });

  it('envelope legado com fp sem "#" não congela (fail-open aqui é o comportamento de sempre)', () => {
    expect(carrinhoEhEnvioPendente({ ...env, fingerprint: 'lixo' }, itensDaFingerprintDoCarrinho(CARRINHO))).toBe(false);
  });
});

// P0-7: o disco é a proteção. Um Storage em memória, com `setItem` que pode recusar (cota cheia).
class StorageFalso {
  dados = new Map<string, string>();
  recusar = false;
  getItem(k: string) { return this.dados.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (this.recusar) throw new DOMException('cheio', 'QuotaExceededError');
    this.dados.set(k, v);
  }
  removeItem(k: string) { this.dados.delete(k); }
}

describe('envelope no disco (P0-7)', () => {
  let disco: StorageFalso;
  beforeEach(() => { disco = new StorageFalso(); vi.stubGlobal('localStorage', disco); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('CONTROLE: gravar devolve true e o envelope volta igual', () => {
    const env = envelopeDe(CARRINHO);
    expect(gravarEnvelopeNoDisco(env)).toBe(true);
    expect(lerEnvelopeDoDisco()).toEqual(env);
    expect(disco.getItem(CHECKOUT_ENV_KEY)).not.toBeNull();
  });

  it('cota cheia: gravar devolve FALSE e o disco fica como estava', () => {
    disco.recusar = true;
    expect(gravarEnvelopeNoDisco(envelopeDe(CARRINHO))).toBe(false);
    expect(lerEnvelopeDoDisco()).toBeNull();
  });

  it('envio já protegido: só quando o disco tem o MESMO checkoutId comprometido', () => {
    const env = envelopeDe(CARRINHO);
    expect(envioJaProtegidoNoDisco('ck-1')).toBe(false); // disco vazio
    gravarEnvelopeNoDisco(env);
    expect(envioJaProtegidoNoDisco('ck-1')).toBe(true);
    expect(envioJaProtegidoNoDisco('ck-outro')).toBe(false); // envelope NOVO não está no disco
    gravarEnvelopeNoDisco(envelopeDe(CARRINHO, false));
    expect(envioJaProtegidoNoDisco('ck-1')).toBe(false); // não comprometido não protege
  });
});

describe('fiação no hook', () => {
  const hook = readFileSync(resolve(__dirname, '../../../hooks/useUnifiedOrder.ts'), 'utf8');

  it('o efeito de reprecificação devolve `prev` intacto quando o carrinho é o envio pendente', () => {
    const ini = hook.indexOf('if (precoPartidaLoading) return;');
    expect(ini).toBeGreaterThan(-1);
    const trava = hook.indexOf('if (carrinhoEhEnvioPendente(checkoutEnvRef.current, itensDaFingerprintDoCarrinho(prev))) return prev;', ini);
    const reprecifica = hook.indexOf('const novo = getProductPrice(p.product);', ini);
    expect(trava).toBeGreaterThan(ini);
    expect(trava).toBeLessThan(reprecifica);
  });

  it('o envio monta a fp com o MESMO helper', () => {
    expect(hook).toContain('const fpItems = itensDaFingerprintDoCarrinho([...obenProductItems, ...colacorProductItems]);');
  });
});
