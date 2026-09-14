import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { edgesInstrumentadas, fecharGrafo, lerMapaCommitado, RAIZ_EDGES } from '../sonda-fingerprint';
import { extrairVersao } from '../sonda-versao-sql';
import {
  acharCiclo,
  ASSENTAR_MIN,
  type EntradaPlano,
  FORMATO_MANIFESTO,
  FRESCOR_MAX_H,
  JSON_MAX_MIN,
  lerManifesto,
  type Manifesto,
  manifestosNoFecho,
  NOME_MANIFESTO,
  planejarOndas,
} from './ordem-entre-edges';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// As MARCAS entre colchetes nos títulos são contrato
// ═══════════════════════════════════════════════════════════════════════════════════════════
// `scripts/falsificar-ordem-entre-edges.sh` sabota uma regra por vez e exige que o vermelho traga a
// marca do teste que existe para ela — e que a mesma marca NÃO saia no controle verde da mesma
// invocação. ASCII, caixa fixa, sem acento: o log tem de sair igual em `LC_ALL=C` e em
// `pt_BR.UTF-8`. Renomear uma marca sem atualizar o falsificador o deixa sem dente.

const AGORA = new Date('2026-09-14T21:00:00.000Z');
const minAtras = (m: number): Date => new Date(AGORA.getTime() - m * 60_000);

const FONTE_A = 'a'.repeat(64);
const VERSAO_A = 'v2.0-a-nova';
const MOTIVO = 'na ordem inversa a predecessora velha desfaz o que a nova grava';

function manifesto(edge: string, ...depoisDe: string[]): Manifesto {
  return { edge, depoisDe: depoisDe.map((a) => ({ edge: a, motivo: MOTIVO, pr: 2469 })) };
}

/** Veredito no formato INTEIRO do `pendencias:deploy --json` — prova de A em dia por default. */
function veredito(edge: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

/** O cenário-base é o CONTROLE POSITIVO: B espera A, A provada há 31 min ⇒ B liberada. */
function entrada(over: Partial<EntradaPlano> = {}): EntradaPlano {
  return {
    leva: ['edge-b'],
    manifestos: new Map([['edge-b', manifesto('edge-b', 'edge-a')]]),
    ledger: { vereditos: [veredito('edge-a')], geradoEm: minAtras(1) },
    alvos: new Map([['edge-a', { fonte: FONTE_A, versao: VERSAO_A }]]),
    agora: AGORA,
    ...over,
  };
}

const ledgerCom = (...vereditos: Record<string, unknown>[]) => ({ vereditos, geradoEm: minAtras(1) });

describe('lerManifesto — parse ESTRITO, cada ramo com a sua marca', () => {
  const VALIDO = {
    formato: FORMATO_MANIFESTO,
    depoisDe: [{ edge: 'sync-reprocess', motivo: MOTIVO, pr: 2469 }],
  };
  const ler = (obj: unknown) => lerManifesto('omie-vendas-sync', JSON.stringify(obj));

  it('[MANIFESTO_VALIDO] lê a exigência com o dono vindo do DIRETÓRIO', () => {
    expect(ler(VALIDO)).toEqual({
      edge: 'omie-vendas-sync',
      depoisDe: [{ edge: 'sync-reprocess', motivo: MOTIVO, pr: 2469 }],
    });
  });

  it('[MANIFESTO_JSON_INVALIDO_LANCA] texto que não é JSON', () => {
    expect(() => lerManifesto('omie-vendas-sync', '{ nao')).toThrow(/não é JSON/);
  });

  it('[MANIFESTO_CHAVE_EXTRA_LANCA] chave desconhecida é ordem declarada que o gate não veria', () => {
    expect(() => ler({ ...VALIDO, antesDe: [] })).toThrow(/o contrato é exatamente/);
    expect(() => ler({ ...VALIDO, depoisDe: [{ ...VALIDO.depoisDe[0], desde: 'x' }] })).toThrow(
      /o contrato é exatamente/,
    );
  });

  it('[MANIFESTO_FORMATO_LANCA] formato de outra versão não é adivinhado', () => {
    expect(() => ler({ ...VALIDO, formato: 'deploy-ordem/2' })).toThrow(/formato "deploy-ordem\/2"/);
  });

  it('[MANIFESTO_VAZIO_LANCA] manifesto sem exigência', () => {
    expect(() => ler({ ...VALIDO, depoisDe: [] })).toThrow(/`depoisDe` vazio/);
  });

  it('[MANIFESTO_AUTORREFERENCIA_LANCA] a edge esperando por ela mesma', () => {
    expect(() => ler({ ...VALIDO, depoisDe: [{ ...VALIDO.depoisDe[0], edge: 'omie-vendas-sync' }] })).toThrow(
      /esperar por ela mesma/,
    );
  });

  it('[MANIFESTO_REPETIDA_LANCA] a mesma predecessora duas vezes', () => {
    expect(() => ler({ ...VALIDO, depoisDe: [VALIDO.depoisDe[0], VALIDO.depoisDe[0]] })).toThrow(/repetida/);
  });

  it('[MANIFESTO_SLUG_LANCA] predecessora fora do formato de slug', () => {
    expect(() => ler({ ...VALIDO, depoisDe: [{ ...VALIDO.depoisDe[0], edge: '../x' }] })).toThrow(/formato de slug/);
  });

  it('[MANIFESTO_MOTIVO_CURTO_LANCA] motivo que não diz o que quebra', () => {
    expect(() => ler({ ...VALIDO, depoisDe: [{ ...VALIDO.depoisDe[0], motivo: 'ordem' }] })).toThrow(
      /`motivo` com menos de/,
    );
  });

  it('[MANIFESTO_PR_INVALIDO_LANCA] pr que não é inteiro positivo', () => {
    expect(() => ler({ ...VALIDO, depoisDe: [{ ...VALIDO.depoisDe[0], pr: '2469' }] })).toThrow(/`pr` tem de ser/);
    expect(() => ler({ ...VALIDO, depoisDe: [{ ...VALIDO.depoisDe[0], pr: 0 }] })).toThrow(/`pr` tem de ser/);
  });
});

describe('acharCiclo e manifestosNoFecho — as duas peças que o gate do repo reusa', () => {
  it('[CICLO_DIRETO] a ↔ b devolve o ciclo', () => {
    const m = new Map([
      ['a', manifesto('a', 'b')],
      ['b', manifesto('b', 'a')],
    ]);
    expect(acharCiclo(['a', 'b'], m)).toEqual(['a', 'b', 'a']);
  });

  it('[CICLO_AUSENTE] cadeia a → b → c não é ciclo', () => {
    const m = new Map([
      ['b', manifesto('b', 'a')],
      ['c', manifesto('c', 'b')],
    ]);
    expect(acharCiclo(['a', 'b', 'c'], m)).toBeNull();
  });

  it('[CICLO_FORA_DOS_NOS_NAO_CONTA] predecessora fora do conjunto é espera de prova, não ordem entre ondas', () => {
    const m = new Map([
      ['a', manifesto('a', 'b')],
      ['b', manifesto('b', 'a')],
    ]);
    expect(acharCiclo(['a'], m)).toBeNull();
  });

  it('[FECHO_COM_MANIFESTO] acusa o manifesto dentro de um fecho de imports', () => {
    expect(
      manifestosNoFecho([`${RAIZ_EDGES}/x/index.ts`, `${RAIZ_EDGES}/x/${NOME_MANIFESTO}`]),
    ).toEqual([`${RAIZ_EDGES}/x/${NOME_MANIFESTO}`]);
  });

  it('[FECHO_SEM_MANIFESTO] nome parecido não é manifesto', () => {
    expect(manifestosNoFecho([`${RAIZ_EDGES}/x/nao-${NOME_MANIFESTO}`, `${RAIZ_EDGES}/x/index.ts`])).toEqual([]);
  });
});

describe('planejarOndas — B só ganha colagem com a predecessora PROVADA', () => {
  it('[ORDEM_SEM_REGRA_LIBERA_TUDO] leva sem manifesto sai inteira, mesmo sem ledger', () => {
    const plano = planejarOndas(entrada({ leva: ['y', 'x'], manifestos: new Map(), ledger: null, alvos: new Map() }));
    expect(plano).toEqual({ liberadas: ['x', 'y'], retidas: [], regras: [], exigidos: [] });
  });

  it('[ORDEM_A_PROVADA_LIBERA_B] par da REF observado há 31 min libera a dependente', () => {
    const plano = planejarOndas(entrada());
    expect(plano.liberadas).toEqual(['edge-b']);
    expect(plano.retidas).toEqual([]);
  });

  it('[ORDEM_B_ESPERA_A_NA_LEVA] estar na leva NÃO prova — mesmo com o par batendo, B espera a próxima onda', () => {
    const plano = planejarOndas(entrada({ leva: ['edge-a', 'edge-b'] }));
    expect(plano.liberadas).toEqual(['edge-a']);
    expect(plano.retidas).toEqual([
      expect.objectContaining({ edge: 'edge-b', tipo: 'ADIADA', espera: ['edge-a'] }),
    ]);
  });

  it('[ORDEM_PAR_FONTE_DIVERGE_BLOQUEIA] prod serve outro `fonte` e a predecessora não está na leva', () => {
    const plano = planejarOndas(entrada({ ledger: ledgerCom(veredito('edge-a', { observado: 'c'.repeat(64) })) }));
    expect(plano.liberadas).toEqual([]);
    expect(plano.retidas[0]).toMatchObject({ edge: 'edge-b', tipo: 'BLOQUEADA' });
    expect(plano.retidas[0].motivos.join()).toMatch(/a REF espera/);
  });

  it('[ORDEM_PAR_VERSAO_DIVERGE_BLOQUEIA] `fonte` certo com VERSAO errada é bundle incoerente, não prova', () => {
    const plano = planejarOndas(entrada({ ledger: ledgerCom(veredito('edge-a', { versao: 'v1.9-a-velha' })) }));
    expect(plano.retidas[0]).toMatchObject({ edge: 'edge-b', tipo: 'BLOQUEADA' });
    expect(plano.retidas[0].motivos.join()).toMatch(/versao v1\.9-a-velha/);
  });

  it('[ORDEM_NUNCA_ATESTADA_BLOQUEIA] predecessora sem observação', () => {
    const plano = planejarOndas(
      entrada({
        ledger: ledgerCom(
          veredito('edge-a', { estado: 'NUNCA_ATESTADA', observado: null, versao: null, via: null, idadeHoras: null }),
        ),
      }),
    );
    expect(plano.retidas[0]).toMatchObject({ tipo: 'BLOQUEADA' });
    expect(plano.retidas[0].motivos.join()).toMatch(/NUNCA_ATESTADA/);
  });

  it('[ORDEM_A_AUSENTE_DO_LEDGER_BLOQUEIA] ausente ≠ provada', () => {
    const plano = planejarOndas(entrada({ ledger: ledgerCom() }));
    expect(plano.retidas[0].motivos.join()).toMatch(/ausente do veredito do ledger/);
  });

  it('[ORDEM_A_VELHA_BLOQUEIA] prova acima do teto de frescor manda sondar', () => {
    const plano = planejarOndas(entrada({ ledger: ledgerCom(veredito('edge-a', { idadeHoras: FRESCOR_MAX_H + 0.5 })) }));
    expect(plano.retidas[0]).toMatchObject({ tipo: 'BLOQUEADA' });
    expect(plano.retidas[0].motivos.join()).toMatch(/sonda:sql edge-a/);
  });

  it('[ORDEM_A_RECENTE_ADIA] prova mais nova que o assentamento adia — a invocação velha pode estar em voo', () => {
    // 3 min no ledger + 1 min de JSON = 4 min < 10 ⇒ faltam 6.
    const plano = planejarOndas(entrada({ ledger: ledgerCom(veredito('edge-a', { idadeHoras: 0.05 })) }));
    expect(ASSENTAR_MIN).toBe(10);
    expect(plano.retidas[0]).toMatchObject({ edge: 'edge-b', tipo: 'ADIADA' });
    expect(plano.retidas[0].motivos.join()).toMatch(/aguarde 6 min/);
  });

  it('[ORDEM_IDADE_REAL_SOMA_JSON] a idade da prova é a do ledger MAIS a do JSON', () => {
    // 8 min no ledger não assentam; somados aos 5 min desde a medição, 13 min assentam.
    const plano = planejarOndas(
      entrada({ ledger: { vereditos: [veredito('edge-a', { idadeHoras: 8 / 60 })], geradoEm: minAtras(5) } }),
    );
    expect(plano.liberadas).toEqual(['edge-b']);
  });

  it('[ORDEM_SEM_LEDGER_BLOQUEIA] leva por nome não tem com o que provar a predecessora', () => {
    const plano = planejarOndas(entrada({ ledger: null }));
    expect(plano.retidas[0]).toMatchObject({ tipo: 'BLOQUEADA' });
    expect(plano.retidas[0].motivos.join()).toMatch(/por NOME/);
  });

  it('[ORDEM_SEM_GERADO_EM_BLOQUEIA] JSON de produtor anterior não data a prova', () => {
    const plano = planejarOndas(entrada({ ledger: { vereditos: [veredito('edge-a')], geradoEm: null } }));
    expect(plano.retidas[0].motivos.join()).toMatch(/não traz `geradoEm`/);
  });

  it('[ORDEM_JSON_VELHO_BLOQUEIA] veredito acima do teto de idade não libera onda', () => {
    const plano = planejarOndas(
      entrada({ ledger: { vereditos: [veredito('edge-a')], geradoEm: minAtras(JSON_MAX_MIN + 15) } }),
    );
    expect(plano.retidas[0]).toMatchObject({ tipo: 'BLOQUEADA' });
    expect(plano.retidas[0].motivos.join()).toMatch(/meça de novo/);
  });

  it('[ORDEM_JSON_NO_FUTURO_BLOQUEIA] relógio incoerente não vira idade negativa que assenta', () => {
    const plano = planejarOndas(
      entrada({ ledger: { vereditos: [veredito('edge-a')], geradoEm: minAtras(-10) } }),
    );
    expect(plano.retidas[0].motivos.join()).toMatch(/no FUTURO/);
  });

  it('[ORDEM_ALVO_AUSENTE_BLOQUEIA] sem o par da REF a prova é impossível', () => {
    const plano = planejarOndas(entrada({ alvos: new Map() }));
    expect(plano.retidas[0].motivos.join()).toMatch(/a REF não dá o par/);
  });

  it('[ORDEM_TRANSITIVA_SO_A_SAI] a → b → c na mesma leva: só a primeira sai', () => {
    const plano = planejarOndas(
      entrada({
        leva: ['c', 'b', 'a'],
        manifestos: new Map([
          ['b', manifesto('b', 'a')],
          ['c', manifesto('c', 'b')],
        ]),
        ledger: ledgerCom(),
        alvos: new Map(),
      }),
    );
    expect(plano.liberadas).toEqual(['a']);
    expect(plano.retidas.map((r) => [r.edge, r.tipo, r.espera])).toEqual([
      ['b', 'ADIADA', ['a']],
      ['c', 'ADIADA', ['b']],
    ]);
  });

  it('[ORDEM_BLOQUEIO_VENCE_ADIAMENTO] uma predecessora na leva e outra sem prova: é BLOQUEADA', () => {
    const plano = planejarOndas(
      entrada({
        leva: ['edge-a', 'edge-b'],
        manifestos: new Map([['edge-b', manifesto('edge-b', 'edge-a', 'edge-z')]]),
      }),
    );
    expect(plano.retidas).toEqual([
      expect.objectContaining({ edge: 'edge-b', tipo: 'BLOQUEADA', espera: ['edge-a', 'edge-z'] }),
    ]);
  });

  it('[ORDEM_CICLO_LANCA] ciclo na leva é mecânica: nenhuma onda começaria', () => {
    expect(() =>
      planejarOndas(
        entrada({
          leva: ['a', 'b'],
          manifestos: new Map([
            ['a', manifesto('a', 'b')],
            ['b', manifesto('b', 'a')],
          ]),
        }),
      ),
    ).toThrow(/ciclo de ordem na leva: a → b → a/);
  });

  it('[ORDEM_VEREDITO_DUPLICADO_LANCA] dois vereditos para a predecessora', () => {
    expect(() => planejarOndas(entrada({ ledger: ledgerCom(veredito('edge-a'), veredito('edge-a')) }))).toThrow(
      /não adivinho qual vale/,
    );
  });

  it('[ORDEM_VEREDITO_MALFORMADO_LANCA] veredito da predecessora fora do contrato', () => {
    expect(() => planejarOndas(entrada({ ledger: ledgerCom(veredito('edge-a', { idadeHoras: '0.5' })) }))).toThrow(
      /fora do contrato do pendencias:deploy/,
    );
  });

  it('[ORDEM_MANIFESTO_FORA_DA_LEVA_LANCA] manifesto de edge que não está na leva', () => {
    expect(() => planejarOndas(entrada({ leva: ['outra'] }))).toThrow(/fora da leva/);
  });

  it('[ORDEM_REGRAS_E_EXIGIDOS_NO_PLANO] o plano carrega o que entra no SHA do pacote', () => {
    const plano = planejarOndas(entrada());
    expect(plano.regras).toEqual([{ edge: 'edge-b', depoisDe: ['edge-a'] }]);
    expect(plano.exigidos).toEqual([{ edge: 'edge-a', fonte: FONTE_A, versao: VERSAO_A }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// O gate sobre os manifestos COMMITADOS
// ═══════════════════════════════════════════════════════════════════════════════════════════
// Roda no `bun run test` sobre o repo real. Três perguntas que o planejador não consegue fazer em
// prod: o manifesto parseia? a predecessora tem par PROVÁVEL (está no mapa e tem VERSAO)? o manifesto
// ficou fora do fecho de imports (senão ele muda o `fonte` e vira código servido)? Hoje o repo pode
// não ter manifesto nenhum — por isso o inventário tem controle positivo, e cada pergunta tem a sua
// peça testada com fixture acima.
describe('manifestos commitados — o gate do repo', () => {
  const RAIZ = join(import.meta.dirname, '..', '..');
  const BASE = join(RAIZ, RAIZ_EDGES);
  const edges = readdirSync(BASE)
    .filter((n) => n !== '_shared' && existsSync(join(BASE, n, 'index.ts')))
    .sort();
  const comManifesto = edges.filter((e) => existsSync(join(BASE, e, NOME_MANIFESTO)));

  it('[GATE_INVENTARIO_VIVO] enxerga as edges do repo — varredura vazia não é "nenhum manifesto"', () => {
    expect(edges.length).toBeGreaterThan(50);
  });

  it('[GATE_MANIFESTO_VALIDO] todo manifesto parseia, e dependente e predecessoras têm par provável', () => {
    const mapa = lerMapaCommitado(RAIZ);
    expect(Object.keys(mapa).length).toBeGreaterThan(20);
    const problemas: string[] = [];
    const versaoLegivel = (edge: string) => {
      const arq = join(BASE, edge, 'versao.ts');
      return existsSync(arq) && extrairVersao(readFileSync(arq, 'utf8')) !== null;
    };
    for (const edge of comManifesto) {
      let m: Manifesto;
      try {
        m = lerManifesto(edge, readFileSync(join(BASE, edge, NOME_MANIFESTO), 'utf8'));
      } catch (e) {
        problemas.push(String(e));
        continue;
      }
      if (mapa[edge] === undefined) problemas.push(`${edge}: dependente fora do mapa de sondas — o ledger não a julga`);
      for (const x of m.depoisDe) {
        if (!edges.includes(x.edge)) problemas.push(`${edge}: predecessora ${x.edge} não existe`);
        else if (mapa[x.edge] === undefined) problemas.push(`${edge}: predecessora ${x.edge} fora do mapa — a prova é impossível`);
        else if (!versaoLegivel(x.edge)) problemas.push(`${edge}: predecessora ${x.edge} sem VERSAO legível`);
      }
    }
    expect(problemas).toEqual([]);
  });

  it('[GATE_SEM_CICLO] o grafo de ordem do repo não tem ciclo', () => {
    const manifestos = new Map(
      comManifesto.map((e) => [e, lerManifesto(e, readFileSync(join(BASE, e, NOME_MANIFESTO), 'utf8'))] as const),
    );
    expect(acharCiclo(edges, manifestos)).toBeNull();
  });

  it('[GATE_MANIFESTO_FORA_DO_FECHO] nenhum fecho de imports inclui um manifesto', () => {
    const instrumentadas = edgesInstrumentadas(RAIZ);
    expect(instrumentadas.length).toBeGreaterThan(20);
    const achados = instrumentadas.flatMap((e) =>
      manifestosNoFecho(fecharGrafo(`${RAIZ_EDGES}/${e}/index.ts`, RAIZ)).map((c) => `${e} importa ${c}`),
    );
    expect(achados).toEqual([]);
  });
});
