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
 * Como o critério é aplicado (2ª rodada, 2026-08-27 — 7 → 17 tabelas, 19 → 38 policies;
 * 3ª rodada, 2026-08-28 — 17 → 20 tabelas, 38 → 50 policies, 5 → 8 predicados). O
 * critério acima tem três membros e eles NÃO se aplicam do mesmo jeito, porque a alavanca é
 * diferente:
 *
 *   · membro (iii), RAIZ — entra sempre, e a tabela estar VAZIA é irrelevante. O poder de uma raiz
 *     é estrutural: uma única linha concede. `fin_permissoes` tem 0 linhas hoje e entra mesmo
 *     assim, porque o que o contrato guarda ali é a FORMA (nenhuma policy de escrita para
 *     `authenticated`) — o alarme é o dia em que a policy de escrita aparecer.
 *   · membros (i)/(ii), DINHEIRO e CUSTO/PREÇO — entra a tabela que guarda o NÚMERO na fonte, com
 *     linha em prod. Fica de fora o agregado, o log e o config cuja fonte já está congelada: se
 *     `product_costs`/`cmc_*`/`order_items` estão no contrato e o gate deles também, o log
 *     derivado acrescenta pouco alarme e muito ruído. Tabela vazia por (i)/(ii) não entra — não há
 *     número para vazar hoje —, e o gatilho de reentrada é ter linha.
 *
 * ═══ LACUNAS DECLARADAS ═══
 *
 * Contrato falso é pior que lacuna; lacuna anônima é quase tão ruim. O que foi medido e RECUSADO
 * não vive nesta prosa — vive em `LACUNAS_DECLARADAS`, logo abaixo do contrato, como DADO com uma
 * razão por tabela. A diferença não é estética: enquanto era prosa, uma rodada seguinte curou três
 * das tabelas que este cabeçalho declarava como lacuna e o texto continuou afirmando o contrário,
 * sem nada ficar vermelho (§7.1 do histórico). Agora um teste cruza as duas listas.
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
 * Estado medido em prod (psql-ro, 2026-08-27 + 2026-08-28; PG 17.6). 20 tabelas · 50 policies
 * (1ª rodada: 7 · 19; 2ª: +10 · +19; 3ª: +3 · +12 — cada rodada marcada pelos separadores abaixo).
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
        motivo:
          '`auth.uid() = user_id` — o autoatendimento: cada um lê o próprio cadastro. Alargá-lo '  +
          'para `true` não concede papel nenhum, mas entrega os 5.668 profiles (94% com e-mail, '  +
          '95% com telefone) a qualquer autenticado. Mesmo md5 do `Staff can view own commercial '  +
          'role`, que é o mesmo texto.',
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
  // ── raiz da autorização (2ª rodada de curadoria, medida em prod 2026-08-27) ─────────────────
  'public.commercial_roles': {
    forceRls: false,
    motivo:
      'A SEGUNDA raiz, e a que o próprio motivo de `private.cap_custo_ler` já apontava sem cobrir: ' +
      '“quem entra lá vê custo … o que protege é quem tem INSERT nela”. Medido por `pg_depend` + ' +
      'leitura do `prosrc`: três funções SECDEF fazem `EXISTS (SELECT 1 FROM public.commercial_roles …)` ' +
      '— `cap_custo_ler` (gate de 8 policies de custo), `cap_carteira_ler` (gate de 22 tabelas de ' +
      'inteligência comercial) e `is_super_admin` — e a policy de leitura de `margin_audit_log` lê a ' +
      'tabela DIRETO. Como as três são SECDEF, elas bypassam a RLS desta tabela na LEITURA; o que ' +
      'sobra de barreira é exatamente a ESCRITA, que é policy — e é isto que o contrato congela. ' +
      'Uma linha `(self, estrategico)` inserida aqui concede custo; `(self, super_admin)` concede ' +
      'custo + carteira + o direito de conceder de novo. 3 linhas em prod (bate com as “3 pessoas” ' +
      'da decisão de 2026-07-20, database.md §4).',
    policies: {
      'Admins can manage commercial roles': {
        cmd: '*',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        withCheckMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        motivo:
          '`has_role(auth.uid(), master)` nos dois lados — mesmo texto (e mesmo md5) da policy que ' +
          'guarda `user_roles`. É a porta pela qual o master concede papel comercial.',
      },
      'Staff can view own commercial role': {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '19300d155780585259ede73ac370586c',
        withCheckMd5: null,
        motivo:
          '`auth.uid() = user_id` — leitura do PRÓPRIO papel. É o único caminho de leitura que não ' +
          'passa por master/super_admin; alargá-lo para `true` não concede nada, mas expõe quem vê ' +
          'custo na operação inteira.',
      },
      'Super admins can manage commercial roles': {
        cmd: '*',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'de2d5ca1583218fc96ddcdbcbfd8344b',
        withCheckMd5: 'de2d5ca1583218fc96ddcdbcbfd8344b',
        motivo:
          '`private.is_super_admin(auth.uid())` nos dois lados — AUTO-REFERENTE por desenho: quem é ' +
          '`super_admin` nesta tabela pode escrever nesta tabela, inclusive criar outro `super_admin`. ' +
          'É delegação deliberada, e é por isso que o CONJUNTO EXATO importa: uma quarta policy aqui ' +
          'é um caminho novo para a raiz, e o audit passa a acusá-la como `POLICY_NOVA`.',
      },
    },
  },
  'public.fin_permissoes': {
    forceRls: false,
    motivo:
      'A raiz do MÓDULO FINANCEIRO. Medido: `public.fin_user_can_access` (o `qual` inteiro de 18 ' +
      'policies do bloco `fin_*`) faz `SELECT * FROM fin_permissoes WHERE user_id = auth.uid()` — e ' +
      'mais QUATRO policies de escrita leem colunas desta tabela DIRETO, sem passar por função ' +
      'nenhuma: `fin_conc_write` (`pode_conciliar`), `fin_elim_write` ' +
      '(`pode_eliminar_intercompany`), `fin_fech_write` (`pode_fechar_mes`/`pode_aprovar_fechamento`) ' +
      'e `fin_orc_write` (`pode_editar_orcamento`). Uma linha aqui não vaza número: concede o direito ' +
      'de FECHAR O MÊS e de editar orçamento. ⚠️ Dependência por TABELA não aparece no `pg_depend` ' +
      'de policy→função — logo o eixo 3 não a descobre, e é o congelamento do CONJUNTO de policies ' +
      'que a cobre. Hoje 0 linhas e NENHUMA policy de escrita para `authenticated` (fail-closed por ' +
      'ausência); a tabela vazia é o estado seguro CORRENTE, não uma garantia — o valor da entrada é ' +
      'acusar o dia em que a policy de escrita aparecer.',
    policies: {
      fin_perm_service: {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'ea849457c1a771a3ea5e4fe3c0210590',
        withCheckMd5: null,
        motivo:
          '`auth.role() = service_role` — o ÚNICO caminho de escrita que existe hoje. `WITH CHECK` ' +
          'nulo num `FOR ALL`: o PG reusa o `USING`, simétrico por construção.',
      },
      fin_perm_user: {
        cmd: 'r',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'cd59a7031f2d715dc539b969290f5332',
        withCheckMd5: null,
        motivo:
          '`user_id = auth.uid() OR fin_user_can_access()` — leio a MINHA permissão, ou todas se já ' +
          'sou staff. Sem policy IUD para `authenticated`: escrita fechada por AUSÊNCIA de policy.',
      },
    },
  },
  // ── dinheiro (o bloco `fin_*` que a 1ª rodada deixou em `fin_contas_receber`) ───────────────
  'public.fin_contas_pagar': {
    forceRls: false,
    motivo:
      'O GÊMEO a pagar do `fin_contas_receber` já curado — curar um lado do caixa e não o outro é ' +
      'assimetria sem razão. 16.032 linhas com `valor_documento`/`valor_pago`/`saldo` e, junto, o ' +
      '`cnpj_cpf` e o `nome_fornecedor`: vazar aqui é vazar a estrutura de custo de fornecimento ' +
      'inteira, não só um total. `authenticated` tem SIUD completo (medido) — a RLS é a única ' +
      'barreira.',
    policies: {
      fin_cp_select: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'c164ff4089eb3d87bd1ca44523f8a4e9',
        withCheckMd5: null,
        motivo:
          '`fin_user_can_access(company)` — mesmo texto (e mesmo md5) do `fin_cr_select` do a ' +
          'receber. Toda a autorização mora no PREDICADO; ler o texto da policy não diz quem passa.',
      },
      fin_cp_service: {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'ea849457c1a771a3ea5e4fe3c0210590',
        withCheckMd5: null,
        motivo: '`auth.role() = service_role` — a escrita é exclusiva das edges de sync do Omie.',
      },
    },
  },
  'public.fin_movimentacoes': {
    forceRls: false,
    motivo:
      'O RAZÃO do caixa realizado: 55.486 linhas de `valor`/`natureza`/`conciliado` por conta ' +
      'corrente. É a tabela de onde o DRE e o fluxo saem — o a receber e o a pagar dizem o que foi ' +
      'PROMETIDO, esta diz o que ANDOU. Entra pelo eixo (i) no sentido mais literal, e com o mesmo ' +
      'grant SIUD aberto a `authenticated`.',
    policies: {
      fin_mov_select: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'c164ff4089eb3d87bd1ca44523f8a4e9',
        withCheckMd5: null,
        motivo: '`fin_user_can_access(company)` — recorte por empresa, idêntico ao do a receber.',
      },
      fin_mov_service: {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'ea849457c1a771a3ea5e4fe3c0210590',
        withCheckMd5: null,
        motivo: '`auth.role() = service_role` — escrita só pelo sync.',
      },
    },
  },
  'public.fin_contas_correntes': {
    forceRls: false,
    motivo:
      'As CONTAS BANCÁRIAS em si: `banco`, `agencia`, `numero_conta` e `saldo_atual`, 61 linhas. ' +
      'Poucas linhas e o pior conteúdo do bloco — é o dado que identifica onde o dinheiro está, não ' +
      'um agregado sobre ele. Pequena o bastante para ninguém notar que ficou de fora, e é ' +
      'exatamente por isso que entra.',
    policies: {
      fin_cc_select: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'c164ff4089eb3d87bd1ca44523f8a4e9',
        withCheckMd5: null,
        motivo: '`fin_user_can_access(company)` — mesmo recorte por empresa do resto do bloco.',
      },
      fin_cc_service: {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'ea849457c1a771a3ea5e4fe3c0210590',
        withCheckMd5: null,
        motivo: '`auth.role() = service_role` — escrita só pelo sync.',
      },
    },
  },
  'public.order_items': {
    forceRls: false,
    motivo:
      'O DETALHE de linha do `sales_orders` já curado — e o achado desta rodada: curar o pai e ' +
      'deixar o filho fora era um buraco com a asa VIRADA. Medido: `authenticated` NÃO tem SELECT em ' +
      '`sales_orders` (privilégio `0101` — só INSERT/DELETE), mas TEM SELECT em `order_items` ' +
      '(`1000`), que guarda `unit_price` e `discount` em 70.489 linhas. O preço praticado e o ' +
      'desconto por cliente estão do lado ALCANÇÁVEL da fronteira, e ali a RLS é a única barreira; ' +
      'no pai, quem barra é o grant (e o `authz:grants:prod` o vigia).',
    policies: {
      order_items_select_customer: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '201fd043b6445e361f172fb493c8b45b',
        withCheckMd5: null,
        motivo:
          '`(SELECT auth.uid()) = customer_user_id` — o cliente vê a própria linha. A coluna ' +
          '`customer_user_id` é desnormalizada no filho justamente para a policy não precisar de ' +
          'join no pai; renomeá-la move este md5, que é o falso-positivo conservador do desenho.',
      },
      order_items_select_staff: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'f2dd33660218e1da7dce99434b09d5b9',
        withCheckMd5: null,
        motivo:
          '`master OR employee`, com o wrap de InitPlan nas duas chamadas. SEM policy IUD: a escrita ' +
          'é fechada por AUSÊNCIA de grant (`authenticated` só tem SELECT) — o único caso do ' +
          'contrato em que a leitura é curada aqui e a escrita mora no outro audit.',
      },
    },
  },
  // ── custo / preço — o resto do que `private.cap_custo_ler` gateia ──────────────────────────
  'public.cmc_snapshot': {
    forceRls: false,
    motivo:
      'O CMC (custo médio de compra) por SKU e data: 31.342 linhas. `product_costs` (3.695 linhas) ' +
      'já é curada e tem uma coluna `cmc` — esta é a série que a alimenta, com quase 9× o volume. ' +
      'Reposição/compras é “cmc-first” (docs/agent/reposicao.md), então este é o número que decide ' +
      'compra. Grant medido: só SELECT para `authenticated` — e é a leitura que vaza custo.',
    policies: {
      cmc_snapshot_select_staff: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'eaca1331bdedc42dcab7ab61e8ff3814',
        withCheckMd5: null,
        motivo:
          '`private.cap_custo_ler(auth.uid())` com wrap de InitPlan — MESMO md5 do ' +
          '`product_costs_select_custo`. Uma policy só, sem escrita: service_role escreve.',
      },
    },
  },
  'public.cmc_ledger': {
    forceRls: false,
    motivo:
      'O razão que PRODUZ o CMC: `cmc_anterior` → `cmc_novo` com `saldo`, 1.148 linhas. É a série ' +
      'temporal do custo — vazar aqui não vaza só o custo de hoje, vaza a TRAJETÓRIA (quando subiu, ' +
      'quanto, em que SKU), que é o que permite inferir preço de fornecedor e negociação.',
    policies: {
      cmc_ledger_select_gestor: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'eaca1331bdedc42dcab7ab61e8ff3814',
        withCheckMd5: null,
        motivo: '`private.cap_custo_ler(auth.uid())` — mesmo predicado e mesmo md5 do snapshot.',
      },
    },
  },
  'public.inventory_position': {
    forceRls: false,
    motivo:
      'Posição de estoque VALORADA: `saldo` + `cmc` + `preco_medio` por SKU, 3.146 linhas. É o ' +
      'mesmo número de custo do `product_costs` exposto por outra porta — e a porta tem um `FOR ALL` ' +
      '(`Staff can manage inventory`), que é a forma que o check estrutural do audit vigia. ' +
      'database.md §4 a cita como o caso em que a FU4-F fase 2 teve de separar sinal de número por ' +
      'view; a tabela em si seguiu com SIUD aberto a `authenticated` (medido), então aqui a RLS é ' +
      'de fato a única barreira.',
    policies: {
      'Staff can manage inventory': {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'eaca1331bdedc42dcab7ab61e8ff3814',
        withCheckMd5: 'eaca1331bdedc42dcab7ab61e8ff3814',
        motivo:
          '`cap_custo_ler` nos DOIS lados — simétrico hoje. É a policy `FOR ALL` mais exposta do ' +
          'contrato (SIUD completo do lado do grant): apertar só o `WITH CHECK` aqui deixaria o ' +
          'DELETE aberto, que é precisamente o `FOR_ALL_ASSIMETRICO` do §4.',
      },
      staff_inventory_position_select: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: 'eaca1331bdedc42dcab7ab61e8ff3814',
        withCheckMd5: null,
        motivo:
          'Leitura redundante com o `FOR ALL` acima (mesmo predicado, e permissivas somam por OR). ' +
          'Está no contrato como MEDIÇÃO do estado real, não como recomendação: remover uma das duas ' +
          'é limpeza legítima, e o audit vai pedir que o contrato acompanhe.',
      },
    },
  },
  'public.markup_policy': {
    forceRls: false,
    motivo:
      'A REGRA que transforma custo em preço: `piso_markup`/`meta_markup` por escopo/família/SKU/tier. ' +
      '8 linhas — e as 8 linhas que definem a margem mínima da operação. Entra pelo eixo (ii) na ' +
      'ponta do PREÇO (o `omie_products` já curado é o preço de tabela; este é a regra que o forma), ' +
      'e é a menor tabela do contrato: pequena, invisível e decisiva.',
    policies: {
      markup_policy_select_carteira: {
        cmd: 'r',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'eaca1331bdedc42dcab7ab61e8ff3814',
        withCheckMd5: null,
        motivo:
          '`private.cap_custo_ler(auth.uid())` — o nome diz “carteira” mas o predicado medido é o de ' +
          'CUSTO (estrategico/super_admin), mais estreito que o de carteira. Nome de policy é ' +
          'comentário; o md5 é o que vale.',
      },
      markup_policy_write_master: {
        cmd: '*',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        withCheckMd5: '8ddd30b6b5137ea748cd7a8508a16675',
        motivo:
          '`has_role(master)` nos dois lados, simétrico. Assimetria aqui deixaria quem só lê custo ' +
          'APAGANDO o piso de margem — e piso apagado não é erro visível, é venda no prejuízo.',
      },
    },
  },
  // ── 3ª rodada: as tabelas escolhidas pelo PREDICADO que ARRASTAM (medida em prod
  //    2026-08-28). As três abaixo guardam pouco; o que elas trazem para o eixo 3 é que
  //    importa — `cap_compras_ler`, `cap_preco_escrever` e `cap_credito_escrever`, três
  //    capabilities que audit nenhum congelava. Ver o bloco AUTHZ_RLS_PREDICADOS. ──────────
  'public.venda_excecao_credito': {
    forceRls: false,
    motivo:
      'A EXCEÇÃO de crédito: a linha que libera venda para cliente com título vencido. O valor não ' +
      'está na tabela — está no que ela AUTORIZA, que é faturar contra risco já materializado. Entra ' +
      'porque a escrita é gateada por `private.cap_credito_escrever`, uma capability que hoje não ' +
      'está congelada por audit nenhum (0 linhas na tabela; o risco é latente, e o predicado é o que ' +
      'importa). É o vetor exato do PR #2064: reescrever a capability deixa o texto da policy ' +
      'idêntico e abre a concessão.',
    policies: {
      venda_excecao_insert_gestor: {
        cmd: 'a',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: null,
        withCheckMd5: 'ff1af097db9f598b8d168be213dcba8b',
        motivo:
          '`private.cap_credito_escrever(auth.uid())` — INSERT puro, sem `USING` (nada a filtrar na ' +
          'entrada). Traz `cap_credito_escrever` para AUTHZ_RLS_PREDICADOS.',
      },
      venda_excecao_select_staff: {
        cmd: 'r',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '2ebe0c0b117eb89cd6b89791bbc868c1',
        withCheckMd5: null,
        motivo:
          '`EXISTS (SELECT 1 FROM user_roles …)` INLINE — não chama `has_role`, repete a subquery à ' +
          'mão. Por isso esta policy não contribui predicado nenhum ao eixo 3: o md5 do `qual` é ' +
          'tudo o que existe para vigiar aqui.',
      },
      venda_excecao_service_all: {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '28f2f9950c5ed7f660b39524ab6b864d',
        withCheckMd5: null,
        motivo:
          '`(SELECT auth.role()) = service_role` — FOR ALL das engines. md5 DIFERENTE do `ea849457…` ' +
          'das outras service-policies porque esta traz o wrap InitPlan `(SELECT auth.role())`: ' +
          'mesma semântica, texto outro (§4). Sem `WITH CHECK`: simétrico por construção.',
      },
    },
  },

  // ── custo / preço (confidencialidade comercial) ────────────────────────────────────────────
  'public.cliente_tier_preco': {
    forceRls: false,
    motivo:
      'O TIER de preço do cliente — a linha que decide o desconto que ele paga. Vazia hoje (0 linhas, ' +
      'contadas), e entra pelo mesmo motivo que `venda_excecao_credito`: a escrita é gateada por ' +
      '`private.cap_preco_escrever`, capability que audit nenhum congelava. Uma tabela de CONCESSÃO ' +
      'vazia não é uma tabela sem risco: é uma tabela cujo primeiro INSERT indevido é o dano.',
    policies: {
      cliente_tier_preco_delete_master: {
        cmd: 'd',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'e133054e309de597df65e71951235297',
        withCheckMd5: null,
        motivo:
          '`has_role((SELECT auth.uid()), master)` — md5 distinto do `8ddd30b6…` das outras policies ' +
          'master-only porque esta tem o wrap InitPlan. Mesma semântica, texto outro: o md5 é da ' +
          'EXPRESSÃO, e é por isso que ele é conservador por desenho.',
      },
      cliente_tier_preco_insert_gestor: {
        cmd: 'a',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: null,
        withCheckMd5: '94c32fa0338037174a4632338242c3e4',
        motivo: '`private.cap_preco_escrever(auth.uid())` — INSERT puro, sem `USING`.',
      },
      cliente_tier_preco_select_staff: {
        cmd: 'r',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '41fa909ea11898d386285db45a4908e9',
        withCheckMd5: null,
        motivo: '`has_role(employee) OR has_role(master)` — broad-staff de leitura.',
      },
      cliente_tier_preco_service_all: {
        cmd: '*',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: 'ea849457c1a771a3ea5e4fe3c0210590',
        withCheckMd5: null,
        motivo: '`auth.role() = service_role` — FOR ALL das engines, sem `WITH CHECK`: simétrico.',
      },
      cliente_tier_preco_update_gestor: {
        cmd: 'w',
        permissiva: true,
        roles: ['PUBLIC'],
        qualMd5: '94c32fa0338037174a4632338242c3e4',
        withCheckMd5: '94c32fa0338037174a4632338242c3e4',
        motivo:
          '`cap_preco_escrever` nos DOIS lados — a linha alterada tem de satisfazer o gate antes e ' +
          'depois, o que impede mover um cliente para um tier melhor sem a capability.',
      },
    },
  },

  'public.pedido_compra_item': {
    forceRls: false,
    motivo:
      'O item do pedido de COMPRA: 2.404 linhas com `preco_unitario`/`valor_linha`/`desconto_percentual` ' +
      '— o custo na origem, antes de virar CMC (docs/agent/reposicao.md). Entra sobretudo pelo eixo 3: ' +
      'é a porta por onde `private.cap_compras_ler` — que gateia 18 policies em 14 tabelas, mais do ' +
      'que qualquer predicado hoje congelado exceto `has_role` — passa a ser vigiado. ⚠️ Medido e ' +
      'digno de nota: a capability chamada `_ler` gateia também INSERT, UPDATE e DELETE aqui; o nome ' +
      'diz leitura e o efeito é escrita. Está registrado, não corrigido — mudar isso é decisão de ' +
      'produto, e o contrato mede o que É.',
    policies: {
      staff_pedido_compra_item_delete: {
        cmd: 'd',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '53c61578bc6811739a0638a2df23462f',
        withCheckMd5: null,
        motivo: '`private.cap_compras_ler(auth.uid())` no `USING` — o lado que o DELETE consulta.',
      },
      staff_pedido_compra_item_insert: {
        cmd: 'a',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: null,
        withCheckMd5: '53c61578bc6811739a0638a2df23462f',
        motivo: '`cap_compras_ler` no `WITH CHECK` — INSERT puro. Mesmo md5: é a mesma expressão.',
      },
      staff_pedido_compra_item_select: {
        cmd: 'r',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '53c61578bc6811739a0638a2df23462f',
        withCheckMd5: null,
        motivo: '`cap_compras_ler` — a leitura do custo de compra.',
      },
      staff_pedido_compra_item_update: {
        cmd: 'w',
        permissiva: true,
        roles: ['authenticated'],
        qualMd5: '53c61578bc6811739a0638a2df23462f',
        withCheckMd5: '53c61578bc6811739a0638a2df23462f',
        motivo: '`cap_compras_ler` nos dois lados — simétrico, então não há brecha de DELETE-por-UPDATE.',
      },
    },
  },

  // ── cadastro-base + aprovação ──────────────────────────────────────────────────────────────
};

/**
 * O que foi MEDIDO e ficou de FORA do eixo curado, com a razão — uma entrada por tabela.
 *
 * Por que isto é DADO e não prosa. Nasceu como parágrafo no cabeçalho, e apodreceu em UM dia: a
 * 3ª rodada (2026-08-28) curou `venda_excecao_credito`, `cliente_tier_preco` e
 * `pedido_compra_item`, que o parágrafo declarava como lacuna — e o texto seguiu afirmando o
 * contrário, verde em todos os gates. Nenhum audit pega isso: eles reconciliam o CONTRATO contra
 * prod, não a prosa contra o contrato. Como lista, o cruzamento é um teste de três linhas
 * (`scripts/authz-rls.test.ts`, §3).
 *
 * ⚠️ E a razão que a 3ª rodada derrubou merece ficar registrada, porque o erro nela é instrutivo:
 * eu recusei `venda_excecao_credito` e `cliente_tier_preco` argumentando que "o gate delas é
 * `has_role(master)` puro, e a raiz `user_roles` já está curada". O argumento vale para o eixo da
 * RAIZ e é CEGO ao eixo 3: congelar `user_roles` não congela o CORPO de `cap_credito_escrever` —
 * reescrevê-lo para `SELECT true` não move o md5 de policy nenhuma, que é exatamente o ponto cego
 * que o eixo 3 existe para fechar. Curar a tabela ARRASTA o predicado para o congelamento. Lição
 * que sobra: **"a raiz já está coberta" não é razão para recusar, porque raiz e predicado são
 * eixos diferentes** — a pergunta certa é se o gate da tabela já é congelado por ALGUÉM.
 *
 * Grupos (não cabem como chave de tabela e seguem como prosa, deliberadamente): as **22** tabelas
 * de `private.cap_carteira_ler` e as **8** de `private.carteira_visivel_para` — inteligência
 * comercial, e a RAIZ delas (`public.commercial_roles`) está curada; as **36** `fin_*` restantes
 * (de 41; 5 curadas) — agregados, logs e controle derivados, com as fontes e as duas raízes
 * curadas e o gate comum (`fin_user_can_access`) congelado; e as outras **13** de
 * `private.cap_compras_ler` (de 14 — `pedido_compra_item` entrou na 3ª rodada e já arrasta o
 * predicado). Contagens medidas em prod 2026-08-28.
 */
export const LACUNAS_DECLARADAS: Record<string, string> = {
  'public.carteira_assignments':
    'É raiz de verdade — `private.carteira_visivel_para` a lê —, mas raiz de INTELIGÊNCIA ' +
    'COMERCIAL, não de dinheiro/custo. O predicado dela não fica órfão: já é congelado por ser ' +
    'chamado pelas policies das tabelas de carteira. Gatilho de reentrada: no dia em que comissão ' +
    'ou preço passarem a depender da carteira, ela vira membro (i)/(ii).',
  'public.carteira_coverage':
    'O SEGUNDO caminho de `carteira_visivel_para` (a cobertura temporária de carteira alheia). ' +
    'Mesma razão de `carteira_assignments`, e o mesmo gatilho. Nota medida: o INSERT dela permite ' +
    '`covered_user_id = auth.uid()`, ou seja, delegar a PRÓPRIA carteira — não tomar a alheia.',
  'public.customer_contacts':
    'Dado PESSOAL (LGPD), não dinheiro/custo/raiz — o critério deste contrato não a alcança. O ' +
    'broad-staff dela é decisão MEDIDA de 2026-07-20 (database.md §4) com gatilho de reavaliação ' +
    'próprio; forçá-la aqui seria usar a sentinela errada para o problema, e o verde passaria a ' +
    'afirmar algo que ninguém mediu.',
  'public.margin_audit_log':
    'Log DERIVADO: 11.869 linhas de `margin_real`/`margin_gap`. A raiz que o gateia ' +
    '(`commercial_roles`, lida DIRETO no `qual` dele) e as fontes de custo (`product_costs`, ' +
    '`cmc_*`, `inventory_position`) estão curadas — o número aqui é consequência delas.',
  'public.regua_preco_log':
    'Log de aplicação da régua de preço. Derivado de `markup_policy` e `product_costs`, ambas ' +
    'curadas; o gate (`cap_custo_ler`) já é predicado congelado. Sem número na fonte.',
  'public.recommendation_log':
    'Log de recomendação emitida. Derivado, e o gate (`cap_custo_ler`) já é predicado congelado.',
  'public.farmer_algorithm_config':
    'CONFIG do motor de recomendação, não número de dinheiro/custo. O gate (`cap_custo_ler`) já é ' +
    'predicado congelado, então a tabela não arrasta nada de novo para o eixo 3.',
  'public.orders':
    'LEGADO: 0 linhas em prod (medido). Tem `subtotal`/`total`, mas o pedido vivo é ' +
    '`sales_orders`, já curado — curar uma tabela vazia é congelar a forma de algo que ninguém ' +
    'usa. Gatilho de reentrada: a primeira linha.',
  'public.cliente_grupos':
    'Agrupamento de cadastros do mesmo cliente (o caso Colacor SC + Oben do database.md §5), 0 ' +
    'linhas em prod. Metadado de consolidação, não dinheiro; o gate (`fin_user_can_access`) já é ' +
    'predicado congelado. Gatilho de reentrada: a primeira linha.',
  'public.cliente_grupo_membros':
    'Os membros do agrupamento acima, 0 linhas em prod. Mesma razão e mesmo gatilho — e o mesmo ' +
    'gate já congelado.',
};

export interface PredicadoEsperado {
  /** `prosecdef`. Todas as 5 são SECDEF: é o que faz o predicado enxergar `user_roles`/
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
 * Medido em prod (2026-08-27 + 2026-08-28): as 50 policies referenciam 10 funções — estas 8
 * mais `auth.uid` e `auth.role`, que ficam em `PREDICADOS_PLATAFORMA`.
 *
 * ⚠️ A 2ª rodada leu o próprio resultado como convergência: 10 tabelas novas trazendo UMA função
 * só (`is_super_admin`) sugeria que a autorização deste banco converge para poucos gates. A 3ª
 * rodada mediu o contrário — 3 tabelas trouxeram 3 funções (`cap_compras_ler`,
 * `cap_preco_escrever`, `cap_credito_escrever`) — e a razão é de MÉTODO, não do banco: a 2ª
 * rodada escolheu tabelas por parentesco com as já curadas (o resto do `fin_*`, o resto do que
 * `cap_custo_ler` gateia), e tabela irmã compartilha o gate da irmã por construção. A amostra
 * confirmava a hipótese porque fora selecionada por ela. O grafo real tem 14 funções gateando
 * policy em `public`; 8 estão congeladas aqui. ⇒ **Convergência medida sobre uma amostra
 * escolhida por semelhança não é convergência — é o método se ouvindo falar.**
 *
 * ⚠️ `cap_compras_ler`, `cap_credito_escrever` e `cap_preco_escrever` têm o MESMO `srcMd5`
 * (`5faf2a21…`): três capabilities distintas cujo corpo hoje é o mesmo `has_role(master)`. Não é
 * duplicação a limpar — é o estado a congelar, e o dia em que uma divergir é o sinal que se quer.
 */
export const AUTHZ_RLS_PREDICADOS: Record<string, PredicadoEsperado> = {
  'private.cap_compras_ler': {
    secdef: true,
    cfg: 'search_path=public',
    srcMd5: '5faf2a21a46209aaf0ffa75041af6b4b',
    motivo:
      '`COALESCE(_uid IS NOT NULL AND has_role(master), false)` — master-only. O predicado de MAIOR ' +
      'alcance que este contrato passa a congelar depois de `has_role`: 18 policies em 14 tabelas ' +
      '(medido por pg_depend), das quais o contrato cura UMA (`pedido_compra_item`). Congelar o corpo ' +
      'cobre as 14 no eixo 3 mesmo sem curar o conteúdo das outras 13 — é o melhor retorno por entrada ' +
      'do arquivo inteiro. ⚠️ Corpo IDÊNTICO ao de `cap_preco_escrever`/`cap_credito_escrever`, logo o ' +
      'mesmo md5 nas três: são capabilities distintas com a mesma regra hoje, e o dia em que uma ' +
      'divergir é exatamente o que se quer ver.',
  },
  'private.cap_credito_escrever': {
    secdef: true,
    cfg: 'search_path=public',
    srcMd5: '5faf2a21a46209aaf0ffa75041af6b4b',
    motivo:
      'master-only, mesmo corpo (e mesmo md5) de `cap_compras_ler`. Gateia 1 policy: o INSERT de ' +
      '`venda_excecao_credito`, que libera faturamento contra título vencido. Alcance pequeno, dano ' +
      'grande — e era invisível aos quatro audits antes desta entrada.',
  },
  'private.cap_preco_escrever': {
    secdef: true,
    cfg: 'search_path=public',
    srcMd5: '5faf2a21a46209aaf0ffa75041af6b4b',
    motivo:
      'master-only, mesmo corpo dos dois acima. Gateia o INSERT e o UPDATE de `cliente_tier_preco`, ' +
      'isto é, o desconto que cada cliente paga. Reescrevê-la para `true` deixa as duas policies ' +
      'byte-a-byte idênticas e entrega a tabela de preços a qualquer autenticado.',
  },
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
  'private.is_super_admin': {
    secdef: true,
    cfg: 'search_path=public',
    srcMd5: 'c4fdac766af935cee0512665d3954724',
    motivo:
      '`EXISTS (SELECT 1 FROM public.commercial_roles WHERE user_id = _user_id AND ' +
      "commercial_role = 'super_admin')`. Entrou na 2ª rodada junto de `public.commercial_roles`, " +
      'que é a tabela que ela lê — e é o predicado da policy AUTO-REFERENTE `Super admins can ' +
      'manage commercial roles`. Não chama nenhuma outra função (medido), então não estende o ' +
      'problema do 2º nível do grafo descrito no cabeçalho de `scripts/lib/authz-rls.ts`.',
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
