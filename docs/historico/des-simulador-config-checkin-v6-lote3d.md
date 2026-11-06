# DES — simulador sem configuração de custo inventada e com o check-in vigente (plano v6, lote 3d)

**Data:** 2026-11-06 · **Camadas:** migration `20261106090000_des_simular_puxar_config_e_checkin.sql` + Publish (Hub). Fecha os follow-ups do [lote 3c](des-simulador-sem-posicao-v6-lote3c.md).

## Problema

Depois do lote 3c, a RPC `simular_puxar_volume_trimestre` ainda inventava parâmetros quando a configuração não existia:

- **Prazo escolhido não cadastrado:** o fator da NF saía 1,0 e o encargo, 0.
- **Prazo padrão não cadastrado:** a perda do antecipado saía 0.
- **Frete ativo ausente:** usava 2,5%.
- **`empresa_configuracao_custos` ausente:** usava 20% de custo de capital.

Ela também misturava check-ins. O desconto **atual** vem da `v_des_desconto_por_checkin`, que lê o check-in vigente da `v_des_checkin_atual`: o de data de avaliação mais recente, desempatado pela criação. Já o desconto **novo** somava os qualitativos do check-in `MAX(id)`. Com um check-in lançado de forma retroativa (id maior, data mais antiga), o delta comparava descontos de check-ins diferentes. No predecessor executado em PG17, o delta saiu 0,10 em vez de 0,85, ou seja, o ganho projetado subestimado em 8,5×.

No Hub, o card "Score SPIN Médio" era `Promise.resolve(0)`: um zero inventado, porque a aba Coaching SPIN usa dados de exemplo.

**Impacto em prod hoje** (psql-ro, 2026-11-06): a OBEN tem os dois prazos, o frete ativo de 2,5% e a configuração de custos. Ainda não há check-in cadastrado. Os números de hoje não mudam.

## O que mudou

- **RPC:**
  - Cada parâmetro de custo ausente levanta `P0001 'DES sem configuracao de custo'`.
  - O desconto novo usa o `checkin_id` da `v_des_checkin_atual`, a mesma fonte do desconto atual.
  - Também recusam: prazo escolhido ou padrão **inativo**; **dois** prazos padrão ativos ou **dois** fretes ativos (antes um arbitrário decidia); check-in gravado que a view não mostra; critério atingido sem percentual cadastrado para a faixa (`'DES sem configuracao de desconto'`). Vieram da 2ª opinião do Codex. Medido na prod: 1 padrão ativo, 1 frete ativo, 54/54 percentuais. Nada disso dispara hoje.
  - A `v_des_checkin_atual` ganha `id DESC` no fim do `DISTINCT ON`: com data e criação empatadas (dois check-ins na mesma transação), o vigente era arbitrário.
  - Assinatura, ACL, dono, INVOKER e STABLE ficam iguais. O envelope é o do 3c, com a trava por `COST`.
- **Hub:** o Score SPIN mostra "—" até existir fonte.
- **Molde** (`sql-house-style.md`): quando a PRE confere um atributo, a trava não pode reescrevê-lo. Ganhou a regra e a medida (o K7 do 3c).

## Provas

- **PG17 `db/test-des-simular-puxar-config-checkin.sh`:** 35 asserts, rodados em `C` e em `pt_BR`, mais `--falsificar` com controle verde e 21 sabotagens. Cobre:
  - o predecessor executado, que mostra os 5 defeitos;
  - a recusa em cada uma das 7 configurações ausentes ou ambíguas e nas 2 lacunas do desconto;
  - o desempate da view;
  - o check-in retroativo lido do vigente (R1);
  - o JSON idêntico ao da prod em 8 combinações;
  - o que o 3c garantiu, que segue de pé;
  - o envelope da função e o da view.
  - Está no núcleo de CI.
- **Front:** vitest do Hub e o mutcheck `performance-hub-posicao.mut` (10/10).

## Lições

- **Duas fontes para a "mesma" escolha divergem no caso de borda.** O desconto atual e o novo escolhiam o check-in por regras diferentes (data e id), e só um lançamento retroativo mostra a diferença. Ler as duas metades da mesma view acaba com a classe inteira, em vez de reimplementar a regra.
- **Para a guarda ter dente, o seed precisa isolar cada guarda.** Com a empresa sem nenhum prazo, sabotar a guarda do prazo escolhido deixava a do padrão recusar no lugar dela. O seed passou a ter só o padrão.

## Fora deste lote

Nada pendente do roadmap DES. Os follow-ups do 3c foram fechados aqui. A ambiguidade de configuração, que no 1º rascunho ficaria de fora, entrou por recomendação do Codex.
