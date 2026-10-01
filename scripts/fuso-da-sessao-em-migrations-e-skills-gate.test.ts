// Gate do relógio da SESSÃO truncado ao calendário em migrations e skills — o módulo explica a classe.
// Diário: docs/historico/relogio-da-sessao-truncado-rpcs-e-views-des.md
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Arquivo,
  CONHECIDOS,
  PISOS,
  analisar,
  confrontar,
  corposVivosDe,
  detectarNoSql,
  lerRepo,
  veredito,
} from './fuso-da-sessao-em-migrations-e-skills-gate';

const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const REPO = lerRepo(RAIZ);
const FIX = 'supabase/migrations/20260927202603_fuso_sp_relogio_da_sessao_rpcs_views_des.sql';
const RADAR = 'supabase/migrations/20260612130000_radar_rpcs_contato.sql';
const VENDAS = '.claude/skills/bi-colacor/references/queries-vendas.md';
const CAIXA = '.claude/skills/cfo-colacor/assets/sql/01-caixa-13-semanas.sql';
const arq = (caminho: string): Arquivo => {
  const a = REPO.arquivos.find((x) => x.caminho === caminho);
  if (!a) throw new Error(`não lido: ${caminho}`);
  return a;
};
const trechos = (a: Arquivo) => analisar([a]).violacoes.map((s) => `${s.linha} ${s.trecho}`);

// A query #1 de bi-colacor como era antes do conserto (o CTE que truncava o current_date da sessão).
const SKILL_PRE_FIX = [
  '## #1 — Faturamento MTD',
  "> Não use `date_trunc('month', current_date)` na prosa — e isto aqui é prosa.",
  '```sql',
  'with p as (',
  "  select date_trunc('month', current_date)                          as ini_atual,",
  "         (current_date + interval '1 day')                          as fim_atual,",
  "         date_trunc('month', current_date - interval '1 month')     as ini_ant",
  ')',
  'select * from p;',
  '```',
].join('\n');

describe('calibração — o detector pega o sítio pré-fix e solta a correção (arquivos REAIS)', () => {
  it('radar_kpis de 20260612130000 (pré-fix): exatamente a truncagem do mês na sessão', () => {
    expect(detectarNoSql(RADAR, arq(RADAR).fonte)).toEqual({
      sitios: [{ arquivo: RADAR, linha: 125, trecho: "date_trunc('month', now())", motivo: 'relógio da sessão sem fuso' }],
      ilegiveis: [],
    });
  });

  it('a correção 20260927202603 não acusa nada — e as chamadas dela foram LIDAS', () => {
    const fonte = arq(FIX).fonte;
    // controle positivo: sem ele, "não achou" e "não leu" dariam o mesmo []
    expect(fonte).toContain("date_trunc('month', now(), 'America/Sao_Paulo')");
    // as 7 truncagens dos 4 objetos (radar 1, projeção 1, em trânsito 2, posição 3), todas com fuso escrito
    expect(fonte.match(/date_trunc\s*\(/gi)?.length).toBe(7);
    expect(detectarNoSql(FIX, fonte)).toEqual({ sitios: [], ilegiveis: [] });
  });

  it('a skill bi-colacor pré-fix acusa as 2 truncagens do CTE — e só elas, na linha certa', () => {
    expect(trechos({ caminho: '.claude/skills/x/q.md', fonte: SKILL_PRE_FIX })).toEqual([
      "5 date_trunc('month', current_date)",
      "7 date_trunc('month', current_date - interval '1 month')",
    ]);
  });

  it('as skills de hoje não acusam nada — e o CTE novo foi lido', () => {
    expect(arq(VENDAS).fonte).toContain("date_trunc('month', h.hoje::timestamp)");
    expect(arq(CAIXA).fonte).toContain("date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')");
    expect(trechos(arq(VENDAS))).toEqual([]);
    expect(trechos(arq(CAIXA))).toEqual([]);
  });
});

describe('as camadas', () => {
  it('prosa de .md não é código: a skill que EXPLICA a forma errada fora da cerca passa', () => {
    const fonte = "Nunca `date_trunc('month', now())`: a sessão é UTC.\n\n```sql\nselect 1;\n```";
    expect(trechos({ caminho: '.claude/skills/x/regra.md', fonte })).toEqual([]);
  });

  it('cerca de QUALQUER linguagem é lida — o psql dentro de um ```bash também roda', () => {
    const fonte = "```bash\npsql-ro -c \"select date_trunc('week', now())\"\n```";
    expect(trechos({ caminho: '.claude/skills/x/receita.md', fonte })).toEqual(["2 date_trunc('week', now())"]);
  });

  it('comentário SQL não é código: a forma antiga citada num `--` não reprova', () => {
    const fonte = "-- antes: date_trunc('month', now())\nselect date_trunc('month', now(), 'America/Sao_Paulo');";
    expect(trechos({ caminho: 'supabase/migrations/29990101000000_x.sql', fonte })).toEqual([]);
  });

  it('o fuso ESCRITO passa, inclusive UTC de propósito; o relógio LOCAL nunca passa', () => {
    const passa = [
      "date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')",
      "date_trunc('month', now(), 'America/Sao_Paulo')",
      "date_trunc('day', now() AT TIME ZONE 'UTC')",
      "date_trunc('hour', now())",
      "date_trunc('month', data_emissao)",
    ];
    for (const e of passa) expect(trechos({ caminho: 'm.sql', fonte: `select ${e};` })).toEqual([]);
    const reprova = ["date_trunc('quarter', CURRENT_DATE::timestamptz)", "date_trunc('week', current_date AT TIME ZONE 'America/Sao_Paulo')"];
    for (const e of reprova) expect(trechos({ caminho: 'm.sql', fonte: `select ${e};` })).toHaveLength(1);
  });

  it('nenhum arquivo → INDETERMINADO, não "limpo"', () => {
    expect(veredito(analisar([]), false).codigo).toBe(2);
  });

  it('em modo fixture (sem baseline), todo sítio reprova com exit 1 — na linha certa', () => {
    const v = veredito(analisar([{ caminho: 'fixture/q.md', fonte: SKILL_PRE_FIX }]), false);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain("fixture/q.md:5 date_trunc('month', current_date)");
  });

  it('cerca que não fecha → INDETERMINADO, não "limpo"', () => {
    const r = analisar([{ caminho: '.claude/skills/x/quebrado.md', fonte: 'texto\n```sql\nselect 1;' }]);
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('chamada que não fecha → INDETERMINADO, não "limpo"', () => {
    const r = analisar([{ caminho: 'm.sql', fonte: "select date_trunc('month', now()" }]);
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('stripper que come mais que o teto → INDETERMINADO (comeu código?)', () => {
    const fonte = `${Array.from({ length: 250 }, (_, i) => `-- linha ${i}`).join('\n')}\nselect 1;`;
    const r = analisar([{ caminho: 'supabase/migrations/29990101000000_x.sql', fonte }]);
    expect(r.alarmes.join('\n')).toContain('250 linhas seguidas');
    expect(veredito(r, false).codigo).toBe(2);
  });
});

describe('o repo', () => {
  const r = analisar(REPO.arquivos, REPO.corpos);

  it('limpo, com os pisos cumpridos — e o censo prova que leu os 3 universos', () => {
    expect(veredito(r, true)).toMatchObject({ codigo: 0 });
    expect(r.migrations).toBeGreaterThanOrEqual(PISOS.migrations);
    expect(r.arquivosDeSkill).toBeGreaterThanOrEqual(PISOS.arquivosDeSkill);
    expect(r.linhasDeCodigoDeSkill).toBeGreaterThanOrEqual(PISOS.linhasDeCodigoDeSkill);
    expect(r.corposVivos).toBeGreaterThanOrEqual(PISOS.corposVivos);
  });

  it('a baseline é EXATA: as 4 definições mortas estão no texto, e nada além delas', () => {
    expect(confrontar(r.contagem, CONHECIDOS)).toEqual({ novos: [], quitados: [] });
    expect(r.violacoes).toHaveLength(CONHECIDOS.reduce((t, c) => t + c.n, 0));
  });

  it('sem a migration que as supera, as definições mortas RESSUSCITAM nos corpos vivos', () => {
    const semFix = REPO.arquivos.filter((a) => a.caminho !== FIX);
    const ressuscitou = analisar(semFix, corposVivosDe(semFix));
    expect(veredito(ressuscitou, true).codigo).toBe(1);
    const vivos = ressuscitou.corposVivosComSitio.join('\n');
    expect(vivos).toContain('fin_projecao_13_semanas(text,numeric)');
    expect(vivos).toContain('radar_kpis()');
  });

  it('sítio novo numa migration nova reprova — view inclusive, que o irmão de funções não lê', () => {
    const nova: Arquivo = {
      caminho: 'supabase/migrations/29990101000000_view_nova.sql',
      fonte: "CREATE VIEW public.v_x AS SELECT date_trunc('quarter', CURRENT_DATE)::date AS ini;",
    };
    const v = veredito(analisar([...REPO.arquivos, nova], REPO.corpos), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain("NOVO supabase/migrations/29990101000000_view_nova.sql · date_trunc('quarter', current_date)");
  });

  it('entrada da baseline que some do texto reprova (arquivo apagado ou editado)', () => {
    const semRadar = REPO.arquivos.filter((a) => a.caminho !== RADAR);
    const v = veredito(analisar(semRadar, REPO.corpos), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain(`QUITADO (tire da baseline CONHECIDOS) ${RADAR}`);
  });

  // Um piso por universo, cada um derrubado SOZINHO: um piso que só cai junto com outro é decoração.
  // Não basta o veredito ser 2 — o furo tem de ser o DESTE piso, e só ele. Medido no mutation-check
  // do #2637: o cenário antigo das skills (sem skill nenhuma) derrubava o piso de LINHAS junto, e o
  // piso de ARQUIVOS desligado sobrevivia (a suíte seguia verde).
  const MENSAGEM_DO_PISO = {
    migrations: 'migration(s) lida(s) < piso',
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
  const skills = REPO.arquivos.filter((a) => a.caminho.startsWith('.claude/skills/'));

  it('10 migrations não são o repo → INDETERMINADO só pelo piso de migrations', () => {
    soPorEste([...migrations.slice(0, 10), ...skills], REPO.corpos, 'migrations');
  });

  it('corpos vivos não lidos → INDETERMINADO só pelo piso de corpos vivos', () => {
    soPorEste(REPO.arquivos, new Map(), 'corposVivos');
  });

  it('skills de MENOS (com código de sobra) → INDETERMINADO só pelo piso de arquivos de skill', () => {
    // as (piso - 1) skills com mais código: arquivos abaixo do piso, linhas ainda acima do delas
    const linhas = (a: Arquivo) => analisar([a]).linhasDeCodigoDeSkill;
    const maiores = [...skills].sort((a, b) => linhas(b) - linhas(a)).slice(0, PISOS.arquivosDeSkill - 1);
    expect(analisar(maiores).linhasDeCodigoDeSkill).toBeGreaterThanOrEqual(PISOS.linhasDeCodigoDeSkill);
    soPorEste([...migrations, ...maiores], REPO.corpos, 'arquivosDeSkill');
  });

  it('skills abertas mas sem consulta lida (arquivo vazio) → INDETERMINADO só pelo piso de linhas de código', () => {
    soPorEste([...migrations, ...skills.map((a) => ({ ...a, fonte: '' }))], REPO.corpos, 'linhasDeCodigoDeSkill');
  });
});
