/**
 * authz-carimbo.ts — núcleo PURO do carimbo de evidência dos audits de produção.
 * ============================================================================================
 *
 * O PROBLEMA que este módulo existe para fechar. Os audits de prod (`authz:funcoes:prod`,
 * `authz:grants:prod`, `authz:audit:prod`) são a ÚNICA guarda que enxerga dois vetores que o gate
 * estático do CI não alcança por construção: (1) `GRANT`/`REVOKE` colado à mão no SQL Editor do
 * Lovable, que não passa por migration nenhuma; (2) migration que mergeou na main e nunca foi
 * aplicada. Eles não rodam no CI porque o runner não tem — e não deve ter — a credencial `psql-ro`.
 * Sem cadência, a garantia deles é "alguém rodou um dia", que é a classe registrada em
 * `docs/historico/fase-sem-sinal.md`: ausência de sinal lida como aprovação. O próprio doc do
 * domínio já havia NOMEADO a lacuna (`sentinela-authz-controle-nao-mencao.md` §9.6):
 * "roda on-demand. Entre duas execuções, a janela existe."
 *
 * O DESENHO: a MEDIÇÃO fica onde a credencial está (a máquina do founder) e o SINAL fica onde a
 * cadência já existe (o CI, que roda `schedule` diário na main). A ponte é este carimbo — um
 * artefato versionado que o runner escreve e o gate lê.
 *
 * ⚠️ LIMITE DECLARADO, e ele é a primeira coisa que se lê aqui de propósito: o carimbo é um
 * AUTO-RELATO. Nada dentro do repo prova que o comando rodou — a credencial vive fora dele. O que
 * o gate garante é "alguém rodou ESTES auditores contra ESTE contrato há no máximo N dias", e a
 * defesa contra fabricação é econômica, não criptográfica: rodar o comando é 1 linha, forjar o
 * JSON exige manter DOIS fingerprints coerentes à mão. O modelo de ameaça é ERRO, não fraude.
 *
 * ⚠️ LIMITE DE ESCOPO — o carimbo NÃO atesta "a autorização de prod". Atesta FATIAS CURADAS
 * dela, com pontos cegos medidos (não deduzidos), listados em `docs/agent/database.md` §1:
 *   · o audit de grants passou a medir os 8 privilégios que o tipo `Priv` declara (#2062,
 *     2026-08-27) — `REFERENCES`/`TRIGGER` deixaram de ser declaráveis-e-nunca-medidos, e no PG17
 *     o `MAINTAIN` entra pelo ramo de versão. ⚠️ Este bullet ficou 1 commit AFIRMANDO a lacuna
 *     depois de ela ser fechada: o #2062 corrigiu o auditor e não voltou aqui. Limite declarado
 *     também envelhece — e um que descreve um buraco JÁ fechado engana na direção oposta, fazendo
 *     alguém "consertar" o que já está certo;
 *   · ACL por COLUNA fica fora (`has_table_privilege` é table-level) — e é justamente o vetor que
 *     importa em `sales_orders` (`GRANT SELECT (omie_payload)`);
 *   · RLS vivo passou a ser reconciliado em 2026-08-27 pelo `authz:rls:prod` (a chave `rls`, ver
 *     AUDITS) — mas com escopo declarado, não total: o INTERRUPTOR (`relrowsecurity`) é universal,
 *     enquanto o CONTEÚDO das policies e o corpo dos predicados cobrem 7 tabelas curadas de 335.
 *     As outras ~328 seguem com o conteúdo das policies **não** reconciliado, e o que a guarda não
 *     alcança em eixo nenhum (bypass por `service_role`/SECDEF/view `invoker=off`, ACL por coluna,
 *     o 2º nível do grafo de predicados) está no cabeçalho de `scripts/lib/authz-rls.ts`.
 * Dizer isso vale mais do que um carimbo que finge cobrir tudo: contrato falso é pior que lacuna,
 * porque o CI passa a AFIRMAR cobertura que não existe (a regra é do cabeçalho do AUTHZ_MANIFEST).
 *
 * ⚠️ Este bullet é a prova de que o formato funciona — e do seu limite. A lacuna de RLS ficou
 * escrita aqui, correta e visível, e ainda assim `relrowsecurity` passou sem leitor até alguém
 * escrever o comando. Declarar o não-medido impede o verde de mentir; não fecha o buraco.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTHZ_FUNCOES_FECHADAS } from '../authz-funcoes-fechadas';
import { AUTHZ_TABELAS_FECHADAS } from '../authz-tabelas-fechadas';
import { AUTHZ_MANIFEST } from '../authz-manifest';
import { AUTHZ_REESCRITAS_CONHECIDAS } from '../authz-reescritas-conhecidas';
import {
  AUTHZ_RLS_ESPERADO,
  AUTHZ_RLS_PREDICADOS,
  LACUNAS_DECLARADAS,
  LACUNAS_POR_GRUPO,
  PREDICADOS_PLATAFORMA,
} from '../authz-rls-esperado';

/** Raiz do repo, a partir de `scripts/lib/` — o gate roda do CI e do laptop, e `process.cwd()`
 *  difere entre os dois. */
export const RAIZ = join(import.meta.dirname, '..', '..');
export const CARIMBO_PATH = join(RAIZ, 'db', 'authz-carimbo-prod.json');

/** Versão do FORMATO do carimbo. Bump ⇒ carimbo antigo é ilegível ⇒ fail-closed (re-medir).
 *
 *  v2 (2026-08-27): entrou a 5ª chave, `rls`. O bump é OBRIGATÓRIO e não cosmético — um carimbo v1
 *  não tem o campo `audits.rls`, e sem ele o gate leria a ausência do audit de RLS como "não há
 *  nada a dizer sobre RLS" em vez de "isto nunca foi medido". Ausência de dado não é aprovação: o
 *  carimbo antigo passa a ser rejeitado, e a renovação (`bun run authz:carimbo:gravar`) é o que
 *  devolve o verde — com o eixo novo medido junto.
 *
 *  v3 (2026-09-26): entrou a 6ª chave, `corpo` — a deriva de CORPO das funções `public`
 *  (`deriva:corpo:prod`). Mesmo argumento do v2: um carimbo v2 não tem `audits.corpo`, e a
 *  ausência se leria como "nada a dizer sobre corpo" em vez de "nunca medido". */
export const SCHEMA_VERSION = 3;

/**
 * Os dois limiares de idade, e por que são DOIS.
 *
 * `VENCIDO_DIAS` é a decisão do founder (2026-08-25). `AVISO_DIAS` existe porque o parecer do
 * Codex (xhigh) apontou, com razão, que N NÃO é a latência de detecção: a janela real é
 * `N + atraso do schedule + tempo até alguém rodar + tempo até o founder aplicar`. O aviso não
 * bloqueia nada e não abre incidente — ele aparece na saída e no corpo da Issue, para que a
 * renovação aconteça ANTES do vencimento em vez de depois. Ratchet: baixar `VENCIDO_DIAS` é
 * mudar UMA constante aqui; todo o resto (gate, job, testes) lê daqui.
 */
export const AVISO_DIAS = 7;
export const VENCIDO_DIAS = 14;

export type ChaveAudit = 'funcoes' | 'grants' | 'audit' | 'claudeRo' | 'rls' | 'corpo';

/** Os audits de prod, com o script npm que os roda e os arquivos que compõem cada FINGERPRINT.
 *
 *  `contrato` = o que o audit COMPARA (o que o repo declara). `auditor` = o INSTRUMENTO que faz a
 *  comparação. São eixos distintos e o bug de `REFERENCES`/`TRIGGER` é a prova de por quê: com
 *  contrato idêntico e instrumento incompleto, o verde é cegueira. Mexer no instrumento invalida a
 *  medição anterior tanto quanto mexer no contrato — logo os dois entram no carimbo. */
export const AUDITS: Record<
  ChaveAudit,
  {
    script: string;
    auditorFiles: string[];
    /** `true` quando o CONTRATO daquele audit é a baseline embutida no próprio auditor, e não um
     *  módulo de contrato do repo. Nesse caso os dois fingerprints coincidem — redundante, mas
     *  VERDADEIRO: editar o arquivo muda as duas coisas ao mesmo tempo, e fingir que são eixos
     *  independentes seria inventar uma separação que não existe. */
    contratoEmArquivo?: true;
  }
> = {
  funcoes: {
    script: 'authz:funcoes:prod',
    auditorFiles: ['db/audit-grants-funcoes-fechadas.ts', 'scripts/lib/authz-funcoes.ts'],
  },
  grants: {
    script: 'authz:grants:prod',
    auditorFiles: ['db/audit-grants-tabelas-fechadas.ts', 'scripts/lib/authz-grants.ts'],
  },
  audit: {
    script: 'authz:audit:prod',
    auditorFiles: ['db/audit-authz-reescritas-prod.ts', 'scripts/lib/authz-contract.ts'],
  },
  // Chegou 12 commits DEPOIS deste carimbo nascer (#e59591b9), e entrou aqui pela mesma razão que
  // o carimbo existe: o cabeçalho dela diz ser "o único artefato que afirma, com evidência, que o
  // estado de 2026-08-25 ainda é o estado de hoje" — e não tinha runner periódico nenhum. Um
  // carimbo que enumerasse 3 de 4 nasceria vencido.
  claudeRo: {
    script: 'authz:claude-ro:prod',
    auditorFiles: ['db/audit-claude-ro-hardening.ts'],
    contratoEmArquivo: true,
  },
  // A QUARTA guarda (2026-08-27), e a que fecha um ponto cego que o cabeçalho DESTE arquivo já
  // nomeava: "RLS vivo (`relrowsecurity`, policies, `qual`/`with_check`) não é reconciliado por
  // nenhum dos três — um `ALTER TABLE … DISABLE ROW LEVEL SECURITY` à mão sai verde". Entrar aqui
  // é o que lhe dá cadência; sem isso ela seria mais um comando que "alguém rodou um dia".
  //
  // O `contrato` dela tem TRÊS partes porque o audit compara três coisas independentes, e o
  // fingerprint precisa cobrir as três: mexer só nos predicados (sem tocar policy nenhuma) muda o
  // que prod tem de satisfazer tanto quanto mexer numa policy.
  rls: {
    script: 'authz:rls:prod',
    auditorFiles: ['db/audit-rls-prod.ts', 'scripts/lib/authz-rls.ts'],
  },
  // A SEXTA guarda (2026-09-26), e a primeira que não é de autorização: o CORPO de toda função
  // `public` que alguma migration define (`docs/historico/deriva-corpo-sem-sensor.md`). Nasceu do
  // `cancelar_pedido_sugerido` que rodou 18 dias o corpo de uma migration ANTERIOR sem nenhum audit
  // ver — entrar aqui é o que lhe dá cadência. O contrato é a baseline de deriva aceita, que mora
  // num JSON: por isso `contratoEmArquivo` e a baseline DENTRO de `auditorFiles`. As libs
  // compartilhadas entram também: a sonda (`precondicao-banco`), o extrator de declarações e o
  // leitor da ref DEFINEM o veredito, e mexer nelas invalida a medição tanto quanto mexer no runner.
  // O diretório de migrations NÃO entra — senão todo PR com migration invalidaria o carimbo; a
  // ref medida vai no denominador (`🔎 … origin/main@<sha>`).
  corpo: {
    script: 'deriva:corpo:prod',
    auditorFiles: [
      'db/audit-deriva-corpo-prod.ts',
      'scripts/lib/deriva-corpo.ts',
      'db/deriva-corpo-baseline.json',
      'scripts/lib/precondicao-banco.ts',
      'scripts/lib/corpo-esperado.ts',
      'scripts/lib/migration-objects.ts',
      'scripts/lib/migrations-da-ref.ts',
      'scripts/lib/sql-comentarios.ts',
    ],
    contratoEmArquivo: true,
  },
};

/**
 * Campos de APRESENTAÇÃO — excluídos do fingerprint de contrato.
 *
 * Eles são prosa para humano (`motivo`, `provaExecutada`): mudar a redação não muda o que prod
 * precisa satisfazer, e cobrar re-medição de prod por causa de um typo em comentário é o tipo de
 * atrito que faz gate morrer. TUDO o mais entra — a exclusão é uma LISTA FECHADA e essa direção é
 * deliberada: campo semântico novo entra no fingerprint por DEFAULT (fail-safe). A projeção
 * "enumero os campos que importam" tem a falha oposta — o campo novo nasce invisível — e é
 * exatamente o apodrecimento nº 1 previsto para este desenho.
 */
const CAMPOS_APRESENTACAO = new Set(['motivo', 'provaExecutada']);

/**
 * Serialização canônica e FAIL-CLOSED.
 *
 * 🔴 A armadilha que este código existe para não pisar: `JSON.stringify(new Set(['a']))` é `'{}'`
 * — Set e Map serializam VAZIO, sem erro. Um fingerprint ingênuo sobre os exports do contrato
 * nasceria CEGO a qualquer mudança neles (`ACKNOWLEDGED_SENSITIVE` e `ACL_ONLY_INTERNAL` são Set;
 * `REESCRITAS_CONHECIDAS_INDEX` é Map). Medido, não deduzido: `bun -e` devolve `Set -> {}`.
 *
 * Por isso: Set e Map são tratados EXPLICITAMENTE e com TAG de tipo — `Set(['a'])` não pode
 * colidir com `['a']`, senão trocar uma lista por um conjunto passaria batido. E qualquer valor
 * que este serializador não saiba representar (função, symbol, Date, instância de classe, bigint)
 * LANÇA em vez de virar `{}` ou `null`: é o mesmo princípio do resto do módulo — ausência de dado
 * não é aprovação, e um contrato futuro com valor exótico tem de quebrar o gate, não silenciá-lo.
 *
 * Ordem de array é PRESERVADA (não ordeno o conteúdo): reordenar vira "contrato mudou" e pede
 * re-medição. É um falso-positivo CONSERVADOR, e ordenar mascararia mudanças de multiplicidade.
 */
export function canonicalizar(v: unknown, caminho = '$'): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';

  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'number' || t === 'boolean') return String(v);

  if (Array.isArray(v)) {
    return `[${v.map((x, i) => canonicalizar(x, `${caminho}[${i}]`)).join(',')}]`;
  }
  if (v instanceof Set) {
    const itens = [...v].map((x, i) => canonicalizar(x, `${caminho}<set:${i}>`)).sort();
    return `Set(${itens.join(',')})`;
  }
  if (v instanceof Map) {
    const pares = [...v.entries()]
      .map(([k, val]) => `${canonicalizar(k, `${caminho}<key>`)}:${canonicalizar(val, `${caminho}[${String(k)}]`)}`)
      .sort();
    return `Map(${pares.join(',')})`;
  }
  if (t === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const obj = v as Record<string, unknown>;
    const chaves = Object.keys(obj)
      .filter((k) => !CAMPOS_APRESENTACAO.has(k))
      .sort();
    return `{${chaves.map((k) => `${JSON.stringify(k)}:${canonicalizar(obj[k], `${caminho}.${k}`)}`).join(',')}}`;
  }

  // Fail-closed: NÃO degrade para '{}' / 'null'. Um tipo que este serializador não conhece é um
  // ponto cego em potencial, e ponto cego silencioso é a falha que o módulo inteiro combate.
  throw new Error(
    `authz-carimbo: valor não-serializável em ${caminho} (tipo ${t}, ctor ${
      (v as object)?.constructor?.name ?? '?'
    }). Estenda canonicalizar() — NÃO ignore: valor não representado vira fingerprint cego.`,
  );
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** O DADO que cada audit compara contra prod.
 *
 *  Exportada para ser TESTÁVEL, e a razão é uma falsificação que passou verde: o teste do eixo de
 *  RLS montava `{tabelas, predicados, plataforma}` no próprio arquivo de teste e canonicalizava —
 *  o que prova que `canonicalizar` funciona, e NADA sobre esta função. Remover um eixo daqui não
 *  produzia vermelho nenhum. Assert que reconstrói a entrada em vez de exercer o caminho real é a
 *  forma mais discreta de teatro. */
export function dadoDoContrato(chave: ChaveAudit): unknown {
  switch (chave) {
    case 'funcoes':
      return AUTHZ_FUNCOES_FECHADAS;
    case 'grants':
      return AUTHZ_TABELAS_FECHADAS;
    case 'audit':
      // As DUAS entradas: o audit checa o gate do manifest no corpo vivo E o md5 das reescritas.
      return { manifest: AUTHZ_MANIFEST, reescritas: AUTHZ_REESCRITAS_CONHECIDAS };
    case 'claudeRo':
    case 'corpo':
      // Sem módulo de contrato: a baseline mora nos arquivos do auditor (ver `contratoEmArquivo`).
      return null;
    case 'rls':
      // As TRÊS: o conjunto de policies curadas, o md5 dos predicados que elas chamam, e quais
      // funções são da PLATAFORMA (o único eixo cuja mudança NÃO é achado — mover uma função para
      // dentro desse Set é afrouxar o contrato, e tem de mover o fingerprint junto).
      // `PREDICADOS_PLATAFORMA` é um Set: entra aqui já sabendo que `canonicalizar` o representa
      // com tag de tipo — um `JSON.stringify` ingênuo o serializaria como `{}` e o fingerprint
      // nasceria cego exatamente no eixo mais permissivo dos três.
      // `LACUNAS_DECLARADAS` entra pelo mesmo motivo que `PREDICADOS_PLATAFORMA`: mudá-la
      // AFROUXA o que o verde afirma. Tirar uma tabela de lá sem curá-la faz o contrato parar de
      // dizer "isto não é coberto" — e o carimbo passaria a atestar uma cobertura que ninguém
      // mediu, na direção que é mais difícil de notar (a de fingir que não há buraco).
      // `LACUNAS_POR_GRUPO` (5º, 2026-08-28) é o mesmo argumento um nível acima: baixar
      // `tabelasNoGrafo` de 22 para 21 faz o audit parar de acusar uma tabela que ENTROU no grupo,
      // sem curar nada — afrouxa o que o verde afirma, e é a mudança de uma linha só.
      return {
        tabelas: AUTHZ_RLS_ESPERADO,
        predicados: AUTHZ_RLS_PREDICADOS,
        plataforma: PREDICADOS_PLATAFORMA,
        lacunas: LACUNAS_DECLARADAS,
        grupos: LACUNAS_POR_GRUPO,
      };
  }
}

export function fingerprintContrato(chave: ChaveAudit): string {
  if (AUDITS[chave].contratoEmArquivo) {
    // O contrato É o arquivo. Hash dos bytes, pelo mesmo motivo do fingerprint de auditor: numa
    // baseline embutida, comentário também é contrato.
    const partes = AUDITS[chave].auditorFiles.map((rel) => `${rel}\n${readFileSync(join(RAIZ, rel), 'utf8')}`);
    return sha256(`v${SCHEMA_VERSION}|${chave}|arquivo|${partes.join('\n---\n')}`);
  }
  return sha256(`v${SCHEMA_VERSION}|${chave}|${canonicalizar(dadoDoContrato(chave))}`);
}

/** Fingerprint do INSTRUMENTO: bytes crus dos arquivos que executam a medição. Cru é o certo aqui
 *  — num auditor, comentário TAMBÉM é contrato (é onde moram os limites declarados), e o custo de
 *  um falso "re-meça" ao editar comentário de auditor é baixo (mexe-se raro). */
export function fingerprintAuditor(chave: ChaveAudit): string {
  const partes = AUDITS[chave].auditorFiles.map((rel) => `${rel}\n${readFileSync(join(RAIZ, rel), 'utf8')}`);
  return sha256(`v${SCHEMA_VERSION}|${chave}|${partes.join('\n---\n')}`);
}

/**
 * As env vars que trocam o CONTRATO de um audit por uma allowlist sintética (o harness PG17 usa
 * `AUTHZ_GRANTS_TEST_JSON`, `AUTHZ_RLS_TEST_JSON`, …). O runner do carimbo tem de RECUSAR todas —
 * carimbar com uma delas setada produz evidência sobre um contrato que não é o do repo.
 *
 * 🔴 Por que por PADRÃO e não por lista literal: a lista literal é um apodrecimento com data
 * marcada. Ela nasceu com dois nomes; o audit de RLS chegou depois com um terceiro, que a lista
 * não conhecia — e o runner teria carimbado um contrato de teste como se fosse produção, em
 * silêncio. Casar o PADRÃO faz o audit futuro nascer coberto, que é a direção certa para uma
 * guarda: falso-positivo (uma env `*_TEST_JSON` que não seja de contrato) custa uma
 * mensagem de erro; falso-negativo custa um carimbo mentiroso.
 *
 * 🔴 E o padrão também apodreceu (2026-10-01): era o PREFIXO `AUTHZ_`, e o audit de `claudeRo` lê
 * `CLAUDE_RO_BASELINE_TEST_JSON` — fora dele. O teste que "provava" a cobertura calculava um nome
 * canônico (`AUTHZ_CLAUDE_RO_TEST_JSON`) que auditor nenhum lê, e passava. Agora o padrão é o
 * SUFIXO, e o teste tira os nomes da FONTE dos auditores de `AUDITS` (scripts/authz-carimbo.test.ts).
 */
export function envDeTesteSetadas(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => /^[A-Z][A-Z0-9_]*_TEST_JSON$/.test(k) && env[k])
    .sort();
}

export interface Achado {
  /** Estável entre execuções e entre mudanças de PROSA do auditor: sai do código DELIMITADO
   *  (`[DRIFT_PROD]`) + o objeto, não da linha inteira. Se a forma não parsear, cai para a linha
   *  toda — fail-safe: id instável é melhor que id que colide entre achados distintos. */
  id: string;
  linha: string;
  /** Quando este achado foi visto PELA PRIMEIRA VEZ. Re-executar NUNCA reseta — senão a renovação
   *  do carimbo lava a dívida e um achado pode ficar "conhecido e fresco" para sempre. */
  primeiraVez: string;
  ultimaVez: string;
}

/** Extrai `[CODIGO] objeto` da linha do auditor. Conservador: sem match, a linha inteira vira id. */
export function idFinding(chave: ChaveAudit, linha: string): string {
  const norm = linha.trim().replace(/\s+/g, ' ');
  const m = /\[([A-Z_]+)\]\s*([^:]+):/.exec(norm);
  const base = m ? `${m[1]}|${m[2].trim()}` : norm;
  return sha256(`${chave}|${base}`).slice(0, 16);
}

/**
 * Escolhe a linha de VEREDITO na saída de um audit.
 *
 * 🔴 Bug real, pego ao integrar o 4º audit: a 1ª versão usava `find` (primeiro `✅`). O
 * `authz:claude-ro:prod` imprime 25 asserções `✅` e só a derradeira é a conclusão — o carimbo
 * passou a atestar "papel existe: SIM" como se fosse o veredito. Sumário vem no FIM.
 *
 * ⚠️ Isto é um contrato ACIDENTAL: raspar texto de saída humana é frágil por natureza, e a
 * correção definitiva é os audits emitirem resultado estruturado. Enquanto não emitem, a regra
 * fica aqui, nomeada e testada, em vez de escondida numa expressão dentro do runner.
 */
export function escolherResumo(linhas: string[]): string {
  const ultimoOk = [...linhas].reverse().find((l) => l.startsWith('✅'));
  return (ultimoOk ?? linhas[linhas.length - 1] ?? '').slice(0, 300);
}

export interface ResultadoAudit {
  script: string;
  exit: number;
  resumo: string;
  denominador: string | null;
  contratoFingerprint: string;
  auditorFingerprint: string;
  achados: Achado[];
}

export interface Carimbo {
  schemaVersion: number;
  medidoEm: string;
  /** INFORMATIVO — aponta para o commit ANTERIOR ao próprio carimbo e muda em squash/rebase.
   *  O vínculo real com o contrato é o fingerprint, não este sha. */
  sourceHead: string | null;
  alvo: { usuario: string; servidor: string; somenteLeitura: boolean; projetoHash: string };
  audits: Record<ChaveAudit, ResultadoAudit>;
}

export interface Veredito {
  codigo: string;
  bloqueiaPR: boolean;
  mensagem: string;
}

/**
 * Avalia o carimbo. NÃO lê prod — só o artefato. Pura para ser testável e falsificável sem banco.
 *
 * `bloqueiaPR` divide as severidades pela pergunta "um PR consegue consertar isto?":
 *   · contrato/auditor mudou, carimbo ausente/ilegível/no futuro → SIM (rodar o runner e commitar);
 *   · carimbo vencido, achado vivo em prod                       → NÃO (o fix é paste do founder
 *     no SQL Editor; travar a fila de ~30 worktrees puniria quem não pode consertar).
 */
export function avaliarCarimbo(
  carimbo: Carimbo | null,
  agora: Date,
  fps: Record<ChaveAudit, { contrato: string; auditor: string }>,
): Veredito[] {
  if (carimbo === null) {
    return [
      {
        codigo: 'CARIMBO_AUSENTE',
        bloqueiaPR: true,
        mensagem: `carimbo ausente ou ilegível em db/authz-carimbo-prod.json — rode \`bun run authz:carimbo:gravar\`. Ausência de dado NÃO é aprovação.`,
      },
    ];
  }

  const out: Veredito[] = [];

  if (carimbo.schemaVersion !== SCHEMA_VERSION) {
    out.push({
      codigo: 'CARIMBO_AUSENTE',
      bloqueiaPR: true,
      mensagem: `carimbo é schemaVersion ${carimbo.schemaVersion}, o gate lê ${SCHEMA_VERSION} — formato incompatível, re-meça.`,
    });
    return out;
  }

  const medido = new Date(carimbo.medidoEm);
  if (Number.isNaN(medido.getTime())) {
    out.push({ codigo: 'CARIMBO_AUSENTE', bloqueiaPR: true, mensagem: `medidoEm inválido: ${carimbo.medidoEm}` });
    return out;
  }
  const idadeMs = agora.getTime() - medido.getTime();
  if (idadeMs < 0) {
    out.push({
      codigo: 'CARIMBO_AUSENTE',
      bloqueiaPR: true,
      mensagem: `medidoEm está no FUTURO (${carimbo.medidoEm}) — relógio errado ou carimbo forjado.`,
    });
    return out;
  }
  const idadeDias = idadeMs / 86_400_000;

  for (const chave of Object.keys(AUDITS) as ChaveAudit[]) {
    const r = carimbo.audits?.[chave];
    if (!r) {
      out.push({
        codigo: 'CARIMBO_AUSENTE',
        bloqueiaPR: true,
        mensagem: `carimbo não tem o audit \`${chave}\` — re-meça.`,
      });
      continue;
    }
    if (r.contratoFingerprint !== fps[chave].contrato) {
      out.push({
        codigo: 'CARIMBO_CONTRATO_MUDOU',
        bloqueiaPR: true,
        mensagem: `\`${chave}\`: o CONTRATO mudou desde a medição — prod nunca foi verificado contra ele. Rode \`bun run authz:carimbo:gravar\` e commite o carimbo.`,
      });
    }
    if (r.auditorFingerprint !== fps[chave].auditor) {
      out.push({
        codigo: 'CARIMBO_AUDITOR_MUDOU',
        bloqueiaPR: true,
        mensagem: `\`${chave}\`: o AUDITOR mudou desde a medição — o instrumento não é mais o que produziu esta evidência. Rode \`bun run authz:carimbo:gravar\`.`,
      });
    }
    if (r.exit !== 0) {
      const idade = r.achados.map((a) => `${a.linha} (aberto desde ${a.primeiraVez})`).join(' · ');
      out.push({
        codigo: 'CARIMBO_ACHADO',
        bloqueiaPR: false,
        mensagem: `\`${chave}\` saiu ${r.exit} contra prod: ${idade || r.resumo}`,
      });
    }
  }

  if (idadeDias > VENCIDO_DIAS) {
    out.push({
      codigo: 'CARIMBO_VELHO',
      bloqueiaPR: false,
      mensagem: `carimbo tem ${idadeDias.toFixed(1)} dias (teto ${VENCIDO_DIAS}) — não é evidência de que prod está limpa, é ausência de evidência.`,
    });
  } else if (idadeDias > AVISO_DIAS) {
    out.push({
      codigo: 'CARIMBO_AVISO',
      bloqueiaPR: false,
      mensagem: `carimbo tem ${idadeDias.toFixed(1)} dias (aviso ${AVISO_DIAS}, vence em ${VENCIDO_DIAS}) — renove antes de vencer.`,
    });
  }

  return out;
}

export function fingerprintsAtuais(): Record<ChaveAudit, { contrato: string; auditor: string }> {
  const out = {} as Record<ChaveAudit, { contrato: string; auditor: string }>;
  for (const chave of Object.keys(AUDITS) as ChaveAudit[]) {
    out[chave] = { contrato: fingerprintContrato(chave), auditor: fingerprintAuditor(chave) };
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A RELEITURA do carimbo ANTERIOR pelo GRAVADOR (2026-10-01)
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * As versões do carimbo que o GRAVADOR relê, e as chaves de `audits` que cada uma TEM.
 *
 * Por que uma JANELA e não só `SCHEMA_VERSION`, como no gate: o gate recusa carimbo de outra versão e
 * BLOQUEIA PR, então o PR que faz o bump tem de regravar o carimbo nele mesmo — e o gravador desse PR
 * lê o carimbo da versão ANTERIOR. É a migração legítima (a 1→2 e a 2→3 passaram por aqui). Abortar
 * nela travaria todo bump; aceitá-la sem conferir é o defeito que esta tabela fecha.
 *
 * Por que SÓ a anterior: na main o carimbo commitado está sempre em `SCHEMA_VERSION` (o gate garante),
 * então duas versões atrás não é migração — é arquivo velho restaurado. E a FUTURA é código
 * desatualizado: regravaria no formato velho (DOWNGRADE) e jogaria fora a `primeiraVez` das chaves
 * que ele não conhece.
 *
 * As chaves são as MEDIDAS no histórico (36 versões commitadas: v1 ×2 com 4 chaves, v2 ×24 com 5,
 * v3 ×10 com 6). Em todas, `alvo.projetoHash` no mesmo lugar e todo achado com `id` + `primeiraVez`.
 * No bump: acrescente a versão nova, tire a mais velha. Bump que MUDE essa forma muda o leitor junto
 * — o teste de releitura do carimbo de hoje (`carimboBom`, tipado `Carimbo`) fica vermelho se não.
 */
export const CHAVES_RELIDAS_POR_VERSAO: Readonly<Record<number, readonly string[]>> = {
  2: ['funcoes', 'grants', 'audit', 'claudeRo', 'rls'],
  3: ['funcoes', 'grants', 'audit', 'claudeRo', 'rls', 'corpo'],
};

/** O que o gravador usa do carimbo anterior — e SÓ isso: a projeção conferida, nunca o JSON cru. */
export interface CarimboAnterior {
  schemaVersion: number;
  /** A trava de cluster. Texto não vazio por construção: a porta RECUSA o anterior sem ele. */
  projetoHash: string;
  /** Por chave de audit DA VERSÃO LIDA, os achados com a data de abertura da dívida. */
  achados: Readonly<Record<string, readonly { id: string; primeiraVez: string }[]>>;
}

/** Por que o gravador NÃO segue com o carimbo anterior. Cada código aborta com o próprio nome. */
export interface RecusaDoAnterior {
  codigo:
    | 'CARIMBO_ANTERIOR_ILEGIVEL'
    | 'CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL'
    | 'CARIMBO_ANTERIOR_SEM_ALVO'
    | 'CARIMBO_ANTERIOR_MALFORMADO'
    | 'CARIMBO_ANTERIOR_OUTRO_CLUSTER';
  motivo: string;
}

/** O que sai de `lerCarimboAnterior`: a projeção (ou `null`, o nascimento), ou a recusa com o porquê. */
export type LeituraDoAnterior = { ok: true; anterior: CarimboAnterior | null } | ({ ok: false } & RecusaDoAnterior);

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const tem = (o: object, campo: string): boolean => Object.prototype.hasOwnProperty.call(o, campo);
const NOME_DO_TIPO: Record<string, string> = { string: 'texto', number: 'numero', boolean: 'booleano', object: 'objeto' };
/** O TIPO do que veio, em ASCII — nunca o valor, que traria acento do arquivo para a mensagem. */
const tipoDe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'lista' : (NOME_DO_TIPO[typeof v] ?? typeof v));
/** Texto vindo do ARQUIVO (uma chave, um hash) com o que não é ASCII imprimível trocado por `?`. */
const ascii = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?');
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const RESTAURAR = 'restaure o carimbo da main (`git checkout origin/main -- db/authz-carimbo-prod.json`)';

/**
 * A ÚNICA porta pela qual o gravador relê o carimbo anterior. `null` = o arquivo não existe.
 *
 * ## Por que ela existe (2026-10-01)
 *
 * O gravador relia com `JSON.parse(...) as Carimbo` e usava dois campos: `alvo.projetoHash` (a TRAVA
 * que não sobrescreve evidência de prod com medição de outro cluster) e `audits[chave].achados`
 * (`primeiraVez`, a idade da dívida). Num carimbo de outro formato — ou com o campo fora do lugar —
 * `anterior.alvo?.projetoHash && …` era falso e a trava era PULADA calada; a `primeiraVez` regredia
 * para hoje; `JSON.parse("null")` virava "nascimento" (sem trava); e JSON inválido era SyntaxError
 * cru, exit 1 (o contrato do runner é 0 gravou · 2 não gravou). Irmão do defeito da matriz do
 * `exclusividade` (`lerMatriz`, #2575) — o mesmo desenho, com a diferença da JANELA de versões.
 *
 * A ordem importa: versão ANTES da forma. Carimbo de outro schema tem, legitimamente, outra forma —
 * chamá-lo de SEM_ALVO ou MALFORMADO mandaria o operador consertar o arquivo em vez do código.
 * A forma conferida é a que o gravador USA, para a versão LIDA: as chaves EXATAS dela (faltando =
 * dívida que sumiria; sobrando = dívida que seria jogada fora), cada achado com `id` e `primeiraVez`.
 *
 * Todo motivo é ASCII imprimível (sem acento, sem travessão): é o que a suíte e o operador casam sem
 * `-i`, em `LC_ALL=C` e em `pt_BR.UTF-8`. Por isso ele nomeia o TIPO do que veio, nunca o valor.
 */
export function lerCarimboAnterior(texto: string | null): LeituraDoAnterior {
  // Ausente é o NASCIMENTO — o único caso sem trava, porque não há evidência a proteger.
  if (texto === null) return { ok: true, anterior: null };
  let doc: unknown;
  try {
    doc = JSON.parse(texto);
  } catch {
    return { ok: false, codigo: 'CARIMBO_ANTERIOR_ILEGIVEL', motivo: `o carimbo anterior nao e JSON valido - ${RESTAURAR}.` };
  }
  // `null`, lista, número: nunca o nascimento — o nascimento é o arquivo AUSENTE, e só ele.
  if (!ehObjeto(doc)) {
    return {
      ok: false,
      codigo: 'CARIMBO_ANTERIOR_MALFORMADO',
      motivo: `o carimbo anterior deveria ser um objeto JSON (veio ${tipoDe(doc)}) - ${RESTAURAR}.`,
    };
  }

  // 1. A VERSÃO, antes de qualquer campo.
  const versao = doc.schemaVersion;
  if (typeof versao !== 'number' || !tem(CHAVES_RELIDAS_POR_VERSAO, String(versao))) {
    const v = versao;
    const lida = !tem(doc, 'schemaVersion')
      ? 'schemaVersion ausente'
      : typeof v === 'number'
        ? `schemaVersion ${v}`
        : `schemaVersion nao numerico (veio ${tipoDe(v)})`;
    return {
      ok: false,
      codigo: 'CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL',
      motivo:
        `o carimbo anterior tem ${lida}; este gravador rele as versoes ${Object.keys(CHAVES_RELIDAS_POR_VERSAO).join(' e ')} ` +
        `e grava a ${SCHEMA_VERSION}. Versao mais nova: atualize a worktree com a main antes de gravar (regravar ` +
        `no formato velho jogaria fora a divida das chaves que este codigo nao conhece). Mais velha: ${RESTAURAR}.`,
    };
  }
  const chaves = CHAVES_RELIDAS_POR_VERSAO[versao];

  // 2. O ALVO. Sem ele a trava de cluster não tem com o que comparar — e ela NUNCA é pulada.
  const alvo = doc.alvo;
  const hash = ehObjeto(alvo) ? alvo.projetoHash : undefined;
  if (typeof hash !== 'string' || hash.trim() === '') {
    const onde = !ehObjeto(alvo)
      ? tem(doc, 'alvo')
        ? `alvo deveria ser objeto (veio ${tipoDe(alvo)})`
        : 'alvo ausente'
      : !tem(alvo, 'projetoHash')
        ? 'alvo.projetoHash ausente'
        : `alvo.projetoHash deveria ser texto nao vazio (veio ${typeof hash === 'string' ? 'texto vazio' : tipoDe(hash)})`;
    return {
      ok: false,
      codigo: 'CARIMBO_ANTERIOR_SEM_ALVO',
      motivo: `${onde} no carimbo anterior (schema ${versao}): sem o alvo a trava de cluster nao tem com o que comparar, e o gravador nao a pula - ${RESTAURAR}.`,
    };
  }

  // 3. Os ACHADOS: a dívida que a re-execução não pode resetar.
  const malformado = (onde: string): LeituraDoAnterior => ({
    ok: false,
    codigo: 'CARIMBO_ANTERIOR_MALFORMADO',
    motivo: `o carimbo anterior esta fora da forma do schema ${versao}: ${onde}. Conflito de merge mal resolvido ou edicao a mao? ${RESTAURAR}.`,
  });
  const audits = doc.audits;
  if (!ehObjeto(audits)) return malformado(tem(doc, 'audits') ? `audits deveria ser objeto (veio ${tipoDe(audits)})` : 'audits ausente');
  const sobrando = Object.keys(audits).find((k) => !chaves.includes(k));
  if (sobrando !== undefined) return malformado(`audits.${ascii(sobrando)} nao pertence ao schema ${versao}`);
  const achados: Record<string, { id: string; primeiraVez: string }[]> = {};
  for (const chave of chaves) {
    if (!tem(audits, chave)) return malformado(`audits.${chave} ausente (o schema ${versao} grava as ${chaves.length} chaves)`);
    const r = audits[chave];
    if (!ehObjeto(r)) return malformado(`audits.${chave} deveria ser objeto (veio ${tipoDe(r)})`);
    const lista = r.achados;
    if (!Array.isArray(lista)) {
      return malformado(tem(r, 'achados') ? `audits.${chave}.achados deveria ser lista (veio ${tipoDe(lista)})` : `audits.${chave}.achados ausente`);
    }
    const projetados: { id: string; primeiraVez: string }[] = [];
    for (let i = 0; i < lista.length; i++) {
      const a: unknown = lista[i];
      const onde = `audits.${chave}.achados[${i}]`;
      if (!ehObjeto(a)) return malformado(`${onde} deveria ser objeto (veio ${tipoDe(a)})`);
      if (typeof a.id !== 'string' || a.id === '') return malformado(`${onde}.id deveria ser texto nao vazio`);
      if (typeof a.primeiraVez !== 'string' || !DATA.test(a.primeiraVez)) return malformado(`${onde}.primeiraVez deveria ser data AAAA-MM-DD`);
      projetados.push({ id: a.id, primeiraVez: a.primeiraVez });
    }
    achados[chave] = projetados;
  }
  return { ok: true, anterior: { schemaVersion: versao, projetoHash: hash, achados } };
}

/**
 * A TRAVA de cluster: não sobrescrever a evidência de prod com a medição de outro banco. `null` = segue.
 *
 * Sem o curto-circuito antigo (`anterior.alvo?.projetoHash && …`), que lia "campo ausente" como "sem
 * trava": aqui o anterior vem da porta, que garante `projetoHash` não vazio — ou não vem (nascimento).
 */
export function conferirCluster(anterior: CarimboAnterior | null, projetoHashAtual: string): RecusaDoAnterior | null {
  if (anterior === null || anterior.projetoHash === projetoHashAtual) return null;
  return {
    codigo: 'CARIMBO_ANTERIOR_OUTRO_CLUSTER',
    motivo:
      `o carimbo anterior foi medido no cluster ${ascii(anterior.projetoHash)} e esta sessao esta em ` +
      `${ascii(projetoHashAtual)}: alvo diferente, o gravador nao sobrescreve a evidencia de prod.`,
  };
}

/**
 * Os achados de UM audit, com a `primeiraVez` herdada por `id`. Re-executar NUNCA reseta a idade —
 * senão a renovação lava a dívida. Ordem: o anterior, a semente (dívida de antes do carimbo existir),
 * hoje. Chave que a versão do anterior não tinha (audit novo no bump) nasce hoje: é a primeira
 * medição dela, não dívida lavada — a porta já conferiu que o anterior tem EXATAMENTE as chaves dele.
 */
export function montarAchados(
  chave: ChaveAudit,
  linhas: string[],
  anterior: CarimboAnterior | null,
  hoje: string,
  semente: Readonly<Record<string, string>>,
): Achado[] {
  return linhas.map((linha) => {
    const id = idFinding(chave, linha);
    const antes = anterior?.achados[chave]?.find((a) => a.id === id);
    return { id, linha, primeiraVez: antes?.primeiraVez ?? semente[id] ?? hoje, ultimaVez: hoje };
  });
}
