# Raio-X: liquidar SÓ o inequívoco (Frente C da leva Oben PME/PMR, PR 2)

2026-11-01 · migration manual `20261101120000_raio_x_inequivoco.sql` · prova `db/test-raio-x-inequivoco.sh` · decisão do
founder 2026-10-31: "agora, só o inequívoco" — o resto espera corante reconciliado + 30–45d do segurar-compra.

## Medido em prod (2026-11-01, psql-ro, account `oben`)

| Conjunto | SKUs | R$ (saldo × CMC) |
|---|---|---|
| parado (cobertura >365d OU sem venda 12m) | 513 | 229.520 |
| **inequívoco** (não corante LC · sem entrada 90d · não cold-start · não substituído) | **217** | **107.799** |
| dos quais já com decisão no Raio-X | 8 | 19.948 |
| aguarda: corante LC (consumo dosado não registrado) | 191 | 53.481 |
| aguarda: entrada de compra em 90d | 62 | 51.368 |
| aguarda: cold-start | 41 | 16.453 |
| aguarda: substituído | 2 | 420 |

(filtro preliminar, com `cmc_ledger` como única evidência de entrada e sem o corte de cadastro recente/não-mercadoria do
servidor — a RPC final é mais restritiva; o número que vale é o da tela depois do apply.)

## O que entrou

- **`raio_x_inequivoco(p_empresa, p_sku)`** (INVOKER, `cap_custo_ler`): a REGRA INTEIRA no servidor, nada de AND no React
  (Codex desenho P0-4). SKU com saldo>0 é inequívoco quando NENHUM impedimento vale; `motivos_espera` lista TODOS os que
  valem. Consumo = `v_sku_demanda_efetiva` (venda + explosão PCP + substituição, P0-3), parado = consumo 0 OU cobertura
  >365d; **entrada em 90d por 3 evidências** — recebimento real (`sku_leadtime_history.t4_data_recebimento`), NF de
  entrada do armazém e observação do `cmc_ledger` — qualquer uma segura (P0-2: o ledger só grava quando o CMC muda; compra
  ao mesmo custo era invisível); não corante LC; não cold-start; não substituído; não cadastro <90d; mercadoria pelo
  servidor (classe giro, não 01/03/07/08/09/99, famílias/descrições de uso e consumo e não-mercadoria, manual vence).
  Desconhecido AGUARDA: sem NF (colacor), fonte de consumo velha, cadastro incompleto. `qtd_liquidavel` = saldo − 90d de
  consumo (liquidar não zera quem ainda gira, P1-8); `revisar_em` = entrada + 90d.
- **`raio_x_decidir`**: liquidar NOVO (destino mudou) fora do inequívoco → **RX004**, nada escrito (P0-1: confirmação no
  React não segura chamada direta nem cliente antigo). Re-salvar liquidação já decidida continua passando. Mesma
  assinatura; PRE confere o corpo vivo (md5 da 20261016120000 ou desta).
- **`raio_x_decisao`** + `frete_estimado`, `desconto_sobre_medio_pct` (1 − piso/médio 12m — desconto COMERCIAL, não
  deságio financeiro, P1-7), `margem_unit` (piso − CMC), `preco_medio_base`, `cmc_base` (bases CONGELADAS ao planejar),
  `troca_contrapartida` ('giro' | 'encalhe'). `raio_x_planejar` ganha `p_frete` e `p_troca_contrapartida` (DEFAULT NULL:
  o cliente antigo de 8 argumentos resolve na função nova — provado; assinatura velha dropada, ACL reemitida).
- **`raio_x_medicao`** devolve `troca_contrapartida`; a tela separa "troca por outro encalhe" do crédito que conta no
  critério da meta (encalhe não libera nada).
- **App**: selo "inequívoco · liquidável N un" / "aguarda: motivos" na lista, filtro Inequívoco/Aguarda, aviso no painel
  de decisão quando liquidar vai ser recusado, frete e contrapartida no plano de execução, mensagem RX004.

## Codex (desenho, gpt-6-astra high, 240 s): 6 P0 + 4 P1

Absorvidos: P0-1 (RX004 no servidor), P0-2 (3 evidências de entrada), P0-3 (`v_sku_demanda_efetiva`), P0-4 (desconhecido
aguarda; classificação no servidor), P1-7 (bases congeladas, desconto NULL sem médio), P1-8 (`qtd_liquidavel`), P1-9
(`revisar_em`, todos os motivos), P1-10 (fixture com UM impedimento + 9 falsificações), P2-11 (cliente antigo provado).

**Não entregue (registrado, não escondido)** — P0-5/P0-6: "caixa líquido RECEBIDO" por liquidação exige rastrear
decisão → item vendido → título → baixa monetária (rateio por SKU, parcial, devolução). A medição continua sendo estoque
reduzido a custo + receita faturada, rotulada como tal e com a troca por encalhe fora. É entrega própria (ledger de
recebimento por SKU) e o critério da meta é decisão do founder.

## Codex adversarial de CÓDIGO (gpt-6-astra high, 284 s, 131k tokens) — 4 P1 + 5 P2, absorvidos

- P1 `sku_leadtime_history.empresa` é ENUM (`empresa_reposicao`): comparação com text quebrava a RPC em prod e o stub text
  escondia → `::text` + stub com o enum real. P1 unidade da venda ≠ do estoque (CX × UN) inflava a cobertura → motivo
  `unidade_divergente`. P1 insumo em `v_pcp_malha_oben_quarentena` perdia o consumo explodido e virava "zero" → motivo
  `insumo_em_quarentena`. P1 bases "congeladas" eram reescritas a cada salvamento → só releem quando o PISO muda.
- P2 cliente antigo (8 args) apagava frete/contrapartida → DEFAULT-sentinela (-1 / 'manter'); NULL explícito limpa.
  P2 refetch com erro servia veredito velho → `isError` ⇒ mapa null. P2 soma do filtro sem custo → "R$ —" + "N sem
  custo"; rótulo "entre os parados". P2 margem escondida sem médio → mostrada.
- Confirmado sem finding: gate sem bypass pelo PostgREST; `ARRAY_REMOVE` nunca gera string vazia; PRE por md5 confere os
  dois corpos; INVOKER dentro do DEFINER roda como postgres (lê MAIS impedimentos que a tela — erra para a espera).

## Prova

`db/test-raio-x-inequivoco.sh` (âncoras 20261016120000 + 20261031130000 + 20261031180000 + esta): gate 42501/22023;
controles positivos (cobertura 405d; sem consumo sem divisão por zero); UM impedimento por fixture (365 exato, corante,
recebimento real com CMC inalterado, NF de entrada, ledger, cold-start, substituído, tipo 07, descrição MÁQUINA, saldo 0,
sem cadastro, cadastro novo, dois motivos, manual vence, colacor sem NF, fonte velha); RX004 (recusa, sem linha-base;
inequívoco passa; trocar passa; re-salvar antigo passa; voltar a liquidar é novo); planejar v2 (frete, bases, 22023s,
cliente de 8 args, desconto NULL sem médio); medição com contrapartida; re-aplicação idempotente (PRE aceita o próprio
corpo); bases congeladas (fontes mudam, mesmo piso não relê); cliente de 8 args preserva frete/contrapartida; **13
falsificações** com o FALHOU específico. Em `LOCALE=C` e `pt_BR.UTF-8`.

## Apply em prod (2026-11-01, founder: "Sim, ensaio e apply")

- Pré-voo psql-ro: os 22 objetos referenciados existem; `raio_x_decidir` vivo com md5 `3f803bd3…` (= 20261016120000, PRE
  aceita); `raio_x_medicao` vivo com o retorno da 20261031130000 (o novo só acrescenta `troca_contrapartida` no fim);
  assinatura de 8 args de `raio_x_planejar` presente. `wt:preflight --full` 🟡 (só evolução serial de migrations commitadas).
- Arquivo sem `BEGIN;/COMMIT;` para o executor (commit `e6067a5fa`); prova PG17 verde de novo em `LC_ALL=C` e `pt_BR.UTF-8`.
- `bun run db:aplicar … --ensaio`: inteiro + `RAIO-X-INEQUIVOCO-OK` + ROLLBACK. Apply: **recibo #843**, sha256 `c98ad6f3…`.
- 2ª testemunha psql-ro: 4 funções com ACL desenhada (anon/public não, authenticated sim; inequívoco/medição INVOKER,
  planejar/decidir DEFINER), assinatura velha de planejar removida, decidir com md5 `307b5777…`, 6 colunas + 2 constraints
  validadas, **17 decisões existentes intactas (10 liquidar)** — RX004 só recusa liquidação NOVA.
- O número de inequívocos não foi lido: o gate `cap_custo_ler(auth.uid())` exige staff real e não forjei claims para um
  relatório. **Próximo sinal (query, não recado)**: depois do Publish, a tela mostra o total; conferir que liquidar um SKU
  "aguarda" devolve RX004 e que `raio_x_decisao` ganha `frete_estimado`/`troca_contrapartida` no 1º plano salvo.

## Incidente pós-Publish: 403 no veredito (2026-11-01) e a correção DEFINER

- **Sintoma (QA visual no Chrome logado, depois do Publish):** a aba Raio-X mostrava "veredito inequívoco indisponível —
  nenhum SKU é tratado como inequívoco por omissão". A rede mostrou `POST /rest/v1/rpc/raio_x_inequivoco` → **403**.
  O fail-closed funcionou (nada virou inequívoco por omissão), mas a feature estava morta para o usuário.
- **Causa:** `raio_x_inequivoco` nasceu `SECURITY INVOKER` e o corpo chama `public._fin_estoque_classe`, helper interno
  fechado para `authenticated` pela 20261018200000 (postcondição "helper interno exposto"). Medido em prod por
  `has_function_privilege`: dos 16 objetos do corpo, só esse dava `false`. O `raio_x_decidir` (DEFINER) não era afetado.
- **Por que a prova PG17 não pegou:** o harness faz `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO
  authenticated`, então o STUB do helper nascia aberto. Teste verde contra uma ACL que prod não tem. Corrigido: o stub
  agora leva o `REVOKE` de prod, e a suíte fica VERMELHA (`permission denied for function _fin_estoque_classe`) sem a
  correção — o controle negativo virou passo da prova, não recado.
- **Correção:** `20261101190000_raio_x_inequivoco_definer.sql` — mesmo padrão das demais RPCs de custo do Raio-X
  (DEFINER + gate `cap_custo_ler` no corpo). Corpo byte a byte igual (md5 `903937e4…` no PRE e na PÓS), só o cabeçalho
  muda; o helper continua fechado (PÓS confere). Registro em `authz-manifest.ts` e `authz-funcoes-fechadas.ts`.
- **Lição:** stub de harness herda a ACL do default privileges, não a de prod. Para RPC `INVOKER`, todo objeto do corpo
  tem de existir no harness com a MESMA ACL de prod — senão a prova mede um banco mais aberto que o real.
- **Aplicado (founder: "Sim, aplique"):** recibo **#845**; 2ª testemunha psql-ro: DEFINER, md5 do corpo igual, `search_path`
  fixo, anon/public sem EXECUTE, helper ainda fechado. Codex (gpt-6-astra high): APROVO, sem P0/P1; P2 = esta prova
  não está em `db/nucleo-ci.txt` (nenhuma do Raio-X está) — pendência registrada, não feita aqui.
- **Tela depois do apply (Chrome logado, 2026-11-01 ~18:50Z):** aviso de indisponível sumiu; selos aparecem
  ("inequívoco · liquidável 174 un" no ALMASUPER KIT MDF); filtro **"Só inequívoco (164 · R$ 91.956)"** — o número
  que vale, mais restritivo que o preliminar de 217 / R$ 107.799 da tabela acima.
