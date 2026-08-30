import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { gerarSqlDaLeva, main, parsearArgs, resolverLeva } from './sonda-versao-sql';

const RAIZ_REPO = join(import.meta.dirname, '..');
const criadas: string[] = [];

afterEach(() => {
  for (const d of criadas.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Repo de mentira com `supabase/config.toml`, um `versao.ts` por edge pedida e o mapa de
 * fingerprints cobrindo TODAS elas — o estado sadio, do qual cada teste sabota UMA coisa.
 */
function fixture(edges: Record<string, string>, ref = 'refdementira000000ab'): string {
  const raiz = mkdtempSync(join(tmpdir(), 'sonda-sql-'));
  criadas.push(raiz);
  mkdirSync(join(raiz, 'supabase', 'functions'), { recursive: true });
  writeFileSync(join(raiz, 'supabase', 'config.toml'), `project_id = "${ref}"\n`);
  for (const [edge, versao] of Object.entries(edges)) escreverVersao(raiz, edge, versao);
  escreverMapaFingerprints(
    raiz,
    Object.fromEntries(Object.keys(edges).map((edge) => [edge, fp(edge)])),
  );
  return raiz;
}

/** Fingerprint de mentira na FORMA que o mapa exige (64 hex), determinístico pela semente. */
function fp(semente: string): string {
  return createHash('sha256').update(semente).digest('hex');
}

/** O mapa do repo de mentira, na MESMA forma que `sonda:fingerprint --write` grava o de verdade. */
function escreverMapaFingerprints(raiz: string, mapa: Record<string, string>): void {
  const dir = join(raiz, 'supabase', 'functions', '_shared');
  mkdirSync(dir, { recursive: true });
  const linhas = Object.entries(mapa).map(
    ([edge, fingerprint]) => `  ${JSON.stringify(edge)}: ${JSON.stringify(fingerprint)},`,
  );
  writeFileSync(
    join(dir, 'sonda-fingerprints.ts'),
    `export const FONTE_SHA256: Record<string, string> = {\n${linhas.join('\n')}\n};\n`,
  );
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

  it('edge com sensor mas FORA do mapa de fingerprints derruba a geração inteira', () => {
    const raiz = fixture({ boa: 'v1.0-sensor-inicial', 'edge-fora-do-mapa': 'v1.0-sensor-inicial' });
    // SABOTAGEM: o mapa perde UMA entrada. Emitir SQL sem o fingerprint dela seria julgar deploy
    // por `versao` sozinho — o falso POSITIVO que este campo existe para impedir.
    escreverMapaFingerprints(raiz, { boa: fp('boa') });
    expect(() => gerarSqlDaLeva({ raiz, edges: ['boa', 'edge-fora-do-mapa'] })).toThrow(
      /edge-fora-do-mapa/,
    );
  });

  it('mapa de fingerprints AUSENTE não degrada para vazio — falha ALTO', () => {
    const raiz = fixture({ boa: 'v1.0-sensor-inicial' });
    rmSync(join(raiz, 'supabase', 'functions', '_shared', 'sonda-fingerprints.ts'));
    expect(() => gerarSqlDaLeva({ raiz, edges: ['boa'] })).toThrow(/boa/);
  });

  it('main devolve 1 e NÃO escreve SQL quando a edge está fora do mapa', () => {
    const raiz = fixture({ boa: 'v1.0-sensor-inicial' });
    escreverMapaFingerprints(raiz, {});
    const saida: string[] = [];
    const erros: string[] = [];
    const codigo = main(['boa'], { raiz, escrever: (t) => saida.push(t), erro: (t) => erros.push(t) });
    expect(codigo).toBe(1);
    expect(saida).toEqual([]);
    expect(erros.join('')).toMatch(/sonda-fingerprints/);
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
    expect(sql).toMatch(/\('edge-a',\s*'v1\.0-alfa',/);
    expect(sql).toMatch(/\('edge-b',\s*'v2\.0-beta',/);
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
    const mapaReal = readFileSync(join(dir, '_shared', 'sonda-fingerprints.ts'), 'utf8');
    for (const edge of edges) {
      const fonte = readFileSync(join(dir, edge, 'versao.ts'), 'utf8');
      const marcador = /export const VERSAO = "([^"]+)"/.exec(fonte)?.[1];
      expect(marcador, `${edge} sem VERSAO legível`).toBeTruthy();
      // Parse INDEPENDENTE do mapa (não o leitor sob teste): senão o mesmo bug passaria nos dois.
      const fingerprint = new RegExp(`^  "${edge}": "([0-9a-f]{64})",$`, 'm').exec(mapaReal)?.[1];
      expect(fingerprint, `${edge} fora de _shared/sonda-fingerprints.ts`).toBeTruthy();
      expect(sql).toContain(`('${edge}', '${marcador}', '${fingerprint}')`);
    }
  });
});

describe('o fingerprint emitido SAI do mapa commitado (falsificação por sabotagem)', () => {
  it('sabotar a entrada do mapa muda o SQL — o fingerprint velho não sobrevive', () => {
    const raiz = fixture({ alvo: 'v1.0-sensor-inicial' });

    const antes = gerarSqlDaLeva({ raiz, edges: ['alvo'] });
    expect(antes).toContain(fp('alvo'));

    // SABOTAGEM: só a ENTRADA DO MAPA muda; o `versao.ts` e o script ficam intactos.
    escreverMapaFingerprints(raiz, { alvo: fp('alvo-SABOTADO') });
    const depois = gerarSqlDaLeva({ raiz, edges: ['alvo'] });

    // Implementação que chuta, cacheia ou IGNORA o fingerprint fica VERMELHA aqui.
    expect(depois).not.toContain(fp('alvo'));
    expect(depois).toContain(fp('alvo-SABOTADO'));
    // Controle: a sabotagem isolou o campo certo — o marcador não se moveu.
    expect(depois).toContain('v1.0-sensor-inicial');
  });

  it('cada edge da leva leva o SEU fingerprint, não o da vizinha', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa', 'edge-b': 'v2.0-beta' });
    const sql = gerarSqlDaLeva({ raiz, edges: ['edge-a', 'edge-b'] });
    expect(sql).toContain(`('edge-a', 'v1.0-alfa', '${fp('edge-a')}')`);
    expect(sql).toContain(`('edge-b', 'v2.0-beta', '${fp('edge-b')}')`);
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

describe('PASSO 2 — a leitura parte da lista CANÔNICA e nomeia os ramos', () => {
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

  it('os 8 ramos de veredito estão nomeados', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    for (const ramo of [
      'SEM ID',
      'AGUARDE',
      'DEPLOY CONFIRMADO',
      'DEPLOY PARCIAL',
      'BUNDLE VELHO',
      'PRE-SENSOR',
      'BUNDLE VELHO (pre-sonda)',
      'INDETERMINADO',
    ]) {
      expect(sql, `ramo ausente: ${ramo}`).toContain(ramo);
    }
  });

  it('a lista canônica carrega o fingerprint, e a saída projeta o que a edge respondeu', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain('esperado(edge, versao_esperada, fonte_esperada)');
    expect(sql).toMatch(/l\.corpo ->> 'fonte'\s+AS fonte_respondida/);
  });

  it('DEPLOY PARCIAL é ramo PRÓPRIO — e vem ANTES do de confirmação', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/COALESCE\(l\.corpo ->> 'fonte', 'nao-mapeada'\) = 'nao-mapeada'/);
    expect(sql).toContain('DEPLOY PARCIAL');
    // A ORDEM é o que impede o falso POSITIVO: depois do CONFIRMADO, este ramo nunca alcançaria a
    // edge cujo `versao` bate — que é exatamente a assinatura do bundle parcial.
    expect(sql.indexOf('DEPLOY PARCIAL')).toBeLessThan(sql.indexOf("THEN 'DEPLOY CONFIRMADO'"));
  });

  it('DEPLOY CONFIRMADO exige o fonte BATENDO — `versao` sozinho não prova deploy verbatim', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/corpo ->> 'fonte' = l\.fonte_esperada/);
  });

  it('o BUNDLE VELHO do ELSE cita os DOIS campos — respondido e esperado', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const senao = sql.slice(sql.indexOf("ELSE 'BUNDLE VELHO"));
    expect(senao).toContain("', fonte=' || COALESCE(l.corpo ->> 'fonte', '?')");
    expect(senao).toContain("l.versao_esperada || ' / ' || l.fonte_esperada");
  });

  it('rejeição (>=400) e execução (200 sem versao) NÃO caem no mesmo ramo', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // O 400 recusou: nada executou → BUNDLE VELHO. Só o 200 sem versao rodou o fluxo real.
    expect(sql).toMatch(/status_code >= 400\s*\n?\s*THEN 'BUNDLE VELHO/);
    expect(sql).toMatch(/THEN 'PRE-SENSOR[^']*RODOU O FLUXO REAL/);
  });

  // ── 401: o único 4xx AMBÍGUO ────────────────────────────────────────────────────────────────
  // Estes 5 guardam a ESTRUTURA (ordem dos WHEN, presença do controle). Quem prova a SEMÂNTICA —
  // que o CASE devolve mesmo o veredito certo, incluindo `NULL > 0` não sendo falso — é
  // `.claude/skills/lovable-deploy-verify/evals/sonda-veredito-401-eval.sh`, que EXECUTA este SQL
  // num Postgres efêmero. Casar string aqui não bastaria: a asserção textual fica verde
  // exatamente quando a ordem dos ramos está errada.
  it('401 tem ramo PRÓPRIO e vem ANTES do 4xx genérico — o ambíguo não herda o confiante', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/l\.status_code = 401/);
    // Um WHEN só alcança o que o anterior não pegou: depois do `>= 400` o ramo do 401 seria
    // inalcançável e o 401 voltaria a sair como 'BUNDLE VELHO' determinado.
    expect(sql.indexOf('l.status_code = 401')).toBeLessThan(sql.indexOf('l.status_code >= 400'));
  });

  it('o fallback do 401 é INDETERMINADO — fail-CLOSED, nunca "bundle velho"', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const iIndeterminado = sql.indexOf("THEN 'INDETERMINADO");
    expect(iIndeterminado).toBeGreaterThan(-1);
    expect(iIndeterminado).toBeLessThan(sql.indexOf('l.status_code >= 400'));
  });

  it('o controle de credencial é cruzado na MESMA consulta — não é recado ao operador', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain('controle_credencial AS (');
    expect(sql).toMatch(/FROM lidas l CROSS JOIN controle_credencial c/);
    expect(sql).toMatch(/count\(\*\) FILTER \(WHERE r\.status_code BETWEEN 200 AND 299\)/);
    expect(sql).toMatch(/count\(\*\) FILTER \(WHERE r\.status_code = 401\)/);
    expect(sql).toMatch(/r\.created > now\(\) - interval '6 hours'/);
  });

  it('o controle não conta a PRÓPRIA leva, e exclui por NOT EXISTS (NOT IN seria NULL-blind)', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM ids i2 WHERE i2\.request_id = r\.id\)/);
    // A trava fechada do bloco caro devolve request_id NULL; `NOT IN` com NULL zeraria o
    // controle inteiro em silêncio, e todo 401 viraria INDETERMINADO por acidente.
    expect(sql).not.toMatch(/r\.id NOT IN \(/);
  });

  it('o veredito determinado do 401 exige PISO de 2xx E zero recusas — amostra rasa não prova', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/c\.ok_recentes >= 10 AND c\.recusas_recentes = 0/);
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
    expect(caro).toContain(`('cara', 'v2.0-beta', '${fp('cara')}')`);
    expect(caro).toMatch(/FROM esperado e\s*\n\s*LEFT JOIN ids i ON i\.edge = e\.edge/);
    expect(caro).not.toContain("('barata', 'v1.0-alfa'");
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
    expect(saida.join('')).toContain(`('edge-a', 'v1.0-alfa', '${fp('edge-a')}')`);
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
