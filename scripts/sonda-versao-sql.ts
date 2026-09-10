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
 *
 * POR QUE A LEITURA NÃO PEDE MAIS O `request_id`: o SQL tinha dois blocos e um `jsonb_each_text('{}')`
 * onde o operador colava, na mão, o JSON devolvido pelo disparo. A colagem que não acontece produz um
 * veredito que se LÊ como problema de deploy — em 2026-08-30, verificando `generate-bundle-argument`,
 * o disparo tinha funcionado (4 respostas HTTP 200) e a leitura devolveu "SEM ID — esta edge não saiu
 * no JSON colado". Honesto, e ainda assim um round-trip inteiro com o founder por um deploy que já
 * estava no ar. A resposta da sonda carrega o slug no próprio corpo, então a leitura acha a linha
 * sozinha; o detalhe (e os dois guards que isso exige) está em `blocoLeitura`.
 *
 * A DIVISÃO DE TRABALHO que sai daí: só o DISPARO precisa do founder — ele lê `vault.decrypted_secrets`
 * e faz INSERT via `net.http_post`, e o wrapper read-only recusa os dois. A leitura é SELECT em
 * `net._http_response`, que o `psql-ro` serve, então o agente lê o veredito sem intermediário.
 * `--so-disparo` e `--so-leitura` recortam exatamente nessa fronteira.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ARQ_MAPA, parsearMapa } from './sonda-fingerprint';

/**
 * Um arquivo que ALIMENTOU o `esperado(...)`, com os BYTES que a geração de fato usou.
 *
 * Os bytes viajam junto com o caminho de propósito. O guard confere o que a GERAÇÃO leu, não o que
 * um segundo `readFileSync` devolveria: duas leituras do mesmo arquivo são duas MEDIÇÕES, o SQL sai
 * da primeira, e conferir a segunda aprova bytes que ninguém emitiu. Desde que a proveniência
 * carrega os bytes, `conferirSincronia` não recebe mais a `raiz` — não tem como reler, e é o
 * compilador que garante isso, não um comentário.
 */
export interface FonteDoEsperado {
  readonly caminho: string;
  readonly bytes: string;
}

/** Uma edge da leva, com o marcador do `versao.ts` dela e o fingerprint da FONTE dela. */
export interface EdgeSondada {
  edge: string;
  versao: string;
  fonte: string;
  /** Os arquivos LIDOS para chegar em `versao` e `fonte` — a fatia que o guard confere. */
  proveniencia: readonly FonteDoEsperado[];
}

/** Caminho do `versao.ts` de uma edge, RELATIVO à raiz do repo (é assim que o `git show` pede). */
function relVersao(edge: string): string {
  return `supabase/functions/${edge}/versao.ts`;
}

/** Caminho do `index.ts` de uma edge, RELATIVO à raiz — onde mora o `contrato:` da canária. */
export function relIndex(edge: string): string {
  return `supabase/functions/${edge}/index.ts`;
}

/** Caminho do `versao.ts` de uma edge, a partir da raiz do repo. */
function caminhoVersao(raiz: string, edge: string): string {
  return join(raiz, relVersao(edge));
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
  // UMA leitura do mapa, e os bytes ficam: são eles que o guard confere. `lerMapaCommitado` leria
  // de novo lá, e o `esperado(...)` teria saído da leitura de cá.
  const bytesMapa = (() => {
    try {
      return readFileSync(join(raiz, ARQ_MAPA), 'utf8');
    } catch {
      return null;
    }
  })();
  const mapa = bytesMapa === null ? {} : parsearMapa(bytesMapa);
  const fonteMapa: FonteDoEsperado[] =
    bytesMapa === null ? [] : [{ caminho: ARQ_MAPA, bytes: bytesMapa }];
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
    resolvidas.push({
      edge,
      versao,
      fonte: mapa[edge],
      // O `versao.ts` DESTA edge (os bytes de que `versao` saiu) e o mapa (de que `fonte` saiu).
      // Nada mais: `supabase/config.toml` decide PARA ONDE a sonda vai, não o que ela espera, e um
      // ref velho falha ALTO (404 do gateway) em vez de virar "bundle velho".
      proveniencia: [{ caminho: relVersao(edge), bytes: textoVersao }, ...fonteMapa],
    });
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

// ============================================================================================
// GUARD DE SINCRONIA — o `esperado(...)` sai do DISCO, e o Lovable deploya a `origin/main`.
// ============================================================================================
//
// O cabeçalho deste arquivo já argumenta que "marcador digitado errado produz VEREDITO FALSO", e
// por isso lê o `versao.ts` e o mapa de fingerprints do repo em vez da memória do operador. O
// buraco é que **"o repo" pode ser um checkout velho**: a mesma falha por outro caminho.
//
// MEDIDO EM 2026-09-05, numa verificação real: o worktree estava em `21e900155`, dois merges atrás
// de `origin/main`. Sondando `enviar-pedido-portal-sayerlack`, o gerador emitiu
// `versao_esperada = v1.5-custo-portal-rpc-cas`; a main já estava em `v1.7-enviado-igual-aprovado`
// (#2194 e #2198 tinham mergeado). A edge no ar respondeu `v1.7` ⇒ o veredito comparado seria
// `v1.7 ≠ v1.5` = "BUNDLE VELHO SERVINDO" numa edge recém-deployada. Falso NEGATIVO de money-path,
// cujo desfecho é redeployar à toa e desconfiar de um deploy correto. Só não saiu errado por
// ACIDENTE: o request tinha 37 min e a janela padrão é 20, então o guard temporal (#2079) devolveu
// INDETERMINADO antes de a comparação acontecer.
//
// O eixo já estava nomeado em `docs/agent/deploy.md`: "o `<sha>` do PR nomeado é a pergunta ERRADA
// — o Lovable deploya a main" (#2123). O gerador não aplicava esse eixo a SI PRÓPRIO.
//
// POR QUE O `git fetch` É DO SCRIPT, E NÃO UM RECADO NO DOC: comparar contra a `origin/main` que
// está em disco é o MESMO defeito um nível acima — o remote-tracking ref também é um retrato, e um
// worktree sincronizado com um `origin/main` de três dias atrás reproduz o falso negativo inteiro.
// "Sincronize antes de MEDIR" (CLAUDE.md) só vale se a sincronização for parte da MEDIÇÃO. Medido
// aqui em 2026-09-05: `git fetch origin main` custa 0,9 s e `git show origin/main:<arq>` custa
// 0,03 s — barato demais para valer um recado que se lê e ignora. E o fetch com refspec ATUALIZA
// `refs/remotes/origin/main` (medido rebaixando o ref à mão e vendo o fetch restaurá-lo), então o
// `origin/main` que a comparação lê é o mesmo que o comando de correção usaria.

/** O que o Lovable deploya. Não é o `<sha>` do PR nomeado: é a MAIN (#2123). */
const REMOTO = 'origin';
const RAMO_DEPLOYADO = 'main';
const REF_DEPLOYADA = `${REMOTO}/${RAMO_DEPLOYADO}`;

/** O comando que conserta o worktree defasado — o mesmo que a mensagem de aborto entrega. */
const CORRECAO = `git fetch ${REMOTO} && git merge --ff-only ${REF_DEPLOYADA}`;

/** Saída crua de um `git`, do jeito que o teste consegue fabricar. */
export interface SaidaGit {
  status: number;
  stdout: string;
  stderr: string;
}

/** Executa `git <args>` na raiz do repo. Injetável: toda a DECISÃO fica na função pura abaixo. */
export type ExecutorGit = (args: string[]) => SaidaGit;

/**
 * `git` de verdade.
 *
 * `status` nulo (morto por sinal, `timeout`, binário ausente) vira 127 e NÃO 0: um spawn que não
 * respondeu é ausência de dado, e ausência de dado aqui precisa cair no ramo fail-CLOSED junto com
 * o erro explícito. Ler `status ?? 0` seria a aprovação fabricada que este guard existe para negar.
 */
export function gitReal(raiz: string): ExecutorGit {
  return (args) => {
    const r = spawnSync('git', args, { cwd: raiz, encoding: 'utf8', timeout: 30_000 });
    if (r.error) return { status: 127, stdout: '', stderr: r.error.message };
    return { status: r.status ?? 127, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/**
 * A fatia da verdade: os arquivos que ALIMENTARAM o `esperado(...)`, com os bytes que alimentaram.
 *
 * Ela não é uma LISTA — é o que o resolvedor registrou ter lido. A lista mantida à parte da lógica
 * de leitura foi o defeito medido em 2026-09-09, e nas DUAS direções: sobrava o mapa de
 * fingerprints no modo canária (que não o lê: `grep -c fingerprint` nos ~20 KB de SQL emitido deu
 * 0, então conferi-lo só produzia bloqueio) e faltava o `index.ts`, de onde o `contrato:` da
 * canária realmente sai — um `contrato:` não mergeado saía como marcador esperado, o guard não
 * notava, e o veredito `CANARIA DE OUTRA FATIA` se lia como deploy pendente. Fatia derivada da
 * leitura não tem como divergir da leitura: quem acrescentar uma dependência ao marcador a
 * acrescenta aqui pelo mesmo gesto.
 *
 * `supabase/config.toml` fica de fora porque o `project_ref` não entra na comparação — ele decide
 * PARA ONDE a sonda vai, e um ref velho falha ALTO (404 do gateway), não vira "bundle velho".
 */
export function fontesDoEsperado(
  resolvidas: ReadonlyArray<{ readonly proveniencia: readonly FonteDoEsperado[] }>,
): FonteDoEsperado[] {
  const porCaminho = new Map<string, string>();
  const brigando: string[] = [];
  for (const f of resolvidas.flatMap((r) => r.proveniencia)) {
    const antes = porCaminho.get(f.caminho);
    if (antes === undefined) porCaminho.set(f.caminho, f.bytes);
    else if (antes !== f.bytes && !brigando.includes(f.caminho)) brigando.push(f.caminho);
  }
  if (brigando.length > 0) {
    throw new Error(
      `o mesmo arquivo foi lido com bytes DIFERENTES dentro desta execução: ` +
        `${brigando.join(', ')}. É a corrida acontecendo — alguém gravou o arquivo entre duas ` +
        'leituras, e o `esperado(...)` saiu de uma delas. Escolher qual conferir é escolher qual ' +
        'metade do veredito é a verdadeira. Repita com o working tree parado. ' +
        'Nenhum SQL foi emitido.',
    );
  }
  return [...porCaminho]
    .map(([caminho, bytes]) => ({ caminho, bytes }))
    .sort((a, b) => a.caminho.localeCompare(b.caminho));
}

/** O que o guard concluiu. `aviso` só existe no caminho `--sem-rede`, que degradou de propósito. */
export interface ResultadoSincronia {
  aviso: string | null;
}

/**
 * Confere que a fatia da verdade no working tree é IDÊNTICA à de `origin/main`, ou LANÇA.
 *
 * Recebe as FONTES (caminho + bytes), não a raiz e uma lista de edges. Duas consequências, e as
 * duas são o desenho: a fatia passa a depender do MODO — quem resolveu o marcador é quem diz o que
 * o alimentou — e não há como reler o disco daqui, porque a raiz não chega. O que se confere é o
 * que se emitiu.
 *
 * Fail-CLOSED em seis portas, e nenhuma delas degrada para warning: um aviso que se lê e ignora
 * devolve exatamente o veredito falso de 2026-09-05, só que com uma linha de texto por cima.
 *
 *  0. fatia VAZIA ⇒ aborta: não ter conferido nada não é ter conferido e aprovado.
 *  1. `git` que não responde (binário ausente, timeout, não é repo) ⇒ aborta.
 *  2. `fetch` que falha ⇒ aborta nomeando `--sem-rede`, a única escada explícita.
 *  3. `origin/main` que não existe nem depois do fetch ⇒ aborta: não há com o que comparar, e
 *     ausência de dado não é aprovação.
 *  4. arquivo da fatia que não existe em `origin/main` ⇒ aborta: é bump que ainda NÃO mergeou, e a
 *     edge no ar nunca vai responder um marcador que só existe neste branch.
 *  5. conteúdo diferente ⇒ aborta nomeando as edges e o comando de correção.
 *
 * `--sem-rede` NÃO desliga o guard: pula só o `fetch`, e a comparação continua acontecendo contra o
 * `origin/main` que está em disco. Divergência achada contra um ref velho é dado POSITIVO de
 * defasagem e aborta igual; o que a flag admite é o inverso — bater contra um retrato velho não
 * prova sincronia. Por isso o caminho degradado IMPRIME a idade do ref, no stderr e no topo do SQL:
 * o SQL é o artefato que sobrevive (colado num chat, num PR), o stderr some.
 *
 * POR QUE `--sem-rede` EXISTE, em vez de travar: sem rede o veredito é inalcançável de qualquer
 * jeito — o disparo é `net.http_post` contra o Supabase e a leitura é `psql-ro` contra a prod. O
 * único uso real do gerador offline é preparar o texto para colar depois, e travar isso custaria
 * mais que o defeito que o guard fecha. A flag é explícita justamente para não ser o padrão.
 */
export function conferirSincronia(
  fontes: readonly FonteDoEsperado[],
  semRede: boolean,
  git: ExecutorGit,
): ResultadoSincronia {
  // Porta 0 — fatia VAZIA. Não ter conferido nada não é ter conferido e aprovado: um modo novo que
  // esqueça de registrar proveniência faria o guard passar em silêncio, e silêncio aqui se lê como
  // "o disco está na main". É o `ausente ≠ zero` do money-path aplicado à própria fatia.
  if (fontes.length === 0) {
    throw new Error(
      'fatia VAZIA: nenhum arquivo foi registrado como fonte do `esperado(...)`, então não há o ' +
        'que comparar com a ' +
        `${REF_DEPLOYADA} — e ausência de dado não é aprovação. Quem resolve o marcador tem de ` +
        'declarar de que arquivos ele saiu (`proveniencia`). Nenhum SQL foi emitido.',
    );
  }
  if (!semRede) {
    const f = git(['fetch', REMOTO, RAMO_DEPLOYADO]);
    if (f.status !== 0) {
      throw new Error(
        `não consegui \`git fetch ${REMOTO} ${RAMO_DEPLOYADO}\` (status ${f.status}): ` +
          `${primeiraLinha(f.stderr)}. O \`esperado(...)\` sai do DISCO e o Lovable deploya a ` +
          `${REF_DEPLOYADA}: sem confirmar que o disco é a main, um veredito "BUNDLE VELHO" pode ` +
          'ser só este worktree atrasado. Sem rede, repita com `--sem-rede` — a comparação ainda ' +
          `acontece, contra a ${REF_DEPLOYADA} que está em disco, e o SQL sai dizendo isso. ` +
          'Nenhum SQL foi emitido.',
      );
    }
  }

  const rev = git(['rev-parse', '--verify', '--quiet', REF_DEPLOYADA]);
  if (rev.status !== 0 || rev.stdout.trim() === '') {
    throw new Error(
      `${REF_DEPLOYADA} não existe neste repo${semRede ? ' e --sem-rede proíbe buscá-la' : ''} — ` +
        'não há contra o que conferir se o disco está sincronizado, e ausência de dado não é ' +
        `aprovação. Rode \`git fetch ${REMOTO}\` num repo com o remote configurado. ` +
        'Nenhum SQL foi emitido.',
    );
  }

  const ausentes: string[] = [];
  const divergentes: string[] = [];
  for (const { caminho, bytes } of fontes) {
    const r = git(['show', `${REF_DEPLOYADA}:${caminho}`]);
    if (r.status !== 0) {
      ausentes.push(caminho);
      continue;
    }
    // `bytes`, e não um `readFileSync` daqui: o que se confere tem de ser o que se EMITIU.
    if (r.stdout !== bytes) divergentes.push(caminho);
  }

  if (ausentes.length > 0 || divergentes.length > 0) {
    const problemas: string[] = [];
    if (divergentes.length > 0) {
      problemas.push(`difere de ${REF_DEPLOYADA}: ${divergentes.join(', ')}`);
    }
    if (ausentes.length > 0) {
      problemas.push(`não existe em ${REF_DEPLOYADA}: ${ausentes.join(', ')}`);
    }
    throw new Error(
      `working tree DESSINCRONIZADO da ${REF_DEPLOYADA} na fatia que vira o \`esperado(...)\` — ` +
        `${problemas.join(' | ')}. O marcador e o fingerprint sairiam deste disco e o veredito ` +
        `compararia com o que a ${REF_DEPLOYADA} deployou: divergência aqui produz "BUNDLE VELHO ` +
        'SERVINDO" numa edge que está no ar (falso NEGATIVO — o desfecho é redeployar money-path ' +
        `à toa). Sincronize e repita: \`${CORRECAO}\`. Se o bump é SEU e ainda não mergeou, não há ` +
        'o que sondar: a edge no ar não serve um marcador que só existe neste branch. ' +
        'Nenhum SQL foi emitido.',
    );
  }

  if (!semRede) return { aviso: null };
  const data = git(['log', '-1', '--format=%ci', REF_DEPLOYADA]);
  const idade = data.status === 0 && data.stdout.trim() !== '' ? data.stdout.trim() : 'data desconhecida';
  return {
    aviso:
      `⚠️ --sem-rede: NÃO busquei a ${REF_DEPLOYADA}; comparei contra a cópia em disco, de ${idade} ` +
      `(${rev.stdout.trim().slice(0, 9)}). O veredito é sobre ESTE disco — se a main andou desde ` +
      'então, "BUNDLE VELHO" pode ser este worktree atrasado, não a edge.',
  };
}

/** Primeira linha não-vazia de um stderr, para a mensagem não virar um despejo de git. */
function primeiraLinha(texto: string): string {
  return texto.split('\n').find((l) => l.trim() !== '')?.trim() ?? '(sem stderr)';
}

export interface OpcoesLeva {
  raiz: string;
  edges: string[];
  /**
   * Subconjunto de `edges` cujo bundle PRÉ-sensor IGNORA o `probe` e dispara o fluxo real (PO no
   * ERP, pedido no portal do fornecedor). O disparo delas sai em bloco separado, com trava.
   */
  caras?: string[];
  /** Janela do guard temporal da leitura, em minutos. Ver `JANELA_PADRAO_MIN`. */
  janelaMin?: number;
  /** Emite SÓ os blocos de disparo — o recorte que o founder cola no SQL Editor. */
  soDisparo?: boolean;
  /** Emite SÓ os blocos de leitura — o recorte que o agente roda no `psql-ro`. */
  soLeitura?: boolean;
  /**
   * A leva JÁ resolvida, quando quem chama precisa que o SQL saia dos MESMOS bytes que conferiu.
   *
   * É o caso da CLI: ela resolve, entrega a proveniência ao guard de sincronia e passa a leva de
   * volta aqui. Sem isto, resolver de novo relê o disco — e o que o guard aprovou não seria,
   * necessariamente, o que o SQL emitiu. Omitido, resolve daqui (o caminho dos testes de unidade).
   */
  resolvida?: readonly EdgeSondada[];
}

/**
 * Janela do guard temporal, e por que ela tem TETO.
 *
 * O piso e o teto são o guard do #2079 em forma executável: a leitura casa a resposta pelo ECO do
 * slug, então uma sondagem ANTIGA da mesma edge — o `pg_net.ttl` guarda 6h — seria lida como
 * veredito de agora se a janela fosse larga. Janela maior que o teto não é "mais tolerante", é o
 * guard desligado; quem quer olhar a janela inteira do TTL já tem a ferramenta certa, que é a irmã
 * PASSIVA (`bun run pendencias:deploy`), e ela sabe que "não observada" ≠ "confere".
 */
const JANELA_PADRAO_MIN = 20;
const JANELA_MAX_MIN = 120;

/** Valida a janela ou LANÇA — nunca degrada para o padrão, que é o guard escolhendo sozinho. */
function validarJanela(janelaMin: number | undefined): number {
  if (janelaMin === undefined) return JANELA_PADRAO_MIN;
  if (!Number.isInteger(janelaMin) || janelaMin < 1 || janelaMin > JANELA_MAX_MIN) {
    throw new Error(
      `--janela precisa ser um inteiro de 1 a ${JANELA_MAX_MIN} minutos (recebi ${janelaMin}). ` +
        'A janela CURTA é o guard que impede uma sondagem antiga de virar veredito de agora ' +
        '(#2079); afrouxá-la sem teto é desligá-lo. Para varrer a janela inteira do pg_net.ttl ' +
        'use `bun run pendencias:deploy`, que trata "não observada" como ausência de dado. ' +
        'Nenhum SQL foi emitido.',
    );
  }
  return janelaMin;
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

/**
 * Teto de tempo do `net.http_post`, em ms. É CONSTANTE, e não literal repetido, porque a regra é
 * uma só e vale para toda chamada: o default do pg_net é 5s e mata em SILÊNCIO (`sync.md`). Duas
 * cópias do número são duas verdades, e a que ninguém atualiza é a que decide errado.
 */
const TIMEOUT_HTTP_MS = 20000;

/**
 * A trava do bloco caro, como CASE — nunca como filtro. O Postgres avalia a projeção mesmo
 * descartando todas as linhas, então travar por `WHERE` deixa o `http_post` sair igual. Também
 * mora aqui por ser uma verdade só: os blocos de disparo da sonda e da canária a compartilham.
 */
const TRAVA_CASE = "CASE WHEN g.confirmei_o_deploy = 'sim'";

/**
 * O que muda entre o disparo da SONDA e o da CANÁRIA — e SÓ isso muda.
 *
 * `url` é o que vai DEPOIS de `/functions/v1/` (a canária concatena um sufixo de query, porque a
 * `carteira-rebuild` se acorda por `?canary=1`); `corpo` é a expressão do `body` (a sonda manda um
 * `{probe:true}` fixo, a canária lê da LINHA, porque as 8 não têm corpo uniforme).
 */
interface AlvoDoDisparo {
  readonly url: string;
  readonly corpo: string;
}

const ALVO_SONDA: AlvoDoDisparo = { url: 'a.edge', corpo: "jsonb_build_object('probe', true)" };
const ALVO_CANARIA: AlvoDoDisparo = { url: 'a.edge || a.sufixo', corpo: 'a.corpo' };

/**
 * A chamada `net.http_post` dos DOIS blocos de disparo.
 *
 * Era duplicada (sonda × canária) e o que a cópia carregava junto eram os HEADERS — que nenhuma
 * das duas suítes vigiava (medido 2026-09-08: `grep -c 'x-cron-secret'` no teste = 0). O drift
 * silencioso que isso permitia é caro e se lê como o contrário do que é: header errado ⇒ 401 SÓ na
 * leva ⇒ o `controle_credencial` (que mede tráfego de FORA da leva) segue verde ⇒ o veredito sai
 * `BUNDLE VELHO (pre-sonda)` / `SEM CANARIA NO AR` CONFIANTE, e o desfecho é redeploy à toa de uma
 * edge que já estava no ar. Com uma cópia só, o header é uma verdade só — e as asserções que o
 * pinam valem para os dois modos por CONSTRUÇÃO, não por disciplina de quem copia.
 */
function httpPost(ref: string, indent: string, alvo: AlvoDoDisparo): string {
  const i = indent;
  return (
    `net.http_post(\n` +
    `${i}  url := 'https://${ref}.supabase.co/functions/v1/' || ${alvo.url},\n` +
    `${i}  headers := jsonb_build_object(\n` +
    `${i}    'Content-Type', 'application/json',\n` +
    `${i}    'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets\n` +
    `${i}                      WHERE name = 'CRON_SECRET' LIMIT 1)),\n` +
    `${i}  body := ${alvo.corpo},\n` +
    `${i}  timeout_milliseconds := ${TIMEOUT_HTTP_MS})`
  );
}

/**
 * De onde o CTE `ids` da leitura tira o mapa `edge → request_id`.
 *
 * `eco` é o bloco standalone (`--so-leitura`): o `{}` fica como está e a linha se acha pelo eco do
 * slug. `embutido` é o passo de leitura que o passo de DISPARO escreve por `format()` — o mapa já
 * vem dentro, e nenhum identificador passa pela mão de ninguém. Os dois textos saem da MESMA
 * função de propósito: duas cópias do veredito divergiriam, e a que o founder recebe é a embutida.
 */
type FonteDosIds =
  | { readonly modo: 'eco' }
  | { readonly modo: 'embutido'; readonly expr: string; readonly passoDisparo: number };

const ECO: FonteDosIds = { modo: 'eco' };

/**
 * Marcador do lugar do mapa dentro do texto que vira argumento de `format()`.
 *
 * Existe para que o escape de `%` (obrigatório: `format()` lê `%` como diretiva) rode sobre o
 * corpo INTEIRO antes de o placeholder entrar — na ordem inversa, o próprio `%1$L` viraria `%%1$L`
 * e o mapa sairia literal no passo seguinte. Caractere de controle porque não aparece em SQL.
 */
export const SENTINELA_MAPA = '\u0001mapa\u0001';

/** Tag do dollar-quoting que embrulha o passo de leitura dentro do `format()`. */
const TAG_SONDA = '$sonda$';

/**
 * Fecha o `format()` e batiza a célula que o operador copia. Verdade ÚNICA para os dois blocos de
 * disparo (sonda e canária): o nome da coluna é o que diz ao operador que ali mora um SQL pronto,
 * e não um blob de ids para transportar à mão — duas cópias divergiriam, e a que diverge é a que
 * devolve o operador ao round-trip que `docs/historico/sonda-request-id-a-mao.md` fechou.
 */
function rodapeDoFormat(passoLeitura: number): string {
  return `${TAG_SONDA}, m.ids) AS passo_${passoLeitura}_copie_esta_celula\nFROM mapa m;\n`;
}

/**
 * Bloco de DISPARO — o único que precisa do founder: lê `vault.decrypted_secrets` e faz INSERT via
 * `net.http_post`, e o wrapper read-only recusa os dois (`permission denied for schema vault` e
 * `cannot execute INSERT in a read-only transaction`, provado 2026-08-30).
 *
 * O id e o nome da edge saem agregados na MESMA execução (`jsonb_object_agg`), e desde 2026-09-06 o
 * agregado não é mais ENTREGUE ao operador: ele é interpolado por `format()` no texto do passo
 * seguinte, que sai pronto numa célula única. O que se copia é a célula, não o número — é a mesma
 * correção que o bloco de UMA edge recebeu, pela mesma razão (docs/historico/sonda-request-id-a-mao.md):
 * identificador transportado à mão troca o alvo em silêncio, e a resposta de cron que ele acerta por
 * acidente tem exatamente a assinatura de "bundle velho".
 *
 * São DOIS blocos por imposição do pg_net, não por ergonomia: o `http_post` só ENFILEIRA, e o worker
 * de fundo enxerga apenas linha COMMITADA — dentro do mesmo batch (o SQL Editor roda tudo como UMA
 * transação) a requisição ainda não saiu. `pg_sleep`, temp table e `\gset` não contornam isso.
 */
function blocoDisparo(
  ref: string,
  leva: EdgeSondada[],
  passoDisparo: number,
  janelaMin: number,
  comTrava = false,
): string {
  const passoLeitura = passoDisparo + 1;
  const cabeca = comTrava
    ? `WITH guard(confirmei_o_deploy) AS (VALUES ('nao')),  -- ⬅️ 'nao' → 'sim' só DEPOIS do verde\n` +
      `alvos(edge) AS (VALUES\n${valuesAlvos(leva)}\n),\n`
    : `WITH alvos(edge) AS (VALUES\n${valuesAlvos(leva)}\n),\n`;
  const projecao = comTrava
    ? `         ${TRAVA_CASE}\n` +
      `              THEN ${httpPost(ref, '                   ', ALVO_SONDA)}\n` +
      `         END AS request_id\n` +
      `  FROM alvos a CROSS JOIN guard g\n`
    : `         ${httpPost(ref, '         ', ALVO_SONDA)} AS request_id\n` + `  FROM alvos a\n`;
  return (
    cabeca +
    `disparos AS (\n` +
    `  SELECT a.edge,\n` +
    projecao +
    `),\n` +
    `mapa AS (\n` +
    `  -- O par (edge, id) é agregado na MESMA execução que disparou: o request_id nunca existe\n` +
    `  -- solto, e por isso não há como colá-lo na linha da edge errada.\n` +
    `  SELECT jsonb_object_agg(edge, request_id)::text AS ids FROM disparos\n` +
    `)\n` +
    `-- O PASSO ${passoLeitura} sai ESCRITO na célula abaixo, com o mapa já dentro. Copie a célula\n` +
    `-- INTEIRA e rode/entregue como está: não há número a anotar nem campo a preencher.\n` +
    `SELECT format(${TAG_SONDA}\n` +
    corpoDoPassoDeLeitura(leva, janelaMin, passoDisparo) +
rodapeDoFormat(passoLeitura)
  );
}

/**
 * O texto do passo de leitura, pronto para virar o 1º argumento de `format()`.
 *
 * Duas conversões, nesta ordem, e a ordem é a correção: (1) todo `%` do corpo vira `%%`, senão
 * `format()` o interpreta como diretiva e aborta ou corrompe o SQL emitido; (2) só então o
 * sentinela vira `%1$L`, que interpola o mapa como LITERAL — `%L` cita e escapa sozinho, e devolve
 * `NULL` sem aspas (e não `''`) quando o agregado é nulo, o que o `jsonb_each_text` lê como zero
 * pares, não como erro. Só que esse caso é o de `disparos` com ZERO linhas, e NÃO o da trava
 * fechada, como esta linha dizia até 2026-09-09: a trava é um `CASE` que preserva a linha com
 * `request_id` nulo, então o agregado sai `{"nome": null}` — um par de valor nulo, medido no PG17,
 * não um agregado nulo. O dollar-quoting é conferido antes: corpo que contenha a tag encerraria
 * a string no meio e o passo seguinte sairia truncado — fail-CLOSED, com o nome do que colidiu.
 */
function corpoDoPassoDeLeitura(
  leva: EdgeSondada[],
  janelaMin: number,
  passoDisparo: number,
): string {
  const passoLeitura = passoDisparo + 1;
  const texto =
    `-- PASSO ${passoLeitura} — lê e julga. O mapa edge→id já está EMBUTIDO aqui, escrito pelo passo\n` +
    `--          ${passoDisparo}: nada a colar. Espere ~10s pela resposta HTTP. É SELECT puro —\n` +
    `--          roda no read-only: cole no chat, ou em ~/.config/afiacao/psql-ro\n` +
    blocoLeitura(leva, janelaMin, {
      modo: 'embutido',
      expr: SENTINELA_MAPA,
      passoDisparo,
    });
  return escaparParaFormat(texto);
}

/**
 * Prepara um texto para virar o 1º argumento de `format()`: escapa `%` e planta o `%1$L`.
 *
 * Exportada porque é AQUI que as duas armadilhas do `format()` moram, e nenhuma delas aparece no
 * SQL emitido hoje (o corpo atual não tem `%` nem `$`): sem um teste direto, as duas ficariam
 * cobertas por acidente do corpus — verdes até o dia em que alguém escrever um `%` num comentário.
 */
export function escaparParaFormat(texto: string): string {
  if (texto.includes(TAG_SONDA)) {
    throw new Error(
      `o texto contém a tag de dollar-quoting ${TAG_SONDA} e sairia TRUNCADO dentro do ` +
        '`format()` — o passo seguinte seria emitido pela metade e ninguém veria. Troque a ' +
        'TAG_SONDA por uma que não apareça no corpo. Nenhum SQL foi emitido.',
    );
  }
  // A ordem é a correção: escapar DEPOIS de plantar o placeholder transformaria `%1$L` em `%%1$L`,
  // e o mapa sairia literal — o passo seguinte leria a string "%1$L" como se fosse o JSON.
  return texto.replaceAll('%', '%%').replaceAll(SENTINELA_MAPA, () => '%1$L');
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
export const PISO_CONTROLE_CREDENCIAL = 10;

/**
 * A prosa que MUDA entre os dois modos no CTE do controle de credencial. A mecânica não muda —
 * por isso ela vive numa cópia só, logo abaixo — mas a AMBIGUIDADE que o controle desfaz é
 * diferente em cada um, e essa diferença é o que o operador lê para decidir.
 *
 * `exclusao` aceita '' quando o modo não tem nada a acrescentar ali. O que o controle NÃO fecha
 * NÃO é parâmetro: é limitação da mecânica, e por isso o aviso é emitido pela própria função.
 */
interface ProsaDoControle {
  /** Por que o 401 DESTE modo é ambíguo, e o que o controle prova. */
  readonly cabeca: string;
  /** O que a exclusão da própria leva vale neste modo (depende de o mapa `ids` estar cheio). */
  readonly exclusao: string;
}

/**
 * O CTE `controle_credencial` — a MECÂNICA, compartilhada pela sonda e pela canária.
 *
 * Era duplicada, e a cópia da canária nasceu SEM as asserções que davam sentido aos números
 * (medido 2026-09-08: `BETWEEN 200 AND 299`, `= 401` e `interval '6 hours'` eram pinados só no
 * bloco da sonda — na cópia, `BETWEEN 200 AND 499` ou `interval '6 days'` passava a suíte). Com
 * uma cópia só, essas asserções valem para os DOIS modos por construção.
 *
 * O que ele decide: `ok_recentes` e `recusas_recentes` são a única prova de que o CRON_SECRET está
 * sendo aceito AGORA. Sem eles o 401 é ambíguo e o veredito honesto é INDETERMINADO — com eles,
 * cada bloco DETERMINA o seu próprio veredito, e é por isso que o veredito NÃO mora aqui.
 */
function cteControleCredencial(prosa: ProsaDoControle): string {
  return (
    'controle_credencial AS (\n' +
    prosa.cabeca +
    '  SELECT count(*) FILTER (WHERE r.status_code BETWEEN 200 AND 299) AS ok_recentes,\n' +
    '         count(*) FILTER (WHERE r.status_code = 401)               AS recusas_recentes\n' +
    '  FROM net._http_response r\n' +
    "  WHERE r.created > now() - interval '6 hours'\n" +
    '    -- A própria leva não pode se avalizar: sem isto, o 401 que estamos julgando entra na\n' +
    '    -- contagem de recusas e o controle se auto-envenena (nenhum 401 seria explicável nunca).\n' +
    '    -- NOT EXISTS, não NOT IN: a trava fechada do bloco caro devolve request_id NULL, e\n' +
    '    -- `NOT IN` com NULL é NULL-blind — zeraria o controle inteiro em silêncio.\n' +
    prosa.exclusao +
    '    AND NOT EXISTS (SELECT 1 FROM ids id_leva WHERE id_leva.request_id = r.id)\n' +
    // A ressalva vale para os DOIS modos porque é limitação da MECÂNICA, não do veredito — e até
    // 2026-09-08 só o bloco da sonda a carregava, deixando quem lia a canária sem o mesmo aviso.
    '    -- ⚠️ O que este controle NAO fecha: ele é HISTORICO. Prova que ALGUM trafego recente\n' +
    '    --    passou, nao que ESTA leva mandou a credencial certa — e nao diz qual credencial\n' +
    '    --    autenticou os 2xx que ele contou. Duas manifestacoes da mesma limitacao:\n' +
    '    --    (a) CRON_SECRET trocado ha poucos minutos E nenhum cron rodado desde a troca — o\n' +
    '    --        trafego 2xx da janela usou o secret ANTIGO e avaliza indevidamente;\n' +
    '    --    (b) o proprio disparo mandando header errado — a leva toma 401, os ids dela ficam\n' +
    '    --        FORA da contagem, e o controle segue verde avalizando um transporte quebrado.\n' +
    '    --    Nos dois casos o veredito determinado abaixo sai CONFIANTE e errado. Na proxima\n' +
    '    --    execucao dos crons (a) vira 401 e o controle se desqualifica sozinho; (b) nao se\n' +
    '    --    corrige sozinho — e por isso os headers sao vigiados no gerador, pela suite.\n' +
    '    --    Se voce ACABOU de mexer no vault, trate o veredito determinado como INDETERMINADO.\n' +
    '),\n'
  );
}

/**
 * A prosa e o PREDICADO que mudam entre os dois modos no CTE do controle ATIVO.
 *
 * `alias` é como o modo batiza o `lidas` (a sonda usa `l`, a canária `ca`); `testemunha` é o
 * predicado de IDENTIDADE VERIFICADA — o que separa "respondeu" de "respondeu PROVANDO ser o
 * bundle do repo". Ele muda porque o eco muda (a sonda ecoa `probe`+`versao`+`fonte`; a canária
 * ecoa `canary`+marcador), mas a MECÂNICA de contagem não muda, e por isso vive numa cópia só.
 */
interface ProsaDoControleAtivo {
  /** Por que a testemunha DESTE modo prova a credencial do disparo. */
  readonly cabeca: string;
  /** Alias do `lidas` neste modo. */
  readonly alias: string;
  /** Predicado que faz de uma linha lida uma TESTEMUNHA de credencial aceita. */
  readonly testemunha: string;
}

/**
 * O CTE `controle_ativo` — a prova de credencial ATRIBUÍDA A ESTA LEVA. Compartilhado.
 *
 * POR QUE ELE EXISTE, e por que o `controle_credencial` não bastava. O histórico é POPULACIONAL:
 * conta tráfego de FORA da leva e conclui "o CRON_SECRET está sendo aceito". Isso prova que ALGUM
 * tráfego recente passou — não que ESTE disparo mandou a credencial certa, e não diz QUAL
 * credencial autenticou os 2xx que contou. A manifestação cara é o disparo com header errado: a
 * leva inteira toma 401, os ids dela ficam FORA da contagem (pelo `NOT EXISTS`), o histórico segue
 * VERDE e o veredito sai `BUNDLE VELHO` CONFIANTE — redeploy à toa de uma edge que já estava no ar.
 * Essa manifestação NÃO se corrige sozinha, e nenhuma asserção sobre o gerador a alcança: o #2424
 * pinou os headers contra DRIFT NO CÓDIGO, mas o segredo pode estar errado/expirado no VAULT no
 * instante do disparo, com o código intacto.
 *
 * ⚠️ POR QUE A TESTEMUNHA É IDENTIDADE, E NÃO STATUS 2xx. Foi a primeira versão deste controle, e
 * ela era fail-OPEN. O parecer Codex (gpt-6-astra, 2026-09-09) derrubou-a com um contraexemplo do
 * próprio repo: `monthly-report@ef08dddd2` é um bundle HISTÓRICO que ignora a credencial e manda
 * e-mail para QUALQUER POST — responde 200 sem autenticar nada (o `sonda-relay/index.ts` documenta
 * esse histórico). Como `resolverLeva()` aceita `monthly-report`, uma leva com esse bundle no ar
 * produziria `aceitas >= 1` com a credencial INVÁLIDA. O erro de raciocínio tem nome: medir o gate
 * no código da MAIN para afirmar uma propriedade do bundle NO AR — quando a razão de existir deste
 * gerador é justamente que os dois divergem.
 *
 * O reparo é exigir que a resposta se IDENTIFIQUE: `versao` E `fonte` iguais às esperadas (sonda),
 * marcador igual ao esperado (canária). Aí a cadeia fecha em três elos, e nenhum deles é suposição:
 *   1. o `fonte` é o sha256 do arquivo servido ⇒ o bundle no ar é VERBATIM o do repo;
 *   2. no repo, o gate `authorizeCron*` roda ANTES de emitir a resposta (medido 60/60 em
 *      2026-09-09, e desde então IMPOSTO por `scripts/gate-sonda-autentica.ts` no CI);
 *   3. o `request_id` amarra a resposta a ESTE disparo, não a tráfego de fundo.
 * Logo o `x-cron-secret` deste disparo foi ACEITO — ativo, autenticado e atribuído. O bundle
 * anônimo do contraexemplo não passa por (1), e um gate `Bearer` (a `recommend` histórica) recusa o
 * nosso disparo, que não manda `Authorization`.
 *
 * ⚠️ ZERO TESTEMUNHA É AUSÊNCIA DE DADO, NÃO "NINGUÉM ACEITOU" — e por isso os quatro contadores
 * são SEPARADOS em vez de um zero só: `pendentes` (sem resposta ainda) e `falhas` (transporte
 * morreu: no pg_net 0.19.5 o erro grava `error_msg` e deixa o status NULL, e `timed_out` fica NULL
 * no estouro — #2015) não são recusa. A mensagem diz "nenhuma aceitação foi OBSERVADA" com o
 * denominador, nunca "nenhum disparo foi aceito": `ausente ≠ zero` aplicado ao próprio controle.
 *
 * Ele lê de `lidas`, não de `net._http_response` — de propósito, e isso é o que dá COERÊNCIA: o
 * controle conta exatamente as linhas que o veredito julga. Contar por fora abriria a porta de o
 * controle falar de uma execução e o veredito de outra.
 */
function cteControleAtivo(prosa: ProsaDoControleAtivo): string {
  const a = prosa.alias;
  return (
    'controle_ativo AS (\n' +
    prosa.cabeca +
    '  SELECT count(*)                                            AS disparos_na_leva,\n' +
    `         count(*) FILTER (WHERE ${prosa.testemunha})  AS aceitas_na_leva,\n` +
    `         count(*) FILTER (WHERE ${a}.status_code = 401)           AS recusadas_na_leva,\n` +
    `         count(*) FILTER (WHERE ${a}.status_code IS NULL\n` +
    `                            AND ${a}.erro_transporte IS NULL)     AS pendentes_na_leva,\n` +
    `         count(*) FILTER (WHERE ${a}.erro_transporte IS NOT NULL) AS falhas_na_leva\n` +
    `  FROM lidas ${a}\n` +
    // Só linha DISPARADA entra no denominador: com a trava fechada o request_id é NULL e nada
    // saiu, e contá-la inflaria `disparos_na_leva` — o denominador da mensagem mentiria.
    `  WHERE ${a}.request_id IS NOT NULL\n` +
    // SEM vírgula: este é sempre o ÚLTIMO CTE dos dois blocos, e o `SELECT` final vem logo abaixo.
    ')\n'
  );
}

/**
 * O texto que o veredito do 401 usa para EXIBIR o controle histórico sem deixá-lo decidir.
 *
 * O histórico saiu da decisão porque o ativo o SUBSUME: se a credencial foi aceita AGORA por um
 * request DESTA leva, o que 52 crons fizeram nas últimas 6h não acrescenta prova — e exigi-lo
 * junto (AND) só cobraria recall sem comprar precisão. Continua EXIBIDO porque quem lê o
 * INDETERMINADO precisa enxergar o fundo para decidir o próximo passo.
 */
function contextoHistorico(alias: string): string {
  return (
    `' Trafego de fundo (6h, fora desta leva, NAO decide o veredito): ' || ${alias}.ok_recentes ||\n` +
    `                ' resposta(s) 2xx e ' || ${alias}.recusas_recentes || ' recusa(s) 401' ||\n` +
    // O piso perdeu o poder de DECIDIR quando o ativo assumiu, mas não perdeu o sentido: ele é o
    // denominador que separa "o fundo está limpo" de "quase ninguém bateu na porta". Sem ele, um
    // `0 2xx e 0 recusas` se leria como fundo saudável, que é o oposto do que esse par diz.
    `                CASE WHEN ${alias}.ok_recentes < ${PISO_CONTROLE_CREDENCIAL}\n` +
    `                     THEN ' — fundo ANORMALMENTE QUIETO (abaixo do piso de ` +
    `${PISO_CONTROLE_CREDENCIAL} em 6h): nem como contexto ele informa.'\n` +
    `                     ELSE '.' END`
  );
}

/**
 * Bloco de LEITURA e veredito. NÃO exige colar `request_id` nenhum.
 *
 * COMO ELE ACHA A LINHA SOZINHO: a resposta da sonda ecoa o próprio slug —
 * `criarRespostaSonda` (`_shared/sonda-versao.ts`) devolve `{ok, probe, versao, edge, fonte}`. Então
 * a leitura procura, na janela, a resposta que diz ser desta edge. O `request_id` viajava de um
 * passo para o outro NA MÃO do operador, e a colagem que não acontece produz veredito que se LÊ
 * como problema de deploy: em 2026-08-30, verificando `generate-bundle-argument`, o disparo tinha
 * funcionado (4 respostas HTTP 200) e o veredito saiu "SEM ID — esta edge não saiu no JSON colado
 * (bloco errado, ou trava fechada)". Honesto, mas custou um round-trip inteiro com o founder por um
 * deploy que já estava no ar.
 *
 * O CASAMENTO EXIGE `probe = 'true'`, NÃO SÓ O SLUG. Medido em prod no mesmo dia: a
 * `analytics-outbox-drain` gravou 72 respostas em 6h com `{"edge":…,"versao":…}` e SEM `probe` — é o
 * cron dela, de 5 em 5 minutos — contra 5 respostas de sonda. Casando só pelo slug, o `LIMIT 1`
 * escolhe a linha do CRON, cujo `probe` é nulo, e o veredito cai no ELSE: "BUNDLE VELHO" citando a
 * versão CERTA. Falso NEGATIVO gerado pela linha de OUTRA execução — e o desfecho é redeployar edge
 * à toa. O `probe:true` é o que separa "resposta a uma SONDA" de "resposta a um run real".
 *
 * A JANELA É OBRIGATÓRIA (guard do #2079): sem ela, uma resposta de sondagem ANTIGA — a mesma edge
 * respondeu ontem, e o `pg_net.ttl` guarda 6h — seria lida como veredito de AGORA. E o desempate por
 * `id` não é enfeite: em prod as respostas 64031 e 64032 têm `created` idêntico ao microssegundo,
 * então `ORDER BY created DESC` sozinho deixa a escolha para o plano, não para o dado.
 *
 * O QUE O ECO NÃO ALCANÇA, e por isso o `ids` sobrevive como OPCIONAL: bundle PRÉ-SENSOR (HTTP 200
 * rodando o fluxo real) e recusa HTTP (>=400) respondem SEM eco do slug — são invisíveis para esta
 * busca, e caem em INDETERMINADO. Contar as respostas sem eco na janela NÃO os identifica: a janela
 * é cheia de cron alheio (72 linhas de uma edge só, acima). Quem separa é o `request_id` do disparo,
 * e é só para isso que a colagem continua existindo.
 *
 * Ausência de linha ⇒ INDETERMINADO explícito, NUNCA "bundle velho": é ausência de dado, e o ramo
 * nomeia as três causas que ele não distingue em vez de escolher uma. Mesmo motivo do
 * `LEFT JOIN LATERAL … ON true` e de partir da lista CANÔNICA: a consulta devolve SEMPRE uma linha
 * por edge esperada, porque zero linhas se lê como "nada a reportar", não como "não achei".
 * OS DOIS RAMOS DO `fonte` QUE FALTA — e por que UM só mentia. Ambos vêm ANTES do de confirmação
 * de propósito (ler qualquer um deles como CONFIRMADO seria o falso POSITIVO que encerra a
 * verificação), mas a CAUSA é oposta e o `COALESCE(fonte,'nao-mapeada')` original os fundia:
 *   · **campo AUSENTE do corpo** (`NOT (corpo ? 'fonte')`) ⇒ `PRE_SONDA_FONTE`: o bundle no ar é
 *     anterior ao #1998, que CRIOU o campo. Não subiu nada pela metade — é um deploy antigo
 *     INTEIRO. Medido em prod 2026-09-05 (request_ids 69377-69381): 5 edges responderam assim e as
 *     5 saíram "DEPLOY PARCIAL — subiu index.ts+versao.ts, mas sonda-fingerprints.ts NAO". O
 *     desfecho prático coincide (redeployar), mas quem lê vai investigar um prompt de deploy que
 *     nomeou poucos arquivos — e esse prompt não existiu. Diagnóstico errado com desfecho certo
 *     custa a próxima meia hora, e some com o caso em que a causa nomeada é a verdadeira.
 *   · **campo PRESENTE valendo `nao-mapeada`** ⇒ `DEPLOY PARCIAL` de verdade: o bundle CONHECE o
 *     campo (logo é ≥ #1998) e o `?? "nao-mapeada"` de `criarRespostaSonda` disparou porque o
 *     `_shared/sonda-fingerprints.ts` que subiu não tem esta edge. Aí sim faltou arquivo.
 * O vocabulário é o do irmão passivo (`.claude/skills/fecho/scripts/edges-pendentes.sh`), que
 * nomeia o mesmo estado `PRE_SONDA_FONTE` — dois nomes para um estado é como o operador conclui
 * que são dois problemas. Confirmação segue exigindo os DOIS campos; a dúvida cai sempre no lado
 * que manda olhar de novo.
 *
 * POR QUE O 401 TEM RAMO PRÓPRIO: ele é AMBÍGUO por construção, e os outros 4xx não são. Um 404 diz
 * "não há edge servida nessa URL"; um 401 pode ser (a) bundle PRÉ-SONDA que ignorou o
 * `{"probe":true}`, caiu no gate JWT e recusou, ou (b) `CRON_SECRET` ausente/errado no vault, com
 * `authorizeCronOrStaff` recusando o header. Nos DOIS casos `versao` vem NULL e o status é 401 — o
 * dado não separa. Ler (b) como (a) manda redeployar uma edge que já está no ar: `ausente ≠ zero`
 * na dimensão CREDENCIAL, irmão do guard temporal do #2079, onde tick pré-merge lido como pendência
 * produzia o mesmo falso negativo confiante.
 *
 * Então o veredito determinado só sai quando um CONTROLE é observado na MESMA consulta. Antes
 * disso a desambiguação dependia de o operador lembrar de rodar duas consultas à mão (feito assim
 * em 2026-08-30, no #2101) — e recado que depende de alguém lembrar é exatamente como a armadilha
 * da sentinela não-exclusiva passou.
 *
 * ⚠️ QUEM DETERMINA É O `controle_ativo`, NÃO O HISTÓRICO — mudou em 2026-09-09. Até então quem
 * determinava era o `controle_credencial`: tráfego de fundo recente que PASSOU (≥ piso de 2xx) e
 * nenhuma recusa 401 fora desta leva. Ele é POPULACIONAL, e o parecer Codex do #2424 nomeou as
 * duas manifestações do buraco: (a) `CRON_SECRET` trocado há minutos sem cron rodado desde — os
 * 2xx da janela usaram o secret ANTIGO e avalizam indevidamente; (b) o PRÓPRIO disparo mandando
 * header errado — a leva toma 401, os ids dela ficam FORA da contagem pelo `NOT EXISTS`, e o
 * controle segue VERDE avalizando um transporte quebrado. (a) se desqualifica sozinha no próximo
 * cron; (b) NÃO se corrige sozinha, e o desfecho é redeploy à toa de edge que já estava no ar.
 *
 * O controle ATIVO fecha as duas porque a prova passou a ser da TENTATIVA ATUAL: uma resposta
 * DESTA leva, correlacionada por `request_id`, com IDENTIDADE verificada (`versao` E `fonte`
 * esperadas). O histórico continua EXIBIDO — o operador precisa enxergar o fundo — mas não
 * condiciona ramo nenhum. Ele não some porque o ativo o SUBSUME: se a credencial foi aceita AGORA
 * por um request desta leva, o que 52 crons fizeram em 6h não acrescenta prova; exigir os dois
 * (AND) cobraria recall sem comprar precisão. A mecânica e a armadilha do "2xx cru" estão na
 * docstring de `cteControleAtivo`.
 *
 * O QUE SE PERDEU, e é a troca deliberada (precisão > recall): quando a leva INTEIRA responde 401,
 * não há testemunha e o veredito é INDETERMINADO — onde o histórico determinava. Na prática isso é
 * a leva de UMA edge pré-sonda, e a saída está escrita no próprio ramo: acrescentar à leva uma edge
 * que se sabe no ar. É o mesmo lugar onde a manifestação (b) morde, então o que se perde em recall
 * é exatamente o que se ganha em não mentir.
 *
 * ⚠️ O `NOT EXISTS (… ids …)` do histórico segue valendo pelo outro motivo: sem ele o 401 sob
 * julgamento entra em `recusas_recentes` e o controle se auto-envenena. Não dá para consertar
 * excluindo a janela inteira da sonda: as recusas 401 recentes dos crons — justamente a prova de
 * secret quebrado AGORA — sairiam junto, e o erro viraria fail-OPEN.
 */
function blocoLeitura(leva: EdgeSondada[], janelaMin: number, ids: FonteDosIds = ECO): string {
  const embutido = ids.modo === 'embutido';
  const exprIds = embutido ? `${ids.expr}::jsonb` : `'{}'::jsonb`;
  const passoDisparo = ids.modo === 'embutido' ? ids.passoDisparo : null;
  const comentarioIds = embutido
    ? `  -- EMBUTIDO pelo passo ${passoDisparo} — o mapa \`edge → request_id\` foi escrito pelo próprio banco\n` +
      `  -- no disparo (format()), então aqui não há nada a colar nem a redigitar. É ele que separa a\n` +
      `  -- causa (c) do INDETERMINADO: PRE-SENSOR e recusa HTTP respondem SEM eco do slug, mas TÊM id.\n`
    : `  -- OPCIONAL — deixe o {} como está. O eco do slug acha a linha sozinho; colar aqui o JSON do\n` +
      `  -- disparo só serve para separar a causa (c) do INDETERMINADO (PRE-SENSOR / recusa HTTP).\n`;
  const comentarioControle = embutido
    ? `    -- ⚠️ Com o mapa EMBUTIDO o \`ids\` nunca está vazio, e é isso que faz esta exclusão valer: o\n` +
      `    --    401 desta leva não entra na contagem de recusas contra si mesmo. Quem DETERMINA o\n` +
      `    --    veredito do 401, porém, é o \`controle_ativo\` abaixo — este aqui só dá contexto.\n`
    : `    -- ⚠️ Com o \`ids\` VAZIO (o padrão do --so-leitura), esta exclusão não exclui nada: um 401\n` +
      `    --    desta leva conta como recusa e o controle se auto-desqualifica. É fail-CLOSED, mas\n` +
      `    --    hoje isso é secundário: o veredito do 401 exige TESTEMUNHA ATIVA, e sem o mapa não\n` +
      `    --    há request_id desta leva para testemunhar. Rode o bloco de DISPARO.\n`;
  const semId = embutido
    ? `'INDETERMINADO — esta edge não tem request_id no mapa embutido NEM eco de sonda na janela ` +
      `de ${janelaMin} min. Isto é ausência de dado, não veredito negativo: ou a trava do passo ` +
      `${passoDisparo} ficou FECHADA e nada foi disparado, ou a célula veio de OUTRA leva — confira ` +
      `se os nomes das edges batem'`
    : `'INDETERMINADO — nenhuma resposta de sonda desta edge na janela de ${janelaMin} min. Isto ` +
      `é ausência de dado, não veredito negativo: pode ser (a) o disparo não ter rodado, (b) a ` +
      `resposta ainda a caminho (leva ~10s) — rode este passo de novo, ou (c) bundle PRE-SENSOR / ` +
      `recusa HTTP, que responde SEM eco do slug e é invisível aqui; para separar (c), cole o ` +
      `request_id do disparo no ids acima'`;
  const aguarde = embutido
    ? `'AGUARDE — o request_id embutido pelo passo ${passoDisparo} ainda não tem resposta HTTP ` +
      `(leva ~10s); rode este passo de novo'`
    : `'AGUARDE — o request_id colado ainda não tem resposta HTTP (leva ~10s); rode este passo de novo'`;
  const textoIdDeOutraExecucao = embutido
    ? `'O mapa veio embutido, logo o id e do disparo desta celula: ou a celula e de OUTRA leva/sessao, ou esta edge respondeu o fluxo real.'`
    : `'O id colado no ids aponta para outra execucao — foi ele que trocou o alvo.'`;
  const sufixo401 = embutido
    ? `                'Acrescente a leva uma edge que voce SABE no ar: a testemunha dela DETERMINA ' ||\n` +
      `                'este 401. '\n`
    : `                'Este modo nao embute o mapa, entao nao ha request_id desta leva para ' ||\n` +
      `                'testemunhar: rode o bloco de DISPARO, que emite o passo de leitura com o ' ||\n` +
      `                'mapa dentro. '\n`;
  // ⚠️ NO MODO EMBUTIDO O ID É AUTORITATIVO — e o `COALESCE(s.id, …)` que havia aqui era um bug
  // que só o controle ativo tornou visível (achado do parecer Codex, 2026-09-09): preferindo o
  // ECO, a linha podia ser julgada por uma resposta de OUTRA execução (a sondagem anterior, ainda
  // dentro da janela) enquanto o request DESTA leva tomava 401 — o veredito falando de uma
  // execução e o controle de outra, na MESMA linha. Pior: com a trava FECHADA (request_id NULL,
  // nada disparado) um eco antigo preenchia a linha e ela saía julgada, quando o honesto é
  // INDETERMINADO. O eco sobrevive como o caminho do `--so-leitura`, onde não há mapa nenhum.
  const projecaoLidas = embutido
    ? `  SELECT e.edge, e.versao_esperada, e.fonte_esperada,\n` +
      `         i.request_id,\n` +
      `         x.status_code,\n` +
      `         x.created,\n` +
      `         x.error_msg AS erro_transporte,\n` +
      `         CASE WHEN x.content IS NOT NULL AND left(ltrim(x.content), 1) = '{'\n` +
      `              THEN COALESCE(x.content::jsonb -> 'data', x.content::jsonb)\n` +
      `         END AS corpo\n`
    : `  SELECT e.edge, e.versao_esperada, e.fonte_esperada,\n` +
      `         COALESCE(s.id, i.request_id) AS request_id,\n` +
      `         COALESCE(s.status_code, x.status_code) AS status_code,\n` +
      `         COALESCE(s.created, x.created) AS created,\n` +
      `         x.error_msg AS erro_transporte,\n` +
      `         COALESCE(s.corpo,\n` +
      `                  CASE WHEN x.content IS NOT NULL AND left(ltrim(x.content), 1) = '{'\n` +
      `                       THEN COALESCE(x.content::jsonb -> 'data', x.content::jsonb)\n` +
      `                  END) AS corpo\n`;
  const lateralDoEco = embutido
    ? ''
    : `  LEFT JOIN LATERAL (\n` +
      `    SELECT rr.id, rr.status_code, rr.created, rr.corpo\n` +
      `    FROM recentes rr\n` +
      `    WHERE rr.corpo ->> 'edge' = e.edge\n` +
      `      AND rr.corpo ->> 'probe' = 'true'\n` +
      `    ORDER BY rr.created DESC, rr.id DESC\n` +
      `    LIMIT 1\n` +
      `  ) s ON true\n`;
  // A recência do caminho por ID não vinha de graça: o eco a herdava de `recentes`, o id não. Com
  // o id autoritativo, sem este ramo uma célula de OUTRA sessão sairia julgada como de agora — a
  // regressão que a correção acima criaria. É o gêmeo do guard que a canária já tinha.
  const foraDaJanela = embutido
    ? `         WHEN l.created <= now() - interval '${janelaMin} minutes'\n` +
      `           THEN 'INDETERMINADO — a resposta e de ' || l.created || ', FORA da janela de ` +
      `${janelaMin} min: esta celula e de OUTRA sessao e o veredito seria de um deploy anterior. ` +
      `Redispare o passo ${passoDisparo}'\n`
    : '';
  // `recentes` existe para o LATERAL do eco, e com o id autoritativo o eco só sobrevive no
  // `--so-leitura`. Emiti-lo no modo embutido deixaria um CTE sem consumidor: SQL morto que se lê
  // como se a janela ainda governasse a busca, quando quem governa ali é o request_id.
  const cteRecentes = embutido
    ? ''
    : `recentes AS (\n` +
      `  -- A JANELA. O filtro textual roda ANTES do cast de propósito: um corpo não-JSON no meio da\n` +
      `  -- janela abortaria a consulta inteira (mesma defesa da irmã passiva, pendencias-deploy.ts).\n` +
      `  SELECT r.id, r.created, r.status_code,\n` +
      `         COALESCE(r.content::jsonb -> 'data', r.content::jsonb) AS corpo\n` +
      `  FROM net._http_response r\n` +
      `  WHERE r.created > now() - interval '${janelaMin} minutes'\n` +
      `    AND r.status_code IS NOT NULL\n` +
      `    AND r.content IS NOT NULL\n` +
      `    AND left(ltrim(r.content), 1) = '{'\n` +
      `),\n`;
  return (
    `WITH esperado(edge, versao_esperada, fonte_esperada) AS (VALUES\n${valuesEsperado(leva)}\n),\n` +
    cteRecentes +
    `ids AS (\n` +
    comentarioIds +
    `  SELECT chave AS edge, valor::bigint AS request_id\n` +
    `  FROM jsonb_each_text(${exprIds}) AS t(chave, valor)\n` +
    `),\n` +
    cteControleCredencial({
      cabeca:
        `  -- Controle de CREDENCIAL: o 401 acima é ambíguo (bundle velho × CRON_SECRET inválido) e só\n` +
        `  -- vira veredito determinado se ESTE bloco provar que o secret do vault está sendo ACEITO\n` +
        `  -- agora. Lê a MESMA tabela do LEFT JOIN de cima de propósito: não acrescenta superfície de\n` +
        `  -- permissão nova (se desse 'permission denied' o bloco inteiro já teria falhado), e um\n` +
        `  -- controle que exige privilégio a mais viraria INDETERMINADO por acidente de ACL.\n`,
      exclusao: comentarioControle,
    }) +
    `lidas AS (\n` +
    projecaoLidas +
    `  FROM esperado e\n` +
    lateralDoEco +
    `  LEFT JOIN ids i ON i.edge = e.edge\n` +
    `  LEFT JOIN net._http_response x ON x.id = i.request_id\n` +
    `),\n` +
    cteControleAtivo({
      cabeca:
        `  -- Controle ATIVO: a prova de credencial ATRIBUÍDA a ESTA leva. O histórico acima conta\n` +
        `  -- tráfego de FORA e não sabe qual credencial autenticou os 2xx que contou; este conta as\n` +
        `  -- respostas DESTES request_ids. Testemunha é IDENTIDADE, não status: exige o eco da sonda\n` +
        `  -- com \`versao\` E \`fonte\` ESPERADAS — aí o bundle no ar é VERBATIM o do repo, e no repo o\n` +
        `  -- gate autentica antes de responder. Um 200 anônimo (bundle histórico que ignora a\n` +
        `  -- credencial e roda o fluxo real) NÃO é testemunha, e é por isso que 2xx não basta.\n`,
      alias: 'l',
      testemunha:
        `l.status_code BETWEEN 200 AND 299\n` +
        `                            AND l.created > now() - interval '${janelaMin} minutes'\n` +
        `                            AND l.corpo ->> 'probe'  = 'true'\n` +
        `                            AND l.corpo ->> 'edge'   = l.edge\n` +
        `                            AND l.corpo ->> 'versao' = l.versao_esperada\n` +
        `                            AND l.corpo ->> 'fonte'  = l.fonte_esperada`,
    }) +
    `SELECT l.edge,\n` +
    `       l.request_id,\n` +
    `       l.status_code,\n` +
    `       l.corpo ->> 'edge'   AS edge_respondida,\n` +
    `       l.corpo ->> 'versao' AS versao_respondida,\n` +
    `       l.versao_esperada,\n` +
    `       l.corpo ->> 'fonte'  AS fonte_respondida,\n` +
    `       CASE\n` +
    `         WHEN l.request_id IS NULL\n` +
    `           THEN ` + semId + `\n` +
    // Falha de TRANSPORTE vem antes do AGUARDE: no pg_net 0.19.5 o erro grava `error_msg` e deixa
    // o status NULL, indistinguível de "resposta a caminho" para quem só olha o status — e mandar
    // "rode de novo" a cada 10s numa requisição que MORREU é laço de espera fail-OPEN.
    `         WHEN l.erro_transporte IS NOT NULL\n` +
    `           THEN 'FALHA DE TRANSPORTE — a requisicao nao chegou a ter resposta HTTP: ' ||\n` +
    `                l.erro_transporte || '. Isto NAO e veredito de deploy e NAO adianta repetir ' ||\n` +
    `                'sem antes resolver a causa (DNS, timeout, rede do pg_net)'\n` +
    `         WHEN l.status_code IS NULL\n` +
    `           THEN ` + aguarde + `\n` +
    foraDaJanela +
    `         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401\n` +
    `              AND a.aceitas_na_leva >= 1\n` +
    `           THEN 'BUNDLE VELHO (pre-sonda) — 401, e a credencial DESTE disparo esta PROVADA ' ||\n` +
    `                'ATIVAMENTE: ' || a.aceitas_na_leva || ' de ' || a.disparos_na_leva ||\n` +
    `                ' request(s) desta leva voltou com IDENTIDADE VERIFICADA (probe + versao + ' ||\n` +
    `                'fonte esperadas), logo o x-cron-secret foi ACEITO neste instante e a recusa ' ||\n` +
    `                'e da EDGE: nada executou'\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401\n` +
    `           THEN 'INDETERMINADO — 401 nao separa bundle velho de CRON_SECRET invalido, e ' ||\n` +
    `                'NENHUMA aceitacao foi OBSERVADA nesta leva (0 testemunha de ' ||\n` +
    `                a.disparos_na_leva || ' disparo(s); 401: ' || a.recusadas_na_leva ||\n` +
    `                ', sem resposta ainda: ' || a.pendentes_na_leva || ', falha de transporte: ' ||\n` +
    `                a.falhas_na_leva || '). Isto e ausencia de prova, nao prova de que o secret ' ||\n` +
    `                'esta ruim. Confira o CRON_SECRET no vault ANTES de redeployar. ' ||\n` +
    sufixo401 +
    `                || ` + contextoHistorico('c') + `\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code >= 400\n` +
    `           THEN 'BUNDLE VELHO — recusou o request (HTTP ' || l.status_code || '), NADA executou'\n` +
    `         WHEN l.corpo ->> 'versao' IS NULL\n` +
    `           THEN 'PRE-SENSOR — HTTP 200 sem versao: ignorou o probe e RODOU O FLUXO REAL'\n` +
    // Ramo do id que aponta para uma resposta que NAO e da sonda. So o caminho dos `ids` chega
    // aqui — o LATERAL do eco ja exige `probe = 'true'` —, e sem este ramo a linha cai no ELSE e
    // sai 'BUNDLE VELHO' citando a versao CERTA: o falso NEGATIVO que esta secao documenta na
    // armadilha do casamento so-por-slug. Medido em prod 2026-09-06 apontando o mapa para a
    // resposta 71275 (cron da analytics-outbox-drain, que ecoa edge/versao/fonte e nao ecoa probe).
    // Vem ANTES do `? 'fonte'`: cron que ecoa versao sem fonte sairia como PRE_SONDA_FONTE, que
    // nomeia bundle anterior ao #1998 — causa errada, mesma classe.
    `         WHEN l.corpo ->> 'probe' IS DISTINCT FROM 'true'\n` +
    `           THEN 'NAO E RESPOSTA DE SONDA — o corpo tem versao mas NAO tem probe:true, entao ' ||\n` +
    `                'e a execucao REAL desta edge (cron), nao a sonda: nao ha veredito de deploy ' ||\n` +
    `                'aqui. ' || ${textoIdDeOutraExecucao} || ' Respondeu versao=' ||\n` +
    `                COALESCE(l.corpo ->> 'versao', '?') || ' (esperado ' || l.versao_esperada || ')'\n` +
    `         WHEN NOT (l.corpo ? 'fonte')\n` +
    `           THEN 'PRE_SONDA_FONTE — respondeu a sonda (200 + probe) e o corpo NAO TEM o campo ' ||\n` +
    `                'fonte: o bundle no ar e ANTERIOR ao #1998, que criou o campo. E deploy ANTIGO ' ||\n` +
    `                'INTEIRO, nao parcial — nao procure prompt que nomeou poucos arquivos. ' ||\n` +
    `                'Respondeu versao=' || COALESCE(l.corpo ->> 'versao', '?') ||\n` +
    `                ' (esperado ' || l.versao_esperada || '). PRECISA DEPLOY'\n` +
    `         WHEN l.corpo ->> 'fonte' = 'nao-mapeada'\n` +
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
    `FROM lidas l CROSS JOIN controle_credencial c CROSS JOIN controle_ativo a\n` +
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

/**
 * Gera o SQL de sondagem da leva.
 *
 * A DIVISÃO DE TRABALHO que os recortes servem: o disparo precisa de ESCRITA (vault + INSERT do
 * `net.http_post`) e por isso passa pelo founder no SQL Editor; a leitura é SELECT em
 * `net._http_response` e roda no wrapper read-only, ou seja, o agente lê o veredito sozinho. Sem os
 * recortes, entregar "o SQL" ao founder entrega os quatro blocos e devolve a leitura para a mão
 * dele — que é justamente o round-trip que o eco do slug eliminou.
 */
export function gerarSqlDaLeva(opts: OpcoesLeva): string {
  if (opts.soDisparo && opts.soLeitura) {
    throw new Error(
      'use --so-disparo OU --so-leitura, não os dois: pedir os dois recortes é pedir o SQL ' +
        'inteiro, que é o padrão (sem flag nenhuma). Nenhum SQL foi emitido.',
    );
  }
  const janelaMin = validarJanela(opts.janelaMin);
  const grupos = separar(opts.edges, opts.caras ?? []);
  // Resolve a leva INTEIRA antes de emitir qualquer coisa: uma edge sem sensor derruba o SQL todo.
  // E resolve UMA vez: os dois grupos saem desta leitura. Antes eram três `resolverLeva` — três
  // leituras do mesmo `versao.ts` na mesma chamada, e o guard conferia uma quarta.
  const todas = opts.resolvida ?? resolverLeva(opts.raiz, opts.edges);
  const porEdge = new Map(todas.map((e) => [e.edge, e]));
  const daLista = (edges: string[]): EdgeSondada[] => edges.map((e) => porEdge.get(e)!);
  const ref = lerProjectRef(opts.raiz);
  const partes: string[] = [];
  // Os recortes escolhem QUAIS blocos saem; o número de cada um continua cravado no próprio bloco,
  // e não na posição dentro do que foi emitido. É o que faz "PASSO 2" nomear a MESMA coisa dos dois
  // lados da conversa — o founder só vê o 1 e o 3, o agente só vê o 2 e o 4.
  const querDisparo = !opts.soLeitura;
  const querLeitura = !opts.soDisparo;

  if (grupos.baratas.length > 0) {
    const leva = daLista(grupos.baratas);
    if (querDisparo) {
      partes.push(
        `-- PASSO 1 — dispara as ${leva.length} edge(s) baratas da leva. Exige ESCRITA: lê o vault e\n` +
          '--          faz INSERT, e o wrapper read-only recusa os dois — o que NÃO é o mesmo que\n' +
          '--          "só o founder consegue". Caminho da SESSÃO: commite este .sql em db/ e rode\n' +
          '--          `bun run db:aplicar db/<arquivo>.sql` (`--ensaio` antes) — o envelope, com\n' +
          '--          sha256, ledger e marcador de fim. Colar no SQL Editor do Lovable é o\n' +
          '--          FALLBACK: de quem só tem o psql-ro (docs/agent/database.md §"o ENVELOPE").\n' +
          '-- Ele DEVOLVE o passo 2 já escrito, com o mapa edge→id dentro: copie a saída inteira — a\n' +
          '-- célula do SQL Editor, ou o log que o db:aplicar aponta no fim.\n' +
          blocoDisparo(ref, leva, 1, janelaMin),
      );
    }
    if (querLeitura) {
      partes.push(
        `-- PASSO 2 — lê e julga SEM mapa nenhum: a resposta da sonda ecoa o próprio slug, e o bloco\n` +
          `--          a encontra na janela de ${janelaMin} min. É SELECT puro — roda no read-only:\n` +
          `--          bun run sonda:sql --so-leitura <edge>… | ~/.config/afiacao/psql-ro\n` +
          `-- ⚠️ Esta é a versão do ECO. A que o passo 1 devolve é ESTRITAMENTE melhor: com o mapa\n` +
          `--    embutido, PRE-SENSOR e recusa HTTP (que não ecoam) saem determinados, e o 401 também.\n` +
          blocoLeitura(leva, janelaMin),
      );
    }
  }

  if (grupos.caras.length > 0) {
    const leva = daLista(grupos.caras);
    if (querDisparo) {
      partes.push(
        `-- PASSO 3 — dispara as ${leva.length} edge(s) CARAS, com trava.\n` +
          `-- ⚠️ Bundle PRÉ-sensor IGNORA o probe e RODA O FLUXO REAL destas. Só abra a trava depois\n` +
          `--    de o deploy estar confirmado por outro caminho.\n` +
          `-- ⚠️ A trava é CASE e NÃO um filtro: o Postgres avalia a projeção mesmo descartando todas\n` +
          `--    as linhas, então travar por filtro deixa o http_post sair igual (falsificado —\n` +
          `--    docs/agent/deploy.md §"Sondar VÁRIAS edges numa tacada"). E NÃO valide um filtro numa\n` +
          `--    consulta simples para se convencer: lá ele filtra antes e PARECE proteger; é nesta\n` +
          `--    forma, agregada, que ele falha. Trava fechada devolve {"edge": null} e NADA sai —\n` +
          `--    o passo seguinte não acha eco na janela, e o mapa que ele recebe embutido vem com\n` +
          `--    id nulo — as duas coisas dizem INDETERMINADO, que é o honesto: nada foi disparado.\n` +
          `-- Ele também DEVOLVE o passo 4 já escrito, com o mapa dentro: copie a célula inteira.\n` +
          blocoDisparo(ref, leva, 3, janelaMin, true),
      );
    }
    if (querLeitura) {
      partes.push(
        `-- PASSO 4 — lê e julga as CARAS, pelo mesmo eco. Também é SELECT puro.\n` +
          blocoLeitura(leva, janelaMin),
      );
    }
  }

  return partes.join('\n');
}

// ==========================================================================================
// MODO CANÁRIA — a irmã COMPORTAMENTAL da sonda
// ==========================================================================================
//
// A sonda responde "qual bundle está no ar?". A canária responde "o COMPORTAMENTO que esta fatia
// atesta continua no ar?" — ela roda o helper REAL sobre fixtures e devolve o veredito. Até aqui
// o disparo dela era `net.http_post` escrito à mão a cada verificação, com o CASE do veredito
// reescrito junto (fecho do #2367: o SQL saiu do bloco da sonda trocando `'probe'` por `'canary'`).
// Duas coisas viajavam na mão nesse caminho, e as duas produzem VEREDITO FALSO:
//
//   1. O CORPO. Ele NÃO é uniforme — `docs/agent/deploy.md` §"Canárias de deploy" lista quatro
//      formas: `{"canary":true}`, `?canary=1` na URL, e rotas nomeadas por `action`
//      (`identidade_probe`, `doc_ambiguo_probe`, `transferencia_probe`, `paginacao_probe`). Corpo
//      errado não é "canária que não respondeu": a edge cai no FLUXO REAL, e em várias delas isso
//      é caro e ESCREVE (a `carteira-rebuild` faz o rebuild inteiro, lease + upserts).
//   2. O MARCADOR esperado. Digitado errado, o veredito sai "bundle velho" numa canária que está
//      no ar — o mesmo falso do cabeçalho deste arquivo, uma camada acima. Aqui ele é DERIVADO do
//      repo (o `contrato` emitido no `index.ts`, lido pelo mesmo extrator que o gate `canaria:bump`
//      usa), nunca digitado no registro.
//
// POR QUE A LEITURA NÃO ACHA A LINHA PELO ECO DO SLUG, como a da sonda: a resposta da canária NÃO
// ecoa o nome da edge. Medido nas 7 emissões: `{canary, contrato, ok, ...}` — `executarCanaria` da
// `copilot-analyze`, o `result` das três `omie-*`, o `Response` da `carteira-rebuild`. Sem eco não
// há como casar resposta com edge sem o `request_id`, e por isso o modo canária SÓ existe na forma
// de mapa EMBUTIDO: o passo 1 escreve o passo 2 com o mapa dentro, e `--so-leitura` é RECUSADO —
// um bloco de leitura sem mapa aqui não seria "menos preciso", seria INDETERMINADO em toda linha.

/** Como a canária é acordada. Não é uniforme entre as 8 — ver a tabela do `deploy.md`. */
export type DisparoCanaria =
  /** corpo JSON no POST (`{"canary":true}` ou `{"action":"<rota>"}`) */
  | { readonly tipo: 'corpo'; readonly corpo: string }
  /** query string na URL (`?canary=1`) — o corpo vai `{}` */
  | { readonly tipo: 'query'; readonly query: string };

export interface CanariaRegistrada {
  /** identificador na CLI. Edge com DUAS canárias precisa de sufixo: `<edge>:<rota>`. */
  readonly nome: string;
  readonly edge: string;
  /** Chave de `localizarCanarias` que hospeda esta canária: `case:<rota>` ou `if:<ordinal>`. */
  readonly chave: string;
  readonly disparo: DisparoCanaria;
  /** Campo da resposta que carrega o marcador. A `generate-tactical-plan` serve em `versao`. */
  readonly campoMarcador: 'contrato' | 'versao';
  /**
   * `null` = alcançável pelo SQL Editor. Texto = por que NÃO é, e o que fazer no lugar. Canária
   * atrás de gate de JWT de usuário é inalcançável por `x-cron-secret`: pedir o disparo dela aqui
   * devolveria 401, e 401 se lê como "bundle velho" — veredito falso sobre uma canária que talvez
   * esteja perfeita. Recusar é o honesto.
   */
  readonly inalcancavel: string | null;
  /**
   * O que um bundle SEM esta canária faz com o disparo. `true` = cai no fluxo real e ele é
   * caro/escreve, então ela sai no bloco COM trava. Derivado do código, não da memória de quem
   * chama: o `--caro` da sonda depende de o operador lembrar, e aqui esquecer significa rebuild
   * real da carteira ou token de LLM queimado.
   */
  readonly fluxoRealSeVelho: boolean;
  /** O efeito do fluxo real, nomeado. Entra no veredito de "rodou o fluxo real". */
  readonly efeitoSeVelho: string;
}

/**
 * As 8 canárias de `docs/agent/deploy.md` §"Canárias de deploy".
 *
 * O que está aqui é o que NÃO dá para derivar: como acordar a canária, e onde ela responde. O
 * MARCADOR não está — ele é lido do repo por `resolverCanarias`, que também recusa canária do repo
 * fora deste registro (a armadilha "canária fora da tabela" do próprio `deploy.md`).
 */
export const CANARIAS: readonly CanariaRegistrada[] = [
  {
    nome: 'copilot-analyze',
    edge: 'copilot-analyze',
    chave: 'if:1',
    disparo: { tipo: 'corpo', corpo: '{"canary": true}' },
    campoMarcador: 'contrato',
    inalcancavel: null,
    // A canária responde ANTES do gate de `Bearer`: um bundle sem ela cai no gate e devolve 401.
    fluxoRealSeVelho: false,
    efeitoSeVelho: 'analise por LLM (token) — mas o gate de Bearer recusa antes',
  },
  {
    nome: 'carteira-rebuild',
    edge: 'carteira-rebuild',
    chave: 'if:1',
    disparo: { tipo: 'query', query: '?canary=1' },
    campoMarcador: 'contrato',
    inalcancavel: null,
    // Sem o ramo `?canary=1` a requisição segue para o rebuild REAL: lease + upserts na carteira.
    fluxoRealSeVelho: true,
    efeitoSeVelho: 'rebuild REAL da carteira (lease + upserts) — idempotente, mas e ESCRITA',
  },
  {
    nome: 'generate-tactical-plan',
    edge: 'generate-tactical-plan',
    // Serve o marcador no campo `versao`, por REFERÊNCIA ao `VERSAO` do `versao.ts` — a única das
    // 8 nessa forma. O `canaria:bump` passou a enxergá-la no #2374 (`contrato: null` + `simbolo`),
    // e é dele que sai o sinal: `resolverCanarias` cobra que `campoMarcador` case com a forma que
    // o REPO usa, nos dois sentidos.
    chave: 'if:1',
    disparo: { tipo: 'corpo', corpo: '{"canary": true}' },
    campoMarcador: 'versao',
    inalcancavel: null,
    // `body.canary === true` é comparação CRUA (não passa pelo classificador), e a edge não tem
    // gate de auth antes: bundle velho vai direto para o plano com LLM.
    fluxoRealSeVelho: true,
    efeitoSeVelho: 'plano tatico com LLM (token) — nao ha gate de auth antes para segurar',
  },
  {
    nome: 'omie-vendas-sync',
    edge: 'omie-vendas-sync',
    chave: 'case:identidade_probe',
    disparo: { tipo: 'corpo', corpo: '{"action": "identidade_probe"}' },
    campoMarcador: 'contrato',
    inalcancavel: null,
    fluxoRealSeVelho: false,
    efeitoSeVelho: 'action desconhecida LANCA antes de qualquer escrita',
  },
  {
    nome: 'omie-analytics-sync:doc_ambiguo_probe',
    edge: 'omie-analytics-sync',
    chave: 'case:doc_ambiguo_probe',
    disparo: { tipo: 'corpo', corpo: '{"action": "doc_ambiguo_probe"}' },
    campoMarcador: 'contrato',
    inalcancavel: null,
    fluxoRealSeVelho: false,
    efeitoSeVelho: 'action desconhecida devolve 400 antes de qualquer escrita',
  },
  {
    nome: 'omie-analytics-sync:transferencia_probe',
    edge: 'omie-analytics-sync',
    chave: 'case:transferencia_probe',
    disparo: { tipo: 'corpo', corpo: '{"action": "transferencia_probe"}' },
    campoMarcador: 'contrato',
    inalcancavel: null,
    fluxoRealSeVelho: false,
    efeitoSeVelho: 'action desconhecida devolve 400 antes de qualquer escrita',
  },
  {
    nome: 'omie-financeiro',
    edge: 'omie-financeiro',
    chave: 'case:paginacao_probe',
    disparo: { tipo: 'corpo', corpo: '{"action": "paginacao_probe"}' },
    campoMarcador: 'contrato',
    inalcancavel: null,
    // O `default` fecha o log como ERRO (não `complete`), então não carimba frescor falso.
    fluxoRealSeVelho: false,
    efeitoSeVelho: 'action desconhecida fecha o fin_sync_log como erro — nao carimba frescor',
  },
  {
    nome: 'analyze-unified-order',
    edge: 'analyze-unified-order',
    chave: 'if:1',
    disparo: { tipo: 'corpo', corpo: '{"canary": true}' },
    campoMarcador: 'contrato',
    inalcancavel:
      'a canária de preço vive DEPOIS do gate de staff (JWT de usuário), e o gate não conhece ' +
      '`x-cron-secret` — pelo SQL Editor ela responde 401, que é indistinguível de bundle velho. ' +
      'Chame-a pelo APP LOGADO: Governança → Auditoria, card "Canária de preço". (A SONDA desta ' +
      'edge é alcançável e responde antes do gate: `bun run sonda:sql analyze-unified-order`.)',
    fluxoRealSeVelho: false,
    efeitoSeVelho: 'inalcancavel pelo SQL Editor',
  },
];

/**
 * O único símbolo de marcador resolvível — o mesmo que o `canaria:bump` sabe seguir. Canária que
 * sirva `versao: <outro>` fica FORA do alcance, e dizer isso é melhor do que adivinhar.
 */
const SIMBOLO_VERSAO = 'VERSAO';

/** Uma canária do registro com o marcador que o REPO diz que ela emite hoje. */
export interface CanariaResolvida extends CanariaRegistrada {
  readonly marcador: string;
  /**
   * Os arquivos LIDOS para chegar em `marcador`: o `index.ts` da edge sempre (é onde mora o
   * `contrato:`, e onde `localizarCanarias` acha a chave e a FORMA), e o `versao.ts` só quando a
   * canária serve por REFERÊNCIA — aí o literal está lá. O mapa de fingerprints não entra: o modo
   * canária não o lê, e conferir o que não alimenta o resultado só produz bloqueio.
   */
  readonly proveniencia: readonly FonteDoEsperado[];
}

/**
 * Lê do repo as canárias de UMA edge: a chave do arm e o marcador emitido.
 *
 * Injetado, e não importado no topo, pelo MESMO motivo documentado em `guardEfeitoLegado`: o eval
 * da skill `lovable-deploy-verify` copia SÓ `sonda-versao-sql.ts` e `sonda-fingerprint.ts` para um
 * diretório temporário e importa daqui. Um import de topo de `canaria-contrato-bump-gate` (que por
 * sua vez importa `@/lib/gates/limpeza-fonte`) não resolveria lá, o módulo inteiro deixaria de
 * carregar, e os cenários do eval voltariam a devolver `SQL_VAZIO`. Quem executa como CLI resolve
 * o leitor real no fim deste arquivo.
 */
export type LeitorCanariasDoRepo = (raiz: string, edge: string) => CanariasDoIndex;

/**
 * O que o leitor devolve: as canárias achadas E os bytes do `index.ts` de que elas saíram.
 *
 * A `fonte` vem do LEITOR, e não de um `readFileSync` do lado de cá, porque é ele quem sabe o que
 * leu — e porque o que o guard confere tem de ser o que o marcador atravessou. Quando os dois
 * lados leem por conta própria, o `esperado(...)` sai de uma leitura e a aprovação da outra.
 */
export interface CanariasDoIndex {
  readonly canarias: ReadonlyArray<{
    chave: string;
    contrato: string | null;
    simbolo: string | null;
  }>;
  readonly fonte: FonteDoEsperado;
}

/** Pastas de `supabase/functions/` que podem hospedar canária (toda pasta com `index.ts`). */
function edgesDoRepo(raiz: string): string[] {
  const dir = join(raiz, 'supabase', 'functions');
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'index.ts')))
    .map((d) => d.name)
    .sort();
}

/**
 * Toda canária do REPO tem de estar no registro — senão a leva silenciosamente pula uma.
 *
 * É a armadilha "canária fora da tabela" do `deploy.md` aplicada à ferramenta: o `canaria:bump`
 * mediu "6 canária(s) conferida(s)" ANTES e DEPOIS de a 7ª existir, e nada ficou vermelho. Um
 * registro que só cresce quando alguém lembra tem o mesmo modo de falha, e aqui ele é pior: a
 * canária ausente do registro nunca é DISPARADA, então a verificação sai verde sobre 7 de 8.
 *
 * O pré-filtro por texto CRU é `canary:true`, o mesmo SINAL que o gate usa, e não `contrato`: a
 * `generate-tactical-plan` serve o marcador em `versao` e não tem a palavra `contrato` em lugar
 * nenhum do código — filtrar por ela deixaria a 8ª canária fora da varredura, que é exatamente a
 * cegueira que o #2374 fechou no gate. É superset seguro porque `removerComentarios` só REMOVE:
 * uma fonte sem o sinal no bruto não pode ganhá-lo depois da limpeza.
 */
function conferirRegistroCompleto(raiz: string, ler: LeitorCanariasDoRepo): void {
  const registradas = new Set(CANARIAS.map((c) => `${c.edge} ${c.chave}`));
  const forasteiras: string[] = [];
  for (const edge of edgesDoRepo(raiz)) {
    const bruto = readFileSync(join(raiz, 'supabase', 'functions', edge, 'index.ts'), 'utf8');
    if (!/canary\s*:\s*true/.test(bruto)) continue;
    for (const c of ler(raiz, edge).canarias) {
      if (!registradas.has(`${edge} ${c.chave}`)) {
        forasteiras.push(`${edge} (${c.chave} -> ${c.contrato ?? `versao: ${c.simbolo ?? '?'}`})`);
      }
    }
  }
  if (forasteiras.length > 0) {
    throw new Error(
      `canária no REPO e FORA do registro CANARIAS: ${forasteiras.join(', ')}. ` +
        'Uma canária que não está no registro nunca é disparada, e a leva sai verde sem tê-la ' +
        'verificado — é a armadilha "canária fora da tabela" do deploy.md dentro da ferramenta. ' +
        'Acrescente a entrada (nome, disparo, campoMarcador, fluxoRealSeVelho) e a linha na ' +
        'tabela de docs/agent/deploy.md §Canárias. Nenhum SQL foi emitido.',
    );
  }
}

/**
 * Resolve os nomes pedidos em canárias com MARCADOR VINDO DO REPO — ou LANÇA.
 *
 * Acusa tudo de uma vez, como `resolverLeva`: quem pediu 5 canárias quer saber quais 2 estão
 * tortas. Nada é emitido enquanto houver uma pendente.
 */
export function resolverCanarias(
  raiz: string,
  nomes: string[],
  ler: LeitorCanariasDoRepo,
): CanariaResolvida[] {
  conferirRegistroCompleto(raiz, ler);
  const porNome = new Map(CANARIAS.map((c) => [c.nome, c]));
  const desconhecidas = nomes.filter((n) => !porNome.has(n));
  if (desconhecidas.length > 0) {
    throw new Error(
      `canária desconhecida: ${desconhecidas.join(', ')}. As registradas são: ` +
        `${CANARIAS.map((c) => c.nome).join(', ')}. Nenhum SQL foi emitido.`,
    );
  }
  const barradas = nomes.filter((n) => porNome.get(n)!.inalcancavel !== null);
  if (barradas.length > 0) {
    throw new Error(
      barradas.map((n) => `${n}: ${porNome.get(n)!.inalcancavel}`).join(' | ') +
        ' Nenhum SQL foi emitido.',
    );
  }

  const semMarcador: string[] = [];
  const campoDesalinhado: string[] = [];
  const resolvidas: CanariaResolvida[] = [];
  for (const nome of nomes) {
    const reg = porNome.get(nome)!;
    const lido = ler(raiz, reg.edge);
    // O `index.ts` entra na proveniência ANTES de sabermos se a canária resolve: é dele que sai a
    // chave, a FORMA e (em 7 das 8) o próprio marcador. Um `index.ts` fora da main é exatamente o
    // caso que passava batido — a canária no ar responde o contrato ANTIGO.
    const doIndex: FonteDoEsperado = lido.fonte;
    const achada = lido.canarias.find((c) => c.chave === reg.chave);
    if (achada === undefined) {
      semMarcador.push(`${nome} (o index.ts de ${reg.edge} não hospeda canária em ${reg.chave})`);
      continue;
    }

    // O campo que o registro LÊ tem de ser o campo que o repo SERVE, nos dois sentidos. Sem esta
    // conferência, uma canária que trocasse de forma continuaria "funcionando" lendo o campo
    // errado: no sentido `versao`→`contrato` o veredito só saberia dizer SEM MARCADOR; no sentido
    // inverso ele leria o marcador da SONDA achando que é o da canária — dois papéis num campo só,
    // o defeito de `canaria-papel-duplo.md`. Fail-CLOSED: o registro acompanha, ou nada é emitido.
    if (achada.contrato !== null) {
      if (reg.campoMarcador !== 'contrato') {
        campoDesalinhado.push(
          `${nome} (o repo emite o LITERAL \`contrato: "${achada.contrato}"\`, o registro lê ` +
            `\`${reg.campoMarcador}\`)`,
        );
        continue;
      }
      resolvidas.push({ ...reg, marcador: achada.contrato, proveniencia: [doIndex] });
      continue;
    }

    if (achada.simbolo === null) {
      semMarcador.push(`${nome} (a canária em ${reg.chave} não serve marcador nenhum)`);
      continue;
    }
    if (reg.campoMarcador !== 'versao') {
      campoDesalinhado.push(
        `${nome} (o repo serve por REFERÊNCIA em \`versao: ${achada.simbolo}\`, o registro lê ` +
          `\`${reg.campoMarcador}\`)`,
      );
      continue;
    }
    if (achada.simbolo !== SIMBOLO_VERSAO) {
      semMarcador.push(
        `${nome} (serve \`versao: ${achada.simbolo}\`, e só \`${SIMBOLO_VERSAO}\` é resolvível — ` +
          'o literal desse símbolo é o que o `versao.ts` declara)',
      );
      continue;
    }
    const texto = (() => {
      try {
        return readFileSync(caminhoVersao(raiz, reg.edge), 'utf8');
      } catch {
        return null;
      }
    })();
    const versao = texto === null ? null : extrairVersao(texto);
    if (versao === null || texto === null) {
      semMarcador.push(`${nome} (versao.ts sem \`export const VERSAO = "..."\` legível)`);
      continue;
    }
    // Só ESTA forma leva o `versao.ts`: é a única em que o literal do marcador mora lá. Para uma
    // canária de `contrato`, o `versao.ts` da mesma edge pode divergir da main sem produzir
    // veredito falso nenhum — conferi-lo seria o bloqueio pelo bloqueio.
    resolvidas.push({
      ...reg,
      marcador: versao,
      proveniencia: [doIndex, { caminho: relVersao(reg.edge), bytes: texto }],
    });
  }

  const pendencias: string[] = [];
  if (semMarcador.length > 0) {
    pendencias.push(`marcador ILEGÍVEL no repo: ${semMarcador.join(', ')}`);
  }
  if (campoDesalinhado.length > 0) {
    pendencias.push(
      'a canária trocou de FORMA e o registro não acompanhou: ' +
        `${campoDesalinhado.join(', ')} — ajuste \`campoMarcador\` no registro e a tabela de ` +
        'docs/agent/deploy.md §Canárias',
    );
  }
  if (pendencias.length > 0) {
    throw new Error(
      `${pendencias.join(' | ')}. O marcador esperado é DERIVADO do repo de propósito: digitá-lo ` +
        'no registro é a via do veredito falso que esta ferramenta existe para fechar. ' +
        'Nenhum SQL foi emitido.',
    );
  }
  return resolvidas;
}

/** Lista `('nome', 'edge', '<corpo>'::jsonb, '<sufixo>'),` para o `VALUES` do disparo. */
function valuesAlvosCanaria(leva: CanariaResolvida[]): string {
  return leva
    .map((c) => {
      const corpo = c.disparo.tipo === 'corpo' ? c.disparo.corpo : '{}';
      const sufixo = c.disparo.tipo === 'query' ? c.disparo.query : '';
      return `  (${lit(c.nome)}, ${lit(c.edge)}, ${lit(corpo)}::jsonb, ${lit(sufixo)})`;
    })
    .join(',\n');
}

/** Lista `('nome', 'campo', 'marcador', 'efeito'),` para a lista canônica da leitura. */
function valuesEsperadoCanaria(leva: CanariaResolvida[]): string {
  return leva
    .map(
      (c) =>
        `  (${lit(c.nome)}, ${lit(c.campoMarcador)}, ${lit(c.marcador)}, ${lit(c.efeitoSeVelho)})`,
    )
    .join(',\n');
}

/**
 * Bloco de DISPARO da canária — o único que precisa do founder, pela mesma razão da sonda: lê
 * `vault.decrypted_secrets` e faz INSERT via `net.http_post`, e o wrapper read-only recusa os dois.
 *
 * Ele DEVOLVE o passo de leitura já escrito, com o mapa `nome → request_id` interpolado por
 * `format()`. Aqui isso não é conveniência, é REQUISITO: a resposta da canária não ecoa o slug, e
 * sem o mapa nenhuma linha seria atribuível. Continuam sendo DOIS blocos pela imposição do pg_net
 * (o `http_post` só ENFILEIRA; o worker de fundo só enxerga linha COMMITADA).
 */
function blocoDisparoCanaria(
  ref: string,
  leva: CanariaResolvida[],
  passoDisparo: number,
  janelaMin: number,
  comTrava = false,
): string {
  const passoLeitura = passoDisparo + 1;
  const cabeca = comTrava
    ? "WITH guard(confirmei_o_deploy) AS (VALUES ('nao')),  -- ⬅️ 'nao' → 'sim' só DEPOIS do verde\n" +
      `alvos(nome, edge, corpo, sufixo) AS (VALUES\n${valuesAlvosCanaria(leva)}\n),\n`
    : `WITH alvos(nome, edge, corpo, sufixo) AS (VALUES\n${valuesAlvosCanaria(leva)}\n),\n`;
  const projecao = comTrava
    ? `         ${TRAVA_CASE}\n` +
      `              THEN ${httpPost(ref, '                   ', ALVO_CANARIA)}\n` +
      '         END AS request_id\n' +
      '  FROM alvos a CROSS JOIN guard g\n'
    : `         ${httpPost(ref, '         ', ALVO_CANARIA)} AS request_id\n` + '  FROM alvos a\n';
  return (
    cabeca +
    'disparos AS (\n' +
    '  SELECT a.nome,\n' +
    projecao +
    '),\n' +
    'mapa AS (\n' +
    '  -- O par (nome, id) é agregado na MESMA execução que disparou: o request_id nunca existe\n' +
    '  -- solto, e por isso não há como colá-lo na linha da canária errada.\n' +
    '  SELECT jsonb_object_agg(nome, request_id)::text AS ids FROM disparos\n' +
    ')\n' +
    `-- O PASSO ${passoLeitura} sai ESCRITO na célula abaixo, com o mapa já dentro. Copie a célula\n` +
    '-- INTEIRA e rode/entregue como está: não há número a anotar nem campo a preencher.\n' +
    `SELECT format(${TAG_SONDA}\n` +
    corpoDoPassoDeLeituraCanaria(leva, janelaMin, passoDisparo) +
rodapeDoFormat(passoLeitura)
  );
}

/** O texto do passo de leitura da canária, pronto para virar o 1º argumento de `format()`. */
function corpoDoPassoDeLeituraCanaria(
  leva: CanariaResolvida[],
  janelaMin: number,
  passoDisparo: number,
): string {
  const passoLeitura = passoDisparo + 1;
  const texto =
    `-- PASSO ${passoLeitura} — lê e julga a CANÁRIA. O mapa nome→id já está EMBUTIDO aqui, escrito\n` +
    `--          pelo passo ${passoDisparo}: nada a colar. Espere ~10s pela resposta HTTP. É SELECT\n` +
    '--          puro — roda no read-only: cole no chat, ou em ~/.config/afiacao/psql-ro\n' +
    blocoLeituraCanaria(leva, janelaMin, passoDisparo);
  return escaparParaFormat(texto);
}

/**
 * O JULGAMENTO da canária. Exige os TRÊS campos que o `deploy.md` §Canárias manda —
 * `canary === true` E `<campoMarcador> === '<marcador>'` E `ok === true` — e, antes deles, separa
 * a classe que a receita à mão confundia:
 *
 *   BUNDLE VELHO  ≠  CANÁRIA VERMELHA
 *
 * Um bundle anterior à canária IGNORA a flag e cai no fluxo real: responde 401 (gate), outro 4xx,
 * ou 200 sem eco nenhum de `canary`. Nada disso é "a fixture reprovou" — é "não há canária no ar",
 * e o desfecho é DEPLOY, não investigar regressão de comportamento. A ausência do eco é veredito
 * PRÓPRIO, e vem ANTES de qualquer leitura de marcador ou de `ok`, senão a linha cai no ELSE e sai
 * com um texto que se lê como reprovação.
 *
 * A ordem dos ramos é o desenho:
 *   1. sem id / sem resposta / fora da janela ....... ausência de dado, nunca veredito
 *   2. sem eco `canary` ............................. SEM CANARIA NO AR (3 sabores: 401 com
 *      controle de credencial, outro 4xx/5xx, e o 200 que RODOU O FLUXO REAL — o caro)
 *   3. eco `canary` sem o campo do marcador ......... CANARIA SEM MARCADOR (pré-versionamento)
 *   4. marcador DIVERGENTE .......................... CANARIA DE OUTRA FATIA — é a armadilha 2 do
 *      deploy.md: o bundle velho carrega o `expected` VELHO e compara velho×velho, então o `ok:true`
 *      dele MENTE VERDE. Por isso o marcador é julgado ANTES do `ok`, e não junto.
 *   5. `ok` ausente ................................. CANARIA SEM VEREDITO (fail-closed)
 *   6. `ok:false` COM marcador batendo .............. CANARIA VERMELHA — esta, sim, é regressão
 *   7. os três campos ............................... CANARIA VERDE
 *
 * ⚠️ O ramo 2 vem antes de qualquer teste de status: a `generate-tactical-plan` responde HTTP **500**
 * quando a canária dela reprova. Julgar pelo status antes do eco leria uma canária vermelha legítima
 * como recusa de bundle velho — e mandaria redeployar em vez de investigar a regressão.
 */
function blocoLeituraCanaria(
  leva: CanariaResolvida[],
  janelaMin: number,
  passoDisparo: number,
): string {
  return (
    'WITH esperado(nome, campo_marcador, marcador_esperado, efeito) AS (VALUES\n' +
    `${valuesEsperadoCanaria(leva)}\n),\n` +
    'ids AS (\n' +
    `  -- EMBUTIDO pelo passo ${passoDisparo} — o mapa \`nome → request_id\` foi escrito pelo próprio\n` +
    '  -- banco no disparo (format()). A canária NÃO ecoa o slug, então este mapa não é atalho: é a\n' +
    '  -- ÚNICA via de atribuir a resposta à canária certa. Trava fechada ⇒ id nulo ⇒ INDETERMINADO.\n' +
    `  SELECT chave AS nome, valor::bigint AS request_id\n` +
    `  FROM jsonb_each_text(${SENTINELA_MAPA}::jsonb) AS t(chave, valor)\n` +
    '),\n' +
    cteControleCredencial({
      cabeca:
        '  -- Mesma mecânica da sonda (é a MESMA função que emite este CTE): o 401 é ambíguo aqui\n' +
        '  -- também, mas o par que ele separa é OUTRO — bundle sem a canária × CRON_SECRET\n' +
        '  -- inválido — e por isso o veredito que o consome fica no bloco, não aqui.\n',
      exclusao:
        '    -- Aqui o mapa `ids` é SEMPRE embutido pelo disparo, então esta exclusão sempre vale:\n' +
        '    -- o 401 desta leva não conta como recusa contra si mesmo.\n',
    }) +
    'lidas AS (\n' +
    '  -- Parte de `esperado`: zero linhas não pode virar "nada a reportar". O envelope `data` é\n' +
    '  -- descido aqui porque a omie-analytics-sync responde `{success, data:{...}}` e as outras no\n' +
    '  -- topo — sem o COALESCE as DUAS canárias dela sairiam como "sem eco".\n' +
    '  SELECT esp.nome, esp.campo_marcador, esp.marcador_esperado, esp.efeito,\n' +
    '         mp.request_id, resp.status_code, resp.created,\n' +
    '         resp.error_msg AS erro_transporte,\n' +
    '         CASE WHEN resp.content IS NOT NULL AND left(ltrim(resp.content), 1) = \'{\'\n' +
    "              THEN COALESCE(resp.content::jsonb -> 'data', resp.content::jsonb)\n" +
    '         END AS corpo\n' +
    '  FROM esperado esp\n' +
    '  LEFT JOIN ids mp ON mp.nome = esp.nome\n' +
    '  LEFT JOIN net._http_response resp ON resp.id = mp.request_id\n' +
    '),\n' +
    cteControleAtivo({
      cabeca:
        '  -- Mesma mecânica da sonda (é a MESMA função que emite este CTE), com a testemunha do\n' +
        '  -- OUTRO eco: aqui o que identifica o bundle é `canary:true` + o MARCADOR esperado.\n' +
        '  -- ⚠️ E aqui a testemunha NÃO exige 2xx: a generate-tactical-plan responde HTTP 500 quando\n' +
        '  --    a canária dela REPROVA, e isso é regressão de NEGÓCIO — o request já tinha passado\n' +
        '  --    pelo gate para chegar a executar a fixture. Exigir 2xx descartaria justamente a\n' +
        '  --    resposta que mais prova a credencial.\n',
      alias: 'ca',
      testemunha:
        `ca.corpo ->> 'canary' = 'true'\n` +
        `                            AND ca.created > now() - interval '${janelaMin} minutes'\n` +
        `                            AND ca.corpo ->> ca.campo_marcador = ca.marcador_esperado`,
    }) +
    'SELECT ca.nome,\n' +
    '       ca.request_id,\n' +
    '       ca.status_code,\n' +
    "       ca.corpo ->> 'canary' AS canary_respondido,\n" +
    '       ca.corpo ->> ca.campo_marcador AS marcador_respondido,\n' +
    '       ca.marcador_esperado,\n' +
    "       ca.corpo ->> 'ok' AS ok_respondido,\n" +
    '       CASE\n' +
    '         WHEN ca.request_id IS NULL\n' +
    `           THEN 'INDETERMINADO — esta canaria nao tem request_id no mapa embutido pelo passo ` +
    `${passoDisparo}. Isto e ausencia de dado, nao veredito: ou a trava ficou FECHADA e nada foi ` +
    `disparado, ou a celula veio de OUTRA leva'\n` +
    // Gêmeo do ramo da sonda: `error_msg` preenchido com status NULL é requisição MORTA, e o
    // AGUARDE mandaria repetir para sempre uma coisa que não vai chegar.
    '         WHEN ca.erro_transporte IS NOT NULL\n' +
    `           THEN 'FALHA DE TRANSPORTE — a requisicao nao chegou a ter resposta HTTP: ' ||\n` +
    `                ca.erro_transporte || '. Isto NAO e veredito de canaria e NAO adianta repetir ` +
    `sem antes resolver a causa (DNS, timeout, rede do pg_net)'\n` +
    '         WHEN ca.status_code IS NULL\n' +
    `           THEN 'AGUARDE — o request_id embutido pelo passo ${passoDisparo} ainda nao tem ` +
    `resposta HTTP (leva ~10s); rode este passo de novo'\n` +
    `         WHEN ca.created <= now() - interval '${janelaMin} minutes'\n` +
    `           THEN 'INDETERMINADO — a resposta e de ' || ca.created || ', FORA da janela de ` +
    `${janelaMin} min: esta celula e de outra sessao e o veredito seria de um deploy anterior. ` +
    `Redispare o passo ${passoDisparo}'\n` +
    // ------------------------------------------------------------------ SEM CANARIA NO AR ---
    // O eco vem ANTES do status de propósito: a generate-tactical-plan devolve 500 quando a
    // canária dela REPROVA, e julgar pelo status primeiro leria regressão como bundle velho.
    `         WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca.status_code = 401\n` +
    `              AND ativo.aceitas_na_leva >= 1\n` +
    `           THEN 'SEM CANARIA NO AR — 401, e a credencial DESTE disparo esta PROVADA ` +
    `ATIVAMENTE: ' || ativo.aceitas_na_leva || ' de ' || ativo.disparos_na_leva || ' request(s) ` +
    `desta leva voltou com o MARCADOR esperado, logo o x-cron-secret foi ACEITO neste instante e a ` +
    `recusa e da EDGE: o bundle no ar e anterior a canaria, ela NAO rodou e NADA executou. Isto ` +
    `NAO e canaria vermelha — o desfecho e DEPLOY'\n` +
    `         WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca.status_code = 401\n` +
    `           THEN 'INDETERMINADO — 401 nao separa bundle sem canaria de CRON_SECRET invalido, e ` +
    `NENHUMA aceitacao foi OBSERVADA nesta leva (0 testemunha de ' || ativo.disparos_na_leva ||\n` +
    `                ' disparo(s); 401: ' || ativo.recusadas_na_leva || ', sem resposta ainda: ' ||\n` +
    `                ativo.pendentes_na_leva || ', falha de transporte: ' || ativo.falhas_na_leva ||\n` +
    `                '). Isto e ausencia de prova, nao prova de secret ruim. Confira o CRON_SECRET ` +
    `no vault ANTES de redeployar.' || ` + contextoHistorico('cred') + `\n` +
    `         WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca.status_code >= 400\n` +
    `           THEN 'SEM CANARIA NO AR — o bundle recusou o request (HTTP ' || ca.status_code ||\n` +
    `                '), NADA executou. Isto NAO e canaria vermelha: nao ha canaria no ar para ` +
    `ficar vermelha'\n` +
    `         WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true'\n` +
    `           THEN 'SEM CANARIA NO AR — HTTP ' || ca.status_code || ' SEM eco canary: o bundle ` +
    `ignorou a flag e RODOU O FLUXO REAL (' || ca.efeito || '). Isto NAO e canaria vermelha, e ` +
    `canaria AUSENTE — e o efeito ja aconteceu'\n` +
    // ------------------------------------------------------------ marcador antes do `ok` ---
    '         WHEN ca.corpo ->> ca.campo_marcador IS NULL\n' +
    `           THEN 'CANARIA SEM MARCADOR — respondeu canary:true e o corpo NAO TEM o campo ' ||\n` +
    `                ca.campo_marcador || ': o bundle e anterior ao versionamento da canaria. O ok ` +
    `sozinho NAO discrimina reversao de fatia (armadilha 2 do deploy.md). PRECISA DEPLOY'\n` +
    '         WHEN ca.corpo ->> ca.campo_marcador IS DISTINCT FROM ca.marcador_esperado\n' +
    `           THEN 'CANARIA DE OUTRA FATIA — respondeu ' || ca.campo_marcador || '=' ||\n` +
    `                COALESCE(ca.corpo ->> ca.campo_marcador, '?') || ' (esperado ' ||\n` +
    `                ca.marcador_esperado || '). O bundle velho carrega o expected VELHO e compara ` +
    `velho x velho, entao o ok dele nao vale — e assim que uma reversao MENTE VERDE. PRECISA DEPLOY'\n` +
    `         WHEN ca.corpo ->> 'ok' IS NULL\n` +
    `           THEN 'CANARIA SEM VEREDITO — canary:true e marcador batendo, mas o corpo nao traz ` +
    `ok. Fail-closed: sem os TRES campos nao ha confirmacao'\n` +
    `         WHEN ca.corpo ->> 'ok' = 'false'\n` +
    `           THEN 'CANARIA VERMELHA — o bundle no ar E o esperado (' || ca.marcador_esperado ||\n` +
    `                ') e a fixture REPROVOU: o comportamento regrediu. NAO e deploy pendente — ` +
    `leia os casos do corpo para saber QUAL lado caiu'\n` +
    `         WHEN ca.corpo ->> 'canary' = 'true'\n` +
    '              AND ca.corpo ->> ca.campo_marcador = ca.marcador_esperado\n' +
    `              AND ca.corpo ->> 'ok' = 'true'\n` +
    "           THEN 'CANARIA VERDE'\n" +
    `         ELSE 'INDETERMINADO — combinacao nao prevista: canary=' ||\n` +
    `              COALESCE(ca.corpo ->> 'canary', '?') || ', ' || ca.campo_marcador || '=' ||\n` +
    `              COALESCE(ca.corpo ->> ca.campo_marcador, '?') || ', ok=' ||\n` +
    `              COALESCE(ca.corpo ->> 'ok', '?')\n` +
    '       END AS veredito\n' +
    'FROM lidas ca CROSS JOIN controle_credencial cred CROSS JOIN controle_ativo ativo\n' +
    'ORDER BY ca.nome;\n'
  );
}

/** A leva de canárias pedida, e o recorte. */
export interface OpcoesCanaria {
  raiz: string;
  /** Nomes do registro `CANARIAS`. Vazio = todas as alcançáveis. */
  nomes: string[];
  janelaMin?: number;
  ler: LeitorCanariasDoRepo;
}

/**
 * Recusa uma leva com nome repetido, ou não faz nada. LANÇA — nenhum SQL deve sair de leva torta.
 *
 * Mora aqui, e não dentro de `parsearArgs`, porque a CLI não é a única fronteira que pede uma leva:
 * `db/lib/gerar-canaria-fixture.ts` é a segunda, e enquanto esta checagem viveu só no parse de
 * argumentos as duas discordaram em silêncio. MEDIDO em 2026-09-09, com `copilot-analyze` pedida
 * duas vezes: a CLI saiu 1 com ZERO bytes, e a fixture saiu 0 com 10 180 bytes carregando a linha
 * DUPLICADA no `VALUES` — ou seja, a prova executada julgava um SQL que a CLI se recusa a emitir.
 * Fronteira nova que chame o gerador chama esta função; é ela, não o parse, que define leva válida.
 *
 * `duplicadas`, e não `repetidas`: a sonda já tem uma `repetidas` sua, e o nome colidido faz o
 * `sed` do `scripts/mutcheck.d/sonda-versao-sql.mut` tocar duas linhas e a mutação virar inválida.
 */
export function recusarCanariasRepetidas(nomes: readonly string[]): void {
  const duplicadas = nomes.filter((e, i) => nomes.indexOf(e) !== i);
  if (duplicadas.length > 0) {
    throw new Error(
      `canária repetida na leva: ${[...new Set(duplicadas)].join(', ')} — ` +
        'linha duplicada no VALUES é canária disparada duas vezes.',
    );
  }
}

/**
 * Gera o SQL de verificação das canárias.
 *
 * A divisão em blocos é a MESMA da sonda, e pela mesma fronteira de permissão: o disparo precisa de
 * ESCRITA (vault + INSERT do `net.http_post`) e passa pelo founder no SQL Editor; a leitura é SELECT
 * em `net._http_response` e roda no `psql-ro`. O que muda é que aqui a leitura NÃO tem versão
 * standalone — ela nasce dentro da célula que o disparo devolve.
 */
export function gerarSqlDasCanarias(opts: OpcoesCanaria): string {
  const janelaMin = validarJanela(opts.janelaMin);
  const pedidas =
    opts.nomes.length > 0
      ? opts.nomes
      : CANARIAS.filter((c) => c.inalcancavel === null).map((c) => c.nome);
  return gerarSqlDeCanariasResolvidas(
    opts.raiz,
    resolverCanarias(opts.raiz, pedidas, opts.ler),
    janelaMin,
  );
}

/**
 * O SQL de uma leva JÁ resolvida — a metade que a CLI usa, para resolver uma vez só.
 *
 * A separação não é estética: o guard de sincronia confere a proveniência da leva que ele recebeu,
 * e o SQL tem de sair DESSA MESMA leva. Enquanto `main` resolvia por um lado e `gerarSqlDasCanarias`
 * resolvia por dentro, havia duas leituras do `index.ts` na mesma execução — uma aprovada, outra
 * emitida, e nada obrigando as duas a concordar.
 */
export function gerarSqlDeCanariasResolvidas(
  raiz: string,
  leva: readonly CanariaResolvida[],
  janelaMinValidada: number,
): string {
  const janelaMin = janelaMinValidada;
  const ref = lerProjectRef(raiz);
  const baratas = leva.filter((c) => !c.fluxoRealSeVelho);
  const caras = leva.filter((c) => c.fluxoRealSeVelho);
  const partes: string[] = [];

  if (baratas.length > 0) {
    partes.push(
      `-- PASSO 1 — dispara as ${baratas.length} canária(s) cujo bundle velho NÃO cai em efeito caro.\n` +
        '--          Exige ESCRITA: lê o vault e faz INSERT, e o read-only recusa os dois — o que\n' +
        '--          NÃO é o mesmo que "só o founder consegue". Caminho da SESSÃO: commite este\n' +
        '--          .sql em db/ e rode `bun run db:aplicar db/<arquivo>.sql` (`--ensaio` antes) —\n' +
        '--          o envelope, com sha256, ledger e marcador de fim. Colar no SQL Editor é o\n' +
        '--          FALLBACK: de quem só tem o psql-ro (docs/agent/database.md §"o ENVELOPE").\n' +
        '-- Ele DEVOLVE o passo 2 já escrito, com o mapa nome→id dentro: copie a saída inteira — a\n' +
        '-- célula do SQL Editor, ou o log que o db:aplicar aponta no fim.\n' +
        blocoDisparoCanaria(ref, baratas, 1, janelaMin),
    );
  }

  if (caras.length > 0) {
    partes.push(
      `-- PASSO 3 — dispara as ${caras.length} canária(s) CARAS, com trava.\n` +
        '-- ⚠️ Bundle sem a canária IGNORA a flag e RODA O FLUXO REAL destas:\n' +
        caras.map((c) => `--    · ${c.nome}: ${c.efeitoSeVelho}\n`).join('') +
        '--    Só abra a trava depois de o deploy estar confirmado por outro caminho (a SONDA da\n' +
        '--    edge, `bun run sonda:sql <edge>`, responde antes de qualquer I/O e não tem efeito).\n' +
        '-- ⚠️ A trava é CASE e NÃO um filtro: o Postgres avalia a projeção mesmo descartando todas\n' +
        '--    as linhas, então travar por filtro deixa o http_post sair igual.\n' +
        '-- Ele também DEVOLVE o passo 4 já escrito, com o mapa dentro: copie a célula inteira.\n' +
        blocoDisparoCanaria(ref, caras, 3, janelaMin, true),
    );
  }

  return partes.join('\n');
}

/** A leva pedida na linha de comando. */
export interface ArgsCli {
  edges: string[];
  caras: string[];
  janelaMin?: number;
  soDisparo?: boolean;
  soLeitura?: boolean;
  semRede?: boolean;
  /** Libera o bloco LEGADO (POST direto na edge) para uma edge que já tem o caminho seguro. */
  permitirEfeitoLegado?: boolean;
  /** Modo CANÁRIA: os posicionais deixam de ser edges e viram nomes do registro `CANARIAS`. */
  canaria?: boolean;
}

const USO =
  'uso: bun run sonda:sql <edge> [<edge> ...] [--caro=<edge>[,<edge>]] [--permitir-efeito-legado]\n' +
  '                        [--janela=<min>] [--so-disparo | --so-leitura]\n' +
  '     bun run sonda:sql --canaria [<canaria> ...] [--janela=<min>]\n' +
  '  <edge>        nome do diretório em supabase/functions/ (precisa ter versao.ts)\n' +
  '  --canaria     verifica a CANÁRIA (comportamento) em vez da sonda (bundle). Sem nomes, faz\n' +
  '                todas as alcançáveis pelo SQL Editor. O corpo de disparo e o marcador esperado\n' +
  '                saem do registro/repo — nunca digitados. Nomes registrados:\n' +
  CANARIAS.map((c) => `                  ${c.nome}${c.inalcancavel === null ? '' : '  (inalcançável pelo SQL Editor)'}\n`).join('') +
  '  --caro        marca um SUBCONJUNTO da leva cujo bundle pré-sensor dispara o fluxo real;\n' +
  '                essas saem em bloco separado, com trava por CASE.\n' +
  `  --janela      janela do guard temporal da leitura, em minutos (padrão ${JANELA_PADRAO_MIN}, ` +
  `teto ${JANELA_MAX_MIN}).\n` +
  '  --so-disparo  emite só os blocos que precisam do FOUNDER (vault + INSERT).\n' +
  '  --so-leitura  emite só os blocos de leitura, que rodam no psql-ro — o agente lê sozinho.\n' +
  `  --sem-rede    não busca a ${REF_DEPLOYADA}; compara contra a cópia em disco e DIZ isso no SQL.\n` +
  '                Escada explícita para máquina offline — não desliga o guard de sincronia.';

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
  let janelaMin: number | undefined;
  let soDisparo: boolean | undefined;
  let soLeitura: boolean | undefined;
  let semRede: boolean | undefined;
  let permitirEfeitoLegado: boolean | undefined;
  let canaria: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--canaria') {
      canaria = true;
      continue;
    }
    if (arg === '--caro' || arg.startsWith('--caro=')) {
      const bruto = arg === '--caro' ? argv[++i] : arg.slice('--caro='.length);
      if (!bruto) throw new Error(`--caro sem valor.\n${USO}`);
      caras.push(...bruto.split(',').filter((s) => s.length > 0));
      continue;
    }
    if (arg === '--janela' || arg.startsWith('--janela=')) {
      const bruto = arg === '--janela' ? argv[++i] : arg.slice('--janela='.length);
      const n = Number(bruto);
      // `Number('')` é 0 e `Number(undefined)` é NaN: os dois caem aqui, e nenhum vira o padrão.
      if (!bruto || !Number.isInteger(n)) {
        throw new Error(`--janela precisa ser um inteiro de minutos (recebi ${bruto ?? '<nada>'}).\n${USO}`);
      }
      janelaMin = n;
      continue;
    }
    if (arg === '--permitir-efeito-legado') {
      permitirEfeitoLegado = true;
      continue;
    }
    if (arg === '--so-disparo') {
      soDisparo = true;
      continue;
    }
    if (arg === '--so-leitura') {
      soLeitura = true;
      continue;
    }
    if (arg === '--sem-rede') {
      semRede = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`flag desconhecida: ${arg}\n${USO}`);
    edges.push(arg);
  }

  if (canaria === true) {
    // As flags da sonda que NÃO têm sentido aqui são RECUSADAS, não ignoradas. Flag aceita em
    // silêncio é a via de "pedi --so-leitura e o SQL veio sem ela" — e `--caro` ignorado seria
    // pior: quem o passou acredita ter armado a trava, e a trava aqui vem do registro.
    const proibidas: string[] = [];
    if (soLeitura === true) {
      proibidas.push(
        '--so-leitura: a resposta da canária NÃO ecoa o slug da edge, então um bloco de leitura ' +
          'sem o mapa `nome → request_id` sairia INDETERMINADO em toda linha. Aqui a leitura já ' +
          'vem escrita DENTRO da célula que o passo de disparo devolve — é ela que roda no psql-ro',
      );
    }
    if (soDisparo === true) {
      proibidas.push(
        '--so-disparo: em modo canária TUDO o que se emite já é disparo (a leitura sai embutida ' +
          'na célula de resposta dele), então o recorte não recorta nada',
      );
    }
    if (caras.length > 0) {
      proibidas.push(
        '--caro: quais canárias caem em efeito caro num bundle velho é propriedade do CÓDIGO, e ' +
          'está no registro CANARIAS (`fluxoRealSeVelho`). Depender de o operador lembrar é como ' +
          'a trava deixa de ser armada justamente na noite em que ela importa',
      );
    }
    if (permitirEfeitoLegado === true) {
      proibidas.push('--permitir-efeito-legado: é do bloco legado da SONDA, não existe aqui');
    }
    if (proibidas.length > 0) {
      throw new Error(`flag sem sentido em modo canária —\n  ${proibidas.join('\n  ')}\n${USO}`);
    }
    recusarCanariasRepetidas(edges);
    // A forma dos nomes NÃO é validada por `FORMA_EDGE` (eles levam `:` quando a edge tem duas
    // canárias): quem valida é `resolverCanarias`, contra o registro, e um nome fora dele já sai
    // com a lista das opções — mais útil que "fora da forma".
    return { edges, caras, janelaMin, soDisparo, soLeitura, semRede, permitirEfeitoLegado, canaria };
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

  return { edges, caras, janelaMin, soDisparo, soLeitura, semRede, permitirEfeitoLegado, canaria };
}

/** Saídas da CLI, injetáveis para o teste ver o que foi escrito. */
export interface DependenciasCli {
  raiz: string;
  escrever: (texto: string) => void;
  erro: (texto: string) => void;
  /**
   * Edges que já têm o caminho seguro da sonda (o ramo `OPTIONS` + entrada na allowlist do cron).
   * Injetada, não importada: ver a nota em `guardEfeitoLegado`. Ausente = nenhuma, e o guard não
   * recusa nada — o que é o comportamento certo para quem chama sem conhecer a allowlist.
   */
  edgesComRele?: readonly string[];
  /**
   * O `git` que o guard de sincronia usa. OBRIGATÓRIO de propósito: opcional-com-default sumiria
   * silenciosamente em quem esquecesse de passá-lo, e um guard que some é fail-OPEN. Assim o
   * compilador cobra — quem chama `main` decide entre o `git` de verdade e um fabricado no teste.
   */
  git: ExecutorGit;
  /**
   * O leitor de canárias do repo. Injetado pelo mesmo motivo do `edgesComRele` (o eval copia só
   * dois arquivos), mas AUSENTE aqui é fail-CLOSED e não "nenhuma": sem ele o marcador esperado
   * teria de ser digitado, que é a via do veredito falso. `--canaria` sem leitor RECUSA.
   */
  lerCanarias?: LeitorCanariasDoRepo;
}

/** Ponto de entrada. Devolve o código de saída; NADA é escrito na saída quando falha. */
/**
 * O bloco LEGADO desta ferramenta faz `POST {"probe":true}` DIRETO na edge — e é o último caminho
 * de efeito que sobrou no mecanismo: num bundle que não conhece o classificador, esse POST executa
 * o fluxo real (medido: `monthly-report@ef08dddd2` chega ao Resend com 2 efeitos para um corpo
 * vazio; `calculate-scores@45a80118b`, 11 escritas).
 *
 * Para as edges que já têm o ramo `OPTIONS` e entraram na allowlist, existe caminho SEGURO: o relé.
 * Então aqui o legado deixa de ser o padrão e passa a exigir `--permitir-efeito-legado` — um aviso
 * impresso não basta, porque quem cola o bloco às 2 da manhã não lê o stderr.
 *
 * A allowlist chega por PARÂMETRO, e não por import de topo, por um motivo concreto: o eval da
 * skill `lovable-deploy-verify` COPIA este arquivo (mais o `sonda-fingerprint`) para um diretório
 * temporário e importa `gerarSqlDaLeva` de lá. Um import de topo para `supabase/functions/` não
 * resolve nesse contexto, e o módulo inteiro deixaria de carregar — foi assim que 7 cenários do
 * eval passaram a devolver `SQL_VAZIO`. Quem executa como CLI resolve a lista no fim do arquivo.
 */
export function guardEfeitoLegado(edges: string[], permitido: boolean, edgesComRele: readonly string[]): string | null {
  if (permitido) return null;
  const comRele = new Set(edgesComRele);
  const naAllowlist = edges.filter((e) => comRele.has(e));
  if (naAllowlist.length === 0) return null;
  const lista = naAllowlist.map((e) => `'${e}'`).join(', ');
  return (
    `RECUSADO: ${naAllowlist.join(', ')} já tem o caminho SEGURO da sonda (OPTIONS via relé).\n` +
    `O bloco desta ferramenta faz POST direto na edge, e num bundle velho isso executa o FLUXO REAL.\n\n` +
    `Use o relé — uma linha no SQL Editor, sem segredo no chat:\n` +
    `  SELECT * FROM public.deploy_sonda_disparar(ARRAY[${lista}]);\n\n` +
    `A resposta entra no ledger em ≤ 15 min; leia com \`bun run pendencias:deploy\`.\n` +
    `Se você PRECISA mesmo do bloco legado (a edge não está deployada com o ramo, por exemplo),\n` +
    `repita com --permitir-efeito-legado e confira o EFEITO declarado no versao.ts antes de colar.`
  );
}

export function main(argv: string[], deps: DependenciasCli): number {
  let sql: string;
  let aviso: string | null;
  try {
    const { edges, caras, janelaMin, soDisparo, soLeitura, semRede, permitirEfeitoLegado, canaria } =
      parsearArgs(argv);
    if (canaria === true) {
      if (deps.lerCanarias === undefined) {
        throw new Error(
          'modo canária sem leitor de canárias do repo: o marcador esperado sairia digitado, e ' +
            'marcador digitado é a via do veredito FALSO que esta ferramenta fecha. Quem chama ' +
            '`main` com --canaria precisa injetar `lerCanarias`. Nenhum SQL foi emitido.',
        );
      }
      const nomes =
        edges.length > 0
          ? edges
          : CANARIAS.filter((c) => c.inalcancavel === null).map((c) => c.nome);
      // UMA resolução: o guard confere os bytes DESTA leva, e é DESTA leva que o SQL sai. Resolver
      // duas vezes (uma para conferir, outra para gerar) é aprovar uma leitura e emitir a outra.
      const leva = resolverCanarias(deps.raiz, nomes, deps.lerCanarias);
      // O guard de sincronia vale IGUAL aqui, sobre a PROVENIÊNCIA do marcador — o `index.ts` de
      // onde o `contrato:` sai, e o `versao.ts` só quando a canária serve por referência. O
      // marcador é lido do DISCO, e disco atrás de `origin/main` produz o mesmo falso da sonda:
      // "canária de outra fatia" contra um repo local velho, não contra o bundle que está no ar.
      ({ aviso } = conferirSincronia(fontesDoEsperado(leva), semRede === true, deps.git));
      sql = gerarSqlDeCanariasResolvidas(deps.raiz, leva, validarJanela(janelaMin));
    } else {
      const recusa = guardEfeitoLegado(edges, permitirEfeitoLegado === true, deps.edgesComRele ?? []);
      if (recusa !== null) {
        deps.erro(`❌ ${recusa}`);
        return 1;
      }
      // A leva é resolvida ANTES do guard de sincronia porque as duas falhas competem pelo mesmo
      // texto e a da leva é mais específica: uma edge sem `versao.ts` deve ouvir "sem sensor", não
      // "não existe em origin/main". Nada é escrito até as DUAS passarem — `gerarSqlDaLeva` só
      // monta a string, e é este `escrever` lá embaixo que emite.
      const levaSondada = resolverLeva(deps.raiz, edges);
      ({ aviso } = conferirSincronia(fontesDoEsperado(levaSondada), semRede === true, deps.git));
      sql = gerarSqlDaLeva({
        raiz: deps.raiz,
        edges,
        caras,
        janelaMin,
        soDisparo,
        soLeitura,
        resolvida: levaSondada,
      });
    }
  } catch (e) {
    deps.erro(`❌ ${(e as Error).message}`);
    return 1;
  }
  if (aviso !== null) {
    deps.erro(aviso);
    // Também no SQL: o stderr some, e o SQL é o artefato que sobrevive colado num chat ou num PR.
    sql = `-- ${aviso.split('\n').join('\n-- ')}\n${sql}`;
  }
  deps.escrever(sql);
  return 0;
}

if (import.meta.main) {
  // Import DINÂMICO, e só aqui: quem apenas importa este módulo (o eval da skill, que o copia para
  // um diretório temporário) não pode depender de `supabase/functions/` resolver.
  const { SONDA_CRON_ALVOS } = await import('../supabase/functions/_shared/sonda-cron-alvos');
  // O leitor de canárias sai daqui pela MESMA razão, e mora num módulo PRÓPRIO
  // (`canaria-leitor-do-repo.ts`) porque a prova executada precisa do MESMO leitor: duas cópias da
  // regra "onde mora o marcador" divergiriam, e a prova continuaria verde julgando um SQL que não é
  // o que o operador cola.
  const { lerCanariasDoRepo } = await import('./canaria-leitor-do-repo');
  process.exit(
    main(process.argv.slice(2), {
      raiz: join(import.meta.dirname, '..'),
      escrever: (t) => process.stdout.write(t),
      erro: (t) => console.error(t),
      git: gitReal(join(import.meta.dirname, '..')),
      edgesComRele: SONDA_CRON_ALVOS.map((a) => a.edge),
      lerCanarias: lerCanariasDoRepo,
    }),
  );
}
