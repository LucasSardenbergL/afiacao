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
 *
 * POR QUE O VEREDITO JULGA O `fonte`, E NÃO SÓ O `versao`: o `versao` sai do `versao.ts` da PRÓPRIA
 * edge, então um deploy que suba `index.ts` + `versao.ts` e deixe `_shared/sonda-fingerprints.ts`
 * para trás (o risco que a skill `lovable-deploy-verify` Passo 3 documenta — prompt que nomeia
 * poucos arquivos) responde `versao` CERTO e `fonte: "nao-mapeada"` (o `?? "nao-mapeada"` de
 * `criarRespostaSonda`). Julgar só pelo `versao` lê isso como DEPLOY CONFIRMADO: falso POSITIVO
 * num money-path, a classe estritamente pior, porque ENCERRA a verificação. É o `fonte` bater que
 * prova deploy VERBATIM — ele hasheia o fecho transitivo dos imports locais, não a disciplina de
 * quem bumpou o marcador (#1998; validado ponta-a-ponta em prod no #2018).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ARQ_MAPA, lerMapaCommitado } from './sonda-fingerprint';

/** Uma edge da leva, com o marcador do `versao.ts` dela e o fingerprint da FONTE dela. */
export interface EdgeSondada {
  edge: string;
  versao: string;
  fonte: string;
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
 *
 * O fingerprint sai do mapa COMMITADO (`_shared/sonda-fingerprints.ts`, o mesmo que a edge serve no
 * campo `fonte`), pelo leitor que já é dono desse parse. Edge instrumentada fora do mapa derruba a
 * geração inteira pelo mesmo motivo que o marcador ilegível: fingerprint ADIVINHADO — ou omitido do
 * veredito — é veredito FALSO, e aqui o falso seria POSITIVO.
 */
export function resolverLeva(raiz: string, edges: string[]): EdgeSondada[] {
  const mapa = lerMapaCommitado(raiz);
  const semSensor: string[] = [];
  const semMarcador: string[] = [];
  const semFingerprint: string[] = [];
  const resolvidas: EdgeSondada[] = [];

  for (const edge of edges) {
    let textoVersao: string;
    try {
      textoVersao = readFileSync(caminhoVersao(raiz, edge), 'utf8');
    } catch {
      semSensor.push(edge);
      continue;
    }
    const versao = extrairVersao(textoVersao);
    if (versao === null) {
      semMarcador.push(edge);
      continue;
    }
    if (!(edge in mapa)) {
      semFingerprint.push(edge);
      continue;
    }
    resolvidas.push({ edge, versao, fonte: mapa[edge] });
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
  if (semFingerprint.length > 0) {
    problemas.push(`sem entrada no mapa ${ARQ_MAPA}: ${semFingerprint.join(', ')}`);
  }
  if (problemas.length > 0) {
    throw new Error(
      `Edge não sondável — ${problemas.join(' | ')}. ` +
        'Edge sem sensor não tem como provar versão: instrumente-a (ver _shared/sonda-versao.ts) ' +
        'antes de sondar. Edge fora do mapa não tem como provar deploy VERBATIM: rode ' +
        '`bun run sonda:fingerprint -- --write` e commite o mapa. Nenhum SQL foi emitido.',
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

/** Lista `('nome', 'marcador', 'fingerprint'),` para o `VALUES` da lista canônica da leitura. */
function valuesEsperado(leva: EdgeSondada[]): string {
  return leva.map((e) => `  (${lit(e.edge)}, ${lit(e.versao)}, ${lit(e.fonte)})`).join(',\n');
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
 * Piso de respostas 2xx recentes (fora da leva) para o controle de credencial VALER.
 *
 * Não é `> 0` por um motivo de denominador: o controle é populacional — ele conclui "o CRON_SECRET
 * está sendo aceito" a partir de tráfego que passou. Com 1 ou 2 respostas a ausência de 401 não
 * distingue "secret bom" de "quase ninguém bateu na porta", e o veredito determinado sairia de uma
 * amostra que não informa. Os ~52 crons que mandam `x-cron-secret` produzem centenas de respostas
 * por janela de 6h (medido em 2026-08-30: 208 linhas, todas 200); abaixo de 10 o fundo está
 * anormalmente quieto e a resposta honesta é INDETERMINADO.
 */
const PISO_CONTROLE_CREDENCIAL = 10;

/**
 * Bloco de LEITURA e veredito.
 *
 * Parte da lista CANÔNICA (`FROM esperado LEFT JOIN ids`) e não dos ids: invertido, colar o JSON
 * do bloco errado devolve ZERO linhas — e zero linhas lê-se como "nada a reportar", não como erro.
 * Mesmo motivo do `LEFT JOIN` contra `net._http_response`: sem ele, "a resposta ainda não chegou"
 * e "veredito negativo" ficam indistinguíveis.
 *
 * O ramo DEPLOY PARCIAL vem ANTES do de confirmação de propósito: `versao` certo com `fonte`
 * ausente é a assinatura do bundle que subiu `index.ts` + `versao.ts` sem o mapa de fingerprints, e
 * ler isso como CONFIRMADO seria o falso POSITIVO que encerra a verificação. Confirmação exige os
 * DOIS campos; a dúvida cai sempre no lado que manda olhar de novo.
 *
 * POR QUE O 401 TEM RAMO PRÓPRIO: ele é AMBÍGUO por construção, e os outros 4xx não são. Um 404 diz
 * "não há edge servida nessa URL"; um 401 pode ser (a) bundle PRÉ-SONDA que ignorou o
 * `{"probe":true}`, caiu no gate JWT e recusou, ou (b) `CRON_SECRET` ausente/errado no vault, com
 * `authorizeCronOrStaff` recusando o header. Nos DOIS casos `versao` vem NULL e o status é 401 — o
 * dado não separa. Ler (b) como (a) manda redeployar uma edge que já está no ar: `ausente ≠ zero`
 * na dimensão CREDENCIAL, irmão do guard temporal do #2079, onde tick pré-merge lido como pendência
 * produzia o mesmo falso negativo confiante.
 *
 * Então o veredito determinado só sai quando o CONTROLE é observado na MESMA consulta (o CTE
 * `controle_credencial`): tráfego de fundo recente que PASSOU (≥ piso de 2xx) e NENHUMA recusa 401
 * fora desta leva provam que o secret do vault está sendo aceito AGORA — logo o 401 é da edge, não
 * da credencial. Sem essa prova o veredito é INDETERMINADO, nunca "bundle velho": fail-CLOSED,
 * igual ao `CONTROLE_CRUZADO_NAO_OBSERVADO` do `verify-edge-escrita.sh`. Antes disso a desambiguação
 * dependia de o operador lembrar de rodar duas consultas à mão (feito assim em 2026-08-30, no
 * #2101) — e recado que depende de alguém lembrar é exatamente como a armadilha da sentinela
 * não-exclusiva passou.
 *
 * O QUE O CONTROLE NÃO PROVA: ele é populacional — conclui "o secret está sendo aceito" de
 * tráfego que passou. Não fecha a janela em que o `CRON_SECRET` foi trocado há poucos minutos e
 * NENHUM cron rodou desde a troca: ali os 2xx da janela foram feitos com o secret antigo e o
 * controle avaliza indevidamente. O ramo ESTREITA muito o erro (antes ele era incondicional),
 * não o elimina — e o SQL gerado diz isso ao operador, em vez de deixar a ressalva só no doc.
 */
function blocoLeitura(leva: EdgeSondada[]): string {
  return (
    `WITH esperado(edge, versao_esperada, fonte_esperada) AS (VALUES\n${valuesEsperado(leva)}\n),\n` +
    `ids AS (\n` +
    `  -- ⬅️ COLE AQUI, no lugar do {}, a célula única devolvida pelo passo de disparo.\n` +
    `  SELECT chave AS edge, valor::bigint AS request_id\n` +
    `  FROM jsonb_each_text('{}'::jsonb) AS t(chave, valor)\n` +
    `),\n` +
    `controle_credencial AS (\n` +
    `  -- Controle de CREDENCIAL: o 401 acima é ambíguo (bundle velho × CRON_SECRET inválido) e só\n` +
    `  -- vira veredito determinado se ESTE bloco provar que o secret do vault está sendo ACEITO\n` +
    `  -- agora. Lê a MESMA tabela do LEFT JOIN de cima de propósito: não acrescenta superfície de\n` +
    `  -- permissão nova (se desse 'permission denied' o bloco inteiro já teria falhado), e um\n` +
    `  -- controle que exige privilégio a mais viraria INDETERMINADO por acidente de ACL.\n` +
    `  SELECT count(*) FILTER (WHERE r.status_code BETWEEN 200 AND 299) AS ok_recentes,\n` +
    `         count(*) FILTER (WHERE r.status_code = 401)               AS recusas_recentes\n` +
    `  FROM net._http_response r\n` +
    `  WHERE r.created > now() - interval '6 hours'\n` +
    `    -- A própria leva não pode se avalizar: sem isto, o 401 que estamos julgando entra na\n` +
    `    -- contagem de recusas e o controle se auto-envenena (nenhum 401 seria explicável nunca).\n` +
    `    -- NOT EXISTS, não NOT IN: a trava fechada do bloco caro devolve request_id NULL, e\n` +
    `    -- \`NOT IN\` com NULL é NULL-blind — zeraria o controle inteiro em silêncio.\n` +
    `    AND NOT EXISTS (SELECT 1 FROM ids i2 WHERE i2.request_id = r.id)\n` +
    `    -- ⚠️ O que este controle NAO fecha: CRON_SECRET trocado ha poucos minutos E nenhum\n` +
    `    --    cron rodado desde a troca — o trafego 2xx da janela usou o secret ANTIGO e\n` +
    `    --    avalizaria indevidamente. Na proxima execucao dos crons isso vira 401 e o\n` +
    `    --    controle se desqualifica sozinho. Se voce ACABOU de mexer no vault, trate o\n` +
    `    --    veredito determinado abaixo como INDETERMINADO.\n` +
    `),\n` +
    `lidas AS (\n` +
    `  SELECT e.edge, e.versao_esperada, e.fonte_esperada, i.request_id, r.status_code,\n` +
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
    `       l.corpo ->> 'fonte'  AS fonte_respondida,\n` +
    `       CASE\n` +
    `         WHEN l.request_id IS NULL\n` +
    `           THEN 'SEM ID — esta edge não saiu no JSON colado (bloco errado, ou trava fechada)'\n` +
    `         WHEN l.status_code IS NULL\n` +
    `           THEN 'AGUARDE — a resposta HTTP ainda não chegou (leva ~10s); rode este passo de novo'\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401\n` +
    `              AND c.ok_recentes >= ${PISO_CONTROLE_CREDENCIAL} AND c.recusas_recentes = 0\n` +
    `           THEN 'BUNDLE VELHO (pre-sonda) — 401, e o CRON_SECRET esta PROVADO bom agora (' ||\n` +
    `                c.ok_recentes || ' resposta(s) 2xx e ZERO 401 fora desta leva em 6h), ' ||\n` +
    `                'logo a recusa e da EDGE: nada executou'\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401\n` +
    `           THEN 'INDETERMINADO — 401 nao separa bundle velho de CRON_SECRET invalido, e o ' ||\n` +
    `                'controle de credencial NAO foi observado (2xx fora da leva em 6h: ' ||\n` +
    `                c.ok_recentes || ', recusas 401: ' || c.recusas_recentes || '). Confira o ' ||\n` +
    `                'CRON_SECRET no vault ANTES de redeployar — nao ha prova de bundle velho aqui'\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code >= 400\n` +
    `           THEN 'BUNDLE VELHO — recusou o request (HTTP ' || l.status_code || '), NADA executou'\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL\n` +
    `           THEN 'PRE-SENSOR — HTTP 200 sem versao: ignorou o probe e RODOU O FLUXO REAL'\n` +
    `         WHEN COALESCE(l.corpo ->> 'fonte', 'nao-mapeada') = 'nao-mapeada'\n` +
    `           THEN 'DEPLOY PARCIAL — subiu index.ts+versao.ts, mas _shared/sonda-fingerprints.ts NAO'\n` +
    `         WHEN l.corpo ->> 'versao' = l.versao_esperada\n` +
    `              AND l.corpo ->> 'fonte' = l.fonte_esperada\n` +
    `              AND l.corpo ->> 'probe' = 'true'\n` +
    `              AND l.corpo ->> 'edge' = l.edge\n` +
    `           THEN 'DEPLOY CONFIRMADO'\n` +
    `         ELSE 'BUNDLE VELHO — respondeu versao=' || COALESCE(l.corpo ->> 'versao', '?') ||\n` +
    `              ', fonte=' || COALESCE(l.corpo ->> 'fonte', '?') ||\n` +
    `              ', edge=' || COALESCE(l.corpo ->> 'edge', '?') ||\n` +
    `              ' (esperado ' || l.versao_esperada || ' / ' || l.fonte_esperada || ')'\n` +
    `       END AS veredito\n` +
    `FROM lidas l CROSS JOIN controle_credencial c\n` +
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
