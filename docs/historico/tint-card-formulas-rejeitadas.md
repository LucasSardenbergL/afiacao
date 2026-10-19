# Tintométrico: o card "Últimos Erros de Importação" dizia "5 erro(s)" e nunca quais (2026-10-18)

## Sintoma
O founder esperava que as mensagens de erro do `/tintometrico` tivessem sumido. A tela mostrava 5 blocos
`sync:<uuid> · sync_agent · 16/10/2026 · 5 erro(s)`, todos iguais, sem dizer o que falhou.

## Diagnóstico (psql-ro)
- O card lia `tint_importacoes` com `registros_erro > 0` e tentava renderizar `erros_detalhe`. O writer vivo
  (`tint_promote_sync_run`) **nunca preenche `erros_detalhe`** — 0 de 4.160 linhas com erro. O detalhe
  vive em **`tint_sync_errors`** (uma linha por fórmula rejeitada, com `entity_id` = cor e `error_message`).
- Os "erros" são fórmulas que o Guard 4 rejeita por **receita corrompida na fonte** (SayerSystem):
  `303U - BS` (dose sem corante, 16 fórmulas), `PRETO`, `AGIL INOX`, `J115 MARROM ZAMBALDE`, `7585`
  (corante com dose 0). Dado da fonte, guard certo — `docs/agent/tintometrico.md` já dizia desde julho.
  Como o conector re-envia o mesmo lote a cada ciclo, as mesmas cores viravam uma entrada por run
  (`303U - BS` em >1.100 runs desde 21/09). O card contava runs, não cores.
- Achado colateral, fora do escopo: **0 runs em 17 e 18/10** (último em 16/10 19:49; gap normal é a noite,
  ~14h). Conector ou máquina da loja parados — não é bug de código daqui.

## Entrega
`TintDashboard.tsx`: hook `useFormulasRejeitadas` lê o **último run de fórmulas** (`tint_sync_runs`) e as
linhas dele em `tint_sync_errors`, deduplica por cor, conta fórmulas e encurta o motivo (cabeça antes de
` (`, ` + ` e ` — `). Card "Fórmulas rejeitadas pela fonte": data do run, nº de cores, lista cor · motivo ·
`N fórmulas`, e a frase de que a correção é na máquina. Run com `errors>0` e lista vazia mostra
"N rejeições sem detalhe" — nunca "tudo certo". Run inexistente → card some sem aviso (`null` ≠ `undefined`:
o aviso de leitura só cabe quando NÃO leu). Testes em `TintDashboard.leitura-falhou.test.tsx` (dedup,
contagem, motivo curto, data, sem-detalhe, sem-run, e os 5 eixos antigos de leitura falhada mantidos).

## Lição
Card de "erros" que lê uma coluna que o writer vivo não escreve é o mesmo defeito da forma que mente
(`a-forma-que-some-e-a-forma-que-mente.md`), só que por outra porta: ele existe, aparece, e não informa.
Antes de desenhar a leitura, `select count(*) filter (where coluna is not null)` na coluna que ela vai mostrar.
