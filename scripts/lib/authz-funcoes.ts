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
import { chaveRevokeSemPublic } from '../authz-revoke-public-baseline';

type FuncaoCodigo =
  | 'FUNCAO_REABERTURA'
  | 'FUNCAO_RECRIADA_SEM_FECHO'
  | 'FUNCAO_ANCORA_AUSENTE'
  | 'FUNCAO_ANCORA_NAO_DECLARADA'
  | 'FUNCAO_FECHO_PENDENTE'
  | 'FUNCAO_GRANT_NAO_PARSEAVEL'
  | 'FUNCAO_DROP_NAO_PARSEAVEL'
  | 'FUNCAO_DEFAULT_PRIVILEGE_ALTERADO'
  // Parte F (universal, não presa à allowlist):
  | 'FUNCAO_REVOKE_SEM_PUBLIC'
  | 'FUNCAO_REVOKE_ALVO_NAO_PARSEAVEL'
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

/** Elementos de topo de uma lista separada por vírgula. A vírgula DENTRO de parênteses não separa:
 *  `f(uuid, text)` e `numeric(10,2)` são um elemento só. */
function elementosDeTopo(lista: string): string[] {
  const out: string[] = [];
  let prof = 0;
  let atual = '';
  for (const ch of lista) {
    if (ch === '(') prof++;
    else if (ch === ')') prof--;
    else if (ch === ',' && prof === 0) {
      out.push(atual);
      atual = '';
      continue;
    }
    atual += ch;
  }
  out.push(atual);
  return out;
}

/** Alvos de `DROP FUNCTION|ROUTINE [IF EXISTS] a(…), b, c(…) [CASCADE|RESTRICT]` — normalizados.
 *
 *  O corte é POSICIONAL: o NOME que ABRE cada elemento da lista. Casar `nome(` — exigir o
 *  parêntese — media a GRAFIA e concluía o EFEITO, e o efeito é o mesmo sem ela: a lista de
 *  argumentos é OPCIONAL desde o PG10 quando o nome é único no schema, e `ROUTINE` é sinônimo que
 *  derruba função igual. Medido em PG17: `DROP FUNCTION public.f;` + `CREATE` deixa `proacl` NULL
 *  e devolve EXECUTE a `anon` exatamente como a forma com args (`DROP ROUTINE`, idem) — enquanto
 *  `CREATE OR REPLACE` preserva o ACL. Sete grafias passavam caladas por esse `(`.
 *
 *  `entendido: false` marca elemento que o parser NÃO leu; o chamador trata como fail-closed,
 *  igual ao ramo do GRANT. `DROP PROCEDURE` fica de fora de propósito: o PG recusa derrubar função
 *  por ele (`is not a procedure`), então não é vetor — e se um dia mencionar função protegida, cai
 *  no fail-closed do chamador em vez de virar alvo inventado. */
function alvosDrop(stmt: string): { alvos: string[]; entendido: boolean } {
  const m = /^DROP\s+(?:FUNCTION|ROUTINE)\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$/i.exec(stmt);
  if (!m) return { alvos: [], entendido: true };
  const cabeca = new RegExp(`^(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`, 'i');
  const alvos: string[] = [];
  let entendido = true;
  for (const el of elementosDeTopo(m[1])) {
    const t = el.trim().replace(/\s*\b(?:CASCADE|RESTRICT)\s*$/i, '').trim();
    const g = t === '' ? null : cabeca.exec(t);
    if (!g) {
      entendido = false;
      continue;
    }
    alvos.push(`${unq(g[1]) || 'public'}.${unq(g[2])}`);
  }
  return { alvos, entendido };
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
  // `ROUTINES` alcança as FUNÇÕES do schema tanto quanto `FUNCTIONS` (PG11+), e `ROUTINE` é
  // sinônimo de `FUNCTION` no alvo singular. Ler só a grafia `FUNCTION` media a PALAVRA e concluía
  // o alcance: `GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO anon` reabria as 43 de uma vez,
  // calado (medido). `PROCEDURES` fica de fora de propósito — não alcança função.
  const all = /\bALL\s+(?:FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+(\S+)/i.exec(onRaw);
  const temAlvo = all !== null || /\b(?:FUNCTION|ROUTINE)\b/i.test(onRaw);
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
      // `ON ROUTINES` muda a MESMA premissa que `ON FUNCTIONS` — a grafia difere, o efeito não.
      if (/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(st) && /\bON\s+(?:FUNCTIONS|ROUTINES)\b/i.test(st)) {
        out.push({
          level: 'warn',
          codigo: 'FUNCAO_DEFAULT_PRIVILEGE_ALTERADO',
          funcao: '—',
          file: m.file,
          msg: `ALTER DEFAULT PRIVILEGES sobre FUNCTIONS/ROUTINES — o ACL que uma função recriada herda mudou. A medição que sustenta scripts/authz-funcoes-fechadas.ts (pg_default_acl, 2026-08-15) precisa ser refeita.`,
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

        if (/^DROP\s+(?:FUNCTION|ROUTINE)\b/i.test(st)) {
          const d = alvosDrop(st);
          if (d.alvos.includes(chave)) {
            dropPendente = true;
            continue;
          }
          // fail-closed simétrico ao ramo do GRANT: um DROP que CITA a função protegida sem que ela
          // tenha saído da lista de alvos é forma que o parser não leu — e um parser que não leu não
          // pode afirmar que o ACL sobreviveu.
          if (mencionaFuncao(st, schema, name)) {
            out.push({
              level: 'error',
              codigo: 'FUNCAO_DROP_NAO_PARSEAVEL',
              funcao: chave,
              file: m.file,
              msg: `DROP FUNCTION/ROUTINE menciona ${chave} numa forma que o parser não entendeu — não posso garantir que o ACL sobreviveu (fail-closed). DROP+CREATE reseta o ACL e devolve EXECUTE ao default do projeto. Ajuste scripts/lib/authz-funcoes.ts.`,
            });
          }
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

/* ==========================================================================================
 * Parte F — o ESPELHO do ⚠️ do cabeçalho deste arquivo.
 * ==========================================================================================
 * O ⚠️ lá em cima diz: `REVOKE … FROM PUBLIC` NÃO fecha, porque o grant de `anon`/`authenticated`
 * é EXPLÍCITO (veio do default privilege POR NOME). Verdade — e a recíproca também é verdade, o
 * que ninguém no CI via: `REVOKE … FROM anon` NÃO fecha enquanto PUBLIC mantiver EXECUTE, porque
 * `anon` é MEMBRO de PUBLIC.
 *
 * Que uma função nova em `public` nasce com os DOIS — `=X/postgres` (PUBLIC) e `anon=X`,
 * `authenticated=X` — é MEDIDO, não deduzido do manual: em 2026-08-22 havia 209 funções de
 * `public` com PUBLIC e as roles nomeadas simultaneamente no `proacl` (nenhuma delas jamais
 * tocada por REVOKE). Fechar de verdade exige os DOIS lados; qualquer um sozinho é teatro.
 * (Não afirmo aqui COMO o default de fábrica e o `pg_default_acl` do Supabase se combinam —
 * o `pg_default_acl` de `public` lista só os nomes, sem PUBLIC, e o efeito observado tem ambos.
 * A regra abaixo não depende de resolver isso: `anon ⊂ PUBLIC` basta.)
 *
 * RECONFERIDO em prod em 2026-09-07 (707 migrations no corpus): o sensor SEGUE aberto e SEGUE sendo
 * a única função de `public` cujo EXECUTE para `anon` vem SÓ de PUBLIC — 1 em 213 com anon-exec.
 * MEDIDO em prod (psql-ro, 2026-08-22): das 18 funções que algum dia receberam `REVOKE … FROM anon`
 * no repo, 17 estão efetivamente fechadas e 1 — `public.omie_products_codigos_multi_conta`, criada
 * pela 20260821200000 — ainda concede EXECUTE a `anon`, e SÓ via PUBLIC. Uma. É o tamanho real do
 * passivo, e é o que torna esta parte barata: ela não conserta o passado, impede o próximo.
 *
 * POR QUE A REGRA NÃO TEM EXCEÇÃO LEGÍTIMA: se PUBLIC retém EXECUTE, `anon` executa de qualquer
 * jeito. Logo "revogar de anon mantendo PUBLIC" nunca é intenção — é no-op ou é bug. Não é
 * preferência de estilo, é incoerência, então o gate pode ser universal sem custo de falso
 * positivo. Reemitir o `FROM PUBLIC` é idempotente e grátis.
 *
 * POR QUE POR FUNÇÃO, NUNCA POR ARQUIVO: a 20260821200000 emite os 3 REVOKE para
 * `farmer_association_rules_substituir` e só o de `anon` para o sensor. Um gate que perguntasse
 * "este arquivo tem algum FROM PUBLIC?" ficaria VERDE exatamente sobre o caso que o originou.
 * (Aconteceu de verdade na apuração deste achado: o primeiro grep foi por arquivo e excluiu a
 * própria migration culpada.)
 *
 * Universal de propósito — NÃO consulta `AUTHZ_FUNCOES_FECHADAS`. A allowlist da Parte E é curada
 * pelo eixo custo/preço, e o sensor que originou o achado não está nela; amarrar a regra à
 * allowlist a deixaria cega justamente onde ela nasceu.
 */

/** Alvos de `REVOKE … ON FUNCTION a(…), b(…) FROM <roles>`. `null` = não é dessa forma;
 *  `[]` = é, mas o alvo não parseou (o chamador trata como fail-closed). */
function alvosRevokeFuncao(stmt: string): { alvos: string[]; entendido: boolean } | null {
  const m = new RegExp(`^REVOKE\\s+[\\s\\S]+?\\s+ON\\s+FUNCTION\\s+([\\s\\S]+)\\s+FROM\\s+[\\s\\S]+$`, 'i').exec(stmt);
  if (!m) return null;
  // Mesma leitura de lista do `alvosDrop`: separa por vírgula de TOPO e lê só a CABEÇA de cada
  // elemento. Varrer `ident(` com regex casaria também o tipo parametrizado de um argumento
  // (`public.f(numeric(10,2))` produziria o alvo fantasma `public.numeric`).
  const cabeca = new RegExp(`^(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})`, 'i');
  const alvos: string[] = [];
  let entendido = true;
  for (const el of elementosDeTopo(m[1])) {
    const t = el.trim().replace(/\s*\b(?:CASCADE|RESTRICT)\s*$/i, '').trim();
    const g = t === '' ? null : cabeca.exec(t);
    if (!g) {
      entendido = false;
      continue;
    }
    alvos.push(`${unq(g[1]) || 'public'}.${unq(g[2])}`);
  }
  return { alvos, entendido };
}

/**
 * Parte F: toda função que recebe `REVOKE EXECUTE … FROM anon|authenticated` em algum ponto do
 * corpus precisa receber `REVOKE … FROM PUBLIC` — na mesma migration, numa POSTERIOR (fix-forward),
 * ou por um sweep `ON ALL FUNCTIONS IN SCHEMA <mesmo schema> FROM PUBLIC`.
 *
 * O julgamento é sobre o CORPUS ORDENADO, não sobre um arquivo isolado, por uma razão dura:
 * migration aplicada NÃO se edita (o snapshot é a fonte de DR e o passado já rodou), então o único
 * conserto legal para uma migration já mergeada é uma POSTERIOR. Um gate por arquivo obrigaria a
 * baselinar todo conserto legítimo — e foi o que aconteceu na primeira versão desta parte, que
 * acusava a `20260821200000` mesmo com a `20260822003041` fechando o débito no arquivo seguinte.
 *
 * A ordem importa nos dois sentidos: um `DROP FUNCTION` + `CREATE` POSTERIOR ao fecho RESETA o ACL
 * e ANULA o `FROM PUBLIC` anterior (o mesmo vetor da Parte E). Já a recriação que traz o REVOKE na
 * PRÓPRIA migration vale — a comparação é INCLUSIVA, ver o comentário na condição abaixo.
 *
 * @param baseline pares `arquivo→função` históricos, medidos fechados em prod. Ver
 *   scripts/authz-revoke-public-baseline.ts — a baseline é justificada por MEDIÇÃO, não por silêncio.
 */
export function auditRevokeSemPublic(
  migrations: { file: string; sql: string }[],
  baseline: ReadonlySet<string>,
): FuncaoFinding[] {
  const out: FuncaoFinding[] = [];
  const ordered = [...migrations].sort((a, b) => a.file.localeCompare(b.file));

  // Estado por função ao longo do CORPUS ORDENADO (não por arquivo — ver o §Parte F acima).
  type Est = { ultNominal: number; ultNominalFile: string; roles: Set<string>; ultPublic: number; ultRecriacao: number };
  const est = new Map<string, Est>();
  const sweepPublicPorSchema = new Map<string, number>(); // schema → índice do último sweep
  const pega = (a: string): Est => {
    let e = est.get(a);
    if (!e) { e = { ultNominal: -1, ultNominalFile: '', roles: new Set(), ultPublic: -1, ultRecriacao: -1 }; est.set(a, e); }
    return e;
  };

  for (let i = 0; i < ordered.length; i++) {
    const mig = ordered[i];
    const stmts = statements(mig.sql);
    const naoParseavel: string[] = [];
    const dropados = new Set<string>();
    let dropNaoLido = false;

    for (const st of stmts) {
      // recriação: DROP+CREATE na mesma migration RESETA o ACL, matando o REVOKE de PUBLIC anterior.
      if (/^DROP\s+(?:FUNCTION|ROUTINE)\b/i.test(st)) {
        const d = alvosDrop(st);
        for (const a of d.alvos) dropados.add(a);
        // fail-closed: DROP que o parser não leu pode ter derrubado a função que o CREATE recria.
        if (!d.entendido) dropNaoLido = true;
      }
      const criado = alvoCreate(st);
      if (criado && (dropados.has(criado) || dropNaoLido)) pega(criado).ultRecriacao = i;

      if (!/^REVOKE\b/i.test(st)) continue;
      const r = parseAcl(st, 'REVOKE');
      if (!r || !r.execute || !r.temAlvo) continue;
      const temPublic = r.roles.includes('public');
      const nominais = ROLES_VIGIADAS.filter((x) => r.roles.includes(x));
      if (!temPublic && nominais.length === 0) continue;

      if (r.allFunctionsEm) {
        if (temPublic) sweepPublicPorSchema.set(r.allFunctionsEm, i);
        continue;
      }
      const alv = alvosRevokeFuncao(st);
      if (alv === null || alv.alvos.length === 0 || !alv.entendido) {
        if (nominais.length > 0) naoParseavel.push(st.replace(/\s+/g, ' ').slice(0, 90));
        if (alv === null || alv.alvos.length === 0) continue;
      }
      for (const a of alv.alvos) {
        const e = pega(a);
        if (temPublic) e.ultPublic = i;
        if (nominais.length > 0) { e.ultNominal = i; e.ultNominalFile = mig.file; for (const n of nominais) e.roles.add(n); }
      }
    }

    for (const st of naoParseavel) {
      out.push({
        level: 'error',
        codigo: 'FUNCAO_REVOKE_ALVO_NAO_PARSEAVEL',
        funcao: '(alvo não parseado)',
        file: mig.file,
        msg: `REVOKE de EXECUTE sobre role nomeada cujo ALVO não parseou — fail-closed, não dá p/ afirmar que PUBLIC foi fechado: \`${st}\``,
      });
    }
  }

  for (const [alvo, e] of [...est].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (e.ultNominal < 0) continue; // nunca revogou role nomeada: a regra não se aplica
    const sweep = sweepPublicPorSchema.get(alvo.split('.')[0]) ?? -1;
    const fechoPublic = Math.max(e.ultPublic, sweep);
    // Vale se ALGUM fecho de PUBLIC existe e sobreviveu à última recriação (DROP+CREATE reseta ACL).
    // A comparação é INCLUSIVA (`>=`) pelo mesmo motivo MEDIDO que a Parte E documenta: a forma
    // real de recriação neste repo é `DROP`+`CREATE`+`REVOKE` na MESMA migration. Com `>` estrito
    // o detector reprovaria justamente a forma correta — 13 falsos positivos medidos ao tentar.
    if (fechoPublic >= 0 && fechoPublic >= e.ultRecriacao) continue;
    if (baseline.has(chaveRevokeSemPublic(e.ultNominalFile, alvo))) continue;
    const recriadaDepois = fechoPublic >= 0 && fechoPublic < e.ultRecriacao;
    out.push({
      level: 'error',
      codigo: 'FUNCAO_REVOKE_SEM_PUBLIC',
      funcao: alvo,
      file: e.ultNominalFile,
      msg:
        `revoga EXECUTE de ${[...e.roles].sort().join('/')} sobre ${alvo} e ${recriadaDepois
          ? 'o único REVOKE de PUBLIC do corpus foi ANULADO por um DROP+CREATE posterior (recriação reseta o ACL)'
          : 'nenhuma migration do corpus revoga de PUBLIC'}. ` +
        `Essas roles são MEMBRO de PUBLIC: enquanto PUBLIC tiver EXECUTE o revoke é teatro. ` +
        `Acrescente \`REVOKE EXECUTE ON FUNCTION ${alvo}(…) FROM PUBLIC;\` — nesta migration, ou numa posterior se esta já foi aplicada.`,
    });
  }
  return out;
}
