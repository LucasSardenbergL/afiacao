import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { lerCanariasDoRepo } from './canaria-leitor-do-repo';

import {
  CANARIAS,
  conferirSincronia,
  escaparParaFormat,
  fontesDoEsperado,
  gerarSqlDaLeva,
  gerarSqlDasCanarias,
  gitReal,
  guardEfeitoLegado,
  main,
  parsearArgs,
  PISO_CONTROLE_CREDENCIAL,
  resolverCanarias,
  resolverLeva,
  SENTINELA_MAPA,
  type CanariaRegistrada,
  type ExecutorGit,
  type LeitorCanariasDoRepo,
} from './sonda-versao-sql';

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
    const codigo = main(['boa'], {
      raiz,
      escrever: (t) => saida.push(t),
      erro: (t) => erros.push(t),
      git: gitProibido(),
    });
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

  // O default do `net.http_post` é 5s e mata silencioso (CLAUDE.md §armadilhas · docs/agent/sync.md).
  // A asserção ANTERIOR era `/timeout_milliseconds\s*:=\s*\d+/`: ela media a FORMA (existe UM
  // número), não a invariante que o próprio nome promete. `:= 1` e `:= 0` são "explícitos" e são
  // PIORES que o default — matam a sondagem antes de qualquer resposta, e o desfecho é a leitura
  // devolvendo ausência de linha para uma edge que respondeu. MEDIDO 2026-09-07 por mutcheck
  // exploratório (controle+ verde na mesma invocação): 20000→3000, →1 e →0 SOBREVIVIAM.
  // Pinar o valor em 20000 seria fachada: 20s é TUNING, não fronteira — por isso 20000→30000 segue
  // `SOBREVIVE` declarado no .mut. A fronteira é o piso, e é ela que esta asserção pina.
  const DEFAULT_PG_NET_MS = 5000;
  it('timeout_milliseconds é EXPLÍCITO e ACIMA do default de 5s, que mata silencioso', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const m = sql.match(/timeout_milliseconds\s*:=\s*(\d+)\)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(DEFAULT_PG_NET_MS);
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
      'NAO E RESPOSTA DE SONDA',
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
    expect(sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM ids id_leva WHERE id_leva\.request_id = r\.id\)/);
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

describe('o PASSO 1 ESCREVE o passo 2 — o mapa edge→id não passa pela mão de ninguém', () => {
  const raiz = () => fixture({ 'edge-a': 'v1.0-alfa', 'edge-b': 'v2.0-beta' });

  // A classe é a do bloco de UMA edge (docs/historico/sonda-request-id-a-mao.md): identificador
  // transportado à mão troca o alvo em silêncio, e a resposta de cron que ele acerta por acidente
  // tem a assinatura de "bundle velho". Aqui o transporte era o blob `{"edge": id}` inteiro.
  it('o disparo termina devolvendo o passo 2 escrito, numa célula única', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toContain('SELECT format($sonda$');
    expect(sql).toContain('$sonda$, m.ids) AS passo_2_copie_esta_celula');
    expect(sql).toMatch(/mapa AS \(/);
  });

  it('o agregado alimenta o format() — deixou de ser coluna ENTREGUE ao operador', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    // O par continua saindo da MESMA execução que disparou (é isso que impede o id de existir
    // solto); o que sumiu é a coluna que o pedia de volta na mão.
    expect(sql).toContain('jsonb_object_agg(edge, request_id)::text');
    expect(sql).not.toContain('ids_opcionais_passo');
  });

  it('o passo embutido recebe o mapa por %1$L; só o standalone do eco fica com o {}', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const embutido = sql.slice(
      sql.indexOf('SELECT format($sonda$'),
      sql.indexOf('AS passo_2_copie_esta_celula'),
    );
    expect(embutido).toContain('jsonb_each_text(%1$L::jsonb)');
    expect(embutido).not.toContain("jsonb_each_text('{}'::jsonb)");
    expect(sql.slice(sql.indexOf('AS passo_2_copie_esta_celula'))).toContain(
      "jsonb_each_text('{}'::jsonb)",
    );
  });

  it('o bloco CARO escreve o passo 4 e a trava continua sendo CASE, não WHERE', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a', 'edge-b'], caras: ['edge-b'] });
    expect(sql).toContain('AS passo_4_copie_esta_celula');
    expect(sql).toContain("CASE WHEN g.confirmei_o_deploy = 'sim'");
    // O `WHERE guard…` é o teatro que a seção do deploy.md falsificou nos dois sentidos: com a
    // trava fechada o Postgres avalia a projeção do mesmo jeito e o http_post SAI.
    expect(sql).not.toMatch(/WHERE\s+g?\.?confirmei_o_deploy/);
  });

  it('a trava FECHADA embute um mapa de ids NULOS — e isso vira INDETERMINADO, não silêncio', () => {
    // Provado contra prod em 2026-09-06: o passo 3 travado devolve `{"edge-b": null}` e o passo 4
    // escrito por ele responde 1 LINHA dizendo que a trava ficou fechada. Zero linhas se leria
    // como "nada a reportar" — a inversão que o `FROM esperado LEFT JOIN ids` existe para impedir.
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-b'], caras: ['edge-b'] });
    const embutido = sql.slice(sql.indexOf('SELECT format($sonda$'));
    expect(embutido).toContain('FROM esperado e');
    expect(ramoDe(embutido, 'INDETERMINADO —')).toMatch(/trava do passo 3 ficou FECHADA/);
  });

  it('o passo embutido e o standalone julgam pelos MESMOS ramos — nada de drift entre as duas', () => {
    // Os dois textos saem da mesma função, mas com variações condicionais (comentários e três
    // mensagens). Uma variação que apagasse um RAMO deixaria o founder — que recebe o embutido —
    // com um veredito a menos, e o CI verde: os testes de ramo medem o SQL inteiro, onde a versão
    // do eco basta para satisfazê-los.
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const emb = sql.slice(
      sql.indexOf('SELECT format($sonda$'),
      sql.indexOf('AS passo_2_copie_esta_celula'),
    );
    const eco = sql.slice(sql.indexOf('AS passo_2_copie_esta_celula'));
    for (const ramo of [
      'INDETERMINADO —',
      'AGUARDE —',
      'BUNDLE VELHO (pre-sonda) —',
      'PRE-SENSOR —',
      'NAO E RESPOSTA DE SONDA —',
      'PRE_SONDA_FONTE —',
      'DEPLOY PARCIAL —',
      'DEPLOY CONFIRMADO',
    ]) {
      expect(emb, `ramo ausente no passo EMBUTIDO: ${ramo}`).toContain(ramo);
      expect(eco, `ramo ausente no passo do ECO: ${ramo}`).toContain(ramo);
    }
  });

  it('o ramo do id que NÃO é sonda vem ANTES do PRE_SONDA_FONTE', () => {
    // Achado ao falsificar contra prod (resposta 71275, cron da analytics-outbox-drain, que ecoa
    // edge/versao/fonte e não ecoa probe): sem este ramo a linha cai no ELSE e sai 'BUNDLE VELHO'
    // com a versão CERTA. E depois do `? 'fonte'` ela sairia como PRE_SONDA_FONTE, que nomeia
    // "bundle anterior ao #1998" — causa errada, mesma classe de falso negativo.
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const iNaoSonda = sql.indexOf('NAO E RESPOSTA DE SONDA');
    const iPreFonte = sql.indexOf('PRE_SONDA_FONTE');
    expect(iNaoSonda).toBeGreaterThan(-1);
    expect(iNaoSonda).toBeLessThan(iPreFonte);
    expect(ramoDe(sql, 'NAO E RESPOSTA DE SONDA')).toMatch(/probe:true/);
  });

  it('a CONDIÇÃO do ramo é NULL-safe e está colada nele — texto presente não é ramo alcançável', () => {
    // Sem esta asserção o ramo passa a ser texto decorativo: trocar a condição por `false` (ou por
    // um `<>`, que com `probe` AUSENTE vale NULL e nunca dispara) deixa a string no arquivo e a
    // suíte VERDE — a cegueira que o próprio .mut descreve e que só EXECUTANDO se vê. Medido: as
    // duas mutações SOBREVIVIAM antes daqui. `IS DISTINCT FROM` é o operador NULL-safe, e é
    // exatamente o corpo SEM o campo `probe` (o cron) que o ramo precisa alcançar.
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    expect(sql).toMatch(
      /WHEN l\.corpo ->> 'probe' IS DISTINCT FROM 'true'\n\s*THEN 'NAO E RESPOSTA DE SONDA/,
    );
  });
});

describe('escaparParaFormat — as duas armadilhas do format() que o corpus não exercita', () => {
  // O SQL emitido hoje não tem `%` nem `$` (medido). Sem teste DIRETO, as duas proteções ficariam
  // verdes por acidente do corpus — a classe de docs/historico/gates-textuais-cegos.md.
  it('escapa `%` do corpo — senão o format() o lê como diretiva', () => {
    expect(escaparParaFormat('100% do lote')).toBe('100%% do lote');
  });

  it('o placeholder entra DEPOIS do escape — na ordem inversa sairia %%1$L', () => {
    expect(escaparParaFormat(`x ${SENTINELA_MAPA} y`)).toBe('x %1$L y');
    expect(escaparParaFormat(`50% ${SENTINELA_MAPA}`)).toBe('50%% %1$L');
  });

  it('corpo que contenha a tag de dollar-quoting falha ALTO — sairia truncado', () => {
    expect(() => escaparParaFormat('antes $sonda$ depois')).toThrow(/TRUNCADO/);
  });
});

describe('PASSO 2 — acha a linha pelo ECO do slug, sem colar request_id nenhum', () => {
  const raiz = () => fixture({ 'edge-a': 'v1.0-alfa', 'edge-b': 'v2.0-beta' });
  // Desde a migração do #2273 há DOIS textos de passo 2: o que o passo 1 devolve escrito (com o
  // mapa dentro) e o standalone do `--so-leitura` (o do eco). Ancorar em '-- PASSO 2' pegaria o
  // primeiro e mediria o embutido achando que media o do eco — o recorte tem de nomear qual.
  const FIM_DO_FORMAT = 'AS passo_2_copie_esta_celula';
  const leitura = (sql: string) => sql.slice(sql.indexOf(FIM_DO_FORMAT));
  const embutida = (sql: string) =>
    sql.slice(sql.indexOf('SELECT format($sonda$'), sql.indexOf(FIM_DO_FORMAT));
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

  it('o 401 do passo EMBUTIDO não manda colar nada — o mapa já está lá', () => {
    // O texto do eco manda "cole o JSON no ids para DETERMINAR". Repetido no bloco embutido, ele
    // mandaria o operador procurar um campo que não existe mais — e a saída certa ali é outra: o
    // que falta é TRÁFEGO de fundo, não colagem. Provado em prod 2026-09-06 (#2273).
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'] });
    const ramo = ramoDe(embutida(sql), 'INDETERMINADO — 401');
    expect(ramo).not.toMatch(/cole/i);
    expect(ramo).toMatch(/embutido/);
    expect(ramo).toMatch(/TRAFEGO/);
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

  /** O SQL que fica FORA do `format($sonda$…$sonda$)` — ou seja, o que de fato EXECUTA ali. */
  const foraDoFormat = (sql: string) =>
    sql
      .split('$sonda$')
      .filter((_, i) => i % 2 === 0)
      .join('\n');

  it('--so-disparo entrega ao founder SÓ o que EXECUTA escrita — a leitura viaja como TEXTO', () => {
    const sql = gerarSqlDaLeva({ raiz: raiz(), edges: ['edge-a'], soDisparo: true });
    expect(sql).toContain('-- PASSO 1');
    expect(sql).toContain('net.http_post(');
    // Desde o #2278 o passo 2 vai junto, mas como ARGUMENTO de `format()`: dentro do dollar-quoting
    // ele é texto, não consulta. O recorte do founder continua sendo só o que precisa dele — o que
    // não pode aparecer é um bloco de leitura EXECUTÁVEL, fora das aspas.
    const fora = foraDoFormat(sql);
    expect(fora).not.toContain('-- PASSO 2');
    expect(fora).not.toContain('net._http_response');
    // Controle POSITIVO: sem ele as duas negativas acima passariam medindo um recorte vazio (se o
    // split mudasse de tag, por exemplo) — a cegueira de `docs/historico/gates-textuais-cegos.md`.
    expect(sql).toContain('AS passo_2_copie_esta_celula');
    expect(sql).toContain('net._http_response');
    expect(fora.length).toBeGreaterThan(200);
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
    const codigo = main(['edge-a'], {
      raiz,
      escrever: (t) => saida.push(t),
      erro: (t) => erros.push(t),
      git: gitFalso({ main: espelho(raiz, ['edge-a']) }),
    });
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
      git: gitProibido(),
    });
    expect(codigo).toBe(1);
    expect(saida).toEqual([]);
    expect(erros.join('')).toMatch(/orfa/);
  });
});

// ============================================================================================
// GUARD DE SINCRONIA com a `origin/main` (o worktree defasado que vira veredito falso).
// ============================================================================================

/**
 * `git` fabricado: `origin/main` é um SNAPSHOT declarado e o disco é o fixture.
 *
 * O `git` de verdade não entra na suíte de propósito — dependeria de rede, do estado do worktree e
 * do que a main tem HOJE, ou seja, o teste passaria a medir o ambiente em vez do guard. O que a
 * suíte precisa provar é a DECISÃO, e ela é a função pura que consome estas saídas.
 */
function gitFalso(opts: {
  main?: Record<string, string> | null;
  fetchFalha?: boolean;
  chamadas?: string[][];
}): ExecutorGit {
  return (args) => {
    opts.chamadas?.push(args);
    if (args[0] === 'fetch') {
      return opts.fetchFalha === true
        ? { status: 128, stdout: '', stderr: 'fatal: unable to access ...: Could not resolve host' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (opts.main == null) return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abc123def4567890\n', stderr: '' };
    if (args[0] === 'log') return { status: 0, stdout: '2026-09-01 10:00:00 +0000\n', stderr: '' };
    if (args[0] === 'show') {
      const caminho = args[1].slice('origin/main:'.length);
      const conteudo = opts.main[caminho];
      return conteudo === undefined
        ? { status: 128, stdout: '', stderr: `fatal: path '${caminho}' does not exist in 'origin/main'` }
        : { status: 0, stdout: conteudo, stderr: '' };
    }
    return { status: 127, stdout: '', stderr: `git falso não conhece ${args[0]}` };
  };
}

/**
 * O estado SADIO: `origin/main` byte-a-byte igual ao disco, do qual cada teste sabota UMA coisa.
 *
 * Ele parte da PROVENIÊNCIA da leva, e não de uma lista escrita à mão: fixture montado por lista
 * própria concorda com a implementação por coincidência, e passa a discordar em silêncio no dia em
 * que o marcador ganha uma dependência nova — que é o defeito medido em 2026-09-09.
 */
function espelho(raiz: string, edges: string[]): Record<string, string> {
  return Object.fromEntries(
    fontesDoEsperado(resolverLeva(raiz, edges)).map((f) => [f.caminho, f.bytes]),
  );
}

/** `git` que REPROVA se for chamado — prova que um ramo anterior abortou antes do guard. */
function gitProibido(): ExecutorGit {
  return (args) => {
    throw new Error(`o guard de sincronia NÃO devia ter rodado: git ${args.join(' ')}`);
  };
}

function rodar(raiz: string, argv: string[], git: ExecutorGit) {
  const saida: string[] = [];
  const erros: string[] = [];
  const codigo = main(argv, { raiz, escrever: (t) => saida.push(t), erro: (t) => erros.push(t), git });
  return { codigo, saida: saida.join(''), erros: erros.join('') };
}

describe('worktree defasado da origin/main não emite SQL (o falso negativo de 2026-09-05)', () => {
  it('disco IGUAL à origin/main: emite o SQL, e o fetch aconteceu ANTES de comparar', () => {
    const raiz = fixture({ 'edge-a': 'v1.7-enviado-igual-aprovado' });
    const chamadas: string[][] = [];
    const r = rodar(raiz, ['edge-a'], gitFalso({ main: espelho(raiz, ['edge-a']), chamadas }));
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain("('edge-a', 'v1.7-enviado-igual-aprovado'");
    expect(r.erros).toBe('');
    // "Sincronize antes de MEDIR": a comparação contra um remote-tracking ref velho é o MESMO
    // defeito um nível acima, então o fetch é parte da medição — não um recado no doc.
    expect(chamadas[0]).toEqual(['fetch', 'origin', 'main']);
    expect(chamadas.some((c) => c[0] === 'show')).toBe(true);
  });

  it('o CASO MEDIDO: versao.ts do disco atrás da main aborta nomeando a edge e a correção', () => {
    const raiz = fixture({ 'enviar-pedido-portal-sayerlack': 'v1.5-custo-portal-rpc-cas' });
    const main2026 = espelho(raiz, ['enviar-pedido-portal-sayerlack']);
    const arq = 'supabase/functions/enviar-pedido-portal-sayerlack/versao.ts';
    main2026[arq] = main2026[arq].replace('v1.5-custo-portal-rpc-cas', 'v1.7-enviado-igual-aprovado');
    const r = rodar(raiz, ['enviar-pedido-portal-sayerlack'], gitFalso({ main: main2026 }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe(''); // nada de SQL parcial
    expect(r.erros).toContain('enviar-pedido-portal-sayerlack/versao.ts');
    expect(r.erros).toContain('git merge --ff-only origin/main');
    expect(r.erros).toMatch(/Nenhum SQL foi emitido/);
  });

  it('mapa de fingerprints defasado aborta — é metade do `esperado(...)`, não um detalhe', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa' });
    const main = espelho(raiz, ['edge-a']);
    const arq = 'supabase/functions/_shared/sonda-fingerprints.ts';
    main[arq] = main[arq].replace(fp('edge-a'), fp('outra-coisa'));
    const r = rodar(raiz, ['edge-a'], gitFalso({ main }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain('sonda-fingerprints.ts');
  });

  it('bump que ainda NÃO mergeou aborta: a edge no ar não serve marcador só deste branch', () => {
    const raiz = fixture({ nova: 'v1.0-sensor-inicial' });
    const main = espelho(raiz, ['nova']);
    delete main['supabase/functions/nova/versao.ts'];
    const r = rodar(raiz, ['nova'], gitFalso({ main }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain('não existe em origin/main');
  });

  it('só a fatia PEDIDA é conferida — edge fora da leva divergente não trava a leva', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa', 'edge-b': 'v2.0-beta' });
    const main = espelho(raiz, ['edge-a', 'edge-b']);
    main['supabase/functions/edge-b/versao.ts'] = 'export const VERSAO = "v9.9-outra";\n';
    const r = rodar(raiz, ['edge-a'], gitFalso({ main }));
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain("('edge-a', 'v1.0-alfa'");
  });

  it('falha da leva vence o guard — e o guard nem roda (mensagem específica sobrevive)', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa' });
    const r = rodar(raiz, ['edge-a', 'orfa'], gitProibido());
    expect(r.codigo).toBe(1);
    expect(r.erros).toMatch(/orfa/);
    expect(r.erros).toMatch(/sem sensor/);
  });
});

describe('não consigo consultar a origin/main: ausência de dado não é aprovação', () => {
  it('fetch que falha ABORTA e nomeia a escada explícita (--sem-rede), não emite SQL', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa' });
    const r = rodar(raiz, ['edge-a'], gitFalso({ main: espelho(raiz, ['edge-a']), fetchFalha: true }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain('--sem-rede');
    expect(r.erros).toMatch(/Nenhum SQL foi emitido/);
  });

  it('origin/main que não existe aborta mesmo com --sem-rede — não há com o que comparar', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa' });
    const r = rodar(raiz, ['edge-a', '--sem-rede'], gitFalso({ main: null }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toMatch(/não existe neste repo/);
  });

  it('--sem-rede pula o FETCH mas NÃO a comparação: divergência contra o ref em disco aborta', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa' });
    const main = espelho(raiz, ['edge-a']);
    main['supabase/functions/edge-a/versao.ts'] = 'export const VERSAO = "v2.0-ja-mergeada";\n';
    const chamadas: string[][] = [];
    const r = rodar(raiz, ['edge-a', '--sem-rede'], gitFalso({ main, chamadas }));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(chamadas.some((c) => c[0] === 'fetch')).toBe(false);
  });

  it('--sem-rede que BATE emite o SQL, e o SQL CARREGA o aviso (o stderr some, ele não)', () => {
    const raiz = fixture({ 'edge-a': 'v1.0-alfa' });
    const chamadas: string[][] = [];
    const r = rodar(raiz, ['edge-a', '--sem-rede'], gitFalso({ main: espelho(raiz, ['edge-a']), chamadas }));
    expect(r.codigo).toBe(0);
    expect(chamadas.some((c) => c[0] === 'fetch')).toBe(false);
    expect(r.erros).toContain('--sem-rede');
    expect(r.erros).toContain('2026-09-01');
    // Primeira linha do SQL é comentário `--`: o bloco continua colável no SQL Editor e no psql-ro.
    expect(r.saida.startsWith('-- ⚠️ --sem-rede')).toBe(true);
    expect(r.saida).toContain("('edge-a', 'v1.0-alfa'");
  });

  it('--sem-rede é OPT-IN: sem a flag, o parse não a inventa', () => {
    expect(parsearArgs(['edge-a']).semRede).toBeUndefined();
    expect(parsearArgs(['edge-a', '--sem-rede']).semRede).toBe(true);
  });
});

/**
 * Repo git de verdade, base dos fixtures do describe abaixo — cada um decide se a
 * `refs/remotes/origin/main` existe nele.
 *
 * Construído aqui, e não herdado do checkout da sessão, porque essa ref é propriedade do CLONE e
 * não do código sob teste. MEDIDO no job `mutation-check` (run 34006830215): `actions/checkout@v5`
 * sem `fetch-depth: 0` roda `git init` + `fetch --depth=1 origin <sha>:refs/remotes/pull/N/merge`
 * e NÃO cria `origin/main` — `rev-parse --verify --quiet origin/main` sai 1 ali e 0 no worktree do
 * dev. Herdar a ref fazia esta asserção medir o AMBIENTE em vez do executor: verde no worktree e
 * no job `validate` (que pede `fetch-depth: 0` por causa do merge-base do `sonda:bump`), vermelho
 * em qualquer clone raso — e o baseline do mutcheck, que roda no job raso, ficava VERMELHO sem
 * mutação nenhuma, abortando o contrato inteiro (= ausência de medição, não medição).
 *
 * `spawnSync` cru de propósito: montar o fixture com o próprio `gitReal` faria o teste do executor
 * depender do executor.
 */
function repoGitCru(prefixo: string): { repo: string; git: (...args: string[]) => string } {
  const repo = mkdtempSync(join(tmpdir(), prefixo));
  criadas.push(repo);
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`fixture: git ${args.join(' ')} falhou: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  git('init', '-q');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git('add', 'base.txt');
  // Config GLOBAL do hospedeiro não decide o veredito do fixture — é a mesma classe que o #2227
  // tirou daqui (teste afirmando fato do ambiente). `commit.gpgsign=false`: numa máquina com
  // assinatura global ligada o commit pediria passphrase / não acharia a chave e a suíte INTEIRA
  // ficaria vermelha por config. `--no-verify`: hook de pre-commit/commit-msg (inclusive via
  // `core.hooksPath` ou `init.templateDir` globais) não roda no commit do fixture.
  // Mora aqui, no helper COMPARTILHADO do #2243, e não em cada chamador: blinda de uma vez os
  // dois fixtures — o COM a `origin/main` e o SEM ela.
  git(
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-qm',
    'base',
  );
  return { repo, git };
}

/** COM a ref: o chão que o `gitReal` precisa ter sob os pés para devolver o ramo POSITIVO. */
function repoComOriginMain(): { repo: string; sha: string } {
  const { repo, git } = repoGitCru('sonda-git-');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  // O sha SAI do fixture porque a asserção lá embaixo compara contra ELE — ver o porquê no teste.
  return { repo, sha: git('rev-parse', 'HEAD') };
}

/**
 * O MESMO repo, sem o `update-ref` — ou seja, git válido com a `origin/main` AUSENTE. É o estado
 * literal do runner que quebrou o `mutation-check`: `actions/checkout@v5` sem `fetch-depth: 0` faz
 * `git init` + `fetch --depth=1 <sha>:refs/remotes/pull/N/merge`, então o repo EXISTE e a ref não.
 * Fica entre os dois casos que o describe já tinha, e é o único dos três que o `gitFalso` simula
 * (ramo `opts.main == null`, que devolve status 1).
 */
function repoSemOriginMain(): string {
  return repoGitCru('sonda-git-raso-').repo;
}

describe('gitReal: o executor de verdade responde o que o guard precisa julgar', () => {
  it('num repo git, rev-parse da origin/main devolve status 0 e o sha DAQUELE repo', () => {
    const { repo, sha } = repoComOriginMain();
    const r = gitReal(repo)(['rev-parse', '--verify', '--quiet', 'origin/main']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    // "40 hex" sozinho não distingue o repo do FIXTURE de qualquer outro que tenha `origin/main` —
    // e o `gitReal(RAIZ_REPO)` que ficava vermelho em todo PR passa nessa forma frouxa. Comparar
    // com o sha do fixture (a) prova que `cwd: raiz` é honrado no ramo APROVADO, coisa que só o
    // caso "fora de um repo git" abaixo cobria, pelo lado negativo, e (b) deixa VERMELHA em
    // QUALQUER ambiente a volta da ref herdada do checkout — que hoje só ficaria vermelha no job
    // `mutation-check`, silenciosa no local e no `validate`.
    expect(r.stdout.trim()).toBe(sha);
  });

  it('em repo git SEM a ref, status ≠ 0 — é o estado do checkout raso, e o guard tem de fechar', () => {
    const r = gitReal(repoSemOriginMain())(['rev-parse', '--verify', '--quiet', 'origin/main']);
    // O que o `conferirSincronia` lê: `rev.status !== 0` manda no ramo que ABORTA sem emitir SQL.
    // MEDIDO: sem este caso, um `gitReal` que traduzisse 1 (ref ausente) em 0 passava pelos outros
    // dois — o de cima devolve 0 de verdade, o de baixo devolve 128 — e o fail-OPEN saía verde.
    expect(r.status).not.toBe(0);
    // E a MARCA do ramo, não só "≠ 0": `--verify --quiet` sai 1 e CALADO quando só a ref falta,
    // contra 128 + "fatal: not a git repository" do caso abaixo. É esse 1 que o `gitFalso` afirma
    // no ramo `opts.main == null`; sem esta linha o dublê estaria citando o git de memória.
    expect(r.status).toBe(1);
    // O guard também recusa por `rev.stdout.trim() === ''`: aqui não há sha nenhum para inventar.
    expect(r.stdout.trim()).toBe('');
  });

  it('fora de um repo git, status ≠ 0 — o guard cai no ramo fail-CLOSED, não no aprovado', () => {
    const fora = mkdtempSync(join(tmpdir(), 'sonda-sem-git-'));
    criadas.push(fora);
    const r = gitReal(fora)(['rev-parse', '--verify', '--quiet', 'origin/main']);
    expect(r.status).not.toBe(0);
  });
});

const RELE = ['monthly-report', 'calculate-scores', 'sonda-relay'];

describe('guardEfeitoLegado — o último caminho de efeito deixa de ser o padrão', () => {
  it('RECUSA edge da allowlist e oferece o one-liner do relé', () => {
    const r = guardEfeitoLegado(['monthly-report'], false, RELE);
    expect(r).toMatch(/RECUSADO/);
    expect(r).toMatch(/deploy_sonda_disparar\(ARRAY\['monthly-report'\]\)/);
    expect(r).toMatch(/FLUXO REAL/);
  });
  it('edge FORA da allowlist continua liberada — ela não tem caminho seguro ainda', () => {
    expect(guardEfeitoLegado(['omie-sync-estoque'], false, RELE)).toBeNull();
  });
  it('--permitir-efeito-legado libera, e é a única forma de liberar', () => {
    expect(guardEfeitoLegado(['monthly-report'], true, RELE)).toBeNull();
  });
  it('leva MISTA recusa nomeando só as que têm caminho seguro', () => {
    const r = guardEfeitoLegado(['monthly-report', 'omie-sync-estoque'], false, RELE);
    expect(r).toMatch(/monthly-report/);
    expect(r).not.toMatch(/ARRAY\['monthly-report', 'omie-sync-estoque'\]/);
  });
  it('leva vazia não recusa', () => expect(guardEfeitoLegado([], false, RELE)).toBeNull());
});

describe('parsearArgs — a flag do efeito legado', () => {
  it('reconhece --permitir-efeito-legado', () => {
    expect(parsearArgs(['monthly-report', '--permitir-efeito-legado']).permitirEfeitoLegado).toBe(true);
  });
  it('sem a flag, o campo fica indefinido (o guard trata como NÃO permitido)', () => {
    expect(parsearArgs(['monthly-report']).permitirEfeitoLegado).toBeUndefined();
  });
});

// ==========================================================================================
// MODO CANÁRIA
// ==========================================================================================

/**
 * O leitor REAL — literalmente o que a CLI injeta, importado, não recriado.
 *
 * Até esta leva era uma CÓPIA da regra, e cópia da regra é o defeito que o módulo compartilhado
 * existe para impedir: a suíte seguiria verde julgando um leitor que não é o que o operador roda.
 */
const lerCanariasReal: LeitorCanariasDoRepo = lerCanariasDoRepo;

/**
 * Um `index.ts` de mentira que hospeda a canária no arm que a `chave` do registro nomeia.
 *
 * `forma: 'versao'` reproduz a `generate-tactical-plan`: o marcador não é literal, vem por
 * REFERÊNCIA ao símbolo `VERSAO` — e é a forma que o `canaria:bump` só passou a enxergar no #2374.
 */
function corpoDaEdge(chave: string, marcador: string, forma: 'contrato' | 'versao' = 'contrato'): string {
  if (forma === 'versao') {
    return (
      'Deno.serve(async (req) => {\n' +
      '  if (body.canary === true) {\n' +
      '    return json({ canary: true, versao: VERSAO, ok: true });\n' +
      '  }\n' +
      '});\n'
    );
  }
  if (chave.startsWith('case:')) {
    const rota = chave.slice('case:'.length);
    return (
      'Deno.serve(async (req) => {\n' +
      '  const { action } = await req.json();\n' +
      '  switch (action) {\n' +
      `      case "${rota}": {\n` +
      `        result = { canary: true, contrato: "${marcador}", ok: true };\n` +
      '        break;\n' +
      '      }\n' +
      '  }\n' +
      '});\n'
    );
  }
  return (
    'Deno.serve(async (req) => {\n' +
    '  if (ehCanaria(req)) {\n' +
    `    return json({ canary: true, contrato: "${marcador}", ok: true });\n` +
    '  }\n' +
    '});\n'
  );
}

/**
 * Repo de mentira com TODAS as edges do registro `CANARIAS`, cada uma emitindo o marcador que
 * `sobrepor` disser (ou um derivado do nome). Um teste sabota UMA coisa a partir daqui.
 */
function fixtureCanarias(sobrepor: Record<string, string> = {}): string {
  const raiz = mkdtempSync(join(tmpdir(), 'canaria-sql-'));
  criadas.push(raiz);
  mkdirSync(join(raiz, 'supabase', 'functions'), { recursive: true });
  writeFileSync(join(raiz, 'supabase', 'config.toml'), 'project_id = "refdementira000000ab"\n');
  const porEdge = new Map<string, CanariaRegistrada[]>();
  for (const c of CANARIAS) porEdge.set(c.edge, [...(porEdge.get(c.edge) ?? []), c]);
  for (const [edge, lista] of porEdge) {
    const dir = join(raiz, 'supabase', 'functions', edge);
    mkdirSync(dir, { recursive: true });
    const corpo = lista
      .map((c) => corpoDaEdge(c.chave, sobrepor[c.nome] ?? `marcador-de-${c.nome}-v1`, c.campoMarcador))
      .join('\n');
    writeFileSync(join(dir, 'index.ts'), corpo);
    writeFileSync(
      join(dir, 'versao.ts'),
      `export const VERSAO = "${sobrepor[edge] ?? `versao-de-${edge}`}";\n`,
    );
  }
  return raiz;
}

/**
 * Um `git` que ESPELHA o disco: `show origin/main:<x>` devolve o próprio arquivo, então a fatia
 * sai "em dia". O guard de sincronia é assunto do último bloco, e lá o espelho é quebrado de
 * propósito — um fake que devolvesse string vazia diria "em dia" por acidente, não por desenho.
 */
function gitEspelho(raiz: string, divergir: string | null = null): ExecutorGit {
  return (args) => {
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abc123456789\n', stderr: '' };
    if (args[0] === 'show') {
      const caminho = args[1].slice(args[1].indexOf(':') + 1);
      if (divergir !== null && caminho.includes(divergir)) {
        return { status: 0, stdout: '// outro conteúdo\n', stderr: '' };
      }
      try {
        return { status: 0, stdout: readFileSync(join(raiz, caminho), 'utf8'), stderr: '' };
      } catch {
        return { status: 1, stdout: '', stderr: 'no such path' };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

describe('registro de canárias — o marcador SAI do repo, nunca do registro', () => {
  it('contra o repo REAL: toda canária alcançável resolve, e o marcador é o que o index.ts emite', () => {
    const alcancaveis = CANARIAS.filter((c) => c.inalcancavel === null).map((c) => c.nome);
    const leva = resolverCanarias(RAIZ_REPO, alcancaveis, lerCanariasReal);
    expect(leva).toHaveLength(alcancaveis.length);
    for (const c of leva) {
      expect(c.marcador, `${c.nome} sem marcador`).not.toBe('');
      const emitido = lerCanariasReal(RAIZ_REPO, c.edge).canarias.find((e) => e.chave === c.chave);
      expect(emitido, `${c.nome} não está no index.ts em ${c.chave}`).toBeDefined();
      if (c.campoMarcador === 'contrato') {
        expect(emitido?.contrato, `${c.nome} não bate com o index.ts`).toBe(c.marcador);
      } else {
        // Forma por REFERÊNCIA: o index.ts serve o símbolo, e o literal mora no `versao.ts`.
        expect(emitido?.contrato, `${c.nome} deveria servir por referência`).toBeNull();
        expect(emitido?.simbolo).toBe('VERSAO');
        const versaoTs = readFileSync(
          join(RAIZ_REPO, 'supabase', 'functions', c.edge, 'versao.ts'),
          'utf8',
        );
        expect(versaoTs).toContain(`"${c.marcador}"`);
      }
    }
  });

  it('sabotar o index.ts muda o SQL — o marcador velho não sobrevive', () => {
    const raiz = fixtureCanarias({ 'copilot-analyze': 'marcador-SABOTADO-v9' });
    const sql = gerarSqlDasCanarias({
      raiz,
      nomes: ['copilot-analyze'],
      ler: lerCanariasReal,
    });
    expect(sql).toContain("'marcador-SABOTADO-v9'");
    expect(sql).not.toContain('marcador-de-copilot-analyze-v1');
  });

  it('cada canária leva o SEU marcador, não o da vizinha', () => {
    const raiz = fixtureCanarias();
    const sql = gerarSqlDasCanarias({
      raiz,
      nomes: ['copilot-analyze', 'omie-financeiro'],
      ler: lerCanariasReal,
    });
    expect(sql).toContain("('copilot-analyze', 'contrato', 'marcador-de-copilot-analyze-v1'");
    expect(sql).toContain("('omie-financeiro', 'contrato', 'marcador-de-omie-financeiro-v1'");
  });

  it('index.ts que não emite o `contrato` da chave registrada falha ALTO — nada é emitido', () => {
    const raiz = fixtureCanarias();
    writeFileSync(
      join(raiz, 'supabase', 'functions', 'omie-financeiro', 'index.ts'),
      'Deno.serve(() => json({ ok: true }));\n',
    );
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({ raiz, nomes: ['omie-financeiro'], ler: lerCanariasReal }),
    );
    expect(msg).toMatch(/marcador ILEGÍVEL/);
    expect(msg).toMatch(/case:paginacao_probe/);
    expect(msg).toMatch(/Nenhum SQL foi emitido/);
  });

  it('acusa TODAS as canárias tortas de uma vez, não só a primeira', () => {
    const raiz = fixtureCanarias();
    for (const edge of ['omie-financeiro', 'omie-vendas-sync']) {
      writeFileSync(join(raiz, 'supabase', 'functions', edge, 'index.ts'), 'Deno.serve(() => {});\n');
    }
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({
        raiz,
        nomes: ['omie-financeiro', 'omie-vendas-sync'],
        ler: lerCanariasReal,
      }),
    );
    expect(msg).toMatch(/omie-financeiro/);
    expect(msg).toMatch(/omie-vendas-sync/);
  });
});

describe('registro COMPLETO — canária fora dele nunca seria disparada', () => {
  it('contra o repo REAL: nenhuma canária emitida está fora do registro', () => {
    expect(() =>
      resolverCanarias(RAIZ_REPO, ['copilot-analyze'], lerCanariasReal),
    ).not.toThrow();
  });

  it('uma 2ª canária na MESMA edge, sem entrada no registro, derruba a geração', () => {
    const raiz = fixtureCanarias();
    const dir = join(raiz, 'supabase', 'functions', 'omie-financeiro');
    writeFileSync(
      join(dir, 'index.ts'),
      readFileSync(join(dir, 'index.ts'), 'utf8') +
        '\nDeno.serve(async (req) => {\n' +
        '  const { action } = await req.json();\n' +
        '  switch (action) {\n' +
        '      case "nova_probe": {\n' +
        '        result = { canary: true, contrato: "nasceu-fora-da-tabela-v1", ok: true };\n' +
        '        break;\n' +
        '      }\n' +
        '  }\n' +
        '});\n',
    );
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({ raiz, nomes: ['copilot-analyze'], ler: lerCanariasReal }),
    );
    expect(msg).toMatch(/FORA do registro CANARIAS/);
    expect(msg).toMatch(/case:nova_probe/);
    expect(msg).toMatch(/nasceu-fora-da-tabela-v1/);
  });

  it('a `generate-tactical-plan` que PASSAR a emitir `contrato` cobra o registro', () => {
    const raiz = fixtureCanarias();
    writeFileSync(
      join(raiz, 'supabase', 'functions', 'generate-tactical-plan', 'index.ts'),
      corpoDaEdge('if:1', 'agora-emite-contrato-v1', 'contrato'),
    );
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({ raiz, nomes: ['generate-tactical-plan'], ler: lerCanariasReal }),
    );
    expect(msg).toMatch(/trocou de FORMA/);
    expect(msg).toMatch(/agora-emite-contrato-v1/);
    expect(msg).toMatch(/Nenhum SQL foi emitido/);
  });

  it('a que emite LITERAL e PASSAR a servir por referência também cobra — nos dois sentidos', () => {
    const raiz = fixtureCanarias();
    writeFileSync(
      join(raiz, 'supabase', 'functions', 'copilot-analyze', 'index.ts'),
      corpoDaEdge('if:1', 'irrelevante', 'versao'),
    );
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({ raiz, nomes: ['copilot-analyze'], ler: lerCanariasReal }),
    );
    expect(msg).toMatch(/trocou de FORMA/);
    expect(msg).toMatch(/REFERÊNCIA/);
    // Sem esta conferência o registro leria `contrato` (ausente) e diria SEM MARCADOR — causa
    // errada: o bundle está no ar, quem envelheceu foi o registro.
    expect(msg).not.toMatch(/marcador ILEGÍVEL/);
  });

  it('a forasteira servida por REFERÊNCIA também é varrida — o pré-filtro é `canary:true`', () => {
    // O pré-filtro por texto cru decide QUEM entra na varredura, e filtrar pela palavra `contrato`
    // deixaria de fora exatamente a 8ª canária: a `generate-tactical-plan` serve o marcador em
    // `versao`, por referência, e não tem a palavra `contrato` em lugar nenhum do arquivo. Uma 2ª
    // canária nela nunca seria disparada, e a leva sairia verde sobre 7 de 8 — a cegueira que o
    // #2374 fechou no gate, aqui dentro da ferramenta. MEDIDO 2026-09-08: trocar o pré-filtro por
    // `/contrato/` SOBREVIVIA à suíte de então, porque as duas fixtures de forasteira usavam
    // edges que emitem `contrato`.
    const raiz = fixtureCanarias();
    const dir = join(raiz, 'supabase', 'functions', 'generate-tactical-plan');
    const bruto = readFileSync(join(dir, 'index.ts'), 'utf8');
    expect(bruto, 'a fixture precisa ser CEGA a `contrato` para medir o pré-filtro').not.toContain('contrato');
    writeFileSync(join(dir, 'index.ts'), `${bruto}\n${bruto.replace('versao: VERSAO', 'versao: SEGUNDA_VERSAO')}`);
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({ raiz, nomes: ['copilot-analyze'], ler: lerCanariasReal }),
    );
    expect(msg).toMatch(/FORA do registro CANARIAS/);
    expect(msg).toMatch(/if:2/);
    expect(msg).toMatch(/SEGUNDA_VERSAO/);
  });

  it('símbolo que não é o `VERSAO` fica FORA do alcance, e o gerador DIZ isso', () => {
    const raiz = fixtureCanarias();
    writeFileSync(
      join(raiz, 'supabase', 'functions', 'generate-tactical-plan', 'index.ts'),
      'Deno.serve(async (req) => {\n' +
        '  if (body.canary === true) {\n' +
        '    return json({ canary: true, versao: OUTRO_SIMBOLO, ok: true });\n' +
        '  }\n' +
        '});\n',
    );
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({ raiz, nomes: ['generate-tactical-plan'], ler: lerCanariasReal }),
    );
    expect(msg).toMatch(/OUTRO_SIMBOLO/);
    expect(msg).toMatch(/só `VERSAO` é resolvível/);
  });
});

describe('o CORPO do disparo é POR CANÁRIA — corpo errado cai no FLUXO REAL', () => {
  const sqlReal = () =>
    gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: [], ler: lerCanariasReal });

  it('as quatro formas da tabela do deploy.md saem no VALUES, cada uma na sua linha', () => {
    const sql = sqlReal();
    expect(sql).toContain(`('copilot-analyze', 'copilot-analyze', '{"canary": true}'::jsonb, '')`);
    expect(sql).toContain(
      `('omie-vendas-sync', 'omie-vendas-sync', '{"action": "identidade_probe"}'::jsonb, '')`,
    );
    expect(sql).toContain(
      `('omie-analytics-sync:transferencia_probe', 'omie-analytics-sync', '{"action": "transferencia_probe"}'::jsonb, '')`,
    );
    expect(sql).toContain(`('carteira-rebuild', 'carteira-rebuild', '{}'::jsonb, '?canary=1')`);
  });

  it('a URL concatena o sufixo — sem isso a carteira-rebuild roda o rebuild REAL', () => {
    expect(sqlReal()).toContain("/functions/v1/' || a.edge || a.sufixo");
  });

  it('o corpo vem da LINHA, não de um jsonb_build_object fixo', () => {
    const sql = sqlReal();
    expect(sql).toContain('body := a.corpo');
    expect(sql).not.toContain("body := jsonb_build_object('canary'");
  });

  // Mede o PISO, não o número: 20s é TUNING e o `.mut` declara 20000→30000 como SOBREVIVE.
  // Pinar o literal aqui reprovaria um ajuste legítimo — a fronteira é o default de 5s do pg_net,
  // que mata silencioso (é a mesma lição da asserção irmã da sonda, algumas centenas de linhas
  // acima; ela foi aprendida por mutcheck e esta cópia nasceu ignorando-a).
  it('timeout_milliseconds é EXPLÍCITO e acima do default de 5s, que mata silencioso', () => {
    const m = sqlReal().match(/timeout_milliseconds\s*:=\s*(\d+)\)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(5000);
  });

  it('o segredo sai do vault, nunca do texto colado', () => {
    expect(sqlReal()).toContain('vault.decrypted_secrets');
  });
});

describe('a trava das CARAS vem do registro, não da memória de quem chama', () => {
  it('as que caem em fluxo real caro saem em bloco COM trava, e as baratas sem', () => {
    const sql = gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: [], ler: lerCanariasReal });
    const [passo1, passo3] = sql.split('-- PASSO 3');
    expect(passo1).not.toContain('confirmei_o_deploy');
    expect(passo1).toContain("('copilot-analyze'");
    expect(passo3).toContain("confirmei_o_deploy = 'sim'");
    expect(passo3).toContain("('carteira-rebuild'");
    expect(passo3).toContain("('generate-tactical-plan'");
    expect(passo3).not.toContain("('copilot-analyze', 'copilot-analyze'");
  });

  it('o bloco caro NOMEIA o efeito de cada canária, não diz só "é caro"', () => {
    const sql = gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: [], ler: lerCanariasReal });
    expect(sql).toMatch(/carteira-rebuild: rebuild REAL da carteira/);
    expect(sql).toMatch(/generate-tactical-plan: plano tatico com LLM/);
  });

  it('a canária CARA não aparece no bloco SEM trava — senão o passo 1 dispara o fluxo real', () => {
    // A asserção irmã acima mede a trava DENTRO do bloco caro; esta mede a PARTIÇÃO, e são coisas
    // diferentes. MEDIDO 2026-09-08: `const baratas = leva` (a partição desligada) SOBREVIVIA —
    // as caras continuavam saindo no bloco 3 com trava, e passavam também no bloco 1, que não tem
    // trava nenhuma. O founder colaria o passo 1 e o rebuild REAL da carteira rodaria ali mesmo.
    const sql = gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: [], ler: lerCanariasReal });
    const passo1 = sql.slice(0, sql.indexOf('-- PASSO 3'));
    const caras = CANARIAS.filter((c) => c.fluxoRealSeVelho && c.inalcancavel === null);
    expect(caras.length, 'sem canária cara o teste passaria por vacuidade').toBeGreaterThan(0);
    for (const c of caras) {
      expect(passo1, `canária CARA no bloco sem trava: ${c.nome}`).not.toContain(`('${c.nome}', '${c.edge}'`);
    }
    // Controle positivo: o bloco 1 existe e leva as baratas — senão o `not.toContain` acima
    // ficaria verde por o recorte estar vazio.
    expect(passo1).toContain("('copilot-analyze', 'copilot-analyze'");
  });

  it('a trava é CASE, não filtro — filtro deixaria o http_post sair igual', () => {
    const sql = gerarSqlDasCanarias({
      raiz: RAIZ_REPO,
      nomes: ['carteira-rebuild'],
      ler: lerCanariasReal,
    });
    expect(sql).toContain("CASE WHEN g.confirmei_o_deploy = 'sim'");
    expect(sql).not.toContain("WHERE g.confirmei_o_deploy = 'sim'");
  });
});

describe('a canária inalcançável pelo SQL Editor é RECUSADA, não sondada', () => {
  it('pedir a analyze-unified-order explica o gate e manda para o app logado', () => {
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({
        raiz: RAIZ_REPO,
        nomes: ['analyze-unified-order'],
        ler: lerCanariasReal,
      }),
    );
    expect(msg).toMatch(/gate de staff/);
    expect(msg).toMatch(/Governança → Auditoria/);
    expect(msg).toMatch(/Nenhum SQL foi emitido/);
  });

  it('a leva PADRÃO (sem nomes) não a inclui — 401 dela se leria como bundle velho', () => {
    const sql = gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: [], ler: lerCanariasReal });
    expect(sql).not.toContain("('analyze-unified-order'");
  });
});

describe('PASSO 2 da canária — o julgamento exige os TRÊS campos', () => {
  const sql = () => gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: [], ler: lerCanariasReal });

  it('a leitura NASCE dentro do format() do disparo — não existe versão sem mapa', () => {
    const s = sql();
    expect(s).toContain('SELECT format($sonda$');
    // `jsonb_each_text('{}')` é o modo ECO da sonda; aqui ele significaria toda linha
    // INDETERMINADA, porque a resposta da canária não ecoa o slug.
    expect(s).not.toContain("jsonb_each_text('{}'::jsonb)");
    expect(s).toContain('jsonb_each_text(%1$L::jsonb)');
  });

  it('CANARIA VERDE exige canary + marcador + ok, os três', () => {
    const ramo = ramoDe(sql(), 'CANARIA VERDE');
    const antes = sql().slice(0, sql().indexOf("THEN 'CANARIA VERDE"));
    const cond = antes.slice(antes.lastIndexOf("WHEN ca.corpo ->> 'canary' = 'true'"));
    expect(cond).toContain("ca.corpo ->> 'canary' = 'true'");
    expect(cond).toContain('ca.corpo ->> ca.campo_marcador = ca.marcador_esperado');
    expect(cond).toContain("ca.corpo ->> 'ok' = 'true'");
    expect(ramo).toContain('CANARIA VERDE');
  });

  it('a leitura parte da lista CANÔNICA — zero linhas não pode virar "nada a reportar"', () => {
    expect(sql()).toContain('WITH esperado(nome, campo_marcador, marcador_esperado, efeito) AS (VALUES');
    expect(sql()).toContain('FROM esperado esp');
  });

  it('desce no envelope `data` — a omie-analytics-sync responde aninhado', () => {
    expect(sql()).toContain("COALESCE(resp.content::jsonb -> 'data', resp.content::jsonb)");
  });

  it('os ramos que separam BUNDLE VELHO de CANARIA VERMELHA estão todos nomeados', () => {
    const s = sql();
    for (const marca of [
      'INDETERMINADO',
      'AGUARDE',
      'SEM CANARIA NO AR',
      'CANARIA SEM MARCADOR',
      'CANARIA DE OUTRA FATIA',
      'CANARIA SEM VEREDITO',
      'CANARIA VERMELHA',
      'CANARIA VERDE',
    ]) {
      expect(s, `ramo ausente: ${marca}`).toContain(`THEN '${marca}`);
    }
  });

  it('o 200 sem eco DIZ que rodou o fluxo real, e diz QUAL efeito', () => {
    const ramo = ramoDe(sql(), 'SEM CANARIA NO AR — HTTP');
    expect(ramo).toContain('RODOU O FLUXO REAL');
    expect(ramo).toContain("|| ca.efeito ||");
    expect(ramo).toContain('NAO e canaria vermelha');
  });

  it('bundle velho e canária vermelha DIZEM que não são a mesma coisa', () => {
    expect(ramoDe(sql(), 'SEM CANARIA NO AR — 401')).toContain('NAO e canaria vermelha');
    expect(ramoDe(sql(), 'CANARIA VERMELHA')).toContain('NAO e deploy pendente');
    expect(ramoDe(sql(), 'CANARIA DE OUTRA FATIA')).toContain('PRECISA DEPLOY');
  });

  it('o eco é julgado ANTES do status — a 500 da generate-tactical-plan é vermelha, não recusa', () => {
    const s = sql();
    const eco = s.indexOf("WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca.status_code >= 400");
    const statusCru = s.indexOf('WHEN ca.status_code >= 400');
    expect(eco).toBeGreaterThan(-1);
    // Não existe ramo que julgue o status sem antes exigir a ausência do eco.
    expect(statusCru).toBe(-1);
  });

  it('o campo do marcador é POR CANÁRIA — a generate-tactical-plan serve em `versao`', () => {
    const s = sql();
    expect(s).toContain("('generate-tactical-plan', 'versao', ");
    expect(s).toContain("('copilot-analyze', 'contrato', ");
    expect(s).toContain('ca.corpo ->> ca.campo_marcador');
  });

  it('cada ramo tem a CONDIÇÃO colada nele — ramo sem condição é texto decorativo', () => {
    // A cegueira que o `.mut` da sonda já nomeia, agora medida aqui: asserção que só procura o
    // TEXTO do ramo (`toContain("THEN 'CANARIA VERMELHA")`) fica verde com a condição trocada por
    // `false` — a string continua no arquivo e o ramo nunca dispara. MEDIDO 2026-09-08: com a
    // suíte de então, neutralizar `CANARIA DE OUTRA FATIA`, `CANARIA VERMELHA`, o ramo do 200 sem
    // eco e o do id ausente SOBREVIVIA às 4 asserções de ramo deste describe. `IS DISTINCT FROM`
    // é o operador NULL-safe, e é exatamente o corpo SEM o campo (bundle velho) que os ramos do
    // eco precisam alcançar: com `<>` a comparação vale NULL e o ramo fica inalcançável.
    const s = sql();
    const pares: ReadonlyArray<readonly [RegExp, string]> = [
      [/WHEN ca\.request_id IS NULL\n\s*THEN 'INDETERMINADO — esta canaria nao tem request_id/, 'id ausente no mapa'],
      [/WHEN ca\.status_code IS NULL\n\s*THEN 'AGUARDE/, 'sem resposta HTTP ainda'],
      [
        /WHEN ca\.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca\.status_code = 401\n\s*AND cred\.ok_recentes >= \d+ AND cred\.recusas_recentes = 0\n\s*THEN 'SEM CANARIA NO AR — 401/,
        '401 com o controle de credencial',
      ],
      [
        /WHEN ca\.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca\.status_code = 401\n\s*THEN 'INDETERMINADO — 401 nao separa/,
        '401 sem controle observado',
      ],
      [
        /WHEN ca\.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca\.status_code >= 400\n\s*THEN 'SEM CANARIA NO AR — o bundle recusou/,
        '4xx/5xx sem eco',
      ],
      [
        /WHEN ca\.corpo ->> 'canary' IS DISTINCT FROM 'true'\n\s*THEN 'SEM CANARIA NO AR — HTTP/,
        '200 sem eco (o que RODOU O FLUXO REAL)',
      ],
      [/WHEN ca\.corpo ->> ca\.campo_marcador IS NULL\n\s*THEN 'CANARIA SEM MARCADOR/, 'sem o campo do marcador'],
      [
        /WHEN ca\.corpo ->> ca\.campo_marcador IS DISTINCT FROM ca\.marcador_esperado\n\s*THEN 'CANARIA DE OUTRA FATIA/,
        'marcador divergente (a armadilha 2 do deploy.md)',
      ],
      [/WHEN ca\.corpo ->> 'ok' IS NULL\n\s*THEN 'CANARIA SEM VEREDITO/, 'sem o ok'],
      [/WHEN ca\.corpo ->> 'ok' = 'false'\n\s*THEN 'CANARIA VERMELHA/, 'ok:false (regressão de verdade)'],
    ];
    for (const [re, rotulo] of pares) {
      expect(s, `ramo sem condição colada: ${rotulo}`).toMatch(re);
    }
  });

  it('os JOINs da leitura são LEFT — canária sem id ou sem resposta sai INDETERMINADA, não SOME', () => {
    // Mesma invariante das duas mutações irmãs da sonda, na leitura da canária: `INNER` encolhe a
    // lista canônica em silêncio, e a linha que some é justamente a da canária cuja trava ficou
    // fechada (request_id NULL) ou cuja resposta ainda não chegou. Ausência de LINHA não pode
    // apagar a canária do relatório — o ramo INDETERMINADO existe para dizer isso.
    const s = sql();
    expect(s).toContain('LEFT JOIN ids mp ON mp.nome = esp.nome');
    expect(s).toContain('LEFT JOIN net._http_response resp ON resp.id = mp.request_id');
    // Varredura: nenhum JOIN pelado abrindo linha em lugar nenhum do SQL da canária.
    expect(s).not.toMatch(/\n\s*JOIN /);
  });

  it('a janela do guard temporal é a PEDIDA, e a mensagem cita o MESMO número', () => {
    // O guard do #2079 vale igual aqui: a célula do passo 2 sobrevive num chat e, colada amanhã,
    // julgaria o deploy de hoje pela resposta de ontem. A backreference cola o `interval` à
    // mensagem — sem ela, um `interval '30 days'` com o texto dizendo "janela de 20 min" passa.
    const padrao = gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: ['copilot-analyze'], ler: lerCanariasReal });
    expect(padrao).toMatch(
      /interval '(\d+) minutes'\n\s*THEN 'INDETERMINADO — a resposta e de ' \|\| ca\.created \|\| ', FORA da janela de \1 min/,
    );
    const larga = gerarSqlDasCanarias({
      raiz: RAIZ_REPO,
      nomes: ['copilot-analyze'],
      janelaMin: 45,
      ler: lerCanariasReal,
    });
    expect(larga).toContain("WHEN ca.created <= now() - interval '45 minutes'");
    expect(msgDoErro(() =>
      gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: ['copilot-analyze'], janelaMin: 999, ler: lerCanariasReal }),
    )).toMatch(/janela/);
  });

  it('o controle de credencial não conta a PRÓPRIA leva — e chega na projeção pelo CROSS JOIN', () => {
    // A mecânica é a da sonda, e cada peça responde por uma falha diferente: `NOT EXISTS` sobre a
    // leva impede que a própria sondagem avalize o CRON_SECRET; `recusas_recentes = 0` faz um 401
    // ALHEIO desqualificar o veredito confiante; e sem o CROSS JOIN o `cred` não existe na
    // projeção — o veredito determinado do 401 vira erro de coluna, ou some.
    const s = sql();
    expect(s).toContain('AND NOT EXISTS (SELECT 1 FROM ids id_leva WHERE id_leva.request_id = r.id)');
    expect(s).toContain('FROM lidas ca CROSS JOIN controle_credencial cred');
    expect(s).toMatch(
      /AND cred\.ok_recentes >= \d+ AND cred\.recusas_recentes = 0\n\s*THEN 'SEM CANARIA NO AR — 401/,
    );
  });

  it('o piso do controle é a CONSTANTE — zerá-lo deixaria UMA resposta 2xx provar a credencial', () => {
    // As asserções acima casam `>= \d+`, que aceita `>= 0`. Com piso zero UMA resposta 2xx já
    // "prova" a credencial — o oposto do que o controle existe para fazer, e o gate de mutação
    // não via a diferença. Referenciar a constante importada mantém a asserção viva quando o
    // piso for ajustado, em vez de pedir edição de teste a cada tuning.
    const s = sql();
    expect(s).toContain(`cred.ok_recentes >= ${PISO_CONTROLE_CREDENCIAL}`);
    expect(s).not.toMatch(/cred\.ok_recentes >= 0\b/);
  });

  it('401 sem controle observado permanece INDETERMINADO — nunca veredito confiante', () => {
    // O fail-CLOSED do 401 ambíguo: sem controle de credencial provado, 401 não separa
    // bundle-sem-canária de CRON_SECRET inválido. Trocar este THEN por um veredito confiante
    // é fail-open — e nenhuma asserção da suíte pegava a troca.
    expect(sql()).toMatch(/THEN 'INDETERMINADO — 401 nao separa bundle sem canaria/);
  });
});

describe('CLI do modo canária — as flags sem sentido são RECUSADAS, não ignoradas', () => {
  it('--canaria muda o significado dos posicionais', () => {
    const a = parsearArgs(['--canaria', 'omie-analytics-sync:doc_ambiguo_probe']);
    expect(a.canaria).toBe(true);
    expect(a.edges).toEqual(['omie-analytics-sync:doc_ambiguo_probe']);
  });

  it('sem --canaria o campo fica indefinido (o modo sonda segue o padrão)', () => {
    expect(parsearArgs(['copilot-analyze']).canaria).toBeUndefined();
  });

  it('--so-leitura é recusado: sem o mapa toda linha sairia INDETERMINADA', () => {
    const msg = msgDoErro(() => parsearArgs(['--canaria', '--so-leitura']));
    expect(msg).toMatch(/NÃO ecoa o slug/);
  });

  it('--caro é recusado: quem é caro está no registro, não na memória de quem chama', () => {
    const msg = msgDoErro(() => parsearArgs(['--canaria', '--caro=carteira-rebuild']));
    expect(msg).toMatch(/fluxoRealSeVelho/);
  });

  it('--so-disparo é recusado: em modo canária tudo o que se emite já é disparo', () => {
    expect(msgDoErro(() => parsearArgs(['--canaria', '--so-disparo']))).toMatch(/--so-disparo/);
  });

  it('canária repetida na leva é recusada — linha duplicada dispara duas vezes', () => {
    const msg = msgDoErro(() => parsearArgs(['--canaria', 'copilot-analyze', 'copilot-analyze']));
    expect(msg).toMatch(/canária repetida/);
  });

  it('nome com `:` passa (é canária), e nome fora do registro sai com a LISTA das opções', () => {
    expect(parsearArgs(['--canaria', 'omie-analytics-sync:transferencia_probe']).edges).toHaveLength(1);
    const msg = msgDoErro(() =>
      gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: ['copilot-analise'], ler: lerCanariasReal }),
    );
    expect(msg).toMatch(/canária desconhecida: copilot-analise/);
    expect(msg).toMatch(/copilot-analyze/);
  });

  it('--canaria sem leitor injetado RECUSA — marcador digitado é a via do veredito falso', () => {
    const saida: string[] = [];
    const erros: string[] = [];
    const rc = main(['--canaria', 'copilot-analyze'], {
      raiz: RAIZ_REPO,
      escrever: (t) => saida.push(t),
      erro: (t) => erros.push(t),
      git: gitEspelho(RAIZ_REPO),
    });
    expect(rc).toBe(1);
    expect(saida).toHaveLength(0);
    expect(erros.join('\n')).toMatch(/sem leitor de canárias/);
  });

  it('main --canaria escreve o SQL e devolve 0', () => {
    const saida: string[] = [];
    const rc = main(['--canaria', 'copilot-analyze'], {
      raiz: RAIZ_REPO,
      escrever: (t) => saida.push(t),
      erro: () => {},
      git: gitEspelho(RAIZ_REPO),
      lerCanarias: lerCanariasReal,
    });
    expect(rc).toBe(0);
    expect(saida.join('')).toContain('AS veredito');
  });

  it('o guard de sincronia vale IGUAL aqui — disco fora da main NÃO emite SQL', () => {
    const saida: string[] = [];
    const erros: string[] = [];
    const rc = main(['--canaria', 'copilot-analyze'], {
      raiz: RAIZ_REPO,
      escrever: (t) => saida.push(t),
      erro: (t) => erros.push(t),
      git: gitEspelho(RAIZ_REPO, 'copilot-analyze'),
      lerCanarias: lerCanariasReal,
    });
    expect(rc).toBe(1);
    expect(saida).toHaveLength(0);
    expect(erros.join('\n')).toMatch(/DESSINCRONIZADO/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A FATIA DA VERDADE DEPENDE DO MODO — e acompanha quem RESOLVE o marcador.
//
// MEDIDO EM 2026-09-09, contra o repo real, com a CLI de verdade:
//
//   · SUB-inclusão (o furo): o marcador da canária sai do literal `contrato: "..."` no `index.ts`
//     da edge, e esse arquivo NÃO estava na fatia. Trocando `tudo-ou-nada-normalizar-v1` por
//     `FABRICADO-NAO-MERGEADO-v9` no working tree, `--canaria copilot-analyze --sem-rede` saiu
//     `exit 0`, com 9 545 bytes de SQL carregando o marcador FABRICADO, e zero menção a
//     DESSINCRONIZADO. A canária no ar responderia o contrato ANTIGO, o veredito sairia
//     `CANARIA DE OUTRA FATIA`, e isso se lê como deploy pendente — a MESMA classe de veredito
//     falso do incidente de 2026-09-05 que este guard existe para fechar.
//
//   · SOBRE-inclusão: o modo canária não lê o mapa de fingerprints — `grep -c -i fingerprint` nos
//     ~20 KB de SQL emitido por `--canaria copilot-analyze omie-analytics-sync:doc_ambiguo_probe
//     omie-financeiro generate-tactical-plan --sem-rede` deu 0. Conferir arquivo que não participa
//     do resultado não fecha veredito falso nenhum: só produz bloqueio (e o `sonda:fingerprint`
//     EXIGE regravar esse mapa quando qualquer `_shared/` muda, então o bloqueio é rotina).
//
// O teste que existia antes desta leva passava por ACIDENTE: `gitEspelho(RAIZ_REPO,
// 'copilot-analyze')` diverge todo caminho que CONTÉM o nome, e pegava o `versao.ts` — que, para
// uma canária de `campoMarcador: 'contrato'`, não alimenta o `esperado(...)`. Divergência no
// arquivo irrelevante, cegueira no que decide. Por isso os testes abaixo nomeiam o caminho EXATO.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** `git` espelho da `raiz`, divergindo nos caminhos EXATOS pedidos (nunca por substring). */
function gitDivergindoEm(raiz: string, divergentes: string[]): ExecutorGit {
  const alvo = new Set(divergentes);
  return (args) => {
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abc123456789\n', stderr: '' };
    if (args[0] === 'log') return { status: 0, stdout: '2026-09-01 10:00:00 +0000\n', stderr: '' };
    if (args[0] === 'show') {
      const caminho = args[1].slice(args[1].indexOf(':') + 1);
      if (alvo.has(caminho)) return { status: 0, stdout: '// outro conteúdo\n', stderr: '' };
      try {
        return { status: 0, stdout: readFileSync(join(raiz, caminho), 'utf8'), stderr: '' };
      } catch {
        return { status: 1, stdout: '', stderr: 'no such path' };
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

/** Roda a CLI contra o repo REAL, com o leitor de canárias de verdade. Devolve o que ela emitiu. */
function rodarCli(argv: string[], git: ExecutorGit) {
  const saida: string[] = [];
  const erros: string[] = [];
  const codigo = main(argv, {
    raiz: RAIZ_REPO,
    escrever: (t) => saida.push(t),
    erro: (t) => erros.push(t),
    git,
    lerCanarias: lerCanariasReal,
  });
  return { codigo, saida: saida.join(''), erros: erros.join('\n') };
}

const IDX = (edge: string) => `supabase/functions/${edge}/index.ts`;
const VER = (edge: string) => `supabase/functions/${edge}/versao.ts`;
const MAPA = 'supabase/functions/_shared/sonda-fingerprints.ts';

describe('modo canária: a fatia SEGUE o `index.ts`, que é de onde o marcador sai', () => {
  it('CONTROLE: espelho fiel emite o SQL — a suíte não é sempre-vermelha', () => {
    const r = rodarCli(['--canaria', 'copilot-analyze'], gitDivergindoEm(RAIZ_REPO, []));
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('AS veredito');
  });

  it('o FURO de 2026-09-09: `contrato:` fora da main não emite SQL', () => {
    const r = rodarCli(
      ['--canaria', 'copilot-analyze'],
      gitDivergindoEm(RAIZ_REPO, [IDX('copilot-analyze')]),
    );
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe(''); // ZERO bytes: nada de SQL parcial
    expect(r.erros).toMatch(/DESSINCRONIZADO/);
    expect(r.erros).toContain(IDX('copilot-analyze'));
  });

  it('`index.ts` que só existe NESTE branch aborta — a edge no ar não hospeda essa canária', () => {
    const git: ExecutorGit = (args) => {
      if (args[0] === 'show' && args[1].endsWith(IDX('copilot-analyze'))) {
        return { status: 128, stdout: '', stderr: "fatal: path ... does not exist in 'origin/main'" };
      }
      return gitDivergindoEm(RAIZ_REPO, [])(args);
    };
    const r = rodarCli(['--canaria', 'copilot-analyze'], git);
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain('não existe em origin/main');
  });

  it('a canária que serve por REFERÊNCIA leva o `versao.ts` junto — é de lá que o literal sai', () => {
    const r = rodarCli(
      ['--canaria', 'generate-tactical-plan'],
      gitDivergindoEm(RAIZ_REPO, [VER('generate-tactical-plan')]),
    );
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain(VER('generate-tactical-plan'));
  });

  it('cada canária confere o SEU `index.ts`: o da vizinha divergente não trava a leva', () => {
    const r = rodarCli(
      ['--canaria', 'copilot-analyze'],
      gitDivergindoEm(RAIZ_REPO, [IDX('omie-financeiro')]),
    );
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('AS veredito');
  });

  it('canária de `contrato` NÃO leva o `versao.ts`: ele não alimenta o marcador dela', () => {
    // O par do teste acima. Sem ESTE, "a fatia acompanha o marcador" passaria com a fatia velha
    // (que leva o `versao.ts` de toda edge) — e a sobre-inclusão seguiria de pé no modo canária.
    const r = rodarCli(
      ['--canaria', 'copilot-analyze'],
      gitDivergindoEm(RAIZ_REPO, [VER('copilot-analyze')]),
    );
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('AS veredito');
  });

  it('o mapa de fingerprints NÃO entra: o SQL da canária não carrega fingerprint nenhum', () => {
    const r = rodarCli(['--canaria', 'copilot-analyze'], gitDivergindoEm(RAIZ_REPO, [MAPA]));
    expect(r.codigo).toBe(0);
    // A razão POSITIVA de o mapa poder sair: ele não alimenta o `esperado(...)` desta leva.
    expect(r.saida.toLowerCase()).not.toContain('fingerprint');
    expect(r.saida).toContain('AS veredito');
  });

  it('confere os BYTES que a geração usou, não uma segunda leitura do disco', () => {
    // O parecer Codex de 2026-09-09: enquanto o gerador lê os arquivos e o guard lê de novo, há uma
    // CORRIDA entre as duas leituras — o `esperado(...)` sai de uma e a aprovação vem da outra.
    // Aqui o leitor devolve bytes que o disco não tem (como se o arquivo tivesse sido regravado
    // entre as duas), e a `origin/main` é o disco, fiel. Guard que relesse o disco acharia tudo
    // igual e aprovaria; guard que confere o que atravessou o marcador RECUSA.
    const regravadoDepois: LeitorCanariasDoRepo = (raiz, edge) => {
      const real = lerCanariasReal(raiz, edge);
      if (edge !== 'copilot-analyze') return real;
      return { ...real, fonte: { ...real.fonte, bytes: `${real.fonte.bytes}// gravado depois\n` } };
    };
    const saida: string[] = [];
    const erros: string[] = [];
    const rc = main(['--canaria', 'copilot-analyze'], {
      raiz: RAIZ_REPO,
      escrever: (t) => saida.push(t),
      erro: (t) => erros.push(t),
      git: gitDivergindoEm(RAIZ_REPO, []),
      lerCanarias: regravadoDepois,
    });
    expect(rc).toBe(1);
    expect(saida.join('')).toBe('');
    expect(erros.join('\n')).toContain(IDX('copilot-analyze'));
  });

  it('o MESMO arquivo lido com bytes diferentes na mesma execução aborta — a corrida acontecendo', () => {
    // `omie-analytics-sync` hospeda DUAS canárias, então o `index.ts` dela é lido duas vezes numa
    // leva que peça as duas. Se as leituras discordarem, escolher uma é escolher qual metade do
    // veredito é a verdadeira — e a escolha seria silenciosa.
    let n = 0;
    const instavel: LeitorCanariasDoRepo = (raiz, edge) => {
      const real = lerCanariasReal(raiz, edge);
      if (edge !== 'omie-analytics-sync') return real;
      n += 1;
      return { ...real, fonte: { ...real.fonte, bytes: `${real.fonte.bytes}// leitura ${n}\n` } };
    };
    const saida: string[] = [];
    const erros: string[] = [];
    const rc = main(
      ['--canaria', 'omie-analytics-sync:doc_ambiguo_probe', 'omie-analytics-sync:transferencia_probe'],
      {
        raiz: RAIZ_REPO,
        escrever: (t) => saida.push(t),
        erro: (t) => erros.push(t),
        git: gitDivergindoEm(RAIZ_REPO, []),
        lerCanarias: instavel,
      },
    );
    expect(rc).toBe(1);
    expect(saida.join('')).toBe('');
    expect(erros.join('\n')).toMatch(/bytes DIFERENTES dentro desta execução/);
    expect(erros.join('\n')).toContain(IDX('omie-analytics-sync'));
  });

  it('fatia VAZIA aborta: não ter conferido nada não é ter conferido e aprovado', () => {
    // A porta que fecha o modo NOVO que esquecer de registrar proveniência. Sem ela, o guard vira
    // decorativo em silêncio — e silêncio, aqui, se lê como "o disco está na main".
    const msg = msgDoErro(() => conferirSincronia([], false, gitDivergindoEm(RAIZ_REPO, [])));
    expect(msg).toMatch(/fatia VAZIA/);
    expect(msg).toMatch(/Nenhum SQL foi emitido/);
  });

  it('no modo SONDA o mesmo mapa divergente segue abortando — lá ele É metade do esperado', () => {
    const r = rodarCli(['copilot-analyze'], gitDivergindoEm(RAIZ_REPO, [MAPA]));
    expect(r.codigo).toBe(1);
    expect(r.saida).toBe('');
    expect(r.erros).toContain(MAPA);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// O TRANSPORTE compartilhado (headers + segredo + timeout), depois que `httpPost` virou uma cópia
// só. Antes desta extração a chamada era duplicada (sonda × canária) e os HEADERS não tinham UMA
// asserção nas duas suítes (medido 2026-09-08: `grep -c 'x-cron-secret'` no teste = 0). O drift que
// isso permitia se lê como o CONTRÁRIO do que é: header errado ⇒ 401 só na leva ⇒ o
// `controle_credencial` (que mede tráfego de FORA da leva) segue verde ⇒ sai `BUNDLE VELHO
// (pre-sonda)` / `SEM CANARIA NO AR` CONFIANTE ⇒ redeploy à toa de edge que já estava no ar.
//
// Varre TODAS as chamadas, não a primeira: o SQL tem `net.http_post` no bloco BARATO e no CARO, e
// `toContain` sobre o texto inteiro fica verde com uma ocorrência correta escondendo outra quebrada
// (ressalva do parecer Codex de 2026-09-08). O `.mut` ancora nestas invariantes.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('transporte do disparo — os headers valem para os DOIS modos por construção', () => {
  /** Cada `net.http_post(...)` do SQL, do `net.http_post(` até o `timeout_milliseconds := N)`. */
  const chamadas = (sql: string): string[] =>
    Array.from(sql.matchAll(/net\.http_post\([\s\S]*?timeout_milliseconds := \d+\)/g), (m) => m[0]);

  const DEFAULT_PG_NET_MS = 5000;
  // Os dois modos com os DOIS blocos presentes: na sonda o caro nasce de `caras`, na canária das
  // canárias marcadas `fluxoRealSeVelho` (a leva inteira tem pelo menos uma). A leva da sonda leva
  // uma edge barata E uma cara porque MEDI que `separar()` só emite o bloco barato quando sobra
  // alguma barata: com `edges` e `caras` iguais o SQL sai com UMA chamada só, e um teste que
  // varresse só ela ficaria verde ignorando o bloco caro — aquele onde um bundle pré-sensor cria
  // PO de verdade no Omie.
  const sqlSonda = () =>
    gerarSqlDaLeva({
      raiz: RAIZ_REPO,
      edges: ['analytics-outbox-drain', 'carteira-rebuild'],
      caras: ['carteira-rebuild'],
    });
  const sqlCanaria = () => gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: [], ler: lerCanariasReal });

  // Denominador explícito: as asserções abaixo varrem TODAS as chamadas, então elas ficariam verdes
  // por AUSÊNCIA se o gerador parasse de emitir o bloco caro. Este teste é o que impede — ele fixa
  // que há DUAS chamadas para varrer (barata + cara), e é o controle dos dois `it.each` seguintes.
  it('os dois modos emitem chamada no bloco BARATO e no CARO — há 2 para varrer, não 1', () => {
    expect(chamadas(sqlSonda())).toHaveLength(2);
    expect(chamadas(sqlCanaria())).toHaveLength(2);
  });

  it.each([
    ['sonda', sqlSonda],
    ['canária', sqlCanaria],
  ])('%s: TODA chamada manda o header x-cron-secret com o segredo do vault', (_nome, gerar) => {
    const todas = chamadas(gerar());
    expect(todas.length).toBeGreaterThan(0);
    for (const c of todas) {
      expect(c).toContain("'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets");
      expect(c).toContain("WHERE name = 'CRON_SECRET' LIMIT 1)");
      expect(c).toContain("'Content-Type', 'application/json'");
      // O segredo sai do vault, nunca colado no texto: nada de literal parecendo credencial.
      expect(c).not.toMatch(/x-cron-secret'\s*,\s*'[^']/);
    }
  });

  it.each([
    ['sonda', sqlSonda],
    ['canária', sqlCanaria],
  ])('%s: TODA chamada tem timeout EXPLÍCITO acima do default de 5s', (_nome, gerar) => {
    const todas = chamadas(gerar());
    expect(todas.length).toBeGreaterThan(0);
    for (const c of todas) {
      const m = c.match(/timeout_milliseconds := (\d+)\)/);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThan(DEFAULT_PG_NET_MS);
    }
  });

  // O que a extração NÃO pode ter unificado: url e corpo são o alvo, e trocá-los troca o que roda.
  it('o alvo continua distinto — a canária leva sufixo e corpo da linha; a sonda, probe fixo', () => {
    for (const c of chamadas(sqlSonda())) {
      expect(c).toContain("|| a.edge,");
      expect(c).toContain("body := jsonb_build_object('probe', true)");
    }
    for (const c of chamadas(sqlCanaria())) {
      expect(c).toContain('|| a.edge || a.sufixo,');
      expect(c).toContain('body := a.corpo');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// O CTE `controle_credencial`, depois que virou uma cópia só. A cópia da canária tinha nascido SEM
// as asserções que dão sentido aos números (medido 2026-09-08: `BETWEEN 200 AND 299`, `= 401` e
// `interval '6 hours'` eram pinados só no bloco da sonda — na cópia, `BETWEEN 200 AND 499` ou
// `interval '6 days'` PASSAVA). Agora a mecânica é uma só e estas asserções valem nos dois modos.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('controle de credencial — a mecânica é a MESMA nos dois modos', () => {
  const sqlSonda = () => gerarSqlDaLeva({ raiz: RAIZ_REPO, edges: ['carteira-rebuild'] });
  const sqlCanaria = () => gerarSqlDasCanarias({ raiz: RAIZ_REPO, nomes: [], ler: lerCanariasReal });

  it.each([
    ['sonda', sqlSonda],
    ['canária', sqlCanaria],
  ])('%s: conta 2xx e 401 na janela de 6h, e exclui a própria leva por NOT EXISTS', (_n, gerar) => {
    const sql = gerar();
    expect(sql).toContain('controle_credencial AS (');
    expect(sql).toMatch(/count\(\*\) FILTER \(WHERE r\.status_code BETWEEN 200 AND 299\) AS ok_recentes/);
    expect(sql).toMatch(/count\(\*\) FILTER \(WHERE r\.status_code = 401\)\s+AS recusas_recentes/);
    expect(sql).toMatch(/r\.created > now\(\) - interval '6 hours'/);
    expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM ids id_leva WHERE id_leva.request_id = r.id)');
    // `NOT IN` com o request_id NULL da trava fechada é NULL-blind e zeraria o controle inteiro.
    expect(sql).not.toMatch(/r\.id NOT IN \(/);
  });

  // O que a extração NÃO unificou, e não pode unificar: cada modo DETERMINA o seu veredito, com o
  // seu alias e a sua prosa. Unificar isto seria transformar dois julgamentos distintos num só.
  it('o veredito do 401 continua SEPARADO — alias, gatilho e desfecho de cada modo', () => {
    expect(sqlSonda()).toMatch(/c\.ok_recentes >= \d+ AND c\.recusas_recentes = 0\n\s*THEN 'BUNDLE VELHO \(pre-sonda\)/);
    expect(sqlCanaria()).toMatch(/cred\.ok_recentes >= \d+ AND cred\.recusas_recentes = 0\n\s*THEN 'SEM CANARIA NO AR/);
  });
});
