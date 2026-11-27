import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 8.2 (rodada 3): cliente do pedido CONFIRMADO no app — FIAÇÃO ──
// O comportamento é provado nos puros (cadastro-cliente.test.ts, motivos-envio.test.ts) e no service
// (submitOrder.test.ts). Hook e página são grandes demais para renderizar aqui; este arquivo prova que
// eles USAM os puros (precedente: useUnifiedOrder.vendedorFechado.test.ts).
const raiz = resolve(__dirname, '../../..');
const ler = (p: string) => readFileSync(resolve(raiz, p), 'utf8');
const selecao = ler('src/hooks/unifiedOrder/useCustomerSelection.ts');
const hook = ler('src/hooks/useUnifiedOrder.ts');
const pagina = ler('src/pages/UnifiedOrder.tsx');

const corpoDoSubmit = () => {
  const ini = hook.indexOf('const submitOrder = useCallback(');
  const trava = hook.indexOf('executarComTravaDeEnvio(submittingRef', ini);
  expect(ini).toBeGreaterThan(-1);
  expect(trava).toBeGreaterThan(ini);
  return hook.slice(ini, trava);
};

describe('8.2 — a busca do cadastro distingue erro de ausência', () => {
  it('erro do mapeamento ainda tenta o documento (como na main) e só LANÇA se nada achar', () => {
    expect(selecao).toContain('erroMapeamento = mappingError ?? null;');
    const ini = selecao.indexOf('erroMapeamento = mappingError');
    const doc = selecao.indexOf('await clientePorDocumento(', ini);
    const lanca = selecao.indexOf('if (!localUserId && erroMapeamento) throw erroMapeamento;', ini);
    expect(doc).toBeGreaterThan(ini);
    expect(lanca).toBeGreaterThan(doc);
  });

  it('busca falhou → RELANÇA para o catch da seleção, como na main (Codex r2 P0-4: seguia até o autocadastro)', () => {
    expect(selecao).toMatch(/setEstadoCadastro\(interpretarCadastro\(localUserId, erroCadastro\)\);\s*if \(erroCadastro\) throw erroCadastro;/);
  });

  it('sem "Revalidar" que mantém o carrinho (Codex r2: 4 P0) — a saída é "Trocar"', () => {
    expect(selecao).not.toContain('revalidarCadastro');
    expect(hook).not.toContain('revalidarCadastro');
  });

  it('o estado vem do intérprete puro, com o erro da busca', () => {
    expect(selecao).toContain('setEstadoCadastro(interpretarCadastro(localUserId, erroCadastro))');
  });
});

describe('8.2 — caminho de envio do staff confere o cadastro ANTES da trava', () => {
  it('o submit chama o guard e retorna quando bloqueia', () => {
    expect(corpoDoSubmit()).toMatch(/const bloqueioCadastro = bloqueioDoCadastro\(\);\s*if \(bloqueioCadastro\) \{\s*toast\.error\(bloqueioCadastro\);\s*return;/);
  });

  it('o guard: autoatendimento passa; "confirmado" sem id conta como não identificado; mensagem do puro', () => {
    const ini = hook.indexOf('const bloqueioDoCadastro = useCallback(');
    const g = hook.slice(ini, hook.indexOf('}, [', ini));
    expect(g).toContain('if (isCustomerMode) return null;');
    expect(g).toContain("!customerUserId && estadoCadastro === 'confirmado' ? 'indisponivel'");
    expect(g).toContain('return mensagemBloqueioCadastro(estadoEfetivo);');
  });

  it('o useCallback do submit depende de estadoCadastro (sem closure velha)', () => {
    const ini = hook.indexOf('const submitOrder = useCallback(');
    const abre = hook.indexOf('\n  }, [', ini);
    const deps = hook.slice(abre, hook.indexOf(']);', abre));
    expect(deps).toContain('bloqueioDoCadastro');
    const gi = hook.indexOf('const bloqueioDoCadastro = useCallback(');
    expect(hook.slice(gi, hook.indexOf(']);', gi))).toContain('[isCustomerMode, customerUserId, estadoCadastro');
  });
});

describe('8.2 — o orçamento também confere o cadastro (Codex r1 P0-2: virava pedido no nome do vendedor)', () => {
  it('o submitQuote chama o mesmo guard e retorna quando bloqueia', () => {
    const ini = hook.indexOf('const submitQuote = useCallback(');
    const svc = hook.indexOf('submitQuoteService(', ini);
    expect(hook.slice(ini, svc)).toMatch(/const bloqueioCadastroOrc = bloqueioDoCadastro\(\);\s*if \(bloqueioCadastroOrc\) \{\s*toast\.error\(bloqueioCadastroOrc\);\s*return;/);
  });
  it('o service do orçamento recebe isCustomerMode (2ª camada)', () => {
    const ini = hook.indexOf('submitQuoteService(');
    expect(hook.slice(ini, ini + 200)).toContain('isCustomerMode,');
  });
});

describe('8.2 — a página mostra o motivo e as saídas', () => {
  it('os motivos recebem o estado do cadastro (autoatendimento sempre confirmado)', () => {
    expect(pagina).toContain("estadoCadastro: h.isCustomerMode ? 'confirmado' : h.estadoCadastro");
  });

  it('o CustomerSearch recebe o estado, sem "Revalidar" nem "criar cadastro" (Codex r1/r2)', () => {
    expect(pagina).toContain('estadoCadastro={h.estadoCadastro}');
    expect(pagina).not.toContain('onRevalidarCadastro');
    expect(pagina).not.toContain('onCriarCadastro');
  });
});
