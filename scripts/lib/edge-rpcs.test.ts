import { describe, it, expect } from 'vitest';
import { extrairRpcs } from './edge-rpcs';

// Por que este módulo existe: o pré-flight de dependências de banco de uma edge era um `grep -oE
// "\.rpc\('[a-z_]+'"` escrito no runbook (docs/agent/deploy.md). Medido no repo em 2026-08-30: das
// **53** RPCs literais chamadas em `supabase/functions/`, aquele comando enxergava **16** — ele só
// casa aspas SIMPLES. A nota do próprio runbook comemorava "das 16 RPCs chamadas por edges, as 16
// existem em prod"; o denominador era 53. O detector mentia, e o verde dele não significava nada.
//
// O custo dessa cegueira já foi pago uma vez: 2026-07-17, `carteira-rebuild` deployada com uma RPC
// que não existia em prod → 500 em produção por ~40 min.

describe('extrairRpcs — o que o grep do runbook enxergava', () => {
  it('acha `.rpc(` com aspas SIMPLES (o único caso que o grep antigo pegava)', () => {
    const r = extrairRpcs(`await db.rpc('claim_carteira_rebuild', {});`, 'x.ts');
    expect(r.rpcs.map((a) => a.nome)).toEqual(['claim_carteira_rebuild']);
    expect(r.indirecoes).toEqual([]);
  });

  it('acha `.rpc(` com aspas DUPLAS — a cegueira que escondia 36 das 53 RPCs do repo', () => {
    const r = extrairRpcs(`await db.rpc("omie_sync_identity_snapshot", { p_account: a });`, 'x.ts');
    expect(r.rpcs.map((a) => a.nome)).toEqual(['omie_sync_identity_snapshot']);
  });

  it('acha `.rpc<T>(` com parâmetro de tipo — a forma que os loaders tipados usam', () => {
    const r = extrairRpcs(`const { data } = await db.rpc<LinhaAgregada>("recommend_cluster_agregado", {});`, 'x.ts');
    expect(r.rpcs.map((a) => a.nome)).toEqual(['recommend_cluster_agregado']);
  });

  it('acha template literal SEM interpolação (é um literal como qualquer outro)', () => {
    const r = extrairRpcs('await db.rpc(`has_role`, {});', 'x.ts');
    expect(r.rpcs.map((a) => a.nome)).toEqual(['has_role']);
  });

  it('reporta ARQUIVO e LINHA — sem isso o achado não é acionável', () => {
    const r = extrairRpcs(`linha1\nawait db.rpc('atp_gate_pedido', {});`, 'supabase/functions/x/index.ts');
    expect(r.rpcs[0]).toMatchObject({ nome: 'atp_gate_pedido', arquivo: 'supabase/functions/x/index.ts', linha: 2 });
  });
});

describe('extrairRpcs — fail-closed onde o nome NÃO é literal', () => {
  it('ACUSA indireção em vez de devolver lista vazia em silêncio', () => {
    // O caso real: `_shared/itens-com-pedido.ts` chama `db.rpc<unknown>(fn, args)`, com o nome
    // vindo do call-site. Um extrator que só colhe literais devolveria "nenhuma RPC" — e "nenhuma"
    // é indistinguível de "não achei", que é exatamente como o pré-flight vira falso VERDE.
    const r = extrairRpcs(`const { data, error } = await db.rpc<unknown>(fn, args);`, 'y.ts');
    expect(r.rpcs).toEqual([]);
    expect(r.indirecoes).toHaveLength(1);
    expect(r.indirecoes[0]).toMatchObject({ arquivo: 'y.ts', linha: 1 });
  });

  it('a indireção NÃO engole os literais do mesmo arquivo', () => {
    const fonte = `await db.rpc("ia_consumir_cota", {});\nawait db.rpc(nome, {});`;
    const r = extrairRpcs(fonte, 'z.ts');
    expect(r.rpcs.map((a) => a.nome)).toEqual(['ia_consumir_cota']);
    expect(r.indirecoes).toHaveLength(1);
  });
});

// ── cegueira (4): LITERAL PARCIAL — a única que errava para o lado do FALSO VERDE ─────────────
// As outras três cegueiras produzem lista CURTA: o gate recusa, e recusar é o desfecho seguro.
// Esta produzia um nome ERRADO com exit 0 — o gate cruzava com prod `has_role` (que existe) e
// liberava uma edge que chama `has_role_v2` (que pode não existir), reencenando o #2285 por
// dentro da própria ferramenta que existe para preveni-lo. Achada pelo Codex em 2026-09-08.
describe('extrairRpcs — o literal tem de ser o argumento INTEIRO', () => {
  it('NÃO reporta `has_role` quando a chamada é `"has_role" + "_v2"` — o nome é outro', () => {
    const r = extrairRpcs('await db.rpc("has_role" + "_v2", {});', 'a.ts');
    expect(r.rpcs).toHaveLength(0);
    expect(r.indirecoes).toHaveLength(1);
  });

  it('NÃO reporta o prefixo quando o nome é montado com variável (`"pre_" + sufixo`)', () => {
    // O pior caso: `pre_` provavelmente não existe em prod, então o gate cruzaria um nome que
    // ninguém chama — e a RPC real nunca seria verificada.
    const r = extrairRpcs('await db.rpc("pre_" + sufixo, {});', 'a.ts');
    expect(r.rpcs).toHaveLength(0);
    expect(r.indirecoes).toHaveLength(1);
  });

  it('NÃO reporta literal seguido de chamada de método (`"nome".toUpperCase()`)', () => {
    const r = extrairRpcs('await db.rpc("nome".toUpperCase(), {});', 'a.ts');
    expect(r.rpcs).toHaveLength(0);
    expect(r.indirecoes).toHaveLength(1);
  });

  // Os controles: o aperto acima não pode custar as formas REAIS do repo. Sem estes, um regex que
  // recusasse tudo passaria nos três testes de cima — sempre-vermelho aprova qualquer coisa.
  it('CONTROLE: literal seguido de vírgula continua literal', () => {
    expect(extrairRpcs('await db.rpc("nome_ok", {});', 'a.ts').rpcs.map((a) => a.nome)).toEqual(['nome_ok']);
  });

  it('CONTROLE: literal seguido de `)` (sem argumentos) continua literal', () => {
    expect(extrairRpcs('await db.rpc("nome_ok");', 'a.ts').rpcs.map((a) => a.nome)).toEqual(['nome_ok']);
  });

  it('CONTROLE: espaço entre o literal e a vírgula não quebra', () => {
    expect(extrairRpcs('await db.rpc("nome_ok" , {});', 'a.ts').rpcs.map((a) => a.nome)).toEqual(['nome_ok']);
  });
});

describe('extrairRpcs — comentário não é dependência', () => {
  it('IGNORA `.rpc(` citado em comentário de linha', () => {
    // Não é hipótese: `_shared/itens-com-pedido.ts` cita `.range()` e `fetchAllKeyset` em prosa
    // para explicar o defeito que fechou. Um extrator ingênuo trataria a explicação como código.
    const r = extrairRpcs(`// antes isto chamava db.rpc('rpc_que_nao_existe_mais', {})\nawait db.rpc('viva', {});`, 'c.ts');
    expect(r.rpcs.map((a) => a.nome)).toEqual(['viva']);
  });

  it('IGNORA `.rpc(` dentro de bloco /* */', () => {
    const r = extrairRpcs(`/*\n await db.rpc('fantasma', {});\n*/\nawait db.rpc('viva', {});`, 'c.ts');
    expect(r.rpcs.map((a) => a.nome)).toEqual(['viva']);
  });

  it('IGNORA indireção citada em comentário (senão o aviso vira ruído permanente)', () => {
    const r = extrairRpcs(`// o helper faz db.rpc(fn, args) e o nome vem do call-site\nawait db.rpc('viva', {});`, 'c.ts');
    expect(r.indirecoes).toEqual([]);
  });
});

// ── contra o repo REAL ────────────────────────────────────────────────────────────────────────
// Fixture prova a TRADUÇÃO; só o repo real prova que as cegueiras 2 (escopo) e 3 (indireção)
// estão fechadas onde elas de fato acontecem. Se estes casos virarem fixture, o gate volta a
// medir a si mesmo.
import { type ArvoreDeFonte, arvoreDeTrabalho } from '../sonda-fingerprint';
import { coletarDaEdge } from './edge-rpcs';

// A procedência é ARGUMENTO, não default: estes casos afirmam sobre o working tree e dizem isso.
const DISCO = arvoreDeTrabalho();

describe('coletarDaEdge — contra o repo REAL', () => {
  it('segue o fecho de imports: acha RPC que mora em `_shared/`, não só no diretório da edge', () => {
    // `recommend` chama `recommend_cluster_agregado` de dentro de `_shared/recommend-leituras.ts`.
    // O grep do runbook, que só varria `supabase/functions/recommend/`, não via essa dependência —
    // e o deploy sobe o fecho inteiro, não o diretório.
    const r = coletarDaEdge('recommend', DISCO);
    expect(r.rpcs.map((a) => a.nome)).toContain('recommend_cluster_agregado');
    expect(r.rpcs.find((a) => a.nome === 'recommend_cluster_agregado')?.arquivo).toMatch(/_shared\//);
  });

  it('acha RPC escrita com aspas DUPLAS (36 das 53 do repo eram invisíveis)', () => {
    const r = coletarDaEdge('omie-analytics-sync', DISCO);
    expect(r.rpcs.map((a) => a.nome)).toContain('omie_sync_identity_snapshot');
  });

  it('vê as DUAS RPCs de `_shared/itens-com-pedido.ts`, sem indireção nenhuma', () => {
    // Este sítio motivou a entrega original e MUDOU em 2026-09-08. Ele chamava
    // `db.rpc<unknown>(fn, args)` num helper que recebia o nome, e o extrator — corretamente —
    // acusava indireção. Só que acusar tem preço: o gate de `pendencias-pacote.ts` recusa liberar
    // a edge sem conseguir medir a cobertura, e isso travou o deploy de `fin-valor-cockpit` com as
    // duas RPCs existindo em prod o tempo todo (exit 3, "a lista está INCOMPLETA").
    //
    // A saída foi eliminar a indireção por CONSTRUÇÃO — literal no `.rpc(` de cada loader, com a
    // validação seguindo compartilhada — em vez de ensinar o extrator a resolvê-la (2ª opinião do
    // Codex: a análise ampliaria o código responsável pela garantia do gate, e provar "nenhum
    // outro nome alcança esta chamada" exige mais do que os call-sites serem literais).
    //
    // Este teste trava as duas metades: as RPCs aparecem NOMEADAS, e o arquivo não volta a
    // esconder dependência atrás de parâmetro. Se alguém reintroduzir o helper, ele fica vermelho.
    const r = coletarDaEdge('fin-valor-cockpit', DISCO);
    expect(r.rpcs.map((a) => a.nome).sort()).toEqual(
      expect.arrayContaining(['apriori_universo_snapshot', 'cockpit_itens_snapshot']),
    );
    expect(r.indirecoes.map((i) => i.arquivo)).not.toContain(
      'supabase/functions/_shared/itens-com-pedido.ts',
    );
  });

  it('edge inexistente FALHA — nunca devolve lista vazia (que se lê como "sem dependências")', () => {
    expect(() => coletarDaEdge('edge-que-nao-existe', DISCO)).toThrow(/edge-que-nao-existe/);
  });
});

// ── a ÁRVORE manda: a resposta é sobre a fonte que o chamador declarou ────────────────────────
// O `pendencias:pacote` gateia a colagem que sai de `origin/main`, e lia as RPCs do disco. Numa
// worktree atrasada isso mede o `index.ts` errado e libera o que devia bloquear (#2285 de novo).
// Estes casos exercitam a extração DIRETO na unidade — o teste de nível `main` não os alcança,
// porque lá o `fatiaDeDeploy` lança antes por outro motivo.
describe('coletarDaEdge — lê a árvore que recebeu, não o disco', () => {
  const ENTRADA = 'supabase/functions/edge-fake/index.ts';

  function arvoreFalsa(arquivos: Record<string, string>, rotulo = 'ref-de-teste'): ArvoreDeFonte {
    return {
      rotulo,
      ler: (rel) => (rel in arquivos ? Buffer.from(arquivos[rel] as string, 'utf8') : null),
    };
  }

  it('acha a RPC que só existe NA ÁRVORE — o disco desta worktree não participa', () => {
    // `edge-fake` não existe em `supabase/functions/`: se a leitura caísse para o disco, isto
    // lançaria em vez de achar a RPC. É a asserção que a versão anterior não conseguia passar.
    const r = coletarDaEdge('edge-fake', arvoreFalsa({
      [ENTRADA]: `await db.rpc('rpc_so_da_ref', {});\n`,
    }));
    expect(r.rpcs.map((a) => a.nome)).toEqual(['rpc_so_da_ref']);
  });

  it('edge ausente NA ÁRVORE lança nomeando a árvore — ausência de dado não é "sem dependência"', () => {
    const arvore = arvoreFalsa({ 'supabase/functions/outra/index.ts': '' }, 'origin/main');
    // A mensagem do GUARD, não só o rótulo: o `fecharGrafo` também lança citando a árvore, então
    // `toThrow(/origin\/main/)` ficava verde com o guard REMOVIDO. Pego na falsificação.
    expect(() => coletarDaEdge('edge-fake', arvore)).toThrow(/edge não encontrada em origin\/main/);
  });

  it('árvore que muda sob os pés LANÇA — fonte vazia extrairia zero RPCs, e zero por cegueira libera', () => {
    // O `fecharGrafo` lê cada arquivo do fecho ANTES desta função relê. Entre as duas leituras a
    // ref pode se mover (dois `git show` distintos). Sem este ramo, `?? ''` transformaria o
    // arquivo sumido em zero RPCs — a lista curta que o gate lê como "sem dependência".
    const conteudo: Record<string, string> = {
      [ENTRADA]: `await db.rpc('some_no_meio_do_caminho', {});\n`,
    };
    let leituras = 0;
    const instavel: ArvoreDeFonte = {
      rotulo: 'ref-instavel',
      ler: (rel) => {
        leituras += 1;
        // As duas primeiras (guard + fecho) respondem; a terceira, a releitura, encontra o vazio.
        if (leituras > 2) return null;
        return rel in conteudo ? Buffer.from(conteudo[rel] as string, 'utf8') : null;
      },
    };
    expect(() => coletarDaEdge('edge-fake', instavel)).toThrow(/sumiu de ref-instavel/);
  });

  it('segue o fecho DENTRO da árvore — helper de `_shared/` que só existe nela conta', () => {
    const r = coletarDaEdge('edge-fake', arvoreFalsa({
      [ENTRADA]: `import { f } from '../_shared/ajuda.ts';\nawait db.rpc('da_entrada', {});\n`,
      'supabase/functions/_shared/ajuda.ts': `await db.rpc('do_shared', {});\n`,
    }));
    expect(r.rpcs.map((a) => a.nome)).toEqual(['da_entrada', 'do_shared']);
  });
});

// ── relatório: o exit code tem de distinguir lista COMPLETA de lista INCOMPLETA ───────────────
import { montarRelatorio } from './edge-rpcs';

describe('montarRelatorio', () => {
  const semIndirecao = { rpcs: [{ nome: 'has_role', arquivo: 'a.ts', linha: 3 }], indirecoes: [] };

  it('lista COMPLETA → código 0 e a RPC aparece com arquivo:linha', () => {
    const r = montarRelatorio('minha-edge', semIndirecao);
    expect(r.codigo).toBe(0);
    expect(r.texto).toContain('has_role');
    expect(r.texto).toContain('a.ts:3');
  });

  it('lista INCOMPLETA (há indireção) → código 3, NUNCA 0', () => {
    // O ponto da entrega. Quem automatiza este pré-flight lê o EXIT CODE, e um 0 aqui afirmaria
    // "estas são todas as dependências" sobre uma lista que o extrator sabe estar furada.
    // Ausência de sinal não é aprovação (CLAUDE.md → evidência positiva).
    const r = montarRelatorio('minha-edge', {
      rpcs: semIndirecao.rpcs,
      indirecoes: [{ arquivo: 'b.ts', linha: 9, trecho: 'await db.rpc(fn, args);' }],
    });
    expect(r.codigo).toBe(3);
    expect(r.texto).toContain('b.ts:9');
  });

  it('emite o SQL de verificação com as RPCs achadas (o cruzamento com prod é o objetivo)', () => {
    const r = montarRelatorio('minha-edge', semIndirecao);
    expect(r.texto).toContain('pg_proc');
    expect(r.texto).toMatch(/'has_role'/);
  });

  it('zero RPCs e zero indireções → código 0, dito EXPLICITAMENTE (não linha em branco)', () => {
    const r = montarRelatorio('minha-edge', { rpcs: [], indirecoes: [] });
    expect(r.codigo).toBe(0);
    expect(r.texto).toMatch(/nenhuma RPC/i);
  });
});
