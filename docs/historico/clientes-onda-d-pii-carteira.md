# Clientes — onda D: contato do cliente só na carteira (fatia 1 de 3)

**Decisão do founder (2026-11-24):** opção (c) — identidade aberta a staff; documento, telefone, e-mail e
endereço só na carteira/cobertura; gestor/master veem tudo; customer inalterado. Para as telas operacionais
que legitimamente precisam de PII fora da carteira: **contexto operacional** (RPC por OBJETO + ledger).
Spec: `docs/superpowers/specs/2026-11-24-clientes-pii-por-carteira-design.md` (Codex challenge integrado).

## Fatia 1 (este PR) — contrato, sem fechar nada
- Migration `20261124120000_clientes_pii_contrato_carteira.sql`:
  - `private.clientes_para_agir(uid)`: atribuição **elegível** expandida pela raiz fiscal; raiz com 2 donos
    elegíveis **não** expande (prod: 0 raízes ambíguas, 0 cadeias de alias em 2026-11-24).
  - `private.clientes_contato_visiveis` / `cliente_pode_agir` / `cliente_contato_visivel` (staff atual,
    gestão, carteira, cobertura vigente; **sem** o ramo "alvo é colega").
  - `public.pode_agir_no_cliente(uuid)`: o MESMO predicado na ficha (`AcoesDaFicha`) e no escritor
    (`venda_registrar_contato`, que aceitava atribuição não elegível; a ficha ignorava alias).
  - `public.v_perfil_contato`: view-gate (`invoker=off`, `barrier`) mascarada + `contato_visivel` + `eh_pj`.
  - `public.buscar_clientes_global`: Cmd-K — staff nunca aparece; doc/CNPJ/e-mail só casam onde visível
    (termo do contato oculto responde igual a termo ausente).
- Front: 360 lê contato pela view e diz "contato visível só para a carteira" (≠ vazio ≠ falha); Cmd-K pela
  RPC, erro visível, recentes por usuário só `kind/id/title/path` e a chave antiga `global_search_recents_v1`
  (que guardava CPF/CNPJ no subtitle) apagada.
- Prova: `db/test-clientes-pii-contrato-carteira.sh` (C **e** pt_BR.UTF-8; controle verde + 10 sabotagens).

## O que AINDA não vale (lacuna declarada, assert L1 do harness)
Pela API, o employee **ainda lê** PII de qualquer cliente direto de `profiles`/`addresses`/
`customer_contacts`, e pelas superfícies do mapa (customer_metrics_mv, sales_orders snapshot, views de
grupo/caça, `listar_clientes_base`, edges `omie-cliente`/`mcp`). Fecha na fatia 3, depois de a fatia 2
migrar os ~35 leitores (pedido, expedição, rota, aprovação → RPC operacional por objeto + ledger).

## Lições
- Com 3 staff e o master dono de 82% da carteira, "só na carteira" estrito quebraria pedido/rota/expedição
  da farmer — a exceção operacional é requisito, não afrouxamento. Medir a DISTRIBUIÇÃO de donos antes de
  desenhar autorização por carteira.
- Grant de coluna > RLS por linha para separar contato de identidade: leitor antigo quebra com 42501
  (visível) em vez de concluir que o cliente não existe (silencioso). Precedente: margem, 20261014120100.
- **Correção no CI (`like-cru-em-migrations-gate`):** a 1ª definição da `buscar_clientes_global` montava o
  ILIKE com o termo cru (`_`/`\` viravam curinga). Migration `20261124130000` recria com
  `private.padrao_like_contem(...) ESCAPE '\'` e ordena por `starts_with`; a definição antiga fica na
  baseline como morta. Prova PG17 ganhou S10 (`e_U` não casa `Cliente Um`) e K11 (pattern cru → vermelho):
  93 ok / 0 fail em C e pt_BR.

## Fatia 2 — fontes mascaradas para todos os leitores + exceção operacional auditada
- Migration `20261124180000_clientes_contato_operacional_ledger.sql`:
  - `v_perfil_contato` **reescrita** (mesmas colunas) em forma de CONJUNTO: a da fatia 1 chamava o
    predicado por linha e a carga aberta estourou 30 s em prod (farmer); a de conjunto mediu 215 ms /
    16.102 linhas. `IN` hasheado e não `EXISTS`: dentro do `OR`, `EXISTS` vira subplano por linha
    (medido 3,4 s). NULL-safe: alvo NULL nunca visível e o conjunto filtra NULL.
  - `v_endereco_contato` (cidade/UF sempre; rótulo, rua, número, bairro, CEP só onde visível) e
    `v_cliente_contatos` (só staff, só cliente visível). Ambas view-gate `invoker=off` + `barrier`.
  - Ledger `contato_acesso_operacional`: só referência; RLS (gestão vê tudo, staff ATUAL vê as suas);
    zero escrita para authenticated **e service_role**; vocabulário FECHADO de (tipo, motivo) no CHECK.
  - RPC `contato_cliente_operacional(tipo, ids[], motivo)`: o cliente sai do OBJETO no servidor
    (`pedido`→sales_orders, `ordem_servico`→orders, `expedicao`→picking_tasks, `rota`→visitas_agendadas
    **agendadas por quem chama**, `aprovacao`→cadastro pendente, `novo_pedido`→o próprio cliente);
    payload mínimo por tipo; teto de 200 objetos (cardinalidade bruta); grava só a EXCEÇÃO, dedupe 10 min
    serializado por `pg_advisory_xact_lock`; `novo_pedido` = 1 cliente/chamada e ≤ 80 clientes distintos
    fora da carteira por staff/dia (pico medido: 34 clientes/dia TOTAIS) → 54000.
- Codex (`gpt-6.2-astra`, high, 79 s): APLICAR COM AJUSTES, sem P0. Integrados: NULL no conjunto
  entregava PII sem ledger; `novo_pedido` sem freio; payload igual para todo tipo; `label` exposto;
  `service_role` como 2º writer; ex-employee lendo o próprio histórico; motivo livre; teto antes do
  DISTINCT; asserts verdes de graça (O5d, alias sem pedido, uuid repetido entre tabelas).
- Prova: `db/test-clientes-contato-operacional.sh` — 211 ok / 0 fail em `C` **e** `pt_BR.UTF-8`,
  24 sabotagens (uma por camada; a exclusão de staff tem DUAS camadas, papel e flag, sabotadas à parte).
- Front: `src/lib/contato-cliente.ts` (as duas portas). Telas → view (`comContatoMascarado`, escopo de
  clientes, scoring, UTI, Prime, AI Ops, gamificação, demanda, agenda, buscas, Meu dia/rota, 360
  endereço/contatos, telefonia, MCP). Operacional → RPC (detalhe e impressão de pedido, OS, roteirizador
  de entrega, visitas agendadas, aprovação de cadastro, novo pedido/proposta). Self → view.
  Busca que filtrava pela coluna PII agora filtra na view (termo do contato oculto = termo ausente).

## Pré-requisitos da fatia 3 (o que esta fatia NÃO migrou, de propósito)
- **Diretório de equipe**: `GovernanceUsers/Permissions/Settings`, `useDepartmentsAdmin`,
  `AdminVendorSipCredentials`, `useExecucaoRaioX` leem `profiles.email` de STAFF. A view mascara colega
  (sem ramo "alvo é colega", decisão da fatia 1) → o REVOKE quebra essas telas. Decidir a fonte antes.
- Servidor: `listar_clientes_base`, `customer_metrics_mv`, views de grupo/caça, `resolver_cliente_por_telefone`,
  `cobranca_regua_hoje`, edges `mcp`/`omie-cliente`/`analyze-unified-order`, snapshot `sales_orders.customer_*`
  (os leitores do front já saíram dele).
- Signup anônimo (`SignupForm`: `profiles.eq('document')` como anon) — decisão da spec: unicidade no
  servidor e resposta pública uniforme no corte. Filtrar por coluna revogada também dá 42501.
- Escrita em `customer_contacts` segue na tabela (o `.select()` pós-escrita depende das policies da fatia 3).

## Fatia 3 — `profiles` fecha pela API (3a leitores de servidor · 3b corte)
- **Escopo (founder, handoff 25/11):** fechar `profiles.email/phone/document/cnpj` pela API. Decisões novas
  (25/11): Caça **mascara o telefone** fora da carteira (o documento segue projetado como chave da fila);
  diretório de equipe = **qualquer staff** vê nome+e-mail de staff (papel OU flag `is_employee`, que é como
  funcionário novo entra antes de ganhar papel).
- **3a `20261125120000`** (segura antes do corte; corpos do `pg_get_*def` de PROD): `private.v_perfil_chaves_internas`
  (chave fiscal/telefone CRUA só para JOIN; ramo `service_role` porque a edge de custo lê `v_caca_compradores`
  sem `sub` — sem ele, zero linhas EM SILÊNCIO; `current_user` em view invoker=off é o do chamador),
  `v_perfil_equipe`, `cliente_por_documento(text[])` (documento → identidade, só staff), as 4 views invoker
  (Caça e Grupo) e `listar_clientes_base` lendo contato pela `v_perfil_contato`, `resolver_cliente_por_telefone`
  SECDEF com gate de staff explícito.
- **3b `20261125130000`:** `REVOKE SELECT` de tabela + `GRANT SELECT` das 21 colunas de identidade (anon e
  authenticated); postcondição confere coluna a coluna.
- **Achado do ensaio (prod, farmer, rollback):** a `v_perfil_contato` da fatia 2 levava **~14 s**, inclusive no
  lote de 150 ids do front — o CTE `ctx` era achatado e `has_role()` (SECDEF, não inlinável) rodava POR LINHA,
  e `clientes_contato_visiveis` 1x por coluna mascarada (5 SubPlans). A medição de 215 ms da fatia 2 não
  reproduz hoje. A 3a a recria com `ctx` e `vis` `MATERIALIZED`: **88 ms** (lote: 68 ms), digest md5 linha a
  linha IGUAL (16.105 linhas). Sem isso a `listar_clientes_base` iria de 0,6 s a 8,5 s em toda página.
  Ensaio por consulta (1 por rodada: o envelope é 1 statement com teto de 300 s, e o bloco inteiro estourava
  já no estado de hoje por causa da página de candidatos da Caça — pré-existente, igual antes e depois).
  Harness ganhou A1i (digest da view por persona, 8 personas) e K15 (regra afrouxada → digest do gestor).
- **Achado do harness:** o `upsert` do signup (`Auth.tsx`, `ON CONFLICT DO UPDATE … EXCLUDED.email`) quebra com
  grant de coluna — o PG exige SELECT na coluna lida pelo `EXCLUDED`. Virou `ignoreDuplicates` + `update`.
  A checagem "documento já cadastrado" do `SignupForm` lia como anon e **nunca disparou** (RLS) — removida.
- **Prova:** `db/test-clientes-pii-fatia3-corte.sh` — 179 ok / 0 fail em `C` e `pt_BR.UTF-8`; digests linha a
  linha antes/depois (compradores como service_role, Caça, grupo, lista), opt-out só por telefone, 14
  sabotagens com o vermelho EXATO do mutante. Camada redundante declarada: o REVOKE de anon nas 4 views é
  coberto por mais duas (chave interna e `v_perfil_contato` sem anon) — falsifica-se a postcondição, não o A19.
- **Codex** (`gpt-6.2-astra`, high, 212 s, 117 k tokens): **NÃO APLICAR a 3b** — P0: `customer_metrics_mv`
  projeta `document` a qualquer employee; `customer_contacts` e os snapshots `sales_orders.customer_*` seguem
  abertos sem ledger; o UPDATE do próprio perfil é oráculo de unicidade de documento (pré-existente). P1:
  `v_grupo_contatos` ainda projeta documento/endereço; `cliente_por_documento` é oráculo exato para staff;
  edge `omie-cliente`; flag de equipe sobrevive ao desligamento; bundle `mcp` defasado. Integrados: digests,
  opt-out por telefone, persistência das escritas, ledger no B12, vermelho exato, bundle `mcp` regenerado.
  **Divergência registrada:** a 3b é estritamente REDUTORA (os P0 são superfícies independentes de `profiles`,
  abertas com ou sem o corte) — então a onda D **não está pronta**; o que falta é a fatia 4 (abaixo).
- **Em prod (2026-11-26):** a 3a já estava aplicada quando a sessão foi aplicá-la; o estado bate com toda a
  postcondição e a `deriva:corpo:prod` deu 651 identidades em dia. Publish servindo o commit `9efe21ae`
  (contém o #4184). O founder decidiu aplicar a 3b apesar da divergência do Codex: pré-voo 🟢, ensaio com
  rollback ok e apply pelo envelope (tentativa **#1454**). Antes, a varredura dos leitores na prod: as 7
  funções invoker que citam colunas de contato só são alcançáveis por SECDEF de `postgres` (nenhuma entrada
  exposta a anon/authenticated); nenhuma policy lê essas colunas; as novas `credito_ficha` e
  `credito_fila_propostas` (`20261126090000`, pendente) são SECDEF. Validado por fora: anon e authenticated
  sem SELECT de tabela e sem as 4 colunas, com identidade e escrita; `service_role` intacto. API real (anon):
  `select=email` → 42501 no grant.
- **Teste logado em prod pós-3b (master, navegador do app, build `9efe21ae`), zero 4xx da fatia:**
  - `/admin/customers` (lista via `listar_clientes_base`);
  - ficha 360 (identidade de `profiles` + contato de `v_perfil_contato`/`v_endereco_contato`);
  - `governance/users`, `governance/permissions`, `governance/settings` e `admin/sip-credentials` (`v_perfil_equipe`);
  - seleção de cliente no novo pedido (vínculo resolvido pelo mapa Omie; a RPC `cliente_por_documento` não
    foi exercitada pela tela — coberta pelo catálogo e pelo harness).
  - Varredura do build servido: nenhuma leitura de `profiles` pede contato ou `*`; as 8 edges que leem contato
    usam `service_role`; nenhum trigger de `profiles` consulta a tabela.
  - Não coberto: persona farmer logada (o ensaio com `SET ROLE` é impossível no envelope, que roda em SECURITY
    DEFINER). Único 4xx visto: `credito_fila_v` → 403, alheio à fatia (não depende de `profiles`).
- **Fatia 4 (não entra aqui):** `customer_metrics_mv.document`; `sales_orders.customer_document/address/phone`;
  policies de `customer_contacts` e `addresses`; `cliente_grupo_membros.documento` e
  `v_grupo_contas_receber_por_doc`; endereço em `v_grupo_contatos`; edges `omie-cliente` (busca de staff e
  oráculo público) e `analyze-unified-order`; `cobranca_regua_hoje`; unicidade de documento mediada no servidor.

## Fatia 4a — snapshot de pedido, métrica e contatos do cliente (os P0 de leitura do Codex)
- **Recorte:** a lista da fatia 4 não coube num PR. A 4a fecha as três superfícies sem dependência de decisão de
  produto. O resto vai para a 4b (abaixo).
- **4a-1 `20261126160000`** (segura já, sem Publish):
  - `public.v_pedido_snapshot_proprio` (view-gate `invoker=off` + `barrier`, só SELECT): o CLIENTE lê o
    snapshot do próprio pedido.
  - Exclui o titular que é staff (papel atual OU flag `is_employee`, mesmo filtro da `selfservice_meus_pedidos`).
    O pedido e o orçamento gravam `customerUserId || user.id`: sem vínculo local, o titular vira o VENDEDOR e o
    snapshot é do comprador. Em prod: **19 pedidos de 3 staff, o último em 2026-11-21**.
  - Igualdade exata do uuid: cliente com 2 cadastros vê cada pedido pelo seu login, como na RLS.
  - `customer_metrics_mv.document` fecha por grant de COLUNA. Nenhum leitor do front pede a coluna; `service_role`
    (ai-ops-agent, `select("*")`) continua com a view inteira.
- **4a-2 `20261126170000`** (só depois do Publish servir o merge):
  - `sales_orders.customer_document/address/phone` perdem o SELECT de coluna. O UPDATE de coluna e o INSERT de
    tabela continuam, então o pedido segue gravando.
  - `customer_contacts` passa a REVOKE SELECT de tabela + GRANT SELECT só de chave, flags e carimbos.
  - O UPDATE de `customer_contacts` vira de COLUNA, sem `customer_user_id`/`created_by`/`id`. A view decide
    pelo dono ATUAL da linha, então reatribuir um contato de fora para um cliente da carteira o exibiria inteiro.
- **Front:**
  - o ramo do cliente em `useSalesOrderDetail` lê a view nova;
  - `useSaveContact` relê só `id, customer_user_id` e não manda dono nem criador no update.
- **Codex** (`gpt-6.2-astra`, high, 155 s, 103 k tokens): **NÃO APLICAR** a 1ª versão. Integrados:
  - P0 titular staff;
  - P0 reatribuição do dono do contato;
  - P2 asserts verdes de graça (S3 sem pedido de titular staff; T7/T8 sem índice único de principal; B3 com
    `has_table_privilege(…, 'INSERT, UPDATE, DELETE')`, que responde "algum deles" — agora verbo a verbo).
- **Prova:** `db/test-clientes-pii-fatia4a-corte.sh` — **213 ok / 0 fail** em `C` e `pt_BR.UTF-8`, digests por
  persona antes/depois (métrica, pedidos, Caça, grupo, `v_cliente_contatos`), 23 sabotagens com o vermelho EXATO
  (5 delas são postcondição abortando com a sua marca).
- **Lições do harness:**
  - `GRANT SELECT, UPDATE (cols)` concede SELECT de TABELA: a lista de colunas é só do último privilégio. Escreva
    `SELECT (cols), UPDATE (cols)`.
  - `WHERE <col revogada>` num UPDATE também dá 42501: o filtro exige SELECT.
  - Casar a mensagem "permission denied" é vermelho que só existe em `C` (o pt_BR traduz) → case a SQLSTATE.
  - O K7 mostrou que o furo era real: view nova nasce `ALL` (default privileges) e o UPDATE pela view de OWNER
    GRAVOU no pedido.
- **Lacuna declarada (L6 do harness):** `contato_cliente_operacional('pedido', …)` trata o pedido de titular staff
  como leitura PRÓPRIA (`cid = v_uid`) e entrega sem ledger. Entra na 4b.
- **No ar (2026-11-26):** PR #4225 mergeado (`566bccce3`).
  - `20261126160000` aplicada pelo envelope (recibo #1484).
  - O Publish já servia `__BUILD_SHA__=566bccce` antes do corte.
  - `20261126170000` aplicada (recibo #1486).
  - Validação por fora (psql-ro):
    - view `invoker=off`/`barrier`, só `authenticated=r`;
    - `customer_metrics_mv.document` fechado e `faturamento_90d` aberto;
    - as 3 colunas de snapshot de `sales_orders` com `authenticated` sel=f e upd=t;
    - contatos: PII sel=f e upd=t; `customer_user_id`/`created_by` sel=t e upd=f;
    - `service_role` intacto.
  - `audit:migrations` e `deriva:corpo:prod` rc=0.

## Fatia 4b — o que falta (não entra na 4a)
- `contato_cliente_operacional`: o ramo "próprio" não pode valer para titular staff.
- Escrita do pedido e do orçamento: parar de gravar o vendedor como titular (`customerUserId || user.id`).
- `addresses`: staff ainda lê tudo. O cliente lê os próprios com `select('*')` (`Addresses.tsx`, `useProfile`
  head count), então o corte por coluna exige migrar esses leitores para `v_endereco_contato`.
- `v_grupo_contatos`: o endereço sai cru, e essa view depende de `addresses.street/number`.
- `cliente_grupo_membros.documento` (embed `membros(*)` em `useClienteGrupos`) e `v_grupo_contas_receber_por_doc`:
  🧭 o founder decide quem vê o documento no contas a receber por grupo.
- `cobranca_regua_hoje`: já filtra `gestão OR dona = uid`. Conferir se "dona da cobrança" basta como carteira.
- `resolver_cliente_por_telefone`: oráculo telefone→cliente para qualquer staff (Codex P1 da 4a). Pode ser
  exceção deliberada da telefonia; se for, registrar no contrato.
- Edges `omie-cliente` (busca de staff e oráculo público) e `analyze-unified-order`.
- Unicidade de documento mediada no servidor (oráculo do UPDATE do próprio perfil) e `cliente_por_documento`.
- Flag de equipe que sobrevive ao desligamento.
- Troca de contato principal em 2 requisições, não atômica (Codex P1, pré-existente; 0 linhas hoje).
- `customer_contacts`: `anon` ainda tem INSERT/DELETE de tabela (ACL `arwdDxtm` herdada; medido 2026-11-26).
  Hoje só a RLS de escrita (exige staff) segura isso → revogar de `anon`.

## Fatia 4b-1 — servidor (migration `20261126230000`)
- **L6 fechada:** `contato_cliente_operacional` perdeu o ramo "próprio" (`a.cid = v_uid`). Como o chamador é sempre
  staff, ele só valia para pedido com o vendedor como titular (fallback do front, 19 pedidos). **Codex P1:** titular
  staff (papel ou flag) também deixa de contar como carteira para quem não é gestão, porque o snapshot é do comprador.
  Medido em prod: 1 staff dentro de uma carteira, 12 pedidos que a dona dela lia sem registro. Agora vão para o ledger.
- **anon fora** (REVOKE ALL) de `addresses`, `customer_contacts`, `cliente_grupos`, `cliente_grupo_membros` e
  `v_grupo_contas_receber_por_doc`. O ACL vinha herdado; até aqui só a RLS segurava.
- **`v_grupo_contatos`** lê o endereço da `v_endereco_contato`: a rua sai NULL fora da carteira, e cidade/UF seguem.
  Continua `security_invoker=true`. Latente (Codex P2): quem chama como `service_role` sem `sub` passa a ver cidade/UF
  NULL. Não há consumidor desse tipo e os grupos estão vazios em prod.
- **`v_perfil_equipe` por papel:** sai a flag `is_employee`. O ex-funcionário com papel removido sai do diretório.
  Prod: 0 perfis com a flag sem papel, md5 igual antes/depois e 430 → 9 ms (ensaio como farmer, rollback).
  Lacuna de produto, não de servidor: não há fluxo de desligamento. Tirar o papel não tira a flag, `commercial_roles`
  nem a carteira; hoje se faz à mão no banco.
- **Decisões registradas:**
  - documento do membro do grupo no CR: quem tem acesso financeiro vê (founder, 2026-11-26);
  - `cobranca_regua_hoje`: "dona" (`carteira_assignments` eligible) ⊆ carteira e já filtra `gestão OR dona`, então basta;
  - `resolver_cliente_por_telefone` (telefonia) e `cliente_por_documento` (Omie→perfil, só uuid): exceções no `COMMENT`
    e em `telefonia.md`.
- **Prova:** `db/test-clientes-pii-fatia4b1-servidor.sh`, 113 ok em C e pt_BR.UTF-8, com 22 sabotagens, cada uma com o
  vermelho exato. Ensaio de desempenho em `db/diagnostico/ensaio-clientes-pii-fatia4b1-perf.sql`.

- **No ar (2026-11-27):** #4239 mergeado. Pré-flight sem deriva: os corpos de prod de `contato_cliente_operacional`,
  `v_grupo_contatos` e `v_perfil_equipe` são iguais aos da captura. Ensaio ok; apply com recibo `db:aplicar` **#1503**,
  postcondição `fatia 4b-1 ok`.
  Validação por fora (psql-ro):
  - L6 fora, `titular_staff` presente;
  - RPC: anon=f, authenticated=t;
  - anon sem SELECT nas 6 relações e sem DELETE em `customer_contacts`;
  - `authenticated` lê e grava `addresses`;
  - `v_grupo_contatos` invoker=true lendo `v_endereco_contato`;
  - `v_perfil_equipe` invoker=off + barrier.
  `audit:migrations` rc=0. `deriva:corpo:prod` rc=0, depois de conciliar o GRANT da RPC como `SO_CITA` na baseline.
  Pendente: prova logado em prod pelo founder (Clientes → grupo; pedido com titular staff → ledger).

## Fatia 4b-2 — o que falta (front + corte)
- `addresses`: migrar `Addresses.tsx:108` (`select('*')`), `RecurringSchedules.tsx:82`, `useProfile.ts:63` (head `*`)
  e `useCustomerDashboard.ts:28` (sem filtro de dono). Depois do Publish, corte por coluna: rua/CEP só pela view.
- Titular: `submitOrder.ts:268/:440`, `submitQuote.ts:76/:128` e `helpers.ts:154` gravam `customerUserId || user.id`.
  Staff sem cliente → erro, não fallback.
- Contato principal: `useCustomerContacts.ts:53-85` usa 2 requisições → RPC atômica.
- Perfil: o 23505 do documento duplicado (`Profile.tsx:186`) confirma que o documento existe → mensagem própria,
  sem eco.
- Edges: `omie-cliente` `pesquisar_clientes`/`consultar_cliente` devolvem PII de qualquer cliente Omie a qualquer staff;
  `analyze-unified-order:523` lê `email, phone` sem usar.

