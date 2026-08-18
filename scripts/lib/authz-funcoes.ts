/**
 * authz-funcoes.ts — núcleo PURO da sentinela de EXECUTE das funções sensíveis.
 * ============================================================================================
 *
 * Sem I/O. Duas guardas sobre a MESMA allowlist (scripts/authz-funcoes-fechadas.ts):
 *   · auditGrantsFuncoes — gate ESTÁTICO, Parte E do `authz:check` (scripts/authz-gate-check.ts).
 *     Lê as migrations do repo; pega a reabertura DENTRO do PR, antes de virar produção.
 *   · compararExecuteProd — audit de PROD (db/audit-grants-funcoes-fechadas.ts, sob psql-ro).
 *     Lê o BANCO; pega o que o estático não vê — `GRANT` colado à mão no SQL Editor, migration
 *     que mergeou e nunca foi aplicada, e a função cujo fecho nunca esteve no repo.
 * Irmã exata de scripts/lib/authz-grants.ts, um nível abaixo: lá o objeto é a TABELA, aqui a FUNÇÃO.
 *
 * O VETOR (§7.4 item 1 / §8.5 item 4 de docs/historico/sentinela-authz-controle-nao-mencao.md):
 * `CREATE OR REPLACE FUNCTION` PRESERVA o ACL; `DROP FUNCTION` + `CREATE FUNCTION` **não** — a
 * função renasce herdando o default privilege, que em `public` concede EXECUTE a `anon` E
 * `authenticated` (MEDIDO em `pg_default_acl`, 2026-08-15) e em `private` nem existe, deixando
 * `proacl` NULL = EXECUTE implícito a PUBLIC. Nada no CI via isso: as Partes A/D checam o GATE no
 * corpo, a Parte C checa grant de TABELA.
 *
 * ANCORA NO FECHO, pelo mesmo motivo da Parte C: migration registra DELTA, e o estado inicial
 * (default privilege + baseline parqueado) não está no repo. Simular o absoluto fabricaria uma
 * verdade que o repo não tem. A diferença é que aqui a âncora é INCLUSIVA (`>=`, não `>`), e isso
 * é medido: das 5 recriações de função do contrato no repo, as 5 fazem `DROP`+`CREATE`+`REVOKE`
 * na PRÓPRIA migration que estabelece o ACL. Com `>` estrito, a forma que o vetor de fato tem
 * neste repo ficaria fora da vigilância — o detector nasceria cego para o seu único caso real.
 *
 * ⚠️ `REVOKE … FROM PUBLIC` NÃO restaura o fecho, e isso não é detalhe: o grant de `anon`/
 * `authenticated` é EXPLÍCITO (veio do default privilege por NOME), então só some com um REVOKE
 * que as nomeie (docs/agent/database.md; a mesma armadilha já custou caro em tabela). Um detector
 * que aceitasse `FROM PUBLIC` como fecho ficaria verde exatamente sobre o buraco.
 *
 * Achados carregam CÓDIGO ASCII estável em caixa fixa, todos prefixados `FUNCAO_` — os testes
 * casam o CÓDIGO, nunca a mensagem em português (lição #1483: `grep -qi` sobre string acentuada
 * falsifica por acidente de locale).
 *
 * ⚠️ O prefixo dá LEGIBILIDADE, não desambiguação: `FUNCAO_REABERTURA` CONTÉM `REABERTURA`, e
 * `FUNCAO_FECHO_PENDENTE` contém `FECHO_PENDENTE`. Quem filtra achado por código tem de casar o
 * código DELIMITADO — `[REABERTURA]`, como o `authz-gate-check` o emite — e não a substring solta.
 * Não é teoria: o teste da Parte C filtrava por substring e passou a contar achados desta parte no
 * primeiro run conjunto.
 */
import { stripNoise } from './authz-contract';
import type { FuncaoFechada, RoleVigiada } from '../authz-funcoes-fechadas';

type FuncaoCodigo =
  | 'FUNCAO_REABERTURA'
  | 'FUNCAO_RECRIADA_SEM_FECHO'
  | 'FUNCAO_ANCORA_AUSENTE'
  | 'FUNCAO_ANCORA_NAO_DECLARADA'
  | 'FUNCAO_FECHO_PENDENTE'
  | 'FUNCAO_GRANT_NAO_PARSEAVEL'
  | 'FUNCAO_DEFAULT_PRIVILEGE_ALTERADO'
  // exclusivos do audit de prod (compararExecuteProd):
  | 'FUNCAO_AUSENTE_EM_PROD'
  | 'FUNCAO_NAO_APLICADA'
  | 'FUNCAO_DRIFT_PROD';

export interface FuncaoFinding {
  level: 'error' | 'warn';
  codigo: FuncaoCodigo;
  /** schema.name */
  funcao: string;
  /** migration onde o achado mora, '—' quando não há arquivo, '(prod)' no audit de banco */
  file: string;
  msg: string;
}

const ROLES_VIGIADAS: RoleVigiada[] = ['anon', 'authenticated'];
const IDENT = '(?:"(?:[^"]|"")+"|[\\w$]+)';

/** Quebra o SQL (já sem comentários/strings) em statements por ';'. Só o pedaço que COMEÇA com o
 *  verbo é julgado — dollar-quote de corpo de função gera fragmentos que nunca começam assim. */
function statements(sql: string): string[] {
  return stripNoise(sql).split(';').map((s) => s.trim());
}

const unq = (s?: string) => (s ?? '').replace(/^"|"$/g, '').toLowerCase();

/** O statement fala da NOSSA função (schema certo, não sufixo nem homônima em outro schema)? */
function mencionaFuncao(stmt: string, schema: string, name: string): boolean {
  return new RegExp(`(?<![\\w.])(?:${schema}\\.)?"?${name}"?(?!\\w)`, 'i').test(stmt);
}

/** Alvos de `DROP FUNCTION [IF EXISTS] a(…), b(…)` — normalizados. Lista múltipla é SQL válido. */
function alvosDrop(stmt: string): string[] {
  const m = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(stmt);
  if (!m) return [];
  const out: string[] = [];
  const re = new RegExp(`(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})\\s*\\(`, 'gi');
  let g: RegExpExecArray | null;
  while ((g = re.exec(m[1])) !== null) out.push(`${unq(g[1]) || 'public'}.${unq(g[2])}`);
  return out;
}

/** Alvo de `CREATE [OR REPLACE] FUNCTION x(…)`. Julga o ALVO, não a menção: o CORPO de uma função
 *  qualquer pode citar uma protegida, e isso não a recria. */
function alvoCreate(stmt: string): string | null {
  const m = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})\\s*\\(`, 'i').exec(stmt);
  return m ? `${unq(m[1]) || 'public'}.${unq(m[2])}` : null;
}

interface AclStmt {
  /** roles NOMEADAS atingidas (PUBLIC de propósito NÃO entra — ver o ⚠️ do cabeçalho) */
  roles: string[];
  /** privilégio cobre EXECUTE (`EXECUTE` explícito ou `ALL`) */
  execute: boolean;
  /** `ON ALL FUNCTIONS IN SCHEMA <s>` — alcança toda função daquele schema */
  allFunctionsEm: string | null;
  /** `ON FUNCTION <alvo>` foi reconhecido (senão o chamador cai no fail-closed) */
  temAlvo: boolean;
}

/** Parseia `GRANT|REVOKE <privs> ON FUNCTION <alvo> TO|FROM <roles>` e a variante ALL FUNCTIONS. */
function parseAcl(stmt: string, verbo: 'GRANT' | 'REVOKE'): AclStmt | null {
  const prep = verbo === 'GRANT' ? 'TO' : 'FROM';
  const m = new RegExp(`^${verbo}\\s+([\\s\\S]+?)\\s+ON\\s+([\\s\\S]+?)\\s+${prep}\\s+([\\s\\S]+)$`, 'i').exec(stmt);
  if (!m) return null;
  const [, privRaw, onRaw, rolesRaw] = m;
  const execute = /\bEXECUTE\b/i.test(privRaw) || /\bALL\b/i.test(privRaw);
  if (!execute && !/\b(SELECT|INSERT|UPDATE|DELETE|USAGE|TRIGGER|REFERENCES)\b/i.test(privRaw)) return null; // privilégio irreconhecível → fail-closed
  const all = /\bALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+(\S+)/i.exec(onRaw);
  const temAlvo = all !== null || /\bFUNCTION\b/i.test(onRaw);
  const roles = rolesRaw
    .replace(/\bWITH\s+GRANT\s+OPTION\b/i, '')
    .replace(/\bCASCADE\b|\bRESTRICT\b/gi, '')
    .split(',')
    .map((r) => r.trim().replace(/"/g, '').toLowerCase())
    .filter((r) => /^\w+$/.test(r));
  return { roles, execute, allFunctionsEm: all ? unq(all[1]) : null, temAlvo };
}

/** Um evento pós-âncora que mexe no EXECUTE de uma role. */
type Abertura = { file: string; porRecriacao: boolean } | null;

/**
 * Gate estático: para cada função da allowlist, vigia o que veio da âncora em diante (inclusive).
 *
 * Modela, por ROLE PROIBIDA, um estado binário "aberta por quem" ao longo dos eventos:
 *   · `GRANT … TO <role>` abre;
 *   · `CREATE` depois de um `DROP` abre (a função renasce com o default privilege);
 *   · `REVOKE … FROM <role>` (pelo NOME) fecha.
 * O que sobra aberto no fim é o achado. Rastrear a ORDEM em vez de só procurar padrões evita os
 * dois falsos: `GRANT` seguido de `REVOKE` na mesma migration não é buraco, e `REVOKE` seguido de
 * `DROP`+`CREATE` **é** — o REVOKE anterior morreu junto com a função.
 *
 * O achado sai AGREGADO por função (não por role) e prioriza `FUNCAO_RECRIADA_SEM_FECHO` sobre
 * `FUNCAO_REABERTURA`: um GRANT explícito aparece no diff e alguém pode revisá-lo; a recriação
 * abre sem que nada no diff diga "grant", que é o que torna este vetor silencioso.
 *
 * @param existingFiles arquivos presentes em supabase/migrations/. Default: os das `migrations`.
 *   Separado para que o teste de ANCORA_AUSENTE possa simular a âncora sumindo do repo.
 */
export function auditGrantsFuncoes(
  migrations: { file: string; sql: string }[],
  allowlist: Record<string, FuncaoFechada>,
  existingFiles?: Set<string>,
): FuncaoFinding[] {
  const out: FuncaoFinding[] = [];
  const ordered = [...migrations].sort((a, b) => a.file.localeCompare(b.file));
  const files = existingFiles ?? new Set(ordered.map((m) => m.file));

  // `stripNoise` + split é o custo DOMINANTE desta parte, e o laço externo é por FUNÇÃO: sem
  // pré-computar, 40 entradas × 650 migrations refazem a MESMA limpeza de texto dezenas de
  // milhares de vezes. Medido A/B na mesma rodada, alternando as duas versões para controlar a
  // carga da máquina (9 pares): min 1006ms → 304ms, mediana 1967ms → 452ms, com os achados
  // byte-idênticos. Não é micro-otimização: o CI roda isto em todo PR, e sob carga a versão
  // ingênua estourava o timeout de 20s do vitest.
  const pre = ordered.map((m) => ({ file: m.file, stmts: statements(m.sql) }));

  // Mexer no default privilege muda a PREMISSA de todo o resto (é dele que a função recriada
  // herda o ACL). Não é erro — pode até estar fechando o vetor de raiz —, é revisita obrigatória
  // da medição. Fora do laço por função: o achado é do projeto, não de uma função.
  for (const m of pre) {
    for (const st of m.stmts) {
      if (/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(st) && /\bON\s+FUNCTIONS\b/i.test(st)) {
        out.push({
          level: 'warn',
          codigo: 'FUNCAO_DEFAULT_PRIVILEGE_ALTERADO',
          funcao: '—',
          file: m.file,
          msg: `ALTER DEFAULT PRIVILEGES sobre FUNCTIONS — o ACL que uma função recriada herda mudou. A medição que sustenta scripts/authz-funcoes-fechadas.ts (pg_default_acl, 2026-08-15) precisa ser refeita.`,
        });
      }
    }
  }

  for (const [chave, entry] of Object.entries(allowlist)) {
    const [schema, name] = chave.split('.');
    const proibidas = ROLES_VIGIADAS.filter((r) => !entry.permitido[r]);

    // (1) o repo fecha a função para TODAS as roles que o contrato proíbe? Detecta o fecho
    //     sozinho — é o que impede a allowlist de mentir sobre o repo (ANCORA_NAO_DECLARADA).
    //
    //     "TODAS" não é preciosismo, é uma correção medida: a 20260510235956 ("Fatia E3 Fase 1")
    //     revoga de `PUBLIC, anon` e **mantém o GRANT a `authenticated`** em 18 SECDEF. Para uma
    //     função que fecha por privilégio (as duas roles proibidas), esse REVOKE parcial NÃO é o
    //     fecho — e tratá-lo como fecho faria o gate exigir uma âncora que não existe, empurrando
    //     quem viesse depois a declarar como âncora um arquivo que concede o que ela proíbe.
    let revokeFile: string | null = null;
    const fechadasNoRepo = new Set<RoleVigiada>();
    for (const m of pre) {
      for (const st of m.stmts) {
        if (!/^REVOKE\b/i.test(st)) continue;
        const r = parseAcl(st, 'REVOKE');
        if (!r?.execute) continue;
        if (!(r.allFunctionsEm === schema || (r.allFunctionsEm === null && mencionaFuncao(st, schema, name)))) continue;
        for (const role of proibidas) if (r.roles.includes(role)) fechadasNoRepo.add(role);
        if (proibidas.every((role) => fechadasNoRepo.has(role))) revokeFile ??= m.file;
      }
    }

    // (2) estado da âncora.
    if (entry.fechadaPor === null) {
      out.push(
        revokeFile
          ? {
              level: 'error',
              codigo: 'FUNCAO_ANCORA_NAO_DECLARADA',
              funcao: chave,
              file: revokeFile,
              msg: `REVOKE de EXECUTE sobre ${chave} presente em ${revokeFile}, mas fechadaPor=null. O fecho mergeou — declare a âncora em scripts/authz-funcoes-fechadas.ts.`,
            }
          : {
              level: 'warn',
              codigo: 'FUNCAO_FECHO_PENDENTE',
              funcao: chave,
              file: '—',
              msg: `fecho de ${chave} não está no repo (fechadaPor=null) — o gate estático NÃO a vigia; quem afirma o estado dela é 'bun run authz:funcoes:prod'. ${entry.motivo}`,
            },
      );
      continue;
    }
    if (!files.has(entry.fechadaPor)) {
      out.push({
        level: 'error',
        codigo: 'FUNCAO_ANCORA_AUSENTE',
        funcao: chave,
        file: entry.fechadaPor,
        msg: `fechadaPor aponta ${entry.fechadaPor}, ausente de supabase/migrations/. O fecho foi revertido ou renomeado?`,
      });
      continue;
    }

    // (3) da âncora em diante, INCLUSIVE (ver o cabeçalho: as 5 recriações reais moram na âncora).
    const aberta = new Map<RoleVigiada, Abertura>(proibidas.map((r) => [r, null]));
    let dropPendente = false;

    for (const m of pre) {
      if (m.file.localeCompare(entry.fechadaPor) < 0) continue;
      for (const st of m.stmts) {
        if (!st) continue;

        if (/^DROP\s+FUNCTION\b/i.test(st)) {
          if (alvosDrop(st).includes(chave)) dropPendente = true;
          continue;
        }
        if (/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.test(st)) {
          // Só CREATE precedido de DROP reseta. `CREATE OR REPLACE` sozinho preserva o ACL — e é
          // o idioma que o repo usa para troca cirúrgica, então tratá-lo como reabertura
          // inundaria o gate de ruído e o desligaria.
          if (alvoCreate(st) === chave && dropPendente) {
            dropPendente = false;
            for (const r of proibidas) aberta.set(r, { file: m.file, porRecriacao: true });
          }
          continue;
        }
        if (/^GRANT\b/i.test(st)) {
          const g = parseAcl(st, 'GRANT');
          const mencao = mencionaFuncao(st, schema, name);
          if (!g || !g.temAlvo) {
            // fail-closed: parser que não entende um statement mencionando a função protegida
            // NÃO pode afirmar que está tudo bem.
            if (mencao) {
              out.push({
                level: 'error',
                codigo: 'FUNCAO_GRANT_NAO_PARSEAVEL',
                funcao: chave,
                file: m.file,
                msg: `GRANT menciona ${chave} numa forma que o parser não entendeu — não posso garantir que não reabre (fail-closed). Ajuste scripts/lib/authz-funcoes.ts.`,
              });
            }
            continue;
          }
          const alcanca = g.allFunctionsEm === schema || (g.allFunctionsEm === null && mencao);
          if (!alcanca || !g.execute) continue;
          for (const r of proibidas) if (g.roles.includes(r)) aberta.set(r, { file: m.file, porRecriacao: false });
          continue;
        }
        if (/^REVOKE\b/i.test(st)) {
          const rv = parseAcl(st, 'REVOKE');
          if (!rv || !rv.execute) continue;
          const alcanca = rv.allFunctionsEm === schema || (rv.allFunctionsEm === null && mencionaFuncao(st, schema, name));
          if (!alcanca) continue;
          for (const r of proibidas) if (rv.roles.includes(r)) aberta.set(r, null);
        }
      }
    }

    const sobrando = proibidas.filter((r) => aberta.get(r) !== null);
    if (sobrando.length === 0) continue;
    const porRecriacao = sobrando.filter((r) => aberta.get(r)!.porRecriacao);
    const culpada = aberta.get(porRecriacao[0] ?? sobrando[0])!;
    out.push(
      porRecriacao.length > 0
        ? {
            level: 'error',
            codigo: 'FUNCAO_RECRIADA_SEM_FECHO',
            funcao: chave,
            file: culpada.file,
            msg: `DROP FUNCTION + CREATE de ${chave} sem REVOKE que restaure o fecho — ela renasce com o default privilege do projeto, que concede EXECUTE a ${sobrando.join(' e ')}. CREATE OR REPLACE preservaria o ACL; o par DROP+CREATE não. Emita 'REVOKE EXECUTE ON FUNCTION ${chave}(...) FROM ${sobrando.join(', ')};' depois do CREATE — nomeando as roles: REVOKE de PUBLIC não tira o grant delas.`,
          }
        : {
            level: 'error',
            codigo: 'FUNCAO_REABERTURA',
            funcao: chave,
            file: culpada.file,
            msg: `GRANT EXECUTE a ${sobrando.join(' e ')} sobre ${chave} após o fecho — fora do permitido. ${entry.motivo}`,
          },
    );
  }
  return out;
}

/**
 * Estado MEDIDO em prod: função (`schema.name`) → roles vigiadas que TÊM EXECUTE + se o `proacl`
 * é NULL. Chave AUSENTE significa que a função não existe no banco (≠ existir sem privilégio),
 * e é por isso que este tipo carrega um objeto em vez de só a lista de roles: a diferença entre
 * "medi e não tem" e "não medi" é a diferença entre um audit e um teatro.
 */
export interface ExecuteMedido {
  roles: RoleVigiada[];
  /** `proacl` NULL ⇒ EXECUTE implícito a PUBLIC (função nasceu e ninguém tocou no ACL) */
  aclNulo: boolean;
}
export type MedicaoExecuteProd = Record<string, ExecuteMedido>;

/**
 * Audit de prod: compara o EXECUTE medido no BANCO com o contrato da allowlist.
 *
 * Dois erros distintos, porque a ação corretiva é distinta — mesma lógica de
 * `compararGrantsProd` para tabela, com o discriminante recalibrado para função:
 *   · FUNCAO_NAO_APLICADA — o estado medido é EXATAMENTE o que o default privilege concede
 *     (`anon` E `authenticated`), ou o `proacl` é NULL. Ninguém escreve isso à mão: é assinatura
 *     de "o REVOKE de fecho nunca rodou neste objeto" — migration no repo mas não aplicada no SQL
 *     Editor, ou função recriada por DROP+CREATE em prod. Corrige-se APLICANDO o fecho.
 *   · FUNCAO_DRIFT_PROD — sobra PARCIAL (uma role só). O default concede às duas, então uma
 *     sozinha significa que alguém mexeu: GRANT colado à mão. Corrige-se REVOGANDO e investigando.
 *
 * ⚠️ `fechadaPor === null` AVISA mas **não pula a comparação**, e é aqui que esta função diverge
 * de propósito da irmã `compararGrantsProd`. Em tabela, `null` quer dizer "o fecho ainda não
 * mergeou" — prod está legitimamente aberta e comparar só produziria ruído. Em função, `null`
 * quer dizer o oposto: MEDI prod fechada e o REVOKE não está em migration nenhuma. Como o gate
 * estático já não vigia esses casos (não há âncora para ancorar), pular a comparação aqui também
 * os deixaria sem NENHUMA guarda — justamente as entradas mais frágeis, cujo fecho não tem
 * registro no repo para reaplicar. O aviso diz que o estático está cego; a comparação continua.
 */
export function compararExecuteProd(
  medido: MedicaoExecuteProd,
  allowlist: Record<string, FuncaoFechada>,
): FuncaoFinding[] {
  const out: FuncaoFinding[] = [];
  for (const [chave, entry] of Object.entries(allowlist)) {
    if (entry.fechadaPor === null) {
      out.push({
        level: 'warn',
        codigo: 'FUNCAO_FECHO_PENDENTE',
        funcao: chave,
        file: '(prod)',
        msg: `${chave}: fechadaPor=null — o fecho NÃO está no repo, então o gate estático não a vigia e este audit é a única guarda dela (comparação abaixo vale normalmente). ${entry.motivo}`,
      });
    }
    const med = medido[chave];
    if (!med) {
      out.push({
        level: 'error',
        codigo: 'FUNCAO_AUSENTE_EM_PROD',
        funcao: chave,
        file: '(prod)',
        msg: `${chave} está na allowlist e NÃO existe no banco — foi removida, renomeada, ou a allowlist ficou obsoleta.`,
      });
      continue;
    }
    const extra = med.roles.filter((r) => !entry.permitido[r]);
    if (extra.length === 0 && !med.aclNulo) continue;

    const pareceDefault =
      med.aclNulo || (ROLES_VIGIADAS.every((r) => med.roles.includes(r)) && extra.length > 0);
    out.push({
      level: 'error',
      codigo: pareceDefault ? 'FUNCAO_NAO_APLICADA' : 'FUNCAO_DRIFT_PROD',
      funcao: chave,
      file: '(prod)',
      msg: pareceDefault
        ? `${chave}: ${med.aclNulo ? 'proacl NULL (EXECUTE implícito a PUBLIC)' : `anon e authenticated têm EXECUTE (${extra.join(',')} fora do permitido)`} — é o default privilege intacto: o fecho ${entry.fechadaPor} está no repo mas NÃO foi aplicado (ou a função foi recriada por DROP+CREATE em prod).`
        : `${chave}: ${extra.join(',')} tem EXECUTE fora do permitido — sobra parcial, que o default privilege não produz: grant aplicado à mão em prod (drift).`,
    });
  }
  return out;
}
