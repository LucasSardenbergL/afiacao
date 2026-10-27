# Saldo de conta corrente fresco e NCG por leitura pontual (plano v3, itens 2 e 3)

**Data:** 2026-10-26 · **Edges:** `fin-cashflow-engine` `v2.0-saldo-cc-fresco` · `fin-valor-engine` `v1.1-ncg-leitura-pontual` · **Publish:** sim (`src/` muda o que a Posição Agora e o Cockpit exibem) · **Migration:** nenhuma · money-path.

## Item 2 — saldo ausente ou velho entrava no caixa como número

### Por que

O `omie-financeiro` lê o saldo de cada conta pelo extrato (`ListarExtrato`). Quando o extrato falha, o upsert **preserva** o saldo anterior: não mexe em `saldo_atual` nem em `saldo_data` (`omie-financeiro/index.ts:680-700`). Nenhum leitor conferia `saldo_data`, então um saldo de dias atrás entrava com cara de hoje. E dois leitores somavam conta sem saldo como zero:

- `getCapitalDeGiro` (`financeiroService.ts`): `(c.saldo_atual || 0)` → `saldo_cc`, `capital_giro_liquido`, `saldo_projetado_30d` (Posição Agora: KPIs, Projeção 30d, Comparativo, Stress Test);
- `fin-cashflow-engine`: `Number(c.saldo_atual ?? 0)` → saldo inicial das 13 semanas, NCG, dias de cobertura e tesouraria, persistidos pelo cron.

### O que a medida mostrou (psql-ro, 2026-10-27 01:23Z)

- 40 contas ativas (colacor 15, colacor_sc 10, oben 15): 0 com `saldo_atual` nulo, 0 com `saldo_data` nulo, todas com `saldo_data` = 2026-10-26. O bug estava **latente**: a correção não muda nenhum número de hoje.
- `saldo_data` é **DATE** (o dia de SP em que o extrato respondeu), não timestamp.
- `saldo_atual` tem **DEFAULT 0**. Uma conta nova cujo 1º extrato falhe nasce "R$ 0" com `saldo_data` NULL, e o `saldo_atual == null` do `saldoIndisponivel` antigo nunca dispararia (money-path §2, "valor com DEFAULT constante não é fato"). O sinal confiável de ausência é `saldo_data` NULL: o writer só grava os dois juntos.
- `fin-sync-base-diario` (jobid 75) roda `0 6 * * *` UTC = 03h SP, todos os dias.

### A regra

`classificarSaldoConta` (espelho verbatim `src/lib/financeiro/saldo-contas.ts` ↔ `fin-cashflow-engine/saldo-contas.ts`, paridade no vitest):

- **fresca**: `saldo_data` de hoje ou de ontem (SP). O plano falou em 36 h; com coluna DATE e sync às 03h, o eixo é o dia-calendário. "Hoje ou ontem" tolera até ~45 h desde o último extrato bom, e anteontem significa ≥1 sync diário perdido.
- **velha**: anteontem ou antes.
- **desconhecida**: `saldo_data`/`saldo_atual` nulo, valor ilegível, data ilegível ou futura.

Consumidores:

- **Tela** (`resumirSaldoContas`): qualquer conta não fresca, ou nenhuma conta ativa → `null` + motivo. Vale para `getCapitalDeGiro` (`saldo_cc`, `capital_giro_liquido`, `saldo_projetado_30d` passam a `number | null`, e `saldo_cc_motivo` é novo) e para `getResumoFinanceiro` (`saldo_total_cc`, cujos consumidores já tratavam `null`; agora ele também pega conta velha e a do DEFAULT 0). O consolidado fica `null` se UMA empresa estiver indisponível. KPIs/Projeção/Stress Test mostram "—" e o motivo, sem alerta de déficit.
- **Edge** (`saldoInicialDasContas`): conta desconhecida **lança**, como a lista vazia já lançava (`exigirLinhas`): o saldo é o ponto de partida de todas as semanas e não há "—" possível. Conta velha **entra datada**, com motivo em `confianca_dados.motivos` (a NCG e o Ciclo já exibem). Lançar derrubaria a projeção inteira por uma conta cujo extrato o Omie parou de responder, e o snapshot anterior ficaria no lugar sem aviso.

### Fora do escopo (registrado, não mexido)

- O data-health por empresa usa `max(saldo_data)` (`db/aplicar-sync-reprocess-degradado-vigiadas.sql:37-38`): uma conta fresca esconde as velhas. A tela e a engine agora olham conta a conta, então a lacuna sobra só no sensor.
- O produtor: `DROP DEFAULT` de `saldo_atual` (gravar NULL de verdade) seria migration. O consumidor já trata `saldo_data` NULL como ausente, então o DEFAULT não chega mais à soma.
- A lista `contas_correntes` do resumo ainda exibe `saldo_atual ?? 0` por conta.

## Item 3 — o cockpit de valor lia os snapshots de NCG com o eixo errado

### Por que

`fin-valor-engine` lia `fin_projecao_snapshots` com `order(snapshot_at desc).limit(400)`, sem janela e com o `error` descartado (`const { data: snaps }`). A engine A1 grava 3 cenários por dia por empresa (a NCG independe do cenário), então 400 linhas ≈ 133 dias. O ponto −12m do ROIC incremental (`acharCapitalGiroAnterior`, 365 ± 60 d) estaria sempre fora: o incremental sairia "histórico insuficiente" para sempre, em silêncio. E uma falha de leitura virava "sem snapshot de NCG — rode a engine A1".

### Medida (psql-ro, 2026-10-27)

colacor 427, colacor_sc 439, oben 433 linhas. As 400 mais recentes já cortam em 2026-06-02/06/04. O snapshot mais antigo é de 2026-05-25. Há 0 NCG nulo e 0 NaN. Índice `fin_proj_company_snap_idx (company, snapshot_at DESC)`. O −12m passa a existir em ~2027-03-26 (2026-05-25 + 365 − 60 d), e o founder lê o ROIC incremental.

### A regra

Aumentar o limite só adia (o teto é o EIXO, [roteirizador-corte-cidades.md](roteirizador-corte-cidades.md)). `lerSnapshotsNcg` (`fin-valor-engine/snapshots-ncg.ts`) faz duas leituras pontuais, independentes do volume:

1. a mais recente com NCG não nula (`limit 1`);
2. a vizinha de cada lado do alvo (recente − 365 d): `lte` desc `limit 1` + `gte` asc `limit 1`.

`acharCapitalGiroAnterior` (intocado, espelho do `src`) escolhe a mais próxima e aplica a tolerância: é o mesmo vencedor da varredura do histórico inteiro. Erro no ponto atual → **500**, como a DRE logo acima no mesmo handler. Erro em qualquer vizinha → só o ponto atual + motivo "Falha ao ler o NCG do ponto −12m", e o incremental fica indisponível sem dizer "histórico insuficiente". O teste Deno prova com 1.260 linhas que o −12m é lido, e que as 400 mais recentes não o contêm.

Diferença aceita: um NCG `NaN` no ponto mais recente agora deixa o giro indisponível (antes caía no anterior válido). Hoje há 0 NaN, e o efeito é fail-closed.
