# Onda D — PII de contato do cliente só na carteira (opção "c" + contexto operacional)

Status: desenho aprovado em direção (founder: opção 2 "contexto operacional", 2026-11-24); Codex challenge rodado
(gpt, `-r high`, P0/P1/P2 integrados abaixo). Implementação em 3 fatias.

## Regra

| Operação | Quem |
|---|---|
| Identidade (nome, razão social, cidade/UF, dono da carteira) | self exato OU chamador staff — qualquer cliente |
| Contato (`profiles.document/cnpj/phone/email`, `addresses` exceto cidade/UF, `customer_contacts`, snapshots `sales_orders.customer_document/address/phone`) | self exato OU staff com: gestão (`pode_ver_carteira_completa`) OU atribuição própria **elegível** na raiz fiscal OU cobertura vigente |
| Contato no contexto operacional (pedido, expedição, rota, aprovação) | staff, via RPC que recebe o OBJETO (pedido/rota/aprovação), valida no servidor que o objeto é do cliente, devolve campos mínimos e grava o acesso no ledger |
| Registrar desfecho / agir | staff atual com atribuição própria elegível na raiz fiscal (`pode_agir_no_cliente`). Cobertura lê, não age. |
| Customer | inalterado (self exato, sem expansão por alias) |

## Fatos de prod que moldam o desenho (psql-ro, 2026-11-24)

- 3 staff: master (dono de 12.701 clientes elegíveis), 1 farmer (2.832), 1 back-office sem carteira/papel. Cobertura ativa: 0.
- `profiles`/`addresses`/`customer_contacts`: SELECT broad-staff; owner `postgres` (BYPASSRLS); sem `attacl`.
- `carteira_assignments`: 1 dono por cliente elegível; clones de alias são `eligible=false`. `customer_canonical_alias` 1.633 ativas.
- `venda_registrar_contato` gateia sem `eligible`; `AcoesDaFicha` gateia sem alias — divergência; `venda_contato` tem 0 linhas.
- ~35 leitores no front leem PII de cliente fora da carteira (mapa na seção "Leitores").

## Mecanismo (Codex P1: grant de coluna > RLS por linha)

- `profiles`: `REVOKE SELECT` de tabela + `GRANT SELECT(<não-PII>)` a `authenticated`/`anon` (precedente 20261014120100). Leitor antigo quebra com 42501 (alto), não some com linha (silencioso).
- PII volta por view `security_invoker=off, security_barrier=true` mascarada com flag `contato_visivel`; `REVOKE ALL` dos 3 papéis e re-`GRANT SELECT` só a `authenticated` (Codex P0-4).
- `addresses` / `customer_contacts`: policies por comando, substituindo as antigas no mesmo corte (permissivas se somam por OR). Escrita em contatos = regra de agir/gestão no INSERT `WITH CHECK` e UPDATE `USING`+`WITH CHECK`.
- Predicados: conjunto visível calculado 1× por consulta (semijoin; precedente `docs/historico/rls-carteira-visibilidade-por-conjunto.md`), EXISTS indexado no pontual. Escritor exige `IS TRUE`.
- Alias: canonicaliza os dois lados; atribuição `eligible=false` nunca concede; raiz ambígua (2 donos elegíveis, cadeia) **não** amplia. Self não expande por alias.
- Sem ramo "alvo é colega" no helper de clientes (liberaria documento/endereço do colega) — diretório de equipe é outra superfície.

## Fatias

1. **Contrato novo, sem fechar nada** — predicados, `pode_agir_no_cliente` (+ escritor do desfecho + `AcoesDaFicha`), ledger de acesso (RLS, 1 writer, só referência), RPC operacional por objeto, view mascarada, RPC do Cmd-K; front: 360 (`useCustomerCore`), Cmd-K (sem staff, sem doc/e-mail fora do escopo, erro visível, recentes por usuário só id+nome, limpa chave v1).
2. **Migrar os leitores** para o contrato (lista abaixo), Publish, conferir adoção do build pelos 3 staff.
3. **Corte** — REVOKE de coluna, policies, RPCs/views/edges que ainda entregam contato. Só aqui o "Pronto" vale. Prova pela API com query real.

## Superfícies que precisam fechar no corte (Codex P0-1)

- `customer_metrics_mv` (view pública projeta `document` a qualquer employee).
- `sales_orders.customer_document/customer_address/customer_phone` (grant explícito).
- Views invoker `v_grupo_comercial`, `v_grupo_contatos`, `v_caca_candidatos`, `v_caca_compradores` (join por documento — não trocar por NULL, zeraria faturamento de grupo) e `v_grupo_contas_receber_por_doc` (devolve `m.documento`).
- RPCs: `listar_clientes_base` (busca/ordena/conta por campos sensíveis), `resolver_cliente_por_telefone` (contato_nome/cargo; o chamador já tem o número — telefonia ring-all: devolve identidade, decisão registrada), `cobranca_regua_hoje`, `carteira_por_municipio` (gestor/master — conferir vivo), radar.
- Edges: `omie-cliente` (`pesquisar_clientes`/`consultar_cliente` devolvem CPF/CNPJ/e-mail/telefone/endereço a staff; `buscar_por_documento` público é oráculo de existência), `mcp` (JWT do usuário).
- Busca/ordem/contagem: termo que só casa no contato oculto deve responder igual a termo ausente (Codex P0-2).

## Casos de borda decididos

- **Telefonia** (`resolve-customer.ts`): resolve pelo número via RPC; vincula só se o candidato está na carteira de quem liga; fora dela vai para conferência (degrada seguro). A RPC devolve identidade, nunca o contato.
- **Pedido**: documento para o Omie resolvido no servidor a partir do `customer_user_id`; endereço de entrega pela RPC operacional vinculada ao pedido.
- **Signup** (anon `.eq('document')`): hoje já não enxerga linha alheia; no corte, unicidade no servidor e resposta pública uniforme.

## Leitores (varredura Fable, 2026-11-24)

Classe A (precisam de PII fora da carteira → RPC operacional ou máscara): Cmd-K, 360, novo pedido (`useCustomerSelection`, `useUnifiedOrder`), detalhe/impressão de pedido (`useSalesOrderDetail`, `useAdminOrderDetail`, `Admin.tsx`, `SalesPrintDashboard`), roteirizador (`useRoutePlanner`), `FarmerCallsPendingLink`, aprovações, UTI, Prime, previsão de demanda, AI Ops, `useBuscaClienteOmie`, `lib/mcp/tools/search-customers`. Classe B (só carteira): lista de clientes por escopo, Meu dia, rota/ligação, farmer scoring, propostas. Leitores de perfil de staff (Governance*, departamentos) e self ficam fora da regra de cliente.
