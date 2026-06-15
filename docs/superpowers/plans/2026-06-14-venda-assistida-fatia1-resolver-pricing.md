# Venda assistida — Fatia 1: resolver + pricing determinístico (decisões + execução)

> Plano/decisões da Fatia 1. Data: 2026-06-14. Design do programa: `docs/superpowers/specs/2026-06-14-venda-assistida-ia-design.md`.
> **Engine puro, testável sem prod nem LLM.** Verificação em prod espera o Publish do casamento (#819) + popular vínculos.

## Decisões do founder (2026-06-14) — money-path

### De-para de litros por embalagem (sufixo Sayerlack + descrição)
| Sufixo | Não-base | Base |
|---|---|---|
| `GL` | 3,6 | 3,24 |
| `QT` | 0,9 | 0,81 |
| `BH` | 20 | 18 |
| `LT` | 18 | — |
| `L5` | 5 | — |
| `BB` | 5 | — |
| `BD` | 18 | — |
| `405ML` (na descrição) | 0,405 | — |
| `CGL` | não existe → sob consulta | |

- **"base" = a descrição contém a palavra "base"** (`/\bbase\b/i`). Bases só vêm em **QT/GL/BH** (litros menores).
- **Fracionado:** item-pai no Omie é `QT`, mas a descrição diz `405ML` → manda a descrição (0,405 L).
- Sufixo fora da tabela → **null → "sob consulta"** (nunca chuta).

### Preço (litro preparado, catalisado)
- **% do catalisador é sobre o VOLUME DA BASE** → `R$/litro preparado = (B + r·C)/(1+r)`, `r = pct/100`.
- `B`/`C` = preço da **MAIOR embalagem disponível** ÷ litros (de-para).
- **Fonte do preço = ÚLTIMO PREÇO PRATICADO PRA AQUELE CLIENTE** (não tabela) — base + o catalisador **que ele já usa**. ⚠️ Codex: o último-praticado **não é contratual** (é copiado Oben↔Colacor) → **rotular "baseado no último praticado"**, nunca "preço fechado". Sem histórico do cliente → fallback tabela (rotulado).
- **Componente obrigatório ausente** (catalisador sem SKU/preço/litros) → `incomplete` ("sob consulta"). **NUNCA soma como zero** (Codex P0).

### Estado (em estoque / encomenda / sob consulta)
- `TECHNICAL_ONLY` — sem casamento (sem SKU) → alternativa técnica, sem preço.
- `SELLABLE_NOW` — base + (catalisador obrigatório) mapeados, **em estoque** E **precificados**. "Em estoque agora" exige **base E catalisador em estoque** (decisão do founder) + preço ok (Codex).
- `ORDERABLE` — mapeado mas não tudo disponível/precificável agora → encomenda.

## Construído (✅ neste branch `claude/venda-assistida-fatia1-pricing`)
- `src/lib/venda-assistida/preco-preparado.ts` — `litrosDaEmbalagem` + `precoLitroPreparado`.
- `src/lib/venda-assistida/resolver-estado.ts` — `classificarEstadoVenda` (primitivo de regras).
- `src/lib/venda-assistida/resolver-opcao.ts` — **`resolverOpcaoVenda`** (entrada money-path coerente: estado + preço das MESMAS embalagens).
- **35 testes** (puros, agnósticos à fonte do preço → a camada de cima decide cliente/tabela/markup).

## Codex adversarial (2026-06-14, xhigh) — 2 P0 + P1/P2, todos fechados
- **P0.1 — proporção ausente eliminava catalisador obrigatório:** `pct=null/NaN/<=0` com catalisador presente virava preço só-da-base (barato) → podia ir a SELLABLE_NOW. Fix: param `temCatalisador`; proporção inválida + temCatalisador → **incomplete** (nunca vira base).
- **P0.2 — preço e estoque de embalagens diferentes:** preço pegava a maior, estado perguntava "alguma em estoque". Fix: **`resolverOpcaoVenda`** calcula o preço de SELLABLE_NOW SÓ sobre embalagens EM ESTOQUE (preço == disponibilidade, coerente por construção).
- **P1:** empate de litros não-determinístico → menor valor vence; maior embalagem sem preço → "sob consulta" (não substitui silenciosa); `\bbase\b` falhava em `BASE_GL` (`_` é word-char) e dava falso-positivo com acento → regex robusta (separador = não-letra).
- **P2:** guard do valor final (Infinity/0) no ramo mono-componente; devolve litros do catalisador (auditável).
- ⚠️ **Decisões mantidas (founder, não-bug):** "base" = literalmente a palavra "base" na descrição; "maior embalagem" pode ter pior R$/L que uma menor (é a regra do founder). Rotular na UI: **"R$/litro preparado (teórico)"**, não "preço do kit/lote".

## Restante da Fatia 1 + Fatia 2 (data-wiring + UI — espera Publish/popular vínculos)
- **Resolver de dados** (hook/RPC): por boletim → SKUs vinculados (casamento `v_omie_product_current_spec`) → agrupar embalagens (sufixo + litros + preço-do-cliente + estoque) → escolher maior → catalisador (casamento do catalisador) → chamar os 2 helpers → opção resolvida `{ estado, preco }`.
- **Preço-do-cliente por embalagem:** o wizard já tem `customerPrices` (por `omie_codigo_produto`) — usar como `valor`; fallback `valor_unitario` (tabela).
- **Catalisador casamento:** o catalisador (`catalisador_codigo` do boletim) precisa do **mesmo casamento** (eu sugiro o vínculo, founder aprova) pra ter SKU/preço/estoque.
- **UI vendedor-only** (card auditável) — Fatia 2.

## Deferido (fatia própria, design próprio)
- **Tabela de catálise** — quais catalisadores um produto aceita + vantagens de cada + markup-pra-migração (preço-do-cliente-no-antigo aplicado ao novo, pra não afastar o cliente). ⚠️ **Fonte do dado em aberto** (planilha do founder? boletim estendido? tabela nova?) — resolver no design dessa fatia. O boletim hoje guarda **só UM** catalisador + proporção.
