# PCP Colacor — Blueprint (design v3.2 — APROVADA)

> **Status: v3.2 — GATE 0 FECHADO (2026-07-03)**: painel tri-modelo completo — Claude (produto, 13 findings) + Codex (engenharia, 13 + 11 challenge) + Gemini (triagem, 9). Todos os findings dispostos; **founder arbitrou as 2 divergências e respondeu as 4 perguntas finais** (§1 "Arbitragens finais"). Malha Omie validada por print. Próximo passo: plano de implementação da Fase 1 (writing-plans) com novo gate tri-modelo. Artefatos: scratchpad `triagem-HPFZVP/` (claude.json, codex.raw, codex2.raw, gemini2.raw, brief.md).

## 1. Fatos que definem o desenho

### Medidos no banco (psql-ro, 2026-07-03)
- Colacor é **conversora de abrasivos**: jumbos/rolos-mãe (262 SKUs MP: AO 73, Zirconado 35, SiC 19, Não-Tecido 10, Jumbos p/ discos 83) → 1.843 SKUs acabados: **Cintas Estreitas 1.401 (76%)**, Discos 239, Tingidor Tingimix 111, Folhas ~36, Colas 11.
- Receita 180d (R$379k espelhado): fabricado R$234k (62%). **Discos R$120k/64 SKUs — repetitivo** (29 SKUs com 5+ pedidos). **Cintas R$67k/195 SKUs — cauda longa MTO** (71% venderam 1x; zero 13x+). Rolo Flanela R$31k. Folhas R$13k.
- **Rolos cortados (tipo 03, 168 SKUs) são estocados E vendáveis** — BOM multi-nível real.
- **Espelho app↔Omie VERIFICADO**: fin_contas_receber 180d = R$419k (841 títulos) vs pedidos espelhados R$379k (670) — Δ10,6% ≈ IPI+frete+parcelamento. Demanda medida ≈ demanda total. ✅
- **Rotas de entrega já existem no app**: `route_schedule` (weekday × city × uf × is_daily) + RoutePlanner.
- **Malha NÃO sincronizada**: `omie_products.metadata` das cintas tem só cfop/marca/modelo/peso — a estrutura vive apenas no Omie.
- Esqueleto existente: `production_orders` (vazia), `/producao` CRUD, edge `IncluirOrdemProducao`/`AlterarOrdemProducao` (try/catch engole erro Omie).

### Respondidos pelo founder (2026-07-03)
1. **Roteiro real das cintas**: (1) **Slitter** corta o jumbo → **rolo cortado vai a ESTOQUE** (2 pessoas ajudam aqui); (2) **Guilhotina + mesa de corte** (comprimento); (3) **Esmeril** (prepara pontas); (4) **Prensa quente** (emenda); (5) **Corte múltiplo** condicional — cinta de 50mm é produzida em 150mm e fatiada em 3 (mais rápido). **Um único operador faz tudo da guilhotina em diante** — e é exatamente aí que atola (gargalo declarado: "da guilhotina até o final"). **Tempos: desconhecidos** (ninguém mediu).
2. **Receita de conversão existe** por produto, puxada em **m² de rolo por cinta**, cadastrada "dentro das cintas" (⇒ estrutura/malha do Omie — formato ✅ validado depois, item 8).
3. **Prazo hoje é acoplado à ROTA de entrega**: pedido de rota pode sair no mesmo dia ou só na semana seguinte, conforme o dia da ligação vs dia da rota. % de atraso: desconhecido (sem registro) → baseline OTIF = a construir; primeiro ganho é registrar data prometida em 100% dos pedidos.
4. **Custeio: PADRÃO** (decidido). Reconciliação padrão×real depois que o apontamento amadurecer.
5. **Lote de jumbo: raríssimo defeito** ⇒ divergência do painel RESOLVIDA: rastreio fora do MVP; jumbos já trazem lote do fornecedor; campo `lote_mp` nullable no evento de consumo (custo zero), scan opcional em fase posterior.
6. **Tingimix: sob demanda; dor real = estoque de insumo mentindo** — erro de fórmula (ex.: esquece solução vermelha) e testes falhos NÃO geram baixa ⇒ falta de insumo surpresa. A dor é de **consumo não registrado**, não de scheduling.
7. **Espelho**: "teoricamente tudo espelhado" — confirmado empiricamente (acima).
8. **Malha do Omie VALIDADA por print (CINTA KA169 150X6200MM P50)**: estrutura **multinível** (cinta ← ROLO tipo 03 ← JUMBO tipo 01 — espelha o desacoplamento do desenho) e **completa nos insumos de emenda** (cola A455 g + catalisador Desmodur NE-S g em ~9:1 + fita Sheldahl em cm ∝ largura). **Consumo = área NOMINAL exata** (0,93 m² = 150×6200mm), **sem perda cadastrada** (refilo do jumbo 1410mm→9×150mm ≈ 4,3% ignorado) ⇒ yield fica em camada própria, como desenhado. Unidades heterogêneas na malha: G, CM, M2, UN. Omie tem abas "Custo da Produção" (✅ confiável — item 12) e "Simular Produção".

### Arbitragens e respostas finais do founder (2026-07-03 — fecham o Gate 0)
9. **Divergência A — corte múltiplo: MODELO COMPLETO** (posição Codex venceu). Rota alternativa + coproduto obrigatório entram no modelo de dados desde a Fase 1; o motor de planejamento **sugere** a rota já na Fase 3 (antecipado da F5) quando a demanda/estoque-alvo absorve as saídas.
10. **Divergência B — mestre do estoque físico: OMIE confirmado** (arquitetura da casa mantida; risco gerenciado por ATP-com-reservas + reconciliação + frescor).
11. **Cura da emenda: a cinta pode ser DESPACHADA direto após a prensa, mas só pode ser USADA 24h depois** ⇒ o CTP **não** precisa de carência de despacho; a regra vira **aviso operacional** ("aguardar 24h antes do uso") na etiqueta/expedição — crítico em venda de balcão com uso imediato.
12. **Custo da Produção do Omie é CONFIÁVEL** ⇒ vira **validação cruzada** do custo padrão destilado (nosso cálculo vs Omie por SKU, com tolerância; divergência → revisão). Não vira fonte na escada (`cost_source` mantém 1 writer).
13. **Disco e Tingidor TAMBÉM têm estrutura no Omie** ⇒ a destilação paramétrica cobre as 3 famílias fabris; sem fallback de entrevista (amostragem estratificada de validação mantida).
14. **Encerrar a OP no Omie BAIXA os insumos automaticamente pela estrutura** ⇒ backflush fiscal é NATIVO: o app conclui a OP → outbox chama `AlterarOrdemProducao` (etapa de conclusão) → Omie consome MP sozinho. O app **não** posta consumo item a item; desvios (refugo, erro_formula, teste) ficam no app para yield/custo, e o **veículo fiscal do desvio** (OP dedicada no Omie para batidas de teste/erro do Tingimix vs ajuste de estoque) é decisão de design da Fase 2.

## 2. Princípio-mãe (v3)

**PCP dual-mode com ponto de desacoplamento no ROLO CORTADO.**
- **Nível 1 (Slitter)**: jumbo → rolos por largura. Candidato a **MTS de rolos** nas larguras de giro (produzir para estoque de rolo; o estoque intermediário já existe fisicamente e como SKU tipo 03 no Omie).
- **Chave técnica canônica do rolo (endurecida no Gate 0)**: **linha/modelo do abrasivo (2909, XZ677, ATX170… — que embute mineral+costado) × largura × grão** — nunca só "largura×grão"; substituição entre linhas SÓ por tabela de equivalência explícita aprovada. (`omie_products.metadata.modelo` já existe como fonte.)
- **Nível 2 (Guilhotina→Prensa)**: rolo → cinta, **MTO puro**, executado por **um operador** — a capacidade é o POOL desse operador, não máquina a máquina. É o gargalo declarado. **Endurecimento Gate 0:** pool é a capacidade primária, MAS cada recurso crítico (guilhotina, esmeril, prensa quente, corte múltiplo) tem flag de **indisponibilidade bloqueante** — prensa quebrada bloqueia promessa de OP que precisa de prensa, mesmo com operador livre.
- **Discos**: MTS clássico (ponto de reposição de produção) para o núcleo repetitivo; MTO para o resto.
- **Corte múltiplo = ROTA ALTERNATIVA na BOM com COPRODUTO OBRIGATÓRIO — MODELO COMPLETO (decisão do founder, Gate 0)**: 150mm ÷ 3 produz 3 unidades físicas — a rota só é elegível quando o pedido/demanda absorve TODAS as saídas (fator inteiro + quantidade mínima econômica), OU a sobra entra explicitamente como estoque do SKU (não sumir sobra, não ratear custo errado; custo unitário = rateado pelas saídas). Fase 1 já traz o modelo de dados (rota + coproduto + rateio); a Fase 3 traz o **motor sugerindo** a rota. Precedente na casa: motor de compras já escolhe embalagem QT↔GL.

## 3. Blueprint por camadas (v3.2)

### Camada 0 — Dados mestres
1. `pcp_itens`: política (MTS_ROLO | MTS | MTO), família de processo, lote mín/múltiplo, lead time padrão, dimensões parseadas (largura, comprimento, grão, costado) via parser com gate de gabarito.
2. **BOM paramétrica**: regra (linha do abrasivo, faixa grão) → jumbo + consumo m² + perdas (refilo, overlap de emenda, setup) + **rotas alternativas de largura** (corte múltiplo). **Seed: DESTILAÇÃO da malha do Omie** (formato validado por print; **founder confirma estrutura também em discos e tingidores** ⇒ cobre as 3 famílias): extrair por linha os coeficientes (abrasivo = área nominal; fita = f(largura); cola/catalisador = f(largura)) e **provar que a fórmula reproduz as ~1.4k malhas existentes** (staging + check `consumo_m2 == largura×comprimento parseados ± tolerância`; divergência → lista de exceção revisada pelo founder — gate de gabarito, padrão de-para Sayerlack).
3. Unidades canônicas: mm + m²; estoque de rolo consultável por largura; conversão só por função (constraint).
4. Roteiros por família — cintas: corte_rolo (slitter) | guilhotina_mesa | esmeril | prensa_quente | corte_multiplo (condicional); tempos padrão **nascem NULL** (ausente ≠ zero) e são preenchidos pelo apontamento real; estimativas grosseiras do founder são bem-vindas mas não bloqueiam.
5. Centros de trabalho: slitter (2 pessoas) + **pool "conversão final" (1 operador)** — capacidade em horas-homem do pool, não por máquina. Calendário simples.

### Camada 1 — Execução (Fase 1)
6. OP com etapas (evolui `production_orders`), origem (pedido_venda | sugestao_mts_rolo | sugestao_mts | manual), data prometida, prioridade.
7. **Apontamento event-sourced offline — granularidade POR OP (v3.1, Gemini P1)**: default = **iniciar OP → finalizar OP (2 toques)** + eventos de EXCEÇÃO só quando ocorrem (refugo | pausa | **consumo_mp com MOTIVO: producao | erro_formula | teste | ajuste**). Início/fim POR ETAPA é opcional/futuro (candidato: só prensa). `pcp_eventos_producao` append-only, `client_event_id` idempotente por device+tenant, máquina de estados na projeção. Mobile + ScanBar + Workbox. **O consumo-com-motivo resolve a dor do Tingimix já na Fase 1.**
8. **Consumo por BACKFLUSH (v3.1)**: ao finalizar a OP, a BOM paramétrica baixa MP automaticamente; correção manual só quando divergir. **No lado fiscal o backflush é NATIVO do Omie** (§1.14): encerrar a OP espelhada baixa os insumos pela estrutura — o app não posta consumo item a item; desvios ficam no app (yield) e o veículo fiscal do desvio é design da Fase 2. **Cola/catalisador = consumíveis INDIRETOS** (pot-life: mix em batch com sobra descartada → baixa agregada + fator de perda de mistura, não MRP linear por cinta). Delta teórico×real do abrasivo alimenta o yield (complementado por inventário cíclico de jumbos/rolos). Campo `lote_mp` nullable (decisão §1.5).
9. OP impressa com barcode; etiqueta de rolo cortado no estoque intermediário.

### Camada 2 — Planejamento
10. Demanda consolidada ✅ (espelho verificado).
11. **MTS de ROLOS** (novo): ponto de reposição pela **chave técnica canônica** (linha/modelo × largura × grão — §2) para o estoque intermediário — OP de slitter sugerida (humano aprova).
12. MTS de discos: idem para o núcleo repetitivo.
13. MTO cintas: item fabricado no pedido → OP sugerida (evolui `criar_ordem_producao`) já resolvendo: tem rolo cortado? → fila só do pool final; não tem? → inclui slitter (ou compra de jumbo via Reposição).
14. **CTP acoplado a `route_schedule`**: data prometida = próxima rota (cidade do cliente, weekday, is_daily) cujo cut-off a fila do POOL alcança; sem rota → data direta. Exibida na tela de venda; grava para medir OTIF. **Cura da emenda NÃO trava o despacho** (§1.11): cinta sai da prensa direto para expedição; a regra "usar só após 24h" vira aviso na etiqueta/expedição (crítico no balcão).
15. MRP de jumbos → `pcp_demanda_mp` como sinal aditivo do motor de Reposição (anti-dupla-contagem explícito).

### Camada 3 — Capacidade
16. Rough-cut do POOL (Σ tempos apontados na fila vs h/dia do operador) + slitter separada; fila reordenável manual (sugestão EDD). Sem otimizador.
17. Sequenciamento assistido depois (agrupar por largura-base p/ maximizar corte múltiplo; por grão na slitter).

### Camada 4 — Custo (money-path) — política DECIDIDA: padrão
18. Custo padrão (v3.1) = **m² nominal × (1 + taxa de perda estimada por família — refilo/sobra/mistura, inicial ~5–8% calibrada pelo founder) × cmc do jumbo** + taxa do pool × tempo. Perda entra DESDE O DIA 1 (convergência das 3 lentes: malha é nominal-pura e jumbo 1410→9×150 perde 4,3% só de refilo); o real refina depois.
19. **Tempo sem medição = ESTIMADO por fórmula paramétrica** (f(largura, comprimento) por família) com `cost_completeness`/confidence flag — não material-only silencioso, não zero fabricado (Gemini P2 + Codex P3 conciliados: estimado-declarado ≠ aprovado ≠ fabricado).
20. Reconciliação padrão×real por família quando o apontamento amadurecer.
21. **Validação cruzada com o "Custo da Produção" do Omie** (§1.12 — founder confia nele): comparar custo padrão destilado vs Omie por SKU com tolerância; divergência → fila de revisão. Omie NÃO entra na escada `cost_source` (1 writer).

### Camada 5 — Rastreabilidade & qualidade (leve)
22. Refugo com motivo (lista curta). Lote: campo nullable, workflow futuro (§1.5). Aviso de cura na etiqueta/expedição ("usar após 24h" — §1.11).

### Camada 6 — Visibilidade
23. KPIs: OTIF, lead time por família, fila do pool (tamanho+idade), % refugo, aderência MTS-rolo. OEE só com apontamento >90%.
24. Telas: `/producao/planejamento`, `/producao/op/:id`, `/producao/apontamento` (mobile), `/producao/cadastros`, `/producao/kpis`.
25. Observabilidade: pcp_run_logs, frescor, Sentinela (OP não-espelhada, motor parado, apontamento mudo).

### Contrato Omie
App = verdade operacional; **Omie = fiscal/estoque (mestre confirmado pelo founder — divergência B fechada)**; outbox idempotente, reconciliação, erro visível — remover try/catch mudo. **Malha: importar como seed da BOM** (formato validado; 3 famílias cobertas); mestre técnico passa a ser o app, Omie recebe o resumo fiscal. **Ciclo da OP: app inclui → app conclui → Omie baixa insumos sozinho pela estrutura (backflush nativo, §1.14)** — sem postagem de consumo item a item; desvio fiscal (teste/erro Tingimix) ganha veículo na Fase 2.

### Anti-escopo v1
APS/otimizador · Gantt sofisticado · OEE completo · qualidade formal · lote profundo (quarentena/validade) · forecast estatístico/S&OP · IoT · custeio multi-nível. **Tela de ordem de mistura Tingimix** (a dor de estoque já é resolvida pelo consumo-com-motivo na Fase 1).

### Regras de engenharia (casa)
RLS por papel desde o 1º SQL · motores = RPCs SQL determinísticas provadas no PG17 com falsificação (golden cases Codex, + caso corte-múltiplo e caso rolo-em-estoque) · lovable-db-operator · deploy 3 camadas · authorizeCronOrStaff.

## 4. Roadmap (gate tri-modelo por fase)

| Fase | Entrega | Status |
|---|---|---|
| **0 — Descoberta** | 7 respostas ✅ · espelho verificado ✅ · rotas localizadas ✅ · malha validada por print ✅ · 6 respostas finais ✅ (tempos grosseiros seguem opcionais) | ✅ |
| **Gate 0** | Codex challenge ✅ (11 → v3) · Gemini ✅ (9 → v3.1) · divergências A/B arbitradas ✅ + 4 respostas ✅ (→ v3.2) | ✅ FECHADO |
| **1 — Fundação** | Dados mestres + parser + BOM paramétrica (seed malha, 3 famílias) + OP etapas + apontamento offline c/ consumo-motivo + modelo de dados do corte múltiplo (rota+coproduto+rateio) | ⏳ próxima |
| **2 — Custo & Omie** | Custo padrão na escada + validação cruzada c/ Custo Omie + outbox (incluir/concluir OP, backflush nativo) + veículo fiscal do desvio (teste/erro Tingimix) + Sentinela | ⏳ |
| **3 — Planejamento** | MTS rolos + MTS discos + fila MTO + CTP por rota + **motor sugere rota de corte múltiplo** (decisão founder: modelo completo) | ⏳ |
| **4 — Capacidade & KPIs** | Rough-cut do pool + OTIF/lead time/refugo | ⏳ |
| **5 — Refino** | MRP→Reposição, sequenciamento (agrupar OPs por largura-base), tela mistura Tingimix, OEE | ⏳ |

## 5. Painel — estado

- Rodada 1 (blueprint): Claude 13 findings + Codex 13 findings; confirmados: BOM paramétrica, contrato Omie, prova SQL, apontamento offline idempotente, rough-cut-antes-de-fino, dados-mestres-antes-de-telas. Gemini indisponível (cota free-tier; pro = limit 0).
- **Divergência lote: RESOLVIDA pela evidência do founder** (raríssimo defeito → fora do MVP; campo nullable fica).
- **Gate 0 (Codex challenge da v2, 2026-07-03): 11 findings, todos ACEITOS** (1 refinado pelo driver). Gemini re-rodou sobre a v3 ✅ (9 findings, tabela abaixo) — painel completo.

### Gate 0 — endurecimentos incorporados (Codex challenge)

| # | Sev | Endurecimento (disposição) | Onde |
|---|---|---|---|
| 1 | P1 | **ATP ≠ saldo bruto**: CTP nunca promete sobre saldo Omie tipo 03 cru — camada de **reservas** (saldo físico − reservas de venda − reservas de OP), distinguindo rolo vendável × alocado à produção | Camada 2 (CTP/MTO) |
| 2 | P1 | **Chave técnica canônica** do rolo = linha/modelo × largura × grão (mineral+costado embutidos na linha); equivalência só por tabela explícita | §2 (incorporado) |
| 3 | P1 | **Indisponibilidade bloqueante por recurso crítico** além do pool (prensa quebrada bloqueia promessa) | §2 (incorporado) |
| 4 | P1 | **Coproduto do corte múltiplo obrigatório**: fator inteiro + qtde mínima absorvida pela demanda, OU sobra vira estoque explícito do SKU; custo unitário rateado certo | §2 (incorporado) |
| 5 | P2 | **CTP com calendário de expedição versionado** (timezone America/Sao_Paulo, cut-off explícito, `route_calendar_override`, cliente sem rota, promessa POR ITEM consolidada por política do pedido) | Camada 2, spec Fase 3 |
| 6 | P2 | **Governança do consumo-com-motivo**: produção exige OP; erro_formula/teste exigem produto/fórmula alvo; ajuste acima de limite exige aprovação; relatórios separam motivos não-produtivos (anti-lixeira) | Camada 1 |
| 7 | P2 | **Import da malha Omie via STAGING com gate estatístico**: amostragem estratificada (10 discos, 20 cintas de larguras extremas, 10 tingidores), validação dimensional com tolerância, cobertura por família, aprovado/rejeitado ANTES de popular a BOM ativa (2-3 prints validam só o FORMATO) | Fase 1 |
| 8 | P2 | **`cost_completeness` persistido**: relatórios separam custo completo × material-only × indisponível; margem consolidada nunca agrega custo parcial sem flag visível | Camada 4 |
| 9 | P2 | **Máquina de estados na projeção de eventos**: rejeitar fim-antes-de-início, pausa sem etapa ativa, consumo pós-OP-fechada, fim duplicado; `client_event_id` único por device+tenant | Camada 1 |
| 10 | P2 | **Lifecycle da demanda dependente** (planned → reserved → consumed → canceled): Reposição lê demanda LÍQUIDA deduplicada pela cadeia pedido→OP (anti-dupla-contagem concreto) | Camada 2 (MRP) |
| 11 | P3 | **Tempo observado ≠ tempo padrão APROVADO**: mediana por família/SKU com N mínimo, exclusão de setup/refugo, revisão humana antes de afetar CTP | Camada 0/3 |

Top risks do Gate 0 (Codex): CTP prometendo sobre saldo tipo 03 que não é ATP · corte múltiplo sem coproduto distorcendo estoque/custo · import frágil da BOM contaminando MRP/custo/reposição em massa.

### Gate 0 — lente Gemini (triagem ampla, 9 findings — disposições do driver)

| # | Sev | Finding | Disposição |
|---|---|---|---|
| 1 | P1 | Perda (refilo 4,3% + sobras) fora do custo nominal | **ACEITO** → Camada 4 item 18 (perda estimada desde o dia 1; 3 lentes convergem) |
| 2 | P1 | **Micro-apontamento por etapa mata a adoção do operador único** (50–150 toques/dia) | **ACEITO, muda o desenho** → apontamento POR OP + backflush + exceções (Camada 1 itens 7–8) |
| 3 | P2 | 1.401 BOMs estáticas insustentáveis; SKU/estrutura on-the-fly no Omie na venda | **ACEITO** → Fase 3 (fluxo cinta nova: dimensões → CTP+preço paramétrico → cria SKU+malha no Omie ao fechar) |
| 4 | P2 | **Cura da emenda (cola PU bicomponente, ~12–24h) ignorada no CTP** | **RESPONDIDO (§1.11)**: despacho liberado direto; uso só após 24h ⇒ sem carência no CTP, aviso na etiqueta/expedição |
| 5 | P2 | Pot-life da cola: mix em batch com sobra descartada ⇒ baixa linear diverge | **ACEITO** → cola/catalisador = consumível indireto (Camada 1 item 8) |
| 6 | P2 | Dual-mode+rotas+coprodutos = over-engineering p/ R$39k/mês; usar Kanban físico | **DIVERGÊNCIA A — ARBITRADA pelo founder: MODELO COMPLETO (Codex)**. F1 = modelo de dados (rota+coproduto+rateio); F3 = motor sugere. MTS de rolo = min-max simples (kanban eletrônico). ATP-com-reservas FICA |
| 7 | P2 | Conflito offline×Omie: app deveria ser o único mestre de estoque físico | **DIVERGÊNCIA B — ARBITRADA pelo founder: OMIE MESTRE confirmado** (arquitetura da casa); risco gerenciado por ATP-reservas + reconciliação + frescor. Cenário de corrida dele vira golden case PG17 |
| 8 | P2 | Máquina parada: além de bloquear, RECALCULAR promessas existentes + alertar | **ACEITO** → switch de status recalcula datas da fila e alerta |
| 9 | P2 | Material-only mascara custo do gargalo; estimar tempo por fórmula | **ACEITO** → Camada 4 item 19 |

Top risks (Gemini): operador abandonar o app por fricção de apontamento · precificação por área nominal pura · founder afundar em arquitetura corporativa.

**Divergências: AMBAS ARBITRADAS pelo founder (2026-07-03)** — (A) corte múltiplo: **modelo completo** (F1 dados, F3 motor); (B) mestre do estoque físico: **Omie** (arquitetura da casa mantida).

## 6. Pendências do founder

1. ~~Print da malha~~ ✅ validado (CINTA KA169). ~~Divergências A/B~~ ✅ arbitradas (§1.9–1.10). ~~Cura~~ ✅ (§1.11). ~~Custo Omie~~ ✅ confiável (§1.12). ~~Estruturas disco/tingidor~~ ✅ existem (§1.13). ~~Baixa no encerramento da OP~~ ✅ automática (§1.14).
2. Tempos grosseiros por etapa, se quiser chutar (não bloqueia — o apontamento mede).
