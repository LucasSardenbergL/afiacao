import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { gerarSqlDaLeva, main, parsearArgs, resolverLeva } from './sonda-versao-sql';

const RAIZ_REPO = join(import.meta.dirname, '..');
const criadas: string[] = [];

afterEach(() => {
  for (const d of criadas.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Repo de mentira com `supabase/config.toml` + um `versao.ts` por edge pedida. */
function fixture(edges: Record<string, string>, ref = 'refdementira000000ab'): string {
  const raiz = mkdtempSync(join(tmpdir(), 'sonda-sql-'));
  criadas.push(raiz);
  mkdirSync(join(raiz, 'supabase', 'functions'), { recursive: true });
  writeFileSync(join(raiz, 'supabase', 'config.toml'), `project_id = "${ref}"\n`);
  for (const [edge, versao] of Object.entries(edges)) escreverVersao(raiz, edge, versao);
  return raiz;
}

function escreverVersao(raiz: string, edge: string, versao: string): void {
  const dir = join(raiz, 'supabase', 'functions', edge);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'versao.ts'),
    'export { classificarSonda } from "../_shared/sonda-versao.ts";\n' +
      `export const VERSAO = "${versao}";\n`,
  );
}

describe('edge sem sensor não é sondável — falha ALTO, nunca SQL parcial', () => {
  it('lança nomeando a edge cujo versao.ts não existe', () => {
    const raiz = fixture({ 'edge-com-sensor': 'v1.0-sensor-inicial' });
    expect(() => resolverLeva(raiz, ['edge-com-sensor', 'edge-sem-sensor'])).toThrow(
      /edge-sem-sensor/,
    );
  });

  it('acusa TODAS as edges sem sensor de uma vez, não só a primeira', () => {
    const raiz = fixture({ boa: 'v1.0-sensor-inicial' });
    let msg = '';
    try {
      resolverLeva(raiz, ['boa', 'orfa-a', 'orfa-b']);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/orfa-a/);
    expect(msg).toMatch(/orfa-b/);
  });

  it('versao.ts que existe mas não declara VERSAO também falha ALTO', () => {
    const raiz = fixture({});
    const dir = join(raiz, 'supabase', 'functions', 'sem-marcador');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'versao.ts'), 'export const EFEITO = "nada";\n');
    expect(() => resolverLeva(raiz, ['sem-marcador'])).toThrow(/sem-marcador/);
  });

  it('uma edge órfã impede o SQL INTEIRO — nada é emitido para as boas', () => {
    const raiz = fixture({ boa: 'v1.0-sensor-inicial' });
    expect(() => gerarSqlDaLeva({ raiz, edges: ['boa', 'orfa'] })).toThrow(/orfa/);
  });
});

describe('o marcador emitido SAI do versao.ts (falsificação por sabotagem)', () => {
  it('sabotar o arquivo muda o SQL — o marcador velho não sobrevive', () => {
    const raiz = fixture({ alvo: 'v9.9-marcador-original' });

    const antes = gerarSqlDaLeva({ raiz, edges: ['alvo'] });
    expect(antes).toContain('v9.9-marcador-original');

    // SABOTAGEM: só o ARQUIVO muda; o script não é tocado.
    escreverVersao(raiz, 'alvo', 'v0.0-SABOTADO');
    const depois = gerarSqlDaLeva({ raiz, edges: ['alvo'] });

    // Implementação que chuta/cacheia o marcador fica VERMELHA aqui.
    expect(depois).not.toContain('v9.9-marcador-original');
    expect(depois).toContain('v0.0-SABOTADO');
  });

  it('cada edge da leva leva o SEU marcador, não o da vizinha', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa', 'edge-b': 'v2.0-beta' });
    const sql = gerarSqlDaLeva({ raiz, edges: ['edge-a', 'edge-b'] });
    expect(sql).toMatch(/\('edge-a',\s*'v1\.0-alfa'\)/);
    expect(sql).toMatch(/\('edge-b',\s*'v2\.0-beta'\)/);
  });

  it('contra o repo REAL: o marcador emitido é o do arquivo, para toda edge instrumentada', () => {
    const dir = join(RAIZ_REPO, 'supabase', 'functions');
    const edges = readdirSync(dir).filter((e) => {
      try {
        readFileSync(join(dir, e, 'versao.ts'), 'utf8');
        return true;
      } catch {
        return false;
      }
    });
    expect(edges.length).toBeGreaterThan(10); // controle: a varredura achou o conjunto real

    const sql = gerarSqlDaLeva({ raiz: RAIZ_REPO, edges });
    for (const edge of edges) {
      const fonte = readFileSync(join(dir, edge, 'versao.ts'), 'utf8');
      const marcador = /export const VERSAO = "([^"]+)"/.exec(fonte)?.[1];
      expect(marcador, `${edge} sem VERSAO legível`).toBeTruthy();
      expect(sql).toContain(`('${edge}', '${marcador}')`);
    }
  });
});

describe('PASSO 1 — dispara a leva numa tacada', () => {
  const raiz = () => fixture({ 'edge-a': 'v1.0-alfa', 'edge-b': 'v2.0-beta' });

  it('dispara com net.http_post sobre um VALUES de nomes', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a', 'edge-b'] });
    expect(sql).toContain('net.http_post(');
    expect(sql).toMatch(/alvos\(edge\) AS \(VALUES/);
    expect(sql).toMatch(/\('edge-a'\),\n\s*\('edge-b'\)/);
  });

  it('agrega id e edge na MESMA execução, em célula única — o id nunca viaja sozinho', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain('jsonb_object_agg(edge, request_id)::text');
  });

  it('timeout_milliseconds é EXPLÍCITO — o default de 5s mata silencioso', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/timeout_milliseconds\s*:=\s*\d+/);
  });

  it('o corpo pede a SONDA, não o fluxo real', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain("jsonb_build_object('probe', true)");
  });

  it('o segredo sai do vault, nunca do texto colado', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain('vault.decrypted_secrets');
    expect(sql).toContain("name = 'CRON_SECRET'");
  });

  it('a URL usa o project_id do supabase/config.toml, não um ref chutado', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain('https://refdementira000000ab.supabase.co/functions/v1/');
  });
});

describe('PASSO 2 — a leitura parte da lista CANÔNICA e nomeia os 5 ramos', () => {
  const raiz = () => fixture({ 'edge-a': 'v1.0-alfa' });

  it('parte de `esperado` e LEFT JOIN nos ids — zero linhas não pode virar "nada a reportar"', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/FROM esperado e\s*\n\s*LEFT JOIN ids i ON i\.edge = e\.edge/);
    expect(sql).not.toMatch(/FROM ids\b[\s\S]*JOIN esperado/);
  });

  it('LEFT JOIN em net._http_response — "não chegou" ≠ "veredito negativo"', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/LEFT JOIN net\._http_response r ON r\.id = i\.request_id/);
    expect(sql).not.toMatch(/(?<!LEFT )JOIN net\._http_response/);
  });

  it('lê pelo request_id — nunca `ORDER BY id DESC LIMIT 1` nem id de EXEMPLO', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // Controle POSITIVO: sem ele as duas negativas abaixo passariam medindo um SQL vazio.
    expect(sql).toMatch(/ON r\.id = i\.request_id/);
    expect(sql).not.toMatch(/ORDER BY id DESC/i);
    expect(sql).not.toMatch(/WHERE\s+r?\.?id\s*=\s*\d+/i);
  });

  it('o placeholder do bloco que LÊ é sintaticamente VÁLIDO', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain("jsonb_each_text('{}'::jsonb)");
    expect(sql).not.toMatch(/'<[A-Z_]+>'::jsonb/);
  });

  it('desce no envelope `data` — a omie-analytics-sync responde aninhado', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/COALESCE\(r\.content::jsonb -> 'data', r\.content::jsonb\)/);
  });

  it('os 5 ramos de veredito estão nomeados', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    for (const ramo of ['SEM ID', 'AGUARDE', 'DEPLOY CONFIRMADO', 'BUNDLE VELHO', 'PRE-SENSOR']) {
      expect(sql, `ramo ausente: ${ramo}`).toContain(ramo);
    }
  });

  it('rejeição (>=400) e execução (200 sem versao) NÃO caem no mesmo ramo', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // O 400 recusou: nada executou → BUNDLE VELHO. Só o 200 sem versao rodou o fluxo real.
    expect(sql).toMatch(/status_code >= 400\s*\n?\s*THEN 'BUNDLE VELHO/);
    expect(sql).toMatch(/THEN 'PRE-SENSOR[^']*RODOU O FLUXO REAL/);
  });

  it('DEPLOY CONFIRMADO exige o eco probe:true E a edge que respondeu, não só a versao', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/corpo ->> 'probe' = 'true'/);
    expect(sql).toMatch(/corpo ->> 'edge' = l\.edge/);
  });
});

describe('subconjunto CARO — a trava é CASE, nunca WHERE', () => {
  const raiz = () => fixture({ barata: 'v1.0-alfa', cara: 'v2.0-beta' });
  const blocoCaro = (sql: string) => sql.slice(sql.indexOf('-- PASSO 3'));

  it('sem --caro não existe bloco de trava — nada de passo inútil', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['barata', 'cara'] });
    expect(sql).not.toContain('-- PASSO 3');
    expect(sql).not.toContain('confirmei_o_deploy');
  });

  it('a edge cara NÃO viaja no bloco barato — o disparo dela é separado', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['barata', 'cara'], caras: ['cara'] });
    const barato = sql.slice(0, sql.indexOf('-- PASSO 3'));
    expect(barato).toContain("('barata')");
    expect(barato).not.toContain("('cara')");
    expect(blocoCaro(sql)).toContain("('cara')");
  });

  it('o http_post do bloco caro está DENTRO de um CASE', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['barata', 'cara'], caras: ['cara'] });
    expect(blocoCaro(sql)).toMatch(
      /CASE WHEN g\.confirmei_o_deploy = 'sim'\s*\n?\s*THEN net\.http_post\(/,
    );
  });

  it('a trava NÃO é um WHERE — o Postgres avaliaria a projeção e o post sairia igual', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['barata', 'cara'], caras: ['cara'] });
    const caro = blocoCaro(sql);
    // Controle: o guard existe mesmo neste bloco (senão o `not.toMatch` abaixo passa por vazio).
    expect(caro).toContain('confirmei_o_deploy');
    expect(caro).not.toMatch(/WHERE[^\n]*confirmei_o_deploy/i);
  });

  it('a trava nasce FECHADA', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['barata', 'cara'], caras: ['cara'] });
    expect(blocoCaro(sql)).toMatch(/guard\(confirmei_o_deploy\) AS \(VALUES \('nao'\)\)/);
  });

  it('o bloco caro tem leitura própria, com a lista canônica das caras', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['barata', 'cara'], caras: ['cara'] });
    const caro = blocoCaro(sql);
    expect(caro).toContain('-- PASSO 4');
    expect(caro).toContain("('cara', 'v2.0-beta')");
    expect(caro).toMatch(/FROM esperado e\s*\n\s*LEFT JOIN ids i ON i\.edge = e\.edge/);
    expect(caro).not.toContain("('barata', 'v1.0-alfa')");
  });

  it('--caro de edge fora da leva falha ALTO — o typo mandaria a cara para o bloco barato', () => {
    expect(() =>
      gerarSqlDaLeva({ raiz: raiz(), edges: ['barata', 'cara'], caras: ['cra'] }),
    ).toThrow(/cra/);
  });

  it('leva 100% cara não emite bloco barato vazio', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['cara'], caras: ['cara'] });
    expect(sql).not.toContain('-- PASSO 1');
    expect(sql).toContain('-- PASSO 3');
  });
});

describe('CLI', () => {
  it('posicionais são a leva; sem --caro, nenhuma é cara', () => {
    expect(parsearArgs(['edge-a', 'edge-b'])).toEqual({ edges: ['edge-a', 'edge-b'], caras: [] });
  });

  it('--caro=a,b marca o subconjunto, e repetir a flag acumula', () => {
    expect(parsearArgs(['a', 'b', 'c', '--caro=a,b'])).toEqual({
      edges: ['a', 'b', 'c'],
      caras: ['a', 'b'],
    });
    expect(parsearArgs(['a', 'b', '--caro=a', '--caro=b']).caras).toEqual(['a', 'b']);
  });

  it('--caro a (com espaço) também marca', () => {
    expect(parsearArgs(['a', 'b', '--caro', 'a']).caras).toEqual(['a']);
  });

  it('leva vazia falha ALTO em vez de emitir SQL sem alvo', () => {
    expect(() => parsearArgs([])).toThrow(/uso/i);
  });

  it('flag desconhecida falha ALTO — não vira nome de edge', () => {
    expect(() => parsearArgs(['a', '--carro=a'])).toThrow(/--carro/);
  });

  it('edge repetida falha ALTO — linha duplicada no VALUES é sonda paga duas vezes', () => {
    expect(() => parsearArgs(['a', 'b', 'a'])).toThrow(/\ba\b/);
  });

  it('nome fora da forma de edge é recusado — nada de ../ nem aspas', () => {
    expect(() => parsearArgs(['../../etc/passwd'])).toThrow(/passwd|forma/i);
    expect(() => parsearArgs(["a'; DROP"])).toThrow(/forma/i);
  });

  it('main devolve 0 e escreve o SQL na saída', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa' });
    const saida: string[] = [];
    const erros: string[] = [];
    const codigo = main(['edge-a'], { raiz, escrever: (t) => saida.push(t), erro: (t) => erros.push(t) });
    expect(codigo).toBe(0);
    expect(saida.join('')).toContain("('edge-a', 'v1.0-alfa')");
    expect(erros).toEqual([]);
  });

  it('main devolve 1 e NÃO escreve SQL quando a leva tem edge sem sensor', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa' });
    const saida: string[] = [];
    const erros: string[] = [];
    const codigo = main(['edge-a', 'orfa'], {
      raiz,
      escrever: (t) => saida.push(t),
      erro: (t) => erros.push(t),
    });
    expect(codigo).toBe(1);
    expect(saida).toEqual([]);
    expect(erros.join('')).toMatch(/orfa/);
  });
});
