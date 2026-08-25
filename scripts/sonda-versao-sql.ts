#!/usr/bin/env bun
/**
 * sonda-versao-sql.ts — GERA o SQL de sondagem de versão de uma leva de edges.
 * ============================================================================================
 *
 * A receita (e as armadilhas que a moldaram) é `docs/agent/deploy.md`
 * §"Sondar VÁRIAS edges numa tacada (leva inteira)". Este script é a receita EXECUTÁVEL.
 *
 * POR QUE EXISTE: o SQL era digitado à mão a cada leva, e a lista `esperado(edge, versao_esperada)`
 * transcrita dos `versao.ts` na unha. Um marcador digitado errado produz VEREDITO FALSO — "BUNDLE
 * VELHO" numa edge que está no ar (e o desfecho é redeployar edge de money-path à toa), ou a falsa
 * impressão de deploy confirmado. A fonte da verdade já está no repo; o script a lê.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Uma edge da leva, com o marcador lido do `versao.ts` dela. */
export interface EdgeSondada {
  edge: string;
  versao: string;
}

/** Caminho do `versao.ts` de uma edge, a partir da raiz do repo. */
function caminhoVersao(raiz: string, edge: string): string {
  return join(raiz, 'supabase', 'functions', edge, 'versao.ts');
}

/**
 * Extrai o literal de `export const VERSAO = "..."`.
 *
 * Estrito de propósito: template literal, concatenação ou `VERSAO` computado devolvem `null` e
 * viram falha ALTA. Emitir um marcador ADIVINHADO é exatamente o veredito falso que o script
 * existe para impedir.
 */
export function extrairVersao(fonte: string): string | null {
  const m = /^\s*export\s+const\s+VERSAO\s*=\s*(["'])(.*?)\1\s*;?\s*$/m.exec(fonte);
  return m ? m[2] : null;
}

/**
 * Resolve a leva inteira ou LANÇA — nunca devolve lista parcial.
 *
 * Acusa TODAS as edges problemáticas de uma vez: quem pediu 10 edges quer saber quais 3 faltam,
 * não descobrir uma por execução.
 */
export function resolverLeva(raiz: string, edges: string[]): EdgeSondada[] {
  const semSensor: string[] = [];
  const semMarcador: string[] = [];
  const resolvidas: EdgeSondada[] = [];

  for (const edge of edges) {
    let fonte: string;
    try {
      fonte = readFileSync(caminhoVersao(raiz, edge), 'utf8');
    } catch {
      semSensor.push(edge);
      continue;
    }
    const versao = extrairVersao(fonte);
    if (versao === null) semMarcador.push(edge);
    else resolvidas.push({ edge, versao });
  }

  const problemas: string[] = [];
  if (semSensor.length > 0) {
    problemas.push(
      `sem sensor (não existe supabase/functions/<edge>/versao.ts): ${semSensor.join(', ')}`,
    );
  }
  if (semMarcador.length > 0) {
    problemas.push(
      `versao.ts sem \`export const VERSAO = "..."\` legível: ${semMarcador.join(', ')}`,
    );
  }
  if (problemas.length > 0) {
    throw new Error(
      `Edge não sondável — ${problemas.join(' | ')}. ` +
        'Edge sem sensor não tem como provar versão: instrumente-a (ver _shared/sonda-versao.ts) ' +
        'antes de sondar. Nenhum SQL foi emitido.',
    );
  }
  return resolvidas;
}

/**
 * Ref do projeto Supabase, lido de `supabase/config.toml` — a fonte da verdade do repo.
 *
 * Não é hardcode por preguiça de constante: ref chutado manda a sonda para OUTRO host, e a
 * resposta do gateway (404 `{"code":"NOT_FOUND"}`) é indistinguível de edge que não existe.
 */
export function lerProjectRef(raiz: string): string {
  const toml = readFileSync(join(raiz, 'supabase', 'config.toml'), 'utf8');
  const m = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error('supabase/config.toml sem `project_id` — não dá para montar a URL da sonda.');
  return m[1];
}

export interface OpcoesLeva {
  raiz: string;
  edges: string[];
  /**
   * Subconjunto de `edges` cujo bundle PRÉ-sensor IGNORA o `probe` e dispara o fluxo real (PO no
   * ERP, pedido no portal do fornecedor). O disparo delas sai em bloco separado, com trava.
   */
  caras?: string[];
}

/** Literal SQL entre aspas simples, com escape. */
function lit(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}

/** Lista `('nome'),` para o `VALUES` do bloco de disparo. */
function valuesAlvos(leva: EdgeSondada[]): string {
  return leva.map((e) => `  (${lit(e.edge)})`).join(',\n');
}

/** Lista `('nome', 'marcador'),` para o `VALUES` da lista canônica do bloco de leitura. */
function valuesEsperado(leva: EdgeSondada[]): string {
  return leva.map((e) => `  (${lit(e.edge)}, ${lit(e.versao)})`).join(',\n');
}

/** A chamada `net.http_post`, idêntica nos dois blocos de disparo. */
function httpPost(ref: string, indent: string): string {
  const i = indent;
  return (
    `net.http_post(\n` +
    `${i}  url := 'https://${ref}.supabase.co/functions/v1/' || a.edge,\n` +
    `${i}  headers := jsonb_build_object(\n` +
    `${i}    'Content-Type', 'application/json',\n` +
    `${i}    'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets\n` +
    `${i}                      WHERE name = 'CRON_SECRET' LIMIT 1)),\n` +
    `${i}  body := jsonb_build_object('probe', true),\n` +
    `${i}  timeout_milliseconds := 20000)`
  );
}

/**
 * Bloco de DISPARO. O id e o nome da edge saem agregados na MESMA execução
 * (`jsonb_object_agg`): é o que impede o `request_id` de viajar sozinho e ser copiado para a linha
 * da edge errada.
 */
function blocoDisparo(
  ref: string,
  leva: EdgeSondada[],
  passoLeitura: number,
  comTrava = false,
): string {
  const cabeca = comTrava
    ? `WITH guard(confirmei_o_deploy) AS (VALUES ('nao')),  -- ⬅️ 'nao' → 'sim' só DEPOIS do verde\n` +
      `alvos(edge) AS (VALUES\n${valuesAlvos(leva)}\n),\n`
    : `WITH alvos(edge) AS (VALUES\n${valuesAlvos(leva)}\n),\n`;
  const projecao = comTrava
    ? `         CASE WHEN g.confirmei_o_deploy = 'sim'\n` +
      `              THEN ${httpPost(ref, '                   ')}\n` +
      `         END AS request_id\n` +
      `  FROM alvos a CROSS JOIN guard g\n`
    : `         ${httpPost(ref, '         ')} AS request_id\n` + `  FROM alvos a\n`;
  return (
    cabeca +
    `disparos AS (\n` +
    `  SELECT a.edge,\n` +
    projecao +
    `)\n` +
    `SELECT jsonb_object_agg(edge, request_id)::text AS cole_no_passo_${passoLeitura}\n` +
    `FROM disparos;\n`
  );
}

/**
 * Bloco de LEITURA e veredito.
 *
 * Parte da lista CANÔNICA (`FROM esperado LEFT JOIN ids`) e não dos ids: invertido, colar o JSON
 * do bloco errado devolve ZERO linhas — e zero linhas lê-se como "nada a reportar", não como erro.
 * Mesmo motivo do `LEFT JOIN` contra `net._http_response`: sem ele, "a resposta ainda não chegou"
 * e "veredito negativo" ficam indistinguíveis.
 */
function blocoLeitura(leva: EdgeSondada[]): string {
  return (
    `WITH esperado(edge, versao_esperada) AS (VALUES\n${valuesEsperado(leva)}\n),\n` +
    `ids AS (\n` +
    `  -- ⬅️ COLE AQUI, no lugar do {}, a célula única devolvida pelo passo de disparo.\n` +
    `  SELECT chave AS edge, valor::bigint AS request_id\n` +
    `  FROM jsonb_each_text('{}'::jsonb) AS t(chave, valor)\n` +
    `),\n` +
    `lidas AS (\n` +
    `  SELECT e.edge, e.versao_esperada, i.request_id, r.status_code,\n` +
    `         COALESCE(r.content::jsonb -> 'data', r.content::jsonb) AS corpo\n` +
    `  FROM esperado e\n` +
    `  LEFT JOIN ids i ON i.edge = e.edge\n` +
    `  LEFT JOIN net._http_response r ON r.id = i.request_id\n` +
    `)\n` +
    `SELECT l.edge,\n` +
    `       l.request_id,\n` +
    `       l.status_code,\n` +
    `       l.corpo ->> 'edge'   AS edge_respondida,\n` +
    `       l.corpo ->> 'versao' AS versao_respondida,\n` +
    `       l.versao_esperada,\n` +
    `       CASE\n` +
    `         WHEN l.request_id IS NULL\n` +
    `           THEN 'SEM ID — esta edge não saiu no JSON colado (bloco errado, ou trava fechada)'\n` +
    `         WHEN l.status_code IS NULL\n` +
    `           THEN 'AGUARDE — a resposta HTTP ainda não chegou (leva ~10s); rode este passo de novo'\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code >= 400\n` +
    `           THEN 'BUNDLE VELHO — recusou o request (HTTP ' || l.status_code || '), NADA executou'\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL\n` +
    `           THEN 'PRE-SENSOR — HTTP 200 sem versao: ignorou o probe e RODOU O FLUXO REAL'\n` +
    `         WHEN l.corpo ->> 'versao' = l.versao_esperada\n` +
    `              AND l.corpo ->> 'probe' = 'true'\n` +
    `              AND l.corpo ->> 'edge' = l.edge\n` +
    `           THEN 'DEPLOY CONFIRMADO'\n` +
    `         ELSE 'BUNDLE VELHO — respondeu versao=' || COALESCE(l.corpo ->> 'versao', '?') ||\n` +
    `              ', edge=' || COALESCE(l.corpo ->> 'edge', '?') ||\n` +
    `              ' (esperado ' || l.versao_esperada || ')'\n` +
    `       END AS veredito\n` +
    `FROM lidas l\n` +
    `ORDER BY l.edge;\n`
  );
}

/**
 * Separa a leva em BARATAS e CARAS, recusando `caras` que não estejam na leva.
 *
 * O typo é fail-CLOSED de propósito: `--caro=disparar-pedidos-aprovado` (sem o "s") aceito em
 * silêncio deixaria a edge cara no bloco SEM trava — e um bundle pré-sensor ali cria PO de verdade
 * no Omie. É a classe "sonda de script destrutivo é fail-CLOSED" aplicada ao gerador.
 */
function separar(edges: string[], caras: string[]): { baratas: string[]; caras: string[] } {
  const forasteiras = caras.filter((c) => !edges.includes(c));
  if (forasteiras.length > 0) {
    throw new Error(
      `--caro nomeia edge(s) fora da leva: ${forasteiras.join(', ')}. ` +
        '`--caro` MARCA um subconjunto das edges pedidas; um nome que não casa seria digitação ' +
        'errada, e a edge cara sairia no bloco SEM trava. Nenhum SQL foi emitido.',
    );
  }
  return { baratas: edges.filter((e) => !caras.includes(e)), caras: edges.filter((e) => caras.includes(e)) };
}

/** Gera o SQL de sondagem da leva (dois passos por bloco: dispara, depois lê e julga). */
export function gerarSqlDaLeva(opts: OpcoesLeva): string {
  const grupos = separar(opts.edges, opts.caras ?? []);
  // Resolve a leva INTEIRA antes de emitir qualquer coisa: uma edge sem sensor derruba o SQL todo.
  resolverLeva(opts.raiz, opts.edges);
  const ref = lerProjectRef(opts.raiz);
  const partes: string[] = [];

  if (grupos.baratas.length > 0) {
    const leva = resolverLeva(opts.raiz, grupos.baratas);
    partes.push(
      `-- PASSO 1 — dispara as ${leva.length} edge(s) baratas da leva.\n` +
        blocoDisparo(ref, leva, 2),
      `-- PASSO 2 — lê e julga. Cole o JSON do PASSO 1 no lugar do {}, NA MESMA ABA.\n` +
        blocoLeitura(leva),
    );
  }

  if (grupos.caras.length > 0) {
    const leva = resolverLeva(opts.raiz, grupos.caras);
    partes.push(
      `-- PASSO 3 — dispara as ${leva.length} edge(s) CARAS, com trava.\n` +
        `-- ⚠️ Bundle PRÉ-sensor IGNORA o probe e RODA O FLUXO REAL destas. Só abra a trava depois\n` +
        `--    de o deploy estar confirmado por outro caminho.\n` +
        `-- ⚠️ A trava é CASE e NÃO um filtro: o Postgres avalia a projeção mesmo descartando todas\n` +
        `--    as linhas, então travar por filtro deixa o http_post sair igual (falsificado —\n` +
        `--    docs/agent/deploy.md §"Sondar VÁRIAS edges numa tacada"). E NÃO valide um filtro numa\n` +
        `--    consulta simples para se convencer: lá ele filtra antes e PARECE proteger; é nesta\n` +
        `--    forma, agregada, que ele falha. Trava fechada devolve {"edge": null}, que o passo\n` +
        `--    seguinte lê como SEM ID.\n` +
        blocoDisparo(ref, leva, 4, true),
      `-- PASSO 4 — lê e julga as CARAS. Cole o JSON do PASSO 3 no lugar do {}.\n` +
        blocoLeitura(leva),
    );
  }

  return partes.join('\n');
}

/** A leva pedida na linha de comando. */
export interface ArgsCli {
  edges: string[];
  caras: string[];
}

const USO =
  'uso: bun run sonda:sql <edge> [<edge> ...] [--caro=<edge>[,<edge>]]\n' +
  '  <edge>   nome do diretório em supabase/functions/ (precisa ter versao.ts)\n' +
  '  --caro   marca um SUBCONJUNTO da leva cujo bundle pré-sensor dispara o fluxo real;\n' +
  '           essas saem em bloco separado, com trava por CASE.';

/**
 * Forma de nome de edge: é o diretório em `supabase/functions/`, e as 94 existentes cabem todas
 * aqui. Validar a forma não é paranoia de injeção (o literal já é escapado) — é o que impede
 * `../..` de virar caminho e um argumento torto de virar linha muda no `VALUES`.
 */
const FORMA_EDGE = /^[a-z0-9][a-z0-9-]*$/;

/** Parseia os argumentos ou LANÇA. Nada de flag desconhecida virando nome de edge. */
export function parsearArgs(argv: string[]): ArgsCli {
  const edges: string[] = [];
  const caras: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--caro' || arg.startsWith('--caro=')) {
      const bruto = arg === '--caro' ? argv[++i] : arg.slice('--caro='.length);
      if (!bruto) throw new Error(`--caro sem valor.\n${USO}`);
      caras.push(...bruto.split(',').filter((s) => s.length > 0));
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`flag desconhecida: ${arg}\n${USO}`);
    edges.push(arg);
  }

  if (edges.length === 0) throw new Error(`nenhuma edge na leva.\n${USO}`);

  const tortas = [...edges, ...caras].filter((e) => !FORMA_EDGE.test(e));
  if (tortas.length > 0) {
    throw new Error(
      `fora da forma de um nome de edge (${FORMA_EDGE.source}): ${tortas.join(', ')}\n${USO}`,
    );
  }

  const repetidas = edges.filter((e, i) => edges.indexOf(e) !== i);
  if (repetidas.length > 0) {
    throw new Error(
      `edge repetida na leva: ${[...new Set(repetidas)].join(', ')} — ` +
        'linha duplicada no VALUES é sonda disparada duas vezes.',
    );
  }

  return { edges, caras };
}

/** Saídas da CLI, injetáveis para o teste ver o que foi escrito. */
export interface DependenciasCli {
  raiz: string;
  escrever: (texto: string) => void;
  erro: (texto: string) => void;
}

/** Ponto de entrada. Devolve o código de saída; NADA é escrito na saída quando falha. */
export function main(argv: string[], deps: DependenciasCli): number {
  let sql: string;
  try {
    const { edges, caras } = parsearArgs(argv);
    sql = gerarSqlDaLeva({ raiz: deps.raiz, edges, caras });
  } catch (e) {
    deps.erro(`❌ ${(e as Error).message}`);
    return 1;
  }
  deps.escrever(sql);
  return 0;
}

if (import.meta.main) {
  process.exit(
    main(process.argv.slice(2), {
      raiz: join(import.meta.dirname, '..'),
      escrever: (t) => process.stdout.write(t),
      erro: (t) => console.error(t),
    }),
  );
}
