/**
 * authz-rls.ts — núcleo PURO da reconciliação de RLS viva contra o contrato do repo.
 * ============================================================================================
 *
 * Puro de propósito: não abre conexão, não lê arquivo, não conhece `psql`. Quem mede é
 * `db/audit-rls-prod.ts`; quem compara é este módulo, e por isso ele é testável sem banco
 * (`scripts/authz-rls.test.ts`, que roda no CI) e falsificável sem prod.
 *
 * ═══ OS QUATRO EIXOS, E POR QUE SÃO QUATRO ═══
 *
 *   1. INTERRUPTOR (universal, sem allowlist) — `relrowsecurity` de TODA tabela de `public`.
 *      É o eixo que pega o `ALTER TABLE … DISABLE ROW LEVEL SECURITY` colado à mão, que é o vetor
 *      que motivou a guarda. Universal porque o estado esperado é o mesmo para todas.
 *   2. CONTEÚDO (allowlist curada) — o conjunto exato de policies das tabelas money-path, com
 *      `polcmd`, `polpermissive`, `polroles` e o md5 de `qual`/`with_check`.
 *   3. PREDICADO (derivado do eixo 2) — o md5 do `prosrc` das funções que as policies CHAMAM,
 *      descobertas por `pg_depend`. Existe porque o eixo 2 é CEGO a ele: reescrever
 *      `cap_pedido_escrever` para `SELECT true` deixa o texto do `qual` idêntico.
 *   4. GRUPO DE LACUNA (o NEGATIVO dos outros três) — não mede autorização nenhuma: mede se a
 *      DECLARAÇÃO de não-cobertura ainda descreve o que existe. Conta em prod as tabelas de cada
 *      grupo de `LACUNAS_POR_GRUPO` e desconta as curadas. Existe porque os eixos 1-3 reconciliam
 *      o contrato contra prod e ninguém reconciliava a declaração contra prod: uma migration que
 *      gateie mais uma tabela por `cap_carteira_ler` deixava a contagem declarada falsa em
 *      silêncio (§7.2 do histórico), verde em todos os gates.
 *
 * ═══ O QUE ESTA GUARDA NÃO PEGA (limites declarados, medidos e não deduzidos) ═══
 *
 *   · **Bypass estrutural, que não passa por policy nenhuma.** `service_role` tem `rolbypassrls`;
 *     função `SECURITY DEFINER` roda como owner; view com `security_invoker=off` lê as bases como
 *     `postgres`; MV não tem RLS. Uma policy perfeita não impede nada disso — e nenhum desses
 *     eixos é medido aqui (o de views tem guarda própria em `db/audit-anon-dml-bypass.sh`; o de
 *     SECDEF, no `authz:audit:prod` para as funções do manifest).
 *   · **ACL por COLUNA.** RLS filtra LINHA. O `GRANT SELECT (omie_payload)` de `sales_orders` é
 *     invisível daqui — é o `authz:grants:prod` que o cobre, e mesmo ele só em nível de tabela.
 *   · **O 2º nível do grafo de predicados.** `pg_depend` registra policy→função, mas NÃO registra
 *     função→função: o md5 de `cap_custo_ler` não se move quando o corpo de `has_role` muda. Hoje
 *     o fecho é completo por COINCIDÊNCIA do grafo medido (`cap_custo_ler` e `cap_pedido_escrever`
 *     só chamam `has_role`, que está declarada como predicado direto de outras policies) — não por
 *     construção. Uma função-predicado que passe a chamar uma 3ª função nova sai do alcance sem
 *     alarme. Se isso acontecer, a correção é declarar a 3ª como predicado, não afrouxar aqui.
 *   · **O que o md5 QUER dizer.** Ele acusa que mudou, nunca se a mudança é boa. É alarme de
 *     drift para leitura humana — e um `pg_get_expr` remonta a expressão a partir da árvore de
 *     parse, então renomear uma coluna move o md5 sem mexer em autorização nenhuma (falso-positivo
 *     conservador, que é a direção certa).
 *   · **A janela entre execuções.** Roda on-demand, como os outros audits de prod; não tem
 *     `psql-ro` no CI e não deve ter. Cadência é problema do carimbo de evidência.
 *   · **O EFEITO.** Catálogo não prova alcance — a lição de `has_table_privilege` vs `USAGE` de
 *     schema (database.md §1). Medido: sob `psql-ro` em prod, `SET ROLE authenticated` devolve
 *     `permission denied to set role`, então a prova executada NÃO é possível contra produção. Ela
 *     mora no PG17 descartável (`db/test-audit-rls-prod.sh`), que exerce as policies sob
 *     `SET ROLE authenticated` + `request.jwt.claim.sub`.
 */
import { createHash } from 'node:crypto';

import type {
  TabelaRls,
  PredicadoEsperado,
  PolicyEsperada,
  LacunaGrupo,
  DefinicaoGrupo,
} from '../authz-rls-esperado';

// Sem `export`, como o `GrantCodigo` de authz-grants.ts: os testes e o harness casam o CÓDIGO
// como string literal delimitada por colchetes, não o tipo.
type RlsCodigo =
  // eixo 1 — o interruptor
  | 'RLS_DESLIGADA'
  | 'RLS_DESLIGADA_FORA_DO_CONTRATO'
  // eixo 2 — o conteúdo
  | 'TABELA_AUSENTE'
  | 'FORCE_DIVERGENTE'
  | 'POLICY_NOVA'
  | 'POLICY_SUMIU'
  | 'POLICY_ALTERADA'
  | 'FOR_ALL_ASSIMETRICO'
  // eixo 3 — o predicado
  | 'PREDICADO_NAO_DECLARADO'
  | 'PREDICADO_ALTERADO'
  | 'PREDICADO_SUMIU'
  // eixo 4 — a declaração de lacuna em bloco. Dois códigos e não um, pela mesma razão de
  // POLICY_NOVA vs POLICY_ALTERADA: as correções são OPOSTAS. `MUDOU` pede re-medir e renovar o
  // número; `CURADO` pede APAGAR a entrada, porque o grupo deixou de ser lacuna.
  | 'LACUNA_GRUPO_MUDOU'
  | 'LACUNA_GRUPO_CURADO';

export interface RlsFinding {
  level: 'error' | 'warn';
  codigo: RlsCodigo;
  /** O objeto do achado. NUNCA contém `:` — o `idFinding` do carimbo de evidência parseia
   *  `[CODIGO] objeto:` e um `:` no meio partiria o id ao meio. */
  objeto: string;
  msg: string;
}

export interface MedPolicy {
  tabela: string;
  nome: string;
  cmd: string;
  permissiva: boolean;
  roles: string;
  qualMd5: string | null;
  wcMd5: string | null;
}

export interface MedicaoRls {
  /** Eixo 1. `totalTabelas` existe para o piso de sanidade do runner: uma medição que devolve 0
   *  tabelas não é "nenhuma violação", é medição quebrada. */
  universal: { tabelasSemRls: string[]; totalTabelas: number };
  /** Eixo 2, parte tabela. `existe:false` quando o contrato declara uma tabela que sumiu. */
  tabelas: { tabela: string; existe: boolean; rls: boolean; force: boolean }[];
  policies: MedPolicy[];
  /** Eixo 3. Descoberto por `pg_depend` a partir das policies das tabelas do contrato. */
  predicados: { funcao: string; secdef: boolean; cfg: string; srcMd5: string }[];
  /** Eixo 4. Uma entrada por grupo DECLARADO, com os `relname` (sem schema — todos de `public`)
   *  que o grupo tem em prod. É a LISTA e não a contagem de propósito: a mensagem do achado
   *  precisa nomear quem entrou e quem saiu, senão "22 → 23" manda o leitor refazer a query. */
  grupos: { grupo: string; tabelas: string[] }[];
}

/** Rótulo estável de um grupo — é o `objeto` do finding e o identificador que o runner casa entre
 *  a declaração e a medição, então ele NÃO pode conter `:` (o `idFinding` do carimbo parte por
 *  ele). Derivado da definição, nunca declarado ao lado dela: um campo `id` escrito à mão seria
 *  mais uma prosa capaz de divergir do dado que descreve, que é a classe inteira que este eixo
 *  existe para fechar. */
export function rotuloGrupo(def: DefinicaoGrupo): string {
  return def.tipo === 'predicado' ? def.predicado : `${def.prefixo}*`;
}

/** md5 do conjunto de tabelas de um grupo. Ordena em JS de propósito, e NÃO em SQL: o
 *  `ORDER BY` do Postgres usa COLLATION, e `_` ordena antes de letra em `C` e é ignorado em
 *  ICU/pt_BR — o mesmo conjunto produziria md5 diferente conforme o locale do servidor. O sort
 *  default de JS é por code unit, que para `[a-z0-9_]` é estável em qualquer ambiente (a lição
 *  #1483, de falsificar em UM locale só, aplicada ANTES de o bug existir). */
export function md5Lista(tabelas: readonly string[]): string {
  return createHash('md5').update([...tabelas].sort().join(','), 'utf8').digest('hex');
}

/** Roles do contrato (array) reduzidas à mesma forma que a medição produz: ordenadas, `+`. */
function normRoles(rs: string[]): string {
  return [...rs].sort().join('+');
}

/** Rótulo humano do `polcmd`, para que a mensagem diga SELECT e não `r`. */
const CMD_NOME: Record<string, string> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
  '*': 'ALL',
};
function cmdNome(c: string): string {
  return CMD_NOME[c] ?? c;
}

/** `null` vira um literal distinguível: `AUSENTE` ≠ `''` ≠ um md5. A lição do §4 sobre assert que
 *  ancora em vazio — estados mutuamente distinguíveis, nunca a string vazia. Uma policy de INSERT
 *  sem `USING` e uma medição que quebrou têm de LER diferente na mensagem, senão o operador não
 *  distingue "é a forma correta" de "não consegui medir". */
function md5Txt(v: string | null): string {
  return v ?? 'AUSENTE';
}

/**
 * Check ESTRUTURAL, independente da baseline: `FOR ALL` cujo `WITH CHECK` diverge do `USING`.
 *
 * database.md §4 (achado Codex xhigh, #1434/E2-FU4): `WITH CHECK` NÃO se aplica a DELETE — só o
 * `USING` é consultado. Uma policy `FOR ALL USING (cap_ler) WITH CHECK (cap_escrever)` parece
 * separar leitura de escrita e não separa: quem tem só a capability de LEITURA continua apagando.
 * É falha LATENTE — não abre nada enquanto as duas expressões coincidem, e por isso passa em
 * qualquer teste de "o comportamento não mudou".
 *
 * Roda sobre o MEDIDO (o que está em prod), não sobre a baseline: o ponto é acusar o dia em que
 * alguém apertar um dos lados no SQL Editor, e nesse dia a baseline ainda é a antiga. Um `WITH
 * CHECK` AUSENTE não é assimetria — o Postgres reusa o `USING`, simétrico por construção.
 */
function checarForAllAssimetrico(p: MedPolicy, entry: TabelaRls | undefined): RlsFinding | null {
  if (p.cmd !== '*') return null;
  if (p.wcMd5 === null || p.wcMd5 === p.qualMd5) return null;
  if (entry?.forAllAssimetricoOk) return null;
  return {
    level: 'error',
    codigo: 'FOR_ALL_ASSIMETRICO',
    objeto: `${p.tabela} » ${p.nome}`,
    msg:
      `${p.tabela} » ${p.nome}: policy FOR ALL com WITH CHECK (${p.wcMd5}) DIFERENTE do USING ` +
      `(${md5Txt(p.qualMd5)}). O DELETE consulta só o USING (database.md §4) — quem satisfaz o ` +
      `USING apaga, mesmo sem satisfazer o WITH CHECK. Divida em uma policy POR COMANDO, ou ` +
      `declare \`forAllAssimetricoOk\` na entrada explicando por que a assimetria é desenho.`,
  };
}

/** Compara campo a campo uma policy medida com a declarada. Retorna a lista de divergências. */
function diffPolicy(med: MedPolicy, esp: PolicyEsperada): string[] {
  const d: string[] = [];
  if (med.cmd !== esp.cmd) d.push(`cmd ${cmdNome(med.cmd)} (contrato: ${cmdNome(esp.cmd)})`);
  if (med.permissiva !== esp.permissiva) {
    d.push(
      `${med.permissiva ? 'PERMISSIVE' : 'RESTRICTIVE'} (contrato: ${esp.permissiva ? 'PERMISSIVE' : 'RESTRICTIVE'})`,
    );
  }
  const rolesEsp = normRoles(esp.roles);
  if (med.roles !== rolesEsp) d.push(`roles ${med.roles || '(vazio)'} (contrato: ${rolesEsp})`);
  if (med.qualMd5 !== esp.qualMd5) d.push(`USING ${md5Txt(med.qualMd5)} (contrato: ${md5Txt(esp.qualMd5)})`);
  if (med.wcMd5 !== esp.withCheckMd5) {
    d.push(`WITH CHECK ${md5Txt(med.wcMd5)} (contrato: ${md5Txt(esp.withCheckMd5)})`);
  }
  return d;
}

/**
 * A reconciliação inteira. Fail-closed em todas as direções: sobra em prod é achado, falta em prod
 * é achado, e objeto AUSENTE é divergência — nunca "negado com sucesso" (a regra da sentinela do
 * `claude_ro`, database.md §1).
 */
export function compararRlsProd(
  med: MedicaoRls,
  contrato: Record<string, TabelaRls>,
  predicados: Record<string, PredicadoEsperado>,
  plataforma: ReadonlySet<string>,
  grupos: readonly LacunaGrupo[],
): RlsFinding[] {
  const out: RlsFinding[] = [];
  const noContrato = new Set(Object.keys(contrato));

  // ── EIXO 1 — o interruptor, universal ──────────────────────────────────────────────────────
  // Tabela curada com RLS desligada é o pior caso possível e ganha código próprio: a ação
  // corretiva é a mesma (religar), mas a urgência não é, e um relatório que empilhasse as duas
  // sob o mesmo rótulo faria a de money-path se perder no meio das outras.
  for (const t of med.universal.tabelasSemRls) {
    const curada = noContrato.has(t);
    out.push({
      level: 'error',
      codigo: curada ? 'RLS_DESLIGADA' : 'RLS_DESLIGADA_FORA_DO_CONTRATO',
      objeto: t,
      msg: curada
        ? `${t}: ROW LEVEL SECURITY DESLIGADA numa tabela do contrato de RLS — as policies dela ` +
          `estão INERTES (o Postgres não as consulta) e qualquer \`authenticated\` com grant lê e ` +
          `escreve a tabela inteira. Religue: ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY.`
        : `${t}: ROW LEVEL SECURITY desligada. Não está no contrato curado, mas a invariante do ` +
          `repo é que TODA tabela de public sai com RLS (CLAUDE.md) — ou foi desligada à mão no ` +
          `SQL Editor, ou nasceu sem. Confira as policies antes de religar: com RLS ligada e ` +
          `nenhuma policy, a tabela fica FECHADA para anon/authenticated.`,
    });
  }

  // ── EIXO 2 — o conteúdo das policies curadas ───────────────────────────────────────────────
  const porTabela = new Map<string, MedPolicy[]>();
  for (const p of med.policies) {
    const lista = porTabela.get(p.tabela);
    if (lista) lista.push(p);
    else porTabela.set(p.tabela, [p]);
  }
  const medTab = new Map(med.tabelas.map((t) => [t.tabela, t]));

  for (const [chave, entry] of Object.entries(contrato)) {
    const t = medTab.get(chave);
    if (!t || !t.existe) {
      // Ausente NÃO é "fechada com sucesso": pode ser tabela renomeada, dropada, ou o contrato
      // apontando para um nome que nunca existiu — e nos três casos a guarda está INERTE.
      out.push({
        level: 'error',
        codigo: 'TABELA_AUSENTE',
        objeto: chave,
        msg:
          `${chave}: declarada no contrato e AUSENTE em prod (ou não é uma tabela comum). A ` +
          `entrada está inerte — vigia um objeto que não existe. Renomeada? Dropada? Corrija a ` +
          `chave ou remova a entrada, com o motivo.`,
      });
      continue;
    }
    // RLS desligada já saiu no eixo 1 com o código específico; aqui só o que ele não cobre.
    if (t.force !== entry.forceRls) {
      out.push({
        level: 'error',
        codigo: 'FORCE_DIVERGENTE',
        objeto: chave,
        msg:
          `${chave}: relforcerowsecurity=${t.force} (contrato: ${entry.forceRls}). FORCE decide se ` +
          `o OWNER da tabela também é filtrado pela RLS — desligá-lo devolve ao owner o bypass, e ` +
          `ligá-lo pode quebrar trigger/engine que escreve como owner (database.md §4).`,
      });
    }

    const medidas = porTabela.get(chave) ?? [];
    const vistas = new Set<string>();
    for (const p of medidas) {
      vistas.add(p.nome);
      const esp = entry.policies[p.nome];
      if (!esp) {
        out.push({
          level: 'error',
          codigo: 'POLICY_NOVA',
          objeto: `${chave} » ${p.nome}`,
          msg:
            `${chave} » ${p.nome}: policy ${cmdNome(p.cmd)} ${p.permissiva ? 'PERMISSIVE' : 'RESTRICTIVE'} ` +
            `TO ${p.roles || '(vazio)'} existe em prod e NÃO está no contrato (USING=${md5Txt(p.qualMd5)}, ` +
            `WITH CHECK=${md5Txt(p.wcMd5)}). Policy permissiva nova SOMA por OR — ela só pode ` +
            `AMPLIAR o acesso. Leia o predicado antes de declarar a entrada.`,
        });
        continue;
      }
      const difs = diffPolicy(p, esp);
      if (difs.length > 0) {
        out.push({
          level: 'error',
          codigo: 'POLICY_ALTERADA',
          objeto: `${chave} » ${p.nome}`,
          msg: `${chave} » ${p.nome}: divergente do contrato em ${difs.length} campo(s) — ${difs.join(' · ')}.`,
        });
      }
      const assim = checarForAllAssimetrico(p, entry);
      if (assim) out.push(assim);
    }
    for (const nome of Object.keys(entry.policies)) {
      if (vistas.has(nome)) continue;
      out.push({
        level: 'error',
        codigo: 'POLICY_SUMIU',
        objeto: `${chave} » ${nome}`,
        msg:
          `${chave} » ${nome}: declarada no contrato e AUSENTE em prod. Um DROP POLICY não deixa ` +
          `rastro em migration nenhuma quando é colado no SQL Editor; e numa tabela onde o acesso ` +
          `vem de VÁRIAS policies permissivas, remover uma FECHA um caminho legítimo em silêncio.`,
      });
    }
  }

  // Policies medidas em tabela FORA do contrato não são achado — a medição do eixo 2 já pergunta
  // só pelas tabelas curadas, e a checagem estrutural de FOR ALL segue o mesmo escopo.

  // ── EIXO 3 — os predicados ─────────────────────────────────────────────────────────────────
  const vistosPred = new Set<string>();
  for (const f of med.predicados) {
    vistosPred.add(f.funcao);
    if (plataforma.has(f.funcao)) continue; // enumerada, corpo não congelado — ver o contrato
    const esp = predicados[f.funcao];
    if (!esp) {
      out.push({
        level: 'error',
        codigo: 'PREDICADO_NAO_DECLARADO',
        objeto: f.funcao,
        msg:
          `${f.funcao}: função referenciada por uma policy curada e NÃO declarada em ` +
          `AUTHZ_RLS_PREDICADOS (secdef=${f.secdef}, cfg=${f.cfg || '(sem SET)'}, ` +
          `md5=${f.srcMd5}). É onde a autorização real pode morar sem que o md5 da policy mude — ` +
          `declare a entrada com o md5 medido, ou explique por que ela não precisa ser congelada.`,
      });
      continue;
    }
    const difs: string[] = [];
    if (f.secdef !== esp.secdef) difs.push(`SECURITY DEFINER ${f.secdef} (contrato: ${esp.secdef})`);
    if (f.cfg !== esp.cfg) difs.push(`proconfig "${f.cfg}" (contrato: "${esp.cfg}")`);
    if (f.srcMd5 !== esp.srcMd5) difs.push(`corpo md5 ${f.srcMd5} (contrato: ${esp.srcMd5})`);
    if (difs.length > 0) {
      out.push({
        level: 'error',
        codigo: 'PREDICADO_ALTERADO',
        objeto: f.funcao,
        msg:
          `${f.funcao}: ${difs.join(' · ')}. O texto da policy que a chama NÃO muda quando isto ` +
          `muda — é o ponto cego que este eixo existe para fechar. Leia o corpo vivo ` +
          `(pg_get_functiondef) ANTES de renovar o md5.`,
      });
    }
  }
  for (const nome of Object.keys(predicados)) {
    if (vistosPred.has(nome)) continue;
    out.push({
      level: 'error',
      codigo: 'PREDICADO_SUMIU',
      objeto: nome,
      msg:
        `${nome}: declarada em AUTHZ_RLS_PREDICADOS e NENHUMA policy curada a referencia mais. Ou ` +
        `a policy que a usava mudou de predicado (veja os achados de POLICY_*), ou a entrada ` +
        `envelheceu. Entrada que não vigia nada é cobertura só no papel.`,
    });
  }

  // ── EIXO 4 — a declaração de lacuna em BLOCO ────────────────────────────────────────────────
  // Este eixo não mede autorização: mede se a DECLARAÇÃO ainda descreve prod. As curadas são
  // DESCONTADAS aqui (do contrato ao lado, a cada execução) em vez de declaradas — número
  // derivado não apodrece, e é o que dá o denominador da linha do veredito.
  const medPorGrupo = new Map(med.grupos.map((g) => [g.grupo, g.tabelas]));
  for (const g of grupos) {
    const rot = rotuloGrupo(g.def);
    const medidas = medPorGrupo.get(rot);
    if (medidas === undefined) {
      // Grupo declarado sem linha de medição. O runner tem piso para isto, mas repetir aqui é o
      // que mantém o módulo puro fail-closed sozinho: ausência de dado NUNCA vira "bate".
      out.push({
        level: 'error',
        codigo: 'LACUNA_GRUPO_MUDOU',
        objeto: rot,
        msg:
          `${rot}: grupo declarado em LACUNAS_POR_GRUPO e SEM linha de medição. Não é "zero ` +
          `divergências" — é medição que não aconteceu para este grupo.`,
      });
      continue;
    }
    const curadas = medidas.filter((t) => `public.${t}` in contrato).sort();
    const lacunas = medidas.length - curadas.length;
    const lista = () => [...medidas].sort().join(', ');

    // CURADO vem ANTES de MUDOU quando os dois valem: se o grupo inteiro foi curado, renovar a
    // contagem é a correção errada — a entrada tem de sair. O guard `medidas.length > 0` é o que
    // impede a inversão perigosa: uma medição que volta VAZIA também tem `lacunas === 0`, e
    // diagnosticá-la como "grupo curado" convidaria a apagar a declaração por causa de uma query
    // quebrada. Lista vazia cai no MUDOU abaixo, que é o diagnóstico honesto.
    if (medidas.length > 0 && lacunas === 0) {
      out.push({
        level: 'error',
        codigo: 'LACUNA_GRUPO_CURADO',
        objeto: rot,
        msg:
          `${rot}: as ${medidas.length} tabela(s) do grupo estão TODAS em AUTHZ_RLS_ESPERADO — o ` +
          `grupo deixou de ser lacuna e a declaração passou a mentir na direção que finge NÃO ` +
          `cobrir. REMOVA a entrada de LACUNAS_POR_GRUPO (não renove a contagem). Tabelas: ` +
          `${lista()}.`,
      });
      continue;
    }
    if (medidas.length !== g.tabelasNoGrafo) {
      const dir = medidas.length > g.tabelasNoGrafo ? 'CRESCEU' : 'ENCOLHEU';
      out.push({
        level: 'error',
        codigo: 'LACUNA_GRUPO_MUDOU',
        objeto: rot,
        msg:
          `${rot}: o grupo ${dir} — ${medidas.length} tabela(s) em prod contra ` +
          `${g.tabelasNoGrafo} declarada(s) (medido em ${g.medidoEm}). ` +
          `${curadas.length} curada(s), ${lacunas} lacuna(s) hoje. A declaração de não-cobertura ` +
          `virou falsa: ou uma migration gateou/renomeou tabela no grupo, ou o grupo sumiu. ` +
          `Confira se as novas merecem entrar no contrato pelo critério do cabeçalho ANTES de ` +
          `renovar \`tabelasNoGrafo\` (e a data). Tabelas hoje: ${lista()}.`,
      });
      continue;
    }
    // Contagem bate. Falta a SUBSTITUIÇÃO: uma sai, outra entra, e o total não se move — a mesma
    // classe de "duas mudanças opostas se cancelam" que fez a declaração guardar o TOTAL em vez
    // do número de lacunas. O md5 da lista ordenada é o que fecha isso.
    const md5Med = md5Lista(medidas);
    if (md5Med !== g.tabelasMd5) {
      out.push({
        level: 'error',
        codigo: 'LACUNA_GRUPO_MUDOU',
        objeto: rot,
        msg:
          `${rot}: a CONTAGEM bate (${medidas.length}) e o CONJUNTO não — md5 ${md5Med} contra ` +
          `${g.tabelasMd5} declarado (medido em ${g.medidoEm}). Houve substituição: uma tabela ` +
          `saiu do grupo e outra entrou no mesmo intervalo, e só a contagem não veria. Tabelas ` +
          `hoje: ${lista()}.`,
      });
    }
  }

  return out;
}
