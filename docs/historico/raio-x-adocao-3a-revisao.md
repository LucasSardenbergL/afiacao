# Raio-X: adoção + 2 correções de dinheiro (3ª revisão, Codex + Fable, 2026-11-07/08)

Prod em 07/11: 1 visita (`reposicao.raio_x_aberta`, 01/11) e 0 decisões com `origem='app'`. Coorte Oben congelada
em 01/11 (61 SKUs, R$ 121,4 mil na foto), 14 decididos (fase A). A revisão concluiu que o problema é **adoção**: o
comprador não é lembrado de abrir a ferramenta. O founder aprovou exatamente 3 itens, um PR por item. Congelado até
25/11: Colacor, Saídas/Contagem/reclassificação, novos painéis, push, integração Omie, concorrência do plano, fase C.

## PR 1 — bloco do Raio-X no e-mail diário (edge `gerar-pedidos-diario`, `v1.5-bloco-raio-x`)

- O digest das 9h15 ganha, abaixo do banner de bloqueados: **"Raio-X: N pendentes do Top 61 · R$ X parado na foto de
  DD/MM · Decidir agora"**, com link para a fila (`…&rxFila=1&origem=email`, o mesmo destino do Cmd-K).
- Lógica em `supabase/functions/gerar-pedidos-diario/raio-x-email.ts` (pura + leitor):
  - pendente = membro de `raio_x_coorte_top` sem decisão com destino (a regra de `filaTop`);
  - valor = o **congelado na coorte** (o e-mail não recalcula estoque), rotulado "na foto de DD/MM"; pendente sem
    custo entra como "+ N sem custo", e com todos sem custo, "valor indisponível" — nunca R$ 0;
  - **ausente ≠ zero**: erro na coorte ou nas decisões → "Raio-X: indisponível hoje", nunca "0 pendentes";
  - empresa sem coorte (hoje, Colacor) → sem bloco. Nada no leitor derruba o e-mail dos pedidos (captura e degrada).
  - O resumo vai também no `metadata.raio_x` do `sync_reprocess_log` (o que o e-mail disse, auditável).
- **Sensor:** `reposicao.raio_x_aberta` ganha `props.origem` (allowlist `ORIGENS_VISITA = ['email']`, lida de
  `?origem=` em `RaioXTab`). Com origem, a chave do dedup vira `empresa:origem` (1 linha por titular × empresa ×
  origem × dia), senão a visita do e-mail sumiria atrás de uma visita direta do mesmo dia. Sem origem, igual a antes.
- **Prova:** 8 testes Deno do módulo; falsificado na mesma invocação (controle 0 → 3 sabotagens vermelhas: erro nas
  decisões tratado como vazio, soma sem custo virando R$ 0, link sem `origem` → restaurado 0). Vitest: allowlist +
  2 casos do sensor no `RaioXTab`.
- **Deploy:** edge (`bun run pendencias:deploy`) + Publish (o `origem` do sensor é front).

### Query — visitas por origem (psql-ro)

```sql
SELECT (ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
       coalesce(props->>'origem', '(direta)') AS origem, count(*) AS visitas, count(DISTINCT user_id) AS pessoas
  FROM public.analytics_outbox
 WHERE evento = 'reposicao.raio_x_aberta' AND ocorrido_em >= '2026-11-09'
 GROUP BY 1, 2 ORDER BY 1 DESC, 2;
```

A partir deste PR, "visitas" por dia pode contar 2 linhas da mesma pessoa (direta + e-mail); para pessoas/dia use
`count(DISTINCT user_id)`.

## PR 2 — duas correções de dinheiro [money-path] [migration manual]

- **(a) Unidade desconhecida bloqueia o inequívoco.** Em `raio_x_inequivoco`, `un_divergente` só acusava com as duas
  unidades não nulas: venda sem `sku_unidade` ou estoque sem `omie_products.unidade`, com consumo a comparar, passava
  como "igual" e o SKU virava liquidável (o RX004 confia no veredito). Migration
  `20261110100000_raio_x_inequivoco_unidade_desconhecida.sql` (CREATE OR REPLACE sobre o md5 de PROD `903937e4…`): motivo
  novo `unidade_desconhecida` quando alguma linha de consumo 365d com `quantidade <> 0` tem unidade da venda OU do
  estoque NULL/vazia; `un_divergente` compara só unidades conhecidas. Prod em 08/11: 382 SKUs Oben com consumo, 0 com
  unidade nula — buraco latente, nenhum veredito atual muda.
- **(b) Recompra acusada sem medição.** Em `medir.ts`, o `continue` de "sem medição" vinha antes da checagem de
  contradição; item sem foto/cmc/saldo/venda legível ou vendido em outra unidade nunca gerava o alerta. A checagem
  subiu; o alerta não carrega valor.
- **Prova:** `db/test-raio-x-inequivoco-unidade.sh` (núcleo do CI, ≥19): o "ANTES" prova o bug executando, controle com
  PRE+PÓS, re-aplicação, PRE negativa, controle do laço na mesma invocação e 7 sabotagens com o vermelho certo, nos
  dois locales. A PÓS foi vista mordendo (recusou o md5 placeholder). Teste TS que falha antes da correção.
- **Codex** (gpt-6-astra, high, 71 s): sem achado nos 5 eixos; comparou 10.368 casos de `medir` contra a main — só
  `contradicoes` muda.
- **Deploy:** migration manual (`bun run db:aplicar`, ensaio primeiro; validar `md5(prosrc) = d6872afb…`) + Publish.

## PR 3 — fila mais leve no celular (só TS)

- **Celular abre direto na fila:** os pendentes do Top 61, na ordem da fila, logo abaixo do botão "Decidir Top 61".
  Segmentos, os 5 selects, a busca, o placar completo, a medição e as Saídas vão para um `<details>` **"Avançado"**
  recolhido. Ele abre sozinho só quando a URL pede algo além da fila (outro segmento ou filtro); o link do e-mail/Cmd-K
  (`rxTop=1&rxStatus=pendente`) É a fila e não abre. Desktop sem Avançado.
- **Avisos amarelos** (inequívoco indisponível, estoque defasado) abaixo do botão da fila, no celular e no desktop.
- **Ordem da fila** (`filaTop`): primeiro as sugestões fáceis de confirmar — `sugestaoConfirmavel` (extraída de
  `argsConfirmarSugestao`, mesma regra do botão: liquidar sem inequívoco nunca é "fácil") —, depois o resto; em cada
  bloco R$ desc, sem custo ao fim, desempate por SKU. Teste de ordem + estabilidade (entrada invertida → mesma saída).
- **"Pular"** no Sheet: `size="touch"` (44px).
- **Prova:** controle verde → 2 sabotagens da ordem vermelhas (partição removida; liquidar sem veredito tratado como
  fácil); as 6 asserções novas de componente ficam vermelhas com o `RaioXTab`/`DecisaoSheet` anteriores.
- **Deploy:** só Publish. Não verificado em aparelho real.

## Roadmap de deploy (merge ≠ produção)

| PR | Edge | Migration | Publish |
|---|---|---|---|
| 1 — e-mail | `gerar-pedidos-diario` (`bun run pendencias:deploy`) | — | sim (origem do sensor) |
| 2 — dinheiro | — | `20261110100000` manual (envelope) | sim |
| 3 — celular | — | — | sim |
