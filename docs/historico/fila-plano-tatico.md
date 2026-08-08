# Fila do Plano Tático (PTPL) — 533 planos, zero desfecho, 72% inalcançáveis

> Diagnóstico + correção de 2026-08-07. Origem: o founder pediu para extrair aprendizado de
> [uma matéria sobre a Dionísio](https://revistapegn.globo.com/startups/noticia/2026/07/startup-capta-r-22-milhoes-para-transformar-whatsapp-em-maquina-de-vendas-para-restaurantes.ghtml)
> (startup que captou R$ 2,2 mi para virar o WhatsApp de restaurantes em canal de vendas).
> A frase que puxou o fio: *"mais de 70% dos dados que passam por restaurantes não são captados"*.
> Medimos o equivalente aqui e o número foi pior.

## O que foi medido (psql-ro, 2026-08-07)

| Fato | Valor |
|---|---|
| Cron `tactical-plans-batch-nightly` | **ativo**, `0 8 * * *`, ~30 planos/dia |
| `farmer_tactical_plans` | 533 linhas (21/07 a 07/08), **100% `gerado`** |
| Com desfecho (`concluido`) | **0** |
| Com `actual_margin` | **0** |
| Donos distintos | 3 (285 / 124 / 124) |
| Fora dos 50 slots da UI | **383 de 533 (72%)** |
| Janela real de visibilidade | **6,7 dias** |

Sinais laterais da mesma doença: `farmer_recommendations` 3.659 linhas 100% `pendente`
(idêntico ao post-mortem de [farmer-aprendizado-conversao.md](farmer-aprendizado-conversao.md));
`call_log` parado desde 2026-06-09. **Todo ponto de captura que depende de digitação manual
está em zero.** O que está vivo é o que a máquina calcula sozinha (`farmer_client_scores`,
recalculado diariamente).

## O que NÃO era (hipóteses descartadas com evidência)

- **Não era export morto.** Ao contrário do `farmer_category_conversion`, a cadeia está inteira:
  `FarmerTacticalPlan.tsx` → `PlanCard.tsx:233` → `RecordResultDialog.tsx` → `recordResult` →
  RPC `registrar_resultado_plano` (que grava `status='concluido'` + `actual_margin`).
- **Não era botão escondido por status.** Renderiza sob `plan.status !== 'concluido'`, verdadeiro
  nos 533.
- **`used_at = 0 em 533` NÃO prova não-adoção.** A coluna **não tem writer nenhum** (nem em `src/`,
  nem em `pg_proc`). Ler esse zero como "ninguém abriu os planos" seria repetir exatamente a
  armadilha do post-mortem: *ler uma tabela vazia é pior que não ler*. A inferência foi retirada.

## A causa: o sistema competia consigo mesmo

`loadPlans` fazia `.order('created_at', desc).limit(50)`, **sem filtro de status e sem paginação**.
Com ~30 planos novos por dia, a lista de 50 rotacionava inteira em menos de uma semana — e o plano
saía de vista para sempre, sem nunca ter recebido desfecho.

O ponto não-óbvio: **trocar só o critério de ordenação não resolveria.** Sem uma saída, qualquer
ordenação estável entope — os mesmos 50 planos (de maior risco, ou mais antigos) ficariam no topo
permanentemente, porque nada os remove. A fila só circula se tiver saída.

## A correção

1. **Saída (banco):** `expirar_planos_taticos(_dias integer DEFAULT 7)` + cron
   `expirar-planos-taticos` (`30 8 * * *`, 30 min depois do batch de geração). Plano `gerado`
   fora da janela vira `expirado`. Nunca toca `concluido` — o desfecho registrado é o dado escasso.
   - Guard fail-closed: `_dias` nulo ou `< 1` levanta `22023` (com `_dias=0` a fila INTEIRA
     expiraria, inclusive o lote da madrugada).
   - `SECURITY DEFINER` + `REVOKE` nominal de `anon`/`authenticated` (revogar de `PUBLIC` não
     basta no Supabase — grant explícito por default privileges).
   - Efeito medido em prod antes do apply: **364 expirariam, 169 ficariam na fila.**
2. **Recorte (front):** `status='gerado'` + janela móvel em `generated_at` + ordenação por
   `churn_risk` desc com `generated_at` de desempate. O front aplica a janela por conta própria
   em vez de confiar que o cron rodou — se o job falhar, a fila entupiria de novo.
   - `churn_risk` foi escolhido por ter variância real (53 valores distintos, 33..89).
     `bundle_lie` e `best_individual_lie` seriam o critério natural de valor, mas estão **NULL em
     100% das 533 linhas** — ordenar por eles seria ordem indefinida disfarçada de priorização.
3. **Contador honesto:** a tela passa a dizer "Mostrando 50 de N". Contagem que falha degrada para
   `null` (o rótulo some), **nunca para 0** — "0 pendentes" é indistinguível de "a query morreu".
4. **Abas** pendentes/concluídos/expirados (`useUrlState`), para que o histórico continue
   alcançável. Valor fora do domínio na query string degrada para `pendentes`.

Prova: `db/test-expirar-planos-taticos.sh` (PG17, 15 asserts + 3 falsificações) e
`src/hooks/__tests__/fila-plano-tatico.test.tsx` (5 testes).

⚠️ A falsificação F3 (re-`GRANT` para `authenticated`) só tem dente porque o harness replica o
`ALTER DEFAULT PRIVILEGES` do Supabase. Sem isso o `authenticated` do stub nasceria sem EXECUTE e
o assert de REVOKE passaria por acidente de ambiente — falso-verde.

## O que este PR NÃO resolve (deliberadamente)

- **A geração continua em ~30/dia para 3 donos.** ~10 planos/dia por vendedor não é executável em
  venda consultiva. Reduzir é config (`farmer_algorithm_config`, 17 linhas), não código — ficou
  como item separado.
- **O custo de registrar continua alto.** O `RecordResultDialog` pede 4 campos, entre eles a
  **margem realizada** digitada, que a vendedora dificilmente sabe durante a ligação. O caminho
  natural é registro de 1 toque (ligou / não atendeu / vendeu / recusou) com a margem vindo do
  pedido no Omie pelo elo, não do teclado.
- **Não se sabe se a tela é aberta.** Não há telemetria server-side do módulo Farmer
  (`farmer_audit_log` e `farmer_copilot_events` estão vazias); a fonte seria o PostHog.

## Lição

O post-mortem irmão catalogou o writer **inalcançável**. Este é o caso oposto e mais difícil de
enxergar: **o writer é alcançável, funciona, e mesmo assim o registro nunca acontece** — porque a
própria geração empurra o item para fora da janela antes que alguém aja sobre ele.

Corolário para revisão: **quando uma tabela de intenção tem muitas linhas e nenhuma transição de
estado, meça a taxa de PRODUÇÃO contra o tamanho da JANELA de consumo antes de culpar a adoção.**
Uma fila que recebe 30/dia e mostra 50 no total dá ao humano menos de dois dias de folga — e
nenhuma tela comunica isso sozinha.

E a leitura que veio da matéria: **desfecho que depende de digitação manual não é capturado.**
É por isso que 70% dos dados se perdem no modelo antigo, e é exatamente o padrão aqui.
