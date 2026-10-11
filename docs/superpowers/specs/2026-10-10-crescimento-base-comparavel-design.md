# Crescimento na base comparável — card no dashboard Master

**Data:** 2026-10-10 · **Tipo:** front puro, read-only, sem migration/edge · **Branch:** `claude/kpi-base-comparavel`
**Origem:** leitura do release da JHSF (Brazil Journal, 13/08/2026), que separa *same store* de expansão e
explicita a base de cada recorde. O que se copia é a gramática de medição, não o negócio.

## Problema

O tile "Receita time · mês" compara receita absoluta com o mesmo período do mês anterior. Ele mistura
três coisas que pedem ação diferente: a base que comprou mais ou menos, o cliente que entrou e o que saiu.

Medido na prod (psql-ro, 2026-10-10, universo de venda, chave empresa × cliente):

| corte | total | base comparável | leitura |
|---|---|---|---|
| Colacor set vs ago | −11,3% | +0,6% (só 24 clientes, 28% da receita) | janela mensal é ruído |
| Colacor jul–set vs abr–jun | −21,6% | **−28,9%** (101 clientes, 79%) | a base encolheu |
| Oben jul–set/26 vs jul–set/25 | +18,0% | +12,1% (163 clientes, 85%) | ~6 p.p. vêm de cliente que entrou |

## Decisões (com Codex, veredito "SEGUE COM AJUSTES")

1. **Janela:** 3 últimos meses fechados (SP). Padrão = mesmos meses do ano anterior; alternância = 3 meses
   antes ("3 meses antes", não "trimestre anterior" — não é trimestre civil). Mês fechado dá número estável.
2. **Coorte por presença** de pedido válido nos dois períodos (não por soma positiva).
3. **Ponte fechada** (testada com 300 entradas semeadas):
   `base − saíram + entraram + Δcomparável + ΔsemCliente = atual`.
4. **Tamanho da coorte ao lado do %:** nº de clientes + participação na receita atual **e** na anterior.
5. **Unidade = vínculo empresa × cliente.** No grupo, o mesmo cliente tem um cadastro por CNPJ; quem migra
   aparece como saiu + entrou. Rótulo explícito na visão do grupo.
6. **Paginação por cursor de `id`** (offset pula pedido quando outro sai do universo entre páginas). Não é
   snapshot transacional; aceitável para painel de gestão. Qualquer falha lança: nunca ponte parcial.
7. **Régua de cobertura (acréscimo desta sessão, achado na validação do P1 do Codex):** a receita de pedidos
   ÷ receita por competência (`fin_dre_competencia_base`, `origem='CR'`) **não é estável no tempo** —
   Colacor cobria 36–67% em jul–set/25 e 90–115% desde out/25. Se as coberturas das duas janelas diferem
   mais de **1,2×** (por empresa), a comparação é **suprimida com o motivo**. Calibrado nos casos medidos
   (comparáveis 1,08–1,12×; sync incompleto 1,86×). DRE que falha → "não verificada" (nunca "comparável").
   Cobertura 0 com DRE positivo = incomparável (sync perdeu a janela), não ausência.
8. **Rodada 2 do Codex (revisão do diff, "AJUSTES"):** zero conhecido de cobertura vence DRE ausente na
   outra ponta (senão a ponte mostra −100% e todos "saíram"); a régua avalia as **empresas esperadas** do
   escopo (`colacor`, `oben`; `colacor_sc` fora por desenho — o card explica), não só as que trouxeram
   pedido, senão o grupo passaria só pela Oben com a Colacor de sync morto; razão (e não p.p.) mantida — o
   erro é multiplicativo; CR inteiro aceito como indicador de **consistência**, não prova (o mix não-venda
   pode mascarar); padrão YoY cai para "3 meses antes" **com aviso persistente**.
9. **Sensor:** `dashboard.crescimento_comparavel_visto` {selection, comparacao, estado}, 1x por (empresa,
   comparação), com `origem` padrão|manual; só com dado na tela, ≥50% visível de fato (`intersectionRatio`,
   não só o callback), nunca em loading/erro, e com a visibilidade reavaliada a cada troca de empresa.

## Fora (com motivo)

- **Ranking normalizado por carteira** — o ranking mudou de régua em 2026-10-06; receita/cliente pode
  premiar quem tira cliente difícil da carteira. Precisa de hipótese própria.
- **Deflação por IPCA** — exigiria tabela mantida; nominal rotulado é honesto.
- **Preço × volume por SKU** — itens; fase seguinte, se o card tiver uso.

## Fase N+1

Só com sinal: `dashboard.crescimento_comparavel_visto` com aberturas em ≥3 semanas distintas e uso da
alternância. Query:

```sql
SELECT toStartOfWeek(timestamp) s, properties.comparacao c, count() n
FROM events WHERE event = 'dashboard.crescimento_comparavel_visto'
GROUP BY s, c ORDER BY s
```

## Arquivos

`src/lib/dashboard/crescimento-comparavel.ts` (puro) · `fetch-pedidos-janela.ts` · `fetch-receita-competencia.ts`
· `src/hooks/dashboard/useCrescimentoComparavel.ts` · `src/components/dashboard/CrescimentoComparavelCard.tsx`.
