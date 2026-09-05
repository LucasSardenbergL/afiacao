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

/** A mensagem do erro lançado por `fn` — vazio se não lançou. Para casar a RAZÃO, não só "lançou". */
function msgDoErro(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * O texto de UM ramo do CASE do veredito: do `THEN '<nome>` até o próximo WHEN/END.
 *
 * Ramo isolado, e não `sql.toContain(...)`: o que importa é o que aquele ramo diz — asserção
 * contra o SQL inteiro passa lendo a palavra na VIZINHA e não pega ramo que trocou de mensagem.
 */
function ramoDe(sql: string, nome: string): string {
  const i = sql.indexOf(`THEN '${nome}`);
  expect(i, `ramo ausente: ${nome}`).toBeGreaterThan(-1);
  const resto = sql.slice(i);
  const fim = resto.search(/\n\s*(WHEN|END AS veredito)/);
  return fim === -1 ? resto : resto.slice(0, fim);
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

  it('parte de `esperado` — zero linhas não pode virar "nada a reportar"', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // Todo caminho até a resposta pendura na lista canônica: invertido (partir das respostas), a
    // edge que não respondeu SOME da saída, e sumir lê-se como "nada a reportar".
    expect(sql).toMatch(/FROM esperado e\n/);
    expect(sql).toMatch(/LEFT JOIN ids i ON i\.edge = e\.edge/);
    expect(sql).not.toMatch(/FROM ids\b[\s\S]*JOIN esperado/);
    expect(sql).not.toMatch(/FROM recentes\b[\s\S]*JOIN esperado/);
  });

  it('LEFT JOIN em net._http_response — "não chegou" ≠ "veredito negativo"', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(/LEFT JOIN net\._http_response x ON x\.id = i\.request_id/);
    expect(sql).not.toMatch(/(?<!LEFT )JOIN net\._http_response/);
  });

  it('o ranking é POR EDGE e dentro da janela — nunca "a última resposta que chegou"', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // Controle POSITIVO: sem ele as negativas abaixo passariam medindo um SQL vazio.
    expect(sql).toMatch(/ON x\.id = i\.request_id/);
    // O `ORDER BY … LIMIT 1` que existe é o do LATERAL, correlacionado por `e.edge` e restrito à
    // janela. Um ranking global — sem slug, sem probe, sem janela — daria a resposta de OUTRA edge.
    expect(sql).not.toMatch(/ORDER BY (rr\.)?id DESC\s*\n?\s*LIMIT/i);
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

  it('os 9 ramos de veredito estão nomeados', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    for (const ramo of [
      'INDETERMINADO',
      'AGUARDE',
      'DEPLOY CONFIRMADO',
      'DEPLOY PARCIAL',
      'PRE_SONDA_FONTE',
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

  it('`fonte` AUSENTE e `fonte` = nao-mapeada são ramos SEPARADOS — e ambos antes da confirmação', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // Campo AUSENTE ⇒ bundle anterior ao #1998 (deploy antigo INTEIRO). Campo PRESENTE valendo
    // `nao-mapeada` ⇒ o bundle conhece o campo e o mapa que subiu não tem a edge: aí sim é parcial.
    // O `COALESCE(fonte,'nao-mapeada')` que existia aqui fundia os dois e nomeava a causa ERRADA
    // para o caso mais comum — medido em prod 2026-09-05 nas 5 edges dos request_ids 69377-69381.
    expect(sql).toContain("WHEN NOT (l.corpo ? 'fonte')");
    expect(sql).toContain('PRE_SONDA_FONTE');
    expect(sql).toContain("WHEN l.corpo ->> 'fonte' = 'nao-mapeada'");
    expect(sql).toContain('DEPLOY PARCIAL');
    // e o COALESCE que os fundia não pode voltar
    expect(sql).not.toMatch(/COALESCE\(l\.corpo ->> 'fonte', 'nao-mapeada'\) = 'nao-mapeada'/);
    // A ORDEM é o que impede o falso POSITIVO: depois do CONFIRMADO, nenhum dos dois alcançaria a
    // edge cujo `versao` bate — que é exatamente a assinatura dos dois bundles.
    expect(sql.indexOf('DEPLOY PARCIAL')).toBeLessThan(sql.indexOf("THEN 'DEPLOY CONFIRMADO'"));
    expect(sql.indexOf('PRE_SONDA_FONTE')).toBeLessThan(sql.indexOf("THEN 'DEPLOY CONFIRMADO'"));
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
    // O alias `l.` NÃO é decoração: desde que o LATERAL também casa `probe = 'true'`, a asserção
    // pelo substring solto passava a ser satisfeita pela ocorrência do LATERAL — e o mutante que
    // dispensa o probe do ramo CONFIRMADO SOBREVIVIA (pego pelo mutcheck, 2026-08-30).
    expect(sql).toMatch(/l\.corpo ->> 'probe' = 'true'/);
    expect(sql).toMatch(/l\.corpo ->> 'edge' = l\.edge/);
  });
});

describe('PASSO 2 — acha a linha pelo ECO do slug, sem colar request_id nenhum', () => {
  const raiz = () => fixture({ 'edge-a': 'v1.0-alfa', 'edge-b': 'v2.0-beta' });
  const leitura = (sql: string) => sql.slice(sql.indexOf('-- PASSO 2'));
  /** O corpo do `LEFT JOIN LATERAL (…) s ON true` — onde a linha da edge é ESCOLHIDA. */
  const lateral = (sql: string) => {
    const t = leitura(sql);
    const i = t.indexOf('LEFT JOIN LATERAL (');
    expect(i, 'o PASSO 2 não tem LEFT JOIN LATERAL').toBeGreaterThan(-1);
    return t.slice(i, t.indexOf(') s ON true', i));
  };

  it('casa a resposta pelo ECO do slug — o request_id deixa de ser obrigatório', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(lateral(sql)).toMatch(/corpo ->> 'edge' = e\.edge/);
  });

  it('o casamento EXIGE probe:true — a resposta de CRON ecoa slug e versao SEM probe', () => {
    // Medido em prod 2026-08-30 (psql-ro): `analytics-outbox-drain` gravou 72 respostas em 6h com
    // {"edge":…,"versao":…} e SEM `probe` — é o cron dela, de 5 em 5 min — contra 5 da sonda de
    // `generate-bundle-argument`. Casando só pelo slug, o `LIMIT 1` pega a linha do CRON e o
    // veredito sai 'BUNDLE VELHO' citando a versão CERTA: falso NEGATIVO, redeploy à toa.
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(lateral(sql)).toMatch(/corpo ->> 'probe' = 'true'/);
  });

  it('a janela é CURTA e explícita — sondagem VELHA não vira veredito de agora (#2079)', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(leitura(sql)).toMatch(/created > now\(\) - interval '\d+ minutes'/);
  });

  it('a ordem do LIMIT 1 é TOTAL — `created` EMPATA entre respostas da mesma leva', () => {
    // Prod 2026-08-30: as respostas 64031 e 64032 têm `created` idêntico ao microssegundo. Sem o
    // desempate por id, qual linha o LIMIT 1 devolve é escolha do plano, não do dado.
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(lateral(sql)).toMatch(/ORDER BY rr\.created DESC, rr\.id DESC\s*\n\s*LIMIT 1/);
  });

  it('o LATERAL é CORRELACIONADO por edge — não um "última resposta da janela" global', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a', 'edge-b'] });
    const l = lateral(sql);
    expect(l).toMatch(/= e\.edge/);
    // Um único LIMIT 1, e ele mora DENTRO do lateral: fora dele cortaria a leva a uma edge.
    expect(leitura(sql).match(/LIMIT 1/g)).toHaveLength(1);
  });

  it('`LEFT JOIN LATERAL … ON true` — SEMPRE uma linha por edge esperada, nunca zero', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // Zero linhas seria silêncio AMBÍGUO: lê-se como "nada a reportar", não como "não achei".
    expect(leitura(sql)).toContain(') s ON true');
    expect(leitura(sql)).not.toMatch(/(?<!LEFT )JOIN LATERAL/);
  });

  it('o cast para jsonb é GUARDADO — corpo não-JSON na janela abortaria a query INTEIRA', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const rec = leitura(sql);
    expect(rec).toMatch(/left\(ltrim\(r\.content\), 1\) = '\{'/);
    // O filtro textual vem ANTES do cast — é o que a irmã passiva (pendencias-deploy) já faz.
    expect(rec.indexOf("left(ltrim(r.content), 1) = '{'")).toBeGreaterThan(rec.indexOf('FROM net._http_response r'));
  });

  it('(a) janela SEM linha da edge ⇒ INDETERMINADO — NUNCA "bundle velho"', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const ramo = ramoDe(leitura(sql), 'INDETERMINADO');
    expect(ramo).toContain('INDETERMINADO');
    expect(ramo).not.toContain('BUNDLE VELHO');
    expect(ramo).not.toContain('DEPLOY CONFIRMADO');
  });

  it('(a) INDETERMINADO nomeia as 3 causas que ele NÃO distingue, e como sair delas', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const ramo = ramoDe(leitura(sql), 'INDETERMINADO');
    expect(ramo, 'causa (a): o disparo não rodou').toMatch(/disparo/i);
    expect(ramo, 'causa (b): a resposta ainda não chegou').toMatch(/de novo/i);
    // Causa (c): bundle PRÉ-SENSOR e recusa HTTP respondem SEM eco — são INVISÍVEIS para a busca
    // por slug, e por isso não podem ser lidos como "não saiu nada".
    expect(ramo, 'causa (c): PRE-SENSOR/recusa não ecoam').toMatch(/PRE-SENSOR/);
    expect(ramo, 'a saída da causa (c) é o request_id do PASSO 1').toMatch(/request_id/);
  });

  it('(b) fonte DIVERGENTE ⇒ BUNDLE VELHO — o eco bateu, o fingerprint não', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const senao = leitura(sql).slice(leitura(sql).indexOf("ELSE 'BUNDLE VELHO"));
    expect(senao).toContain("', fonte=' || COALESCE(l.corpo ->> 'fonte', '?')");
    expect(senao).toContain("l.versao_esperada || ' / ' || l.fonte_esperada");
  });

  it('(c) fonte `nao-mapeada` ⇒ DEPLOY PARCIAL, e ANTES do ramo de confirmação', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const t = leitura(sql);
    expect(t).toContain("WHEN l.corpo ->> 'fonte' = 'nao-mapeada'");
    expect(t.indexOf('DEPLOY PARCIAL')).toBeLessThan(t.indexOf("THEN 'DEPLOY CONFIRMADO'"));
  });

  it('(c2) fonte AUSENTE ⇒ PRE_SONDA_FONTE, e o texto NÃO acusa deploy parcial', () => {
    // O ramo tem de NOMEAR a causa certa, não só cair no lugar seguro: "DEPLOY PARCIAL" manda
    // procurar um prompt de deploy que nomeou poucos arquivos, e nesse estado esse prompt não
    // existiu — o bundle inteiro é anterior ao #1998.
    const t = leitura(gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] }));
    const ramo = t.slice(t.indexOf("WHEN NOT (l.corpo ? 'fonte')"), t.indexOf("WHEN l.corpo ->> 'fonte' = 'nao-mapeada'"));
    expect(ramo).toContain('PRE_SONDA_FONTE');
    expect(ramo).toContain('#1998');
    expect(ramo).not.toContain('DEPLOY PARCIAL');
  });

  it('o 401 sem colagem AUTO-DESQUALIFICA o controle — e a mensagem diz a saída', () => {
    // Interação entre a leitura sem colagem e o controle de credencial do #2131: o controle exclui
    // a própria leva por `NOT EXISTS (… ids …)`, e o `ids` agora nasce VAZIO. O 401 sob julgamento
    // entra em `recusas_recentes` e o controle se auto-desqualifica — fail-CLOSED, vira
    // INDETERMINADO. Quem lê precisa saber que a colagem é o que DETERMINA o veredito.
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const ramo = ramoDe(leitura(sql), 'INDETERMINADO — 401');
    expect(ramo).toMatch(/ids/);
    expect(ramo).toMatch(/DETERMINAR/);
    expect(ramo).not.toContain('BUNDLE VELHO');
  });

  it('a colagem do request_id sobrevive como OPCIONAL — e o placeholder segue VÁLIDO', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // Ela deixa de ser exigida, mas não some: é a única saída da causa (c) do INDETERMINADO,
    // porque PRE-SENSOR e recusa HTTP não ecoam o slug e o eco jamais os encontra.
    expect(leitura(sql)).toContain("jsonb_each_text('{}'::jsonb)");
    expect(leitura(sql)).toMatch(/opcional/i);
  });
});

describe('--janela — o guard temporal é configurável, mas fail-CLOSED', () => {
  const raiz = () => fixture({ 'edge-a': 'v1.0-alfa' });

  it('sem a flag, a janela padrão é curta', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain("interval '20 minutes'");
  });

  it('--janela=45 muda o interval emitido', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'], janelaMin: 45 });
    expect(sql).toContain("interval '45 minutes'");
    expect(sql).not.toContain("interval '20 minutes'");
  });

  it('janela larga demais falha ALTO — é o guard do #2079 que ela apagaria', () => {
    expect(() => gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'], janelaMin: 600 })).toThrow(
      /janela/i,
    );
  });

  it('janela zero/negativa falha ALTO — nunca degrada para o padrão', () => {
    for (const min of [0, -5]) {
      expect(() => gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'], janelaMin: min })).toThrow(
        /janela/i,
      );
    }
  });

  it('--janela não-numérica falha ALTO — não vira nome de edge nem interval torto', () => {
    // A asserção casa a mensagem do VALOR, não `/janela/i` solto: antes da flag existir, o parser
    // já lançava "flag desconhecida: --janela=6h", que casaria e faria o teste passar VAZIO.
    expect(msgDoErro(() => parsearArgs(['edge-a', '--janela=6h']))).toMatch(/--janela.*inteiro/i);
    expect(msgDoErro(() => parsearArgs(['edge-a', '--janela']))).toMatch(/--janela.*inteiro/i);
  });

  it('--janela=45 chega em janelaMin pelo parser', () => {
    expect(parsearArgs(['edge-a', '--janela=45']).janelaMin).toBe(45);
    expect(parsearArgs(['edge-a']).janelaMin).toBeUndefined();
  });
});

describe('divisão de trabalho — o founder dispara, o agente lê', () => {
  const raiz = () => fixture({ 'edge-a': 'v1.0-alfa', cara: 'v2.0-beta' });

  it('--so-disparo entrega ao founder SÓ o que precisa de escrita (vault + INSERT)', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'], soDisparo: true });
    expect(sql).toContain('-- PASSO 1');
    expect(sql).toContain('net.http_post(');
    expect(sql).not.toContain('-- PASSO 2');
    expect(sql).not.toContain('net._http_response');
  });

  it('--so-leitura entrega ao AGENTE só o que roda no psql-ro — nada de vault nem http_post', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'], soLeitura: true });
    expect(sql).toContain('-- PASSO 2');
    expect(sql).toContain('net._http_response');
    // `vault.decrypted_secrets` dá `permission denied for schema vault` no claude_ro, e o
    // `net.http_post` dá `cannot execute INSERT in a read-only transaction` (provado 2026-08-30).
    expect(sql).not.toContain('vault.decrypted_secrets');
    expect(sql).not.toContain('net.http_post(');
  });

  it('a numeração dos passos é ABSOLUTA — --so-leitura não renumera o PASSO 2 para 1', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a', 'cara'], caras: ['cara'], soLeitura: true });
    expect(sql).toContain('-- PASSO 2');
    expect(sql).toContain('-- PASSO 4');
    expect(sql).not.toContain('-- PASSO 1');
    expect(sql).not.toContain('-- PASSO 3');
  });

  it('as duas flags juntas falham ALTO — pedir os dois recortes é pedir o SQL inteiro', () => {
    expect(() =>
      gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'], soDisparo: true, soLeitura: true }),
    ).toThrow(/--so-disparo|--so-leitura/);
  });

  it('o parser aceita as duas flags', () => {
    expect(parsearArgs(['edge-a', '--so-disparo']).soDisparo).toBe(true);
    expect(parsearArgs(['edge-a', '--so-leitura']).soLeitura).toBe(true);
    expect(parsearArgs(['edge-a']).soDisparo).toBeUndefined();
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
    expect(caro).toMatch(/FROM esperado e\n/);
    expect(caro).toMatch(/LEFT JOIN ids i ON i\.edge = e\.edge/);
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
