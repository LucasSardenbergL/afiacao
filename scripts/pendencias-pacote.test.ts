import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FORMATO_SONDA, TOKEN_NAO, TOKEN_SIM } from './lib/precondicao-banco';
import { lerVeredito, main, separarSaida } from './pendencias-pacote';
import { type ExecutorGitBytes, REF_DEPLOYADA } from './pendencias-prompt';
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

describe('lerVeredito — o contrato com o pendencias:deploy --json', () => {
  const veredito = (estado: string, edge = 'copilot-analyze') => ({
    formato: 'pendencias-deploy/1',
    vereditos: [{ edge, estado }],
  });

  it('DIVERGE_P1 entra na leva — é o estado que a `copilot-analyze` tinha', () => {
    expect(lerVeredito(JSON.stringify(veredito('DIVERGE_P1')))).toEqual(['copilot-analyze']);
  });

  it('CONFERE não entra', () => {
    expect(lerVeredito(JSON.stringify(veredito('CONFERE')))).toEqual([]);
  });

  it('NUNCA_ATESTADA não entra — ausência de dado pede SONDA, não deploy', () => {
    expect(lerVeredito(JSON.stringify(veredito('NUNCA_ATESTADA')))).toEqual([]);
  });

  it('formato desconhecido LANÇA — não adivinha a leva', () => {
    expect(() => lerVeredito('{"formato":"outro/9","vereditos":[]}')).toThrow(/formato inesperado/);
  });

  it('JSON sem `vereditos` LANÇA — ausente ≠ leva vazia', () => {
    expect(() => lerVeredito('{"formato":"pendencias-deploy/1"}')).toThrow(/sem `vereditos`/);
  });

  it('stdin que não é JSON LANÇA', () => {
    expect(() => lerVeredito('nada disso')).toThrow(/não é JSON/);
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

  /** Working tree e ref com conteúdos INDEPENDENTES — é a divergência que estes testes medem. */
  function montarRepo(noDisco: string | null, naRef: string | null) {
    const raiz = mkdtempSync(join(tmpdir(), 'pacote-procedencia-'));
    escrever(raiz, ARQ_MAPA, MAPA);
    if (noDisco !== null) escrever(raiz, ENTRADA, noDisco);

    const naArvore = new Map<string, string>([[ARQ_MAPA, MAPA]]);
    if (naRef !== null) naArvore.set(ENTRADA, naRef);

    const git: ExecutorGitBytes = (args) => {
      const ok = (bytes: Buffer) => ({ ok: true, bytes, erro: '' });
      if (args[0] === 'rev-parse') return ok(Buffer.from(`${SHA_REF}\n`));
      if (args[0] === 'show') {
        const rel = String(args[1]).slice(`${REF_DEPLOYADA}:`.length);
        const c = naArvore.get(rel);
        return c === undefined
          ? { ok: false, bytes: Buffer.alloc(0), erro: `path '${rel}' does not exist` }
          : ok(Buffer.from(c, 'utf8'));
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
  function sondaFalsa(existentesEmProd: readonly string[]) {
    return (sql: string): string => {
      const pedidas = [...sql.matchAll(/\('([a-z0-9_]+)'\)/g)].map((m) => m[1]);
      return [
        ...pedidas.map((r) =>
          existentesEmProd.includes(r)
            ? `rpc|${r}|${TOKEN_SIM}|7`
            : `rpc|${r}|${TOKEN_NAO}|0`,
        ),
        'controle|funcoes_public|479|',
        `autoteste|presente|${TOKEN_SIM}|`,
        `autoteste|ausente|${TOKEN_NAO}|`,
        `fim|${FORMATO_SONDA}||`,
      ].join('\n');
    };
  }

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
});
