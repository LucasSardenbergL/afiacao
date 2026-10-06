# omie-sync-estoque v1.6: três caminhos respondiam ok:true sobre um par (físico, pendente) torto (2026-10-06)

> Money-path (reposição). Edge `omie-sync-estoque` v1.5 → v1.6 (`v1.6-recusa-par-torto`). Os três achados
> preexistentes do adversarial do #2817 ([diário da v1.5](sync-estoque-deadline-fase-po-na-cauda.md)). Codex: desenho
> `gpt-6-astra · max · 323s · 45.434 tokens`; adversarial de código registrado no PR.

## A medição (antes de mudar)

**A pré-condição falhou.** A tarefa pedia a série que a v1.5 grava em `acoes_execucoes`, e a v1.5 não estava no ar: o
ledger atestava `v1.4-observa-conjunto-aberto` (sonda de 05/10 16:06Z). Outra sessão a deployou às ~20:08Z de 06/10
(12 hashes conferidos, nenhum arquivo editado). Sem atestação no ledger: a edge não está na sonda por cron, e a resposta
normal dela traz `versao` mas não `edge` — não vira "eco". **Série v1.5: 0 linhas, denominador 0.**

Fonte substituta, a v1.4 (05/10 16:06Z → 06/10 20:05Z): **10 runs** (9 de cron, 1 clique).

| Caminho | Contagem | Denominador | Como |
|---|---|---|---|
| C1 pendente não confiável | 0 | 9 | publicar a observação do PR0 exige pendente confiável |
| C2 físico truncado | 0 | 3 | só os 3 runs retidos no `net._http_response` (3714/3714); 6 sem dado |
| C3 upsert parcial | 0 | 9 | `pendente_aplicado = true` nos 9 (= confiável e `erros_upsert = 0`) |
| falha (deadline no PO, 05/10 17:40Z) | 1 | 10 | |

Duração total do run (a v1.4 não grava `fase_fisico_ms`): slot 09:00Z 1 run, 48s; :40 de 45 a 54s (mediana 53s);
clique 37s. **O histórico do C1 antes da v1.4 é irrecuperável, não zero:** nenhum check vigia o
`reposicao_pendente_po` (0 episódios em `fin_alertas`; o `_data_health_compute` só o cita num comentário).

O que a medição achou e o desenho usou:

- **Os três caminhos eram invisíveis.** O `sync_state_saude` lê `error` → broken e `partial` → stale; `complete` COM
  `error_message` é **ok** — e era assim que a v1.5 sinalizava o físico truncado. O badge da tela é
  `max(ultima_sincronizacao)`: a linha mais fresca esconde o SKU velho.
- **O motor consome todo sync** 15 a 35 min depois (09:00 → 09:15; :40 → :15) e não tem trava de frescor.
- **COLACOR não tem `sku_parametros`** (só OBEN, 399 habilitados): o ramo COLACOR é inalcançável.
- **0 SKU multi-local**: a soma parcial por local (o P1 do Codex no C2) tinha população zero; o efeito real do C2/C3
  era SKU com par velho-porém-coerente, invisível.

## O desenho

**C1 → falhar.** Recusa antes de qualquer escrita. O par misto (físico fresco, pendente velho) erra para o lado
INVISÍVEL: a NF recebida depois do último run bom entra no físico e segue no pendente, e o motor sub-sugere. O par
velho-coerente erra no TEMPO, e o tempo aparece no badge e na Sentinela. Custo assumido: com "dado torto" persistente
no Omie o físico congela até alguém corrigir o PO — visível e acionável. Isso reverte a decisão de 2026-06-20 ("não
derruba o sync por 1 PO suja"), que não considerou a coerência do par.

**C2 → falhar.** Veredito em três estados (`completo`/`inconsistente`/`desconhecido`) logo depois do laço do físico,
antes da fase do PO. Só `completo` publica.

**C3 → degradar.** O que gravou fica (cada linha leva físico e pendente juntos: par coerente por SKU), marcadores
`partial`, resposta HTTP 200 `ok:false`, registro `sucesso` com `detalhes.desfecho = 'parcial'`.

### O parecer do Codex (cru, resumido)

Concorda com falhar/falhar/degradar. Achados: **[P1]** o helper `varreduraTruncada` responde `false` com total
ausente/zero/inválido — uma resposta vazia passaria o gate, gravaria zero linhas e **inativaria os 399**; **[P1]**
corrida cron × botão: o run atrasado regrava par mais velho com timestamp novo — exige primitiva compartilhada, fica
residual da solução na edge; **[P1]** o fallback de upsert individual não tinha prazo, então o `partial` podia nunca
ser gravado; **[P1]** falha da inativação só era logada — "completo" não descrevia o run; **[P1]** guarda textual
admite verde indevido: extrair a ORQUESTRAÇÃO com escritas injetadas e provar os EFEITOS; sobre-leitura e
`(produto, local)` repetido → gate; total declarado variando → bloquear; local ausente → só sensor; **[P2]** marca ASCII
no início (o registro guarda 300 caracteres), motivo explícito para PO vazio, régua com idade por SKU e consumo
durante a degradação.

### A calibração (decisão desta sessão, não do Codex)

Todos os P1 aceitos, menos a corrida — ela exige migration (lease em `sync_state` ou versão monotônica em
`sku_estoque_atual`) e fica como residual com query de detecção. "Total variando bloqueia" aceito: é o único sinal de
uma remoção no meio da varredura, e a remoção pula uma linha que vira inativação falsa. A régua extra virou query
(abaixo), não código.

## O que mudou (v1.6)

- **`fisico.ts`** (puro): soma por SKU e veredito. Recusa: total ausente/inválido (desconhecido); total que muda entre
  páginas; par `produto|local` repetido (antes do filtro de habilitados); físico/reservado não finito em habilitado;
  lidos < declarados; lidos > declarados; nenhum habilitado com habilitados esperados. Linha sem local fica fora da
  unicidade (sensor `linhas_sem_local`).
- **`publicacao.ts`**: gate do físico → fase do PO → gate do pendente → gravação → inativação → observação →
  marcadores. Escritas injetadas. Prazo na cauda (nenhum request depois de deadline + 5s; o que não cabe é "não
  tentado"); request abortado pelo prazo é "sem confirmação", não sucesso. Inativação no desfecho, e leitura com erro
  ABORTA a inativação (a v1.5 ignorava: regravaria a `data_inativacao` original com "agora" e duplicaria o alerta).
  Observação depois da inativação.
- **`index.ts`**: só a varredura do Omie e os adaptadores, todos com `AbortSignal` (guard conta 7 de 7). Marcadores
  com prazo fixo de 1s (85 + 2×1 + 2 do registro = 89s). Recusas começam pela marca: `FISICO_NAO_PUBLICAVEL`,
  `PENDENTE_NAO_CONFIAVEL`, `GRAVACAO_NAO_CONFIRMADA`. COLACOR: a falha do `ListarSaldoPendente` passa a ser fatal.

## Provas executadas

- **Deno `--no-remote`:** 50 testes da edge (`fisico_test.ts` 12, `publicacao_test.ts` 17 — orquestração com escritas
  falsas que registram cada efeito); `test:edges` 1499/0.
- **vitest:** os guards do F8 reescritos para a estrutura nova + o do `AbortSignal` (18 nos 2 arquivos); os 10 gates
  textuais sobre `supabase/functions/` 92/92; baseline do `[object Object]` 4→2 no `index.ts` (dívida quitada).
- **Falsificação:** 30 sabotagens, uma por vez, controle verde na MESMA invocação, vermelho exigido no teste NOMEADO —
  **30/30 sob `LC_ALL=C` e 30/30 sob `pt_BR.UTF-8`**. Camadas: gates e ordem (P1-P5, P13, P14) ficam vermelhos no
  Deno E no vitest; semântica do desfecho, do prazo e do veredito (P6-P12, P15, F1-F9) só o Deno pega; fiação do
  handler (I1-I6) só o vitest. Na 1ª rodada o P6 deu "vermelho" no lugar errado: a sabotagem estreitou o tipo e o
  `deno test` caiu no type-check (TS2367) sem rodar teste nenhum — só a exigência do teste nomeado separou isso de uma
  mordida.
- `edges:typecheck` (0 erro na edge com as flags do gate), `edges:sintaxe`, `sonda:bump`, `sonda:fingerprint`.

## Residuais (não corrigidos aqui)

1. **Corrida cron × botão** — precisa de primitiva no banco (migration). Detecção: query (5).
2. **Inativação por ausência** — contagem estável e chaves únicas não provam ausência: remoção antes do cursor +
   inserção depois preservam a contagem e pulam uma linha. O `omie-sync-status-produtos` reativa depois.
3. **Front** — para o parcial o botão diz "o estoque do Omie falhou" (impreciso, ação certa); o badge segue `max()`.
   Mudar exige Publish.
4. **O motor não tem trava de frescor** — o cron dele consome o snapshot parcial (C3) e o par velho (C1/C2); agora
   com a Sentinela alertando.

## Quando medir é query

```sql
-- (1) desfecho por dia (v1.6+). O registro grava String(e): o texto começa por "Error: ", a marca vem logo depois.
SELECT (iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia_sp, count(*) AS runs,
       count(*) FILTER (WHERE detalhes->>'desfecho' = 'completo') AS completos,
       count(*) FILTER (WHERE detalhes->>'desfecho' = 'parcial') AS parciais,
       count(*) FILTER (WHERE detalhes->>'erro' LIKE '%FISICO_NAO_PUBLICAVEL%') AS c2_fisico,
       count(*) FILTER (WHERE detalhes->>'erro' LIKE '%PENDENTE_NAO_CONFIAVEL%') AS c1_pendente,
       count(*) FILTER (WHERE detalhes->>'erro' LIKE '%GRAVACAO_NAO_CONFIRMADA%') AS nada_confirmado,
       count(*) FILTER (WHERE status = 'erro'
         AND detalhes->>'erro' !~ '(FISICO_NAO_PUBLICAVEL|PENDENTE_NAO_CONFIAVEL|GRAVACAO_NAO_CONFIRMADA)') AS outras_falhas,
       count(*) FILTER (WHERE status = 'executando') AS sem_fechamento
  FROM acoes_execucoes WHERE acao = 'reposicao.sync_estoque' GROUP BY 1 ORDER BY 1;

-- (2) cobertura da série (o registro é fail-open): 7 crons por dia UTC × linhas automáticas
SELECT d::date AS dia_utc, 7 AS cron_esperados,
       (SELECT count(*) FROM acoes_execucoes a WHERE a.acao = 'reposicao.sync_estoque' AND a.origem = 'automatica'
          AND a.iniciado_em >= d AND a.iniciado_em < d + interval '1 day') AS automaticas_registradas
  FROM generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') AS d;

-- (3) o que o badge max() esconde: a idade do par de CADA habilitado
SELECT count(*) AS habilitados, count(*) FILTER (WHERE e.ultima_sincronizacao IS NULL) AS sem_linha,
       count(*) FILTER (WHERE now() - e.ultima_sincronizacao > interval '4 hours') AS par_mais_velho_que_4h,
       max(now() - e.ultima_sincronizacao) AS pior_idade
  FROM sku_parametros p
  LEFT JOIN sku_estoque_atual e ON e.empresa = p.empresa AND e.sku_codigo_omie = p.sku_codigo_omie::text
 WHERE p.empresa = 'OBEN' AND p.habilitado_reposicao_automatica;

-- (4) consumo durante a degradação: de um run recusado/parcial até o próximo completo
WITH r AS (
  SELECT iniciado_em, CASE WHEN detalhes->>'desfecho' = 'completo' THEN 'bom' ELSE 'degradado' END AS estado
    FROM acoes_execucoes WHERE acao = 'reposicao.sync_estoque' AND status IN ('sucesso', 'erro')
), j AS (
  SELECT iniciado_em AS ini,
         (SELECT min(r2.iniciado_em) FROM r r2 WHERE r2.iniciado_em > r.iniciado_em AND r2.estado = 'bom') AS fim
    FROM r WHERE estado = 'degradado'
)
SELECT count(*) AS pedidos_gerados_na_degradacao, count(*) FILTER (WHERE x.aprovado_em IS NOT NULL) AS aprovados,
       coalesce(sum(x.valor_total), 0) AS valor_total
  FROM (SELECT DISTINCT p.id, p.aprovado_em, p.valor_total
          FROM j JOIN pedido_compra_sugerido p
            ON p.empresa = 'OBEN' AND p.horario_geracao >= j.ini AND p.horario_geracao < coalesce(j.fim, now())) x;

-- (5) a corrida residual: runs cujos intervalos se cruzam (o de fim mais tarde vence a escrita)
SELECT a.iniciado_em, a.finalizado_em, a.origem, b.iniciado_em AS outro_inicio, b.origem AS outra_origem
  FROM acoes_execucoes a
  JOIN acoes_execucoes b ON b.acao = a.acao AND b.id <> a.id AND b.iniciado_em > a.iniciado_em
   AND b.iniciado_em < coalesce(a.finalizado_em, a.iniciado_em + interval '90 seconds')
 WHERE a.acao = 'reposicao.sync_estoque' ORDER BY a.iniciado_em;
```

As cinco rodaram em prod via `psql-ro` em 2026-10-06 (série ainda vazia; 399 habilitados, pior idade do par 3h37).

## Lições

- **Sinal que o vigia não lê é sinal nenhum.** `complete` + `error_message` passa como ok no `sync_state_saude`: escolha
  o status pelo que o vigia ENXERGA (`partial`/`error`), não pelo campo que parece mais descritivo.
- **"Não truncada" não é "completa".** O helper responde `false` quando não sabe; o gate de publicação precisa de um
  estado para "desconhecido", senão a ausência do denominador aprova a varredura vazia.
- **Prova de efeito exige a orquestração executável.** Texto prova presença e ordem; extrair com escritas injetadas é
  o que deixou a falsificação provar "C1/C2 não escrevem nada".
- **Vermelho de compilação não é o teste mordendo** (P6). Exija o nome do teste na falha.
- **zsh não quebra `$var` em palavras:** um laço `heavy $passo` saiu rc=127 em todos os passos do CI local — "rodou"
  sem rodar. Só o rc capturado por passo denunciou.
