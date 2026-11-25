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
