# Gate v2 em modo SOMBRA + sensores (crédito-IA, PR 5 — 2026-11-25)

Programa: spec `docs/superpowers/specs/2026-11-20-credito-ia-design.md` · plano detalhado `docs/superpowers/plans/2026-11-25-credito-ia-pr5-sombra.md` (com a revisão pós-Codex).

## O que o banco mostrou (psql-ro, 2026-11-25)

- **O app quase não cria pedido.** Em 120 dias, 2 pedidos nasceram no app (um deles teste de R$ 1,70); `credito_operacao_revisao` e `venda_bloqueio_credito_log` estão vazios desde o PR 3 e desde sempre. Nos últimos 14 dias foram **176 PVs, R$ 213 mil, 106 clientes, todos importados do Omie** (oben 142 / R$ 200 mil; colacor 34 / R$ 13 mil). Uma sombra pendurada só no `criar_pedido` mediria ~0 pedidos em 2 semanas.
- 100% desses 176 resolvem para um par com dono único no mapa. Nas últimas 24 h, 21 de 26 PVs já chegaram **faturados** na 1ª leitura do pull (que roda a cada 2 h).
- O vínculo PV→título existe: `fin_contas_receber.numero_pedido = sales_orders.omie_numero_pedido` na mesma empresa. Faturados de 30 d com título: oben 65%, colacor 89% (o resto é CR ainda não sincronizado ou venda sem CR).

**Decisões do Lucas (2026-11-25):** a sombra mede importados **e** app; redução automática de limite + backtest IA × regra ficam numa **fatia 5b**, depois do merge do PR 4.

## O que mudou

| Camada | Depois |
|---|---|
| Migration `20261125195900_credito_sombra_indices.sql` | os 2 índices do vínculo PV→título, **numa transação à parte**: o lock do `CREATE INDEX` dura até o COMMIT, e junto da sombra travaria `sales_orders` durante a carga (Codex diff P1) |
| Migration `20261125200000_credito_gate_v2_sombra.sql` | ledger `credito_sombra_*` (marco, inventário congelado, lote, decisão, tentativa, reserva) com RLS de gestor e a guarda/portão do PR 2; avaliador `private.credito_sombra_avaliar` (só lê); lote `private.credito_sombra_lote` pelo pg_cron a cada 10 min (`3-59/10`); views `credito_sombra_pv_atual` e `credito_sombra_saude` (`security_invoker`, legíveis pelo `claude_ro`) |
| Edge | **nenhuma** — `omie-vendas-sync` não muda |
| Front | **nenhum** — sem Publish |

A lógica da sombra (o que o PR 6 vai promover a efetivo) acrescenta ao núcleo do PR 2: frescor/cobertura do sync de CR por empresa (§9.5), título do próprio PV fora da soma, reserva de todo PV real com residual derivado e transferência só com título que a cubra (§9.2), PV do grupo não medido → 🟡, e prazo desconhecido → 🟡 `prazo_ilegivel` (nunca 🟢; a Colacor sem catálogo cai aqui), com a faixa "se o prazo fosse aceito" ao lado para calibrar.

## Por que a sombra não altera venda (provado)

Nada no caminho do pedido chama a sombra. Ela não escreve em tabela do gate efetivo, não toma o lock de grupo do núcleo nem o da aprovação, e não toca `private.credito_avaliar_reservar` nem `venda_gate_credito_grupo` — a pós-condição aborta a migration se o corpo ou o ACL dos dois mudar (F8). Na prova, um lote aberto numa 2ª sessão não segura nem o piso nem o lock de grupo (`statement_timeout 1s`). Erro num PV vira tentativa e o lote segue.

## Prova

`db/test-credito-sombra.sh` (PG17, banco criado em `C` **e** `pt_BR.UTF-8`): banco-modelo com as 7 migrations reais de prod; cada rodada clona o modelo e aplica as 2 migrations (a da sombra real ou sabotada). **153 asserts** e **12 sabotagens** vermelhas pelo motivo certo, com controle verde na mesma invocação e re-prova estrita no fim: sem veto de sync, full basta, título do PV soma (inteiro ou sem `least`), transfere sem título, transferida definitiva, `deleted_at` libera, sem sub-bloco, desconto duplo do título, irmão sem conferir a versão, app reduz antes do Omie, e piso alterado → pós-condição aborta com rollback. A query de medição roda dentro da prova **como `claude_ro`**.

A pós-condição pegou na 1ª rodada um furo real: as views nasciam com o default ACL do Supabase (ALL para `authenticated`, INSERT para `sandbox_exec_*`). Fecho por allowlist também nelas.

**Codex** (gpt-6.2-astra high): desenho com 1 P0 + 6 P1 + 1 P2, todos acatados (o principal: a sombra não toca o núcleo). Diff com 13 P1 + 4 P2, acatados salvo um: drenar as revisões intermediárias do app entre dois lotes. A reserva segue a versão corrente e o app cria ~0 pedidos; fica declarado. Os acatados: índices fora da transação, candidatos limitados na consulta e `statement_timeout` no cron, app sem reduzir a reserva antes do Omie, cobertura do irmão pela versão corrente (inclusive faturado e excluído no app), transferida relida por 120 d, `least` no título próprio, PAGTO PARCIAL sem saldo → indeterminado, app sem revisão → tentativa, orçamento pré-ativação entra ao virar venda e `pendente` fica fora, `claude_ro` lê a medição, critério pelo histórico imutável e pela cadência de lotes, A → B ilegível tira o PV da distribuição, reaplicação com importado retrodatado, pós-condição por assinatura e com ACL default expandido, marca futura de 1 min, coorte pelo 1º status e re-prova estrita.

## Quando medir

`~/.config/afiacao/psql-ro -X -f db/medir-credito-sombra.sql` — a seção 0 dá `criterio_2_semanas` pelo histórico imutável: ≥ 14 d desde a 1ª decisão nova, nenhum buraco > 1 h entre lotes, último lote < 30 min e nenhum PV de venda sem observação. A seção 7 mostra a saúde (minutos sem lote, erros 24 h, carga pendente). Enquanto `credito_limite` estiver vazio, tudo que passa do piso, da identidade e do sync cai em 🟡 `sem_limite` — é o esperado até a 1ª leva do PR 4.

## Fora do PR 5 (declarado)

Redução automática + backtest → fatia 5b (após o PR 4). Condições de ativação herdadas dos PRs 2/3 (lock no escritor do mapa, retomada e despacho por revisão, tint/ATP antes da reserva) → PR 6. Esta prova não entrou no núcleo do CI, como as dos PRs 1–3.

## Deploy (2026-11-26)

- **Migrations**: `bun run db:aplicar` a partir da main mergeada (#4192 → `c39f1f5a5`), com ensaio verde antes de cada uma. Índices: **`db_aplicacoes` #1439 `aplicada`** às 02:25:25Z (sha256 `99c17724…`). Sombra: **#1441 `aplicada`** às 02:26:14Z (sha256 `b5ba9c70…`), com `POSCONDICAO credito-sombra OK`.
- **2ª testemunha** por psql-ro:
  - 6 tabelas `credito_sombra_*` com RLS e as 2 views com `security_invoker`;
  - 7 funções sem EXECUTE para anon/authenticated/service_role;
  - nenhuma escrita fora do dono;
  - cron `credito-sombra-lote-10min` ativo como `postgres` (`3-59/10`);
  - md5 do núcleo e do piso inalterados (`3bd62a20…`, `e89aa733…`);
  - marco 02:26:14Z, inventário = 32.545 PVs (122 abertos).
- **1º lote** (02:33Z, 6 s): 78 PVs da carga inicial avaliados, 0 erros, 22 pulados como `revisao_ausente` (PVs antigos do app, anteriores ao PR 3) e 1 sinal de sobra (44 da carga para o lote seguinte). 78 reservas sombra ativas, R$ 56,8 mil. Distribuição da carga:

| Faixa / motivo | PVs | R$ |
|---|---|---|
| 🔴 `piso_vencido_60d` (oben 31, colacor 10) | 41 | 33,4 mil |
| 🟡 `sem_limite` (colacor 23, oben 14) | 37 | 23,4 mil |

  O piso domina a carga: mais da metade dos PVs em trânsito é de cliente com vencido ≥ 60 d no grupo. Vale olhar no PR 6 se esses "importado/separacao" são trânsito real ou status parado. O sensor `excluido_app_reserva_ativa` = 13 (PVs excluídos no app que seguem com reserva, como o desenho manda).
- Sem edge e sem Publish.

## Follow-up: `carga_pendente` sem os não avaliáveis (2026-11-26)

Na 1ª leitura da medição, a `carga_pendente` da saúde estava em **22 fixo**. Eram os 22 PVs antigos do app, anteriores ao PR 3, que o lote já tinha observado como `revisao_ausente`. Eles nunca drenariam, e o sensor parecia carga travada. A migration `20261126130000_credito_sombra_saude_carga_pendente.sql` redefine só a view (mesmas colunas, `security_invoker` repetido, ACL preservado):

- PV da carga com tentativa **não-erro** sai da conta.
- PV com tentativa só de **erro** continua na conta, mesmo depois das 3 tentativas: é defeito real, e a `erros_24h` esquece depois de 24 h.

Prova: S8 em `db/test-credito-sombra.sh`, mais as sabotagens F13 (view antiga) e F14 (erro contado como observado). A migration roda em toda rodada da suíte e é reaplicada no A1b. Resultado: **164 ok / 0 fail** em `C` e `pt_BR.UTF-8`, com as duas sabotagens vermelhas no S8.2 e a re-prova verde.

## Como reverter

`SELECT cron.unschedule('credito-sombra-lote-10min');` para parar. Remover de vez: `DROP` das 6 tabelas, 2 views e 7 funções `credito_sombra_*` (os 2 índices podem ficar) (founder, SQL Editor). Nenhuma decisão de venda depende delas.
