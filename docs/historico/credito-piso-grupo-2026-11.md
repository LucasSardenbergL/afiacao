# Trava de crédito vê o grupo inteiro + fail-closed (crédito-IA, PR 1 — 2026-11-20)

Programa: `docs/superpowers/specs/2026-11-20-credito-ia-design.md` · plano `docs/superpowers/plans/2026-11-20-credito-ia.md`.

## O furo (medido em prod, psql-ro, 2026-11-20)

`venda_gate_credito` olhava só o PAR do pedido `(company, omie_codigo_cliente)`. Cliente com vencido
> 60 d na Colacor SC comprava na Oben sem trava. Em 90 dias: **93 pedidos, 26 clientes, R$ 143.507**
enviados/faturados numa conta do grupo para cliente com vencido > 60 d em OUTRA (só vínculo direto
user↔código; aliases fiscais podem somar mais). 125 clientes mapeados com vencido > 60 d.

## O que mudou

| Camada | Antes | Depois |
|---|---|---|
| SQL | `venda_gate_credito(company, codigo, pedido)` | `venda_gate_credito_grupo(pedido, company, codigo)` + `credito_grupo_pares(user)`: a RAIZ é o dono do par comprovado no mapa (nunca o UUID do pedido — pode ser o do vendedor); canônico + aliases `active`; `inactive`/`conflict` não expandem; devolve `pares[]` |
| Edge, gate mudo | liberava com log `gate_indisponivel` | **segura**: erro retentável "Verificação de crédito indisponível — tente de novo em instantes." (erro, não `blocked` novo: bundle antigo trata erro como falha) |
| Edge, edição | gate só se o total sobe; sem `codigo_cliente` liberava com log | também se a **parcela muda** (`edicaoExigeGate`); sem `codigo_cliente` no consult → **segura** |
| Ingestão CR | `valor_documento \|\| 0` | só número/string decimal; sem valor legível → não grava (log); modo estrito lança |
| Tela | "R$ X vencido" | "vencido no grupo: Colacor SC R$ 500,00 · Oben R$ 150,00" |

Exceção continua por (pedido, par do pedido) e libera a dívida do grupo que o gestor vê no painel
(lista os pares — também no fluxo remoto, lidos do `detalhe` do log). Exceção criada ANTES do marco
`credito_virada_grupo.aplicada_em` (gravado quando a migration é aplicada) foi aprovada vendo só o par
→ **não** cobre dívida de outra empresa (`motivo='excecao_anterior_nao_cobre_grupo'`).
A v1 `venda_gate_credito` fica no banco.

Titularidade dos aliases (psql-ro 2026-11-20): 1.633/1.633 `active` têm o MESMO documento do profile
do canônico; nenhum alias tem par próprio no mapa nem título fora dele → a expansão por alias não
transfere dívida entre titulares hoje.

## Risco residual aceito (review Codex P2)

Sync de CR **não estrito** com título sem valor: o título é pulado só com `console.warn` — um título
novo fica invisível e um existente mantém o saldo antigo até o próximo retrato estrito. Hoje há **0**
títulos assim em prod; se aparecer, persistir pendência e condicionar `full_ok` (não feito aqui).

## Ordem de deploy (OBRIGATÓRIA)

1. **Migration `20261121120000_trava_credito_piso_grupo.sql`** — SEM ela a edge nova falha fechado
   e **segura toda venda**.
2. Edges `omie-vendas-sync` (v1.41) e `omie-financeiro` (v1.12).
3. Publish (front: mensagem por empresa).

## Rollback

Edge volta a chamar `venda_gate_credito` (a função v1 está intacta). Não há dado a desfazer.

## Prova

- PG17 `db/test-trava-credito-piso-grupo.sh`: 31 asserts × 2 (controle + re-prova) + 6 falsificações, em `C` e `pt_BR.UTF-8`.
- Deno `gate-credito_test.ts` (13) + 5 sabotagens vermelhas com controle verde; `mapear-titulo_test.ts` (7).
- vitest: invariantes da edge (lê `index.ts` + `gate-credito.ts`), paridade de vocabulário nas 2 migrations, submit com pares.

## Quando medir

24 h após o deploy: `select acao, count(*), count(*) filter (where detalhe not like '%' || company || '/' || omie_codigo_cliente || '=%') as so_outra_empresa from venda_bloqueio_credito_log where created_at > now()-interval '24 hours' and detalhe like 'pares:%' group by 1;` — `so_outra_empresa` > 0 = o furo sendo fechado (bloqueio que a v1 não faria); `gate_indisponivel` > 0 = investigar (agora segura venda).
