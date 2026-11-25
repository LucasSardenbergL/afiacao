import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 8.1 (rodada 3): vendedor falha FECHADO — FIAÇÃO ──
// O comportamento é provado nos puros (validacao-vendedor.test.ts, motivos-envio.test.ts). Hook e
// página são grandes demais para renderizar aqui; este arquivo prova que eles USAM os puros
// (precedente: useUnifiedOrder.followups4068.test.ts).
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

describe('8.1 — a resposta da validação passa pelo intérprete fechado', () => {
  it('o hook interpreta a resposta pelo puro (e não testa `!validacao.consistente` cru)', () => {
    expect(selecao).toContain('interpretarValidacaoVendedor(data, error)');
    expect(selecao).not.toContain('!validacao.consistente');
  });

  it('o catch da chamada NÃO é silencioso: a exceção vira `error` do intérprete', () => {
    expect(selecao).toMatch(/catch \(err\) \{\s*error = err;/);
  });

  it('o estado é gravado do resultado (inclusive indisponivel)', () => {
    expect(selecao).toContain('setEstadoVendedor(resultado.estado)');
  });
});

describe('8.1 — caminho de envio confere o vendedor ANTES da trava', () => {
  it('o submit chama o guard e retorna quando bloqueia', () => {
    expect(corpoDoSubmit()).toMatch(/mensagemBloqueioVendedor\(estadoVendedor\)[\s\S]*?toast\.error\(bloqueioVendedor\);\s*return;/);
  });

  it('o useCallback do submit depende de estadoVendedor (sem closure velha)', () => {
    const ini = hook.indexOf('const submitOrder = useCallback(');
    const deps = hook.slice(hook.indexOf('\n  }, [', ini), hook.indexOf(']);', hook.indexOf('\n  }, [', ini)));
    expect(deps).toContain('estadoVendedor');
  });

  it('a página passa o estado aos motivos do botão', () => {
    expect(pagina).toContain('estadoVendedor: h.estadoVendedor');
  });
});
