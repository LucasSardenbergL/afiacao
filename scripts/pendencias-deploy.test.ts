import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  edgesParaSondar,
  ESCALAR_P2_APOS_DIAS,
  julgar,
  lerTolerancia,
  LIMITE_FORA_DO_MAPA_HORAS,
  parsearObservacoes,
  SEM_FONTE,
  SEM_MAPA,
  type Contexto,
  type Esperado,
  type Observacao,
} from './lib/pendencias-deploy';
import { CRON_COLETOR, MIGRATION_LEDGER, SQL, SQL_SAUDE_COLETOR } from './pendencias-deploy';

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
