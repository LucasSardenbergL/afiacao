# Radar, Frente 5: situação na Receita fora do Radar (ficha do cliente e pedido)

> PR: (este). Bloco seguinte ao #3212 (situação cadastral no Radar). Origem: brainstorm Codex + Fable, frente 5 de 5 paralelas. Só alerta: nada bloqueia pedido.

## O problema

O Radar já grava a foto mensal da Receita (RFB) de todo CNPJ conhecido em `radar_situacao_cadastral`, e o lote 2026-10 contou **2.981 clientes irregulares de 15.061 verificados** (`radar_ingest_state.situacao_resultado`). A informação só aparecia dentro do Radar, que é tela de gestor. Quem vende a prazo (o vendedor, no wizard de pedido) e quem abre a ficha do cliente não viam nada.

Restrição de acesso: a policy da tabela é `pode_ver_carteira_completa` (gestor/master) e **não se afrouxa** (a frente 2 é dona dela). O vendedor precisa ver o selo dos clientes da carteira dele.

## Medido antes de escrever (psql-ro, 2026-10-29)

- Documento por cliente: `profiles.document`, 1 por `user_id`. `omie_customer_account_map.evidence_document_normalized` diverge de `profiles.document` em **0 de 16.122** linhas; `profiles.cnpj` é NULL em 100%. Logo a RPC lê só `profiles.document`.
- Lotes na foto: 2026-09 (~566k linhas) e 2026-10 (~576k). Marcador de publicação: `radar_ingest_state` (`status='complete'` + `situacao_aplicada_em`); os chunks gravam a foto **antes** do finalize, então `max(lote)` da foto pode ser um lote em carga.
- Donos: `radar_situacao_cadastral` é do `postgres` (`rolbypassrls=t`), RLS ligada, sem FORCE.

## O que entrou

1. **Migrations `20261029200343_cliente_situacao_receita.sql` (v1) e `20261030000642_cliente_situacao_receita_lote_publicado.sql` (v2, a viva)**: RPC `public.cliente_situacao_receita(p_customer_user_id uuid)`, `SECURITY DEFINER`, `search_path` fixo (`pg_catalog, public, pg_temp`), `REVOKE` de `PUBLIC` e de `anon`, `GRANT` a `authenticated` e `service_role`.
   - Escopo = o do vizinho `get_scores_margem`: `private.cap_carteira_ler(uid) OR private.carteira_visivel_para(cliente, uid)`. O gate roda antes de qualquer leitura. Fora dele: `42501` com `HINT 'fora_da_carteira'` (o discriminador que o front casa); user_id inexistente recebe a mesma recusa.
   - Devolve **exatamente 1 linha**: `estado` ∈ `irregular` (03/04/08) · `ativa` (02) · `outra` (01 ou desconhecido; `situacao` preservada) · `sem_dado` (CNPJ válido sem linha) · `sem_cnpj` (CPF/lixo) · `sem_documento`.
   - Linha do lote **publicado** mais recente do CNPJ (`lote <= lote_vigente`); `confirmado_no_vigente` separa "situação no último lote publicado" de "último registro histórico". **Publicado** (v2) = `complete` **e** `situacao_aplicada_fechamento = finalizado_em`, a chave da aplicação da situação (20261027010000): num reprocessamento o finalize troca o `finalizado_em` e preserva `situacao_aplicada_em`, então o filtro da v1 contava o mês como publicado antes de a situação nova ser aplicada. Sem lote publicado: `55000` com `HINT 'sem_lote_publicado'` (o front mostra "indisponível"); a v1 liberava qualquer lote nesse caso.
   - A v2 segue o molde TRAVA → PRE → CREATE → PÓS: a PRE exige o md5 **exato** do corpo vivo ∈ {v1 lido da PROD `4dc173d4…`, a própria v2 `1ab61f8b…`}; a prova confere que o banco calcula os dois md5 a partir dos arquivos.
   - Casamento de CNPJ espelha `radar_docs_clientes()` (dígitos ∪ alfanumérico cru ou com a máscara exata), sem varrer a base.
   - Postcondição com 7 predicados, inclusive **POS7**: o dono da função atravessa a RLS da tabela (BYPASSRLS, ou dono da tabela sem FORCE). Sem isso o vendedor veria sempre `sem_dado`, um "nada consta" falso.
2. **Front, módulo plataforma** (ficha = farmer-inteligencia e pedido = vendas consomem o mesmo contrato, sem aresta nova entre módulos):
   - `src/lib/receita/situacao-cliente.ts`: `interpretarRespostaSituacao` (0/2+ linhas ou estado desconhecido = erro de contrato, nunca `sem_dado`; `42501` sem o HINT = erro, não "sem acesso") e `seloReceita` (texto só para irregular; lote velho vira "Último registro na Receita…").
   - `src/lib/receita/useSituacaoReceitaCliente.ts`: chave com o usuário real + cliente, sem `placeholderData`; erro de contrato sem retry.
   - `src/components/receita/SeloSituacaoReceita.tsx`: selo warning para irregular; **linha neutra "indisponível" em erro e offline** (no pedido: "confirme o CNPJ antes de vender a prazo"), porque silêncio seria lido como "nada consta"; fora da carteira = silêncio; no pedido, cliente sem cadastro vinculado diz "não consultada".
   - Ficha (`Customer360`): entre o hero e a faixa de KPIs. Pedido (`UnifiedOrder`): no passo de cliente, junto do alerta de crédito.
3. **Sensor**: `cliente.situacao_receita_lida` `{superficie, estado}` 1x por (superfície, cliente) montado, com o desfecho (estados da RPC + `sem_acesso`, `erro`, `erro_contrato`, `offline`, `sem_vinculo`). É o denominador. `cliente.situacao_receita_irregular_exibida` `{superficie, situacao, confirmado}` quando o selo aparece. Sem CNPJ nem motivo na telemetria.

## Provas

- **PG17 `db/test-cliente-situacao-receita.sh`** (no `nucleo-ci.txt`, `20 falsificar=21`; aplica a v1 como em prod e depois a v2), executando sob `SET ROLE authenticated` + GUC `test.uid`, com o **corpo real** de `carteira_visivel_para` extraído da migration que o define e movido para `private`, como em prod. Cobre dono elegível, `eligible=false`, cobertura ativa/expirada/inativa, gestor, sem identidade (42501 **sem** o HINT), anon, RLS de gestor intacta (SELECT direto do vendedor = 0), os 6 estados com 1 linha cada, 04→02 tira o selo, lote velho com `confirmado=false`, lote em carga ignorado, reprocessamento não publicado (A15), sem lote publicado = 55000 (A14), PRE anti-deriva da v2 (A16), e o espelho **por documento** contra `radar_docs_clientes()` viva em 11 formatos (máscara, cru, alfanumérico, minúscula, espaços, CPF, o CPF-com-sufixo permissivo herdado, lixo).
- Falsificação: controle verde e **21/21 sabotagens vermelhas**, cada uma no assert dela, nos **dois** locales (`LC_ALL=C` e `pt_BR.UTF-8`). Pares com e sem a postcondição (uma camada por vez): gate aberto, sem HINT, ACL aberta, SECURITY INVOKER, dono sem bypass, leitura sem lote vigente e reprocessamento como publicado são pegos pela POS e também pelo assert executado. As sabotagens de ACL agem na v1: `CREATE OR REPLACE` preserva o ACL, então sabotar só o REVOKE da v2 não mudaria nada (seria teatro). O md5 do corpo da v1 no harness é `4dc173d4…`, igual ao lido da PROD.
- Vitest: `src/lib/receita/__tests__/situacao-cliente.test.ts` (contrato e texto) e `src/components/receita/__tests__/SeloSituacaoReceita.test.tsx` (hook real: estados, recusa, 42501 sem HINT, contrato, offline sem e COM cache vencido, troca A→B com B lento, A→B→A sem recontar, sensores sem CNPJ). Os consertos de front do Codex de código foram falsificados (sabotados → vermelhos nos testes certos → restaurados).

## Codex

- **Desenho** (`gpt-6-astra`, max, 331 s): 2 ALTOS, ambos incorporados: (1) irregular de lote velho apresentado como situação atual → `lote_vigente` publicado + `confirmado_no_vigente` + "Último registro…"; (3) falha no wizard virando silêncio → linha "indisponível" em erro e offline. MÉDIOS incorporados: marcador de publicação em vez de `max(lote)`; `42501` só conta como recusa com discriminador (HINT); 0/2+ linhas = erro de contrato; POS7 + prova executada como vendedor com a RLS de pé; espelho provado por documento; troca de cliente sem dado anterior; denominador por (superfície, cliente) com desfecho. BAIXOS: sem oráculo relevante no gate; 01 fora do selo.
- **Código** (`gpt-6-astra`, max, 250 s): 2 ALTOS, 1 MÉDIO e 2 BAIXOS, todos procedentes e corrigidos. ALTO 1: offline **com cache vencido** mostrava o cache como leitura nova → pausada conta como indisponível mesmo com dado. ALTO 2: sem lote publicado a RPC liberava qualquer lote → v2 recusa com `55000`. MÉDIO 3: reprocessamento contava como publicado cedo demais → v2 usa a chave de fechamento. BAIXO 4: `irregular_exibida` disparava com o selo escondido por erro → o selo só existe quando a leitura vale. BAIXO 5: A→B→A recontava → dedupe por conjunto. Ele confirmou que, no `UnifiedOrder`, o selo desmonta durante `loadingCustomer` e o token de seleção impede vazamento entre clientes.

## Camadas de deploy (quem faz o quê)

| Camada | Estado | Quem |
| --- | --- | --- |
| Migration `20261029200343` | ✅ **APLICADA** em 2026-10-29 por `db:aplicar` (pré-voo: nome ausente em 182 worktrees, na main e em prod; ensaio com ROLLBACK verde; tentativa **#764** virou recibo, sha256 `fb823190…`). 2ª testemunha psql-ro em outra conexão: `secdef=t`, `search_path=pg_catalog, public, pg_temp`, dono `postgres` `bypass=t`, `anon=f public=f auth=t service=t`, gate no corpo, policy `radar_situacao_cadastral_select_gestor` inalterada | sessão |
| Migration `20261030000642` (v2) | ✅ **APLICADA** em 2026-10-30 por `db:aplicar` (ensaio com ROLLBACK verde; tentativa **#767** virou recibo, sha256 `e0508bdc…`). 2ª testemunha psql-ro: corpo md5 `1ab61f8b…` (o provado), `secdef=t`, `search_path` fixo, dono `postgres` `bypass=t`, `anon=f public=f auth=t`, lote vigente em prod `2026-10` | sessão |
| Publish do Lovable (selo na ficha e no pedido) | pendente após o merge | founder (Publish) |
| Edge | nenhuma | — |

## Follow-ups (não feitos aqui)

- **Bloquear pedido a prazo para CNPJ irregular**: decisão do founder (hoje só alerta). O sinal para decidir é **query**, não telemetria: pedidos a prazo criados para clientes cujo CNPJ estava irregular no lote vigente da data do pedido (`sales_orders` × `radar_situacao_cadastral`).
- **Cliente Omie sem cadastro no app** (sem `user_id`): o pedido diz "não consultada". Ler por documento exigiria outro gate (não há carteira sem `user_id`).
- **Venda fora da carteira** (vendedor atendendo cliente de outro): recusa silenciosa por desenho. O sensor conta `sem_acesso`; se for frequente, discutir um escopo de "pedido em andamento".
- **Ledger autenticado**: o sensor está só no `track()` (censurável). Adicionar evento ao `analytics_ledger_registrar` exige recriar a função quente (molde TRAVA→PRE, várias sessões mexendo); fica para quando houver fase N+1 que dependa do uso do selo.

## Lições

- **SECURITY DEFINER não prova bypass de RLS**: quem atravessa é o DONO. A postcondição tem de ler o dono (`rolbypassrls`/FORCE), e a prova tem de executar como vendedor com a policy de pé; `prosecdef=true` sozinho aprovaria uma função que devolve sempre "sem dado".
- **42501 não é uma resposta só**: o mesmo SQLSTATE sai de recusa deliberada e de privilégio faltando numa dependência. Recusa que o front trata como "normal" precisa de discriminador próprio (HINT), e o resto é erro.
