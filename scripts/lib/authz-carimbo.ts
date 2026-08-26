/**
 * authz-carimbo.ts — núcleo PURO do carimbo de evidência dos 3 audits de produção.
 * ============================================================================================
 *
 * O PROBLEMA que este módulo existe para fechar. Os três audits de prod (`authz:funcoes:prod`,
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
 * ⚠️ LIMITE DE ESCOPO — o carimbo NÃO atesta "a autorização de prod". Atesta três FATIAS CURADAS
 * dela, com pontos cegos medidos (não deduzidos), listados em `docs/agent/database.md` §1:
 *   · o audit de grants mede 6 privilégios (SELECT/INSERT/UPDATE/DELETE/TRUNCATE + MAINTAIN no
 *     PG17) dos 8 que o tipo `Priv` declara — `REFERENCES` e `TRIGGER` são declaráveis no contrato
 *     e NUNCA medidos em prod;
 *   · ACL por COLUNA fica fora (`has_table_privilege` é table-level) — e é justamente o vetor que
 *     importa em `sales_orders` (`GRANT SELECT (omie_payload)`);
 *   · RLS vivo (`relrowsecurity`, policies, `qual`/`with_check`) não é reconciliado por nenhum dos
 *     três — um `ALTER TABLE … DISABLE ROW LEVEL SECURITY` à mão sai verde.
 * Dizer isso vale mais do que um carimbo que finge cobrir tudo: contrato falso é pior que lacuna,
 * porque o CI passa a AFIRMAR cobertura que não existe (a regra é do cabeçalho do AUTHZ_MANIFEST).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTHZ_FUNCOES_FECHADAS } from '../authz-funcoes-fechadas';
import { AUTHZ_TABELAS_FECHADAS } from '../authz-tabelas-fechadas';
import { AUTHZ_MANIFEST } from '../authz-manifest';
import { AUTHZ_REESCRITAS_CONHECIDAS } from '../authz-reescritas-conhecidas';

/** Raiz do repo, a partir de `scripts/lib/` — o gate roda do CI e do laptop, e `process.cwd()`
 *  difere entre os dois. */
export const RAIZ = join(import.meta.dirname, '..', '..');
export const CARIMBO_PATH = join(RAIZ, 'db', 'authz-carimbo-prod.json');

/** Versão do FORMATO do carimbo. Bump ⇒ carimbo antigo é ilegível ⇒ fail-closed (re-medir). */
export const SCHEMA_VERSION = 1;

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

export type ChaveAudit = 'funcoes' | 'grants' | 'audit';

/** Os 3 audits, com o script npm que os roda e os arquivos que compõem cada FINGERPRINT.
 *
 *  `contrato` = o que o audit COMPARA (o que o repo declara). `auditor` = o INSTRUMENTO que faz a
 *  comparação. São eixos distintos e o bug de `REFERENCES`/`TRIGGER` é a prova de por quê: com
 *  contrato idêntico e instrumento incompleto, o verde é cegueira. Mexer no instrumento invalida a
 *  medição anterior tanto quanto mexer no contrato — logo os dois entram no carimbo. */
export const AUDITS: Record<ChaveAudit, { script: string; auditorFiles: string[] }> = {
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

/** O DADO que cada audit compara contra prod. */
function dadoDoContrato(chave: ChaveAudit): unknown {
  switch (chave) {
    case 'funcoes':
      return AUTHZ_FUNCOES_FECHADAS;
    case 'grants':
      return AUTHZ_TABELAS_FECHADAS;
    case 'audit':
      // As DUAS entradas: o audit checa o gate do manifest no corpo vivo E o md5 das reescritas.
      return { manifest: AUTHZ_MANIFEST, reescritas: AUTHZ_REESCRITAS_CONHECIDAS };
  }
}

export function fingerprintContrato(chave: ChaveAudit): string {
  return sha256(`v${SCHEMA_VERSION}|${chave}|${canonicalizar(dadoDoContrato(chave))}`);
}

/** Fingerprint do INSTRUMENTO: bytes crus dos arquivos que executam a medição. Cru é o certo aqui
 *  — num auditor, comentário TAMBÉM é contrato (é onde moram os limites declarados), e o custo de
 *  um falso "re-meça" ao editar comentário de auditor é baixo (mexe-se raro). */
export function fingerprintAuditor(chave: ChaveAudit): string {
  const partes = AUDITS[chave].auditorFiles.map((rel) => `${rel}\n${readFileSync(join(RAIZ, rel), 'utf8')}`);
  return sha256(`v${SCHEMA_VERSION}|${chave}|${partes.join('\n---\n')}`);
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
