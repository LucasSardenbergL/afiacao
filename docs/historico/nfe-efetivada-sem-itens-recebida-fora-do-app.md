# NF-e efetivada sem itens: rótulo "Recebida fora do app" (plano v3, item 4)

**Data:** 2026-10-27 · **Só front** (sem migration, sem edge, sem backfill) · estoque/recebimento.

## Por que

NF-e com `status = 'efetivado'` e nenhuma linha em `nfe_recebimento_itens` apareciam na lista de recebimento e no histórico (`/admin/estoque/recebimento`) como **"0 itens"**. Abertas pela URL da conferência, mostravam **"0 de 0 unidades"** e **"Itens (0)"**. Isso afirma uma nota vazia, mas a nota tem mercadoria: o app é que não tem os itens (ausente ≠ zero). Decisão do founder (2026-10-21, respostas do plano v3, 🧭 #2): **rótulo "Recebida fora do app", sem backfill**. O backfill pelo Omie esbarra na trava anti-REDUNDANT do `omie-nfe-reconcile` e só se justificaria se a rastreabilidade de lote dessas NF-e fosse exigida.

## Remedição em prod (psql-ro, 2026-10-27)

O plano contou **26**. Hoje são **52 efetivadas + 1 `falha_efetivacao`** sem itens:

| `efetivado_at` (mês) | NF-e | `valor_total` do cabeçalho |
| --- | ---: | ---: |
| 2026-07 | 26 | R$ 133.205,15 |
| 2026-08 | 14 | R$ 57.369,85 |
| 2026-09 | 4 | R$ 14.167,31 |
| 2026-10 | 8 | R$ 2.298,88 |
| `falha_efetivacao` (2026-04) | 1 | R$ 4.204,63 |

- **Todas** com `conferido_at`, `origem` e `xml_completo` nulos, e `efetivado_at` no minuto `:10–:11` da hora, que é a assinatura do cron horário do `omie-nfe-reconcile`. Foram recebidas **direto no Omie** e o reconcile só fechou o status no app.
- **Nenhuma** depois do #3334 (a mais recente é de 2026-10-16) e a trilha `nfe_recebimento_manual_trilha` tem **0 linhas**: a aba Manual não gerou nenhum caso.
- As NF-e com itens começam em 2026-10-08, quando a importação passou a ser transacional (`importar_nfe_recebimento`, [nfe-recebimento-rpc-transacional.md](nfe-recebimento-rpc-transacional.md)). Desde então, cabeçalho e itens entram juntos. O estoque é **legado e fechado**.
- A diferença de 26 para 52 não é crescimento após o plano: 44 das 52 foram criadas até 2026-09-04 (a janela que o plano citou). A contagem do plano subestimou.

## O que mudou

- `src/lib/recebimento/itens-da-nf.ts` (puro): `situacaoItensNf(status, itens)` → `com_itens` · `recebida_fora_do_app` (efetivado sem item) · `itens_nao_carregados` (qualquer outro status sem item). Os textos do rótulo moram aqui.
- `src/components/recebimento/RotuloItensDaNf.tsx`: o badge `text-status-info` "Recebida fora do app" (com a explicação no `title`) e o aviso "Itens não carregados".
- `Recebimento.tsx` (lista e aba Histórico, que é a mesma tela com `statusFilter`): sem item, o card troca "N itens · X de N conferidos" pelo rótulo. O `valor_total` continua: é do cabeçalho fiscal, não é soma de item.
- `RecebimentoConferencia.tsx`: sem item, a barra "X de Y unidades" e o "Itens (0)" dão lugar ao rótulo e a um `EmptyState` operacional. O botão de finalizar já não aparecia (`canFinalize` exige item).

**Onde mais a NF-e efetivada aparece, e por que não muda:** os KPIs de `/admin/estoque/recebimento` e as zonas do dashboard (`useEstoqueZone`, `useBriefDeltas`) contam **NF-e**, não itens. Não há Fornecedor/Customer 360 que leia `nfe_recebimentos`.

## Prova

- Teste de estado da tela: `src/pages/__tests__/Recebimento.recebida-fora-do-app.test.tsx` (lista efetivada sem item, efetivada com item, pendente sem item, conferência por URL) e `src/lib/recebimento/itens-da-nf.test.ts`.
- Falsificação depois do commit, com controle verde na mesma invocação e nos dois locales (`C` e `pt_BR.UTF-8`). Sabotada uma camada por vez (a lista, a conferência e o helper), todas deram vermelho pela asserção certa: o `data-testid` do rótulo não achado e `'itens_nao_carregados'` no lugar de `'recebida_fora_do_app'`.

## Deploy

Só front: entra no ar com o **Publish** do founder. Conferir nos bytes com `lovable-deploy-verify` (string `Recebida fora do app` no bundle servido).
