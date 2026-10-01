// Gate da classe "data de SP medida no fuso da SESSÃO" — o módulo explica a classe e os limites.
// Diário: docs/historico/positivacao-mes-sp-sob-sessao-utc.md
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONHECIDOS, PISOS, type SitioConhecido, confrontar, detectarFusoDaSessao, varrerMigrations } from './fuso-da-sessao-gate';
import { modelarRepo } from './lib/deriva-corpo';
import { maiorBlocoDescartadoSql } from './lib/sql-comentarios';

const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const DIR = join(RAIZ, 'supabase', 'migrations');
const MIGS = readdirSync(DIR)
  .filter((n) => n.endsWith('.sql'))
  .sort()
  .map((nome) => ({ nome, sql: readFileSync(join(DIR, nome), 'utf8') }));

const ORIGEM = '20260525210000_viewas_rpcs_for.sql';
const CORRECAO = '20260927133606_positivacao_mes_sp_sessao_utc.sql';
// A definição VIGENTE: a 20260927195430 (universo canônico, só order_date_kpi) recriou a função
// depois da correção de fuso. Mudou a função, este pin reprova — é o lembrete de reolhar a classe.
const VIGENTE = '20260927195430_positivacao_universo_canonico.sql';
const ALVO = '_carteira_positivacao_for_owner(uuid)';
const corpoEm = (migration: string): string => {
  const m = MIGS.find((x) => x.nome === migration);
  return modelarRepo(m ? [m] : []).identidades.get(ALVO)?.versoes.at(-1)?.corpo ?? '';
};

describe('calibração — o detector pega o site-mãe e solta a correção (arquivos REAIS)', () => {
  it('o corpo de 20260525210000 (pré-fix) acusa os DOIS eixos, e só eles', () => {
    const achados = detectarFusoDaSessao(corpoEm(ORIGEM));
    expect(achados).toEqual([
      { familia: 'A', trecho: 'fc.started_at >= mes_inicio' },
      { familia: 'A', trecho: 'fc.started_at < mes_fim' },
      { familia: 'B', trecho: 'so.created_at::date' },
    ]);
  });

  it('o corpo de 20260927133606 (a correção) não acusa nada — e foi lido de verdade', () => {
    const corpo = corpoEm(CORRECAO);
    // controle positivo: sem ele, "não achou" e "não leu o corpo" dariam o mesmo []
    expect(corpo).toContain("(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date >= mes_inicio");
    expect(detectarFusoDaSessao(corpo)).toEqual([]);
  });
});

describe('formas — os dois lados de cada família', () => {
  const emSp = (miolo: string) => [
    '',
    'DECLARE',
    "  d date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;",
    "  t timestamp := now() AT TIME ZONE 'America/Sao_Paulo';",
    'BEGIN',
    `  ${miolo}`,
    'END;',
    '',
  ].join('\n');

  it.each([
    ['A: coluna OP variável', 'SELECT 1 FROM x WHERE x.criado_em >= d;', 'A'],
    ['A: variável OP coluna', 'SELECT 1 FROM x WHERE d <= x.created_at;', 'A'],
    ['A: BETWEEN', 'SELECT 1 FROM x WHERE x.created_at BETWEEN d AND d + 1;', 'A'],
    ['A: timestamp local contra timestamptz', 'SELECT 1 FROM x WHERE x.created_at < t;', 'A'],
    ['B: ::date', 'SELECT x.created_at::date FROM x;', 'B'],
    ['B: ::timestamp', 'SELECT x.aprovado_em::timestamp FROM x;', 'B'],
    ['B: date()', 'SELECT date(x.created_at) FROM x;', 'B'],
    ['B: CAST(… AS date)', 'SELECT CAST(x.created_at AS date) FROM x;', 'B'],
    ['A: variável castada para timestamptz (ainda é o fuso da sessão)', 'SELECT 1 FROM x WHERE x.created_at >= d::timestamptz;', 'A'],
    ['B: date_trunc de coluna', "SELECT date_trunc('month', x.created_at) FROM x;", 'B'],
    ['B: extract de coluna', 'SELECT extract(hour from x.created_at) FROM x;', 'B'],
    ['C: current_date', 'SELECT current_date;', 'C'],
    ['C: now()::date', 'SELECT now()::date;', 'C'],
    ['C: date_trunc de now()', "SELECT date_trunc('day', now());", 'C'],
  ])('acusa — %s', (_nome, miolo, familia) => {
    expect(detectarFusoDaSessao(emSp(miolo)).map((a) => a.familia)).toContain(familia);
  });

  it.each([
    ['coluna convertida para SP antes de comparar', "SELECT 1 FROM x WHERE (x.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= d;"],
    ['variável contra coluna já em SP (AT TIME ZONE liga mais forte)', "SELECT 1 FROM x WHERE d <= x.created_at AT TIME ZONE 'America/Sao_Paulo';"],
    ['coluna date: sem fuso', 'SELECT 1 FROM x WHERE x.visit_date >= d;'],
    ['borda convertida para instante de SP (o conserto que usa índice)', "SELECT 1 FROM x WHERE x.created_at >= d::timestamp AT TIME ZONE 'America/Sao_Paulo';"],
    ['*_em que é date na prod (inicio_em, medido_em, suspensa_em)', 'SELECT 1 FROM x WHERE x.inicio_em >= d AND medido_em < d;'],
    ['::timestamptz não converte fuso', 'SELECT x.created_at::timestamptz FROM x;'],
    ['o hoje de SP', "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date;"],
    ['comentário não é código', '-- WHERE x.created_at::date >= current_date\n  SELECT 1;'],
  ])('solta — %s', (_nome, miolo) => {
    expect(detectarFusoDaSessao(emSp(miolo))).toEqual([]);
  });

  // As formas de ATRIBUIR que o PL/pgSQL aceita além de `:=` — escapavam da 1ª versão (Codex, adversarial).
  it.each([
    ['declaração com `=`', "DECLARE d date = (now() AT TIME ZONE 'America/Sao_Paulo')::date; BEGIN PERFORM 1 FROM x WHERE x.created_at >= d; END;"],
    ['SELECT … INTO', "DECLARE d date; BEGIN SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date INTO d; PERFORM 1 FROM x WHERE x.created_at >= d; END;"],
  ])('acusa — variável de SP atribuída por %s', (_nome, corpo) => {
    expect(detectarFusoDaSessao(corpo)).toEqual([{ familia: 'A', trecho: 'x.created_at >= d' }]);
  });

  it('corpo SEM America/Sao_Paulo não é medido: a semântica dele pode ser UTC de propósito', () => {
    expect(detectarFusoDaSessao('BEGIN SELECT current_date, x.created_at::date FROM x; END')).toEqual([]);
  });
});

describe('o corpo VIVO do repo (a última definição de cada função)', () => {
  const v = varrerMigrations(MIGS);

  it('mediu: piso de migrations e de identidades com semântica SP', () => {
    expect(v.migrations).toBeGreaterThanOrEqual(PISOS.migrations);
    expect(v.identidadesComSp.length).toBeGreaterThanOrEqual(PISOS.identidadesComSp);
    expect(v.identidadesComSp).toContain(ALVO);
  });

  it('a positivação vale pelo corpo VIGENTE, e ele está limpo', () => {
    const versoes = v.modelo.identidades.get(ALVO)?.versoes ?? [];
    expect(versoes.at(-1)?.migration).toBe(VIGENTE);
    // controle positivo: o vigente ainda converte a ligação para SP — sem ele, "limpo" e "não leu
    // o corpo" dariam o mesmo `undefined`
    expect(versoes.at(-1)?.corpo).toContain("(fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date >= mes_inicio");
    expect(v.achados.get(ALVO)).toBeUndefined();
  });

  it('nenhum sítio NOVO fora da baseline', () => {
    expect(confrontar(v, CONHECIDOS).novos).toEqual([]);
  });

  it('nenhuma entrada QUITADA esquecida na baseline (a lista só encolhe)', () => {
    expect(confrontar(v, CONHECIDOS).quitados).toEqual([]);
  });

  it('a detecção de QUITADO tem dente mesmo com a baseline vazia: a entrada que saiu reprovaria se voltasse', () => {
    // A baseline zerou em 2026-10-01 (a família data_ciclo, 20261001023000) — sem este teste, desligar o
    // laço de quitados não deixaria nada vermelho, porque não sobrou entrada real para exercitá-lo.
    const antiga: SitioConhecido = {
      alvo: '_data_health_compute()', familia: 'C', trecho: 'current_date', n: 2, veredito: 'falso-positivo',
      motivo: 'a entrada que saiu com a 20261001023000 (current_date contra pedido_compra_sugerido.data_ciclo)',
    };
    expect(confrontar(v, [...CONHECIDOS, antiga]).quitados).toEqual([
      '_data_health_compute() · C · current_date (baseline 2, corpo vivo 0)',
    ]);
  });

  it('toda entrada da baseline diz o porquê — dívida sem motivo vira lista que ninguém lê', () => {
    for (const c of CONHECIDOS) expect(c.motivo.length, c.alvo).toBeGreaterThan(60);
  });

  it('canário: uma migration nova que recria o corpo pré-fix REPROVA, nomeando o sítio', () => {
    const origem = MIGS.find((m) => m.nome === ORIGEM);
    expect(origem).toBeDefined();
    const canario = { nome: '99999999999999_canario.sql', sql: origem?.sql ?? '' };
    const { novos } = confrontar(varrerMigrations([...MIGS, canario]), CONHECIDOS);
    expect(novos).toEqual([
      `${ALVO} · A · fc.started_at >= mes_inicio (1× no corpo vivo, baseline 0)`,
      `${ALVO} · A · fc.started_at < mes_fim (1× no corpo vivo, baseline 0)`,
      `${ALVO} · B · so.created_at::date (1× no corpo vivo, baseline 0)`,
    ]);
  });

  it('canário 2: o corpo pré-fix nas formas alternativas (`date =` e `CAST`) também REPROVA', () => {
    const origem = MIGS.find((m) => m.nome === ORIGEM)?.sql ?? '';
    const variante = origem.replaceAll('mes_inicio date :=', 'mes_inicio date =')
      .replaceAll('mes_fim date :=', 'mes_fim date =')
      .replace('so.created_at::date', 'CAST(so.created_at AS date)');
    // controle: as 3 trocas aconteceram — senão o canário mediria o corpo de sempre
    expect(variante.split('date =').length - 1).toBeGreaterThanOrEqual(2);
    expect(variante).toContain('CAST(so.created_at AS date)');
    const { novos } = confrontar(varrerMigrations([...MIGS, { nome: '99999999999999_canario.sql', sql: variante }]), CONHECIDOS);
    expect(novos).toEqual([
      `${ALVO} · A · fc.started_at >= mes_inicio (1× no corpo vivo, baseline 0)`,
      `${ALVO} · A · fc.started_at < mes_fim (1× no corpo vivo, baseline 0)`,
      `${ALVO} · B · cast(so.created_at as date) (1× no corpo vivo, baseline 0)`,
    ]);
  });

  it('o stripper não desabou em nenhum corpo medido (sentinela do maior bloco descartado)', () => {
    const culpados: string[] = [];
    for (const alvo of v.identidadesComSp) {
      const corpo = v.modelo.identidades.get(alvo)?.versoes.at(-1)?.corpo ?? '';
      const bloco = maiorBlocoDescartadoSql(corpo);
      if (bloco > PISOS.blocoDescartado) culpados.push(`${alvo}: bloco ${bloco}`);
    }
    expect(culpados).toEqual([]);
  });
});
