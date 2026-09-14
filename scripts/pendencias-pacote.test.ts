import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { md5Exato } from './lib/corpo-esperado';
import {
  AMOSTRA_CORPO_JS,
  FORMATO_SONDA,
  TOKEN_NAO,
  TOKEN_SEM_CORPO,
  TOKEN_SIM,
} from './lib/precondicao-banco';
import { lerRelatorio, main, separarSaida } from './pendencias-pacote';
import { type ExecutorGitBytes } from './pendencias-prompt';
import { ARQ_MAPA, RAIZ_EDGES } from './sonda-fingerprint';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Por que este arquivo existe
// ═══════════════════════════════════════════════════════════════════════════════════════════
// O `pendencias:pacote` é o GATE de ordem entre camadas (#2369): ele recusa a colagem da edge
// enquanto o banco de prod não tem a RPC que ela chama. Um gate que não lê a leva não gateia
// nada — e era o caso. `args.indexOf('--saida')` devolve `-1` quando a flag está ausente, então
// `iSaida + 1` valia **0** e o `filter` comia o argumento de índice 0: o `-` do pipe canônico
// impresso no próprio `uso:`, ou a única edge nomeada.
//
// O modo de falha não era um erro: era um VERDE. O CLI escrevia "✓ nada pendente de deploy" e
// saía 1 — a mesma saída de uma leva legitimamente vazia. Medido em 2026-09-08 com a
// `copilot-analyze` em `DIVERGE_P1`: `pendencias:pacote copilot-analyze` dizia "nada pendente",
// e `pendencias:pacote copilot-analyze --saida x.md` emitia o pacote. Um dia de gate cego.
//
// Estes testes cobrem a função PURA que passou a fazer a separação, e o par que falsifica:
// a asserção sem `--saida` fica VERMELHA se alguém restaurar o filtro de índice.

describe('separarSaida — o argumento de índice 0 sobrevive', () => {
  it('sem --saida, TODOS os alvos sobrevivem (o `-` do pipe canônico inclusive)', () => {
    expect(separarSaida(['-'])).toEqual({ nomes: ['-'] });
    expect(separarSaida(['copilot-analyze'])).toEqual({ nomes: ['copilot-analyze'] });
    expect(separarSaida(['a', 'b', 'c'])).toEqual({ nomes: ['a', 'b', 'c'] });
  });

  it('com --saida no fim, o alvo de índice 0 sobrevive e o caminho é extraído', () => {
    expect(separarSaida(['copilot-analyze', '--saida', 'p.md'])).toEqual({
      nomes: ['copilot-analyze'],
      saida: 'p.md',
    });
  });

  it('com --saida no começo, o alvo depois dela sobrevive', () => {
    expect(separarSaida(['--saida', 'p.md', 'copilot-analyze'])).toEqual({
      nomes: ['copilot-analyze'],
      saida: 'p.md',
    });
  });

  it('--saida sem caminho devolve `saida` indefinido — quem decide o exit 2 é o `main`', () => {
    expect(separarSaida(['edge-a', '--saida'])).toEqual({ nomes: ['edge-a'], saida: undefined });
  });

  it('sem argumento nenhum, leva vazia — e nada de `saida`', () => {
    expect(separarSaida([])).toEqual({ nomes: [] });
  });
});

describe('lerRelatorio — o contrato com o pendencias:deploy --json', () => {
  const veredito = (estado: string, edge = 'copilot-analyze', extra: Record<string, unknown> = {}) => ({
    formato: 'pendencias-deploy/1',
    vereditos: [{ edge, estado }],
    ...extra,
  });
  const nomes = (bruto: string) => lerRelatorio(bruto).nomes;

  it('DIVERGE_P1 entra na leva — é o estado que a `copilot-analyze` tinha', () => {
    expect(nomes(JSON.stringify(veredito('DIVERGE_P1')))).toEqual(['copilot-analyze']);
  });

  it('CONFERE não entra', () => {
    expect(nomes(JSON.stringify(veredito('CONFERE')))).toEqual([]);
  });

  it('NUNCA_ATESTADA não entra — ausência de dado pede SONDA, não deploy', () => {
    expect(nomes(JSON.stringify(veredito('NUNCA_ATESTADA')))).toEqual([]);
  });

  it('formato desconhecido LANÇA — não adivinha a leva', () => {
    expect(() => lerRelatorio('{"formato":"outro/9","vereditos":[]}')).toThrow(/formato inesperado/);
  });

  it('JSON sem `vereditos` LANÇA — ausente ≠ leva vazia', () => {
    expect(() => lerRelatorio('{"formato":"pendencias-deploy/1"}')).toThrow(/sem `vereditos`/);
  });

  it('stdin que não é JSON LANÇA', () => {
    expect(() => lerRelatorio('nada disso')).toThrow(/não é JSON/);
  });

  it('[RELATORIO_GERADO_EM_LIDO] `geradoEm` vira Date — é a régua da idade real das provas', () => {
    const r = lerRelatorio(JSON.stringify(veredito('CONFERE', 'x', { geradoEm: '2026-09-14T20:00:00.000Z' })));
    expect(r.geradoEm?.toISOString()).toBe('2026-09-14T20:00:00.000Z');
  });

  it('[RELATORIO_SEM_GERADO_EM_E_NULL] produtor anterior não é erro aqui — quem recusa a onda é o planejador', () => {
    expect(lerRelatorio(JSON.stringify(veredito('CONFERE'))).geradoEm).toBeNull();
  });

  it('[RELATORIO_GERADO_EM_ILEGIVEL_LANCA] instante fora do ISO do produtor não data prova', () => {
    for (const ruim of ['ontem', '2026-09-14', 1757880000000]) {
      expect(() => lerRelatorio(JSON.stringify(veredito('CONFERE', 'x', { geradoEm: ruim })))).toThrow(
        /`geradoEm` ilegível/,
      );
    }
  });

  it('os vereditos voltam CRUS e inteiros — o planejador valida só os que lê', () => {
    expect(lerRelatorio(JSON.stringify(veredito('DIVERGE_P1'))).vereditos).toEqual([
      { edge: 'copilot-analyze', estado: 'DIVERGE_P1' },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// A PROCEDÊNCIA das duas metades do gate
// ═══════════════════════════════════════════════════════════════════════════════════════════
// Achado do Codex em 2026-09-08, confirmado por leitura: as duas metades do gate liam FONTES
// DIFERENTES.
//
//   · a FATIA da colagem sai de `origin/main` (`fatiaDeDeploy(edge, raiz, arvore)`) — deliberado,
//     medido no #2123: o Lovable deploya a MAIN, não este checkout;
//   · a DESCOBERTA das RPCs saía do WORKING TREE (`coletarDaEdge` com `existsSync`/`readFileSync`).
//
// Numa worktree atrasada — o normal aqui, com ~30 em paralelo — a edge da main pode chamar uma RPC
// que este checkout desconhece. O gate então lia o `index.ts` VELHO, media em prod só as RPCs
// velhas (que existem), respondia `✅ pré-condição satisfeita` e EMITIA a colagem: o #2285
// reencenado pela ferramenta criada para evitá-lo. Ausente ≠ zero — a RPC que o disco não vê não
// é uma RPC que a edge não chama.
//
// O eixo destes testes é a DIVERGÊNCIA entre disco e ref, não "o gate bloqueia": por isso o
// controle positivo mora no mesmo `describe` — um harness sempre-vermelho aprovaria qualquer
// correção.
describe('pendencias:pacote — a leitura da edge sai da REF, não do disco', () => {
  const EDGE = 'edge-de-teste';
  const ENTRADA = `${RAIZ_EDGES}/${EDGE}/index.ts`;
  const SHA_REF = 'c0ffee1234567890c0ffee1234567890c0ffee12';
  const MAPA = 'export const FINGERPRINTS = {};\n';

  function escrever(raiz: string, rel: string, conteudo: string): void {
    const abs = join(raiz, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo, 'utf8');
  }

  /**
   * Working tree e ref com conteúdos INDEPENDENTES — é a divergência que estes testes medem.
   *
   * `migrations` alimenta o eixo 5 (#2428): o histórico de corpos sai das migrations da REF, lidas
   * por `ls-tree` + `cat-file --batch`. O fake reproduz o protocolo do `--batch`
   * (`<oid> SP blob SP <size> LF <bytes> LF`) em vez de devolver um formato inventado — o parser
   * fatia por TAMANHO, e um fixture "parecido" validaria a si mesmo.
   *
   * Sem migration nenhuma, `main` teria de morrer no controle positivo do inventário; por isso o
   * default traz uma, e os testes que querem o inventário vazio pedem `[]` explicitamente.
   */
  function montarRepo(
    noDisco: string | null,
    naRef: string | null,
    migrations: readonly { nome: string; sql: string }[] = [MIGRATION_BASE],
  ) {
    const raiz = mkdtempSync(join(tmpdir(), 'pacote-procedencia-'));
    escrever(raiz, ARQ_MAPA, MAPA);
    if (noDisco !== null) escrever(raiz, ENTRADA, noDisco);

    const naArvore = new Map<string, string>([[ARQ_MAPA, MAPA]]);
    if (naRef !== null) naArvore.set(ENTRADA, naRef);

    // oid falso de 40 hex, e o mapa de volta — `parseInt` sobre um oid alfanumérico dá NaN, e um
    // fake que erra o caminho de volta reprova o código certo.
    const porOid = new Map(migrations.map((m, i) => [`${'0'.repeat(39)}${i.toString(16)}`, m]));
    const oidDe = (i: number) => `${'0'.repeat(39)}${i.toString(16)}`;

    const git: ExecutorGitBytes = (args, entrada) => {
      const ok = (bytes: Buffer) => ({ ok: true, bytes, erro: '' });
      if (args[0] === 'rev-parse') return ok(Buffer.from(`${SHA_REF}\n`));
      if (args[0] === 'show') {
        // O prefixo é o SHA RESOLVIDO, não o nome da ref: `origin/main` é mutável e outra worktree
        // pode movê-la no meio da execução (#2428). Um fake que aceitasse os dois esconderia isso.
        const rel = String(args[1]).slice(`${SHA_REF}:`.length);
        const c = naArvore.get(rel);
        return c === undefined
          ? { ok: false, bytes: Buffer.alloc(0), erro: `path '${rel}' does not exist` }
          : ok(Buffer.from(c, 'utf8'));
      }
      if (args[0] === 'ls-tree' && args[2] === '--name-only') {
        // O inventário dos diretórios das edges (manifesto de ordem, #2469): os nomes da MESMA
        // `naArvore` que o `show` lê, sob os diretórios pedidos depois do `--`.
        if (args[3] !== SHA_REF) {
          return { ok: false, bytes: Buffer.alloc(0), erro: `ls-tree fora do sha: ${args[3]}` };
        }
        const dirs = args.slice(args.indexOf('--') + 1);
        const nomes = [...naArvore.keys()].filter((c) => dirs.some((d) => c.startsWith(d))).sort();
        return ok(Buffer.from(nomes.map((n) => `${n}\n`).join(''), 'utf8'));
      }
      if (args[0] === 'ls-tree') {
        if (args[2] !== SHA_REF) {
          return { ok: false, bytes: Buffer.alloc(0), erro: `ls-tree fora do sha: ${args[2]}` };
        }
        return ok(Buffer.from(
          migrations
            .map((m, i) => `100644 blob ${oidDe(i)}\tsupabase/migrations/${m.nome}`)
            .join('\n') + (migrations.length > 0 ? '\n' : ''),
          'utf8',
        ));
      }
      if (args[0] === 'cat-file') {
        const pedidos = (entrada ?? '').split('\n').filter(Boolean);
        const partes: Buffer[] = [];
        for (const oid of pedidos) {
          const m = porOid.get(oid);
          if (m === undefined) return { ok: false, bytes: Buffer.alloc(0), erro: `oid ${oid} ?` };
          const corpo = Buffer.from(m.sql, 'utf8');
          partes.push(Buffer.from(`${oid} blob ${corpo.length}\n`, 'utf8'), corpo, Buffer.from('\n'));
        }
        return ok(Buffer.concat(partes));
      }
      return { ok: false, bytes: Buffer.alloc(0), erro: `git não esperado: ${args.join(' ')}` };
    };
    return { raiz, git, saida: join(raiz, 'pacote.md') };
  }

  /**
   * Sonda falsa que responde ao que foi PEDIDO, com os tokens do PRÓPRIO módulo.
   *
   * O formato não sai da memória: `TOKEN_SIM`/`TOKEN_NAO`/`FORMATO_SONDA` são importados, que é a
   * regra que o `precondicao-de-banco-como-gate.md` §3 fixou depois de um fixture inventado de
   * cabeça custar um ciclo inteiro.
   */
  function sondaFalsa(
    existentesEmProd: readonly string[],
    corposEmProd: Record<string, string> = {},
  ) {
    return (sql: string): string => {
      const pedidas = [...sql.matchAll(/\('([a-z0-9_]+)'\)/g)].map((m) => m[1]);
      return [
        ...pedidas.map((r) =>
          existentesEmProd.includes(r)
            ? `rpc|${r}|${TOKEN_SIM}|7`
            : `rpc|${r}|${TOKEN_NAO}|0`,
        ),
        ...pedidas
          .filter((r) => existentesEmProd.includes(r))
          .map((r) => `corpo|${r}|${corposEmProd[r] ?? TOKEN_SEM_CORPO}|1`),
        'controle|funcoes_public|479|',
        `autoteste|presente|${TOKEN_SIM}|`,
        `autoteste|ausente|${TOKEN_NAO}|`,
        // O md5 da amostra do módulo — o laço TS↔SQL. Vem de `md5Exato` da lib porque aqui ele
        // simula o BANCO; o valor digitado à mão fica em `precondicao-banco.test.ts`, que é onde a
        // paridade com prod é a asserção.
        `autoteste|md5corpo|${md5Exato(AMOSTRA_CORPO_JS)}|`,
        `fim|${FORMATO_SONDA}||`,
      ].join('\n');
    };
  }

  /**
   * Uma migration com função DE VERDADE é o default porque o eixo 5 tem um controle positivo que
   * acusa "arquivos lidos e ZERO funções extraídas" como extrator quebrado. Um fixture de migration
   * vazia dispara esse controle — e ele está certo: no repo real, 721 migrations sem função nenhuma
   * só acontece se a extração morreu.
   */
  const CORPO_VELHO = ` SELECT 1; `;
  const CORPO_NOVO = ` SELECT 2; `;
  const MIGRATION_BASE = {
    nome: '20260101000000_base.sql',
    sql: `CREATE OR REPLACE FUNCTION public.rpc_velha() RETURNS int LANGUAGE sql AS $$${CORPO_VELHO}$$;\n`,
  };
  /** A segunda versão da MESMA função — o cenário do #2428 quando prod ficou na primeira. */
  const MIGRATION_NOVA = {
    nome: '20260202000000_recria.sql',
    sql: `CREATE OR REPLACE FUNCTION public.rpc_velha() RETURNS int LANGUAGE sql AS $$${CORPO_NOVO}$$;\n`,
  };

  const CHAMA_VELHA = `await db.rpc('rpc_velha', {});\n`;
  const CHAMA_AS_DUAS = `await db.rpc('rpc_velha', {});\nawait db.rpc('rpc_nova_da_main', {});\n`;

  it('BLOQUEIA (3) quando a REF chama uma RPC ausente em prod que o disco não conhece', () => {
    // O caso que estava passando: disco atrasado (só a velha), main à frente (velha + nova).
    const { raiz, git, saida } = montarRepo(CHAMA_VELHA, CHAMA_AS_DUAS);

    const codigo = main([EDGE, '--saida', saida, '--sem-rede'], raiz, git, sondaFalsa(['rpc_velha']));

    expect(codigo).toBe(3);
    const pacote = readFileSync(saida, 'utf8');
    expect(pacote).toContain('rpc_nova_da_main');
    expect(pacote).toContain('BLOQUEADO no passo 1');
  });

  // ── controle positivo, na MESMA invocação ────────────────────────────────────────────────
  // Sem estes dois, o teste acima seria satisfeito por um gate que bloqueia SEMPRE.
  it('LIBERA (0) quando disco e ref concordam e a RPC existe em prod', () => {
    const { raiz, git, saida } = montarRepo(CHAMA_VELHA, CHAMA_VELHA);

    const codigo = main([EDGE, '--saida', saida, '--sem-rede'], raiz, git, sondaFalsa(['rpc_velha']));

    expect(codigo).toBe(0);
  });

  it('LIBERA (0) quando a ref chama a RPC nova e ela JÁ está em prod — divergir do disco não é o crime', () => {
    const { raiz, git, saida } = montarRepo(CHAMA_VELHA, CHAMA_AS_DUAS);

    const codigo = main(
      [EDGE, '--saida', saida, '--sem-rede'],
      raiz,
      git,
      sondaFalsa(['rpc_velha', 'rpc_nova_da_main']),
    );

    expect(codigo).toBe(0);
  });

  // ── o fail-closed, do lado da REF ────────────────────────────────────────────────────────
  it('MECÂNICA (2) quando a edge existe no disco mas NÃO na ref — lista vazia não é "sem dependência"', () => {
    const { raiz, git, saida } = montarRepo(CHAMA_VELHA, null);

    const codigo = main([EDGE, '--saida', saida, '--sem-rede'], raiz, git, sondaFalsa(['rpc_velha']));

    expect(codigo).toBe(2);
  });

  // ── eixo 5 (#2428): existir não basta, e divergir não basta para bloquear ────────────────
  it('BLOQUEIA (3) quando a RPC EXISTE mas prod roda o corpo da migration ANTERIOR', () => {
    const { raiz, git, saida } = montarRepo(CHAMA_VELHA, CHAMA_VELHA, [MIGRATION_BASE, MIGRATION_NOVA]);

    const codigo = main([EDGE, '--saida', saida, '--sem-rede'], raiz, git, sondaFalsa(
      ['rpc_velha'],
      { rpc_velha: md5Exato(CORPO_VELHO) }, // prod ficou na PRIMEIRA versão
    ));

    expect(codigo).toBe(3);
    const pacote = readFileSync(saida, 'utf8');
    expect(pacote).toContain('20260202000000_recria.sql');
    expect(pacote).toContain('DESCARTA o campo em silêncio');
    // E a colagem NÃO sai — emiti-la aqui é o incidente inteiro.
    expect(pacote).not.toContain('Cole no chat do Lovable');
  });

  // ── controle positivo, na MESMA invocação: sem estes dois o teste acima seria satisfeito
  //    por um gate que bloqueia qualquer divergência — que travaria 17 das 65 RPCs deste repo.
  it('LIBERA (0) quando prod roda o corpo da ÚLTIMA migration', () => {
    const { raiz, git, saida } = montarRepo(CHAMA_VELHA, CHAMA_VELHA, [MIGRATION_BASE, MIGRATION_NOVA]);

    const codigo = main([EDGE, '--saida', saida, '--sem-rede'], raiz, git, sondaFalsa(
      ['rpc_velha'],
      { rpc_velha: md5Exato(CORPO_NOVO) },
    ));

    expect(codigo).toBe(0);
  });

  it('LIBERA (0) em DERIVA — corpo que migration nenhuma declara é edição manual, não atraso', () => {
    const { raiz, git, saida } = montarRepo(CHAMA_VELHA, CHAMA_VELHA, [MIGRATION_BASE, MIGRATION_NOVA]);

    const codigo = main([EDGE, '--saida', saida, '--sem-rede'], raiz, git, sondaFalsa(
      ['rpc_velha'],
      { rpc_velha: 'd'.repeat(32) },
    ));

    expect(codigo).toBe(0);
    // Mas o pacote DECLARA que não afirmou sobre ela — verde estreito, não verde largo.
    expect(readFileSync(saida, 'utf8')).toContain('fora do alcance do eixo de corpo');
  });

  it('MECÂNICA (2) quando a ref não tem migration nenhuma — inventário vazio é git quebrado', () => {
    const { raiz, git, saida } = montarRepo(CHAMA_VELHA, CHAMA_VELHA, []);

    expect(main([EDGE, '--saida', saida, '--sem-rede'], raiz, git, sondaFalsa(['rpc_velha']))).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// A ordem ENTRE edges (#2469) — o pacote de ponta a ponta
// ═══════════════════════════════════════════════════════════════════════════════════════════
// O planejador puro tem a suíte dele (`lib/ordem-entre-edges.test.ts`). Aqui se prova a FIAÇÃO: o
// manifesto sai da REF@sha por um inventário (e não do `null` ambíguo do `show`), a régua da prova
// sai do mapa e do `versao.ts` da MESMA ref, o JSON do ledger chega inteiro pelo stdin, e exit e
// pacote obedecem à partição. As marcas entre colchetes são as que o falsificador exige.
describe('pendencias:pacote — a ordem entre edges vira ONDA', () => {
  const SHA = 'feedface1234567890feedface1234567890feed';
  const A = 'edge-a';
  const B = 'edge-b';
  const FONTE_A = 'a'.repeat(64);
  const FONTE_B = 'b'.repeat(64);
  const VERSAO_A = 'v2.0-a';
  const MAPA_COM_AS_DUAS =
    'export const FONTE_SHA256: Record<string, string> = {\n' +
    `  "${A}": "${FONTE_A}",\n` +
    `  "${B}": "${FONTE_B}",\n` +
    '};\n';
  const MANIFESTO_B = JSON.stringify({
    formato: 'deploy-ordem/1',
    depoisDe: [{ edge: A, motivo: 'na ordem inversa a predecessora velha desfaz o que a nova grava', pr: 2469 }],
  });
  const MIGRATION = {
    nome: '20260101000000_base.sql',
    sql: 'CREATE OR REPLACE FUNCTION public.rpc_qualquer() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;\n',
  };

  /**
   * O commit com as duas edges e, por default, o manifesto de B. `quebrar` injeta a falha de git que
   * o inventário tem de separar de ausência: manifesto LISTADO e ilegível, ou listagem cega.
   */
  function repo(opcoes: { manifesto?: string | null; quebrar?: 'show-manifesto' | 'ls-tree-cego' } = {}) {
    const raiz = mkdtempSync(join(tmpdir(), 'pacote-ordem-'));
    const arvore = new Map<string, string>([
      [ARQ_MAPA, MAPA_COM_AS_DUAS],
      [`${RAIZ_EDGES}/${A}/index.ts`, 'import "./versao.ts";\nexport default {};\n'],
      [`${RAIZ_EDGES}/${A}/versao.ts`, `export const VERSAO = "${VERSAO_A}";\n`],
      [`${RAIZ_EDGES}/${B}/index.ts`, 'export default {};\n'],
    ]);
    const manifesto = opcoes.manifesto === undefined ? MANIFESTO_B : opcoes.manifesto;
    if (manifesto !== null) arvore.set(`${RAIZ_EDGES}/${B}/deploy-ordem.json`, manifesto);

    const git: ExecutorGitBytes = (args, entrada) => {
      const ok = (bytes: Buffer) => ({ ok: true, bytes, erro: '' });
      const nao = (erro: string) => ({ ok: false, bytes: Buffer.alloc(0), erro });
      if (args[0] === 'rev-parse') return ok(Buffer.from(`${SHA}\n`));
      if (args[0] === 'show') {
        const alvo = String(args[1]);
        const rev = alvo.slice(0, alvo.indexOf(':'));
        const rel = alvo.slice(alvo.indexOf(':') + 1);
        if (rev !== SHA) return nao(`show fora do sha: ${rev}`);
        if (opcoes.quebrar === 'show-manifesto' && rel.endsWith('/deploy-ordem.json')) return nao('fatal: bad object');
        const c = arvore.get(rel);
        return c === undefined ? nao(`path '${rel}' does not exist`) : ok(Buffer.from(c, 'utf8'));
      }
      if (args[0] === 'ls-tree' && args[2] === '--name-only') {
        if (args[3] !== SHA) return nao(`ls-tree fora do sha: ${args[3]}`);
        if (opcoes.quebrar === 'ls-tree-cego') return ok(Buffer.alloc(0));
        const dirs = args.slice(args.indexOf('--') + 1);
        const nomes = [...arvore.keys()].filter((c) => dirs.some((d) => c.startsWith(d))).sort();
        return ok(Buffer.from(nomes.map((n) => `${n}\n`).join(''), 'utf8'));
      }
      if (args[0] === 'ls-tree') {
        if (args[2] !== SHA) return nao(`ls-tree fora do sha: ${args[2]}`);
        return ok(Buffer.from(`100644 blob ${'0'.repeat(40)}\tsupabase/migrations/${MIGRATION.nome}\n`, 'utf8'));
      }
      if (args[0] === 'cat-file') {
        const corpo = Buffer.from(MIGRATION.sql, 'utf8');
        const oid = (entrada ?? '').trim();
        return ok(Buffer.concat([Buffer.from(`${oid} blob ${corpo.length}\n`, 'utf8'), corpo, Buffer.from('\n')]));
      }
      return nao(`git não esperado: ${args.join(' ')}`);
    };
    return { raiz, git, saida: join(raiz, 'pacote.md') };
  }

  const AGORA = new Date('2026-09-14T21:00:00.000Z');
  const veredito = (edge: string, over: Record<string, unknown> = {}) => ({
    edge,
    estado: 'CONFERE',
    esperado: FONTE_A,
    observado: FONTE_A,
    versaoEsperada: VERSAO_A,
    versao: VERSAO_A,
    via: 'sonda',
    criado: '2026-09-14 20:30:00+00',
    idadeHoras: 0.5,
    diasPendente: null,
    escalada: false,
    ...over,
  });
  const divergente = (edge: string) =>
    veredito(edge, { estado: 'DIVERGE_P1', esperado: 'e'.repeat(64), observado: 'd'.repeat(64), versao: 'v0-velha' });
  const ledger = (...vereditos: object[]) => (): string =>
    JSON.stringify({ formato: 'pendencias-deploy/1', ref: 'origin/main', geradoEm: '2026-09-14T20:59:00.000Z', vereditos });
  const semStdin = (): string => {
    throw new Error('o stdin não devia ser lido: a leva veio por nome');
  };
  const naoMede = (): string => {
    throw new Error('a sonda de banco não devia rodar: a leva não chama RPC');
  };

  function rodar(r: ReturnType<typeof repo>, entrada: () => string, alvos: string[] = ['-']) {
    const codigo = main([...alvos, '--saida', r.saida, '--sem-rede'], r.raiz, r.git, naoMede, entrada, () => AGORA);
    let pacote = '';
    try {
      pacote = readFileSync(r.saida, 'utf8');
    } catch {
      /* exit 2 não escreve pacote — e o teste diz se esperava isso */
    }
    const passo2 = pacote.slice(pacote.indexOf('## Passo 2'), pacote.indexOf('## Passo 3'));
    const ini = passo2.indexOf('~~~');
    const colagem = ini < 0 ? '' : passo2.slice(ini + 3, passo2.indexOf('~~~', ini + 3));
    return { codigo, pacote, colagem };
  }

  it('[PACOTE_ONDA_PARCIAL_EXIT_4] A e B pendentes: a colagem leva só A, e B fica retida', () => {
    const { codigo, pacote, colagem } = rodar(repo(), ledger(divergente(A), divergente(B)));
    expect(codigo).toBe(4);
    expect(colagem).toContain(`\`${A}\``);
    expect(colagem).not.toContain(B);
    expect(pacote).toMatch(/`edge-b`\*\* — ADIADA/);
  });

  it('[PACOTE_A_PROVADA_LIBERA_B_EXIT_0] controle: A servindo o par da REF há 31 min libera B', () => {
    const { codigo, colagem } = rodar(repo(), ledger(veredito(A), divergente(B)));
    expect(codigo).toBe(0);
    expect(colagem).toContain(`\`${B}\``);
  });

  it('[PACOTE_TUDO_RETIDO_EXIT_3] só B pendente e A nunca atestada: nenhuma colagem', () => {
    const nunca = veredito(A, { estado: 'NUNCA_ATESTADA', observado: null, versao: null, via: null, idadeHoras: null });
    const { codigo, pacote, colagem } = rodar(repo(), ledger(nunca, divergente(B)));
    expect(codigo).toBe(3);
    expect(colagem).toBe('');
    expect(pacote).not.toContain('Cole no chat do Lovable');
  });

  it('[PACOTE_POR_NOME_COM_ORDEM_EXIT_3] leva nomeada não tem ledger com que provar a predecessora', () => {
    const { codigo, colagem } = rodar(repo(), semStdin, [B]);
    expect(codigo).toBe(3);
    expect(colagem).toBe('');
  });

  it('[PACOTE_MANIFESTO_ILEGIVEL_MECANICA] manifesto listado e ilegível é exit 2, não "sem ordem"', () => {
    expect(rodar(repo({ quebrar: 'show-manifesto' }), ledger(veredito(A), divergente(B))).codigo).toBe(2);
  });

  it('[PACOTE_MANIFESTO_MALFORMADO_MECANICA] manifesto fora do contrato é exit 2', () => {
    expect(rodar(repo({ manifesto: '{ nao e json' }), ledger(veredito(A), divergente(B))).codigo).toBe(2);
  });

  it('[PACOTE_INVENTARIO_CEGO_MECANICA] listagem que não vê a própria edge é exit 2', () => {
    expect(rodar(repo({ quebrar: 'ls-tree-cego' }), ledger(veredito(A), divergente(B))).codigo).toBe(2);
  });

  it('[PACOTE_SEM_MANIFESTO_SEGUE_INTEIRO] controle: sem manifesto, A e B saem juntas como sempre', () => {
    const { codigo, colagem } = rodar(repo({ manifesto: null }), ledger(divergente(A), divergente(B)));
    expect(codigo).toBe(0);
    expect(colagem).toContain(`\`${A}\``);
    expect(colagem).toContain(`\`${B}\``);
  });
});
