/**
 * migration-objects.ts — extração de objetos SQL criados por uma migration + chave de colisão.
 * ============================================================================================
 *
 * Fundação compartilhada de:
 *  - scripts/audit-custom-migrations.ts  (inventário "o que cada migration cria")
 *  - scripts/wt-preflight-migration.ts   (detecta 2 migrations recriando o MESMO objeto)
 *
 * Heurístico (regex), não parser SQL completo — cobre os patterns do projeto. Acréscimos
 * sobre o extractObjects original (pedidos pelo Codex):
 *  - `view`  — o audit não detectava CREATE [OR REPLACE] [MATERIALIZED] VIEW (views v_grupo_*).
 *  - limpeza de comentário pelo stripper COMPARTILHADO `sql-comentarios.ts` — ver extractObjects.
 *  - assinatura de função — identidade PG = nome + tipos de arg; sem isso, overloads colidiriam
 *    falsamente (foo(int) vs foo(text)).
 *
 * Limitações conhecidas (fase 1, por design): não vê ALTER TABLE/FUNCTION, DROP+CREATE,
 * grants, nem SQL dinâmico; a assinatura é a lista de args normalizada (renomear param muda a
 * chave). O preflight degrada para "não detectado", nunca fabrica colisão.
 */
import { createHash } from 'node:crypto';

import { removerComentariosSql } from './sql-comentarios';

/**
 * A receita ESTRITA de hash de corpo: md5 dos bytes utf-8, sem normalização nenhuma.
 *
 * É o que `md5(pg_proc.prosrc)` devolve. Mora AQUI, na fundação, e não no consumidor
 * (`corpo-esperado.ts`), porque este arquivo é quem a aplica ao extrair — o import na outra
 * direção fecharia um ciclo. Um dono só para as duas pontas que precisam coincidir (o extrator de
 * migration e o autoteste da sonda): duas receitas escritas em dois lugares divergem calmamente, e
 * a divergência não aparece como erro, aparece como DERIVA em massa.
 */
export function md5Exato(texto: string): string {
  return createHash('md5').update(texto, 'utf8').digest('hex');
}

export type ObjectKind = 'table' | 'index' | 'function' | 'trigger' | 'cron_job' | 'enum_value' | 'rls_policy' | 'view';

export interface ExtractedObject {
  kind: ObjectKind;
  schema: string;
  name: string;
  /** trigger/rls_policy: a tabela. enum_value: o nome do enum. */
  parent?: string;
  /** function: assinatura normalizada (lista de args) — distingue overloads. */
  signature?: string;
  /**
   * function: md5 do CORPO (o texto entre os delimitadores dollar-quoted), normalizado com a
   * MESMA receita do resto do repo — `md5(regexp_replace(btrim(prosrc), '\s+', ' ', 'g'))`.
   *
   * 🔴 `btrim(x)` do Postgres, com UM argumento, remove apenas ESPAÇOS — **não** `\n`. O corpo de
   * `AS $f$\n  SELECT …` começa com quebra de linha, que SOBREVIVE ao btrim e vira um espaço à
   * esquerda no `regexp_replace`. Um `.trim()` de JS removeria e produziria md5 diferente do que o
   * banco calcula (medido; ver §11.2 do histórico de RLS). Por isso `trimEspacos`, não `trim`.
   *
   * Ausente quando o corpo não pôde ser extraído (função sem dollar-quote, `LANGUAGE c`, …) — e
   * ausência aqui NUNCA vira "confere": o audit degrada para INDECIDÍVEL, não para ✅.
   */
  bodyMd5?: string;
  /**
   * function: md5 do corpo EXATO, byte a byte — o que `md5(pg_proc.prosrc)` devolve, sem
   * normalização nenhuma.
   *
   * Existe ao lado de `bodyMd5` porque as duas receitas respondem perguntas diferentes, e o
   * gate de deploy (#2428) precisa da estrita. O colapso `\s+ → ' '` do `bodyMd5` iguala corpos
   * que o Postgres executa DIFERENTE — `SELECT 'a  b'` e `SELECT 'a b'` colidem, porque a receita
   * não sabe onde começa um literal (achado do Codex, reproduzido). Para o audit isso é ruído
   * tolerável; para "a RPC em prod é a versão que esta edge espera?" é uma igualdade que mente.
   *
   * Medido nas 65 RPCs literais das edges deste repo: a receita EXATA classifica as mesmas 48
   * como em dia. A precisão a mais não custou recall nenhum — então o gate usa a estrita, e o
   * audit segue com a sua, cada uma com autoteste contra o banco.
   */
  bodyMd5Exato?: string;
}

/** `btrim(x)` do Postgres com UM argumento: só ESPAÇOS, nunca `\n`/`\t`. Ver `bodyMd5`. */
function trimEspacos(s: string): string {
  return s.replace(/^ +| +$/g, '');
}

/** md5 do corpo com a receita NORMALIZADA do audit: btrim(espaços) → colapsa whitespace → md5.
 *  Interna: os consumidores são `corposCrusPorNome` logo abaixo (que também calcula a receita
 *  ESTRITA, a do gate de deploy) — exportá-la sem consumidor externo reprova no gate de dead-code
 *  (`knip`), que só roda no CI. */
function md5CorpoFuncao(corpo: string): string {
  return createHash('md5').update(trimEspacos(corpo).replace(/\s+/g, ' '), 'utf8').digest('hex');
}

/** Uma declaração de função e o corpo CRU que ela realmente carrega. */
interface CorpoDeclarado {
  /** md5 pela receita do banco (`btrim` + colapso de whitespace) — o do audit. */
  md5: string;
  /** md5 do corpo EXATO, byte a byte: o que `md5(pg_proc.prosrc)` devolve. */
  md5Exato: string;
}

/** `CREATE [OR REPLACE] FUNCTION [schema.]nome(` — a declaração, no texto MASCARADO. */
const DECLARACAO_FUNCAO = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\.)?(\w+)\s*\(/gi;

/**
 * Corpo de cada função, lido do SQL **CRU** e indexado por `schema.nome`.
 *
 * 🔴 O corpo sai do CRU, e não do texto sem comentários que o resto do extrator usa.
 * `pg_proc.prosrc` **guarda os comentários do corpo**; calcular o md5 sobre a versão
 * comentário-strippada produz um hash que NUNCA bate com o banco para qualquer função que tenha um
 * `--` dentro. Medido em 2026-08-29: com o texto strippado a Seção 3 classificou 52 funções como
 * DERIVA e 36 em dia; com o texto cru, 24 e 69 — 28 alarmes FALSOS.
 *
 * 🔴 Mas a DELIMITAÇÃO sai do texto MASCARADO, e é isso que o #2428 consertou. A v1 varria o cru
 * com um único regex lazy (`FUNCTION nome\(…[\s\S]*?\bAS\s+(\$tag\$)([\s\S]*?)\3`), e o Codex
 * reproduziu três formas de ele FABRICAR o corpo esperado — todas verificadas aqui antes de
 * mexer, todas com o mesmo desfecho: o gate de deploy compararia prod contra um corpo que
 * migration nenhuma declara.
 *
 *   a) `CREATE … f() AS $$ SELECT 2 $$` seguido do MESMO create **comentado** para rollback:
 *      a última ocorrência vence e `f` ficava com o corpo do COMENTÁRIO (`SELECT 1`).
 *   b) `f()` sem corpo dollar-quoted (`LANGUAGE sql RETURN 1`) seguida de `g() AS $$…$$`:
 *      o lazy atravessava a fronteira e dava a `f` o corpo de `g` — e `g` ficava SEM corpo.
 *   c) tag com dígito (`$v1$`), que `[A-Za-z_]*` não reconhecia: mesmo roubo de corpo que (b).
 *
 * O conserto usa uma propriedade que `removerComentariosSql` já tinha e ninguém explorava: ele
 * **preserva os offsets** (troca cada caractere de comentário por espaço, mantendo os `\n`), então
 * o índice no mascarado É o índice no cru. Delimitar no mascarado e fatiar do cru dá as duas
 * coisas ao mesmo tempo: imunidade a comentário na hora de decidir ONDE o corpo começa, e os
 * comentários internos preservados no hash.
 *
 * O varredor é linear e avança PARA DEPOIS do fecho de cada corpo consumido, de modo que uma
 * declaração que apareça dentro de um corpo (SQL dinâmico, `EXECUTE format(…)`) não abre uma
 * declaração nova. Sem corpo dollar-quoted ANTES da próxima declaração, a função entra sem corpo —
 * e ausência de corpo NUNCA vira "confere": ela sai do histórico e o julgamento a chama de
 * indecidível.
 *
 * Overload no MESMO arquivo (mesmo nome, assinaturas diferentes) ainda colapsa no último: quem
 * compara decide o que fazer com isso, e o gate de deploy trata nome com overload em prod como
 * indecidível em vez de "bate com algum".
 */
function corposCrusPorNome(sqlCru: string): Map<string, CorpoDeclarado> {
  const mascarado = removerComentariosSql(sqlCru);
  // A garantia de que o mascarado é um MAPA de offsets do cru, e não outro texto. Se algum dia o
  // stripper deixar de preservar comprimento, fatiar o cru por índices do mascarado devolveria um
  // pedaço deslocado — corpo silenciosamente errado, que é o modo de falha que este arquivo todo
  // combate. Degradar aqui é seguro: sem corpo, o consumidor diz "não sei", nunca "confere".
  if (mascarado.length !== sqlCru.length) return new Map();

  const out = new Map<string, CorpoDeclarado>();
  let pos = 0;
  for (;;) {
    DECLARACAO_FUNCAO.lastIndex = pos;
    const m = DECLARACAO_FUNCAO.exec(mascarado);
    if (m === null) return out;
    const depoisDoNome = m.index + m[0].length;

    // A janela desta declaração termina onde a PRÓXIMA começa — é o que impede o corpo de `g` de
    // ser creditado a `f`.
    DECLARACAO_FUNCAO.lastIndex = depoisDoNome;
    const proxima = DECLARACAO_FUNCAO.exec(mascarado);
    const limite = proxima === null ? mascarado.length : proxima.index;

    pos = depoisDoNome;
    const janela = mascarado.slice(depoisDoNome, limite);
    // `$v1$` e `$_x$` são tags válidas: o dígito entra, e o fecho exige a MESMA tag.
    const abre = /\bAS\s+(\$[A-Za-z_0-9]*\$)/i.exec(janela);
    if (abre === null) continue;

    const tag = abre[1];
    const ini = depoisDoNome + abre.index + abre[0].length;
    const fim = mascarado.indexOf(tag, ini);
    if (fim < 0 || fim >= limite) continue;

    const corpo = sqlCru.slice(ini, fim);
    out.set(`${(m[1] ?? 'public').toLowerCase()}.${m[2].toLowerCase()}`, {
      md5: md5CorpoFuncao(corpo),
      md5Exato: md5Exato(corpo),
    });
    pos = fim + tag.length;
  }
}

/** split por vírgula no nível 0 de parênteses (preserva numeric(10,2) etc.) */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** conteúdo entre o primeiro '(' em/após `from` e seu ')' correspondente (balanceado) */
export function balancedParens(s: string, from: number): string {
  const start = s.indexOf('(', from);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return s.slice(start + 1, i);
    }
  }
  return '';
}

/** normaliza a assinatura de função para comparação de identidade (tipos de arg) */
export function normalizeSignature(argsRaw: string): string {
  return splitTopLevel(argsRaw)
    .map((a) =>
      a
        .replace(/\bDEFAULT\b[\s\S]*$/i, '')
        .replace(/=[\s\S]*$/, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' '),
    )
    .filter(Boolean)
    .join(',');
}

/**
 * Extrai os objetos criados por uma migration.
 *
 * A limpeza de comentário é a COMPARTILHADA (`removerComentariosSql`), que entende a gramática do
 * Postgres. O `sql.replace(/--.*$/gm, '')` que morava aqui errava nos dois sentidos — a classe de
 * `docs/historico/gates-textuais-cegos.md`, aqui no eixo SQL:
 *  - comia de um `--` DENTRO de literal ou de identificador citado até o fim da linha, e a DDL
 *    seguinte sumia do inventário (ausência, o pior modo de falha de um audit);
 *  - não removia comentário de BLOCO, então DDL comentada para rollback entrava como objeto
 *    esperado — vermelho eterno, porque o banco nunca vai tê-la.
 * Medido no corpus de 483 migrations custom ao trocar: delta ZERO (1671 objetos antes e depois).
 * É endurecimento, não correção de falha ativa. Casos em migration-objects.test.ts.
 */
export function extractObjects(sql: string): ExtractedObject[] {
  const stripped = removerComentariosSql(sql);
  // Corpos vêm do CRU (ver `corposCrusPorNome`); nomes/assinaturas, do strippado.
  const corpos = corposCrusPorNome(sql);
  const objects: ExtractedObject[] = [];

  // CREATE [OR REPLACE] FUNCTION [schema.]name(args) — captura args via parênteses balanceados
  const fnRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(\w+)\.)?(\w+)\s*\(/gi;
  for (const m of stripped.matchAll(fnRe)) {
    const args = balancedParens(stripped, m.index! + m[0].length - 1);
    const corpo = corpos.get(`${(m[1] || 'public').toLowerCase()}.${m[2].toLowerCase()}`);
    objects.push({
      kind: 'function',
      schema: m[1] || 'public',
      name: m[2],
      signature: normalizeSignature(args),
      ...(corpo === undefined ? {} : { bodyMd5: corpo.md5, bodyMd5Exato: corpo.md5Exato }),
    });
  }

  // CREATE [OR REPLACE] [MATERIALIZED] VIEW [IF NOT EXISTS] [schema.]name
  const viewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)/gi;
  for (const m of stripped.matchAll(viewRe)) {
    objects.push({ kind: 'view', schema: m[1] || 'public', name: m[2] });
  }

  // CREATE TABLE [IF NOT EXISTS] [schema.]name (
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)\s*\(/gi;
  for (const m of stripped.matchAll(tableRe)) {
    objects.push({ kind: 'table', schema: m[1] || 'public', name: m[2] });
  }

  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] name ON [schema.]table
  const indexRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(?:(\w+)\.)?(\w+)/gi;
  for (const m of stripped.matchAll(indexRe)) {
    objects.push({ kind: 'index', schema: m[2] || 'public', name: m[1], parent: m[3] });
  }

  // CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name ... ON [schema.]table
  const trigRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(\w+)[\s\S]*?ON\s+(?:(\w+)\.)?(\w+)/gi;
  for (const m of stripped.matchAll(trigRe)) {
    objects.push({ kind: 'trigger', schema: m[2] || 'public', name: m[1], parent: m[3] });
  }

  // SELECT cron.schedule('jobname', ...)
  const cronRe = /cron\.schedule\s*\(\s*'([^']+)'/gi;
  for (const m of stripped.matchAll(cronRe)) {
    objects.push({ kind: 'cron_job', schema: 'cron', name: m[1] });
  }

  // ALTER TYPE [schema.]enum ADD VALUE [IF NOT EXISTS] 'value'
  const enumRe = /ALTER\s+TYPE\s+(?:(\w+)\.)?(\w+)\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi;
  for (const m of stripped.matchAll(enumRe)) {
    objects.push({ kind: 'enum_value', schema: m[1] || 'public', name: m[3], parent: m[2] });
  }

  // CREATE POLICY [IF NOT EXISTS] "nome com espaço"|nome ON [schema.]table
  // O nome CITADO é a forma majoritária no corpus e a classe `[^\s"]+` parava no 1º espaço:
  // 11% das policies sumiam do inventário (viravam AUSÊNCIA, não vermelho). Capturas aceitam
  // `%` só para RECONHECER a DDL gerada por `EXECUTE format(...)` e DESCARTÁ-LA — `%I` como
  // nome esperado é vermelho eterno; o certo é não inventariar. Ver migration-objects.test.ts.
  const policyRe = /CREATE\s+POLICY\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([\w%]+))\s+ON\s+(?:([\w%]+)\.)?([\w%]+)/gi;
  for (const m of stripped.matchAll(policyRe)) {
    const name = m[1] ?? m[2];
    const schema = m[3] || 'public';
    const parent = m[4];
    if ([name, schema, parent].some((s) => s.includes('%'))) continue;
    objects.push({ kind: 'rls_policy', schema, name, parent });
  }

  // dedupe por chave de colisão (IF NOT EXISTS pode repetir o mesmo objeto)
  const seen = new Set<string>();
  return objects.filter((o) => {
    const k = objectKey(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Chave estável de colisão. Dois objetos com a MESMA chave em migrations diferentes = a
 * "última a rodar vence" sobrescreve a outra. Function inclui assinatura (overloads são
 * objetos distintos); trigger/policy são por-tabela; enum_value é por-enum.
 */
export function objectKey(o: ExtractedObject): string {
  const base = `${o.schema}.${o.name}`;
  switch (o.kind) {
    case 'function':
      return `function:${base}(${o.signature ?? ''})`;
    case 'trigger':
      return `trigger:${o.schema}.${o.parent}.${o.name}`;
    case 'rls_policy':
      return `rls_policy:${o.schema}.${o.parent}.${o.name}`;
    case 'enum_value':
      return `enum_value:${o.schema}.${o.parent}:${o.name}`;
    case 'cron_job':
      return `cron_job:${o.name}`;
    default:
      return `${o.kind}:${base}`;
  }
}
