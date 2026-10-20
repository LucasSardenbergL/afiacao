# Radar: qualificação + aprovação em 1 clique (bloco 5 do brainstorm, 2026-10-20)

**Problema:** o brainstorm pedia "cadastro automático" de leads no Omie. A decisão de produto (Codex, bloco 0) foi
outra: **o Radar sugere QUEM cadastrar e o gestor aprova em 1 clique** — nunca cadastrar os 500 mil no ERP, nunca
cadastrar sem clique, e o cadastro vem DEPOIS do sinal comercial (lead marcado `em_conversa`). Até aqui existiam as
peças (score por lead #3214/#3220, foto vigente #3216, cadastro em massa #3163, situação cadastral #3212), mas nada
ligava sinal → sugestão → aprovação.

## O que entrou (só front — zero migration, zero edge)

1. **Helper puro `src/lib/radar/sugeridos.ts`** — o predicado vive UMA vez:
   - `cadastravelNoOmie(e)`: não cliente · sem `omie_codigo_cliente` (`!= null`, '' conta como vínculo — paridade
     com o `IS NULL` do count) · `rfb_situacao` NULL ou `02` · documento que a lib aceita (`documentoCadastravelNoOmie`: numérico de 14 dígitos ou
     alfanumérico RFB válido — o #3215 liberou o `criar_cliente` com letras; o filtro PostgREST confere o
     FORMATO e o DV fica com o helper e a lib, antes de tocar o ERP).
   - `sugeridoParaCadastro(e, lote)`: cadastrável E `ultimo_lote = vigente` E `prospeccao_status = em_conversa` E
     `score ≥ LIMIAR_SUGERIDO` (**70**). Motivos distintos para cada recusa; `score NULL` é `sem_score`, nunca
     "abaixo". Sem lote completo ninguém é sugerido.
   - `estadoCardSugeridos`: `sem_lote` · `sem_score` · `carregando` · `pronto{n}` — o 0 só existe no último.
2. **Count `useRadarSugeridos(lote)`**: `filtrarSugeridos(q, lote)` é a tradução PostgREST do predicado
   (exportada e reaproveitada pelo filtro da lista — card e fila contam o MESMO conjunto); `count: exact, head`
   (capa de 1.000 do PostgREST); `temScore` = a última rodada `sucesso` de `radar.score_recalcular` no ledger
   `acoes_execucoes` cobriu ESTE lote (`detalhes.lote_vigente`). `count`/`data` nulos LANÇAM.
3. **Card KPI "Sugeridos para cadastro: N de T"** (`RadarKpis`, 5º card) com botão "só sugeridos" → liga
   `soSugeridos` na URL (`useUrlState`). Estados honestos: "não consegui contar" · "sem lote completo" · "sem score
   calculado" (nunca 0 fabricado). Conta o lote inteiro (sem os filtros da tela) — está no `title`.
4. **Filtro `soSugeridos`** em `useRadarLista` (vence status/já-clientes/saiu-do-dump; "só inéditos" pode somar) +
   toggle em `RadarFiltros`. A seleção múltipla e a barra "Cadastrar no Omie" do #3163 funcionam como estão
   (teto 100 por lote). A linha ganha o selo **"sugerido p/ cadastro"** (mesmo `ehSugerido`) e, com o filtro
   ligado, os `score_motivos` viram TEXTO (`mostrarMotivos`) para justificar o cadastro.
5. **Gatilho pós-sinal** (`RadarOutcomeMenu`, com `empresa` da ficha): marcar `em_conversa` num lead cadastrável
   abre "Cadastrar no Omie (Oben) agora?" — "Cadastrar agora" roda o MESMO fluxo do lote (`cadastrarEmpresaNoOmie`
   + RPC `radar_registrar_cadastro_omie`, histórico em `radar_contatos`); "Agora não" só fecha. O avanço da ficha
   (`onProximo`) é ADIADO até a resposta. Resultado honesto: sucesso (cód.) · já existia (reconciliado) ·
   **indeterminado** (`OMIE_RESPOSTA_INDETERMINADA` → warning, lead segue na fila) · erro. O menu da rota
   (`RouteStopCard`, só CNPJ) não oferece.
6. **Sensores** (nascem com a superfície, com denominador): `radar.sugeridos_filtro {ativo, origem card|filtro,
   lote, sugeridos: N|null, total: T, limiar}`; `radar.cadastro_pos_sinal {aceitou, origem}` (cada evento = uma
   oferta EXIBIDA; denominador = `radar.contato_registrado {acao: em_conversa}`); `radar.cadastro_pos_sinal_resultado
   {resultado: sucesso|ja_existia|indeterminado|erro|lead_mudou}`.

## Medição em prod (psql-ro, 2026-10-20, foto 2026-08 = 501.380 empresas)

| recorte (não cliente, foto vigente) | ≥ 60 | ≥ 70 | ≥ 80 |
| --- | --- | --- | --- |
| qualquer status ativo (498.621 `a_contatar` + 2 + 1) | 12.434 | **852** | 33 |
| `em_conversa` (1 lead hoje, score < 60) | 0 | **0** | 0 |

Leitura: **sugeridos hoje = 0 em qualquer limiar** — o número nasce honesto em zero e sobe à medida que o time
marca conversas; o que o limiar governa é o TAMANHO do universo quando isso acontecer: 70 → 852 leads (cabe numa
rodada de qualificação); 60 → 12 mil (a fila inteira de novo); 80 → 33 (só o topo). `rfb_situacao` é NULL em
**100 %** da foto 2026-08 — exigir `02` deixaria o card morto; NULL passa (ausente ≠ baixado) e o selo diz "RFB
ainda não cruzada".

## Parecer Codex (desenho+adversarial, gpt-6-astra · max · 508 s) — 12 achados, o que virou código

| # | Achado | Tratamento |
| --- | --- | --- |
| 1 ALTO | **Um clique processava DUAS respostas** (o `onClick` de "Cadastrar agora" e o `onOpenChange(false)` do Radix chegam no mesmo tick; `setOferta(null)` não invalida a closure) — reproduzido por ele no meu código | Oferta consumida UMA vez por **ref síncrona**; teste exige exatamente 1 evento e 1 `onRegistrado` |
| 2 ALTO | "Só após sinal" não é regra da execução (barra/ficha cadastram `a_contatar`) | **Decisão**: cadastro MANUAL por clique explícito segue legítimo (#3163); o que entrou é **reler o lead antes do efeito** (`lerLeadParaCadastro`: `em_conversa` + cadastrável AGORA, senão "o lead mudou") |
| 3 ALTO | Lote e individual não compartilham exclusão; RPC não idempotente | A releitura do vínculo fecha a janela comum (lote em outra aba já cadastrou → não repete). Exclusão por `(conta, CNPJ)` + RPC idempotente exige banco → **follow-up** |
| 4 ALTO | O toast prometia retomada que não existia | "Tentar de novo" (indeterminado) passa `retentativa: true`; "Gravar de novo" (Omie confirmou, Radar não gravou) passa `codigoConhecido` — a lib relê o vínculo antes de tocar o Omie |
| 5 ALTO | Dedup (2 min) podia oferecer com o lead já descartado | Registro `deduped` **não oferece** + releitura antes do efeito |
| 6 ALTO | "Desfeito" escondia cadastro que ficou no Omie | Aceitar o cadastro **descarta o toast com "Desfazer"** do contato |
| 7 MÉDIO | RFB NULL aprovada como ativa | Mantido (100 % NULL hoje); o selo explicita "RFB ainda não cruzada" |
| 8 MÉDIO | `temScore` por "existe uma nota" colapsa cobertura parcial | `temScore` = **ledger da rodada** cobriu o lote vigente; `data` nulo lança |
| 9 MÉDIO | Card nacional vs. lista filtrada; `''` vs `IS NULL` | `title` do card diz "lote inteiro"; helper usa `!= null` (teste de paridade) |
| 10 MÉDIO | Runner do lote não invalidava o count | `['radar','sugeridos']` invalidado no fim do lote |
| 11 MÉDIO | Limiar não protege contra mudança da fórmula | `limiar` vai nos eventos; versão da fórmula no ledger → **follow-up** |
| 12 MÉDIO | Sensores sem denominador | Evento por oferta EXIBIDA (ambas as respostas) + `_resultado` correlacionado; denominador = `contato_registrado` |

## Provas

- `src/lib/radar/__tests__/sugeridos.test.ts` — limiar, predicado, cada exclusão (já cliente · vínculo (inclusive
  `''`) · RFB 01/03/04/08 · alfanumérico válido aceito, DV errado/minúscula/13 posições recusados · saiu do dump · lote em ingestão · status ≠ em_conversa · score NULL
  · abaixo), estados do card (sem lote · sem score · carregando · zero legítimo).
- `src/components/radar/__tests__/RadarOutcomeMenu.oferta.test.tsx` — oferece só com `empresa` + `em_conversa` +
  cadastrável + registro OK e não deduplicado; consumo único; releitura; "lead mudou"; indeterminado com
  `retentativa`; etapa radar com `codigoConhecido`; dismiss do Desfazer. (Radix em jsdom: abrir por teclado —
  `pointerDown` não carrega `button`.)
- `RadarKpis.estados.test.tsx` — card: "N de T" com o predicado inteiro no count, "0 de T" legítimo, "sem score"
  pelo ledger, "sem lote", "não consegui", clique + sensor com N/T/limiar.
- `RadarLinha.selos.test.tsx` — selo "sugerido", abaixo do limiar, sem lote, motivos como texto só com
  `mostrarMotivos`.
- `useRadarLista.lote-vigente.test.tsx` — `soSugeridos` aplica o predicado inteiro, vence já-clientes/saiu-do-dump,
  sem lote não finge.

## Camadas de deploy

| Camada | Estado | Quem |
| --- | --- | --- |
| Migration / edge | nenhuma | — |
| Publish do Lovable (front) | ⏳ após o merge | **founder** (Publish) |

## Follow-ups (fora deste bloco)

- RPC `radar_registrar_cadastro_omie` idempotente por vínculo idêntico + exclusão `(conta, CNPJ)` partilhada entre
  lote e clique individual (Codex #3) — exige migration.
- Versão da fórmula do score (md5 do `prosrc`) no ledger e nos eventos; re-medir a distribuição ao mudar peso
  (Codex #11).
- Mapa/ranking de cidades vão por RPC e ignoram `soSugeridos` (como já ignoram `soIneditos`).
- Oferta pós-sinal também no `RouteStopCard` (hoje só tem o CNPJ).
