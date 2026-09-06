#!/usr/bin/env bun
/**
 * pendencias-deploy.ts — CLI da varredura PASSIVA de deploy divergente.
 *
 * Lê o LEDGER `public.deploy_atestacoes` (∪ a janela viva de `net._http_response`) pelo wrapper
 * read-only e julga contra o que a main espera. Não dispara sonda, não escreve, não precisa de
 * secret: só do `psql-ro` e do git. Feito para virar cron e só falar quando algo diverge.
 *
 * O julgamento puro vive em `lib/pendencias-deploy.ts` (testável sem rede). Aqui fica só a borda:
 * shell, git, o esperado lido do repo e os códigos de saída.
 *
 * EXIT CODES — e o 2 é o que impede este script de virar teatro:
 *   0  nada pendente
 *   1  há pendência: P1 (deploy no PR) · P2 (leva agrupada; escalada após 7 d) · bundle incoerente ·
 *      bundle sem mapa · edge fora do mapa · eco sem fonte · NUNCA atestada — o relatório nomeia
 *      cada classe e imprime o comando da sonda para as que precisam dela
 *   2  MECÂNICA não confiável: psql falhou, ledger inexistente (migration não aplicada), coletor
 *      sem execução bem-sucedida nos últimos 45 min, mapa vazio ou desatualizado em relação à
 *      fonte, `versao.ts` ilegível, linha da saída que não casou o formato, ZERO observações.
 *      Zero aqui NÃO é "tudo limpo" — um cron que devolvesse 0 ensinaria o operador a ler
 *      silêncio como aprovação, que é exatamente o hábito que a varredura existe para desfazer.
 *
 * `--json` (2026-09-06): a MESMA varredura, serializada para outro programa ler — o Passo 3 do
 * `/fecho` (`.claude/skills/fecho/scripts/edges-pendentes.sh`) consulta o ledger por aqui antes de
 * classificar uma edge como SEM_PROVA, porque a janela viva de 6 h evaporava prova que o ledger
 * guarda. O contrato é a marca `FORMATO_JSON`: exit 0/1 SEM ela é "presente-porém-quebrado" para o
 * consumidor, que trata como não consultado (fail-closed). Os exit codes são os mesmos do modo
 * humano — inclusive o 2 de flag desconhecida, que para o consumidor já significa não consultado.
 *
 * POR QUE O LEDGER, E NÃO SÓ A JANELA (2026-09-05): `pg_net.ttl = 6h`. Antes, cada sessão via
 * 47/54 edges "sem sonda na janela" e o relatório mandava o founder colar o SQL de sonda DE NOVO —
 * a prova de ontem valia zero hoje. O ledger é alimentado por cron (`deploy-atestacoes-colher`,
 * 15/15 min); a sonda humana passa a ser UMA por deploy (e a 1ª de edge nova), nunca por sessão.
 *
 * A 2ª LEITURA (`SQL_SEM_IDENTIDADE`, 2026-09-05): `deploy_atestacoes_janela_viva()` exige `edge`
 * string — é o que impede corpo alheio de virar veredito, e é o que torna a sonda de bundle
 * pré-28/08 INVISÍVEL: ela responde `{"ok":true,"probe":true,"versao":"…"}` e mais nada. Medido no
 * bootstrap do ledger: das 30 sondas do founder, 6 vieram assim, ficaram fora do ledger e saíram no
 * relatório como `NUNCA_ATESTADA — precisa da 1ª sonda`. O founder sondava de novo e recebia a
 * mesma resposta. Então o CLI faz uma segunda consulta, barata, sobre a MESMA janela: 200 +
 * `probe` booleano true + SEM a chave `edge`. O produto dela é a classe `SONDA_SEM_IDENTIDADE`.
 *
 * ATRIBUIR É OPCIONAL, E SÓ POR `request_id` (`--ids`). `v1.0-sensor-inicial` é a `VERSAO` de 13
 * edges da main; duas respostas de edges diferentes são idênticas byte a byte, e nem a URL, nem a
 * fila, nem os headers, nem o `created` desempatam (§7 de `verificar-sonda-versao.md`). A única
 * identidade forte é o id que o PASSO 1 do `sonda:sql` devolve. Sem `--ids`, o relatório dá a
 * CONTAGEM, as versões e os ids — nunca a edge. Casar por posição seria fabricar.
 *
 * POR QUE ELAS NÃO ENTRAM NO LEDGER COM `edge = 'desconhecida'` (pedido explicitamente, e a
 * resposta é não): (a) o `DISTINCT ON (edge)` passaria a ver uma edge chamada `desconhecida`, que a
 * main não mapeia ⇒ 🟠 FORA_DO_MAPA urgente — uma edge INVENTADA no relatório de deploy, e o slug
 * casa o regex da janela viva, então nada no banco a barraria; (b) o ledger é ETERNO e a janela do
 * pg_net dura 6h: a chance de atribuir morre com a janela, e a linha ficaria para sempre
 * impossível de reinterpretar; (c) este CLI lê pelo `psql-ro` — gravar exigiria o founder colar
 * SQL, custo humano por um dado que não conclui nada. A prova não se perde: ela vira CLASSE no
 * relatório (exit 1), e veredito por edge quando houver `--ids`.
 *
 * POR QUE NÃO HÁ CRON DE SONDA ATIVA: o desenho inicial tinha um (6/6h, allowlist das edges que
 * já responderam `probe:true`). O Codex derrubou: rollback pelo Lovable, restauração de projeto
 * ou recriação manual devolvem um bundle PRÉ-sensor, que ignora `probe` e roda o fluxo real — a
 * `monthly-report` mandaria e-mail para a base inteira, autorizada por uma linha histórica do
 * ledger. Sondar para descobrir se o sensor existe é executar o request que o bundle velho lê
 * como fluxo real; só um mecanismo que o bundle velho REJEITE antes de qualquer efeito (p.ex.
 * atestação por `OPTIONS`) tornaria a automação segura. Fica registrado como follow-up.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  atribuirSondasSemIdentidade,
  DATA_ECO_COM_IDENTIDADE,
  decidirExit,
  edgesParaSondar,
  julgar,
  lerTolerancia,
  parsearIds,
  parsearObservacoes,
  parsearSondasSemIdentidade,
  resumirSemIdentidade,
  type Contexto,
  type Esperado,
  type Estado,
  type Observacao,
  type Relatorio,
  type Veredito,
} from './lib/pendencias-deploy';
import {
  alvosForaDoRepo,
  cronSondaParado,
  type AtestacaoAtribuida,
  type Disparo,
  julgarSondaCron,
} from './lib/sonda-cron-testemunha';
import { SONDA_CRON_ALVOS } from '../supabase/functions/_shared/sonda-cron-alvos';
import { ARQ_MAPA, parsearMapa, RAIZ_EDGES } from './sonda-fingerprint';
import { git, lerNaRev } from './sonda-versao-bump-gate';
import { extrairVersao } from './sonda-versao-sql';

const PSQL_RO = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/**
 * A ref que define o ESPERADO. O Lovable deploya a MAIN — não a worktree de quem roda o script.
 *
 * Medido no primeiro veredito real (2026-09-05): a worktree estava 3 commits atrás, o `versao.ts`
 * local dizia v1.6 e prod já servia a v1.7 da main — saiu um P1 FALSO de uma edge em dia. Minutos
 * depois de um rebase, a main já tinha andado de novo (5 arquivos em `supabase/functions/`). Com
 * ~30 sessões mergeando, "sincronize antes de medir" não é disciplina que se sustente: o
 * instrumento lê a ref, não a árvore. É o eixo TEMPO/ÁRVORE de `fatia-de-deploy-envelhece.md`,
 * fechado no lugar certo.
 */
export const REF_MAIN = 'origin/main';

/** A migration que cria o ledger — citada no erro quando a tabela não existe em prod. */
export const MIGRATION_LEDGER = '20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql';

/** Nome do cron do coletor (o mesmo da migration). */
export const CRON_COLETOR = 'deploy-atestacoes-colher';

/** O coletor roda de 15 em 15 min; 3 passagens perdidas é cron parado, não atraso. */
export const COLETOR_TOLERANCIA_MIN = 45;

/**
 * Marca de FORMA da saída `--json`. O consumidor (`edges-pendentes.sh`, Passo 3 do /fecho) exige
 * esta string literal ANTES de ler qualquer veredito: exit 0/1 sem ela é "presente-porém-quebrado"
 * (bun que imprimiu outra coisa, contrato que mudou) e cai no fail-closed dele — a resposta tem de
 * ser POSITIVA, não só "não deu erro". Mudança incompatível no JSON = bump aqui, e o shell velho
 * passa a RECUSAR em vez de ler errado. A paridade das duas pontas é testada como texto.
 */
export const FORMATO_JSON = 'pendencias-deploy/1';

/**
 * `--json` está presente no argv? Quem RECUSA argumento desconhecido continua sendo o `lerArgIds`
 * (⇒ exit 2, "mecânica"): um validador só, e a recusa dele já é o que o consumidor trata como
 * ledger não consultado. Esta função apenas LÊ a flag — por isso `lerArgIds` precisa conhecê-la.
 */
export function lerArgJson(argv: string[]): boolean {
  return argv.includes('--json');
}

/**
 * O relatório inteiro como JSON, com a marca de formato na frente. Os vereditos vão INTEIROS
 * (`Veredito`, campo a campo): o consumidor decide o que ler, e `observado: null` na NUNCA_ATESTADA
 * continua sendo null — ausente ≠ zero, então o shell recebe a ausência e não um `""` que pudesse
 * casar com um esperado vazio.
 */
export function serializarRelatorio(rel: Relatorio, meta: { ref: string; tolerarNunca: boolean }): string {
  return JSON.stringify({
    formato: FORMATO_JSON,
    ref: meta.ref,
    tolerarNunca: meta.tolerarNunca,
    totalMapeadas: rel.totalMapeadas,
    totalObservadas: rel.totalObservadas,
    totalPendentes: rel.totalPendentes,
    totalUrgentes: rel.totalUrgentes,
    foraDoMapaHistoricas: rel.foraDoMapaHistoricas,
    vereditos: rel.vereditos,
  });
}

/**
 * O que prod já disse sobre cada edge — a linha MAIS RECENTE por edge, de duas fontes:
 *
 * 1. o LEDGER (`public.deploy_atestacoes`), que guarda tudo que o coletor já copiou;
 * 2. a JANELA VIVA (`public.deploy_atestacoes_janela_viva()`), para o que respondeu nos últimos
 *    minutos e o coletor ainda não copiou (ele passa de 15 em 15 min).
 *
 * A definição de "observação válida" mora na função do banco — a MESMA que o coletor usa. Duas
 * cópias do filtro divergiriam em silêncio (o #2103 documentou o ponto cego do eco passivo, e o
 * script ficou cego por dias porque a query dele não acompanhou a doc).
 *
 * `DISTINCT ON (edge) ... ORDER BY observado_em DESC, request_id DESC`: o desempate por id é
 * obrigatório — em prod há respostas com `created` idêntico ao microssegundo (64031/64032), e sem
 * ele a escolha fica com o plano, não com o dado.
 *
 * A idade vem calculada pelo banco (`now() - observado_em`): o parse de timestamptz no cliente é
 * o tipo de detalhe que quebra por locale/offset, e a lib só precisa de um número.
 */
export const SQL = `
WITH tudo AS (
  SELECT request_id, edge, versao, fonte, via, observado_em
  FROM public.deploy_atestacoes
  UNION ALL
  SELECT request_id, edge, versao, fonte, via, observado_em
  FROM public.deploy_atestacoes_janela_viva()
)
SELECT DISTINCT ON (edge)
       edge, versao, fonte, via,
       to_char(observado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'),
       round((extract(epoch FROM (now() - observado_em)) / 3600.0)::numeric, 2)
FROM tudo
ORDER BY edge, observado_em DESC, request_id DESC;
`.trim();

/**
 * Saúde do coletor: minutos desde a última execução BEM-SUCEDIDA do cron. `cron.job_run_details`
 * é a única testemunha de que o ledger está sendo alimentado — o ledger cheio de ontem e o
 * coletor morto hoje têm a mesma cara vistos só pela tabela.
 */
export const SQL_SAUDE_COLETOR = `
SELECT coalesce(
  round((extract(epoch FROM (now() - max(d.end_time))) / 60.0)::numeric, 1)::text,
  'nunca')
FROM cron.job j
LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid AND d.status = 'succeeded'
WHERE j.jobname = '${CRON_COLETOR}';
`.trim();

/**
 * A 2ª leitura: sondas que responderam e NÃO disseram quem são.
 *
 * Sobre `net._http_response` direto, porque a janela viva as exclui por construção (exige `edge`).
 * Afrouxar a janela seria deixar entrar no LEDGER — que é eterno — linha sem edge; esta consulta
 * não escreve nada e roda no mesmo wrapper read-only.
 *
 * Os guards são os mesmos da janela viva, pela mesma razão: `LIKE` textual e `left(ltrim(...))`
 * ANTES do cast, com o cast dentro de um `CASE` (ordem de avaliação é da linguagem, não do plano) —
 * sem isso, um corpo truncado que começa com `{` aborta a varredura inteira.
 *
 * `NOT (r.c ? 'edge')` e não `(r.c ->> 'edge') IS NULL`: a ausência se testa pela CHAVE. E
 * `probe` tem de ser o BOOLEANO true — sem essa assinatura, qualquer corpo de terceiro sem `edge`
 * entraria na classe.
 *
 * LIMITE conhecido: `probe:true` sem `versao` string fica de fora. Não é forma que este repo já
 * emitiu (`respostaSonda` sempre recebeu a `VERSAO`), e sem `versao` não há o que comparar com a
 * main — a linha entraria só para inflar um contador.
 */
export const SQL_SEM_IDENTIDADE = `
SELECT r.id,
       r.c ->> 'versao',
       to_char(r.created AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'),
       round((extract(epoch FROM (now() - r.created)) / 3600.0)::numeric, 2)
FROM (
  SELECT id, created,
         CASE WHEN content IS JSON OBJECT THEN content::jsonb END AS c
  FROM net._http_response
  WHERE status_code = 200
    AND id IS NOT NULL
    AND created IS NOT NULL
    AND content IS NOT NULL
    AND left(ltrim(content), 1) = '{'
    AND content LIKE '%"probe"%'
    AND content LIKE '%"versao"%'
) r
WHERE r.c IS NOT NULL
  AND (r.c -> 'probe') = to_jsonb(true)
  AND NOT (r.c ? 'edge')
  AND jsonb_typeof(r.c -> 'versao') = 'string'
  AND length(r.c ->> 'versao') BETWEEN 1 AND 120
ORDER BY r.created DESC, r.id DESC;
`.trim();

export const MIGRATION_SONDA_CRON = '20260906151204_deploy_sonda_cron_fail_closed.sql';
export const CRON_SONDA = 'deploy-sonda-cron';

/**
 * ── A sonda por CRON como testemunha (F3) ────────────────────────────────────────────────────
 *
 * As três leituras abaixo respondem juntas a única pergunta que a matriz do par NÃO responde: *o
 * bundle que o ledger jura estar no ar continua lá?* A ligação é sempre por `request_id` — a
 * atribuição gravada na mesma transação do disparo — porque atribuir por TEMPO deixa uma resposta
 * atrasada mascarar dois ticks silenciosos logo depois de um rollback.
 *
 * Se as tabelas ainda não existem (F2 não aplicada), a seção inteira sai como AVISO e o resto do
 * relatório continua valendo: fazer o CLI reprovar por uma migration pendente transformaria uma
 * entrega em voo num bloqueio para todo mundo.
 */
export const SQL_SONDA_CRON_ALVOS = `
SELECT edge FROM public.deploy_sonda_alvos WHERE ativo ORDER BY edge;
`.trim();

/** Os disparos dos 2 ticks mais recentes: (tick, edge, request_id), mais recente primeiro. */
export const SQL_SONDA_CRON_DISPAROS = `
WITH ticks AS (
  SELECT tick_id, max(enfileirado_em) AS quando
  FROM public.deploy_sonda_disparos
  GROUP BY tick_id
  ORDER BY quando DESC
  LIMIT 2
)
SELECT d.tick_id::text, d.edge, d.request_id
FROM public.deploy_sonda_disparos d
JOIN ticks t ON t.tick_id = d.tick_id
ORDER BY t.quando DESC, d.edge;
`.trim();

/**
 * Quais desses `request_id` viraram atestação, e com que identidade no CORPO.
 *
 * Lê o LEDGER e a janela viva — a mesma união do veredito principal. Uma atestação que só existe
 * na janela ainda não foi colhida, e ignorá-la faria o CLI acusar silêncio nos 15 minutos entre a
 * resposta e a passagem do coletor.
 */
export const SQL_SONDA_CRON_ATESTACOES = `
WITH ticks AS (
  SELECT tick_id, max(enfileirado_em) AS quando
  FROM public.deploy_sonda_disparos
  GROUP BY tick_id
  ORDER BY quando DESC
  LIMIT 2
), pedidos AS (
  SELECT d.request_id FROM public.deploy_sonda_disparos d JOIN ticks t ON t.tick_id = d.tick_id
), tudo AS (
  SELECT request_id, edge FROM public.deploy_atestacoes
  UNION ALL
  SELECT request_id, edge FROM public.deploy_atestacoes_janela_viva()
)
SELECT DISTINCT tudo.request_id, tudo.edge
FROM tudo JOIN pedidos p ON p.request_id = tudo.request_id
ORDER BY 1;
`.trim();

/** Minutos desde o último sucesso do cron de SONDA (não o do ledger). `nunca` = recém-aplicado. */
export const SQL_SAUDE_CRON_SONDA = `
SELECT coalesce(
  round((extract(epoch FROM (now() - max(d.end_time))) / 60.0)::numeric, 1)::text,
  'nunca')
FROM cron.job j
LEFT JOIN cron.job_run_details d ON d.jobid = j.jobid AND d.status = 'succeeded'
WHERE j.jobname = '${CRON_SONDA}';
`.trim();

/**
 * Lê o `--ids` do argv, ou LANÇA (⇒ exit 2). A flag é opcional; o que não é opcional é ela ser
 * inequívoca — argumento digitado errado que caísse em "sem atribuição" devolveria o relatório
 * ANTIGO com cara de novo, e o founder concluiria que a atribuição não funciona.
 */
export function lerArgIds(argv: string[]): string | null {
  const USO = 'Uso: bun run pendencias:deploy [--json] [--ids=\'{"<edge>": <request_id>, …}\']';
  let ids: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let valor: string | undefined;

    if (arg === '--ids') {
      valor = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--ids=')) {
      valor = arg.slice('--ids='.length);
    } else if (arg === '--json') {
      // conhecida aqui, LIDA em `lerArgJson`: um validador só para todo o argv, senão a flag nova
      // cairia em "argumento desconhecido" e o `--json` nasceria recusado pelo próprio CLI.
      continue;
    } else {
      throw new Error(`argumento desconhecido: ${arg}. ${USO}`);
    }

    if (valor === undefined || valor.trim() === '') {
      throw new Error(`--ids veio sem valor. Cole o JSON do PASSO 1 do \`sonda:sql\`. ${USO}`);
    }
    if (ids !== null) {
      throw new Error('--ids repetido: dois JSONs são duas levas, e escolher um deles é escolher por ordem.');
    }
    ids = valor;
  }

  return ids;
}

/** A seção da classe. Sem resposta sem identidade não há seção — silêncio aqui é o certo. */
export function formatarSemIdentidade(resumo: ReturnType<typeof resumirSemIdentidade>): string[] {
  if (resumo.total === 0) return [];
  return [
    `\n🔴 SONDA_SEM_IDENTIDADE — ${resumo.total} resposta(s) \`probe:true\` SEM \`edge\` no corpo`,
    `   versao respondida: ${resumo.porVersao.map((v) => `${v.versao} × ${v.n}`).join(' · ')}`,
    `   request_id: ${resumo.requestIds.join(', ')}`,
    `   Bundle anterior a ${DATA_ECO_COM_IDENTIDADE}, quando o eco passou a trazer edge+fonte (069540905).`,
    '   Isto é DEPLOY PENDENTE por closure, não ausência de dado: NÃO RE-SONDE — a resposta seria a mesma.',
    '   Para virar veredito POR EDGE, cole o JSON do PASSO 1:',
    `     bun run sonda:sql --so-disparo <edge>…   →   bun run pendencias:deploy --ids='<json do passo 1>'`,
  ];
}

function psql(sql: string): string {
  return execFileSync(PSQL_RO, ['-A', '-F', '|', '-t', '-c', sql], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function semChatter(saida: string): string[] {
  return saida
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== 'SET');
}

/**
 * O esperado por edge, lido da MAIN (`origin/main` recém-buscada): `fonte` do mapa commitado +
 * `VERSAO` do `versao.ts` — os dois pela ref, nunca pela árvore de trabalho.
 *
 * Não recalcula o fingerprint aqui: quem garante que o mapa da main bate com a fonte da main é o
 * gate `sonda:fingerprint` do CI, que todo commit da main já passou — recalcular exigiria ler o
 * closure inteiro por `git show` (centenas de blobs) para provar o que o CI provou.
 *
 * LANÇA (⇒ exit 2) se o fetch falhar, se o mapa não existir na ref, ou se algum `versao.ts` está
 * ausente/ilegível: esperado indeterminável não é "sem divergência" (achado do Codex — validar o
 * universo antes de julgar).
 */
export function lerEsperados(): Record<string, Esperado> {
  const fetch = git(['fetch', '--quiet', 'origin', 'main']);
  if (!fetch.ok) {
    throw new Error(
      '`git fetch origin main` falhou — sem a main ATUAL não sei o que prod deveria servir (ref velha fabricaria veredito)',
    );
  }
  const textoMapa = lerNaRev(REF_MAIN, ARQ_MAPA);
  if (textoMapa === null) throw new Error(`${ARQ_MAPA} não existe em ${REF_MAIN}`);
  const mapa = parsearMapa(textoMapa);

  const esperados: Record<string, Esperado> = {};
  const ilegiveis: string[] = [];
  for (const [edge, fonte] of Object.entries(mapa)) {
    const texto = lerNaRev(REF_MAIN, `${RAIZ_EDGES}/${edge}/versao.ts`);
    const versao = texto === null ? null : extrairVersao(texto);
    if (versao === null) {
      ilegiveis.push(edge);
      continue;
    }
    esperados[edge] = { fonte, versao };
  }
  if (ilegiveis.length > 0) {
    throw new Error(
      `\`export const VERSAO\` ilegível ou ausente em ${REF_MAIN} para: ${ilegiveis.join(', ')}. ` +
        'Sem os dois marcadores o par (versao, fonte) não se julga.',
    );
  }
  return esperados;
}

/**
 * O contexto que só o git responde.
 *
 * `parCoerente`: o commit mais ANTIGO em que a entrada `"edge": "fonte"` aparece no mapa é onde
 * esse `fonte` ENTROU na main; o `versao.ts` naquele commit é a versão que coexistiu com ele —
 * `versao.ts` está no closure, então enquanto o `fonte` não mudar a versão também não muda. Se o
 * `fonte` observado nunca esteve no mapa, o bundle não veio de commit nenhum da main.
 *
 * `diasPendente`: o commit mais RECENTE em que a entrada esperada aparece é onde ela entrou (ela é
 * a atual, logo nunca saiu); a idade dele é há quanto tempo a pendência existe.
 */
export function contextoGit(): Contexto {
  const agulha = (edge: string, fonte: string) => `-S"${edge}": "${fonte}"`;
  return {
    parCoerente(edge, versao, fonte) {
      const r = git(['log', REF_MAIN, '--format=%H', agulha(edge, fonte), '--', ARQ_MAPA]);
      if (!r.ok) throw new Error(`git log -S falhou para ${edge} — sem git não há coerência a provar`);
      const commits = r.saida.split('\n').filter((c) => c !== '');
      if (commits.length === 0) return false;
      const entrou = commits[commits.length - 1];
      const texto = lerNaRev(entrou, `${RAIZ_EDGES}/${edge}/versao.ts`);
      return texto !== null && extrairVersao(texto) === versao;
    },
    diasPendente(edge, fonteEsperado) {
      const r = git(['log', REF_MAIN, '-1', '--format=%ct', agulha(edge, fonteEsperado), '--', ARQ_MAPA]);
      if (!r.ok || r.saida === '') return null;
      const ct = Number(r.saida);
      if (!Number.isFinite(ct)) return null;
      return Math.floor((Date.now() / 1000 - ct) / 86_400);
    },
  };
}

function idade(v: Veredito): string {
  if (v.idadeHoras === null) return '';
  if (v.idadeHoras < 1) return `há ${Math.round(v.idadeHoras * 60)} min`;
  if (v.idadeHoras < 48) return `há ${Math.round(v.idadeHoras)} h`;
  return `há ${Math.round(v.idadeHoras / 24)} d`;
}

function imprimir(rel: Relatorio, linhasSemIdentidade: string[]): void {
  // Tipados como `Estado` de propósito: um estado novo na lib sem rótulo aqui — ou um nome
  // digitado errado — vira erro de compilação, não seção que some calada do relatório.
  const ordem: Estado[] = [
    'DIVERGE_P1',
    'INCOERENTE',
    'SEM_MAPA_NO_BUNDLE',
    'FORA_DO_MAPA',
    'DIVERGE_P2',
    'SEM_FONTE_NO_ECO',
    'NUNCA_ATESTADA',
    'CONFERE',
  ];
  const rotulo: Record<Estado, string> = {
    DIVERGE_P1: '🔴 P1 — DEPLOY PENDENTE declarado (versao bumpou): deploy no PR',
    INCOERENTE: '🔴 bundle INCOERENTE (par versao/fonte nunca existiu na main): deploy PARCIAL ou bundle de fora da main',
    SEM_MAPA_NO_BUNDLE: '🔴 BUNDLE SEM O MAPA (_shared/sonda-fingerprints.ts ficou para trás no deploy)',
    FORA_DO_MAPA: '🟠 prod serve edge que a main não mapeia',
    DIVERGE_P2: '🟡 P2 — DEPLOY PENDENTE não declarado (closure mudou sem bump): política = leva agrupada, escala após 7 d',
    SEM_FONTE_NO_ECO: '⚪ eco sem `fonte` — não prova o closure: sonde-a',
    NUNCA_ATESTADA: '⚪ NUNCA atestada (ausência de dado, NÃO é ok): precisa da 1ª sonda',
    CONFERE: '✅ confere',
  };

  for (const estado of ordem) {
    const grupo: Veredito[] = rel.vereditos.filter((v) => v.estado === estado);
    if (grupo.length === 0) continue;
    console.log(`\n${rotulo[estado]} — ${grupo.length}`);
    for (const v of grupo) {
      let det = '';
      switch (v.estado) {
        case 'DIVERGE_P1':
          det = `  prod ${v.versao} → main ${v.versaoEsperada} · pendente há ${v.diasPendente ?? '?'} d`;
          break;
        case 'DIVERGE_P2':
          det = `  ${v.versao} · fonte ${v.observado?.slice(0, 10)}… → ${v.esperado?.slice(0, 10)}… · pendente há ${v.diasPendente ?? '?'} d${v.escalada ? ' · ⚠️ ESCALADA' : ''}`;
          break;
        case 'INCOERENTE':
          det = `  prod (${v.versao}, ${v.observado?.slice(0, 10)}…) · main (${v.versaoEsperada}, ${v.esperado?.slice(0, 10)}…)`;
          break;
        case 'NUNCA_ATESTADA':
          det = '';
          break;
        default:
          det = `  ${v.versao ?? ''} · visto ${idade(v)} via ${v.via}`;
      }
      console.log(`   ${v.edge.padEnd(34)}${det}`);
    }
  }

  for (const linha of linhasSemIdentidade) console.log(linha);

  const sondar = edgesParaSondar(rel);
  if (sondar.length > 0) {
    console.log(
      `\n   → sonda (founder cola no SQL Editor): bun run sonda:sql ${sondar.join(' ')}` +
        '\n     A resposta entra no ledger em até 15 min (cron deploy-atestacoes-colher) e vale até o fonte da main mudar.',
    );
    // Sem `--ids` não dá para saber QUAIS destas já responderam — mas dá para não deixar as duas
    // instruções se contradizerem na mesma tela. A ressalva é o que impede a re-sonda inútil.
    if (linhasSemIdentidade.length > 0) {
      console.log(
        '     ⚠️  Há resposta(s) SEM IDENTIDADE na janela (acima): parte desta lista pode já ter respondido.',
      );
      console.log('        Se você acabou de sondar, ATRIBUA com --ids em vez de sondar de novo.');
    }
  }

  console.log(
    `\n─── cobertura: ${rel.totalObservadas}/${rel.totalMapeadas} edges mapeadas com atestação (ledger ∪ janela viva)`,
  );
  if (rel.foraDoMapaHistoricas.length > 0) {
    console.log(
      `    ${rel.foraDoMapaHistoricas.length} edge(s) só no histórico do ledger, sem observação fresca (main não mapeia): ${rel.foraDoMapaHistoricas.join(', ')}`,
    );
  }
}

/**
 * Lê e julga a sonda por CRON. Devolve as linhas a imprimir e quantos ACHADOS houve (pendências).
 *
 * Degrada com AVISO — nunca com exit 2 — quando as tabelas da F2 não existem: a F3 pode chegar ao
 * repo antes de o founder colar a migration, e reprovar por isso transformaria uma entrega em voo
 * num bloqueio para todas as sessões. A mecânica de verdade (cron parado, banco fora do repo) só
 * se aplica quando a F2 JÁ está no ar, porque só aí o silêncio significa alguma coisa.
 */
export function secaoSondaCron(
  estadoPorEdge: Map<string, string>,
  ler: (sql: string) => string,
): { linhas: string[]; achados: number; mecanica: string | null } {
  const linhas: string[] = [];
  let ativos: string[];
  try {
    ativos = semChatter(ler(SQL_SONDA_CRON_ALVOS));
  } catch (e) {
    const stderr = String((e as Error & { stderr?: string | Buffer }).stderr ?? '');
    // ASCII em caixa fixa: `exist` casa "does not exist" E "nao existe" sem depender de acento.
    if (stderr.includes('deploy_sonda_alvos') && stderr.includes('exist')) {
      return {
        linhas: [
          `\n🕒 SONDA POR CRON: ainda não instalada — a migration ${MIGRATION_SONDA_CRON} não foi aplicada.`,
          '   Enquanto isso, a atestação continua dependendo da sonda humana (`bun run sonda:sql`).',
        ],
        achados: 0,
        mecanica: null,
      };
    }
    return { linhas: [], achados: 0, mecanica: `leitura da sonda por cron falhou — ${(e as Error).message}` };
  }

  const doRepo = SONDA_CRON_ALVOS.map((a) => a.edge);
  const intrusos = alvosForaDoRepo(ativos, doRepo);
  if (intrusos.length > 0) {
    return {
      linhas: [],
      achados: 0,
      mecanica:
        `o banco sonda edge(s) que o repo NÃO aprovou: ${intrusos.join(', ')}. ` +
        'Só a allowlist do repo teve todos os closures históricos executados (`bun run sonda:cron-prova`). ' +
        `Desative no banco: UPDATE public.deploy_sonda_alvos SET ativo = false WHERE edge IN ('${intrusos.join("','")}');`,
    };
  }

  const saude = semChatter(ler(SQL_SAUDE_CRON_SONDA));
  const minutos = saude.length === 1 && saude[0] !== 'nunca' ? Number(saude[0]) : null;
  if (saude.length !== 1) {
    return { linhas: [], achados: 0, mecanica: `o cron '${CRON_SONDA}' não existe em prod — a migration ${MIGRATION_SONDA_CRON} não foi aplicada inteira.` };
  }
  if (minutos !== null && !Number.isFinite(minutos)) {
    return { linhas: [], achados: 0, mecanica: `a saúde do cron '${CRON_SONDA}' veio ilegível: ${saude[0]}` };
  }
  if (cronSondaParado(minutos)) {
    return {
      linhas: [],
      achados: 0,
      mecanica:
        `o cron '${CRON_SONDA}' não tem execução bem-sucedida há ${saude[0]} min. ` +
        'Sem ele o silêncio das edges não significa nada — confira cron.job_run_details.',
    };
  }

  const disparos: Disparo[] = [];
  const ticksRecentes: string[] = [];
  for (const linha of semChatter(ler(SQL_SONDA_CRON_DISPAROS))) {
    const [tickId, edge, req] = linha.split('|');
    const requestId = Number(req);
    if (!tickId || !edge || !Number.isFinite(requestId)) {
      return { linhas: [], achados: 0, mecanica: `linha de disparo fora do formato: ${linha}` };
    }
    disparos.push({ tickId, edge, requestId });
    if (!ticksRecentes.includes(tickId)) ticksRecentes.push(tickId);
  }

  const atestacoes: AtestacaoAtribuida[] = [];
  for (const linha of semChatter(ler(SQL_SONDA_CRON_ATESTACOES))) {
    const [req, edge] = linha.split('|');
    const requestId = Number(req);
    if (!edge || !Number.isFinite(requestId)) {
      return { linhas: [], achados: 0, mecanica: `linha de atestação fora do formato: ${linha}` };
    }
    atestacoes.push({ requestId, edgeDoCorpo: edge });
  }

  const r = julgarSondaCron({
    ativosNoBanco: ativos,
    allowlistDoRepo: doRepo,
    ticksRecentes,
    disparos,
    atestacoes,
    estadoPorEdge,
  });

  const atestadas = new Set(atestacoes.map((a) => a.requestId));
  const respondidos = disparos.filter((d) => atestadas.has(d.requestId)).length;
  linhas.push(
    `\n🕒 SONDA POR CRON — ${ativos.length} edge(s) ativa(s), ${ticksRecentes.length} tick(s) recente(s), ` +
      `${respondidos}/${disparos.length} disparo(s) atestado(s)`,
  );
  for (const a of r.achados) linhas.push(`   🔴 ${a.classe} · ${a.edge}: ${a.detalhe}`);
  for (const aviso of r.avisos) linhas.push(`   ⚠️  ${aviso}`);
  if (r.achados.length === 0 && r.avisos.length === 0) {
    linhas.push('   ✅ toda edge ativa foi atestada nos ticks recentes — o bundle do ledger continua no ar');
  }
  return { linhas, achados: r.achados.length, mecanica: null };
}

export function main(argv: string[] = []): number {
  let tolerarNunca: boolean;
  let idsBruto: string | null;
  let json: boolean;
  try {
    tolerarNunca = lerTolerancia(process.env.PENDENCIAS_TOLERAR_NUNCA_ATESTADA);
    idsBruto = lerArgIds(argv);
    json = lerArgJson(argv);
  } catch (e) {
    console.error(`❌ MECÂNICA: ${(e as Error).message}`);
    return 2;
  }

  let esperados: Record<string, Esperado>;
  try {
    esperados = lerEsperados();
  } catch (e) {
    console.error(`❌ MECÂNICA: esperado indeterminável — ${(e as Error).message}`);
    return 2;
  }
  if (Object.keys(esperados).length === 0) {
    console.error('❌ MECÂNICA: mapa de fingerprints VAZIO. Rode `bun run sonda:fingerprint`.');
    return 2;
  }

  // O `--ids` se valida contra o mapa da MAIN, então só aqui: edge fora do mapa é fail-closed.
  let idParaEdge = new Map<number, string>();
  if (idsBruto !== null) {
    try {
      idParaEdge = parsearIds(idsBruto, esperados);
    } catch (e) {
      console.error(`❌ MECÂNICA: ${(e as Error).message}`);
      return 2;
    }
  }

  let saudeBruta: string;
  let saida: string;
  let saidaSemIdentidade: string;
  try {
    saudeBruta = psql(SQL_SAUDE_COLETOR);
    saida = psql(SQL);
    saidaSemIdentidade = psql(SQL_SEM_IDENTIDADE);
  } catch (e) {
    const err = e as Error & { stderr?: string | Buffer };
    const stderr = String(err.stderr ?? '');
    // ASCII em caixa fixa de propósito: `exist` casa "does not exist" E "não existe" (o psql de
    // prod fala português) sem depender de acento nem de `-i` (lição #1483).
    if (stderr.includes('deploy_atestacoes') && stderr.includes('exist')) {
      console.error(
        `❌ MECÂNICA: o ledger public.deploy_atestacoes NÃO existe em prod — a migration\n` +
          `   supabase/migrations/${MIGRATION_LEDGER} ainda não foi aplicada (SQL Editor do Lovable).`,
      );
      return 2;
    }
    console.error(`❌ MECÂNICA: '${PSQL_RO}' falhou — ${err.message}`);
    console.error('   Sem leitura de prod NÃO existe veredito. Isto não é "tudo limpo".');
    return 2;
  }

  const saude = semChatter(saudeBruta);
  const minutos = saude.length === 1 && saude[0] !== 'nunca' ? Number(saude[0]) : NaN;
  if (saude.length !== 1) {
    console.error(
      `❌ MECÂNICA: o cron '${CRON_COLETOR}' não existe em prod — a migration ${MIGRATION_LEDGER} não foi aplicada inteira.`,
    );
    return 2;
  }
  if (!Number.isFinite(minutos) || minutos > COLETOR_TOLERANCIA_MIN) {
    console.error(
      `❌ MECÂNICA: o coletor '${CRON_COLETOR}' não tem execução bem-sucedida há ${saude[0]} min` +
        ` (tolerância ${COLETOR_TOLERANCIA_MIN}). O ledger pode estar desatualizado — confira cron.job_run_details.`,
    );
    return 2;
  }

  const { observacoes, linhasIgnoradas } = parsearObservacoes(saida);
  const { sondas, linhasIgnoradas: ignoradasSemIdentidade } = parsearSondasSemIdentidade(saidaSemIdentidade);
  const ignoradas = linhasIgnoradas + ignoradasSemIdentidade;
  if (ignoradas > 0) {
    console.error(
      `❌ MECÂNICA: ${ignoradas} linha(s) da saída do psql não casaram o formato — a linha descartada pode ser a divergência.`,
    );
    return 2;
  }

  // A atribuída vira observação de primeira classe (id é identidade mais forte que o eco do slug);
  // a não atribuída continua sendo SINAL, sem virar veredito por edge.
  const { observacoes: atribuidas, naoAtribuidas } = atribuirSondasSemIdentidade(sondas, idParaEdge);
  const todas: Observacao[] = [...observacoes, ...atribuidas];
  const linhasSemIdentidade = formatarSemIdentidade(resumirSemIdentidade(naoAtribuidas));

  let rel: Relatorio;
  try {
    rel = julgar(esperados, todas, contextoGit(), ignoradas);
  } catch (e) {
    console.error(`❌ MECÂNICA: ${(e as Error).message}`);
    return 2;
  }

  if (rel.totalObservadas === 0) {
    // A classe sai ANTES do erro: sem ela, "dispare a 1ª leva" mandaria sondar de novo justamente
    // quem já respondeu — o laço que esta correção existe para cortar.
    for (const linha of linhasSemIdentidade) console.error(linha);
    console.error(
      `❌ MECÂNICA: ZERO das ${rel.totalMapeadas} edges mapeadas tem atestação (ledger vazio E janela vazia).`,
    );
    console.error('   Isto é ausência de dado, não aprovação — dispare a 1ª leva com `bun run sonda:sql`.');
    return 2;
  }

  // A sonda por cron (F3): lê os 2 últimos ticks e liga cada resposta ao disparo por `request_id`.
  const estadoPorEdge = new Map(rel.vereditos.map((v) => [v.edge, v.estado as string]));
  const secao = secaoSondaCron(estadoPorEdge, psql);
  if (secao.mecanica !== null) {
    console.error(`❌ MECÂNICA: ${secao.mecanica}`);
    return 2;
  }

  // No modo `--json` o stdout é SÓ o JSON: qualquer outra linha ali quebraria o parse do
  // consumidor, que trataria como não consultado. Avisos vão para o stderr.
  if (json) console.log(serializarRelatorio(rel, { ref: REF_MAIN, tolerarNunca }));
  else imprimir(rel, linhasSemIdentidade);
  for (const linha of secao.linhas) {
    if (json) console.error(linha);
    else console.log(linha);
  }

  const nunca = rel.vereditos.filter((v) => v.estado === 'NUNCA_ATESTADA').length;
  if (tolerarNunca && nunca > 0) {
    const aviso = `\n⚠️  PENDENCIAS_TOLERAR_NUNCA_ATESTADA=1: ${nunca} nunca atestada(s) NÃO contam como pendência nesta execução.`;
    if (json) console.error(aviso);
    else console.log(aviso);
  }
  const exit = decidirExit({
    totalPendentes: rel.totalPendentes,
    nuncaAtestadas: nunca,
    tolerarNunca,
    semIdentidade: naoAtribuidas.length,
  });
  // Achado da sonda por cron é PENDÊNCIA: um silêncio de 2 ticks numa edge que o ledger diz
  // CONFERE é a assinatura de rollback, e sair 0 com isso na tela é o silêncio virando aprovação
  // uma camada acima. Nunca rebaixa um exit 2 de mecânica (que já retornou antes daqui).
  return secao.achados > 0 ? Math.max(exit, 1) : exit;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
