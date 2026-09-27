import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { analisar, detectar, veredito, type Analise } from './fuso-da-sessao-em-provas-gate';
import { PISOS, RAIZES_PADRAO } from './relogio-bash-em-provas-gate';
import { enumerar } from './shell-variavel-colada-gate';

/**
 * Dente do fiscal do fuso da sessão em provas (docs/historico/provas-janela-de-relogio-fora-do-
 * nucleo.md). Roda no CI por `bun run test` — puramente textual, não executa shell nem SQL. As
 * mutações que provam que cada bloco abaixo tem dente vivem em
 * `scripts/mutcheck.d/fuso-da-sessao-em-provas.mut`.
 *
 * ⚠️ Fonte de teste vai em aspas SIMPLES ou DUPLAS do TS, nunca em template literal: lá `${…}` é
 * interpolação do próprio TS, e a linha testada seria outra.
 */

// `import.meta.dir` é do Bun e não existe no vitest — `import.meta.url` existe nos dois.
const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const linhas = (fonte: string) => detectar('db/test-x.sh', fonte).sitios.map((s) => s.linha);

/** O caso de origem, byte a byte como estava na main antes do conserto (l.145-146 da positivação). */
const SEED_145 = "  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','faturado', 1000, date_trunc('month', now())::date),";
const SEED_146 = "  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','faturado', 1000, date_trunc('month', now())::date);";
const ARQUIVO_DA_POSITIVACAO = 'db/test-positivacao-eligible-consumo.sh';
/** O trecho de antes do conserto, no heredoc de SQL onde morava — com o comentário `--` que o precedia. */
const SEED_PRE_CONSERTO = [
  "P -q <<'SQL'",
  '-- pedido no mês corrente só p/ aaaa e bbbb (mesmo valor) → só o elegível pode contar',
  'INSERT INTO public.sales_orders(customer_user_id, status, total, order_date_kpi) VALUES',
  SEED_145,
  SEED_146,
  'SQL',
  '',
].join('\n');

describe('controle POSITIVO — se o detector parar de casar, isto fica vermelho', () => {
  it('o caso que abriu a classe: o seed da positivação, no heredoc de SQL', () => {
    expect(detectar(ARQUIVO_DA_POSITIVACAO, SEED_PRE_CONSERTO).sitios).toEqual([
      { arquivo: ARQUIVO_DA_POSITIVACAO, linha: 4, trecho: SEED_145.trim() },
      { arquivo: ARQUIVO_DA_POSITIVACAO, linha: 5, trecho: SEED_146.trim() },
    ]);
  });

  it.each([
    ['dia, sem espaço', "SELECT date_trunc('day',now());"],
    ['semana', "SELECT date_trunc('week', now());"],
    ['trimestre', "SELECT date_trunc('quarter', now());"],
    ['ano', "SELECT date_trunc('year', now());"],
    ['caixa alta (SQL não liga para caixa)', "SELECT DATE_TRUNC('MONTH', NOW());"],
    ['qualificado: o pg_catalog das provas de relógio controlado', "SELECT date_trunc('month', pg_catalog.now());"],
    ['entre parênteses', "SELECT date_trunc('month', (now()));"],
    ['com aritmética: segue na sessão', "SELECT date_trunc('month', now() - interval '1 month');"],
    ['com cast: segue na sessão', "SELECT date_trunc('month', now()::date);"],
    ['current_timestamp', "SELECT date_trunc('month', current_timestamp);"],
    ['current_timestamp com precisão', "SELECT date_trunc('month', current_timestamp(0));"],
    ['current_date', "SELECT date_trunc('month', current_date);"],
    ['localtimestamp', "SELECT date_trunc('month', localtimestamp);"],
    ['clock_timestamp()', "SELECT date_trunc('day', clock_timestamp());"],
    ['transaction_timestamp()', "SELECT date_trunc('day', transaction_timestamp());"],
    ['num -c do psql, dentro de $( ) e de aspas duplas', 'MES=$(Pq -c "SELECT date_trunc(\'month\', now())::date")'],
  ])('%s: %s', (_rotulo, linha) => {
    expect(linhas(linha + '\n')).toEqual([1]);
  });

  it('a chamada quebrada em várias linhas é UM sítio, na linha do date_trunc', () => {
    expect(linhas("SELECT 1;\nSELECT date_trunc(\n  'month',\n  now()\n)::date;\n")).toEqual([2]);
  });

  it('o fuso aplicado DEPOIS de truncar não conserta: a truncagem já foi na sessão (isenção por LINHA erraria)', () => {
    expect(linhas("SELECT date_trunc('month', now()) AT TIME ZONE 'America/Sao_Paulo';\n")).toEqual([1]);
  });
});

describe('o que NÃO é a classe', () => {
  it.each([
    ['fuso explícito', "SELECT date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo');"],
    ['fuso explícito entre parênteses (a forma da prime-fundacao)', "SELECT date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date;"],
    ['fuso explícito e qualificado (a forma do conserto)', "SELECT date_trunc('month', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo');"],
    ['a forma de 3 argumentos (PG14+)', "SELECT date_trunc('month', now(), 'America/Sao_Paulo');"],
    ['fuso explícito mesmo que UTC: a intenção está escrita (o fiscal pede fuso EXPLÍCITO, não SP)', "SELECT date_trunc('day', now() AT TIME ZONE 'UTC');"],
    ['hora: SP tem offset de hora cheia', "SELECT date_trunc('hour', now());"],
    ['instante DADO, não o relógio (a forma do fin-sync)', "((date_trunc('day', p_now AT TIME ZONE 'UTC') - make_interval(days=>d.d)"],
    ['instante dado por coluna', "SELECT date_trunc('month', p_mes_de::timestamp)::date;"],
    ['current_date e now()::date NUS: fora de propósito (363 casos, quase todos coerentes)', 'INSERT INTO t VALUES (current_date, now()::date);'],
    ['to_char/extract sobre o relógio: fora de propósito (0 casos da classe)', "SELECT to_char(now(), 'YYYY-MM'), extract(epoch from now());"],
    ['função que só TERMINA em date_trunc', "SELECT meu_date_trunc('month', now());"],
  ])('%s', (_rotulo, linha) => {
    expect(linhas(linha + '\n')).toEqual([]);
  });
});

describe('a camada do stripper é a do SHELL — e só ela', () => {
  it('comentário `#` não conta: linha inteira (a forma que o conserto deixou no cabeçalho) e fim de linha', () => {
    expect(linhas("# Antes, o seed usava `date_trunc('month', now())`\necho ok  # date_trunc('day', now())\n")).toEqual([]);
  });

  it('`#` DENTRO de aspas é dado: o que vem depois dele segue visível (regex local o apagaria)', () => {
    expect(linhas('Pq -c "SELECT 5 # 3, date_trunc(\'month\', now())"\n')).toEqual([1]);
  });

  it('no corpo de heredoc, `#` é dado — a leitura segue ali', () => {
    expect(linhas("P <<'SQL'\n# SELECT date_trunc('month', now());\nSQL\n")).toEqual([2]);
  });

  it('comentário `--` de SQL CONTA: o preço da camada, pago do lado seguro (vermelho num comentário)', () => {
    expect(linhas("P <<'SQL'\n-- antes: date_trunc('month', now())\nSELECT 1;\nSQL\n")).toEqual([2]);
  });

  it('sentinela da camada: o `--` de um flag não apaga o SQL que vem depois (o stripper de SQL apagaria)', () => {
    expect(linhas('Pq --no-psqlrc -c "SELECT date_trunc(\'month\', now())::date"\n')).toEqual([1]);
  });

  it('a linha reportada é a da FONTE (a limpeza preserva o número de linhas)', () => {
    expect(linhas('# 1\n# 2\n\n' + SEED_145 + '\n')).toEqual([4]);
  });

  it('o denominador conta CÓDIGO: linha em branco e comentário não entram no piso', () => {
    expect(detectar('db/test-x.sh', '#!/usr/bin/env bash\n\n# cabeçalho\n  \necho a\necho b  # fim\n').linhasDeCodigo).toBe(2);
  });
});

/**
 * O dente de CADA alarme é provado no dono de `alarmesDoStripper` (`shell-variavel-colada-gate.test.ts`
 * + `.mut`). Aqui cabe provar que ESTE fiscal os consulta: ponta a ponta, com a máquina real.
 */
describe('os alarmes do stripper — herdados, e vistos disparar AQUI', () => {
  it('heredoc sem delimitador vira INDETERMINADO, não "limpo" — mesmo escondendo uma violação', () => {
    const r = analisar([{ caminho: 'db/test-x.sh', fonte: "P -q <<'SQL'\n" + SEED_145 + '\n' }]);
    expect(r.alarmes).toHaveLength(1);
    expect(veredito(r, false).codigo).toBe(2);
  });
});

describe('veredito — 2 nunca é "passou"', () => {
  const limpo: Analise = { caminhos: ['db/test-a.sh'], linhasDeCodigo: 1, violacoes: [], alarmes: [] };
  const provas = Array.from({ length: PISOS.provas }, (_, i) => `db/test-p${i}.sh`);
  const cheio: Analise = { ...limpo, caminhos: [...provas, 'db/lib/pg-harness.sh'], linhasDeCodigo: PISOS.linhasDeCodigo };

  it('limpo, sem pisos → 0', () => {
    expect(veredito(limpo, false).codigo).toBe(0);
  });

  it('com violação → 1, e a saída aponta arquivo:linha E o conserto (fuso na expressão, relógio controlado)', () => {
    const v = veredito({ ...limpo, violacoes: detectar(ARQUIVO_DA_POSITIVACAO, SEED_PRE_CONSERTO).sitios }, false);
    expect(v.codigo).toBe(1);
    const saida = v.linhas.join('\n');
    expect(saida).toContain(`${ARQUIVO_DA_POSITIVACAO}:4`);
    expect(saida).toContain("now() AT TIME ZONE 'America/Sao_Paulo'");
    expect(saida).toContain('test.agora');
    expect(saida).toContain('docs/historico/provas-janela-de-relogio-fora-do-nucleo.md');
  });

  it('nenhum arquivo lido → 2 (ausente ≠ zero violações)', () => {
    expect(veredito({ ...limpo, caminhos: [] }, false).codigo).toBe(2);
  });

  it('alarme do stripper → 2, mesmo COM violação (não dá para confiar em nenhuma das duas)', () => {
    const v = veredito({ ...limpo, violacoes: detectar(ARQUIVO_DA_POSITIVACAO, SEED_145).sitios, alarmes: ['x.sh: heredoc aberto'] }, false);
    expect(v.codigo).toBe(2);
  });

  it('com pisos: exatamente nos pisos passa (controle dos casos de baixo)', () => {
    expect(veredito(cheio, true).codigo).toBe(0);
  });

  it('com pisos: uma prova a menos que o piso → 2 — e shell que não é prova não conta para ele', () => {
    const semUma = { ...cheio, caminhos: [...cheio.caminhos.slice(1), 'db/lib/outro.sh', 'db/falsifica-y.sh'] };
    const v = veredito(semUma, true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.join('\n')).toContain('db/test-*.sh');
  });

  it('com pisos: linhas de código abaixo do piso (abriu arquivo, mas não leu código) → 2', () => {
    expect(veredito({ ...cheio, linhasDeCodigo: PISOS.linhasDeCodigo - 1 }, true).codigo).toBe(2);
  });
});

describe('o corpo REAL do repo', () => {
  let arquivos: { caminho: string; fonte: string }[];
  let r: Analise;
  beforeAll(() => {
    arquivos = enumerar(RAIZES_PADRAO, RAIZ).map((c) => ({ caminho: relative(RAIZ, c), fonte: readFileSync(c, 'utf8') }));
    r = analisar(arquivos);
  }, 30_000);

  it('nenhuma prova trunca o relógio da sessão sem fuso', () => {
    expect(r.violacoes.map((s) => `${s.arquivo}:${s.linha}  ${s.trecho}`)).toEqual([]);
  });

  it('o fiscal MEDIU e o stripper não desabou: com pisos, o veredito é 0 — não 2', () => {
    expect(veredito(r, true)).toEqual({ codigo: 0, linhas: [expect.stringContaining('✅')] });
  });

  /**
   * A falsificação, com CONTROLE verde na MESMA invocação: o mesmo corpo, com a linha 145 de antes
   * do conserto devolvida à positivação — no 1º heredoc de SQL dela, onde o seed mora —, tem de
   * acusar exatamente aquele sítio, e nada além dele. No arquivo REAL, e não num fixture: é ali que
   * o stripper precisa atravessar o arquivo sem perder o fio.
   */
  it('falsificação: devolver o seed de antes do conserto à positivação acusa exatamente ele (e o corpo intocado, não)', () => {
    const alvo = arquivos.find((a) => a.caminho === ARQUIVO_DA_POSITIVACAO);
    expect(alvo, `${ARQUIVO_DA_POSITIVACAO} sumiu do universo — a falsificação perdeu o alvo`).toBeDefined();
    expect(veredito(r, true).codigo).toBe(0); // controle, antes de sabotar
    const doAlvo = alvo!.fonte.split('\n');
    const heredoc = doAlvo.findIndex((l) => /^[^#]*<<-?\s*'SQL'\s*$/.test(l));
    expect(heredoc, `${ARQUIVO_DA_POSITIVACAO} sem heredoc <<'SQL' — a falsificação perdeu o alvo`).toBeGreaterThanOrEqual(0);
    const sabotada = [...doAlvo.slice(0, heredoc + 1), SEED_145, ...doAlvo.slice(heredoc + 1)].join('\n');
    const rs = analisar(arquivos.map((a) => (a === alvo ? { ...a, fonte: sabotada } : a)));
    expect(rs.violacoes).toEqual([{ arquivo: ARQUIVO_DA_POSITIVACAO, linha: heredoc + 2, trecho: SEED_145.trim() }]);
    expect(veredito(rs, true).codigo).toBe(1);
  });
});
