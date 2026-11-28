import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Follow-ups do Codex r1 do #4271 (P0-7 e P0-4) — FIAÇÃO ──
// O hook é grande demais para renderizar com o envio inteiro (vendedor, cadastro, formas, ensure).
// Precedente: useUnifiedOrder.envioRobusto.test.ts / dadosPerdidos.test.ts — prova pela ORDEM no texto.
const raiz = resolve(__dirname, '../../..');
const hook = readFileSync(resolve(raiz, 'src/hooks/useUnifiedOrder.ts'), 'utf8');
const selecao = readFileSync(resolve(raiz, 'src/hooks/unifiedOrder/useCustomerSelection.ts'), 'utf8');

function posicao(texto: string, agulha: string, desde = 0): number {
  const i = texto.indexOf(agulha, desde);
  expect(i, `não encontrado: ${agulha}`).toBeGreaterThan(-1);
  return i;
}

describe('P0-7: envelope que não foi gravado no disco barra o envio', () => {
  const ini = posicao(hook, 'const envelopeAnterior = checkoutEnvRef.current;');
  const envio = posicao(hook, 'await submitOrderService({', ini);
  const trecho = hook.slice(ini, envio);

  it('a gravação do envelope é CONFERIDA antes de comprometer e de chamar o service', () => {
    const guarda = posicao(trecho, 'if (!persistCheckoutEnv(checkoutEnvRef.current) && !envioJaProtegidoNoDisco(checkoutEnvRef.current.checkoutId)) {');
    const comprometer = posicao(trecho, 'cicloRascunhoRef.current.aoComprometer?.();');
    expect(guarda).toBeLessThan(comprometer);
  });

  it('na falha: volta a memória ao envelope anterior, registra o motivo e sai', () => {
    const guarda = posicao(trecho, 'if (!persistCheckoutEnv(checkoutEnvRef.current) && !envioJaProtegidoNoDisco(checkoutEnvRef.current.checkoutId)) {');
    const fim = posicao(trecho, '\n      }\n', guarda);
    const ramo = trecho.slice(guarda, fim);
    expect(ramo).toContain('checkoutEnvRef.current = envelopeAnterior;');
    expect(ramo).toContain("falhouLocal('envelope_nao_gravado');");
    expect(ramo).toContain('toast.error(');
    expect(ramo).toMatch(/\n\s+return;$/);
  });

  it('o envelope anterior é lido ANTES de o ramo new/reuse reescrever a ref', () => {
    const decisao = posicao(hook, "if (decision === 'new') {", ini);
    expect(ini).toBeLessThan(decisao);
  });
});

describe('P0-4: "Criar perfil e cadastrar ferramenta" não carimba o cliente trocado', () => {
  const ini = posicao(hook, 'const handleStaffAddTool = async () => {');
  const fim = posicao(hook, '\n  };\n', ini);
  const corpo = hook.slice(ini, fim);

  it('lê o token da seleção ANTES do primeiro await', () => {
    const token = posicao(corpo, 'const tokenInicial = tokenDaSelecao();');
    const primeiroAwait = posicao(corpo, 'await ');
    expect(token).toBeLessThan(primeiroAwait);
    expect(corpo).toContain('const seTrocou = () => tokenDaSelecao() !== tokenInicial;');
  });

  it('cada await é seguido do teste de troca antes de qualquer escrita de cliente', () => {
    const escritas = ['setCustomerUserId(', 'setSelectedCustomer(', 'loadUserTools(', 'setAddToolDialogOpen(true)', 'toast.'];
    let desde = posicao(corpo, 'setCreatingLocalProfile(true);');
    let awaits = 0;
    for (;;) {
      const a = corpo.indexOf('await ', desde);
      if (a < 0) break;
      awaits++;
      const fimDaChamada = corpo.indexOf(';', a);
      const guarda = corpo.indexOf('if (seTrocou()) return;', fimDaChamada);
      expect(guarda, `await #${awaits} sem guarda`).toBeGreaterThan(-1);
      const proximaEscrita = Math.min(...escritas.map(e => {
        const i = corpo.indexOf(e, fimDaChamada);
        return i < 0 ? Infinity : i;
      }));
      expect(guarda, `await #${awaits}: escrita antes da guarda`).toBeLessThan(proximaEscrita);
      desde = guarda + 1;
    }
    expect(awaits).toBe(3);
  });

  it('o erro atrasado do cliente anterior não vira toast na tela do cliente novo', () => {
    const c = posicao(corpo, '} catch (e) {');
    const guarda = posicao(corpo, 'if (seTrocou()) return;', c);
    expect(guarda).toBeLessThan(posicao(corpo, "toast.error('Erro'", c));
  });

  it('o token vem do selectionTokenRef (o mesmo que selectCustomer/clearCustomer incrementam)', () => {
    expect(selecao).toContain('const tokenDaSelecao = useCallback(() => selectionTokenRef.current, []);');
    expect(selecao).toMatch(/selectCustomer, clearCustomer, waitForAccountEnsure, tokenDaSelecao,/);
  });
});
