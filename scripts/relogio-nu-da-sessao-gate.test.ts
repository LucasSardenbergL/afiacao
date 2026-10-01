// Gate do DIA da sessão lido NU (classe ii do fuso da sessão) — o módulo explica a classe.
// Diário: docs/historico/hoje-da-sessao-nu-funcoes-e-skills.md
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Arquivo,
  CONHECIDOS,
  CORTE,
  PISOS,
  analisar,
  confrontar,
  corposVivosDe,
  detectarNoSql,
  lerRepo,
  veredito,
} from './relogio-nu-da-sessao-gate';
import { removerComentariosSql } from './lib/sql-comentarios';

const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const REPO = lerRepo(RAIZ);
const RADAR = 'supabase/migrations/20260613190000_radar_fatia3.sql';
const PICKING = 'supabase/migrations/20260604120000_picking_bridge.sql';
const FINANCEIRO = '.claude/skills/bi-colacor/references/queries-financeiro.md';
const VENDAS = '.claude/skills/bi-colacor/references/queries-vendas.md';
const FARMER = '.claude/skills/farmer-industrial/references/queries-sql.md';
const AGING = '.claude/skills/cfo-colacor/assets/sql/03-inadimplencia-aging.sql';
const FIX = 'supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql';
const FIXTURE = 'db/fixtures/hoje-sp-sete-funcoes-predecessoras-prod-20260929.sql';
const arq = (caminho: string): Arquivo => {
  const a = REPO.arquivos.find((x) => x.caminho === caminho);
  if (!a) throw new Error(`não lido: ${caminho}`);
  return a;
};
const trechos = (a: Arquivo) => analisar([a]).violacoes.map((s) => `${s.linha} ${s.trecho}`);
const sql = (fonte: string) => trechos({ caminho: 'fixture/m.sql', fonte });

// A #14 de bi-colacor como era antes do conserto: o dia da sessão E o instante virando data na sessão.
const SKILL_PRE_FIX = [
  '## #14 — Pedidos travados',
  '> Não use `current_date` na prosa — e isto aqui é prosa.',
  '```sql',
  'select id,',
  '  (current_date - created_at::date) as dias_em_aberto',
  'from sales_orders',
  "where created_at::date <= current_date - interval '3 days';",
  '```',
].join('\n');

describe('calibração — o detector pega o sítio pré-fix e solta a correção (arquivos REAIS)', () => {
  it('radar_atribuir_tarefa de 20260613190000 (pré-fix): exatamente o hoje da due_date', () => {
    expect(detectarNoSql(RADAR, arq(RADAR).fonte)).toEqual([
      { arquivo: RADAR, linha: 111, trecho: 'current_date', forma: 'dia da sessão' },
    ]);
  });

  it('listar_pedidos_a_separar de 20260604120000 (pré-fix): os 3 instantes do pedido e a janela', () => {
    expect(trechos(arq(PICKING)).length).toBe(0);   // antes do corte: o texto não é lido…
    expect(detectarNoSql(PICKING, arq(PICKING).fonte).map((s) => `${s.linha} ${s.trecho}`)).toEqual([
      '147 so.created_at::date', '152 current_date', '152 so.created_at::date', '154 so.created_at::date',
    ]);   // …mas a assinatura o reconhece: é o corpo VIVO que a baseline vigia
  });

  it('os 7 predecessores da prod (fixture) carregam os 12 sítios que a 20260929001651 troca — e só eles', () => {
    const fonte = readFileSync(resolve(RAIZ, FIXTURE), 'utf8');
    const conta = (t: string) => detectarNoSql(FIXTURE, fonte).filter((s) => s.trecho === t).length;
    expect(detectarNoSql(FIXTURE, fonte)).toHaveLength(12);
    expect([conta('current_date'), conta('so.created_at::date')]).toEqual([9, 3]);
  });

  it('a correção 20260929001651 não acusa nada — e o conserto foi LIDO (9 hojes de SP no código)', () => {
    const fonte = arq(FIX).fonte;
    expect(removerComentariosSql(fonte).match(/\(now\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date/g)?.length).toBe(9);
    expect(detectarNoSql(FIX, fonte)).toEqual([]);
  });

  it('a skill pré-fix acusa as 2 formas na linha certa — e a prosa fica de fora', () => {
    expect(trechos({ caminho: '.claude/skills/x/q.md', fonte: SKILL_PRE_FIX })).toEqual([
      '5 created_at::date', '5 current_date', '7 created_at::date', '7 current_date',
    ]);
  });

  it('as skills de hoje não acusam nada — e o conserto foi LIDO (controle positivo)', () => {
    expect(arq(FINANCEIRO).fonte).toContain("select (now() at time zone 'America/Sao_Paulo')::date as hoje");
    expect(arq(VENDAS).fonte).toContain("(created_at at time zone 'America/Sao_Paulo')::date <= h.hoje - 3");
    expect(arq(FARMER).fonte).toContain("(so.created_at at time zone 'America/Sao_Paulo')::date as data");
    expect(arq(AGING).fonte).toContain("((now() AT TIME ZONE 'America/Sao_Paulo')::date - data_vencimento)");
    for (const c of [FINANCEIRO, VENDAS, FARMER, AGING]) expect(trechos(arq(c))).toEqual([]);
  });
});

describe('as camadas', () => {
  it('prosa de .md não é código: a skill que EXPLICA a forma errada fora da cerca passa', () => {
    const fonte = 'Nunca `current_date` nem `created_at::date`: a sessão é UTC.\n\n```sql\nselect 1;\n```';
    expect(trechos({ caminho: '.claude/skills/x/regra.md', fonte })).toEqual([]);
  });

  it('cerca de QUALQUER linguagem é lida — o psql dentro de um ```bash também roda', () => {
    const fonte = '```bash\npsql-ro -c "select to_char(started_at,\'HH24:MI\') from t"\n```';
    expect(trechos({ caminho: '.claude/skills/x/receita.md', fonte })).toEqual(['2 to_char(started_at,']);
  });

  it('comentário SQL não é código: a forma antiga citada num `--` não reprova', () => {
    expect(sql("-- antes: current_date e created_at::date\nselect (now() AT TIME ZONE 'America/Sao_Paulo')::date;")).toEqual([]);
  });

  it('o fuso ESCRITO passa — SP ou UTC de propósito —, e cada forma da assinatura reprova sozinha', () => {
    const passa = [
      "(now() AT TIME ZONE 'America/Sao_Paulo')::date",
      "(now() AT TIME ZONE 'UTC')::date",
      "(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date",
      "date_trunc('day', now(), 'America/Sao_Paulo')",
      "to_char(started_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI')",
      'now()::timestamptz',
      'now()::timestamp with time zone',
      'extract(epoch from now())',
      'inicio_em::date',             // os 3 *_em que são date na prod
      'data_vencimento::date',       // date já é date
      'current_timestamp',
      'age(now(), started_at)',
    ];
    for (const e of passa) expect(sql(`select ${e};`), e).toEqual([]);
    const reprova = [
      'current_date', 'CURRENT_DATE', 'localtimestamp', 'localtime', 'current_time',
      'now()::date', 'now() :: timestamp', 'now()::timestamp without time zone', 'current_timestamp::date',
      'clock_timestamp()::date', 'cast(now() as date)', 'date(now())', "to_char(now(), 'YYYY-MM')",
      'extract(day from now())', "date_part('month', current_timestamp)",
      'created_at::date', 'so.created_at::date', 'criado_em::timestamp', 'max(created_at)::date', 'date(started_at)',
      'cast(created_at as date)', "date_trunc('day', created_at)", 'extract(hour from so.created_at)', "to_char(criado_em, 'MM-DD')",
    ];
    for (const e of reprova) expect(sql(`select ${e};`), e).toHaveLength(1);
  });

  it('nenhum arquivo → INDETERMINADO, não "limpo"', () => {
    expect(veredito(analisar([]), false).codigo).toBe(2);
  });

  it('em modo fixture (sem baseline), todo sítio reprova com exit 1 — na linha certa', () => {
    const v = veredito(analisar([{ caminho: 'fixture/q.md', fonte: SKILL_PRE_FIX }]), false);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('fixture/q.md:5 current_date (dia da sessão)');
    expect(v.linhas.join('\n')).toContain('fixture/q.md:7 created_at::date (instante→data na sessão)');
  });

  it('cerca que não fecha → INDETERMINADO, não "limpo"', () => {
    const r = analisar([{ caminho: '.claude/skills/x/quebrado.md', fonte: 'texto\n```sql\nselect 1;' }]);
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('stripper que come mais que o teto → INDETERMINADO (comeu código?)', () => {
    const fonte = `${Array.from({ length: 250 }, (_, i) => `-- linha ${i}`).join('\n')}\nselect 1;`;
    const r = analisar([{ caminho: `supabase/migrations/${CORTE.slice(0, 8)}999999_x.sql`, fonte }]);
    expect(r.alarmes.join('\n')).toContain('250 linhas seguidas');
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('o corte: migration ANTES dele não tem o texto lido; a partir dele, tem', () => {
    const fonte = 'select current_date;';
    const antes = analisar([{ caminho: 'supabase/migrations/20260101000000_velha.sql', fonte }]);
    const depois = analisar([{ caminho: `supabase/migrations/${CORTE}_mesmo_instante.sql`, fonte }]);
    expect([antes.migrations, antes.migracoesNovas, antes.violacoes.length]).toEqual([1, 0, 0]);
    expect([depois.migrations, depois.migracoesNovas, depois.violacoes.length]).toEqual([1, 1, 1]);
  });
});

describe('o repo', () => {
  const r = analisar(REPO.arquivos, REPO.corpos);
  const nova = (fonte: string): Arquivo => ({ caminho: 'supabase/migrations/29990101000000_nova.sql', fonte });

  it('limpo, com os pisos cumpridos — e o censo prova que leu os 3 universos', () => {
    expect(veredito(r, true)).toMatchObject({ codigo: 0 });
    expect(r.migrations).toBeGreaterThanOrEqual(PISOS.migrations);
    expect(r.migracoesNovas).toBeGreaterThanOrEqual(PISOS.migracoesNovas);
    expect(r.arquivosDeSkill).toBeGreaterThanOrEqual(PISOS.arquivosDeSkill);
    expect(r.linhasDeCodigoDeSkill).toBeGreaterThanOrEqual(PISOS.linhasDeCodigoDeSkill);
    expect(r.corposVivos).toBeGreaterThanOrEqual(PISOS.corposVivos);
  });

  it('a baseline é EXATA: cada sítio conhecido está no corpo vivo, e nada além deles', () => {
    expect(confrontar(r.contagemVivos, CONHECIDOS)).toEqual({ novos: [], quitados: [] });
    expect(r.violacoes).toEqual([]);
    expect([...r.contagemVivos.values()].reduce((t, n) => t + n, 0)).toBe(CONHECIDOS.reduce((t, c) => t + c.n, 0));
  });

  it('toda entrada tem veredito e motivo — a baseline guarda o PORQUÊ, não só o trecho', () => {
    for (const c of CONHECIDOS) expect(c.motivo.length, `${c.alvo} · ${c.trecho}`).toBeGreaterThan(20);
    expect(new Set(CONHECIDOS.map((c) => `${c.alvo} · ${c.trecho}`)).size).toBe(CONHECIDOS.length);
  });

  it('função nova numa migration nova com o dia da sessão reprova — no texto E no corpo vivo', () => {
    const f = nova('CREATE OR REPLACE FUNCTION public.f_nova() RETURNS date LANGUAGE sql AS $f$ SELECT current_date $f$;');
    const arquivos = [...REPO.arquivos, f];
    const corpos = new Map(REPO.corpos).set('f_nova()', ' SELECT current_date ');
    const v = veredito(analisar(arquivos, corpos), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('supabase/migrations/29990101000000_nova.sql:1 current_date (dia da sessão)');
    expect(v.linhas.join('\n')).toContain('CORPO VIVO NOVO f_nova() · current_date');
  });

  it('view e DEFAULT numa migration nova também — o que o irmão de funções não lê', () => {
    const v = veredito(analisar([...REPO.arquivos, nova(
      'CREATE VIEW public.v_x AS SELECT so.created_at::date AS dia FROM sales_orders so;\n'
      + 'ALTER TABLE public.t ALTER COLUMN d SET DEFAULT CURRENT_DATE;',
    )], REPO.corpos), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('29990101000000_nova.sql:1 so.created_at::date');
    expect(v.linhas.join('\n')).toContain('29990101000000_nova.sql:2 current_date');
  });

  it('UTC de propósito, escrito, passa numa migration nova', () => {
    const v = veredito(analisar([...REPO.arquivos, nova("SELECT (now() AT TIME ZONE 'UTC')::date;")], REPO.corpos), true);
    expect(v.codigo).toBe(0);
  });

  it('sem a 20260929001651, os 5 corpos que ela conserta (e têm CREATE antigo no repo) voltam como NOVOS', () => {
    // A 20261001014200 (universo de pedidos) recria get_regua_preco POR CIMA da FIX e herda o hoje de SP: no
    // contrafactual ela sai junto, senão a régua não volta crua (a última a recriar vence).
    const SUCESSORAS = ['supabase/migrations/20261001014200_universo_pedidos_preco.sql'];
    const semFix = REPO.arquivos.filter((a) => a.caminho !== FIX && !SUCESSORAS.includes(a.caminho));
    const v = veredito(analisar(semFix, corposVivosDe(semFix)), true);
    expect(v.codigo).toBe(1);
    const txt = v.linhas.join('\n');
    for (const f of ['fin_period_lock_trigger()', 'get_regua_preco(uuid,uuid,numeric,numeric,numeric[])', 'listar_pedidos_a_separar(text)',
      'radar_atribuir_tarefa(text,integer)', 'vendas_sync_semear_janela(date,date,text[])']) {
      expect(txt).toContain(`CORPO VIVO NOVO ${f} · `);
    }
  });

  it('sítio conhecido que sai do corpo vivo reprova como QUITADO (a lista só encolhe)', () => {
    const corpos = new Map(REPO.corpos);
    corpos.delete('fin_audit_trigger()');
    const v = veredito(analisar(REPO.arquivos, corpos), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('QUITADO (tire da baseline CONHECIDOS) fin_audit_trigger() · current_date (baseline 3, corpo vivo 0)');
  });

  it('um sítio a MAIS num corpo conhecido reprova como novo (a contagem é parte da identidade)', () => {
    const corpos = new Map(REPO.corpos);
    corpos.set('fin_audit_trigger()', `${corpos.get('fin_audit_trigger()')}\n  PERFORM current_date;`);
    const v = veredito(analisar(REPO.arquivos, corpos), true);
    expect(v.linhas.join('\n')).toContain('CORPO VIVO NOVO fin_audit_trigger() · current_date (4× no corpo vivo, baseline 3)');
  });

  // Um piso por universo, cada um derrubado SOZINHO: um piso que só cai junto com outro é decoração.
  const MENSAGEM_DO_PISO = {
    migrations: 'migration(s) lida(s) < piso',
    migracoesNovas: `a partir do corte ${CORTE} < piso`,
    arquivosDeSkill: 'arquivo(s) de skill < piso',
    linhasDeCodigoDeSkill: 'linha(s) de código de skill < piso',
    corposVivos: 'corpo(s) vivo(s) < piso',
  } as const;
  const soPorEste = (arquivos: readonly Arquivo[], corpos: ReadonlyMap<string, string>, piso: keyof typeof MENSAGEM_DO_PISO) => {
    const v = veredito(analisar(arquivos, corpos), true);
    expect(v.codigo).toBe(2);
    for (const [k, mensagem] of Object.entries(MENSAGEM_DO_PISO)) {
      if (k === piso) expect(v.linhas.join('\n')).toContain(mensagem);
      else expect(v.linhas.join('\n')).not.toContain(mensagem);
    }
  };
  const migrations = REPO.arquivos.filter((a) => a.caminho.startsWith('supabase/migrations/'));
  const novas = migrations.filter((a) => (a.caminho.split('/').pop() ?? '').slice(0, 14) >= CORTE);
  const velhas = migrations.filter((a) => !novas.includes(a));
  const skills = REPO.arquivos.filter((a) => a.caminho.startsWith('.claude/skills/'));

  it('10 migrations não são o repo → INDETERMINADO só pelo piso de migrations', () => {
    soPorEste([...novas, ...velhas.slice(0, 10 - novas.length), ...skills], REPO.corpos, 'migrations');
  });

  it('as migrations do corte não lidas → INDETERMINADO só pelo piso do corte', () => {
    soPorEste([...velhas, ...skills], REPO.corpos, 'migracoesNovas');
  });

  it('corpos vivos não lidos → INDETERMINADO só pelo piso de corpos vivos', () => {
    soPorEste(REPO.arquivos, new Map(), 'corposVivos');
  });

  it('skills de MENOS (com código de sobra) → INDETERMINADO só pelo piso de arquivos de skill', () => {
    const linhas = (a: Arquivo) => analisar([a]).linhasDeCodigoDeSkill;
    const maiores = [...skills].sort((a, b) => linhas(b) - linhas(a)).slice(0, PISOS.arquivosDeSkill - 1);
    expect(analisar(maiores).linhasDeCodigoDeSkill).toBeGreaterThanOrEqual(PISOS.linhasDeCodigoDeSkill);
    soPorEste([...migrations, ...maiores], REPO.corpos, 'arquivosDeSkill');
  });

  it('skills abertas mas sem consulta lida (arquivo vazio) → INDETERMINADO só pelo piso de linhas de código', () => {
    soPorEste([...migrations, ...skills.map((a) => ({ ...a, fonte: '' }))], REPO.corpos, 'linhasDeCodigoDeSkill');
  });
});
