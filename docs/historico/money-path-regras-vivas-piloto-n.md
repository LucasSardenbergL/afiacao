# Piloto N do plano v2: `money-path.md` reescrito como regras vivas (2026-10-19)

Item N de "Depois do Top 5" do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md) (§3 · decisão #2 do §5, aprovada pelo founder em 2026-10-19): um domínio de `docs/agent/` reescrito como **regra viva** — cada regra com _Quando_ · _Obrigação_ · _Exceção_ · _Evidência_ — e os casos movidos para `docs/historico/`, para **medir antes de generalizar** aos outros docs de agente. `deploy.md` ficou fora de propósito (`gates:frescura` o lê como texto).

## O que mudou

- `docs/agent/money-path.md`: 468 linhas / 194.593 bytes / 29.934 palavras → 263 linhas / ~73 KB / ~9,5 mil palavras (**−62% em bytes**; contexto estimado por chars/4: ~48,6k → ~18,3k tokens). Numeração §1–§17 e os 17 títulos de seção **preservados byte a byte** (são citados por migrations, edges, testes e hooks: `money-path.md §2`, `§"O ALVO mente"`, `§"Helper espelhado"`).
- 10 arquivos novos `money-path-casos-*.md` (159 KB) com as 167 linhas do doc antigo que carregavam narrativa própria, copiadas **verbatim** por script a partir de `git show HEAD:` — nenhuma reescrita de caso. Casos que já tinham arquivo em `docs/historico/` (33 conferidos por grep de número-chave) só ganharam ponteiro.
- Inventário de 170 regras → destino no corpo do PR; 4 nomes de seção que código cita (`§"o ALVO mente"`, `preflight de CLIENTE não é fronteira de escrita`, `O GATE mente quando a regex não conhece a forma REAL do repo`, `sabotagem que não compila`) foram restaurados depois que a conferência automática (`git grep "money-path.md"` × grep no doc novo) acusou a ausência.

## Como medir a próxima vez (antes de generalizar)

1. **Contexto carregado:** bytes/palavras do doc antes e depois (acima). O KPI do plano é `bytes de money-path.md`.
2. **Erro de execução:** 5 perguntas operacionais reais respondidas por citação de linha no doc novo (tabela no PR) — se uma sessão money-path precisar abrir o histórico para responder a uma delas, a regra viva está incompleta e volta ao doc.
3. **Regressão de âncora:** `git grep -n "money-path.md" -- docs scripts src .claude CLAUDE.md supabase db | grep -o '§"[^"]*"'` e conferir cada nome contra o doc — é o teste que pegou os 4 acima.

## O que NÃO foi feito

- Nenhum outro doc de `docs/agent/` foi tocado; nenhum código.
- Regras não foram fundidas nem cortadas — o piloto mede o efeito de mover NARRATIVA, não de podar regra. Podar é decisão separada, com o inventário na mão.

## Verificação pós-merge (2026-10-21)

O founder aprovou o piloto N em 2026-10-21 pedindo, com estas palavras, que a reescrita fosse feita "medindo contexto antes e depois". A reescrita já estava na main desde o #3185, então esta rodada **mediu e auditou** o que ele entregou, em vez de reescrever de novo. O "195 KB" do plano era o tamanho de antes: o doc estava em 73 KB desde 2026-10-19.

### 1. Contexto carregado

| | Antes do #3185 (`0fbc0c3fc`) | Depois do #3185 | Depois desta verificação |
|---|---|---|---|
| bytes | 194.593 | 73.038 | 75.138 |
| linhas | 468 | 263 | 264 |
| palavras | 29.934 | 9.483 | 9.786 |
| tokens (chars/4) | ~47,0k | ~17,7k | ~18,2k |

Os +2,1 KB desta rodada são as obrigações devolvidas ao doc (seção 2). Ainda dá −61% em relação ao doc antigo.

### 2. Cobertura: auditoria independente das 170 regras

Um auditor separado (subagente Sonnet, só leitura) percorreu o doc antigo regra a regra contra o novo, conferindo o texto em vez do inventário do autor. A 2ª opinião do Codex não rodou: `codex-async.sh` saiu com exit 79 (cota em 94%, teto 85%). Também houve uma varredura mecânica: os 1.203 trechos em crase do doc antigo (gate, script, arquivo, função) existem todos em algum doc do repo. **Nenhuma obrigação sumiu de todo.**

| Inventário #3185 | O que faltava no doc vivo | Classe | Agora em `money-path.md` |
|---|---|---|---|
| #37 (antes L32) | controle de calibração **PAREADO** (com e sem `.order()`); detector que exige laço textual é cego à paginação delegada | REBAIXADA (só em `money-path-casos-paginacao.md`) | §9, "O GATE mente…" |
| #74 (antes L84) | gate de TIPO se falsifica por `@ts-expect-error`; vitest transpila sem type-check; vale só no 1º nível | REBAIXADA (só em `money-path-casos-leitura-que-falha.md`) | §"Helper compartilhado troca o VOCABULÁRIO" |
| #94 (antes L204) | `IF NOT FOUND OR`/`ASSERT FOUND AND`; `count … WHERE col <> x` → `(col = x) IS NOT TRUE` + denominador | REBAIXADA (só em `assert-verde-por-ausencia.md`) | "Assert verde por AUSÊNCIA" |
| #6 (antes L8) | ordem segura: consumidor antes do produtor | limítrofe | §2, "Rótulo/valor com DEFAULT" |
| #95 (antes L205) | `AT TIME ZONE 'UTC'` explícito; ponto cego do timestamptz fora da convenção de nome; medir o outro lado antes de chamar de consistente | limítrofe | "Prova que depende da HORA" |
| #71 (antes L80) | `queryFn` que engole o erro torna inerte o fix de UI | limítrofe | §"A leitura que falha…" |
| — (CLAUDE.md, desde #844) | **sinal money-path nunca em jsonb multi-writer**: o CLAUDE.md aponta para o money-path.md, mas a regra nunca esteve lá (nem antes do #3185) | lacuna anterior ao piloto | §2, sub-regra nova |

Resultado: **167 de 170 cobertas** pelo #3185 e **170 de 170** depois desta rodada. Os 3 limítrofes de justificativa (#169, #122, #59) ficaram no histórico, porque são o porquê da regra e não o que fazer. O inventário do #3185 errava a favor do autor em #37 e #74. **A lição para generalizar:** o inventário feito por quem reescreveu não basta como prova de cobertura; a auditoria tem de vir de outro leitor conferindo o texto.

### 3. Referências

- Uma âncora estava quebrada: `money-path.md § "O LOG mente 2"`, citada em `db/test-fu4f-fase3-paridade-ts-sql.sh:28`. O #3185 tinha escrito "(2)" no lugar do nome. Restaurada.
- As demais âncoras com nome casam no doc. A regressão foi conferida com `git grep "money-path.md"` (380 citações) × o doc.
- `§35`, em `src/lib/scoring/rpcPaginada.ts:6` e `calculate-scores/index.ts:222`, é numeração de uma versão mais antiga, anterior ao #3185. Ficou fora do escopo.
- Nenhum gate ou hook lê trecho literal do money-path.md. `test-ocupacao-por-comando.sh` só usa o caminho como fixture.

### 4. Proxy de "erro de execução"

O teste: 18 perguntas que as sessões fazem, tiradas das armadilhas do CLAUDE.md e das seções mais citadas no código. Para cada uma, `grep -F <palavra-chave>` precisa cair numa linha que, junto com as 2 seguintes, carregue a obrigação. Os scripts estão em `logs/piloto-n/` (gitignorado).

| Métrica | Doc antigo | Doc atual |
|---|---|---|
| perguntas respondidas pelo grep | 16/18 | **18/18** |
| bytes devolvidos pelos 18 greps | 62.288 | **15.647** (−75%) |

As duas que falhavam antes:
- **P08 (jsonb multi-writer):** a regra não existia no doc.
- **P17 (TOCTOU):** a obrigação ficava a mais de 2 linhas do cabeçalho.

O ganho que importa não é o tamanho do arquivo, e sim o que cada consulta devolve: o grep cai numa linha que já é a regra, e não em 8 parágrafos de narrativa.

**Antes de generalizar a outro doc de `docs/agent/`:** rode esta auditoria (outro leitor, conferindo texto) e este proxy *antes* de mergear a reescrita, não depois.
