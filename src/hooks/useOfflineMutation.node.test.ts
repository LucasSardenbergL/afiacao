/**
 * Este arquivo NÃO declara ambiente no docblock, DE PROPÓSITO: tem de rodar no project `node`.
 *
 * ⚠️ NÃO escreva o token de ambiente do vitest aqui — nem citando, nem negando. O vitest
 * varre o TEXTO do arquivo pelo token e troca o ambiente; prosa do tipo "sem <token> de
 * propósito" liga o jsdom e faz este arquivo provar o CONTRÁRIO do que diz. Pior, o rótulo
 * da saída (`|node|`) é o nome do PROJECT, não o ambiente que rodou — ele não denuncia a
 * troca. Quem denuncia é o teste de PREMISSA abaixo. (Medido: dois arquivos idênticos salvo
 * a prosa, `navigator.onLine` = `true` com o token vs `undefined` sem ele.)
 *
 * Por que node: o irmão `useOfflineMutation.test.ts` declara jsdom porque exercita o caminho
 * de browser. Aqui é o inverso — `node` é hoje o ÚNICO ambiente onde `navigator` EXISTE com
 * `onLine` indefinido (Node 21+ define `globalThis.navigator` sem essa propriedade), que é
 * exatamente a sonda ausente que o guard de `isNetworkError` tem de ignorar.
 *
 * Em jsdom e em browser `onLine` sempre tem valor, então a diferença entre `!navigator.onLine`
 * (fail-open: sonda ausente vira "offline") e `navigator.onLine === false` (fail-closed: só o
 * valor `false` prova offline) é INVISÍVEL. Rodar isto em jsdom não conserta — deixa verde por
 * CEGUEIRA.
 */
import { describe, it, expect } from 'vitest';
import { isNetworkError } from './useOfflineMutation';

describe('isNetworkError sob sonda ausente (navigator.onLine indefinido)', () => {
  it('PREMISSA do ambiente: navigator existe e onLine é indefinido', () => {
    // Não é cerimônia. Se esta asserção cair, as duas de baixo deixam de provar o que
    // dizem provar (o guard nem é alcançado, ou é alcançado com sonda PRESENTE) e passariam
    // por vacuidade. Falhar alto > verde por ausência de dado.
    expect(typeof navigator, 'sem `navigator` o guard sequer é avaliado').not.toBe('undefined');
    expect(
      navigator.onLine,
      'o runtime passou a definir `navigator.onLine`: este arquivo perdeu o ambiente que o ' +
        'justifica. Reancore (stub de navigator sem `onLine`) em vez de apagar o teste.',
    ).toBeUndefined();
  });

  it('erro de APLICAÇÃO não vira erro de rede com a sonda ausente', () => {
    // Estas são as que caíam em `node` antes do endurecimento: `!undefined === true`
    // fazia o guard responder "é de rede" ANTES de olhar o erro. Consequência real:
    // a mutação ia pra fila offline (que não tem teto de tentativas) e o operador via
    // "salvo offline" em cima de um erro que nunca vai sincronizar.
    expect(isNetworkError({ message: 'permission denied for function confirmar_item_picking' })).toBe(false);
    expect(isNetworkError(new Error('null value in column violates not-null constraint'))).toBe(false);
    expect(isNetworkError({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });

  it('erro de REDE de verdade continua indo pra fila com a sonda ausente', () => {
    // Controle contra a sobre-correção: um guard que devolvesse `false` sempre passaria
    // no teste de cima e mataria o offline-first inteiro. Sem `onLine`, quem sustenta o
    // enfileiramento são os regexes de mensagem — e é assim que o browser reporta.
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('NetworkError when attempting to fetch resource'))).toBe(true);
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true);
    expect(isNetworkError({ message: 'Network request failed' })).toBe(true);
  });
});
