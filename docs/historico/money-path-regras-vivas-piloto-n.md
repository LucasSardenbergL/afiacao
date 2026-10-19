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
