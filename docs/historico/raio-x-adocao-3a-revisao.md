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
