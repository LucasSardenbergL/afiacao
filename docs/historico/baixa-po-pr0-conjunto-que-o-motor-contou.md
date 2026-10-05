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

(preencher: run, versao_edge, pedidos_lidos, itens por motivo, varredura_completa, pendente_aplicado, skus_divergentes)
