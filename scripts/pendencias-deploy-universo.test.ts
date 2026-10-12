/**
 * Integração com GIT do universo de edges — separado do `pendencias-deploy.test.ts` DE PROPÓSITO.
 *
 * Motivo medido (CI do #2840): o `lerUniverso()` estava no corpo de um `describe`, logo rodava na
 * COLETA, e o harness do `mutcheck` copia os arquivos para um temp dir sem a ref `origin/main` —
 * a BASELINE do contrato morria antes da primeira mutação, e o relatório dizia "teste perdeu
 * poder" quando o que faltava era a ref. Teste que fala com git mora num arquivo próprio, como o
 * `pendencias-deploy-allowlist.test.ts` já fazia.
 *
 * E a ref aqui é `HEAD`, não `origin/main`: a asserção é sobre a ÁRVORE DO REPO (a edge existe e
 * escreve), que o HEAD responde sem depender de fetch. O CLI segue julgando contra `origin/main`,
 * que é o certo para ele — o que muda é só de onde o TESTE lê.
 *
 * O poder de discriminação sobre a lógica vive no `montarUniverso`, que é puro e está testado no
 * arquivo principal com fixture. Aqui ficam só os controles POSITIVOS VIVOS, contra a árvore real.
 */
import { describe, expect, it } from 'vitest';

import { contarEscrita } from './lib/pendencias-deploy';
import { lerUniverso } from './pendencias-deploy';
import { detectarMutacao } from './sonda-edge-nova-gate';

describe('lerUniverso — o denominador HONESTO, medido na ref real (#2824)', () => {
  // Controle positivo VIVO, no padrão do `sonda:nova`: a asserção é sobre a árvore de verdade,
  // não sobre uma fixture. Se a `tint-omie-sync` for instrumentada amanhã, este teste fica
  // vermelho e manda reler o controle — que é o comportamento certo, não um incômodo.
  const u = lerUniverso('HEAD');

  it('conta MAIS edges do que o mapa mapeia — era essa a diferença que o relatório não dizia', () => {
    expect(u.totalExistentes).toBeGreaterThan(0);
    expect(u.semMarcador.length).toBeGreaterThan(0);
    // o universo contém as mapeadas: sem-marcador é um SUBCONJUNTO do que existe
    expect(u.semMarcador.length).toBeLessThan(u.totalExistentes);
  });

  it('`_shared` não é edge e não entra no denominador', () => {
    expect(u.semMarcador.map((e) => e.edge)).not.toContain('_shared');
  });

  it('uma edge que ESCREVE e não tem marcador está na lista, classificada como quem escreve', () => {
    // O controle era a `tint-omie-sync`, a QUINTA edge do #2824 (grava no tintométrico — por isso
    // deixá-la fora do relatório era money-path invisível). Ela ganhou sonda no M-26 (1ª leva do
    // Lote C) e foi para o teste de baixo. O controle vivo passou a `fin-period-override`
    // (insert via PostgREST, módulo congelado pelo §0.3 do plano de melhorias — estável sem marcador).
    const controle = u.semMarcador.find((e) => e.edge === 'fin-period-override');
    expect(controle, 'o controle saiu da lista — se foi instrumentado, troque por outra edge que escreve').toBeDefined();
    expect(controle?.escrita).toBe('postgrest');
  });

  it('as instrumentadas (as 4 do #2824 + a `tint-omie-sync`, do M-26) NÃO aparecem aqui', () => {
    const nomes = u.semMarcador.map((e) => e.edge);
    for (const e of ['omie-analytics-sync', 'omie-sync-metadados', 'omie-vendas-sync', 'sync-reprocess', 'tint-omie-sync']) {
      expect(nomes).not.toContain(e);
    }
  });

  it('toda edge listada tem classe do vocabulário fechado — nunca `undefined` virando "sem risco"', () => {
    for (const e of u.semMarcador) {
      expect(['postgrest', 'rpc', 'nenhuma']).toContain(e.escrita);
    }
  });

  it('a classificação vem dos detectores do gate (stripper compartilhado), não de grep local', () => {
    // Falsificação do stripper: `.insert(` só dentro de comentário NÃO é escrita. Um grep local
    // diria `postgrest` aqui — e foi para isso que o `maquinas-meta.md` proibiu regex própria.
    expect(detectarMutacao("// await sb.from('t').insert(x)\nDeno.serve(() => new Response('ok'));")).toBeNull();
    expect(detectarMutacao("await sb.from('t').insert(x);")).toBe('insert');
  });

  it('FAIL-CLOSED: ref que não resolve LANÇA, nunca devolve universo vazio', () => {
    // Universo vazio por ERRO imprimiria `0 fora do alcance` — o mesmo silêncio que esta função
    // existe para desfazer, agora com cara de boa notícia. O `main` converte isto em exit 2.
    expect(() => lerUniverso('ref-que-nao-existe-xyz-000')).toThrow(/falhou/);
  });

  it('contarEscrita soma exatamente a lista — o eixo do risco, não o tamanho dela', () => {
    const n = contarEscrita(u.semMarcador);
    expect(n.postgrest + n.rpc + n.nenhuma).toBe(u.semMarcador.length);
    expect(n.postgrest).toBeGreaterThan(0);
  });
});
