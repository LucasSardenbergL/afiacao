# A "classe travada" era uma FILA DE PRONTIDÃO — e o sensor dela vigiava a derivada, não o nível

> Money-path (reposição/compras). Diagnóstico medido em produção via `psql-ro` em **2026-08-26 00:14–01:05 UTC**.
> Evidência de banco tem validade (`database.md` §2) — **re-meça antes de agir sobre qualquer número daqui**.

## O pedido

"206 dos 537 SKUs ativos da OBEN têm `ponto_pedido` E `estoque_maximo` NULL. `ponto_pedido` NULL ⇒ o motor
compara `estoque_efetivo <= NULL` ⇒ nunca verdadeiro ⇒ **38% do catálogo é invisível ao motor de compras**.
Destrave a classe." Duas travas alegadas: (1) falta lead time; (2) `atualizar_parametros_numericos_skus` exige
`max_antes > 0` para poder escrever `estoque_maximo` — deadlock de cold start. Correção proposta: trocar
`WHEN max_antes IS NULL OR max_antes <= 0` por `WHEN max_antes IS NOT NULL AND max_antes <= 0`.

**A correção proposta destrava ZERO SKUs, e aplicá-la abriria um buraco de money-path.** As duas coisas foram
provadas por medição, não por leitura de código.

## Lição 1 — o primeiro `WHEN` de um CASE é o teto de alcance de todos os outros

`atualizar_parametros_numericos_skus` classifica assim (ordem importa):

```
WHEN pp_sug IS NULL OR max_sug IS NULL OR ... THEN 'sem_mudanca'   -- (1)
WHEN <sugestão inválida/NaN/negativa>          THEN 'bloqueado_validacao'
WHEN max_antes IS NULL OR max_antes <= 0       THEN 'bloqueado_validacao'  -- (2) o guard acusado
...
```

**Prova positiva:** dos 206, 135 entram em `v_sku_parametros_sugeridos`, e **135/135 têm `pp/max/min/ss/cobertura`
sugeridos TODOS NULL** ⇒ param no ramo (1). Os outros 71 nem entram no JOIN. O guard (2) **nunca é alcançado**.

⇒ **Antes de "corrigir" um ramo de CASE, prove que a população chega nele.** Ler o código mostra que o guard
barra; só a medição mostra que ninguém bate nele. Um patch em ramo inalcançável é indistinguível de um no-op —
e passa em qualquer teste de "a função ainda funciona".

## Lição 2 — quando o guard e o fusível compartilham a âncora, remover o guard desarma o fusível

O fusível de magnitude da mesma função é `WHEN max_antes > 0 AND round(max_sug) > v_mult * round(max_antes)
THEN 'segurado'` (`v_mult`=3, de `company_config`). Ele é ancorado no **mesmo** `max_antes` do guard.

Com `max_antes` NULL: `NULL > 0` é falso ⇒ o fusível não dispara. Então relaxar o guard faria o SKU cold-start
cair **direto em `'aplicado'`, sem teto de magnitude nenhum** — escrita automática de parâmetro de compra sem
freio, em 206 SKUs de uma vez.

⇒ **O guard acusado de "confundir ausente com inválido" era, na prática, o único freio do caminho cold-start.**
Ao propor remover uma barreira, enumere o que mais depende da mesma condição — um fusível que lê a mesma coluna
morre junto, em silêncio. É a família da falha ABERTA: muda autorização/limite, não comportamento observável.

## Lição 3 — `status` de cascata ordenada é o PRIMEIRO bloqueador, nunca a composição da fila

`v_sku_parametros_sugeridos` é **fail-closed por desenho**: todo campo sugerido é NULL salvo
`status_sugestao='OK'`, e o status é uma cascata ordenada:

```
num_ordens<2 → AGUARDANDO_SEGUNDA_ORDEM ; lt IS NULL → SEM_LEADTIME_DEFINIDO ;
fornecedor NULL → SEM_FORNECEDOR_IDENTIFICADO ; NOT habilitado → AGUARDANDO_HABILITACAO_FORNECEDOR ;
grupo NULL & Sayerlack → AGUARDANDO_CLASSIFICACAO_GRUPO ; preço nulo → SEM_PRECO ; else → OK
```

Decomposição real dos 206 (nada homogêneo):

| bloco | n | causa medida |
|---|---|---|
| fora do universo da view | **71** (34%) | `v_sku_demanda_estatisticas` filtra venda `>= CURRENT_DATE-90d`. 65/71 vendem em **180d** mas não em 90d; 6 nunca venderam. 0/71 em `v_sku_classificacao_abc_xyz` |
| `AGUARDANDO_SEGUNDA_ORDEM` | **81** (39%) | `num_ordens = 1` |
| `SEM_LEADTIME_DEFINIDO` | **54** (26%) | **54/54 sem fornecedor NA VIEW**; 51/54 sem fornecedor no próprio `sku_parametros` |

⇒ **"Classificar os 54 em `sku_grupo_producao`" não os liberaria.** `v_sku_lt_teorico` faz
`JOIN fornecedor_grupo_producao gp ON gp.fornecedor_nome = sp.fornecedor_nome` — com fornecedor NULL o JOIN não
casa, e mesmo se casasse o **próximo** degrau da cascata (`fornecedor_nome IS NULL`) os pararia de novo. Contar
por `status` mede em que degrau cada um **parou primeiro**, não quantos degraus faltam. Para estimar rendimento
de uma ação, calcule a **matriz completa de pré-requisitos**, não o `GROUP BY status`.

## Lição 4 — sensor de DERIVADA fica verde enquanto a fila apodrece parada

`reposicao_param_limbo_watchdog` (cron diário) já vigia exatamente esta classe. Mas ele só alerta se o limbo
**saltar mais de +30 em 1 dia** — e o ramo `ELSE` **`dismissa` o alerta ativamente**. Ele foi desenhado para pegar
uma *regressão* ("o cron voltou a zerar config", fix #521), não estagnação.

Série de `reposicao_param_limbo_log` (OBEN): **146** em 31/05 → drena de 1 em 1 → **119** em 05/08 →
**congelado em 119 há 20 dias**, com o sensor verde o tempo todo.

⇒ **Alerta de delta e alerta de nível respondem a perguntas diferentes; ter o primeiro não dá o segundo.**
Um `ELSE ... dismissed_at = now()` transforma ausência de piora em prova de saúde — a mesma falácia de
"no ar e ninguém reclamou" (`fase-sem-sinal.md`). Fila que não anda precisa de sensor de **nível + composição +
idade**; o de derivada continua útil para o propósito original, ao lado, não no lugar.

## Lição 5 — `NULL` de parâmetro é semântica correta; ESTAGNAÇÃO de NULL é defeito operacional

Tentação a resistir: preencher os 206 com número sintético para "ficarem visíveis ao motor". Isso é exatamente
`ausente ≠ zero` (`money-path.md`) aplicado ao próprio parâmetro — compraria estoque com número inventado.
`NULL` aqui significa "não tenho evidência para autorizar compra", e está certo.

Mas (correção trazida pela 2ª opinião do Codex, aceita): **fail-closed não é sinônimo de saudável.** Uma fila
pode falhar fechada e permanecer abandonada indefinidamente. `NULL` é boa semântica para o *valor* e péssima
*máquina de estados*: falta motivo, idade, próximo passo e rota de saída. O defeito real não é o NULL — é não
haver quem observe que 54 SKUs esperam um cadastro que ninguém sabe que está pendente.

## Lição 6 — rotas paralelas criam VÃO: um `NOT EXISTS` decide quem fica de fora para sempre

Existem, sobrepostas, quatro máquinas de estado para o mesmo problema. `reposicao_cold_start_parametros`
(cron 08:15, **vivo**: 87 `criado`, 8 `graduado`, último 2026-08-25) tem dois ramos:

- **CRIAR** — filtra `NOT EXISTS (SELECT 1 FROM sku_parametros ...)` ⇒ só atende SKU **sem linha**;
- **GRADUAR** — exige `parametro_cold_start = true`.

Os 206 **têm** linha (órfã, com pp/max NULL) e têm `parametro_cold_start = false` ⇒ **CRIAR os ignora, GRADUAR os
ignora**. Caem no vão entre os dois ramos. Medido: 79 SKUs com `parametro_cold_start=true` e **todos já têm
`ponto_pedido`** — o mecanismo funciona, só não os alcança.

Quantificação do vão: **23 dos 206** já passam em `v_reposicao_cold_start_elegivel` e são barrados *apenas* pelo
`NOT EXISTS`. Destes, **18** são `habilitado + automatica` (os outros 5 = 4 desabilitados + 1 descontinuado —
adotá-los **religaria item desligado de propósito**). Dry-run dos 18: 18/18 com estoque, 16 com custo CMC,
**2 sem custo** (⇒ revisão, nunca fallback); exposição se recebessem `max=2`: **R$ 2.913,50**.

⇒ **Ao herdar "a feature X não cobre estes registros", procure o predicado de exclusão antes de escrever feature
nova.** Aqui o destravamento defensável tem 18 SKUs e R$ 2.913,50 — não 206.

## Lição 7 — a rota "óbvia" que a 2ª opinião sugere também precisa ser MEDIDA

O Codex apontou (corretamente) que existem `v_sku_candidatos_primeira_compra` e
`promover_candidato_primeira_compra`, criadas justamente para `AGUARDANDO_SEGUNDA_ORDEM`, e recomendou operá-las
para os 81. **A medição não sustentou:** a fila inteira dessa view tem **5 SKUs**, e cobre **5** dos 206.

⇒ Parecer de 2ª opinião é hipótese de alta qualidade, **não evidência**. Ele acertou dois achados que eu não
tinha visto (abaixo) e errou o dimensionamento deste. Verifique cada alegação verificável antes de replanejar em
cima dela.

## Achado colateral, aberto: a graduação escreve por fora do fusível

`reposicao_cold_start_parametros` / ramo GRADUAR escreve `pp/max/min/ss/cobertura` **direto no `UPDATE`**, sem
passar pelo CASE de `atualizar_parametros_numericos_skus` — logo **sem o fusível de 3×** e sem o guard. É um
caminho money-path vivo e desprotegido.

Risco **não materializado até aqui**: os 8 graduados saltaram de `pp=1/max=2` para `pp` 2–4 / `max` 3–5.
Mas dois deles gravaram `cobertura_alvo_dias` de **286** e **136 dias** — investigar o cap de cobertura.
⇒ Hardening preventivo, não incêndio; e a correção certa é no caminho que **escreve hoje**, não no guard que
não é alcançado.

## Consequência para o CLAUDE.md

A regra durável foi acrescentada em **⚠️ Armadilhas recorrentes** (guard/fusível com âncora comum + `status` de
cascata ≠ composição da fila + sensor de derivada). Este arquivo é o detalhe.
