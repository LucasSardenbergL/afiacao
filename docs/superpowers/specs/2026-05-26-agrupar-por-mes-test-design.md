# Cobertura de teste do `agruparPorMes` — Design Spec

> **Data:** 2026-05-26
> **Status:** continuação autônoma (lane seguro/não-colidente). `src/lib/agruparPorMes.ts` (agrupa registros por mês com headers e meses vazios — usado em `/admin/reposicao/{promocoes,aumentos}`) sem teste. Pura/determinística (com `new Date` fixado). 

## Goal

Travar as 6 funções de agrupamento mensal. Sem mudança de código.

## Regras (do código)

- **`chaveMes`** → `YYYY-MM` de ISO; null/sem-mês → `null`.
- **`formatarMesAno`** → `"Abril 2026"`; mês fora de 1-12/inválido → devolve a chave crua.
- **`chaveMesAtual`** → `YYYY-MM` do mês corrente (`new Date`).
- **`gerarRangeMeses(antiga, recente)`** → todas as chaves no intervalo inclusivo, **do mais recente p/ o mais antigo**; vira de ano; `recente < antiga` → `[]`; chave inválida → `[]`; cap de 600.
- **`agruparPorMes(itens, pegarData)`** → agrupa por mês; padding de meses vazios **do item mais antigo** até `max(item mais recente, mês atual)`; ordenado recente→antigo; item sem data ignorado; lista vazia → `[]`.
- **`chavesUltimosNMeses(n)`** → `Set` dos N meses mais recentes (`new Date`), vira de ano.

## Cenários-chave

- `chaveMes`/`formatarMesAno`: extração + boundaries + inválidos.
- `gerarRangeMeses`: mesmo mês, intervalo, virada de ano, recente<antiga→[], inválido→[].
- Com `vi.setSystemTime(15/05/2026)`: `chaveMesAtual`→`2026-05`; `chavesUltimosNMeses(3/6)`; `agruparPorMes` (vazio, padding de meses vazios incluindo mês atual, extensão a item futuro com old+futuro, **único item futuro NÃO pada até o atual** — o range parte do item mais antigo).

## Testing

`src/lib/__tests__/agruparPorMes.test.ts` (vitest; `vi.useFakeTimers`/`setSystemTime` p/ as date-dependentes). 17 casos, verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- As páginas que consomem; o cap de 600 (safeguard improvável).
