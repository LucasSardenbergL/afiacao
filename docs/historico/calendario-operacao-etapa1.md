# Calendário de operação — Etapa 1 (dezembro de 2026)

Spec: `docs/superpowers/specs/2026-11-18-calendario-operacao-design.md` · Plano: `docs/superpowers/plans/2026-11-18-calendario-operacao-etapa1.md`.

## O que entrega

- **Banco** (migrations manuais, nome custom — o Lovable NÃO aplica):
  - `20261119100000_calendario_operacao.sql` — tabelas `calendario_operacao_empresa` / `_fornecedor` / `_log` (RLS staff lê, master escreve, log por trigger), colunas `pedido_compra_sugerido.data_recebimento_prevista` / `recebimento_ajustado_calendario`, funções `calendario_proximo_dia_recebimento`, `calendario_somar_dias_uteis_fornecedor`, `calendario_dias_sem_nf`. Postcondição confere ACL (PUBLIC, anon, authenticated **e service_role** — sem ele a edge cairia no legado para sempre).
  - `20261119120000_calendario_antecipar_recesso.sql` — `calendario_antecipar_avaliacao` (lógica única), `calendario_itens_antecipar` (lista), `calendario_itens_antecipar_resumo` (avaliados/listados/sem dado) e `calendario_previsao_pedido` (prévia do recebimento antes do disparo). O estoque do "antecipar" soma físico + pendente Omie + **trânsito do app** com a regra do CTE `em_transito` do motor; SKU de grupo de equivalência sai com motivo próprio (unidade). Quem não lê compras (RLS de `pedido_compra_item` = master) recebe 42501 em vez de lista inflada.
  - Carga `db/carga-calendario-operacao-2025-2030.sql` (idempotente, NOTICE `POST carga calendario OK`).
- **Edge** `disparar-pedidos-aprovados` **v1.17**: dias úteis do `dDtPrevisao` pelo calendário do fornecedor; `data_recebimento_prevista`/`recebimento_ajustado_calendario` no update do desfecho; falha ⇒ legado inteiro (chaves ausentes do patch — testado em `previsao_test.ts`).
- **Tela** `/admin/reposicao/calendario`: grade, pendências (inclui emenda de feriado **municipal**), períodos de fornecedor, cartão "antecipar" com contagem ("N listados de M avaliados; K sem dados"). Lista de pedidos: "recebe em DD/MM (prévia)" para pendente/aprovado/bloqueado, "previsão indisponível" quando não dá para calcular.

## Ordem de deploy (quem faz: founder no SQL Editor + Lovable)

1. migration `20261119100000` → 2. migration `20261119120000` → 3. carga `db/carga-calendario-operacao-2025-2030.sql` (exigir o NOTICE `POST carga calendario OK`) → 4. deploy da edge `disparar-pedidos-aprovados` v1.17 → 5. Publish.

Edge antes da carga não quebra, mas grava "sem ajuste" falso em pedido de dezembro. Publish antes das migrations: a tela mostra "não foi possível carregar".

## Medição da Task 4 (o recesso não faz o motor recomprar) — 2026-11-18

- Fonte do pendente: `omie-sync-estoque` → `PesquisarPedCompra` (`lExibirPedidosRecebidos: "F"`), soma `max(0, nQtde − nQtdeRec)` só em `cEtapa = "15"`, janela pela **previsão** de hoje−365 a hoje+120 (`PEDIDOS_JANELA_PASSADO_DIAS = 365`). Previsão vencida não derruba o pendente.
- Casamento com o último run `reposicao_po_observado_run` (`884c200a…`, 2026-11-18 15:40:55 UTC, varredura completa, 25 pedidos lidos): **213** pedidos do app `disparado` há >15 dias (30/04–30/10/2026); **210** fora do run (já recebidos/fechados no Omie); **3** abertos no Omie (PO 1324, 1325, 1327), entrega vencida em **12–13/11**, os **3 contribuindo** ao pendente (5, 21 e 2 unidades); 0 aberto sem contribuição.
- Prova PG17: `db/test-calendario-acaminho-recesso.sh` (C1: no ciclo de 04/01 o pendente Omie segura o pedido disparado em 10/12).

## Limite conhecido

- **Se o sync falhar, a garantia não vale** (caso C2 da prova: PO fora da varredura ⇒ recompra, comportamento fixado com nome explícito). É risco de dado, não do recesso.
- A "costura de 1 dia" entre o corte do sync (hojeSP−7) e o do motor (`p_data_ciclo`−7) fica para sessão própria.
- O "antecipar" herda a mesma costura (usa a regra do motor com `p_hoje`).

## Aplicação em produção (2026-11-18)

Pelo `bun run db:aplicar` (ensaio com ROLLBACK verde antes de cada apply), a partir das cópias sem envelope `db/aplicar-calendario-operacao-{1-esquema,2-antecipar,3-carga}.sql` (idênticas às originais exceto `BEGIN;`/`COMMIT;` — o executor fornece a transação):

| Peça | sha256 (prefixo) | Tentativa/recibo |
|---|---|---|
| migration 20261119100000 | `9890393b` | #1173 |
| migration 20261119120000 | `6e092b70` | #1175 |
| carga 2025–2030 (NOTICE `POST carga calendario OK`) | `0c69b921` | #1177 |

2ª testemunha (psql-ro, `fim|ok`): 3 tabelas com RLS; 2 colunas em `pedido_compra_sugerido`; 6 RPCs com EXECUTE para `authenticated`/`service_role` e sem `anon`; empresa por origem OBEN/COLACOR = emenda 16/16 · escala 148/148 · feriado 34/34 · historico 33/26 · manual 12/12; fornecedor 616 linhas / 7 razões sociais; nacionais 10/ano em 2027–2030; recesso 18/12/2026–03/01/2027 com 11 dias úteis fechados e 04/01/2027 sem linha (aberto); Sayerlack fechada só 25/12 e 01/01. Pendentes: edge `disparar-pedidos-aprovados` v1.17 (ledger `pendencias:deploy`) e Publish.
