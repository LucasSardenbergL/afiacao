import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { removerComentarios } from '@/lib/gates/limpeza-fonte';

import {
  atribuirSondasSemIdentidade,
  DATA_ECO_COM_IDENTIDADE,
  edgesParaSondar,
  ESCALAR_P2_APOS_DIAS,
  julgar,
  lerTolerancia,
  LIMITE_FORA_DO_MAPA_HORAS,
  parsearIds,
  parsearObservacoes,
  parsearSondasSemIdentidade,
  resumirSemIdentidade,
  SEM_FONTE,
  SEM_IDENTIDADE,
  SEM_MAPA,
  type Contexto,
  type Esperado,
  type Observacao,
  type SondaSemIdentidade,
} from './lib/pendencias-deploy';
import {
  CRON_COLETOR,
  formatarSemIdentidade,
  lerArgIds,
  MIGRATION_LEDGER,
  SQL,
  SQL_SAUDE_COLETOR,
  SQL_SEM_IDENTIDADE,
} from './pendencias-deploy';

const ESPERADOS: Record<string, Esperado> = {
  'edge-a': { fonte: 'aaa111', versao: 'v1.0-a' },
  'edge-b': { fonte: 'bbb222', versao: 'v1.0-b' },
};

const obs = (
  edge: string,
  fonte: string,
  extra: Partial<Omit<Observacao, 'edge' | 'fonte'>> = {},
): Observacao => ({
  edge,
  fonte,
  versao: extra.versao ?? (edge === 'edge-a' ? 'v1.0-a' : 'v1.0-b'),
  via: extra.via ?? 'sonda',
  criado: extra.criado ?? '2026-09-05 17:34Z',
  idadeHoras: extra.idadeHoras ?? 1,
});

/** Contexto de git FIXO: o teste decide se o par observado existiu na main e há quanto tempo. */
const ctx = (coerente = true, dias: number | null = 1): Contexto => ({
  parCoerente: () => coerente,
  diasPendente: () => dias,
});

const OK = [obs('edge-a', 'aaa111'), obs('edge-b', 'bbb222')];

describe('parsearObservacoes', () => {
  it('o SET do wrapper NÃO conta como ruído — senão a mecânica reprovaria em toda execução', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes(
      'SET\nSET\nedge-a|v1.0-a|aaa111|sonda|2026-09-05 17:34Z|1.5\n',
    );
    expect(observacoes).toEqual([
      { edge: 'edge-a', versao: 'v1.0-a', fonte: 'aaa111', via: 'sonda', criado: '2026-09-05 17:34Z', idadeHoras: 1.5 },
    ]);
    expect(linhasIgnoradas).toBe(0);
  });

  it('mas ruído DE VERDADE continua contado — o filtro é do chatter conhecido, não de tudo', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes(
      'SET\nERROR: alguma coisa\nedge-a|v1.0-a|aaa111|eco|hoje|0.1\n',
    );
    expect(observacoes).toHaveLength(1);
    expect(linhasIgnoradas).toBe(1);
  });

  it('CONTA a linha malformada — a descartada pode ser justamente a divergência (CLI: exit 2)', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes(
      'edge-a|v1|aaa111|sonda|hoje\nedge-b|v1|bbb222|sonda|hoje|2\n',
    );
    expect(observacoes.map((o) => o.edge)).toEqual(['edge-b']);
    expect(linhasIgnoradas).toBe(1);
  });

  it('`via` fora do vocabulário e idade não numérica/negativa são IGNORADAS, não interpretadas', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes(
      'edge-a|v1|aaa111|cron|hoje|1\nedge-a|v1|aaa111|sonda|hoje|abc\nedge-a|v1|aaa111|sonda|hoje|-1\n',
    );
    expect(observacoes).toHaveLength(0);
    expect(linhasIgnoradas).toBe(3);
  });
});

describe('julgar — a matriz do par (versao, fonte)', () => {
  it('(=, =) CONFERE — e nada pendente', () => {
    const r = julgar(ESPERADOS, OK, ctx());
    expect(r.vereditos.every((v) => v.estado === 'CONFERE')).toBe(true);
    expect(r.totalPendentes).toBe(0);
    expect(r.totalUrgentes).toBe(0);
  });

  it('(=, ≠) é INCOERENTE, nunca CONFERE — versao.ts está no closure, fonte igual exige versao igual', () => {
    const r = julgar(ESPERADOS, [obs('edge-a', 'aaa111', { versao: 'v0.9-a' }), obs('edge-b', 'bbb222')], ctx());
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('INCOERENTE');
    expect(r.totalUrgentes).toBe(1);
  });

  it('(≠, ≠) é P1 — bump declarado, deploy no PR, urgente, com os dois lados e a idade da pendência', () => {
    const r = julgar(ESPERADOS, [obs('edge-a', 'ANTIGO0', { versao: 'v0.9-a' }), obs('edge-b', 'bbb222')], ctx(true, 3));
    const a = r.vereditos.find((v) => v.edge === 'edge-a');
    expect(a?.estado).toBe('DIVERGE_P1');
    expect(a?.esperado).toBe('aaa111');
    expect(a?.observado).toBe('ANTIGO0');
    expect(a?.versaoEsperada).toBe('v1.0-a');
    expect(a?.versao).toBe('v0.9-a');
    expect(a?.diasPendente).toBe(3);
    expect(r.totalUrgentes).toBe(1);
    expect(r.totalPendentes).toBe(1);
  });

  it('(≠, =) com par COERENTE na main é P2 — pendente (exit 1), mas não urgente', () => {
    const r = julgar(ESPERADOS, [obs('edge-a', 'ANTIGO0'), obs('edge-b', 'bbb222')], ctx(true, 2));
    const a = r.vereditos.find((v) => v.edge === 'edge-a');
    expect(a?.estado).toBe('DIVERGE_P2');
    expect(a?.escalada).toBe(false);
    expect(r.totalPendentes).toBe(1);
    expect(r.totalUrgentes).toBe(0);
  });

  it('(≠, =) com par que NUNCA existiu na main é INCOERENTE — deploy parcial (versao.ts novo, mapa velho)', () => {
    const r = julgar(ESPERADOS, [obs('edge-a', 'ANTIGO0'), obs('edge-b', 'bbb222')], ctx(false));
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('INCOERENTE');
    expect(r.totalUrgentes).toBe(1);
  });

  it(`P2 pendente há mais de ${ESCALAR_P2_APOS_DIAS} dias é ESCALADA — conta como urgente`, () => {
    const r = julgar(ESPERADOS, [obs('edge-a', 'ANTIGO0'), obs('edge-b', 'bbb222')], ctx(true, ESCALAR_P2_APOS_DIAS + 1));
    const a = r.vereditos.find((v) => v.edge === 'edge-a');
    expect(a?.estado).toBe('DIVERGE_P2');
    expect(a?.escalada).toBe(true);
    expect(r.totalUrgentes).toBe(1);
    expect(r.totalPendentes).toBe(1);
  });

  it('P2 exatamente no limite NÃO escala; idade desconhecida (null) também não', () => {
    expect(
      julgar(ESPERADOS, [obs('edge-a', 'ANTIGO0'), obs('edge-b', 'bbb222')], ctx(true, ESCALAR_P2_APOS_DIAS)).vereditos[0].escalada,
    ).toBe(false);
    expect(
      julgar(ESPERADOS, [obs('edge-a', 'ANTIGO0'), obs('edge-b', 'bbb222')], ctx(true, null)).vereditos[0].escalada,
    ).toBe(false);
  });

  it('ARMADILHA 1 — edge sem observação é NUNCA_ATESTADA: pendente, e na lista da sonda', () => {
    const r = julgar(ESPERADOS, [obs('edge-a', 'aaa111')], ctx());
    expect(r.vereditos.find((v) => v.edge === 'edge-b')?.estado).toBe('NUNCA_ATESTADA');
    expect(r.totalObservadas).toBe(1);
    expect(r.totalPendentes).toBe(1);
    expect(r.totalUrgentes).toBe(0);
    expect(edgesParaSondar(r)).toEqual(['edge-b']);
  });

  it('ARMADILHA 2 — fonte "nao-mapeada" é DIVERGÊNCIA URGENTE, não ausência', () => {
    const r = julgar(ESPERADOS, [obs('edge-a', SEM_MAPA), obs('edge-b', 'bbb222')], ctx());
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('SEM_MAPA_NO_BUNDLE');
    expect(r.totalUrgentes).toBe(1);
  });

  it('ARMADILHA 3 — eco sem fonte não prova o closure: não é CONFERE nem P2, é "sonde-a"', () => {
    const r = julgar(ESPERADOS, [obs('edge-a', SEM_FONTE, { via: 'eco' }), obs('edge-b', 'bbb222')], ctx());
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('SEM_FONTE_NO_ECO');
    expect(r.totalPendentes).toBe(1);
    expect(r.totalUrgentes).toBe(0);
    expect(r.totalObservadas).toBe(2);
    expect(edgesParaSondar(r)).toEqual(['edge-a']);
  });

  it('ARMADILHA 4 — zero observações não vira relatório limpo', () => {
    const r = julgar(ESPERADOS, [], ctx());
    expect(r.totalObservadas).toBe(0);
    expect(r.vereditos.every((v) => v.estado === 'NUNCA_ATESTADA')).toBe(true);
    expect(r.totalPendentes).toBe(2);
  });

  it('a observação MAIS RECENTE (menor idade) vence quando há várias da mesma edge', () => {
    const r = julgar(
      ESPERADOS,
      [obs('edge-a', 'ANTIGO0', { idadeHoras: 30 }), obs('edge-a', 'aaa111', { idadeHoras: 2 }), obs('edge-b', 'bbb222')],
      ctx(),
    );
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('CONFERE');
  });

  it('ARMADILHA 5 — edge fora do mapa com observação FRESCA é divergência urgente…', () => {
    const r = julgar(ESPERADOS, [...OK, obs('fantasma', 'xxx', { idadeHoras: 2 })], ctx());
    expect(r.vereditos.find((v) => v.edge === 'fantasma')?.estado).toBe('FORA_DO_MAPA');
    expect(r.totalUrgentes).toBe(1);
    expect(r.foraDoMapaHistoricas).toEqual([]);
  });

  it('…mas com observação VELHA é só história — o ledger eterno não fabrica "prod serve X"', () => {
    const r = julgar(ESPERADOS, [...OK, obs('fantasma', 'xxx', { idadeHoras: LIMITE_FORA_DO_MAPA_HORAS + 1 })], ctx());
    expect(r.vereditos.find((v) => v.edge === 'fantasma')).toBeUndefined();
    expect(r.foraDoMapaHistoricas).toEqual(['fantasma']);
    expect(r.totalUrgentes).toBe(0);
    expect(r.totalPendentes).toBe(0);
  });

  it('o eco passivo chega inteiro: `via: eco` com fonte batendo é CONFERE e conta como observada', () => {
    const rel = julgar(
      { 'analytics-outbox-drain': { fonte: 'b03bbf88', versao: 'v1.1-guard' } },
      [obs('analytics-outbox-drain', 'b03bbf88', { via: 'eco', versao: 'v1.1-guard', idadeHoras: 0.1 })],
      ctx(),
    );
    expect(rel.vereditos[0].estado).toBe('CONFERE');
    expect(rel.vereditos[0].via).toBe('eco');
    expect(rel.totalObservadas).toBe(1);
  });

  it('o contexto de git LANÇA → o erro sobe (o CLI converte em exit 2), nunca vira P2 por omissão', () => {
    const quebrado: Contexto = {
      parCoerente: () => {
        throw new Error('git indisponível');
      },
      diasPendente: () => null,
    };
    expect(() => julgar(ESPERADOS, [obs('edge-a', 'ANTIGO0'), obs('edge-b', 'bbb222')], quebrado)).toThrow(/git/);
  });
});

describe('lerTolerancia — a válvula do bootstrap', () => {
  it('ausente/vazio = NÃO tolerar (nunca atestada é pendência por padrão)', () => {
    expect(lerTolerancia(undefined)).toBe(false);
    expect(lerTolerancia(' ')).toBe(false);
  });

  it('1 tolera, 0 não', () => {
    expect(lerTolerancia('1')).toBe(true);
    expect(lerTolerancia('0')).toBe(false);
  });

  it('LANÇA no inválido em vez de cair no padrão calado', () => {
    for (const ruim of ['sim', 'true', '2']) {
      expect(() => lerTolerancia(ruim)).toThrow(/PENDENCIAS_TOLERAR_NUNCA_ATESTADA/);
    }
  });
});

/**
 * O SQL como TEXTO — o único gate desta correção que roda no CI.
 *
 * A prova de verdade é `db/test-deploy-atestacoes.sh`, que EXECUTA a migration, o coletor e
 * estas queries num PG17 com fixtures e falsifica. Mas `db/test-*.sh` precisa de Postgres local e
 * não roda no CI, então sozinha ela não impede alguém de reintroduzir o filtro errado num
 * refactor. Estas asserções são o cão de guarda barato: leem o SQL como texto e casam a MARCA de
 * cada ramo.
 */
describe('SQL da varredura — ledger ∪ janela viva, uma definição só', () => {
  const semEspacos = SQL.replace(/\s+/g, ' ');

  it('lê o LEDGER e a JANELA VIVA pela função do banco — não redefine o filtro no cliente', () => {
    expect(semEspacos).toContain('FROM public.deploy_atestacoes ');
    expect(semEspacos).toContain('FROM public.deploy_atestacoes_janela_viva()');
    expect(semEspacos).not.toContain('net._http_response');
    expect(semEspacos).not.toContain("'probe'");
  });

  it('uma linha por edge, a mais recente, com desempate por request_id (created não é ordem total)', () => {
    expect(semEspacos).toContain('DISTINCT ON (edge)');
    expect(semEspacos).toContain('ORDER BY edge, observado_em DESC, request_id DESC');
  });

  it('a idade vem do banco, em horas — a lib não faz parse de timestamptz', () => {
    expect(semEspacos).toContain('now() - observado_em');
    expect(semEspacos).toContain('/ 3600.0');
  });

  it('a saúde do coletor lê cron.job_run_details pelo NOME do job, só execuções bem-sucedidas', () => {
    const s = SQL_SAUDE_COLETOR.replace(/\s+/g, ' ');
    expect(s).toContain('cron.job_run_details');
    expect(s).toContain("d.status = 'succeeded'");
    expect(s).toContain(`j.jobname = '${CRON_COLETOR}'`);
    expect(s).toContain("'nunca'");
  });
});

describe('a MIGRATION do ledger — as marcas que o coletor não pode perder', () => {
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION_LEDGER), 'utf8');
  const semEspacos = sql.replace(/\s+/g, ' ');

  it('a janela viva aceita o ECO PASSIVO (`probe` ausente) e a SONDA ATIVA (`probe` = true booleano)', () => {
    expect(semEspacos).toContain("NOT (r.c ? 'probe')");
    expect(semEspacos).toContain("(r.c -> 'probe') = to_jsonb(true)");
  });

  it('a chave ausente NÃO é testada por desigualdade (NULL-blind cegaria o eco de novo)', () => {
    expect(semEspacos).not.toContain("<> 'true'");
    expect(semEspacos).not.toContain('<> to_jsonb(true)');
  });

  it('o cast para jsonb vive num CASE — ordem de avaliação garantida pela linguagem, não pelo plano', () => {
    expect(semEspacos).toContain('CASE WHEN content IS JSON OBJECT THEN content::jsonb END');
    expect(semEspacos).toContain("left(ltrim(content), 1) = '{'");
    expect(semEspacos).toContain('LIKE \'%"edge"%\'');
    expect(semEspacos).toContain('LIKE \'%"versao"%\'');
  });

  it('a FORMA de cada campo é exigida — `{"edge":null}` não pode derrubar a cópia inteira', () => {
    expect(semEspacos).toContain("jsonb_typeof(r.c -> 'edge') = 'string'");
    expect(semEspacos).toContain("jsonb_typeof(r.c -> 'versao') = 'string'");
    expect(semEspacos).toContain("~ '^[a-z0-9-]{1,80}$'");
    expect(semEspacos).toContain("~ '^[0-9a-f]{64}$'");
  });

  it('eco sem fingerprint vira `sem-campo` (nomeado), não linha perdida', () => {
    expect(semEspacos).toContain("coalesce(r.c ->> 'fonte', 'sem-campo')");
  });

  it('a cópia é idempotente pela PK composta (request_id, observado_em)', () => {
    expect(semEspacos).toContain('PRIMARY KEY (request_id, observado_em)');
    expect(semEspacos).toContain('ON CONFLICT (request_id, observado_em) DO NOTHING');
  });

  it('NÃO há sonda ativa por cron — o Codex derrubou (rollback pré-sensor rodaria o fluxo real)', () => {
    expect(semEspacos).not.toContain('deploy_sonda_ativa');
    expect(semEspacos).not.toContain('net.http_post');
    expect(semEspacos).not.toContain('vault.decrypted_secrets');
  });

  it('o coletor fica fechado para anon E authenticated, nomeados (PUBLIC não basta)', () => {
    expect(semEspacos).toContain('REVOKE ALL ON FUNCTION public.deploy_atestacoes_colher() FROM anon');
    expect(semEspacos).toContain('REVOKE ALL ON FUNCTION public.deploy_atestacoes_colher() FROM authenticated');
  });

  it('tabela nova nasce com RLS e sem anon', () => {
    expect(semEspacos).toContain('ALTER TABLE public.deploy_atestacoes ENABLE ROW LEVEL SECURITY');
    expect(semEspacos).toContain('REVOKE ALL ON public.deploy_atestacoes FROM anon');
  });

  it('o cron do coletor tem nome fixo e passa de 15 em 15 min', () => {
    expect(semEspacos).toContain(`'${CRON_COLETOR}', '*/15 * * * *'`);
  });
});

/**
 * A CLASSE `SONDA_SEM_IDENTIDADE` — a resposta que prova bundle velho e não diz de QUEM.
 *
 * Caso medido (2026-09-05 23:35Z, bootstrap do ledger): das 30 sondas do founder, 24 responderam
 * `{ok,probe,versao,edge,fonte}` e viraram CONFERE; 6 responderam a forma ANTERIOR a 2026-08-28
 * (`{"ok":true,"probe":true,"versao":"v1.0-sensor-inicial"}`), sem `edge` e sem `fonte`. A janela
 * viva exige `edge` string, então essas 6 ficaram INVISÍVEIS e o relatório disse "NUNCA atestada —
 * precisa da 1ª sonda": o veredito mandava sondar de novo justamente as que já tinham respondido.
 *
 * A resposta sem `edge` não é ausência de dado — é PROVA POSITIVA de bundle anterior ao commit que
 * pôs `edge`+`fonte` no eco (069540905, 2026-08-28). O `_shared/sonda-versao.ts` está no closure de
 * toda edge instrumentada ⇒ o `fonte` servido diverge do da main com CERTEZA, sem precisar observá-lo.
 */
describe('SONDA_SEM_IDENTIDADE — parse da 2ª leitura', () => {
  it('parseia `request_id|versao|criado|idade_horas` e ignora o SET do wrapper', () => {
    const { sondas, linhasIgnoradas } = parsearSondasSemIdentidade(
      'SET\n70261|v1.0-sensor-inicial|2026-09-05 23:35Z|1.5\n',
    );
    expect(sondas).toEqual([
      { requestId: 70261, versao: 'v1.0-sensor-inicial', criado: '2026-09-05 23:35Z', idadeHoras: 1.5 },
    ]);
    expect(linhasIgnoradas).toBe(0);
  });

  it('CONTA a linha malformada — a descartada pode ser a prova de bundle velho (CLI: exit 2)', () => {
    const { sondas, linhasIgnoradas } = parsearSondasSemIdentidade(
      '70261|v1.0|2026-09-05 23:35Z\n70262|v1.0|hoje|2\n',
    );
    expect(sondas.map((s) => s.requestId)).toEqual([70262]);
    expect(linhasIgnoradas).toBe(1);
  });

  it('id não inteiro e idade não numérica/negativa são IGNORADAS, não interpretadas', () => {
    const { sondas, linhasIgnoradas } = parsearSondasSemIdentidade(
      'abc|v1.0|hoje|1\n70261|v1.0|hoje|xyz\n70262|v1.0|hoje|-1\n70263.5|v1.0|hoje|1\n',
    );
    expect(sondas).toHaveLength(0);
    expect(linhasIgnoradas).toBe(4);
  });
});

describe('parsearIds — a atribuição por request_id é OPCIONAL e FAIL-CLOSED', () => {
  it('casa o JSON que o PASSO 1 do `sonda:sql` devolve: id → edge', () => {
    const m = parsearIds('{"edge-a": 70261, "edge-b": 70262}', ESPERADOS);
    expect(m.get(70261)).toBe('edge-a');
    expect(m.get(70262)).toBe('edge-b');
    expect(m.size).toBe(2);
  });

  it('JSON inválido LANÇA — atribuição indeterminável não vira atribuição parcial', () => {
    expect(() => parsearIds('{edge-a: 70261', ESPERADOS)).toThrow(/--ids/);
  });

  it('o que não é OBJETO de topo LANÇA (array, número, null)', () => {
    for (const ruim of ['[70261]', '70261', 'null', '"edge-a"']) {
      expect(() => parsearIds(ruim, ESPERADOS)).toThrow(/objeto/i);
    }
  });

  it('valor que não é inteiro positivo LANÇA nomeando a edge — request_id é bigint do pg_net', () => {
    for (const ruim of ['{"edge-a": "70261"}', '{"edge-a": 0}', '{"edge-a": -1}', '{"edge-a": 1.5}', '{"edge-a": null}']) {
      expect(() => parsearIds(ruim, ESPERADOS)).toThrow(/edge-a/);
    }
  });

  it('id REPETIDO entre duas edges LANÇA nomeando as duas — um request_id teve UMA resposta', () => {
    expect(() => parsearIds('{"edge-a": 70261, "edge-b": 70261}', ESPERADOS)).toThrow(/70261/);
    expect(() => parsearIds('{"edge-a": 70261, "edge-b": 70261}', ESPERADOS)).toThrow(/edge-a.*edge-b|edge-b.*edge-a/);
  });

  it('edge FORA do mapa da main LANÇA — sem esperado não há veredito, e ignorar perderia a resposta', () => {
    expect(() => parsearIds('{"edge-a": 70261, "fantasma": 70262}', ESPERADOS)).toThrow(/fantasma/);
  });

  it('objeto VAZIO LANÇA — `--ids={}` é colagem que não atribui nada, não "sem ids"', () => {
    expect(() => parsearIds('{}', ESPERADOS)).toThrow(/--ids/);
  });
});

describe('atribuirSondasSemIdentidade — por request_id, NUNCA por posição', () => {
  const SONDAS: SondaSemIdentidade[] = [
    { requestId: 70261, versao: 'v1.0-sensor-inicial', criado: '2026-09-05 23:35Z', idadeHoras: 1 },
    { requestId: 70262, versao: 'v1.0-sensor-inicial', criado: '2026-09-05 23:35Z', idadeHoras: 1 },
  ];

  it('casa o id e emite Observacao com o sentinela de fonte e `via: sonda`', () => {
    const { observacoes, naoAtribuidas } = atribuirSondasSemIdentidade(SONDAS, new Map([[70262, 'edge-b']]));
    expect(observacoes).toEqual([
      {
        edge: 'edge-b',
        versao: 'v1.0-sensor-inicial',
        fonte: SEM_IDENTIDADE,
        via: 'sonda',
        criado: '2026-09-05 23:35Z',
        idadeHoras: 1,
      },
    ]);
    expect(naoAtribuidas.map((s) => s.requestId)).toEqual([70261]);
  });

  it('SEM ids, nada é atribuído — ordem/posição não é identidade (ausente ≠ zero)', () => {
    const { observacoes, naoAtribuidas } = atribuirSondasSemIdentidade(SONDAS, new Map());
    expect(observacoes).toEqual([]);
    expect(naoAtribuidas).toHaveLength(2);
  });

  it('id do JSON que não casa resposta nenhuma não inventa observação (a leva tem ids das 24 que se identificaram)', () => {
    const { observacoes } = atribuirSondasSemIdentidade(SONDAS, new Map([[99999, 'edge-a']]));
    expect(observacoes).toEqual([]);
  });
});

describe('julgar — a sonda sem identidade atribuída é DIVERGE, nunca CONFERE nem NUNCA_ATESTADA', () => {
  const semId = (edge: string, versao: string): Observacao => ({
    edge,
    versao,
    fonte: SEM_IDENTIDADE,
    via: 'sonda',
    criado: '2026-09-05 23:35Z',
    idadeHoras: 1,
  });

  it('versao IGUAL ao da main é P2 — o closure andou (o `_shared/sonda-versao.ts` de 2026-08-28) sem bump', () => {
    const r = julgar(ESPERADOS, [semId('edge-a', 'v1.0-a'), obs('edge-b', 'bbb222')], ctx(true, 2));
    const a = r.vereditos.find((v) => v.edge === 'edge-a');
    expect(a?.estado).toBe('DIVERGE_P2');
    expect(a?.diasPendente).toBe(2);
    expect(r.totalPendentes).toBe(1);
    expect(r.totalUrgentes).toBe(0);
  });

  it('versao DIFERENTE é P1 — o autor bumpou, o deploy é do PR', () => {
    const r = julgar(ESPERADOS, [semId('edge-a', 'v0.9-a'), obs('edge-b', 'bbb222')], ctx(true, 3));
    const a = r.vereditos.find((v) => v.edge === 'edge-a');
    expect(a?.estado).toBe('DIVERGE_P1');
    expect(a?.observado).toBe(SEM_IDENTIDADE);
    expect(a?.versao).toBe('v0.9-a');
    expect(r.totalUrgentes).toBe(1);
  });

  it('NÃO chama `parCoerente` — o par nunca foi observado; a divergência do fonte é DEDUZIDA do bundle', () => {
    const proibido: Contexto = {
      parCoerente: () => {
        throw new Error('parCoerente não deve ser consultado: não há `fonte` observado para casar');
      },
      diasPendente: () => 4,
    };
    expect(julgar(ESPERADOS, [semId('edge-a', 'v1.0-a'), obs('edge-b', 'bbb222')], proibido).vereditos[0].estado).toBe(
      'DIVERGE_P2',
    );
  });

  it('a P2 sem identidade também ESCALA depois de 7 dias — a fila é a mesma', () => {
    const r = julgar(ESPERADOS, [semId('edge-a', 'v1.0-a'), obs('edge-b', 'bbb222')], ctx(true, ESCALAR_P2_APOS_DIAS + 1));
    expect(r.vereditos[0].escalada).toBe(true);
    expect(r.totalUrgentes).toBe(1);
  });

  it('SAI da lista da sonda — era o bug: "NUNCA atestada, sonde-a" mandava re-sondar quem já respondeu', () => {
    const r = julgar(ESPERADOS, [semId('edge-a', 'v1.0-a')], ctx());
    expect(edgesParaSondar(r)).toEqual(['edge-b']);
    expect(r.totalObservadas).toBe(1);
  });

  /**
   * CASO MEDIDO em prod (2026-09-05 ~01:40Z, `psql-ro`, a 2ª leitura importada do CLI): 7 respostas
   * `probe:true` sem `edge` — ids 70261/70262/70267/70271/70281/70282 (23:35Z) e 70287 (23:38Z);
   * seis disseram `v1.0-sensor-inicial` e a do 70262 disse `v1.1-marco-causal`.
   *
   * O mapa id→edge abaixo é o que o founder COLARIA do PASSO 1 — ele não é deduzido daqui, e o
   * teste não afirma quem respondeu o quê: o que ele prende é a MECÂNICA (id casa, `versao` decide
   * a fila, quem não casa continua sinal). O 70287 fica de fora do mapa de propósito.
   */
  it('CASO MEDIDO (2026-09-05): o `versao` de cada uma decide a fila, e a não atribuída sobra como sinal', () => {
    const mainReal: Record<string, Esperado> = {
      'conciliar-pedido-portal': { fonte: 'f1', versao: 'v1.0-sensor-inicial' },
      'disparar-pedidos-aprovados': { fonte: 'f2', versao: 'v1.1-marco-causal' },
      'gerar-pedidos-diario': { fonte: 'f3', versao: 'v1.0-sensor-inicial' },
      'omie-nfe-recebimento': { fonte: 'f4', versao: 'v1.1-falha-sai-nao-2xx' },
      'pedido-programado-enviar': { fonte: 'f5', versao: 'v1.0-sensor-inicial' },
      'process-nfe': { fonte: 'f6', versao: 'v1.0-sensor-inicial' },
    };
    const medido: [number, string][] = [
      [70261, 'v1.0-sensor-inicial'],
      [70262, 'v1.1-marco-causal'],
      [70267, 'v1.0-sensor-inicial'],
      [70271, 'v1.0-sensor-inicial'],
      [70281, 'v1.0-sensor-inicial'],
      [70282, 'v1.0-sensor-inicial'],
      [70287, 'v1.0-sensor-inicial'],
    ];
    const sondas: SondaSemIdentidade[] = medido.map(([requestId, versao]) => ({
      requestId,
      versao,
      criado: '2026-09-05 23:35Z',
      idadeHoras: 2.2,
    }));
    const ids = parsearIds(
      JSON.stringify({
        'conciliar-pedido-portal': 70261,
        'disparar-pedidos-aprovados': 70262,
        'gerar-pedidos-diario': 70267,
        'omie-nfe-recebimento': 70271,
        'pedido-programado-enviar': 70281,
        'process-nfe': 70282,
      }),
      mainReal,
    );
    const { observacoes, naoAtribuidas } = atribuirSondasSemIdentidade(sondas, ids);
    expect(naoAtribuidas.map((s) => s.requestId)).toEqual([70287]);

    const r = julgar(mainReal, observacoes, ctx(true, 1));
    const porEstado = (e: string) => r.vereditos.filter((v) => v.estado === e).map((v) => v.edge).sort();
    // Só a `omie-nfe-recebimento` bumpou (a main já está em v1.1-falha-sai-nao-2xx) ⇒ P1.
    expect(porEstado('DIVERGE_P1')).toEqual(['omie-nfe-recebimento']);
    expect(porEstado('DIVERGE_P2')).toEqual([
      'conciliar-pedido-portal',
      'disparar-pedidos-aprovados',
      'gerar-pedidos-diario',
      'pedido-programado-enviar',
      'process-nfe',
    ]);
    expect(porEstado('NUNCA_ATESTADA')).toEqual([]);
    expect(edgesParaSondar(r)).toEqual([]);
    expect(r.totalPendentes).toBe(6);
    expect(r.totalUrgentes).toBe(1);
  });
});

describe('resumirSemIdentidade — sem `--ids`, só a CONTAGEM (jamais atribuição por ordem)', () => {
  it('agrupa por versao respondida e lista os request_ids, ordenados', () => {
    const resumo = resumirSemIdentidade([
      { requestId: 70282, versao: 'v1.0-sensor-inicial', criado: 'x', idadeHoras: 1 },
      { requestId: 70261, versao: 'v1.0-sensor-inicial', criado: 'x', idadeHoras: 1 },
      { requestId: 70271, versao: 'v0.9-antiga', criado: 'x', idadeHoras: 2 },
    ]);
    expect(resumo.total).toBe(3);
    expect(resumo.porVersao).toEqual([
      { versao: 'v1.0-sensor-inicial', n: 2 },
      { versao: 'v0.9-antiga', n: 1 },
    ]);
    expect(resumo.requestIds).toEqual([70261, 70271, 70282]);
  });
});

/**
 * A 2ª LEITURA — as respostas que a janela viva não pode enxergar, por construção.
 *
 * `deploy_atestacoes_janela_viva()` exige `edge` string: é o que impede corpo alheio de virar
 * veredito, e é o que torna a sonda pré-28/08 invisível. Consertar isso AFROUXANDO a janela seria
 * deixar entrar no LEDGER linha sem edge — e o ledger é eterno. Então a correção é uma segunda
 * consulta, barata, que não escreve nada e cujo produto é uma CLASSE, não uma linha de ledger.
 */
describe('SQL_SEM_IDENTIDADE — a 2ª leitura, direto em net._http_response', () => {
  const s = SQL_SEM_IDENTIDADE.replace(/\s+/g, ' ');

  it('lê net._http_response — a janela viva exige `edge` e por definição não devolve estas linhas', () => {
    expect(s).toContain('FROM net._http_response');
    expect(s).toContain('status_code = 200');
    expect(s).not.toContain('deploy_atestacoes_janela_viva');
    expect(s).not.toContain('public.deploy_atestacoes');
  });

  it('é a sonda ATIVA (probe booleano true), não eco: sem o probe, corpo alheio sem `edge` entraria', () => {
    expect(s).toContain("(r.c -> 'probe') = to_jsonb(true)");
    expect(s).not.toContain("'probe') = 'true'");
  });

  it('exige a AUSÊNCIA de `edge` com `NOT (c ? …)` — desigualdade é NULL-blind e devolveria vazio', () => {
    expect(s).toContain("NOT (r.c ? 'edge')");
    expect(s).not.toContain("(r.c -> 'edge') <>");
    expect(s).not.toContain("'edge') IS NULL");
  });

  it('o cast vive num CASE, com o guard textual antes — corpo truncado não aborta a varredura', () => {
    expect(s).toContain('CASE WHEN content IS JSON OBJECT THEN content::jsonb END');
    expect(s).toContain("left(ltrim(content), 1) = '{'");
    expect(s).toContain('LIKE \'%"probe"%\'');
  });

  it('exige `versao` string — `probe:true` sem versao é forma que este repo nunca emitiu', () => {
    expect(s).toContain("jsonb_typeof(r.c -> 'versao') = 'string'");
  });

  it('ordem estável (created não é ordem total: 64031/64032 empatam ao microssegundo)', () => {
    expect(s).toContain('ORDER BY r.created DESC, r.id DESC');
  });

  it('NÃO grava: a 2ª leitura roda no psql-ro e o ledger exige edge REAL', () => {
    expect(s).not.toContain('INSERT');
    expect(s).not.toContain('UPDATE');
  });
});

describe('--ids — a flag é opcional e o argv também é fail-closed', () => {
  it('aceita `--ids=<json>` e `--ids <json>`', () => {
    expect(lerArgIds(['--ids={"edge-a": 1}'])).toBe('{"edge-a": 1}');
    expect(lerArgIds(['--ids', '{"edge-a": 1}'])).toBe('{"edge-a": 1}');
  });

  it('ausente devolve null — a atribuição é opcional, o relatório sai do mesmo jeito', () => {
    expect(lerArgIds([])).toBeNull();
  });

  it('`--ids` sem valor LANÇA em vez de virar "sem ids"', () => {
    expect(() => lerArgIds(['--ids'])).toThrow(/--ids/);
    expect(() => lerArgIds(['--ids='])).toThrow(/--ids/);
  });

  it('`--ids` repetido LANÇA — dois JSONs são duas levas, e escolher uma é escolher por ordem', () => {
    expect(() => lerArgIds(['--ids={"edge-a": 1}', '--ids={"edge-b": 2}'])).toThrow(/--ids/);
  });

  it('argumento desconhecido LANÇA — `--id=` digitado errado sairia como "sem atribuição"', () => {
    expect(() => lerArgIds(['--id={"edge-a": 1}'])).toThrow(/--id=/);
  });
});

describe('o texto da classe — o que impede o founder de sondar de novo', () => {
  const linhas = formatarSemIdentidade(
    resumirSemIdentidade([
      { requestId: 70261, versao: 'v1.0-sensor-inicial', criado: 'x', idadeHoras: 1 },
      { requestId: 70262, versao: 'v1.0-sensor-inicial', criado: 'x', idadeHoras: 1 },
    ]),
  ).join('\n');

  it('nomeia a CLASSE, a contagem, a versao respondida e os request_ids', () => {
    expect(linhas).toContain('SONDA_SEM_IDENTIDADE');
    expect(linhas).toContain('2');
    expect(linhas).toContain('v1.0-sensor-inicial');
    expect(linhas).toContain('70261');
    expect(linhas).toContain('70262');
  });

  it('dá o VEREDITO e a contra-instrução — a resposta é prova de bundle velho, não pedido de sonda', () => {
    expect(linhas).toContain(DATA_ECO_COM_IDENTIDADE);
    expect(linhas).toContain('DEPLOY PENDENTE');
    expect(linhas).toContain('NÃO RE-SONDE');
  });

  it('ensina a atribuir por request_id, que é a única identidade forte', () => {
    expect(linhas).toContain('--ids');
  });

  it('sem nenhuma resposta sem identidade, NÃO imprime seção nenhuma', () => {
    expect(formatarSemIdentidade(resumirSemIdentidade([]))).toEqual([]);
  });
});

/**
 * ITEM (3) DO PEDIDO, como GATE: a resposta sem identidade NÃO entra no ledger com edge fictícia.
 *
 * `edge = 'desconhecida'` casaria o regex de slug da janela viva e o NOT NULL do ledger — nada no
 * banco a barraria. As razões de não gravar: (a) o `DISTINCT ON (edge)` do CLI passaria a ver uma
 * "edge" chamada `desconhecida`, que a main não mapeia ⇒ 🟠 FORA_DO_MAPA urgente, uma edge
 * INVENTADA no relatório de deploy; (b) o ledger é ETERNO e a janela do pg_net dura 6h — a chance
 * de atribuir a resposta morre com a janela, e ficaria para sempre uma linha que ninguém consegue
 * reinterpretar; (c) `pendencias:deploy` roda no `psql-ro`: gravar exigiria o founder colar SQL,
 * custo humano por um dado que não conclui nada. A prova de bundle velho não se perde — ela vira
 * CLASSE no relatório, e veredito por edge quando (e só quando) houver `--ids`.
 *
 * O gate mede o CÓDIGO, nunca o arquivo cru: o parágrafo acima cita as duas strings proibidas, e um
 * `not.toContain` sobre o arquivo inteiro ficaria vermelho pela PROSA. Stripper compartilhado
 * (`removerComentarios`), nunca regex local — a lição de `gates-textuais-cegos.md`.
 */
describe('o ledger não recebe edge fictícia — o CLI é read-only por construção', () => {
  const fonteCrua = readFileSync(join(__dirname, 'pendencias-deploy.ts'), 'utf8');
  const codigo = removerComentarios(fonteCrua);

  it('o stripper deixou código de sobra — gate que mede string vazia é gate cego', () => {
    expect(codigo.length).toBeGreaterThan(fonteCrua.length * 0.4);
    expect(codigo).toContain('SQL_SEM_IDENTIDADE');
  });

  it('nenhuma escrita no ledger, e nenhuma edge fictícia no CÓDIGO', () => {
    expect(codigo).not.toContain('INSERT INTO');
    expect(codigo).not.toContain('desconhecida');
  });
});
