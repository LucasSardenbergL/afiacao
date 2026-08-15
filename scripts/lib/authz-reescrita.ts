/**
 * authz-reescrita.ts — detector do padrão que a Parte A do `authz:check` NÃO enxerga.
 * ============================================================================================
 *
 * O PONTO CEGO (medido 2026-08-14, follow-up do §7.4 item 2 de
 * docs/historico/sentinela-authz-controle-nao-mencao.md): a Parte A é last-writer por função
 * sobre o TEXTO das migrations e procura `CREATE [OR REPLACE] FUNCTION`. Uma migration pode
 * recriar uma função **sem escrever nenhum CREATE**: lê a definição VIVA com
 * `pg_get_functiondef()`, aplica `regexp_replace`/`replace` e a devolve por `EXECUTE`. O parser
 * não vê nada, então o "last-writer" que a Parte A mede **não é a última definição**.
 *
 * Não é hipótese e não é acidente isolado — é o IDIOMA que o repo usa para troca cirúrgica
 * (preserva SECURITY DEFINER, STABLE, `SET search_path`, o gate e o ACL, que um corpo colado
 * perderia). **23 das 648 migrations** usam o padrão; 5 delas são as próprias migrations de
 * authz que INJETARAM os gates `cap_custo_ler`/`cap_compras_ler`.
 *
 * A MEDIÇÃO QUE JUSTIFICA ESTE ARQUIVO (psql-ro, 19 funções do AUTHZ_MANIFEST, corpo vivo de
 * prod vs. last-writer do repo): **3 divergem** — `get_preco_cockpit`, `get_defasagem_cliente`
 * e `reposicao_pos_candidatos` — e são **exatamente** as 3 que este detector aponta. Precisão e
 * recall 3/3 contra um oráculo independente (md5 do corpo). Em prod, `get_preco_cockpit` já não
 * CHAMA `pode_ver_carteira_completa` (o manifest ainda a lista como alternativa aceitável e o
 * corpo do repo ainda a chama): o CI está verde medindo uma cláusula que prod não tem mais.
 *
 * Por que este detector é de TEXTO e não tenta simular a reescrita: simular `regexp_replace` do
 * Postgres em JS produziria um corpo que ninguém executou — heurística sobre heurística, e o
 * verde resultante afirmaria cobertura inexistente (o erro que o cabeçalho de authz-contract.ts
 * adverte). O que este arquivo entrega é honesto e verificável: **saber que a Parte A não está
 * medindo a última definição**, e nomear o arquivo e a função. A prova do corpo que roda é
 * EXECUTADA (harness PG17) ou o audit read-only de prod (`bun run authz:audit:prod`).
 */
import { balancedParens } from './migration-objects';
import { stripComments } from './authz-contract';

export interface ReescritaViva {
  /** a migration recria alguma função reescrevendo a definição VIVA (invisível ao parser de CREATE) */
  detectada: boolean;
  /** alvos `schema.nome` — do literal de assinatura quando há, senão TODOS os do arquivo (fail-closed) */
  alvos: string[];
  /** o argumento de `pg_get_functiondef` não é literal (variável, `r.oid`, loop sobre `pg_proc`) */
  indeterminado: boolean;
}

/** literal de assinatura de função: `'public.f(text)'` (schema opcional → default `public`) */
const RE_ASSINATURA = /'(?:([a-z_]\w*)\.)?([a-z_]\w*)\s*\(([^')]*)\)'/gi;
/**
 * literal de NOME puro: `'get_tint_price'`. É como a FU4-F escolhe alvos em lote
 * (`WHERE n.nspname='public' AND p.proname IN ('a','b')`), sem assinatura nenhuma. Colher isto
 * só faz sentido no ramo indeterminado, e o ruído (`'employee'`, `'public'`, `'g'`) morre no
 * cruzamento com o AUTHZ_MANIFEST, que é quem decide se o alvo importa.
 */
const RE_NOME_PURO = /'([a-z_]\w{2,})'/gi;
/**
 * `EXECUTE <expr>` dinâmico. Exclui o `EXECUTE FUNCTION/PROCEDURE` de `CREATE TRIGGER` e o
 * `EXECUTE ON` de `GRANT/REVOKE EXECUTE ON FUNCTION` — os dois convivem com o padrão no mesmo
 * arquivo (a 20260814022626 tem os três) e não recriam nada.
 */
const RE_EXECUTE = /\bEXECUTE\s+(?!(?:FUNCTION|PROCEDURE|ON)\b)([^;]{0,400})/gi;
/**
 * `<var> [constant] [tipo] := <rhs>` — a atribuição PL/pgSQL, em DECLARE ou no corpo.
 *
 * A âncora inicial NÃO é decoração: sem ela o trecho antes do `:=` casava a partir de qualquer
 * palavra ao alcance e o nome capturado era o ERRADO — `DO $rpc$\nDECLARE\n  v_def text :=
 * pg_get_functiondef(…)` registrava a variável como `do`, e a 20260814022626 (o caso que motivou
 * este arquivo) escapava do próprio detector.
 *
 * `DECLARE`/`BEGIN` entram como delimitador junto de `;` e da quebra de linha porque
 * `DECLARE v_def text := …` na MESMA linha é SQL válido e capturava `DECLARE` como nome da
 * variável — a migration inteira escapava do detector. Falha ABERTA, e num detector de
 * autorização esse é o pior desfecho; pegou no teste da Parte D, não em produção.
 * O nome é a PRIMEIRA palavra do grupo; o resto é o tipo opcional.
 */
const RE_ATRIBUICAO =
  /(?:^|[;\n]|\b(?:declare|begin)\b)([ \t]*\w[\w."]*(?:[ \t]+(?:constant[ \t]+)?[\w."]+(?:[ \t]*\([^)]*\))?(?:\[\])?)?[ \t]*):=\s*([^;]{0,800})/gi;

function nomesDeAssinatura(texto: string): string[] {
  const out: string[] = [];
  RE_ASSINATURA.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ASSINATURA.exec(texto)) !== null) {
    out.push(`${(m[1] ?? 'public').toLowerCase()}.${m[2].toLowerCase()}`);
  }
  return out;
}

/**
 * Detecta a recriação por reescrita da definição viva e resolve o(s) alvo(s).
 *
 * O laço `EXECUTE ← definição viva` é seguido por data-flow de 2 níveis sobre as atribuições
 * PL/pgSQL, porque é isso que as migrations reais escrevem: `v_def := pg_get_functiondef(…)`,
 * depois `v_novo := regexp_replace(v_def, …)`, e só então `EXECUTE v_novo`. Sem seguir a
 * variável, a alternativa seria "tem `pg_get_functiondef` e tem `EXECUTE` em algum lugar" — e
 * isso marcaria toda migration que apenas ASSERTA sobre a definição viva (a maioria das 82 que
 * mencionam a função). Ruído demais e o detector seria desligado.
 */
export function detectarReescritaViva(sqlRaw: string): ReescritaViva {
  const sql = stripComments(sqlRaw); // comentário não recria função (mesma regra do parser de gate)
  const vazio: ReescritaViva = { detectada: false, alvos: [], indeterminado: false };
  if (!/pg_get_functiondef\s*\(/i.test(sql)) return vazio;

  // (1) variáveis que carregam a definição viva, e o fecho transitivo das derivadas dela.
  const atribuicoes: Array<{ nome: string; rhs: string }> = [];
  RE_ATRIBUICAO.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = RE_ATRIBUICAO.exec(sql)) !== null) {
    const nome = /^\s*([\w."]+)/.exec(a[1])?.[1];
    if (nome) atribuicoes.push({ nome: nome.toLowerCase(), rhs: a[2] });
  }

  const carregaDef = new Set<string>();
  for (let volta = 0; volta < 5; volta++) {
    const antes = carregaDef.size;
    for (const { nome, rhs } of atribuicoes) {
      const r = rhs.toLowerCase();
      if (/pg_get_functiondef\s*\(/.test(r) || [...carregaDef].some((v) => new RegExp(`\\b${v}\\b`).test(r))) {
        carregaDef.add(nome);
      }
    }
    if (carregaDef.size === antes) break;
  }

  // (2) algum EXECUTE dinâmico recebe a definição viva (direta ou por variável)?
  let detectada = false;
  RE_EXECUTE.lastIndex = 0;
  let e: RegExpExecArray | null;
  while ((e = RE_EXECUTE.exec(sql)) !== null) {
    const alvo = e[1].toLowerCase();
    if (/pg_get_functiondef\s*\(/.test(alvo) || [...carregaDef].some((v) => new RegExp(`\\b${v}\\b`).test(alvo))) {
      detectada = true;
      break;
    }
  }
  if (!detectada) return vazio;

  // (3) resolver o alvo. Literal DENTRO do argumento de pg_get_functiondef = alta confiança;
  //     senão indeterminado → colhe TODAS as assinaturas literais do arquivo (fail-closed:
  //     pode sobrar alvo, nunca faltar).
  const diretos = new Set<string>();
  let indeterminado = false;
  const re = /pg_get_functiondef\s*\(/gi;
  let d: RegExpExecArray | null;
  while ((d = re.exec(sql)) !== null) {
    const arg = balancedParens(sql, d.index + d[0].length - 1);
    const nomes = nomesDeAssinatura(arg);
    if (nomes.length > 0) nomes.forEach((n) => diretos.add(n));
    else indeterminado = true;
  }

  if (!indeterminado) return { detectada: true, alvos: [...diretos].sort(), indeterminado: false };

  // indeterminado: colhe TODO literal do arquivo que possa nomear função — com assinatura ou
  // sem. Fail-closed: pode sobrar alvo (o manifest filtra), nunca faltar.
  const inferidos = new Set([...diretos, ...nomesDeAssinatura(sql)]);
  RE_NOME_PURO.lastIndex = 0;
  let n: RegExpExecArray | null;
  while ((n = RE_NOME_PURO.exec(sql)) !== null) inferidos.add(`public.${n[1].toLowerCase()}`);
  return { detectada: true, alvos: [...inferidos].sort(), indeterminado: true };
}
