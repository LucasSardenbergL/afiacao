# Casos do money-path — helper espelhado: canárias, "define e chama" e a cópia sem bloco (B1)

> Caso extraído de `docs/agent/money-path.md` no piloto N do plano v2 (2026-10-19): o doc de agente ficou só com a regra viva; a narrativa e os números moram aqui. Os `§N` citados referem-se aos princípios de [money-path.md](../agent/money-path.md); as datas e PRs são os da narrativa original.

## Paridade textual + canária comportamental; a canária do `analyze-unified-order` aposentada (2026-09-30)

Edge só-TS (sem contraparte SQL): a paridade vira **textual no CI** — bloco entre `// MIRROR-START/END` comparado normalizado src×edge (pega reescrita do Lovable no deploy) — **mais** uma **canária comportamental** `{canary:true}` staff-gated que roda o helper REAL deployado com fixture fixo e retorna `{resolved, expected, ok}`. Probe HTTP = única prova do COMPORTAMENTO em produção: o guard textual cobre a FONTE, a canária cobre o DEPLOY. ⚠️ A canária prova "helper deployado + lógica certa", **não** que o real-path usa o helper (isso é o guard textual + paridade). Ex.: `identidade_probe` (`omie-vendas-sync`); `doc_ambiguo_probe` (`omie-analytics-sync`, P1b — indispensável ali: a ausência do helper é invisível no dado, a proof-table só encolhe com duplicata-CNPJ real na conta, que não há). Até 2026-09-30 o exemplo canônico era o merge de preço do `analyze-unified-order` (#1089) — APOSENTADO quando a edge deixou de precificar; a canária dela passou a atestar `ia-nao-precifica-v1` ([historico](../historico/ia-nao-precifica.md)).

## "Define E chama" não prova que o produto chega a alguém (2026-08-25)

**"Define E chama" não prova que o produto do helper CHEGA a alguém.** O guard usual do espelho —
`expect(src).toMatch(/helper\(/)` mais a contagem de ≥2 menções — casa o NOME e conclui o EFEITO.
Quando o helper é PURO (o valor de RETORNO é o produto), `helper(args);` como sentença solta calcula
tudo e joga fora, e o gate fica verde sobre a edge que voltou ao comportamento proibido. Medido em
2026-08-25: 7 asserts do `edge-money-path-invariants` aprovavam a forma descartada (identidade
self-service, fail-closed de doc ambíguo, classificação de lote, owner-map, elegibilidade e ordem da
fila de leadtime, acumulador de uso de cache). Ancore na FRONTEIRA com `vereditoFronteira` de
`@/lib/gates/retorno-consumido` — assert POSICIONAL, porque enumerar embrulhos (`const X = helper(`)
reprova predicado de `.filter`, comparador de `.sort`, propriedade de objeto e ramo de ternário, e o
conserto de um gate que reprova código correto é sempre afrouxá-lo. Cuidado gêmeo: `descartes === 0`
sozinho aprova ZERO chamadas — o veredito trata "não encontrei" como vermelho, senão uma renomeação
apaga o guard em silêncio. Não vale para função chamada pelo EFEITO colateral (`await derivar(...)`
solto é legítimo): ali o assert certo é o posicional do próprio site.

## Paridade só vigia o espelho que tem BLOCO (B1, #2633)

**Paridade só vigia o espelho que tem BLOCO — cópia sem marcador deriva no escuro (B1, #2633).** O
`sanitizeForPostgrestOr` da `analyze-unified-order` nunca teve `MIRROR-START`: o #1051 (2026-06-24) pôs
o `*` só em `src/lib/postgrest.ts`, e a edge passou ~3 meses montando `name.ilike.%***%` (match-all em
`profiles`), com o espelho do tool MCP em dia ao lado. Helper com mais de um espelho pede **descoberta +
paridade**: a assinatura estrutural da cópia (ali, literal de regex com `%` e `_` na mesma classe)
varrida em `src/`+edges, e todo hit fora da fonte tem de morar num bloco comparado com ela. Assim a cópia
NOVA nasce vigiada, sem depender de alguém lembrar de marcá-la (describe "classe B1" do
`edge-money-path-invariants`). Bundle GERADO (`supabase/functions/mcp`, do `@lovable.dev/mcp-js`) perde
os comentários no esbuild: confira-o pelo literal, não pelo bloco.
