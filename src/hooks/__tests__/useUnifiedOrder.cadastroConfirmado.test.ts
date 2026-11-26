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
  it('o erro da leitura do mapeamento é LANÇADO (antes era ignorado e virava "sem cadastro")', () => {
    expect(selecao).toContain('if (mappingError) throw mappingError;');
  });

  it('o estado vem do intérprete puro, com o erro da busca', () => {
    expect(selecao).toContain('setEstadoCadastro(interpretarCadastro(localUserId, erroCadastro))');
  });
});

describe('8.2 — caminho de envio do staff confere o cadastro ANTES da trava', () => {
  it('o submit chama o guard (fora do autoatendimento) e retorna quando bloqueia', () => {
    expect(corpoDoSubmit()).toMatch(
      /if \(!isCustomerMode\) \{[\s\S]*?const bloqueioCadastro = mensagemBloqueioCadastro\(estadoEfetivo\);\s*if \(bloqueioCadastro\) \{\s*toast\.error\(bloqueioCadastro\);\s*return;/,
    );
  });

  it('"confirmado" sem id conta como não identificado', () => {
    expect(corpoDoSubmit()).toContain("!customerUserId && estadoCadastro === 'confirmado' ? 'indisponivel'");
  });

  it('o useCallback do submit depende de estadoCadastro (sem closure velha)', () => {
    const ini = hook.indexOf('const submitOrder = useCallback(');
    const abre = hook.indexOf('\n  }, [', ini);
    const deps = hook.slice(abre, hook.indexOf(']);', abre));
    expect(deps).toContain('estadoCadastro');
  });
});

describe('8.2 — a página mostra o motivo e as saídas', () => {
  it('os motivos recebem o estado do cadastro (autoatendimento sempre confirmado)', () => {
    expect(pagina).toContain("estadoCadastro: h.isCustomerMode ? 'confirmado' : h.estadoCadastro");
  });

  it('o CustomerSearch recebe "Revalidar" e "Criar cadastro"', () => {
    expect(pagina).toContain('onRevalidarCadastro={h.revalidarCadastro}');
    expect(pagina).toContain('onCriarCadastro={h.criarCadastroNoApp}');
  });
});
