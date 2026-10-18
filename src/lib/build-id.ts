/**
 * Identidade do BUILD que está EXECUTANDO no browser do cliente.
 *
 * POR QUE ISTO EXISTE (custou um dia em 2026-08-24): o service worker roda com
 * `registerType: 'prompt'` e SEM `skipWaiting` (vite.config.ts) — por DESENHO, pra
 * um deploy não recarregar o app do separador no meio de um picking. Consequência
 * permanente: o SW novo instala e ESPERA indefinidamente por um clique humano. O
 * #1934, o #1945 e o #1949 estavam os três publicados no servidor e NENHUM
 * executava no browser do founder — o SW servia `index-DghZxghH.js` enquanto o
 * servidor entregava `index-DnOk4g4H.js`. A descoberta foi ACIDENTAL (um toast num
 * screenshot). Não havia query capaz de responder isso.
 *
 * O `verify-frontend.sh` prova o que o servidor ENTREGA, nunca o que o browser
 * EXECUTA: responde DISPONIBILIDADE, não ADOÇÃO. Este módulo fecha a outra ponta.
 *
 * POR QUE O CHUNK DO ENTRY, e não o commit:
 *  - `__COMMIT_SHA__` degradava pra "dev" em produção (builder do Lovable sem `.git`,
 *    2026-06-19). Desde 2026-10-18 o Publish expõe o SHA — mas o motivo de fundo fica:
 *    um id constante entre builds (preview e Publish do MESMO commit são dois builds)
 *    não identifica build. O commit é a VERSÃO legível (menu), não o eixo de adoção.
 *  - O hash do entry é CONTENT-HASH do Vite: nasce sempre, sem depender de env, e
 *    muda se e somente se o app mudou (dois Publish do mesmo código = mesmo id, o
 *    que evita falso "não adotou").
 *  - É o MESMO eixo que o verificador já lê do servidor —
 *    `verify-frontend.sh:50` faz `grep -oE '/assets/index-[A-Za-z0-9_-]+\.js'` no
 *    HTML. Servidor e cliente ficam comparáveis SEM tabela de tradução.
 *
 * ⚠️ O regex abaixo é o gêmeo do que está no `verify-frontend.sh`. Mudou lá, muda
 * aqui — senão os dois lados da conta de adoção param de casar (e o sintoma é
 * "adoção 0%", indistinguível de ninguém ter atualizado).
 */
const RE_ENTRY = /\/assets\/(index-[A-Za-z0-9_-]+)\.js/;

/**
 * Valor EXPLÍCITO quando não dá pra saber o build (dev, SSR, HTML de forma nova).
 *
 * Deliberadamente não é `undefined`/propriedade omitida: evento SEM a propriedade
 * significa "build anterior a esta instrumentação", que é informação diferente de
 * "build atual, mas o entry não foi encontrado". Fabricar um id seria pior que
 * ambos — colapsar os dois casos num só é o que cega a medição.
 */
export const BUILD_ID_DESCONHECIDO = 'desconhecido';

/** Primeiro src que parecer o entry do Vite vence. Puro — o miolo testável. */
export function extrairBuildId(srcs: readonly string[]): string {
  for (const src of srcs) {
    const casou = RE_ENTRY.exec(src);
    if (casou?.[1]) return casou[1];
  }
  return BUILD_ID_DESCONHECIDO;
}

/**
 * Lê o entry do documento que o browser REALMENTE carregou. Quando o SW velho
 * está no controle, ele serve o `index.html` PRECACHEADO — que aponta pro entry
 * velho. É justamente essa a leitura que queremos.
 */
export function resolverBuildId(doc: Document | null | undefined = globalThis.document): string {
  if (!doc) return BUILD_ID_DESCONHECIDO;
  const srcs = Array.from(doc.querySelectorAll('script[src]'), (s) => s.getAttribute('src') ?? '');
  return extrairBuildId(srcs);
}

/**
 * Carimbo ORDENÁVEL do build (ISO-8601, quando o Vite rodou) — o `<meta name="app-build-em">`
 * que o `vite.config.ts` injeta no index.html. Complementa o `build_id`, não o substitui:
 * o hash do entry identifica o build e é o eixo de ADOÇÃO (dois Publish do mesmo código = o
 * mesmo id); o carimbo só responde "este build é anterior àquele?", que é o que o build
 * mínimo (`pwa-build-minimo.ts`) precisa e o hash não sabe dizer.
 *
 * Ausente/ilegível → `null` (ausência de dado, nunca "build antigo" nem "build novo").
 */
const META_BUILD_EM = 'app-build-em';
const RE_META_BUILD_EM = /<meta\s+name="app-build-em"\s+content="([^"]+)"/;

function carimboValido(v: string | null | undefined): string | null {
  return v && Number.isFinite(Date.parse(v)) ? v : null;
}

/** Lê o carimbo do HTML como TEXTO (o index.html que o servidor entrega agora). */
export function extrairBuildEm(html: string): string | null {
  return carimboValido(RE_META_BUILD_EM.exec(html)?.[1]);
}

/** Lê o carimbo do documento que o browser REALMENTE carregou — mesmo documento do `build_id`. */
export function resolverBuildEm(doc: Document | null | undefined = globalThis.document): string | null {
  if (!doc) return null;
  return carimboValido(doc.querySelector(`meta[name="${META_BUILD_EM}"]`)?.getAttribute('content'));
}

/**
 * COMMIT de que este build saiu — `<meta name="app-commit-sha">` e `app-commit-em`
 * (data do commit, ISO), também injetados pelo `vite.config.ts`. É a "versão" que o
 * menu mostra: igual no preview e no Publish do mesmo commit, ao contrário do carimbo
 * de build e do hash do entry. Só existem quando o builder tem `.git`; ausentes → null.
 */
const META_COMMIT_SHA = 'app-commit-sha';
const META_COMMIT_EM = 'app-commit-em';
const RE_META_COMMIT_EM = /<meta\s+name="app-commit-em"\s+content="([^"]+)"/;

/** Lê a data do commit do HTML como TEXTO (o index.html que o servidor entrega agora). */
export function extrairCommitEm(html: string): string | null {
  return carimboValido(RE_META_COMMIT_EM.exec(html)?.[1]);
}

/** Commit do documento que o browser REALMENTE carregou. */
export function resolverCommit(
  doc: Document | null | undefined = globalThis.document,
): { sha: string | null; em: string | null } {
  if (!doc) return { sha: null, em: null };
  const sha = doc.querySelector(`meta[name="${META_COMMIT_SHA}"]`)?.getAttribute('content')?.trim() || null;
  const em = carimboValido(doc.querySelector(`meta[name="${META_COMMIT_EM}"]`)?.getAttribute('content'));
  return { sha, em };
}
