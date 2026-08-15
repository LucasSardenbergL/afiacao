#!/usr/bin/env bun
/**
 * authz-gate-check.ts — gate de CI anti-regressão de autorização em RPCs SECURITY DEFINER.
 * ============================================================================================
 *
 * Chip task_fc0cc5bd (follow-up do PR #1264). Mata o padrão de bug recorrente: uma migration
 * faz CREATE OR REPLACE de uma função SECDEF sensível e OMITE o gate → vazamento silencioso.
 *
 * Duas partes (spec: docs/superpowers/specs/2026-07-09-authz-gate-regression-check-design.md):
 *  - Parte A (regressão): a ÚLTIMA definição (last-writer) de cada função do manifest deve conter
 *    o gate esperado EM FORMA DE BLOQUEIO. Ausência, gate decorativo (presente sem bloquear), ou
 *    recriação que o parser não conseguiu extrair (fail-closed) → erro nomeando a migration.
 *  - Parte B (cobertura): no estado final (last-writer por ASSINATURA, p/ não perder overloads),
 *    TODA SECDEF que toca o eixo sensível deve estar classificada — `gated` ou `acknowledged`.
 *    Uma SECDEF sensível nova não classificada → erro. O eixo é custo/preço/estoque **e**
 *    comercial de compras (`SENSITIVE_*` em scripts/lib/authz-contract.ts — o 2º entrou em
 *    2026-08-14, ver o cabeçalho daquele arquivo).
 *
 * Uso:  bun run authz:check           # roda no CI (ci.yml, job validate) e local
 *       bun scripts/authz-gate-check.ts --json
 * Fonte: supabase/migrations/*.sql (o CI prova o REPO, não o PROD — audit de PROD é complemento).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFunctions, checkGate, touchesSensitive, rawIsSensitiveSecdef, type FunctionDef } from './lib/authz-contract';
import { detectarReescritaViva } from './lib/authz-reescrita';
import { AUTHZ_MANIFEST, ACKNOWLEDGED_SENSITIVE, manifestKey } from './authz-manifest';
import { REESCRITAS_CONHECIDAS_INDEX, chaveReescrita } from './authz-reescritas-conhecidas';
import { auditGrantsTabelas } from './lib/authz-grants';
import { AUTHZ_TABELAS_FECHADAS } from './authz-tabelas-fechadas';

export interface Finding {
  level: 'error' | 'warn';
  file: string;
  fn: string;
  msg: string;
}
export interface Migration {
  file: string;
  sql: string;
}

/** núcleo testável: lista de migrations → achados (erros bloqueiam, avisos não). */
export function auditAuthz(migrations: Migration[]): Finding[] {
  const findings: Finding[] = [];
  const finalByName = new Map<string, { def: FunctionDef; file: string }>(); // p/ Parte A (gate por nome)
  const finalBySig = new Map<string, { def: FunctionDef; file: string }>(); // p/ Parte B (overloads distintos)
  const lastMention = new Map<string, { file: string; parsed: boolean }>(); // fail-closed: última menção deu p/ parsear?
  const unparsedRaw = new Map<string, { file: string; raw: string }>(); // texto bruto da última def não-parseável

  const ordered = [...migrations].sort((a, b) => a.file.localeCompare(b.file));
  for (const mig of ordered) {
    let extracted;
    try {
      extracted = extractFunctions(mig.sql);
    } catch {
      continue;
    }
    for (const def of extracted.defs) {
      const nkey = manifestKey(def.schema, def.name);
      finalByName.set(nkey, { def, file: mig.file });
      finalBySig.set(def.key, { def, file: mig.file });
      lastMention.set(nkey, { file: mig.file, parsed: true });
      unparsedRaw.delete(nkey); // uma def parseável posterior supera o unparsed
    }
    for (const u of extracted.unparsed) {
      const nkey = manifestKey(u.schema, u.name);
      lastMention.set(nkey, { file: mig.file, parsed: false });
      unparsedRaw.set(nkey, { file: mig.file, raw: u.raw });
    }
  }

  // Parte A — regressão: última def de cada função do manifest tem o gate em forma de bloqueio.
  for (const [mkey, entry] of Object.entries(AUTHZ_MANIFEST)) {
    const mention = lastMention.get(mkey);
    if (!mention) {
      findings.push({ level: 'warn', file: '—', fn: mkey, msg: `no manifest mas sem definição nas migrations (só no schema-snapshot?) — gate não verificável estaticamente.` });
      continue;
    }
    if (!mention.parsed) {
      findings.push({
        level: 'error',
        file: mention.file,
        fn: mkey,
        msg: `recria ${mkey} numa forma que o parser NÃO extraiu (quoted identifier? corpo não dollar/single-quoted?) — o gate não pode ser garantido (fail-closed). Ajuste a migration ou o parser (scripts/lib/authz-contract.ts).`,
      });
      continue;
    }
    const rec = finalByName.get(mkey)!;
    const res = checkGate(rec.def.body, entry.requiredGate);
    if (!res.ok) {
      const why =
        res.missing.length > 0
          ? `falta a chamada de ${res.missing.join(' ou ')}`
          : `${res.weak.join(', ')} aparece mas fora da forma de bloqueio "IF NOT <gate>(…) THEN RAISE EXCEPTION" (gate decorativo não protege)`;
      findings.push({ level: 'error', file: rec.file, fn: mkey, msg: `última def de ${mkey} SEM gate válido: ${why}. Motivo: ${entry.motivo}` });
    }
  }

  // Parte D — recriação INVISÍVEL: a migration reescreve a definição VIVA (`pg_get_functiondef`
  // + `EXECUTE`) em vez de escrever `CREATE FUNCTION`. Roda logo após a Parte A porque o que ela
  // julga é a validade da afirmação da Parte A: quando existe reescrita posterior ao last-writer,
  // "a última def de X tem o gate" é falso — a Parte A mediu uma definição que não é a última.
  // A Parte D não proíbe o padrão (ele preserva SECDEF/search_path/ACL, que um corpo colado
  // perderia): ela impede o CI de AFIRMAR o que não mediu.
  findings.push(...auditReescritas(ordered, lastMention));

  // Parte B — cobertura: toda SECDEF sensível no estado final (por assinatura) está classificada.
  for (const [, { def, file }] of finalBySig) {
    if (!def.securityDefiner) continue;
    const sensitive = touchesSensitive(def.body);
    if (sensitive.length === 0) continue;
    const mkey = manifestKey(def.schema, def.name);
    if (AUTHZ_MANIFEST[mkey] || ACKNOWLEDGED_SENSITIVE.has(mkey)) continue;
    findings.push({
      level: 'error',
      file,
      fn: def.signature ? `${mkey}(${def.signature})` : mkey,
      msg: `SECURITY DEFINER toca dado sensível (${sensitive.join(', ')}) e NÃO está classificada. Adicione ${mkey} a AUTHZ_MANIFEST (com gate) ou a ACKNOWLEDGED_SENSITIVE (com justificativa) em scripts/authz-manifest.ts. Última def: ${file}`,
    });
  }

  // fail-closed: CREATE FUNCTION não extraído. Se o texto bruto é SECDEF sensível e não
  // classificado → ERRO (não posso verificar o gate, mas SEI que é sensível). Senão → aviso.
  for (const [mkey, { file, raw }] of unparsedRaw) {
    if (AUTHZ_MANIFEST[mkey] || ACKNOWLEDGED_SENSITIVE.has(mkey)) continue; // manifest já tratado na Parte A
    const sensitive = rawIsSensitiveSecdef(raw);
    if (sensitive.length > 0) {
      findings.push({ level: 'error', file, fn: mkey, msg: `SECURITY DEFINER que toca dado sensível (${sensitive.join(', ')}) NÃO foi parseável (fail-closed) e não está classificada. Classifique ${mkey} em scripts/authz-manifest.ts e/ou ajuste o parser (scripts/lib/authz-contract.ts).` });
    } else {
      findings.push({ level: 'warn', file, fn: mkey, msg: `CREATE FUNCTION ${mkey} não extraído pelo parser — se for SECDEF que toca custo/preço/estoque ou dado comercial de compras, classifique manualmente.` });
    }
  }

  return findings;
}

/**
 * Parte D — a migration recria função do manifest reescrevendo a definição VIVA, o que o parser
 * de `CREATE FUNCTION` não enxerga. Detalhe do padrão e a medição que o justifica:
 * scripts/lib/authz-reescrita.ts.
 *
 * Três desfechos, e a fronteira entre eles é o que impede o detector de virar ruído (medido:
 * 7 das 648 migrations usam o padrão, e só 2 deixam função do manifest sem medição):
 *  · alvo no manifest + migration POSTERIOR ao last-writer → ERRO (ou AVISO se baselinada);
 *  · alvo OPACO (loop sobre `pg_proc`, nenhum literal do manifest) → AVISO: não dá para saber o
 *    alvo, e inventar erro aqui seria acusar sem dado;
 *  · alvo fora do manifest, ou reescrita SUPERADA por um `CREATE OR REPLACE` posterior → nada,
 *    porque a Parte A voltou a medir a última definição e a afirmação dela é verdadeira de novo.
 *
 * O CÓDIGO ASCII no início da msg é contrato com os testes (e legível no log do CI): asserção
 * que casa frase em pt-BR quebra conforme o locale (#1483).
 */
function auditReescritas(ordered: Migration[], lastMention: Map<string, { file: string; parsed: boolean }>): Finding[] {
  const findings: Finding[] = [];
  for (const mig of ordered) {
    const r = detectarReescritaViva(mig.sql);
    if (!r.detectada) continue;

    const doManifest = r.alvos.filter((a) => AUTHZ_MANIFEST[a]);
    if (doManifest.length === 0) {
      if (r.indeterminado) {
        // Dizer QUAIS literais foram colhidos transforma "não sei o alvo" em "olhei e nenhum
        // destes é do manifest" — o leitor consegue julgar, em vez de receber um alerta oco.
        const colhidos = r.alvos.length > 0 ? r.alvos.slice(0, 8).join(', ') : '(nenhum literal no arquivo)';
        findings.push({
          level: 'warn',
          file: mig.file,
          fn: '—',
          msg: `[REESCRITA_VIVA_ALVO_OPACO] recria função reescrevendo a definição VIVA (pg_get_functiondef + EXECUTE) com alvo que o parser não resolve (loop sobre pg_proc? assinatura montada em runtime?). Literais colhidos, NENHUM no AUTHZ_MANIFEST: ${colhidos}. Se o alvo real for função do manifest, a Parte A não está medindo a última definição dela.`,
        });
      }
      continue;
    }

    for (const fnKey of doManifest) {
      const mention = lastMention.get(fnKey);
      // reescrita ANTERIOR ao último CREATE: aquele CREATE é a última definição, Parte A ok.
      if (mention && mig.file.localeCompare(mention.file) <= 0) continue;

      const conhecida = REESCRITAS_CONHECIDAS_INDEX.get(chaveReescrita(mig.file, fnKey));
      const ondeAParteAOlha = mention ? mention.file : '(nenhum CREATE no repo)';
      if (conhecida) {
        findings.push({
          level: 'warn',
          file: mig.file,
          fn: fnKey,
          msg: `[REESCRITA_VIVA_BASELINADA] a Parte A NAO mede ${fnKey}: esta migration a recria reescrevendo a definição VIVA, e o last-writer parseável (${ondeAParteAOlha}) é ANTERIOR. O gate desta função é provado por ${conhecida.provaExecutada} e pelo audit read-only (bun run authz:audit:prod, md5 esperado ${conhecida.md5ProdEsperado}). Motivo da reescrita: ${conhecida.motivo}`,
        });
      } else {
        findings.push({
          level: 'error',
          file: mig.file,
          fn: fnKey,
          msg: `[REESCRITA_VIVA_NAO_MEDIDA] recria ${fnKey} reescrevendo a definição VIVA (pg_get_functiondef + EXECUTE) sem escrever CREATE FUNCTION, e é POSTERIOR ao last-writer parseável (${ondeAParteAOlha}) — logo a Parte A está medindo o gate de uma definição que NÃO é a última. Saídas: (a) reescrever como CREATE OR REPLACE, que é auditável estaticamente; ou (b) registrar em scripts/authz-reescritas-conhecidas.ts com a prova EXECUTADA e o md5 do prosrc de prod (medido, não presumido).`,
        });
      }
    }
  }
  return findings;
}

/**
 * Parte C — grants de tabela fechada por PRIVILÉGIO (allowlist curada em
 * scripts/authz-tabelas-fechadas.ts). Núcleo puro em scripts/lib/authz-grants.ts; aqui só
 * convertemos GrantFinding→Finding, prefixando o CÓDIGO ASCII na msg para que ele apareça no log
 * do CI (e nos testes, que casam por código e nunca pela frase em pt-BR).
 *
 * SEPARADA de `auditAuthz` de propósito. A Parte C julga o conjunto de arquivos que EXISTEM no
 * repo (a âncora sumiu?), enquanto A/B julgam definições de função. Fundidas, todo fixture de A/B
 * — que naturalmente não contém a migration-âncora — dispararia ANCORA_AUSENTE, e cada teste novo
 * de A/B teria de carregar o contrato de C. As duas rodam juntas só onde o repo real é lido:
 * `auditCompleto`, chamada pelo `main()`. O comando de CI continua um só (`bun run authz:check`).
 */
function auditGrants(migrations: Migration[]): Finding[] {
  const filesPresentes = new Set(migrations.map((m) => m.file));
  return auditGrantsTabelas(migrations, AUTHZ_TABELAS_FECHADAS, filesPresentes).map((gf) => ({
    level: gf.level,
    file: gf.file,
    fn: gf.tabela,
    msg: `[${gf.codigo}] ${gf.msg}`,
  }));
}

/** O que o CI roda: Parte A + B (contrato de gate) e Parte C (grants de tabela fechada). */
export function auditCompleto(migrations: Migration[]): Finding[] {
  return [...auditAuthz(migrations), ...auditGrants(migrations)];
}

function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, sql: readFileSync(join(dir, f), 'utf8') }));
}

function main(): void {
  const json = process.argv.includes('--json');
  const dir = join(process.cwd(), 'supabase', 'migrations');
  const findings = auditCompleto(loadMigrations(dir));
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (json) {
    console.log(JSON.stringify({ ok: errors.length === 0, findings }, null, 2));
    process.exit(errors.length === 0 ? 0 : 1);
  }

  for (const w of warns) console.log(`⚠️  ${w.file} — ${w.msg}`);
  for (const e of errors) console.error(`❌ ${e.file} — ${e.msg}`);
  if (errors.length > 0) {
    console.error(`\nauthz:check — ${errors.length} erro(s) de contrato de autorização. Ver scripts/authz-manifest.ts.`);
    process.exit(1);
  }
  // O verde declara o que NÃO foi medido. Antes desta linha o `authz:check` afirmava
  // "contrato de gate ok" mesmo quando a Parte A media uma definição que não era a última —
  // e "o gate de CI está verde" foi lido como "a função está coberta" (§2.1 do histórico).
  // Ausência de sinal não é aprovação; um verde que esconde o não-coberto é pior que um aviso.
  const naoMedidas = [...new Set(warns.filter((w) => w.msg.includes('REESCRITA_VIVA_BASELINADA')).map((w) => w.fn))];
  const ressalva = naoMedidas.length
    ? ` ⚠️ ${naoMedidas.length} função(ões) do manifest NÃO são medidas estaticamente (recriadas por reescrita da definição viva): ${naoMedidas.join(', ')} — o gate delas se prova por asserção EXECUTADA e por 'bun run authz:audit:prod'.`
    : '';
  console.log(
    `✅ authz:check — contrato de gate ok${warns.length ? ` (${warns.length} aviso(s))` : ''}. Parte A (regressão) + Parte B (cobertura) + Parte C (grants de tabela fechada) + Parte D (reescrita da definição viva) verdes.${ressalva}`,
  );
}

if (import.meta.main) main();
