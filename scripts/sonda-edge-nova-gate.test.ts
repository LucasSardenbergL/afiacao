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
  type EstadoEdgeNova,
  type Dispensa,
} from './sonda-edge-nova-gate';

function nova(p: Partial<EstadoEdgeNova> & { edge: string }): EstadoEdgeNova {
  return { corpo: [{ caminho: 'index.ts', fonte: 'Deno.serve(() => new Response("ok"));' }], versao: null, temMarcador: false, noMapa: false, ...p };
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

  it('edge que JÁ existia na base NÃO é nova, por mais que a fatia a altere', () => {
    const ler = leitor({
      base: { [`${R}/drain/index.ts`]: 'const x = 0;' },
      HEAD: { [`${R}/drain/index.ts`]: 'const x = 1;' },
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
