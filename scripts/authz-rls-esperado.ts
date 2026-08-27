/**
 * authz-rls-esperado.ts — contrato CURADO da RLS viva das tabelas money-path / raiz-da-autz.
 * ============================================================================================
 *
 * O PONTO CEGO que este contrato existe para fechar. Os três audits de prod que existiam antes
 * (`authz:funcoes:prod`, `authz:grants:prod`, `authz:audit:prod`) cobrem EXECUTE de função, grant
 * de TABELA e o gate no corpo vivo das RPCs. Nenhum deles lê `pg_class.relrowsecurity`,
 * `relforcerowsecurity` ou `pg_policy` — logo um `ALTER TABLE … DISABLE ROW LEVEL SECURITY` ou uma
 * policy criada/alterada à mão no SQL Editor do Lovable sai VERDE em todos eles. O gate estático
 * do CI (`scripts/lib/authz-grants.ts`, código `RLS_OFF`) pega o DISABLE **escrito numa migration**
 * e **só nas 3 tabelas** de `AUTHZ_TABELAS_FECHADAS`; o vetor que sobra é justamente o que não
 * passa por migration nenhuma, que é o modo normal de operar este banco (database.md §1).
 *
 * ═══ POR QUE ESTE ARQUIVO É UMA ALLOWLIST, E O QUE FICA DE FORA DELA ═══
 *
 * Reconciliar as 335 tabelas de `public` policy-a-policy produziria 701 policies de ruído — e
 * relatório que ninguém lê é sentinela desligada. Mas a decisão de escopo NÃO é "curar tudo":
 * o audit tem DOIS eixos, com escopos deliberadamente diferentes, porque o custo de ruído deles
 * é diferente.
 *
 *   · EIXO UNIVERSAL — o INTERRUPTOR (`relrowsecurity`). NÃO usa esta allowlist: vale para toda
 *     tabela de `public`. É barato porque o estado esperado é o MESMO para todas (ligada) e não
 *     cresce com migration nova ("tabela nova sempre com RLS", CLAUDE.md). Medido em prod
 *     2026-08-27 via psql-ro: **335 tabelas, 335 com RLS ligada, 0 desligada, 0 com FORCE**. O
 *     veredito sai como CONTAGEM de violações ("0 tabelas com RLS desligada"), nunca como o total
 *     congelado — congelar 335 faria a sentinela gritar à toa a cada migration e ser desligada
 *     (é a mesma escolha da sentinela do `claude_ro`, database.md §1).
 *
 *   · EIXO CURADO — o CONTEÚDO (`pg_policy`). É este arquivo. Aqui cada entrada é uma MEDIÇÃO
 *     (psql-ro, 2026-08-27), não um palpite: os md5 abaixo foram lidos de produção, não escritos
 *     à mão. Critério de entrada, explícito para que a lista não vire depósito: **a RLS da tabela
 *     é a única ou a principal barreira entre um `authenticated` qualquer e (i) dinheiro,
 *     (ii) custo/preço, ou (iii) a raiz da autorização.**
 *
 * O que fica FORA por decisão consciente: as ~328 tabelas restantes com policy. Elas seguem
 * cobertas pelo eixo universal (ninguém desliga a RLS delas em silêncio), mas o CONTEÚDO das
 * policies delas não é reconciliado. Isso é lacuna declarada, não cobertura implícita — e a regra
 * do repo é que contrato falso é pior que lacuna.
 *
 * ═══ A REPRESENTAÇÃO, E O QUE ELA NÃO PEGA ═══
 *
 * `qual`/`with_check` são EXPRESSÕES. Guardá-las como texto e comparar string é frágil, então o
 * contrato guarda o **md5 do `pg_get_expr` normalizado** — exatamente o padrão já usado em
 * `AUTHZ_REESCRITAS_CONHECIDAS.md5ProdEsperado`:
 *
 *     md5(regexp_replace(btrim(pg_get_expr(polqual, polrelid)), '\s+', ' ', 'g'))
 *
 * `pg_get_expr` NORMALIZA de volta a partir da árvore de parse (o `SELECT x` vira ` SELECT x AS
 * alias`), então o md5 é estável a whitespace e a parênteses redundantes do DDL original. Em
 * troca ele MUDA em renomeação de coluna ou de função — falso-positivo CONSERVADOR, que é a
 * direção certa: o audit acusa e um humano lê.
 *
 * 🔴 O que o md5 da expressão explicitamente NÃO pega, e é o motivo do terceiro bloco deste
 * arquivo: **mudança no CORPO de uma função que a policy CHAMA.** Reescrever
 * `private.cap_pedido_escrever` para `SELECT true` no SQL Editor deixa o texto do `qual`
 * IDÊNTICO — o md5 não se move, e a RLS de `sales_orders` passa a autorizar qualquer
 * autenticado. Medido: **nenhuma** das funções-predicado (`has_role`, `cap_custo_ler`,
 * `cap_pedido_escrever`, `fin_user_can_access`) está no `AUTHZ_MANIFEST`, que cobre RPCs de
 * money-path e não predicados de RLS — logo o `authz:audit:prod` também não as vê. Por isso
 * `AUTHZ_RLS_PREDICADOS` congela o md5 do `prosrc` delas.
 *
 * Os demais limites (bypass por `service_role`, SECDEF, view `invoker=off`, ACL por coluna, o
 * alcance de UM nível do `pg_depend`) estão em `scripts/lib/authz-rls.ts`, no cabeçalho do
 * comparador, junto do código que os produz.
 */

/** `pg_policy.polcmd`: `r`=SELECT · `a`=INSERT · `w`=UPDATE · `d`=DELETE · `*`=ALL. */
export type PolCmd = 'r' | 'a' | 'w' | 'd' | '*';

export interface PolicyEsperada {
  cmd: PolCmd;
  /** `false` = RESTRICTIVE (soma por AND). Trocar PERMISSIVE↔RESTRICTIVE muda a álgebra inteira. */
  permissiva: boolean;
  /** roles do `polroles`, ordenadas por `rolname`. `['PUBLIC']` = `polroles = {0}`. */
  roles: string[];
  /** md5 do `pg_get_expr(polqual)` normalizado. `null` = policy sem `USING` (INSERT puro). */
  qualMd5: string | null;
  /** md5 do `pg_get_expr(polwithcheck)` normalizado. `null` = sem `WITH CHECK` (o PG usa o USING). */
  withCheckMd5: string | null;
  motivo: string;
}

export interface TabelaRls {
  /** `relforcerowsecurity`. Hoje `false` em todas — o owner (`postgres`) segue bypassando.
   *  Está no contrato porque ligá-lo é mudança de segurança real e hoje não é medida por ninguém. */
  forceRls: boolean;
  /** Conjunto EXATO. Policy em prod fora daqui é `POLICY_NOVA`; entrada sem par em prod é
   *  `POLICY_SUMIU`. Allowlist fail-closed: o silêncio nunca é aprovação. */
  policies: Record<string, PolicyEsperada>;
  /** Escape do check estrutural `FOR ALL` com `USING` ≠ `WITH CHECK` (database.md §4: o DELETE só
   *  consulta o `USING`). Ausente = a assimetria é ERRO. Hoje nenhuma entrada precisa dele. */
  forAllAssimetricoOk?: string;
  motivo: string;
}

/**
 * Estado medido em prod (psql-ro, 2026-08-27; PG 17.6). 7 tabelas · 19 policies.
 *
 * ⚠️ Os md5 se REPETEM entre tabelas quando o predicado é literalmente o mesmo texto — p.ex.
 * `8ddd30b6…` é `has_role(auth.uid(), 'master'::app_role)` em `profiles` E em `user_roles`. O md5
 * é da EXPRESSÃO, não do par (tabela, policy); a comparação é que é por tabela+policy.
 */
export const AUTHZ_RLS_ESPERADO: Record<string, TabelaRls> = {
  // ── raiz da autorização ────────────────────────────────────────────────────────────────────
  'public.user_roles': {
    forceRls: false,
    motivo:
      'A RAIZ: `public.has_role` (o predicado de quase toda policy staff do banco, e o gate de ' +
      'quase toda RPC do AUTHZ_MANIFEST) é um SELECT nesta tabela. Uma policy de escrita afrouxada ' +
      'aqui não vaza dado — CONCEDE master, e com master vem todo o money-path de uma vez. Já houve ' +
      'um caminho de escalação por esta porta (o trigger auto_assign_user_role dava master a quem ' +
      'soubesse o CNPJ público — database.md §4); desde então master é provisionamento MANUAL, e o ' +
      'que sustenta isso em prod é exatamente a policy `Only admins can manage roles`.',
    policies: {
      'Only admins can manage roles': {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        withCheckMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        motivo:
          '`has_role(auth.uid(),master)` nos DOIS lados. É um FOR ALL, a forma que o §4 do ' +
          'database.md marca como latente — mas aqui `USING` e `WITH CHECK` são o MESMO md5, então ' +
          'a armadilha do DELETE (que só consulta o USING) não está armada. O check estrutural ' +
          'FOR_ALL_ASSIMETRICO existe para acusar o dia em que alguém apertar só um dos lados.',
      },
      'Admins and employees can view all roles': {
        cmd: 'r',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '45ad0946ce322aefa63a18a15417ba0c',
        withCheckMd5: null,
        motivo: 'leitura broad-staff (`master OR employee`) — assimetria leitura>escrita do §4.',
      },
      'Users can view their own roles': {
        cmd: 'r',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '19300d155780585259ede73ac370586c',
        withCheckMd5: null,
        motivo: '`auth.uid() = user_id` — o próprio usuário lê o próprio papel (o front usa no boot).',
      },
    },
  },

  // ── money-path ─────────────────────────────────────────────────────────────────────────────
  'public.sales_orders': {
    forceRls: false,
    motivo:
      'pedido de venda — money-path. É a tabela cujo desenho de RLS custou mais caro no repo: o ' +
      'BFLA foi fechado pelo eixo do VERBO em 20260724120000 (#1477/FU4), trocando um `FOR ALL` ' +
      'amplo por UMA policy POR COMANDO. Esse split é precisamente o que um `CREATE POLICY … FOR ' +
      'ALL` colado à mão desfaz em uma linha, sem migration e sem alarme — as 4 entradas por ' +
      'comando abaixo são o que trava a volta. Também já está em AUTHZ_TABELAS_FECHADAS (grants), ' +
      'e as duas guardas medem eixos distintos: lá o privilégio, aqui a policy.',
    policies: {
      sales_orders_select_staff: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'f2dd33660218e1da7dce99434b09d5b9',
        withCheckMd5: null,
        motivo: '`master OR employee`, cada disjunto envolto em `(SELECT …)` — o wrap de InitPlan do §4.',
      },
      sales_orders_select_customer: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '201fd043b6445e361f172fb493c8b45b',
        withCheckMd5: null,
        motivo: '`auth.uid() = customer_user_id` — o cliente vê o próprio pedido no self-service.',
      },
      sales_orders_insert_staff: {
        cmd: 'a',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: null,
        withCheckMd5: '83f2bf73643847d941f1c3c152f58c59',
        motivo:
          'INSERT só tem `WITH CHECK` (`cap_pedido_escrever`) — `qualMd5: null` é a FORMA CORRETA ' +
          'aqui, não dado faltando. Preenchê-lo seria a divergência.',
      },
      sales_orders_update_staff: {
        cmd: 'w',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '83f2bf73643847d941f1c3c152f58c59',
        withCheckMd5: '83f2bf73643847d941f1c3c152f58c59',
        motivo: '`cap_pedido_escrever` dos dois lados — a linha velha e a nova sob a mesma capability.',
      },
      sales_orders_delete_staff: {
        cmd: 'd',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'a84d175983edc38753cc370b5deba57a',
        withCheckMd5: null,
        motivo:
          '`cap_pedido_escrever AND omie_pedido_id IS NULL AND status IN (orcamento,rascunho)` — a ' +
          'capability de ESCRITA no `USING` do DELETE, que é onde o §4 diz que ela tem de estar. ' +
          '⚠️ O predicado de ESTADO é contornável por quem controla o estado (PATCH → DELETE, 2 ' +
          'requests); quem fecha isso é o grant de COLUNA, medido pelo `authz:grants:prod`, não aqui.',
      },
    },
  },
  'public.fin_contas_receber': {
    forceRls: false,
    motivo:
      'contas a receber — money-path direto (DSO/funding, docs/agent/financeiro.md). O gate é ' +
      '`fin_user_can_access(company)`, SECDEF fail-closed (`auth.uid() IS NULL` ⇒ false): o §4 ' +
      'registra que uma varredura de "policy sem has_role/auth.uid ⇒ não restringe por identidade" ' +
      'classifica esta policy como aberta — ela não é, o gate mora dentro da função. É por isso que ' +
      'o md5 do PREDICADO (bloco AUTHZ_RLS_PREDICADOS) importa mais aqui do que em qualquer outra.',
    policies: {
      fin_cr_select: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'c164ff4089eb3d87bd1ca44523f8a4e9',
        withCheckMd5: null,
        motivo: '`fin_user_can_access(company)` — recorte por empresa (as 3 do grupo, mapa-do-app.md).',
      },
      fin_cr_service: {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'ea849457c1a771a3ea5e4fe3c0210590',
        withCheckMd5: null,
        motivo:
          '`auth.role() = service_role` — o FOR ALL das engines de sync. Sem `WITH CHECK` próprio, ' +
          'então o PG reusa o `USING`: simétrico por construção, o oposto do hazard do §4.',
      },
    },
  },

  // ── custo / preço (confidencialidade comercial) ────────────────────────────────────────────
  'public.product_costs': {
    forceRls: false,
    motivo:
      'custo unitário. Fechada por privilégio no PR #1520 (FU4-F fase 3) e vigiada pelo ' +
      '`authz:grants:prod` — mas o grant fechado só decide QUEM alcança a tabela; quem decide o ' +
      'que ele LÊ é esta policy. Com o grant de SELECT que `authenticated` legitimamente tem, ' +
      'afrouxar o `USING` aqui abre o custo para toda a força de vendas.',
    policies: {
      product_costs_select_custo: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'eaca1331bdedc42dcab7ab61e8ff3814',
        withCheckMd5: null,
        motivo:
          '`private.cap_custo_ler(auth.uid())` — master OU (employee E commercial_role em ' +
          'estrategico/super_admin). Sem policy de escrita, por desenho: só service_role escreve.',
      },
    },
  },
  'public.omie_products': {
    forceRls: false,
    motivo:
      'preço de tabela (`valor_unitario`). Fechada pelo PR #1558 e aplicada — é a única das três ' +
      'de AUTHZ_TABELAS_FECHADAS cuja âncora está confirmada em prod. Uma policy só, de leitura.',
    policies: {
      omie_products_select_staff: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'c5fa3f201d742194eafb0bccf62977f7',
        withCheckMd5: null,
        motivo:
          '`master OR employee` com wrap de InitPlan. SEM policy de escrita, por desenho — nem ' +
          'employee nem master escrevem via API; escrita é exclusiva das edges de sync do Omie.',
      },
    },
  },
  'public.tint_formulas': {
    forceRls: false,
    motivo:
      'fórmulas tintométricas — 950k linhas, o ativo de conhecimento do tintométrico ' +
      '(docs/agent/tintometrico.md). Entra pelo eixo (ii): a receita É custo/IP. Foi ela que gerou ' +
      'a lição de InitPlan em policy (13,4s→<1s, migration 20260627150000), então o md5 do `qual` ' +
      'aqui também guarda o formato que sustenta a PERFORMANCE — perder o wrap `(SELECT …)` não ' +
      'abre autorização, mas derruba a tela, e o audit acusa a mudança do mesmo jeito.',
    policies: {
      'Staff can manage tint_formulas': {
        cmd: '*',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'c5fa3f201d742194eafb0bccf62977f7',
        withCheckMd5: 'c5fa3f201d742194eafb0bccf62977f7',
        motivo:
          'FOR ALL `master OR employee`, simétrico (mesmo md5 nos dois lados). É o mesmo texto de ' +
          'predicado de `omie_products_select_staff` — daí o md5 repetido.',
      },
    },
  },

  // ── cadastro-base + aprovação ──────────────────────────────────────────────────────────────
  'public.profiles': {
    forceRls: false,
    motivo:
      'cadastro do usuário e `is_approved`/`is_employee` — o eixo (iii) por um caminho indireto: ' +
      'não concede papel, mas alimenta o gate de aprovação do customer e carrega o `is_employee`. ' +
      'A policy `Users can insert own profile` é auto-inserção por qualquer autenticado (foi o ' +
      'degrau do caminho de escalação do §4), e hoje o que a segura é o `WITH CHECK` incluir ' +
      '`is_employee = false`. É broad-staff na leitura POR DECISÃO MEDIDA de 2026-07-20 (o vendedor ' +
      'precisa achar qualquer cliente) — não redescubra isso como achado.',
    policies: {
      'Users can insert own profile': {
        cmd: 'a',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: null,
        withCheckMd5: '560ad673fa4edb8fb4237ccf5534df87',
        motivo:
          '`auth.uid() = user_id AND is_employee = false` — o `AND is_employee = false` é a trava ' +
          'contra auto-promoção; se este md5 mudar, leia o novo predicado ANTES de renovar a linha.',
      },
      'Users can update own profile': {
        cmd: 'w',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '19300d155780585259ede73ac370586c',
        withCheckMd5: '560ad673fa4edb8fb4237ccf5534df87',
        motivo:
          'assimetria DELIBERADA e correta: o `USING` acha a própria linha, o `WITH CHECK` proíbe ' +
          'gravá-la com `is_employee = true`. Não é `FOR ALL`, então o check estrutural não a toca.',
      },
      'Users can view their own profile': {
        cmd: 'r',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '19300d155780585259ede73ac370586c',
        withCheckMd5: null,
        motivo: '`auth.uid() = user_id`.',
      },
      'Employees can view all profiles': {
        cmd: 'r',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '45ad0946ce322aefa63a18a15417ba0c',
        withCheckMd5: null,
        motivo: 'broad-staff de LEITURA — a decisão medida de 2026-07-20 (4 grants, 3 pessoas).',
      },
      'Admins can update any profile': {
        cmd: 'w',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        withCheckMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        motivo: '`has_role(master)` nos dois lados — é por aqui que a aprovação de customer é dada.',
      },
      'Admins can delete profiles': {
        cmd: 'd',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        withCheckMd5: null,
        motivo: '`has_role(master)` no `USING`, que é o lado que o DELETE consulta.',
      },
    },
  },
};

export interface PredicadoEsperado {
  /** `prosecdef`. Todas as 4 são SECDEF: é o que faz o predicado enxergar `user_roles`/
   *  `commercial_roles` sem depender da RLS delas. Perder o SECDEF quebra a autorização por
   *  BAIXO — a policy continua idêntica e passa a devolver `false` para todo mundo. */
  secdef: boolean;
  /** `proconfig` juntado por vírgula. `search_path=public` preso é o que impede sequestro de
   *  resolução de nome numa função que roda como owner. String vazia = sem `SET`. */
  cfg: string;
  /** md5 do `prosrc` normalizado (`regexp_replace(btrim(prosrc), '\s+', ' ', 'g')`) — a mesma
   *  receita de `AUTHZ_REESCRITAS_CONHECIDAS.md5ProdEsperado`, para que as duas guardas falem a
   *  mesma língua e um md5 possa ser conferido à mão com a mesma query. */
  srcMd5: string;
  motivo: string;
}

/**
 * As funções que as policies curadas CHAMAM — descobertas por `pg_depend`, não por parse de texto
 * (o catálogo registra a dependência policy→função; ler o texto do `qual` com regex erraria em
 * `cap_custo_ler` chamada dentro de um `COALESCE`, e o §4 tem o registro de duas varreduras
 * textuais que produziram falso-positivo integral).
 *
 * Medido em prod 2026-08-27: as 19 policies referenciam 6 funções — estas 4 mais `auth.uid` e
 * `auth.role`, que ficam em `PREDICADOS_PLATAFORMA`.
 */
export const AUTHZ_RLS_PREDICADOS: Record<string, PredicadoEsperado> = {
  'public.has_role': {
    secdef: true,
    cfg: 'search_path=public',
    srcMd5: '6e1a80057b49adba3fef73eca09f59d4',
    motivo:
      '`SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)`. ' +
      '91 caracteres dos quais depende a autorização inteira do produto: é o predicado de 8 das 19 ' +
      'policies curadas, e o gate de 40+ RPCs. SECDEF de propósito — é o que permite responder ' +
      'sobre `user_roles` sem que o caller precise de RLS que o deixe ler a tabela.',
  },
  'private.cap_pedido_escrever': {
    secdef: true,
    cfg: 'search_path=public',
    srcMd5: '8c9d0cdb0318b9c61cd608e7659f58d5',
    motivo:
      '`COALESCE(_uid IS NOT NULL AND (has_role(master) OR has_role(employee)), false)` — a ' +
      'capability de escrita das 3 policies IUD de `sales_orders`. O `COALESCE(…, false)` é o ' +
      'null-hardening: sem ele, `_uid` nulo devolveria NULL, que a RLS trata como falso mas o ' +
      'código chamador não.',
  },
  'private.cap_custo_ler': {
    secdef: true,
    cfg: 'search_path=public',
    srcMd5: 'cdfb90910980bc2ac059c493d76662bb',
    motivo:
      'master OU (employee E `commercial_roles` em estrategico/super_admin) — o único predicado ' +
      'curado que lê uma SEGUNDA tabela (`commercial_roles`). Quem entra lá vê custo; a RLS de ' +
      '`commercial_roles` NÃO é o que protege isso (a função é SECDEF e a bypassa), o que protege ' +
      'é quem tem INSERT nela.',
  },
  'public.fin_user_can_access': {
    secdef: true,
    cfg: 'search_path=public',
    srcMd5: '6599d0b9836c35f9f4836ae18bb6f336',
    motivo:
      'recorte por empresa de `fin_contas_receber`. Fail-closed em `auth.uid() IS NULL`. É o caso ' +
      'em que o md5 do PREDICADO carrega quase toda a autorização: o `qual` da policy é só ' +
      '`fin_user_can_access(company)`, e ler o texto da policy não diz nada sobre quem passa.',
  },
};

/**
 * Funções-predicado da PLATAFORMA — enumeradas, mas com o corpo deliberadamente NÃO congelado.
 *
 * `auth.uid()`/`auth.role()` são do Supabase e mudam em upgrade de plataforma, sem aviso e sem
 * nada que possamos fazer a respeito. Congelar o md5 delas produziria um vermelho periódico cuja
 * única resolução possível é "renove a baseline" — e sentinela que só sabe pedir renovação é
 * treino para ignorar a sentinela. Ficam aqui para que apareçam como CONHECIDAS: uma função-
 * predicado que não esteja nem em `AUTHZ_RLS_PREDICADOS` nem neste conjunto é
 * `PREDICADO_NAO_DECLARADO` (erro), inclusive uma `auth.*` nova.
 */
export const PREDICADOS_PLATAFORMA: ReadonlySet<string> = new Set(['auth.uid', 'auth.role']);
