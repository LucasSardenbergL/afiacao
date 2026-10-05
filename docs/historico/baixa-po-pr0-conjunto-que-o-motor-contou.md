# Baixa de PO — PR0: o `omie-sync-estoque` registra o conjunto aberto que o motor contou

> 2026-10-05 · PR [#2780](https://github.com/LucasSardenbergL/afiacao/pull/2780) · plano
> `docs/superpowers/plans/2026-09-26-baixa-po-fase-0.md` (Tasks 0.1–0.4) · spec
> `docs/superpowers/specs/2026-09-26-baixa-pedido-compra-nf-concluida-design.md` §13–§16.

## O que entrou

- `reposicao_po_observado_run`/`_item` + RPC `reposicao_po_observado_publicar` (1 writer, SECURITY DEFINER, EXECUTE só
  `service_role`, retenção de 14 d no mesmo writer). A RPC **confere no banco, na mesma transação**, o pendente gravado
  de cada SKU habilitado × a soma do que a observação contou (`pendente_aplicado` + `skus_divergentes`).
- Helper puro `observacao-po.ts` com o **coletor** (1 registro por PO; nunca lança; perde a integridade em vez de mentir;
  linha de presença para PO sem itens).
- Edge `v1.4-observa-conjunto-aberto`: publica depois do upsert, com pendente confiável + coleta íntegra + invariante, com
  prazo pelo orçamento do run, sempre dentro de try/catch.

## O que o plano não previa (e quem pegou)

| defeito | quem pegou | como |
|---|---|---|
| PO repetido na varredura colidia na PK e derrubava a publicação inteira | a sessão, lendo a edge antes de codar | coletor "1ª aparição vence" |
| a coleta podia LANÇAR com itens malformados num PO não contado (antes, o motor nem olhava) | Codex (P1) + revisão final | coletor nunca lança |
| RPC sem prazo podia comer o teto de 90 s dos marcadores | Codex (P1) | `abortSignal` + `lock_timeout` |
| `pendente_aplicado` não provava cobertura (SKU fora do upsert, run concorrente) | Codex (P1) + revisão final | conferência no banco |
| duas anomalias se compensando na soma por SKU (atribuição ao PO errado) | Codex (P1) | o contado espelha o filtro final do acumulador; reaparição contada = perda |
| PO lido sem itens / sem `nCodPed` sumia de um run "completo" | Codex (P1) + revisão final | linha de presença; sem `nCodPed` = não publica |
| `service_role` (BYPASSRLS + ACL default) escrevia direto | Codex (P2) | `REVOKE` da escrita |
| postcondição: `ANY(NULL)` passava calado; CHECK/policy trocados passavam | Codex (P2) | `IS DISTINCT FROM true` + md5 de definições |
| guarda "não-fatal" sem dente (acharia o try do ramo COLACOR) | revisão final (opus) | recorte do bloco + mutante morto |
| cascata e borda da retenção sem teste | revisão final | item no run velho + run de 15 d + 2 sabotagens |

A falsificação da própria prova pegou 3 defeitos MEUS no caminho: um predicado de postcondição que ficou redundante
(contagem de CHECKs, coberta pelo md5 de nome+definição), uma âncora de sabotagem desatualizada e uma declaração de
"verde" errada (`cascata_fora` derruba a publicação inteira, então A5 também fica vermelho). Sem o laço com controle
verde na mesma invocação, os três teriam virado "falsificação OK".

## Lições

1. **Ler a edge real antes de transcrever o plano.** O plano foi "executado" em PG17/Deno, mas nenhum teste exercitava a
   reaparição de PO — o caminho que só existe na integração edge ↔ PK.
2. **Acessório não pode mudar o comportamento do caminho principal** — nem lançando (coleta), nem demorando (RPC). O
   critério de revisão é "o run termina igual com a fatia quebrada?", não "o try/catch existe?".
3. **Uma flag que AFIRMA reconciliação tem de ser conferida onde o dado está** (no banco, na mesma transação), não
   deduzida do que o writer acha que fez.
4. **Postcondição também precisa de cópia defeituosa por predicado** — e um predicado que a falsificação mostra redundante
   sai, em vez de ficar dando falsa sensação de camada.

## Medição do run real (Task 0.4 Step 3)

Run do cron de 2026-10-05 **19:40Z** (job 124), `run_id 396daec0…`, `v1.4-observa-conjunto-aberto`: HTTP 200 em 53,1 s
(v1.3: 49,5 s nos 2 runs retidos), 399/399 SKUs, `observacao_publicada: true`.

| campo | valor |
|---|---|
| `varredura_completa` · `pendente_aplicado` · `skus_divergentes` | `t` · `t` · **0** |
| janela | 2025-10-05 → 2027-02-02 |
| POs lidos | 21 (1 página do `PesquisarPedCompra`) |
| itens contados | 27 em 12 POs = **164 un.** = soma do pendente gravado dos 399 habilitados |
| `dedup_app` | 46 itens em 8 POs |
| `sku_nao_habilitado` | 3 itens em 2 POs |
| custo da publicação | ~130 ms (`concluido_em` 19:40:56,377 → fim do sync 19:40:56,506) |

**O 1º run da v1.4 (17:40Z) não publicou — o sync inteiro caiu por prazo** (HTTP 500 `PesquisarPedCompra: deadline do
run atingido antes da chamada`, 73,3 s de 75 s; estoque OBEN sem regravar até as 19:40). Não foi a v1.4: a fase do PO
são 2 chamadas (21 POs) e só ganhou o coletor síncrono O(1); quem come o prazo é o `ListarPosEstoque` (75 páginas, ≈45 s
por diferença num run normal), que a v1.4 não tocou; o tombo do run inteiro em erro de varredura do PO é desenho
anterior; e o mesmo código fechou em 53,1 s às 19:40. Leitura: o sync OBEN roda a 66–71% do prazo, e um Omie ~1,5× mais
lento derruba o run (17:40Z = 14:40 BRT, no lote concorrente do pg_net). **Para a 0.5:** run que caiu não publica — o denominador é o run do cron (`net._http_response`/`sync_state`),
não só `reposicao_po_observado_run`; ausência de run publicado não é "PO fechado" (spec §16).
