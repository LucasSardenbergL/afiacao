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
import { coletarDaEdge } from './edge-rpcs';

describe('coletarDaEdge — contra o repo REAL', () => {
  it('segue o fecho de imports: acha RPC que mora em `_shared/`, não só no diretório da edge', () => {
    // `recommend` chama `recommend_cluster_agregado` de dentro de `_shared/recommend-leituras.ts`.
    // O grep do runbook, que só varria `supabase/functions/recommend/`, não via essa dependência —
    // e o deploy sobe o fecho inteiro, não o diretório.
    const r = coletarDaEdge('recommend');
    expect(r.rpcs.map((a) => a.nome)).toContain('recommend_cluster_agregado');
    expect(r.rpcs.find((a) => a.nome === 'recommend_cluster_agregado')?.arquivo).toMatch(/_shared\//);
  });

  it('acha RPC escrita com aspas DUPLAS (36 das 53 do repo eram invisíveis)', () => {
    const r = coletarDaEdge('omie-analytics-sync');
    expect(r.rpcs.map((a) => a.nome)).toContain('omie_sync_identity_snapshot');
  });

  it('ACUSA a indireção real de `_shared/itens-com-pedido.ts` em vez de omiti-la', () => {
    // Este é o sítio que motivou a entrega: o loader chama `db.rpc<unknown>(fn, args)`, com o nome
    // vindo do call-site. Sem o aviso, `apriori_universo_snapshot` e `cockpit_itens_snapshot`
    // sumiriam do pré-flight — e sumir em silêncio é como o pré-flight vira falso VERDE.
    const r = coletarDaEdge('fin-valor-cockpit');
    expect(r.indirecoes.map((i) => i.arquivo)).toContain('supabase/functions/_shared/itens-com-pedido.ts');
  });

  it('edge inexistente FALHA — nunca devolve lista vazia (que se lê como "sem dependências")', () => {
    expect(() => coletarDaEdge('edge-que-nao-existe')).toThrow(/edge-que-nao-existe/);
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
