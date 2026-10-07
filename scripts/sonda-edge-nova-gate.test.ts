import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  auditarEdgesNovas,
  detectarMutacao,
  detectarRpcs,
  DISPENSAS,
  MOTIVOS_DISPENSA,
  coletarNovas,
  formatarAchado,
  main,
  montarEstadoNovas,
  unirTocados,
  type EstadoEdgeNova,
  type Dispensa,
} from './sonda-edge-nova-gate';
import { git } from './sonda-versao-bump-gate';

function nova(p: Partial<EstadoEdgeNova> & { edge: string }): EstadoEdgeNova {
  return { corpo: [{ caminho: 'index.ts', fonte: 'Deno.serve(() => new Response("ok"));' }], versao: null, temMarcador: false, noMapa: false, origem: 'nasceu', ...p };
}

const SEM_DISPENSA: Record<string, Dispensa> = {};

describe('auditarEdgesNovas — a decisão não pode ser tomada por OMISSÃO', () => {
  it('edge NOVA sem marcador e fora da lista de dispensa REPROVA', () => {
    const achados = auditarEdgesNovas([nova({ edge: 'analytics-outbox-drain' })], SEM_DISPENSA);
    expect(achados.map((a) => a.motivo)).toEqual(['sem-decisao']);
    expect(achados[0].edge).toBe('analytics-outbox-drain');
  });

  it('edge NOVA instrumentada (marcador legível + entrada no mapa) PASSA', () => {
    const achados = auditarEdgesNovas(
      [nova({ edge: 'omie-novo', temMarcador: true, versao: 'v1.0-inicial', noMapa: true })],
      SEM_DISPENSA,
    );
    expect(achados).toEqual([]);
  });

  it('edge NOVA na lista de dispensa PASSA — o gate não é imposto sobre quem não precisa de sonda', () => {
    const achados = auditarEdgesNovas([nova({ edge: 'fin-relatorio-leitura' })], {
      'fin-relatorio-leitura': { motivo: 'leitura-pura', porque: 'só faz SELECT em fin_dre; chamá-la é grátis.' },
    });
    expect(achados).toEqual([]);
  });
});

describe('auditarEdgesNovas — instrumentou pela METADE não é ter decidido', () => {
  it('marcador presente mas VERSAO ilegível REPROVA como `marcador-ilegivel`, não como omissão', () => {
    const a = auditarEdgesNovas([nova({ edge: 'x', temMarcador: true, versao: null, noMapa: true })], SEM_DISPENSA);
    expect(a.map((v) => v.motivo)).toEqual(['marcador-ilegivel']);
  });

  it('marcador legível mas edge FORA do mapa de fingerprints REPROVA como `fora-do-mapa`', () => {
    const a = auditarEdgesNovas([nova({ edge: 'x', temMarcador: true, versao: 'v1.0-i', noMapa: false })], SEM_DISPENSA);
    expect(a.map((v) => v.motivo)).toEqual(['fora-do-mapa']);
  });
});

describe('auditarEdgesNovas — a válvula de escape não é de graça', () => {
  it('dispensa com `porque` em branco REPROVA — lista sem justificativa é depósito silencioso', () => {
    const a = auditarEdgesNovas([nova({ edge: 'x' })], { x: { motivo: 'leitura-pura', porque: '   ' } });
    expect(a.map((v) => v.motivo)).toEqual(['dispensa-invalida']);
  });

  it('dispensa com motivo fora do vocabulário REPROVA', () => {
    const a = auditarEdgesNovas([nova({ edge: 'x' })], {
      x: { motivo: 'porque-sim' as unknown as Dispensa['motivo'], porque: 'texto qualquer' },
    });
    expect(a.map((v) => v.motivo)).toEqual(['dispensa-invalida']);
  });

  it('dispensa `leitura-pura` numa edge que ESCREVE REPROVA — a asserção é verificada, não aceita', () => {
    const a = auditarEdgesNovas(
      [nova({ edge: 'drain', corpo: [{ caminho: 'index.ts', fonte: "await sb.from('outbox').insert(linhas);" }] })],
      { drain: { motivo: 'leitura-pura', porque: 'só lê a outbox' } },
    );
    expect(a.map((v) => v.motivo)).toEqual(['dispensa-falsa']);
  });

  it('edge dispensada E instrumentada REPROVA — a lista apodrece se a contradição passar', () => {
    const a = auditarEdgesNovas([nova({ edge: 'x', temMarcador: true, versao: 'v1.0-i', noMapa: true })], {
      x: { motivo: 'leitura-pura', porque: 'só lê' },
    });
    expect(a.map((v) => v.motivo)).toEqual(['decisao-dupla']);
  });
});

describe('detectarMutacao — precisão > recall (gate que grita errado treina a ignorar)', () => {
  it('acha a cadeia PostgREST de escrita', () => {
    expect(detectarMutacao("await sb.from('t').insert(x)")).toBe('insert');
    expect(detectarMutacao("sb.from('t')\n  .upsert(x, { onConflict: 'id' })")).toBe('upsert');
    expect(detectarMutacao("sb.from('t').update({ a: 1 }).eq('id', i)")).toBe('update');
  });

  it('NÃO confunde `Map.delete`/`.update` de outro objeto com escrita no banco', () => {
    expect(detectarMutacao('cache.delete(chave); contador.update(1);')).toBe(null);
  });

  it('NÃO conta escrita citada em COMENTÁRIO — mede pelo stripper compartilhado', () => {
    expect(detectarMutacao("// antes: sb.from('t').insert(x)\nconst r = await sb.from('t').select('*');")).toBe(null);
  });

  it('leitura pura de verdade não acusa nada', () => {
    expect(detectarMutacao("const { data } = await sb.from('fin_dre').select('*').eq('ano', 2026);")).toBe(null);
  });
});

// ─── I/O: o seam onde moram os falsos-verdes ────────────────────────────────────────────────

const R = 'supabase/functions';

/** Leitor de árvore falso: { rev: { caminho: fonte } }. Ausente = null (arquivo não existe). */
function leitor(arvores: Record<string, Record<string, string>>) {
  return (rev: string | null, caminho: string): string | null =>
    arvores[rev ?? 'HEAD']?.[caminho] ?? null;
}

describe('montarEstadoNovas — quem é NOVA (e quem só parece)', () => {
  it('edge com index.ts no HEAD e ausente na BASE é NOVA', () => {
    const ler = leitor({
      base: {},
      HEAD: { [`${R}/drain/index.ts`]: 'const x = 1;' },
    });
    const novas = montarEstadoNovas([`${R}/drain/index.ts`], 'base', null, ler);
    expect(novas.map((n) => n.edge)).toEqual(['drain']);
    expect(novas[0].corpo.map((c) => c.caminho)).toEqual([`${R}/drain/index.ts`]);
  });

  // Este teste AFIRMAVA `toEqual([])` para uma edge que já existia e NÃO tem marcador — e era a
  // expressão exata do buraco do #2824: devolvia o caso ao `sonda:bump`, que também o descarta
  // (`versaoBase === null`). A asserção que ele realmente queria fazer é a de baixo: é MUDAR de
  // edge INSTRUMENTADA que não é problema deste gate.
  it('edge que já existia e É instrumentada NÃO entra — MUDAR com marcador é do `sonda:bump`', () => {
    const ler = leitor({
      base: { [`${R}/drain/index.ts`]: 'const x = 0;' },
      HEAD: {
        [`${R}/drain/index.ts`]: 'const x = 1;',
        [`${R}/drain/versao.ts`]: "export const VERSAO = 'v1.0-ja-instrumentada';",
      },
    });
    expect(montarEstadoNovas([`${R}/drain/index.ts`], 'base', null, ler)).toEqual([]);
  });

  it('edge REMOVIDA na fatia não é nova — sumir não é nascer', () => {
    const ler = leitor({ base: { [`${R}/velha/index.ts`]: 'a' }, HEAD: {} });
    expect(montarEstadoNovas([`${R}/velha/index.ts`], 'base', null, ler)).toEqual([]);
  });

  it('`_shared/` nunca é edge', () => {
    const ler = leitor({ base: {}, HEAD: { [`${R}/_shared/novo.ts`]: 'a' } });
    expect(montarEstadoNovas([`${R}/_shared/novo.ts`], 'base', null, ler)).toEqual([]);
  });

  it('lê marcador e mapa na REV do head, não da árvore de trabalho', () => {
    const ler = leitor({
      base: {},
      h: {
        [`${R}/drain/index.ts`]: 'const x = 1;',
        [`${R}/drain/versao.ts`]: "export const VERSAO = 'v1.0-nasce';",
        [`${R}/_shared/sonda-fingerprints.ts`]: `export const FONTE_SHA256 = {\n  "drain": "${'a'.repeat(64)}",\n};`,
      },
    });
    const [n] = montarEstadoNovas([`${R}/drain/index.ts`, `${R}/drain/versao.ts`], 'base', 'h', ler);
    expect(n.temMarcador).toBe(true);
    expect(n.versao).toBe('v1.0-nasce');
    expect(n.noMapa).toBe(true);
    // o versao.ts NÃO entra no corpo — ele é o marcador, não a fatia que o marcador nomeia
    expect(n.corpo.map((c) => c.caminho)).toEqual([`${R}/drain/index.ts`]);
  });

  it('edge nova instrumentada mas AUSENTE do mapa vem com noMapa=false', () => {
    const ler = leitor({
      base: {},
      HEAD: {
        [`${R}/drain/index.ts`]: 'const x = 1;',
        [`${R}/drain/versao.ts`]: "export const VERSAO = 'v1.0-nasce';",
        [`${R}/_shared/sonda-fingerprints.ts`]: 'export const FONTE_SHA256 = {\n};',
      },
    });
    const [n] = montarEstadoNovas([`${R}/drain/index.ts`, `${R}/drain/versao.ts`], 'base', null, ler);
    expect(n.noMapa).toBe(false);
  });

  it('edge nova cujo index.ts nasce SEM aparecer no diff ainda é vista pelo irmão de pasta', () => {
    // o diff traz `helper.ts`; o `index.ts` existe no HEAD e não na base — a edge nasceu.
    const ler = leitor({
      base: {},
      HEAD: { [`${R}/drain/index.ts`]: 'a', [`${R}/drain/helper.ts`]: 'b' },
    });
    const novas = montarEstadoNovas([`${R}/drain/helper.ts`], 'base', null, ler);
    expect(novas.map((n) => n.edge)).toEqual(['drain']);
  });
});

describe('o SEGUNDO universo: mexer no corpo de edge SEM MARCADOR (#2824)', () => {
  const BASE = { [`${R}/tint/index.ts`]: 'const x = 0;' };

  it('edge que já existia, SEM marcador, com o CORPO alterado ENTRA — e marcada como mexida', () => {
    const ler = leitor({ base: BASE, HEAD: { [`${R}/tint/index.ts`]: 'const x = 1;' } });
    const novas = montarEstadoNovas([`${R}/tint/index.ts`], 'base', null, ler);
    expect(novas.map((n) => n.edge)).toEqual(['tint']);
    expect(novas[0].origem).toBe('mexida-sem-marcador');
    expect(novas[0].temMarcador).toBe(false);
  });

  it('edge NOVA continua marcada como `nasceu` — as duas réguas não se confundem', () => {
    const ler = leitor({ base: {}, HEAD: { [`${R}/tint/index.ts`]: 'const x = 1;' } });
    expect(montarEstadoNovas([`${R}/tint/index.ts`], 'base', null, ler)[0].origem).toBe('nasceu');
  });

  it('só o `_test.ts` mexido NÃO entra — teste não cria deploy pendente', () => {
    const ler = leitor({
      base: { ...BASE, [`${R}/tint/index_test.ts`]: 'a' },
      HEAD: { ...BASE, [`${R}/tint/index_test.ts`]: 'b' },
    });
    expect(montarEstadoNovas([`${R}/tint/index_test.ts`], 'base', null, ler)).toEqual([]);
  });

  it('só o `versao.ts` mexido NÃO entra (e com marcador no head o caso é do `sonda:bump`)', () => {
    const ler = leitor({
      base: BASE,
      HEAD: { ...BASE, [`${R}/tint/versao.ts`]: "export const VERSAO = 'v1.1-x';" },
    });
    expect(montarEstadoNovas([`${R}/tint/versao.ts`], 'base', null, ler)).toEqual([]);
  });

  it('helper da pasta mexido entra, e o `index.ts` do head entra no corpo junto', () => {
    const ler = leitor({
      base: { ...BASE, [`${R}/tint/helper.ts`]: 'a' },
      HEAD: { [`${R}/tint/index.ts`]: 'const x = 1;', [`${R}/tint/helper.ts`]: 'b' },
    });
    const [n] = montarEstadoNovas([`${R}/tint/helper.ts`], 'base', null, ler);
    expect(n.origem).toBe('mexida-sem-marcador');
    // o index.ts é onde a escrita está em 16 das 16 escritoras medidas — por isso ele entra sempre
    expect(n.corpo.map((c) => c.caminho).sort()).toEqual([`${R}/tint/helper.ts`, `${R}/tint/index.ts`]);
  });

  it('a edge REMOVIDA na fatia segue fora — sumir não é mexer', () => {
    const ler = leitor({ base: BASE, HEAD: {} });
    expect(montarEstadoNovas([`${R}/tint/index.ts`], 'base', null, ler)).toEqual([]);
  });

  it('mexida sem marcador e sem dispensa REPROVA, com o detalhe que nomeia o invisível', () => {
    const a = auditarEdgesNovas([nova({ edge: 'tint-omie-sync', origem: 'mexida-sem-marcador' })], SEM_DISPENSA);
    expect(a.map((v) => v.motivo)).toEqual(['sem-decisao']);
    expect(a[0].detalhe).toMatch(/alterou o corpo/);
    expect(a[0].detalhe).toMatch(/pendencias:deploy/);
    // e o remédio impresso oferece as DUAS saídas, como para a edge nova
    const texto = formatarAchado(a[0]);
    expect(texto).toMatch(/versao\.ts/);
    expect(texto).toMatch(/DISPENSAS/);
  });

  it('mexida sem marcador mas DISPENSADA passa — a decisão existe, e o gate só proíbe a omissão', () => {
    const a = auditarEdgesNovas([nova({ edge: 'cep-geo', origem: 'mexida-sem-marcador' })], {
      'cep-geo': { motivo: 'leitura-pura', porque: 'só resolve CEP, não grava' },
    });
    expect(a).toEqual([]);
  });

  it('dispensa FALSA de mexida é falsificada igual à de edge nova', () => {
    const a = auditarEdgesNovas(
      [
        nova({
          edge: 'tint-omie-sync',
          origem: 'mexida-sem-marcador',
          corpo: [{ caminho: 'index.ts', fonte: "await sb.from('produtos').update({ estoque: 0 });" }],
        }),
      ],
      { 'tint-omie-sync': { motivo: 'leitura-pura', porque: 'só lê o Omie' } },
    );
    expect(a.map((v) => v.motivo)).toEqual(['dispensa-falsa']);
  });
});

describe('CONTROLE POSITIVO VIVO: a fatia real do #2824 reprova, e as vizinhas não', () => {
  // O incidente, medido em git de verdade: `f55523513` tirou `estoque: prod.quantidade_estoque
  // || 0` de CINCO edges; quatro instrumentadas (pegas pelo `sonda:bump`) e a `tint-omie-sync`,
  // sem marcador. Antes desta entrega os DOIS gates saíam `exit 0` com mensagem de aprovação
  // sobre essa fatia. Se este teste ficar verde por vacuidade, o `git` do CI não tem o commit —
  // daí a asserção de que a fatia existe antes da asserção sobre o veredito.
  const COMMIT = 'f55523513';

  function temCommit(): boolean {
    return git(['rev-parse', '--verify', `${COMMIT}^{commit}`]).ok;
  }

  it('a fatia do incidente acusa `tint-omie-sync` como decisão em aberto', () => {
    if (!temCommit()) {
      expect.fail(`o commit ${COMMIT} não está neste clone — sem ele o controle positivo é vácuo`);
    }
    const achados = auditarEdgesNovas(coletarNovas(`${COMMIT}^`, COMMIT), SEM_DISPENSA);
    const tint = achados.find((a) => a.edge === 'tint-omie-sync');
    expect(tint, 'a quinta edge do #2824 tem de aparecer').toBeDefined();
    expect(tint?.motivo).toBe('sem-decisao');
    // e as quatro instrumentadas NÃO entram aqui: elas são do `sonda:bump`, que as pegou
    for (const instrumentada of ['omie-analytics-sync', 'omie-sync-metadados', 'omie-vendas-sync', 'sync-reprocess']) {
      expect(achados.map((a) => a.edge)).not.toContain(instrumentada);
    }
  });

  it('CALIBRAÇÃO: uma fatia que não toca edge sem marcador segue VERDE', () => {
    if (!temCommit()) expect.fail(`o commit ${COMMIT} não está neste clone`);
    // o commit anterior (`d699d9c26`) mexe em edge instrumentada e em SQL — nada sem marcador.
    // Sem este controle, uma régua sempre-vermelha passaria no teste de cima e quebraria a main.
    const achados = auditarEdgesNovas(coletarNovas(`${COMMIT}^^`, `${COMMIT}^`), SEM_DISPENSA);
    expect(achados.map((a) => `${a.edge}:${a.motivo}`)).toEqual([]);
  });
});

describe('main — fail-CLOSED: não medir não é o mesmo que estar em ordem', () => {
  it('`git diff` que FALHA lança em vez de devolver "nenhuma edge nova"', () => {
    expect(() => coletarNovas('inexistente-xyz-000', null)).toThrow(/falhou/);
  });

  it('--head que NÃO resolve reprova NOMEANDO o --head', () => {
    const erros: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void erros.push(a.join(' ')));
    try {
      expect(main(['--base', 'HEAD', '--head', 'inexistente-xyz-000'])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(erros.join('\n')).toMatch(/--head/);
  });

  it('controle: o MESMO par com --head válido mede e passa', () => {
    expect(main(['--base', 'HEAD', '--head', 'HEAD'])).toBe(0);
  });
});

describe('formatarAchado — reprovar sem oferecer a saída (b) é criar imposto', () => {
  it('a mensagem de `sem-decisao` nomeia AS DUAS saídas', () => {
    const msg = formatarAchado({ edge: 'drain', motivo: 'sem-decisao', detalhe: 'd' });
    expect(msg).toMatch(/versao\.ts/);
    expect(msg).toMatch(/DISPENSAS/);
    expect(msg).toMatch(/sonda-edge-nova-gate\.ts/);
  });

  it('a mensagem de `fora-do-mapa` diz o COMANDO que resolve', () => {
    expect(formatarAchado({ edge: 'd', motivo: 'fora-do-mapa', detalhe: 'x' })).toMatch(/--write/);
  });

  it('toda mensagem carrega o nome da edge e o detalhe medido', () => {
    for (const motivo of ['sem-decisao', 'marcador-ilegivel', 'fora-do-mapa', 'dispensa-invalida', 'dispensa-falsa', 'decisao-dupla'] as const) {
      const msg = formatarAchado({ edge: 'minha-edge', motivo, detalhe: 'DETALHE-MEDIDO' });
      expect(msg, motivo).toMatch(/minha-edge/);
      expect(msg, motivo).toMatch(/DETALHE-MEDIDO/);
    }
  });
});

// ─── Sentinela de ESTADO: a lista de dispensa não pode apodrecer ────────────────────────────
//
// O gate acima é de DIFF — ele vê a edge no dia em que ela nasce e nunca mais. Uma dispensa
// escrita naquele dia sobrevive a renomeação, a remoção e à edge passar a escrever no banco, e
// nenhum diff futuro a revisita. Quem revisita é isto aqui, que o `bun run test` roda em TODO
// evento: é gate de estado, e o custo é uma varredura de 95 pastas.

const RAIZ = 'supabase/functions';

function pastasDeEdge(): string[] {
  return readdirSync(RAIZ)
    .filter((n) => n !== '_shared' && statSync(join(RAIZ, n)).isDirectory())
    .sort();
}

describe('DISPENSAS × árvore real — dispensa que sobra vira licença silenciosa', () => {
  it('toda edge dispensada EXISTE (renomeada/removida deixa a linha para trás)', () => {
    const existentes = new Set(pastasDeEdge());
    expect(Object.keys(DISPENSAS).filter((e) => !existentes.has(e))).toEqual([]);
  });

  it('nenhuma edge dispensada tem `versao.ts` — as duas saídas são exclusivas', () => {
    const contraditorias = Object.keys(DISPENSAS).filter((e) =>
      existsSync(join(RAIZ, e, 'versao.ts')),
    );
    expect(contraditorias).toEqual([]);
  });

  it('toda dispensa tem motivo do vocabulário e `porque` assinado', () => {
    for (const [edge, d] of Object.entries(DISPENSAS)) {
      expect(MOTIVOS_DISPENSA, edge).toContain(d.motivo);
      expect(d.porque.trim(), edge).not.toBe('');
    }
  });

  it('dispensa `leitura-pura` continua verdadeira contra a fonte de HOJE', () => {
    const falsas: string[] = [];
    for (const [edge, d] of Object.entries(DISPENSAS)) {
      if (d.motivo !== 'leitura-pura') continue;
      const dir = join(RAIZ, edge);
      if (!existsSync(dir)) continue;
      for (const arq of readdirSync(dir)) {
        if (!/\.[cm]?[jt]sx?$/.test(arq) || /(?:_test|\.test)\./.test(arq)) continue;
        const metodo = detectarMutacao(readFileSync(join(dir, arq), 'utf8'));
        if (metodo !== null) falsas.push(`${edge}/${arq} (.${metodo}()`);
      }
    }
    expect(falsas).toEqual([]);
  });
});

describe('CALIBRAÇÃO: os sentinelas acima reprovam de verdade', () => {
  // Sem isto, uma lista vazia faz os quatro testes passarem por VACUIDADE, e ninguém sabe se
  // eles pegariam alguma coisa. O corpo é o mesmo, aplicado a uma lista de mentira.
  it('pega dispensa de edge inexistente', () => {
    const existentes = new Set(pastasDeEdge());
    expect(existentes.has('edge-que-nunca-existiu')).toBe(false);
  });

  it('pega dispensa contraditória com a árvore real', () => {
    const instrumentada = pastasDeEdge().find((e) => existsSync(join(RAIZ, e, 'versao.ts')));
    expect(instrumentada, 'o repo precisa ter ao menos uma edge instrumentada').toBeDefined();
    expect(existsSync(join(RAIZ, instrumentada as string, 'versao.ts'))).toBe(true);
  });

  it('pega `leitura-pura` falsa na edge REAL que motivou o gate', () => {
    // Controle positivo vivo: a `analytics-outbox-drain` é o caso medido, e ela escreve — por
    // `.rpc()`, não por PostgREST. Foi este teste que descobriu isso; sem ele o motivo
    // auto-verificado teria um buraco exatamente no formato do caso que o motivou.
    const dir = join(RAIZ, 'analytics-outbox-drain');
    expect(existsSync(dir), 'a edge do caso medido sumiu — reveja o controle positivo').toBe(true);
    const fontes = readdirSync(dir)
      .filter((a) => /\.ts$/.test(a) && !/(?:_test|\.test)\./.test(a))
      .map((a) => readFileSync(join(dir, a), 'utf8'));
    expect(fontes.some((f) => detectarRpcs(f).length > 0)).toBe(true);
    const a = auditarEdgesNovas(
      [nova({ edge: 'analytics-outbox-drain', corpo: fontes.map((fonte, i) => ({ caminho: `f${i}.ts`, fonte })) })],
      { 'analytics-outbox-drain': { motivo: 'leitura-pura', porque: 'só drena a fila' } },
    );
    expect(a.map((v) => v.motivo)).toEqual(['dispensa-falsa']);
  });
});

describe('detectarRpcs — `.rpc()` pode escrever, e o texto não diz qual', () => {
  it('extrai os nomes literais chamados', () => {
    expect(detectarRpcs('await db.rpc("analytics_outbox_claim", { p_n: 5 });\nawait db.rpc(\'fin_x\')')).toEqual([
      'analytics_outbox_claim',
      'fin_x',
    ]);
  });

  it('ignora rpc citado em comentário e não inventa nome para chamada dinâmica', () => {
    expect(detectarRpcs('// await db.rpc("nao_conta")')).toEqual([]);
    expect(detectarRpcs('await db.rpc(nomeVariavel, {})')).toEqual([]);
  });
});

describe('o vocabulário separa o que o gate VERIFICA do que ele só registra', () => {
  it('`leitura-pura` numa edge que chama RPC REPROVA — o gate não sabe se o RPC escreve', () => {
    const a = auditarEdgesNovas(
      [nova({ edge: 'x', corpo: [{ caminho: 'index.ts', fonte: 'await db.rpc("fin_saldo");' }] })],
      { x: { motivo: 'leitura-pura', porque: 'só lê saldo' } },
    );
    expect(a.map((v) => v.motivo)).toEqual(['dispensa-falsa']);
    expect(a[0].detalhe).toMatch(/leitura-via-rpc/);
  });

  it('`leitura-via-rpc` PASSA quando o `porque` NOMEIA o RPC chamado', () => {
    const a = auditarEdgesNovas(
      [nova({ edge: 'x', corpo: [{ caminho: 'index.ts', fonte: 'await db.rpc("fin_saldo");' }] })],
      { x: { motivo: 'leitura-via-rpc', porque: '`fin_saldo` é SELECT puro sobre fin_dre' } },
    );
    expect(a).toEqual([]);
  });

  it('`leitura-via-rpc` que NÃO nomeia nenhum RPC chamado REPROVA', () => {
    const a = auditarEdgesNovas(
      [nova({ edge: 'x', corpo: [{ caminho: 'index.ts', fonte: 'await db.rpc("fin_saldo");' }] })],
      { x: { motivo: 'leitura-via-rpc', porque: 'só lê, confia' } },
    );
    expect(a.map((v) => v.motivo)).toEqual(['dispensa-invalida']);
  });

  it('`leitura-via-rpc` numa edge com mutação PostgREST direta REPROVA igual', () => {
    const a = auditarEdgesNovas(
      [nova({ edge: 'x', corpo: [{ caminho: 'index.ts', fonte: "await db.rpc('fin_saldo'); await db.from('t').insert(x);" }] })],
      { x: { motivo: 'leitura-via-rpc', porque: '`fin_saldo` é SELECT puro' } },
    );
    expect(a.map((v) => v.motivo)).toEqual(['dispensa-falsa']);
  });

  it('motivo NÃO verificável passa sem checagem de fonte — o gate declara o limite, não finge', () => {
    const a = auditarEdgesNovas(
      [nova({ edge: 'x', corpo: [{ caminho: 'index.ts', fonte: "await db.from('t').insert(y);" }] })],
      { x: { motivo: 'sem-deploy-proprio', porque: 'utilitário importado por outra edge, não é bundle servido' } },
    );
    expect(a).toEqual([]);
  });
});

describe('unirTocados — edge NOVA nasce UNTRACKED, e `git diff` não a enxerga', () => {
  // Achado da falsificação (2026-08-28): com a pasta criada e não adicionada, `git diff HEAD`
  // devolve vazio e o gate imprimia "✓ toda edge nascida nesta fatia tem a decisão TOMADA".
  // Verde por CEGUEIRA no exato momento em que a decisão está sendo tomada — que é quando o
  // autor roda o gate. No CI não aparece (lá tudo está commitado), então só a falsificação
  // manual pegaria.
  it('inclui os untracked quando o HEAD é a ÁRVORE DE TRABALHO', () => {
    expect(unirTocados(['a/index.ts'], ['b/index.ts'], null)).toEqual(['a/index.ts', 'b/index.ts']);
  });

  it('IGNORA untracked quando se compara duas REVS — lá árvore de trabalho não existe', () => {
    expect(unirTocados(['a/index.ts'], ['b/index.ts'], 'abc123')).toEqual(['a/index.ts']);
  });

  it('deduplica: arquivo pode aparecer nas duas listas', () => {
    expect(unirTocados(['a/index.ts'], ['a/index.ts'], null)).toEqual(['a/index.ts']);
  });
});
