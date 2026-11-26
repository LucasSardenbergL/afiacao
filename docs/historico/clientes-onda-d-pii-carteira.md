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
