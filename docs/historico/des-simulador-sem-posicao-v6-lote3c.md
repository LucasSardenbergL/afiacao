# DES — simulador e Hub sem posição ou meta confirmada (plano v6, lote 3c)

**Data:** 2026-11-05/06 · **Camadas:** migration `20261105180000_des_simular_puxar_sem_posicao_recusa.sql` + Publish (Hub). Continuação do lote 3b (#3634).

## Problema

O lote 3b fez a `v_des_posicao_trimestre_ao_vivo` devolver NULL quando não há faturado confirmado do GoodData. Dois consumidores ainda fabricavam número:

- **RPC `simular_puxar_volume_trimestre`:**
  - Fazia `IF posição IS NULL THEN 0`, e dessa posição inventada saíam a faixa atual, o desconto, o ganho do próximo trimestre e a recomendação.
  - Em T4, o "próximo trimestre" lia a meta de T1 do **mesmo** ano, um trimestre que já passou.
  - Sem meta nenhuma, a projeção usava um `400000` fixo.
  - Medido no predecessor executado em PG17: `anon` chamando direto recebia uma simulação inteira. A RLS esvazia a view, então a posição vinha 0 e a meta, 400000.
- **Hub (`PerformanceHub`):**
  - Os cards do topo fixavam `empresa='OBEN'`. Com COLACOR no seletor, mostravam a posição da OBEN.
  - A meta fazia `Number(meta ?? 0)` sem ler o `error`, e mostrava "R$ 0" sem meta ou com a leitura falhando.

Impacto em prod hoje (psql-ro, 2026-11-05): as metas da OBEN são 400.840,02 em T1..T4/26, nenhuma de 2027, e só T2/26 tem faturado. Nos casos com posição, os números de hoje não mudam; muda a fonte. O front já não chamava a RPC sem posição desde o #3634.

## O que mudou

- **RPC:**
  - Sem faturado confirmado, ou sem linha na view, levanta `P0001 'DES sem posicao confirmada'`.
  - Sem meta do trimestre seguinte nem do corrente, levanta `P0001 'DES sem meta para projetar'`.
  - Em T4, a projeção lê T1 do ano seguinte.
  - Faturado 0 é fato: a posição é o trânsito e a simulação segue.
  - O ano/trimestre padrão (só sem `p_ano`/`p_trimestre`) usa o dia de São Paulo, não `CURRENT_DATE` em UTC. Foi o gate `relogio-nu-da-sessao` que acusou: o corpo da prod entrou no repo por esta migration.
  - Assinatura, defaults, retorno, ACL, dono, search_path, INVOKER e STABLE ficam iguais. A PÓS confere tudo isso.
  - O `SimulationPanel` já mostra o erro da RPC num toast.
- **Hub:**
  - Uma só leitura de posição e meta, pela empresa do seletor. A aba DES abaixo continua fixa em OBEN por desenho, porque o contrato DES é da OBEN.
  - Meta ausente ou leitura com erro mostra "—".

## Provas

- **PG17 `db/test-des-simular-puxar-sem-posicao.sh`:** 29 asserts, rodados em `C` e em `pt_BR`, mais `--falsificar` com controle verde e 13 sabotagens (cada camada sozinha). Cobre:
  - o predecessor executado, que mostra os 3 defeitos e a exposição a `anon`;
  - a recusa nos 4 jeitos de não ter faturado e também sobre a view antiga;
  - o JSON idêntico ao da prod em 8 combinações;
  - a trava em 2 sessões, a PRE de md5 e de atributo, e a PÓS de ACL.
  - Está no núcleo de CI.
- **Front:** vitest do Hub com um mock que filtra por empresa, mais o mutcheck `performance-hub-posicao.mut` (9/9).
- **Codex:** estágio 1 no plano. Os ajustes foram incorporados: faturado 0 com trânsito, o 400000 alcançável, a trava pela volatilidade viva, a PRE de atributo, a PÓS de dono e assinatura, e a chamada direta. Estágio 2 no diff.

## Lições

- **Corrigir a view não conserta quem lê a coluna.** A RPC tinha seu próprio `COALESCE` (`IF NULL THEN 0`) e continuou fabricando depois do 3b. Ao trocar número por NULL, procure os `?? 0` do front **e** os `IF NULL` das funções SQL que leem a coluna.
- **Uma guarda que não dá para falsificar é ruído.** A guarda `posição IS NULL` foi tirada: com faturado presente, a posição nunca é NULL em nenhuma das duas views. A guarda que ficou, pelo faturado, é a que a view antiga fura (N5).
- **A trava não pode reescrever um atributo que a PRE confere.** O molde sugere `ALTER FUNCTION … <volatilidade viva>`, que lê o valor e o reescreve igual. Se outra sessão commitar VOLATILE entre a leitura e o ALTER, a trava regrava STABLE e a PRE aprova a deriva apagada (Codex, estágio 2, por análise estática). Aqui a trava passou a ser `COST 100`: a PRE não confere o custo e o `CREATE OR REPLACE` o redefine. O K7 prova o caso sequencial, e a sabotagem `trava_escreve_atributo` mostra a deriva sumindo.
- **O erro do `supabase.rpc` é objeto plano, não `Error`.** Com `err instanceof Error ? … : "desconhecido"`, a recusa nova chegaria ao toast como "desconhecido". O painel passou a usar `mensagemDeErro`.
- **Sabotar uma camada inteira pode cortar outra junto.** O bloco PRE também guarda o ACL de antes para a PÓS. Cortá-lo inteiro fazia o K2 ficar vermelho pela PÓS, não pela PRE. A sabotagem passou a cortar só o md5.

## Fora deste lote (follow-up)

✅ Os 4 itens abaixo foram resolvidos no [lote 3d](des-simulador-config-checkin-v6-lote3d.md).

- Os fallbacks de custo `2,5%` (frete) e `0,20` (custo de capital) quando a configuração não existe. Não foram observados no recorte atual, porque a OBEN tem as duas configurações.
- A escolha do check-in: a RPC usa `MAX(id)` e a `v_des_desconto_por_checkin` usa a data. Um check-in retroativo pode comparar descontos de check-ins diferentes. O diferencial deste lote não certifica essa parte.
- O card "Score SPIN Médio" do Hub mostra 0 fixo (`Promise.resolve(0)`).
- O molde `.claude/skills/lovable-db-operator/references/sql-house-style.md` §"Recriar objeto VIVO" recomenda a trava pela volatilidade viva, que tem a janela descrita nas lições. Falta medir essa janela em PG17, com duas sessões intercaladas, antes de trocar o molde.
