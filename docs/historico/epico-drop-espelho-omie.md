# Épico-drop do espelho `omie_clientes`

Aposentar a tabela-espelho `omie_clientes` e passar identidade Omie↔user a resolver pela **proof**
(`omie_customer_account_map` / view fresca `omie_customer_account_map_fresco`). Registro das fatias
entregues, com a validação em produção. Regras vivas do domínio: [database.md](../agent/database.md) §5 e
[money-path.md](../agent/money-path.md).

## Por que o espelho não serve como fonte de identidade

Medido em prod (psql-ro, 2026-07-16):

- `omie_clientes` é **UNIQUE(user_id)** → 1 linha por user, **sobrescrita pelo writer da vez**;
- `empresa_omie = 'colacor'` em **6.909/6.909** linhas — é o DEFAULT, nunca populado por writer nenhum.

Ou seja, o rótulo de conta é mentiroso e o código guardado é de conta **indeterminada**. Quem lê o
espelho para resolver "código Omie → user" pode anexar a coisa ao cliente errado. A proof é
`UNIQUE(user_id, account)` + `UNIQUE(omie_codigo_cliente, account)`, então sabe a conta de cada código
(e `.maybeSingle()` é seguro).

**A view fresca é a base filtrada por `updated_at >= now() - 7 dias`.** Ela é reabastecida por cron
diário (`sync-customers-vendas-daily` 05:00 UTC · `sync-customers-colacor-vendas-daily` 05:20 ·
`sync-customers-servicos-daily` 05:40 · `sync-products-customers-daily` 06:00) — todos batendo no
`omie-analytics-sync`. Se esses crons pararem ~7 dias, **a view esvazia** e uma consulta bem-sucedida
com zero linhas não acusa erro nenhum: é o cenário que fabrica clientes duplicados em massa.

## Fatias entregues

| Fatia | PR | O que mudou |
| --- | --- | --- |
| 3-edges PR-A | #1364 | 3 LEITORES do `omie-cliente` (`criar_perfil_local`, `sync_all_clients`, `sync_addresses`) saem do espelho → proof fresca account-correta |
| 3-edges PR-B | #1367 | leitor do `omie-analytics-sync` (`fetchAllOmieClienteCodigos`) idem, por conta |
| Hardening P1 | #1425 | fecha a PORTA que o PR-A deixou aberta (abaixo) |

A conta de cada leitor saiu do **chamador**, não de presunção — as credenciais do edge enganam
(`callOmieApi` usa colacor_sc, mas não é ela que decide): `criar_perfil_local` → `oben`
(`useUnifiedOrder` resolve o mesmo código com `.eq('account','oben')` antes de invocar);
`sync_all_clients` → conta do `account_index`; `sync_addresses` → multi-conta, usa o account de cada
linha da proof.

## O hardening (#1425) — trocar a fonte não bastava

O PR-A trocou a FONTE do dedup e deixou de pé a porta que fabricou os placeholders **que já estão no
banco**. Aritmética que o Codex (xhigh) expôs, medida em prod 2026-07-18:

```
profiles reais:        5.276   ← o profileByDoc lia SEM paginar → via 1.000 (19%)
users na proof:        5.276
espelho total:         6.909
clones sem profile:    1.633   ← 6.909 − 5.276
```

Para os 81% de perfis fora da janela de 1.000, o dedup por documento devolvia `undefined` e o handler
criava um usuário Auth **novo** para quem já tinha cadastro. E como o supabase-js devolve `{ error }`
em vez de lançar, os inserts falhos passavam mudos — o contador ainda somava "importado".

Oito fixes: `paginarProfilesComDocumento` (keyset, usada pelos dois dedups) · `assertProofFrescaSaudavel`
(aborta se a cobertura por conta cair abaixo de 50% da base; a base entra só como **denominador**, nunca
como fonte de vínculo) · erros de insert contam e abortam o cliente · `upsertAddressFromOmie` devolve
`false` em falha de escrita · `sync_addresses` drena por offset (bastavam 30 "poison users" para o
`while (hasMore)` do caller girar para sempre) · prioridade de conta explícita no lugar da ordem
alfabética da consulta · proof vazia vira erro em vez de `200`/zeros · paginação das views deslizantes
de offset para keyset.

## Validação em produção (2026-07-18)

Deploy das duas edges pelo chat do Lovable, depois execução real pela tela `/admin/analytics-sync`:

| Métrica | Baseline | Depois | Leitura |
| --- | --- | --- | --- |
| **Clones** (espelho sem profile) | 1.633 | **1.633** | a fábrica está fechada |
| **Espelho** `omie_clientes` | 6.909 | **6.909** | não cresceu um registro |
| Órfãos criados | — | **0** | toda identidade nasceu com vínculo |
| Profiles | 5.276 | 5.668 | +392 clientes legítimos (documento inédito) |
| Users na proof | 5.276 | 5.668 | **== profiles**: invariante intacto |
| Endereços | 4.060 | 6.496 | `sync_addresses` drenou 2.052 → 8 pendentes |

Auditoria de qualidade nos 392: **0 documento duplicado entre eles, 0 documento que já existia antes,
0 órfão**. O `sync_all_clients` percorreu as contas e criou **zero** identidades — antes, com o dedup
enxergando 1.000 de 5.276, esse é o caminho que produziu os 1.633.

**Sinal para a Fatia 5:** o espelho ficou imóvel em 6.909 enquanto 392 clientes entravam pela proof.
Ele já é peça morta na entrada — só resta a herança.

## O que trava o DROP (Fatia 5)

Os **1.633 clones existem SÓ no espelho** e não têm linha na proof. Migrar os leitores restantes para a
proof zeraria silenciosamente quem opera sobre eles. Medido: alvos do `fetchAlvosSemProfile` =
espelho 1.633 · proof **0** · ledger 1.633 — mas o **ledger não tem `omie_codigo_cliente`**, então
trocar a fonte por lá zera `syncBackfillCadastro` e `mapaConsolidacao` sem erro nenhum.

⚠️ **Nunca deleção ad-hoc de `auth.users`**: o CASCADE cobre só 14 tabelas (59 pedidos + 836 endereços +
1.459 scores virariam uuid pendurado). Canonicalizar o histórico é decisão legítima de produto, mas
referência a referência, preservando `sales_orders.account`/proveniência ERP. Ver `database.md` §5.

## Fatia 4 (pendente) — os writers

Restam writers de `omie_clientes`: `omie-cliente` (3 inserts), `omie-analytics-sync:515` (upsert),
`omie-sync:372`, além de `Auth.tsx` e o par gate+writer do `AdminApprovals`. O `omie-analytics-sync:238`
(`fetchOmieClienteUserMap`) é a leitura-de-apoio do writer CODE-FIRST — par indivisível, migra junto.

## Lições

- **Trocar a fonte de um dedup não fecha a porta que ele guarda.** O PR-A estava correto e ainda assim
  levaria a fábrica de clones para produção; foi o Codex no money-path que pegou.
- **Zero linhas não é "nada a fazer" — é cegueira.** Consulta bem-sucedida e vazia é o pior desfecho de
  uma view com TTL: nenhum erro, e o dedup importa tudo de novo. Guard de cobertura antes de criar.
- **Keyset, não offset, em view deslizante.** Linha que expira entre páginas desloca as seguintes e o
  dedup pula códigos — código pulado vira cliente recriado.
- **Canária textual é regex sobre fonte: ela fica verde com o bug de pé.** O que dá confiança é a
  falsificação (14 sabotagens, cada guard exigindo vermelho), com detecção de sabotagem-que-não-aplicou
  — senão um regex furado do script vira falso "teatro".
- **"Deployar" e "rodar o sync" são passos distintos**, e a tela `/admin/analytics-sync` mistura cards de
  dois edges: os "Sincronizar Clientes/Produtos" do topo batem no `omie-analytics-sync` (escreve na
  **proof**); "Importar Clientes (3 Contas Omie)" bate no `omie-cliente/sync_all_clients` (escreve no
  **espelho**). Na hora de diagnosticar, é a tabela que recebeu a escrita que diz quem rodou.
- **Nenhum cron chama o `omie-cliente`** — aqueles dois botões são 100% manuais. O que se mantém sozinho
  é a proof.
