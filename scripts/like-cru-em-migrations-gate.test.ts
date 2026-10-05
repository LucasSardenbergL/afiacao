// Prova do fiscal da classe pattern-like-cru na camada SQL (scripts/like-cru-em-migrations-gate.ts).
// As mutações que provam o dente de cada camada: scripts/mutcheck.d/like-cru-em-migrations.mut.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analisar,
  analisarPassos,
  type Arquivo,
  CONHECIDOS,
  confrontar,
  corposVivosDePassos,
  lerRepo,
  lerSql,
  type Motivo,
  PISOS,
  temAncora,
  TETO_BLOCO_DESCARTADO,
  veredito,
  VIVOS_PERMITIDOS,
} from './like-cru-em-migrations-gate';
import { contarPulsos, descreverPulsos, drenarCedendo } from '@/test/loop-livre';

const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const REPO = lerRepo(RAIZ);

/**
 * O repo inteiro DENTRO do `it`, drenado CEDENDO o event loop do worker — para os `it` que PAGAM a
 * varredura: o fold dos corpos vivos (sem `corpos`) ou a leitura que erra o memo do `lerSql` (chave
 * = texto + caminho; renomear o caminho relê tudo). De uma vez, esses eram bloqueios síncronos de até
 * 3,2s sob carga em 2026-10-05, e acima de 60s o RPC do vitest estoura — `test` rc=1 sem teste
 * falhando (src/test/loop-livre.ts). Os `it` que só releem o memo (3–4ms) ficam no `analisar`
 * síncrono: não há o que ceder, e um pulso sobre trabalho tão curto não bate nem cedendo.
 */
async function analisarCedendo(arquivos: readonly Arquivo[], corpos?: ReadonlyMap<string, string>) {
  const p = await contarPulsos(async () =>
    drenarCedendo(
      analisarPassos(arquivos, corpos ?? (await drenarCedendo(corposVivosDePassos(arquivos))), VIVOS_PERMITIDOS),
    ),
  );
  expect(p.batidas, descreverPulsos(p)).toBeGreaterThanOrEqual(2);
  return p.resultado;
}
const FIX = 'supabase/migrations/20260929000234_padrao_like_contem_escapa_curinga.sql';

const motivos = (sql: string): Motivo[] => lerSql('fixture.sql', sql).sitios.map((s) => s.motivo);
const fixture = (fonte: string, caminho = 'fixture/x.sql'): Arquivo => ({ caminho, fonte });

describe('calibração — o pré-fix acusa e a correção passa (arquivos REAIS)', () => {
  it('sem a 20260929000234, os 5 corpos vivos do repo voltam a ser os crus e acusam os 9 sítios', async () => {
    // A 20261001014100 (universo de pedidos) recria melhoria_clientes_por_produto POR CIMA da FIX e herda o
    // escape: no contrafactual ela sai junto, senão a melhoria não volta a ser a crua (a última a recriar vence).
    const SUCESSORAS = ['supabase/migrations/20261001014100_universo_pedidos_recencia.sql'];
    const sem = REPO.arquivos.filter((a) => a.caminho !== FIX && !SUCESSORAS.includes(a.caminho));
    const r = await analisarCedendo(sem);
    const porFuncao = new Map<string, number>();
    for (const c of r.corposVivosComSitio) {
      const f = c.split(' — ')[0];
      porFuncao.set(f, (porFuncao.get(f) ?? 0) + 1);
    }
    expect(Object.fromEntries(porFuncao)).toEqual({
      'resolver_sku_por_codigo_fornecedor(text,text)': 3,
      'tarefas_matcher_tick()': 1,
      'melhoria_clientes_por_produto(text)': 2,
      'melhoria_produtos_relacionados(text)': 2,
      'buscar_skus_candidatos(text[])': 1,
    });
    expect(veredito(r, true).codigo).toBe(1);
  });

  it('a 20260929000234 não acusa nada — e os 14 operadores dela foram LIDOS', () => {
    const l = lerSql(FIX, readFileSync(resolve(RAIZ, FIX), 'utf8'));
    expect(l.sitios).toEqual([]);
    expect(l.alarmes).toEqual([]);
    expect(l.operadores).toBe(14);
  });

  it('os corpos de PROD de listar_skus e expandir (só existem no schema-snapshot) acusam', () => {
    const snap = readFileSync(resolve(RAIZ, 'supabase/schema-snapshot.sql'), 'utf8');
    const bloco = (nome: string) => {
      const ini = snap.indexOf(`CREATE FUNCTION ${nome}`);
      expect(ini).toBeGreaterThan(-1);
      return snap.slice(ini, snap.indexOf('$$;', snap.indexOf('AS $$', ini) + 5) + 3);
    };
    expect(lerSql('snapshot', bloco('public.listar_skus_por_codigo_fornecedor(')).sitios.map((s) => s.trecho))
      .toEqual(["ilike '%' || p_codigo_fornecedor || '%'"]);
    expect(lerSql('snapshot', bloco('public.expandir_promocao_item(p_item_id bigint, p_threshold')).sitios.map((s) => s.trecho))
      .toEqual(["ilike '%' || v_item . sku_codigo_fornecedor || '%'"]);
  });
});

describe('a assinatura — o operando da direita como o parser o lê', () => {
  it.each<[string, string, Motivo[]]>([
    ['concatenação com parâmetro', "SELECT 1 WHERE a ILIKE '%' || p || '%'", ['concatenação']],
    ['NOT ILIKE com concatenação', "SELECT 1 WHERE a NOT ILIKE '%' || p || '%'", ['concatenação']],
    ['variável nua', 'SELECT 1 WHERE a ILIKE p', ['valor']],
    ['parâmetro posicional', 'SELECT 1 WHERE a ILIKE $1', ['valor']],
    ['outra função sobre o valor', 'SELECT 1 WHERE a ILIKE lower(p)', ['valor']],
    ['subconsulta', 'SELECT 1 WHERE a ILIKE (SELECT v FROM t)', ['valor']],
    ['CASE', "SELECT 1 WHERE a ILIKE CASE WHEN x THEN 'a' ELSE 'b' END", ['valor']],
    ['cast antes da concatenação', "SELECT 1 WHERE a ILIKE '%'::text || p", ['concatenação']],
    ['cast de várias palavras antes da concatenação', "SELECT 1 WHERE a ILIKE '%'::character varying || p", ['concatenação']],
    ['grupo com concatenação', "SELECT 1 WHERE a ILIKE ('%' || p || '%')", ['concatenação']],
    ['literal constante', "SELECT 1 WHERE a ILIKE 'abc%'", []],
    ['literal com ESCAPE próprio', "SELECT 1 WHERE a LIKE 'margem!_faixa!_%' ESCAPE '!'", []],
    ['literais concatenados', "SELECT 1 WHERE a ILIKE 'a' || 'b'", []],
    ['função sobre literal', "SELECT 1 WHERE a ILIKE upper('abc%')", []],
    ['o idioma', "SELECT 1 WHERE a ILIKE private.padrao_like_contem(p) ESCAPE '\\'", []],
    ['o idioma entre parênteses', "SELECT 1 WHERE a ILIKE (private.padrao_like_contem(trim(p))) ESCAPE '\\'", []],
    ['o idioma em LIKE com upper', "SELECT 1 WHERE upper(a) LIKE private.padrao_like_contem(upper(t)) ESCAPE '\\'", []],
    ['o helper sem ESCAPE', 'SELECT 1 WHERE a ILIKE private.padrao_like_contem(p)', ['helper sem ESCAPE']],
    ['o helper com ESCAPE vazio', "SELECT 1 WHERE a ILIKE private.padrao_like_contem(p) ESCAPE ''", ['helper sem ESCAPE']],
    ['o helper com algo concatenado depois', "SELECT 1 WHERE a ILIKE private.padrao_like_contem(p) || 'x' ESCAPE '\\'", ['concatenação']],
    ['função homônima de outro schema', "SELECT 1 WHERE a ILIKE outra.padrao_like_contem(p) ESCAPE '\\'", ['valor']],
    ['o operador ~~* com valor', "SELECT 1 WHERE a ~~* ('%' || p || '%')", ['operador sem ESCAPE']],
    ['o operador ~~ com o helper (não tem cláusula ESCAPE)', 'SELECT 1 WHERE a ~~ private.padrao_like_contem(p)', ['operador sem ESCAPE']],
    ['o operador ~~ com literal', "SELECT 1 WHERE a ~~ 'abc%'", []],
    ['SIMILAR TO com valor', 'SELECT 1 WHERE a SIMILAR TO p', ['SIMILAR TO']],
    ['SIMILAR TO com literal', "SELECT 1 WHERE a SIMILAR TO '(a|b)%'", []],
    ['LIKE ANY de array constante', "SELECT 1 WHERE a LIKE ANY (ARRAY['a%', 'b%'])", []],
    ['LIKE ANY de array vindo de parâmetro', 'SELECT 1 WHERE a LIKE ANY (p_padroes)', ['ANY/ALL']],
  ])('%s', (_nome, sql, esperado) => {
    expect(motivos(sql)).toEqual(esperado);
  });
});

describe('as camadas', () => {
  it('comentário não é código: a forma crua citada num `--` ou `/* */` não reprova', () => {
    expect(motivos("-- a ILIKE '%' || p || '%'\n/* b LIKE p */ SELECT 1")).toEqual([]);
  });

  it('literal não é código: o LIKE dentro de um rótulo não reprova (o caso do _data_health_compute)', () => {
    expect(motivos("SELECT 'fonte_sync LIKE ListarPosEstoque% (dado real)'::text")).toEqual([]);
  });

  it('CREATE TABLE (LIKE outra …) não é o operador', () => {
    expect(motivos('CREATE TABLE t (LIKE s INCLUDING ALL); CREATE TABLE u (id int, LIKE s)')).toEqual([]);
  });

  it('o corpo em dollar-quote é lido por dentro, com o contexto certo — função e bloco DO', () => {
    const l = lerSql(
      'fixture.sql',
      "CREATE OR REPLACE FUNCTION public.f(p text) RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN PERFORM 1 WHERE a ILIKE p; RETURN 1; END $fn$;\n" +
        "DO $d$ BEGIN PERFORM 1 WHERE b ILIKE '%' || q || '%'; END $d$;",
    );
    expect(l.sitios.map((s) => [s.contexto, s.motivo])).toEqual([
      ['função public.f', 'valor'],
      ['bloco DO', 'concatenação'],
    ]);
  });

  it('a âncora casa por tokens contíguos e em ordem, imune a espaço e comentário', () => {
    expect(temAncora("IF p_cnpj   !~ /* x */ '^[0-9]{14}$' THEN", "p_cnpj !~ '^[0-9]{14}$'")).toBe(true);
    expect(temAncora("IF p_cnpj ~ '^[0-9]{14}$' THEN", "p_cnpj !~ '^[0-9]{14}$'")).toBe(false);
    expect(temAncora("IF '^[0-9]{14}$' !~ p_cnpj THEN", "p_cnpj !~ '^[0-9]{14}$'")).toBe(false);
  });

  it('literal que não fecha → INDETERMINADO, não "limpo"', () => {
    const r = analisar([fixture("SELECT 1 WHERE a ILIKE 'abc")]);
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('dollar-quote que não fecha → INDETERMINADO, não "limpo"', () => {
    const r = analisar([fixture('CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $fn$ SELECT 1')]);
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('nenhum arquivo → INDETERMINADO, não "limpo"', () => {
    expect(veredito(analisar([]), false).codigo).toBe(2);
  });

  it('stripper que descarta mais que o teto → INDETERMINADO (comeu código?)', () => {
    const r = analisar([fixture(`${'-- x\n'.repeat(TETO_BLOCO_DESCARTADO + 1)}SELECT 1`)]);
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('em modo fixture (sem baseline), todo sítio reprova com exit 1 — com o contexto e o motivo', () => {
    const v = veredito(analisar([fixture("SELECT 1 WHERE a ILIKE '%' || p || '%'")]), false);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain("fixture/x.sql · ilike '%' || p || '%' [texto] (concatenação)");
  });
});

describe('o repo', () => {
  const r = analisar(REPO.arquivos, REPO.corpos, VIVOS_PERMITIDOS);

  it('limpo, com os pisos cumpridos — e o censo prova que leu os 2 universos', () => {
    const v = veredito(r, true);
    expect(v.codigo, v.linhas.join('\n')).toBe(0);
    expect(r.migrations).toBeGreaterThanOrEqual(PISOS.migrations);
    expect(r.operadores).toBeGreaterThanOrEqual(PISOS.operadores);
    expect(r.corposVivos).toBeGreaterThanOrEqual(PISOS.corposVivos);
  });

  it('a baseline é EXATA: as definições mortas estão no texto, e nada além delas', () => {
    expect(confrontar(r.contagem, CONHECIDOS)).toEqual({ novos: [], quitados: [] });
    // 22 + 1: a 20260929001651 recria radar_atribuir_tarefa (só o hoje de SP muda) — o MESMO
    // falso-positivo de VIVOS_PERMITIDOS, agora no arquivo da definição viva.
    expect(CONHECIDOS.reduce((n, c) => n + c.n, 0)).toBe(23);
  });

  it('os 3 vivos permitidos estão no corpo vivo, com a âncora de pé', () => {
    for (const p of VIVOS_PERMITIDOS) {
      const corpo = REPO.corpos.get(p.identidade);
      expect(corpo, p.identidade).toBeDefined();
      expect(temAncora(corpo ?? '', p.ancora), p.identidade).toBe(true);
    }
    expect(r.permitidosInvalidos).toEqual([]);
  });

  it('sítio novo numa migration nova reprova — e o texto diz onde', async () => {
    const nova = fixture(
      "CREATE OR REPLACE FUNCTION public.busca_nova(p text) RETURNS SETOF int LANGUAGE sql AS $$ SELECT 1 FROM t WHERE nome ILIKE '%' || p || '%' $$;",
      'supabase/migrations/29990101000000_busca_nova.sql',
    );
    const arquivos = [...REPO.arquivos, nova];
    const v = veredito(await analisarCedendo(arquivos), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('NOVO supabase/migrations/29990101000000_busca_nova.sql');
    expect(v.linhas.join('\n')).toContain('CORPO VIVO busca_nova(text)');
  });

  it('entrada da baseline que some do texto reprova (arquivo apagado ou editado)', () => {
    const editado = REPO.arquivos.map((a) =>
      a.caminho.endsWith('20260615194500_fix_tarefas_matcher_enum.sql') ? { ...a, fonte: '-- esvaziado' } : a,
    );
    const v = veredito(analisar(editado, REPO.corpos, VIVOS_PERMITIDOS), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('QUITADO (tire da baseline CONHECIDOS) supabase/migrations/20260615194500_fix_tarefas_matcher_enum.sql');
  });

  it('vivo permitido que perdeu a validação a montante reprova (a âncora sumiu)', () => {
    const corpos = new Map(REPO.corpos);
    const alvo = 'radar_atribuir_tarefa(text,integer)';
    corpos.set(alvo, (corpos.get(alvo) ?? '').replace("p_cnpj !~ '^[0-9]{14}$'", 'false'));
    const v = veredito(analisar(REPO.arquivos, corpos, VIVOS_PERMITIDOS), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('PERMITIDO radar_atribuir_tarefa(text,integer): a âncora');
  });

  it('vivo permitido cujo LIKE saiu do corpo reprova até sair da allowlist (QUITADO)', () => {
    const corpos = new Map(REPO.corpos);
    const alvo = 'reposicao_alerta_pedido_minimo_tick()';
    corpos.set(alvo, (corpos.get(alvo) ?? '').replace('ILIKE v_fornecedor', '= v_fornecedor'));
    const v = veredito(analisar(REPO.arquivos, corpos, VIVOS_PERMITIDOS), true);
    expect(v.codigo).toBe(1);
    expect(v.linhas.join('\n')).toContain('PERMITIDO reposicao_alerta_pedido_minimo_tick(): o sítio');
  });

  it('10 migrations não são o repo → INDETERMINADO só pelo piso de migrations', async () => {
    // Os demais arquivos continuam LIDOS (os operadores não caem), só deixam de contar como migration:
    // cortar a lista derrubaria junto o piso de operadores, e o teste não isolaria piso nenhum.
    const dez = REPO.arquivos.map((a, i) => (i < 10 ? a : { ...a, caminho: `fora/${a.caminho}` }));
    const v = veredito(await analisarCedendo(dez, REPO.corpos), true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.filter((l) => l.startsWith('  · '))).toEqual([`  · 10 migration(s) lida(s) < piso ${PISOS.migrations}`]);
  });

  it('corpos vivos não lidos → INDETERMINADO só pelo piso de corpos vivos', () => {
    const v = veredito(analisar(REPO.arquivos, new Map(), VIVOS_PERMITIDOS), true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.filter((l) => l.startsWith('  · '))).toEqual([`  · 0 corpo(s) vivo(s) < piso ${PISOS.corposVivos}`]);
  });

  it('migrations abertas mas sem operador lido → INDETERMINADO só pelo piso de operadores', () => {
    const vazias = REPO.arquivos.map((a) => ({ ...a, fonte: 'SELECT 1;' }));
    const v = veredito(analisar(vazias, REPO.corpos, VIVOS_PERMITIDOS), true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.filter((l) => l.startsWith('  · '))).toEqual([
      `  · 0 operador(es) LIKE lido(s) < piso ${PISOS.operadores} — abriu arquivo, mas não leu operador?`,
    ]);
  });
});
