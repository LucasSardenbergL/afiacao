# Crescimento na base comparável: o "same store" por cliente no Master

**2026-10-10.** Card novo no dashboard Master: separa a variação da receita dos 3 últimos meses fechados em
base comparável (cliente com pedido nos dois períodos), entraram e saíram, contra o mesmo trimestre do ano
anterior ou os 3 meses antes. Spec: `docs/superpowers/specs/2026-10-10-crescimento-base-comparavel-design.md`.

## Por que valeu construir (medido antes de codar)

O número de cima contava a história errada nos dois sentidos. Colacor set/ago: −11% no total com a base em
+0,6% (giro de avulso). Colacor jul–set vs abr–jun: −22% no total com a base em **−29%** (é a base que
encolhe). Na janela mensal a base comparável da Colacor era 24 clientes (28% da receita) — por isso a janela é
trimestral (79–93% da receita).

## O achado que mudou o desenho

O P1 do Codex ("mês fechado não é dado congelado; valide a cobertura") foi medido contra o DRE por competência:
os pedidos do app cobriam **36–67%** da receita contábil da Colacor em jul–set/25 e **90–115%** desde out/25
(Oben fica acima de 100% e oscila). Comparar essas janelas mede o sync, não o negócio: cliente que em 2025 só
comprou por pedido não sincronizado vira "entrou" em 2026. Daí a régua: coberturas das duas janelas a até
**1,2×** por empresa, senão a comparação é suprimida com o motivo. Na prod, ela bloqueia exatamente o YoY da
Colacor (0,49 vs 0,91 = 1,86×) e deixa os outros três cortes (1,08–1,12×).

## Lições

- **Decomposição antes de construção:** a query de 30 linhas que mostrou o −29% escondido justificou o card; a
  mesma query, refeita pelo helper sobre as linhas reais, foi a reconciliação final (bateu nas 4 combinações e
  nas contagens). A identidade da ponte prova a álgebra, não que o pedido certo entrou na janela certa.
- **O banner "Dados de venda parciais" do Master** afirma cobertura parcial; a medição mostra 90–155% desde
  out/25. Ele pode estar velho — candidato a virar condicional sobre a cobertura medida (fora deste PR).
- **Teste cujo nome contradiz a asserção é defeito no código, não no teste:** "cobertura 0 é sinal, não
  ausência" esperava "não verificada" — a regra tratava sync que perdeu a janela inteira como dúvida, e a
  ponte mostraria todo cliente como "saiu". Virou "incomparável".

## O sensor que não media (2026-10-12)

O card foi visto com números (confirmado pelo founder, com `/meu-dia` rolado a 100%) e o PostHog tinha
**zero** `dashboard.crescimento_comparavel_visto`. Eram dois defeitos empilhados, e o segundo só apareceu
depois de consertar o primeiro:

1. **Limiar único** (#3006): `threshold: [0, 0.5]` + `ratio >= 0.5`. O navegador chama o callback só ao
   CRUZAR um limiar, e no cruzamento pode reportar 0,4999 — era a única chance. Agora são cinco limiares
   e tolerância de 0,02, com teste de regressão e as duas sabotagens vermelhas.
2. **Canal censurado:** o Chrome do founder bloqueia `us.i.posthog.com` (já documentado em
   `docs/agent/analytics.md`). A prova veio do par imune: `telemetria_probes` registrou os boots
   (23:25/23:27 UTC, build novo) e o PostHog, nenhum evento web. Uma exceção no bloqueador funcionou
   por alguns minutos e não sobreviveu à reabertura das abas.

**Conserto do 2:** o card grava também no **ledger** (`analytics_ledger_registrar`), que escreve pelo
domínio do app. Migration `20261012233500` (allowlist + postcondição que exige os três eventos), aplicada
pelo `db:aplicar` (recibo #384) com md5 do corpo na prod = o da migration; prova PG17 nos dois locales
(`db/test-analytics-ledger-crescimento.sh`, 10 asserts, 2 sabotagens abortadas pela postcondição). Teste
de **paridade** banco × `EventoLedger` (o ledger é fail-open: evento fora da allowlist sumiria calado).

**Lição:** sinal que decide fase seguinte nasce no ledger, não só no PostHog — a regra já estava no
`analytics.md`; o card a violou na origem, e o custo foi um dia de sensor mudo. "Superfície nasce com
o sensor" exige o sensor **no canal que o usuário principal não bloqueia**.

**Prova de ponta a ponta (2026-10-13):** #3021 publicado (bundle `MeuDia-*.js` com o evento; o carimbo
saiu `dev`, caso previsto no `vite.config.ts`, então a prova foi pelo conteúdo). Com zero linhas antes,
o founder abriu `/meu-dia` no Chrome que bloqueia o PostHog: outbox #2132 (00:45:57Z, oben, `ano_anterior`,
origem `padrao`) e #2133 (00:48:22Z, `meses_anteriores`, origem `manual` — ele trocou o modo). O drain das
00:50 aceitou as duas, e o PostHog tem exatamente as duas (`$lib=analytics-outbox`, mesmo `distinct_id`).
O sensor do card mede. O #4 (ranking normalizado) espera algumas semanas desse sinal.
