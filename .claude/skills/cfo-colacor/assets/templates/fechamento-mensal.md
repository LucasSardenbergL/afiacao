# Fechamento gerencial — Grupo Colacor — {MÊS}/{ANO}

> Diagnóstico gerencial, READ-ONLY, gerado pela skill `cfo-colacor`. **Não é apuração
> contábil/fiscal.** Números marcados com ⚠️ dependem de configuração (mapeamento, estoque
> valorado) ou são estimativa observada — confirmar com contador onde indicado.
> Dados extraídos do Supabase via SQL no Lovable em {DATA_EXTRACAO}. Último sync Omie: {ULTIMO_SYNC}.

## 1. Resumo executivo (3 linhas)
- **Caixa**: {situação em 1 frase — folga/aperto, pior semana das 13}.
- **Resultado**: {resultado líquido do grupo no mês, regime usado}.
- **Atenção**: {o risco nº1 do mês — inadimplência / NCG / tributo / divergência}.

## 2. Caixa — projeção 13 semanas
| Empresa | Saldo hoje | Pior semana (saldo) | Quando | Bandeira |
|---|--:|--:|---|---|
| Colacor |  |  |  | 🟢/🟡/🔴 |
| Oben |  |  |  |  |
| Colacor SC |  |  |  |  |

Gatilho de alerta vermelho: saldo projetado negativo em qualquer semana **OU** dias de
cobertura abaixo do threshold de `fin_config_cashflow`. Alertas ativos: {listar de 01d}.
> O cross-check SQL não desconta inadimplência nem inclui folha/eventos (01c). Confronte com
> a tela /financeiro/capital-giro (engine canônico) antes de concluir.

## 3. NCG / capital de giro
| Empresa | ACO | PCO | NCG | Cap. Giro Próprio | NCG > CGP? |
|---|--:|--:|--:|--:|---|
| Colacor |  |  |  |  |  |
| Oben |  |  |  |  |  |
| Colacor SC |  |  |  |  |  |

⚠️ Estoque = {valor de fin_estoque_valor ou "0 (não valorado → NCG subestimada)"}.

## 4. Inadimplência (aging de recebíveis)
| Empresa | A vencer | D+1–7 | D+8–30 | D+31–90 | D+90+ | % vencido | Conc. top1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| Colacor |  |  |  |  |  |  |  |
| Oben |  |  |  |  |  |  |  |
| Colacor SC |  |  |  |  |  |  |  |

**Lista de cobrança prioritária** (top devedores vencidos, ação por faixa): {tabela de 03b}.

## 5. DRE gerencial
Regime usado: **{caixa|competência}** — motivo: {confiabilidade, pct_valor_mapeado}.
| Linha | Colacor | Oben | Colacor SC | Grupo* |
|---|--:|--:|--:|--:|
| Receita bruta |  |  |  |  |
| Receita líquida |  |  |  |  |
| Lucro bruto |  |  |  |  |
| Resultado operacional |  |  |  |  |
| Impostos |  |  |  |  |
| **Resultado líquido** |  |  |  |  |

\* Grupo = soma simples ⚠️ {com|sem} eliminação intercompany.

## 6. Confiabilidade do DRE
| Empresa | % valor mapeado | Categorias sem mapeamento | Heurística | Status |
|---|--:|--:|--:|---|
| Colacor |  |  |  |  |
| Oben |  |  |  |  |
| Colacor SC |  |  |  |  |

Categorias a classificar em /financeiro/mapping: {lista de 05, por valor}.

## 7. Carga tributária observada ⚠️ (não é apuração)
| Empresa | Regime | Receita bruta | Impostos | Alíq. efetiva | Faixa esperada | Bandeira |
|---|---|--:|--:|--:|---|---|
| Colacor | Presumido |  |  |  | ~11–16% |  |
| Oben | Presumido |  |  |  | ~11–16% |  |
| Colacor SC | Simples |  |  |  | faixa RBT12 |  |

Colacor SC — RBT12: {valor} ({pct}% do teto de R$ 4,8 mi).
> Itens não cobertos (ICMS/IPI/ST/monofásico/Fator R): só o contador fecha.

## 8. Intercompany
Divergências: {de 07a/07b}. Eliminações aplicadas no período: {07c}.

## 9. Orçado vs realizado + status de fechamento
Status formal do período (08a): {aberto / em_revisão / fechado / reaberto, por empresa — ou "nunca fechado"}.
| Empresa | Linha DRE | Orçado | Realizado | Desvio | Desvio % |
|---|---|--:|--:|--:|--:|
| | | | | | |

> Sem orçamento cadastrado em `fin_orcamento`? Registre "sem base orçamentária pra comparar"
> e siga. Maiores desvios viram pergunta pro contador ou ajuste de premissa.

## 10. Movimento desde o último fechamento
{O que mudou vs o mês anterior — caixa melhorou/piorou, inadimplência subiu, etc. Use a
tendência de 04c/06c. Pule na 1ª execução.}

---

## Perguntas pro contador
{Cole aqui a saída de assets/templates/perguntas-contador.md preenchida.}
