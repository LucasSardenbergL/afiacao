# Prime Colacor — programa de assinatura B2B (design)

> Brainstorm 2026-07-09/10 (founder + Claude + Codex + deep-research global verificada). Status: **consolidado — aguardando aprovação final do founder**.
> Objetivo: assinatura mensal paga ("Amazon Prime" B2B) para aumentar fidelização e share-of-wallet dos clientes do grupo, com prova de valor mensal honesta.

## 1. Decisões do founder (registradas nesta sessão)

1. **Público v1:** guarda-chuva do grupo todo (Oben + Colacor + Colacor SC), enxuto.
2. **Promessa central:** híbrido com âncora — 1 benefício econômico tangível + camada de previsibilidade operacional.
3. **Pricing:** sai da conta da base real (não de chute).
4. **Capacidade:** folga real nas 4 frentes (rota, bancada de afiação, separação/tintometria, time técnico) → benefícios de prioridade têm custo marginal ~zero.
5. **Frete:** entrega na rota já é cortesia universal → frete grátis NÃO é âncora.
6. **Afiação:** fatura no Omie (conta colacor_sc, fora do sync do app hoje). Preço de tabela: **R$1,20/dente**.
7. **Métrica de vida-ou-morte (6 meses):** share-of-wallet incremental (margem incremental líquida vs grupo controle pareado).

## 2. Evidência da base (psql-ro, 2026-07-09, 12 meses)

| Conta | Clientes 12m | Recorrentes ≥6m ativos | Ticket mensal p50 | p75 | p90 | Receita 12m |
|---|---|---|---|---|---|---|
| Oben | 386 | 122 | R$578 | R$1.146 | R$2.923 | R$4,86M |
| Colacor | 333 | 52 | R$265 | R$515 | R$1.077 | R$820k |

- Universo natural do Prime v1: **~170 clientes recorrentes**.
- `loyalty_points`: **0 lançamentos, 0 usuários** — o programa de pontos atual é vitrine morta. O Prime substitui (aposentar `/loyalty`, `/gamification`, `/savings`).
- `orders` (afiação no portal): **0 transações** — afiação real não passa pelo app. Benefício não pode depender do portal; app = extrato.
- Conta colacor_sc **fora** do `sales_orders` (sync cobre só colacor/oben) → incluir a 3ª conta é pré-requisito da âncora automática.

## 3. Parecer Codex (gpt-5.5, reasoning high — resumo)

- **Tese:** vender previsibilidade operacional ("não parar produção"), não desconto. Desconto amplo = benefício mais perigoso (canibaliza margem de quem já compraria).
- Benefícios rankeados (valor percebido ÷ custo real): prioridade na rota > SLA de afiação casado à rota > coleta junto da entrega > frete condicionado (n/a aqui) > prioridade separação/tintometria > suporte técnico com teto > histórico de ferramentas > pré-reserva SKU (v2).
- **Pricing:** mensalidade fixa única no piloto; contrato mínimo 3 ciclos; âncora psicológica na dor operacional (ferramenta parada), não em "desconto". Evitar % de volume.
- **Extrato honesto em 3 blocos:** (A) monetizado com contrafactual transacional real; (B) benefício usado não-monetizado (contagens); (C) NUNCA estimar (mata o R$250 hardcoded do `/savings`). Regra de ouro: só entra em R$ com contrafactual real.
- **Armadilhas P1:** seleção adversa (→ tetos), SLA que a rota semanal não sustenta (→ prometer "próxima rota", nunca horas), cobrança virando atrito (→ boleto junto do faturamento, suspensão simples), fiscal (quem emite? NFS-e/ISS/Simples → contador), misturar mercadoria e serviço sem regra fiscal.
- **Piloto:** 10-30 clientes, 3 ciclos, grupo controle pareado, sem escolher só "clientes fãs". Critérios de morte explícitos (ver §6).
- Benchmarks citados: Amazon Business Prime, Sam's Club Sócio Plus, Juntos Somos Mais, Rappi Prime, Meli+.

## 4. Benchmark global (deep-research 2026-07-10: 104 agentes, 22 fontes, 25 claims verificadas adversarialmente → 21 confirmadas)

### 4.1 Os dois arquétipos encontrados

**Arquétipo BR — clube de pontos GRATUITO bancado por fabricante/distribuidor.** Todos os programas relevantes do setor no Brasil são gratuitos: **Juntos Somos Mais** (construção civil, ~100 mil lojas, fidelidade como porta de entrada do marketplace de reabastecimento — GMV R$6–11bi), **Amigo Leo/Leo Madeiras** (concorrente direto na marcenaria: pontos por compra, 5 tiers "madeiras nobres" Jatobá→Jacarandá Plus, resgate SÓ com retirada em loja física — prêmio vira visita e recompra), **Clube Pro Pintor/Sherwin-Williams** (pontos por foto de NF, operado por terceiro) e **Pintou Parceria/Suvinil** (100% gratuito; âncora = GERAÇÃO DE DEMANDA via rede "Encontre seu Pintor"; Reclame Aqui registra prêmios não entregues e pontos não creditados). **Nenhum cobra assinatura** → o mercado BR está condicionado a fidelidade gratuita. [fontes primárias verificadas 3-0]

**Arquétipo global — assinatura B2B paga com âncora em PREVISIBILIDADE (Amazon Business Prime).** Tiers anuais por número de usuários (Duo grátis → Essentials US$179 → Small US$499 → Medium US$1.299 → Enterprise US$10.099/ano); âncora universal **logística** (entrega rápida/grátis — a página não lista NENHUM desconto de produto como benefício do tier pago); **prazo de pagamento 45/60 dias como diferenciador de tier, sempre "upon approval"** (gate de crédito separado da assinatura); rewards com expiração de 12 meses e **earning comportamental** (ganha por adotar features — adicionar usuários, configurar Guided Buying — não só por gastar); entrada freemium + promo agressiva de 1º ano (US$9,99, ~95% off, out/2024). [fontes primárias verificadas 3-0]

**Nicho afiação — ninguém publica plano flat com preço público.** **Leitz** (líder global): "service models" contratados caso a caso (Complete Care = "long-term partnership" com faturamento por produção acordada); pilares de confiabilidade = **coleta/entrega + contato local pessoal + preço transparente** (espelho exato do nosso desenho: rota + vendedora + extrato); **funil aberto** — reafia ferramenta de QUALQUER fabricante, em 150+ países. **Cozzini Bros** (EUA, desde 1905, a mecânica mais copiável): **dois conjuntos idênticos em rotação** — um em uso no cliente, outro na fábrica afiando — trocados em rota própria com agenda fixa (padrão quinzenal), zero downtime; ressalvas: é ALUGUEL de pool (não a faca do cliente) e usuários relatam gume degradando dentro do ciclo → a promessa entregável é **disponibilidade, não fio permanente**. [3-0]

**Implicação central (síntese do relatório):** o plano pago R$99–129/CNPJ **não tem cópia nacional conhecida** — seria síntese inédita de Amazon (previsibilidade como âncora + crédito gateado) + Cozzini (troca na rota) + Leitz (confiabilidade + funil aberto). É simultaneamente a oportunidade (espaço vazio) e o risco central (mercado condicionado a gratuito).

### 4.1b Checagem dirigida complementar (2026-07-10: Meli+, Sam's, Rappi, atacarejos — páginas vivas/imprensa)

- **Meli+ (Mercado Livre):** assinatura B2C em 3 planos — Essencial R$9,90/mês (frete grátis rápido em itens elegíveis a partir de R$19 de pedido + cashback), Total R$19,90 (+ Disney+ e descontos em streamings), Mega até R$175 (combos Netflix/HBO/Apple TV+). Lições: **preço de entrada que se paga em 1–2 usos** (1–2 fretes ≈ mensalidade) e elegibilidade por pedido mínimo baixo. Nosso análogo de venda: **"uma serra de esquadrejadeira por mês (≈96 dentes) já paga o plano"**. Tiers por bundle de perks externos (streaming) não se aplicam ao B2B — validam o alerta do Codex de não distrair com perks fora da operação.
- **Sam's Club Brasil (único clube PAGO de atacado relevante no BR):** anuidade Sócio R$95/ano, **Sócio Plus R$175/ano** — prova que o comprador BR (inclusive PJ) paga por clube. Cashback Plus com engenharia de janela (acumula até R$300 comprando dias 1–7 com gasto escalonado ≥R$500–2.000; gasta o resto do mês) = força 2 visitas/mês. **Contraponto de escala:** mensalizado dá ~R$14,60/mês — nosso R$99–129 é ~8× isso, sustentável só porque a âncora é serviço individual com valor de tabela real (não desconto de prateleira). Reclame Aqui registra queixa de "falta de clareza nos descontos Sócio Plus" → validação direta do nosso extrato honesto como diferencial.
- **Rappi Prime:** R$29,90/mês ou R$299/ano; frete grátis com pedido mínimo R$30; teste grátis de 30 dias (uma única vez). **Lição negativa documentada (Reclame Aqui/imprensa): aumento de mensalidade sem aviso e REMOÇÃO de benefícios de assinantes ativos** — mata a confiança no modelo. → Regra nova pro nosso regulamento: **grandfathering** (mudança de preço/benefício só para novos ciclos, com aviso prévio e porta de saída sem multa).
- **Atacadão/Assaí:** NÃO têm clube de assinatura — a fidelização do atacarejo BR é **cartão de crédito próprio** (Passaí/Cartão Atacadão: parcelamento, preço de atacado em qualquer quantidade). Lição: no B2B de margem apertada, **crédito/prazo é o benefício rei** — reforça o prazo estendido gateado como v2 de maior potencial (convergência com o modelo Amazon "upon approval").

### 4.1c Campeões mundiais de engajamento (checagem dirigida 2026-07-10) — mecanismo → adaptação

| Campeão (evidência de engajamento) | Mecanismo central | Adaptação à nossa realidade |
|---|---|---|
| **Costco** — renovação 92,3% US (topo mundial do varejo pago) | Lucro concentrado NA anuidade; margem ~zero no produto; confiança radical | Nosso lucro fica no share-of-wallet (não na mensalidade) — mas a confiança radical vira a garantia de extrato |
| **Amazon Prime** — 93% renovam após 1 ano; membro gasta 2,3× o não-membro | "Rentabilizar a assinatura": quem paga concentra a compra pra fazer o plano valer | É exatamente a aposta do share-of-wallet — o extrato mensal alimenta esse instinto |
| **Starbucks Rewards** — membros = 59% das vendas US; visitam 5,6× mais; retenção 44% vs 25% da indústria | **Stored value** (carteira pré-carregada = compra futura garantida) + gamificação | v1 não (complexidade fiscal); **v2 opcional:** "carteira de dentes" pré-paga como degrau para não-assinantes |
| **Tesco Clubcard** — 82–84% das transações UK com cartão; £627M incrementais 2020-23 | **Member pricing VISÍVEL** ("preço de membro" na etiqueta — "tem dinheiro de verdade no Clubcard") | **Absorvido na v1:** o 5% off aparece no orçamento/pedido como "preço Prime" com o preço cheio riscado — benefício visível no momento da compra, não só no extrato |
| **Delta Medallion (aéreas)** — perder status = "breakup"; +30% engajamento | **Status aspiracional em tiers**; earning fora do voo mantém o programa vivo entre compras | v1: selo "Prime" no atendimento (status leve). Tiers de status = v2 (não inflar o piloto) |
| **88VIP (Alibaba)** — renovação 83%, o mais leal da China; >50% das vendas de top brands do Tmall | **Gate de elegibilidade** (só heavy user QUALIFICA — o clube é prêmio, não produto de prateleira) → inverte a seleção adversa | **Absorvido na v1:** piloto vendido como **convite** ("você foi selecionado") — reconhecimento, não prateleira |
| **JD Plus** — membro aumenta gasto anual +150% e frequência +120% no 1º ano | Paid membership como acelerador de share-of-wallet | Valida a métrica de vida-ou-morte escolhida |
| **B2B distribuidor (case Brandmovers; Ferguson ProPlus+)** — inscritos +25% de vendas vs +5% não-inscritos | Rewards B2B premiam pessoa E empresa; "buy more = get more" | **Régua do piloto:** delta esperado assinante vs controle ≈ +20pp; no micro-B2B dono=comprador (benefício empresarial e pessoal se fundem) |

### 4.2 SWOT do Prime Colacor à luz do benchmark

- **Forças:** único ator regional com rota própria semanal + afiação + indústria de abrasivo no mesmo guarda-chuva; registro do benefício SEM fricção (somos canal E operador — nenhum clube BR consegue: todos exigem foto de NF do profissional); margem de indústria própria banca benefício sem verba de fornecedor.
- **Fraquezas:** portal sem uso (extrato precisa nascer útil); afiação fora do sync hoje; capacidade de bancada não dimensionada formalmente; marca de "plano pago" inexistente no setor (educação de mercado é custo nosso).
- **Oportunidades:** espaço vazio de assinatura paga no nicho; extrato honesto como diferencial anti-Reclame-Aqui; prazo gateado por crédito (v2) como degrau de tier à la Amazon; "2º jogo em rotação" (v2) à la Cozzini para heavy users.
- **Ameaças:** condicionamento ao gratuito (Amigo Leo ao lado); programas de FABRICANTE (Pro Pintor, Pintou Parceria) disputando a lealdade do mesmo cliente por cima da distribuidora; e-commerce B2B (Leo online) atacando o giro de insumos — a afiação física é nossa barreira anti-digital.

### 4.3 As 5 Forças de Porter (contexto Colacor: insumos + afiação no interior de MG)

1. **Rivalidade:** Leo Madeiras/GMad/Multilider na distribuição (Leo com clube gratuito consolidado e e-commerce); afiação local = oficinas avulsas sem plano. Nossa diferenciação: o bundle serviço+insumo+rota que nenhum rival opera junto.
2. **Novos entrantes:** marketplaces B2B (Amazon Business/Meli) e e-commerce de insumo. Barreira nossa: logística reversa FÍSICA da afiação + relacionamento de rota semanal — não se replica por app.
3. **Substitutos:** da afiação → serra nova barata (a conta afiar-vs-comprar é real, mas nunca fabricar o número); do plano → status quo avulso gratuito.
4. **Poder de fornecedor:** tintas concentradas (Sayerlack/AkzoNobel) e programas de fabricante competindo pela lealdade do MESMO cliente; mitigação: abrasivo próprio (margem de indústria) + benefícios ortogonais aos dos fabricantes (serviço/logística, não pontos).
5. **Poder de comprador:** clientes pulverizados (individualmente fracos), mas custo de troca baixíssimo (compra avulsa multi-fornecedor é a norma) → é exatamente o que o Prime ataca: subir o custo de troca com franquia + prioridade + extrato.

### 4.4 Shortlist copiar-e-melhorar (mecânicas → nosso desenho)

| # | Mecânica (origem) | Como copiamos e melhoramos |
|---|---|---|
| 1 | Âncora logística universal, zero desconto no tier pago (Amazon) | Franquia de afiação + prioridade na rota; desconto só na categoria da casa | 
| 2 | Prazo 45/60d como benefício de tier "upon approval" (Amazon) | **v2:** prazo estendido pra assinante, gateado pelo financeiro (nunca automático) |
| 3 | Earning comportamental (Amazon Rewards) | Bônus de dentes por cross-sell: 1ª compra de categoria nova no mês ganha +50 dentes — paga a métrica share-of-wallet |
| 4 | Troca na rota com agenda fixa; promessa = disponibilidade (Cozzini) | v1: coleta/devolução na cadência da rota (nunca prometer horas); **v2:** "2º jogo em rotação" para heavy users |
| 5 | Funil aberto — afia qualquer marca (Leitz) | Copy de venda v1: "manda qualquer serra, de qualquer fabricante" |
| 6 | Confiabilidade = coleta + contato local + preço transparente (Leitz) | Já é o desenho: rota + vendedora dona + extrato honesto (nosso extrato é MAIS transparente que o benchmark) |
| 7 | Prêmio entregue no canal força recompra (Amigo Leo: retirada em loja) | Kit de boas-vindas e benefícios entregues NA ROTA pela vendedora |
| 8 | Fidelidade como porta do giro (Juntos Somos Mais) | O extrato mensal vira pauta fixa de ligação da vendedora (gatilho de recompra todo mês) |
| 9 | Member pricing visível (Tesco: "preço de membro" na etiqueta) | "Preço Prime" impresso no orçamento/pedido com o preço cheio riscado — o benefício aparece na transação, não só no extrato |
| 10 | Gate de elegibilidade (88VIP: o clube é prêmio) | Piloto vendido como CONVITE a clientes selecionados — inverte a seleção adversa e dá status |
| 11 | Régua de sucesso B2B (case distribuidor: +25% vs +5%) | Benchmark do delta assinante vs controle no painel do piloto |

### 4.5 Os 4 erros dos benchmarks a evitar

1. **Falhar na execução do benefício** (Reclame Aqui do Pintou Parceria: prêmios não entregues, pontos não creditados; queixas análogas no Sócio Plus). Antídoto: registro manual com dono único, extrato mensal pontual, fila de reconciliação visível no admin.
2. **Prometer o que o ciclo não sustenta** (críticas à Cozzini: gume degrada dentro do ciclo quinzenal). Antídoto: prometer DISPONIBILIDADE na cadência da rota — nunca fio permanente, nunca prazo em horas.
3. **Vender como cupom** (condicionamento BR a clube gratuito de pontos/desconto). Antídoto: script de previsibilidade, desconto restrito, garantia de extrato — e coexistência declarada com os clubes de fabricante (benefícios ortogonais: eles dão pontos, nós damos operação).
4. **Mudar a regra em cima de quem já paga** (Rappi Prime: aumento sem aviso + remoção de benefícios de assinantes ativos, documentado no Reclame Aqui). Antídoto: **grandfathering no regulamento** — mudança de preço/benefício vale só para ciclos novos, com aviso prévio e saída sem multa; regra clara desde o dia 1 (clareza é o que o Sócio Plus não entrega, segundo as queixas).

### 4.6 Honestidade da pesquisa (caveats do relatório)

- **Sem cobertura verificada no workflow:** Sam's/Sócio Plus, atacarejos, Rappi/Meli+ foram cobertos depois por **checagem dirigida** (§4.1b — páginas vivas + imprensa, sem verificação adversarial tripla; confiança menor que os findings 3-0). Continuam descobertos: Bosch/Makita/DeWalt PRO, GMad/Multilider, Blum/Häfele, Costco B2B (não significa que não existam; significa não-verificado).
- **Refutadas (NÃO usar):** "Pintou Parceria não tem pontos/NF/tiers" (0-3) e "pay-per-output da Leitz valida o R$1,20/dente" (1-2) — não citar essa analogia no pitch.
- **Não verificadas (hipóteses a confirmar no regulamento antes de citar):** resgate cash-like via cartão pré-pago do Clube Pro Pintor; pontuação automática operada pela revenda (fricção zero) com pontos em dobro em "revenda master".
- **Viés de fonte:** a maior parte prova POSICIONAMENTO declarado (páginas oficiais), não execução real; o lado "o que falha" ficou subcoberto (emergiu só em Pintou Parceria e Cozzini).
- **Aberto:** churn/retenção de assinaturas B2B pagas não teve cobertura — é o risco central do modelo pago em mercado gratuito; observar no piloto.

### Ferramentas recomendadas para análise contínua de benchmark (pedido do founder)

- **Frameworks:** SWOT por programa concorrente · 5 Forças de Porter do setor · RFM da base própria (roda hoje via psql-ro) · Loyalty Program Canvas para consolidar o desenho.
- **Fontes/dados:** relatórios anuais de loyalty (Bond, Antavo, McKinsey) · Reclame Aqui (fraquezas de programas BR) · SimilarWeb/Ahrefs (tráfego de concorrentes — conectores disponíveis no Claude, requerem autorização em claude.ai → connectors).
- **Nesta base de código:** skill `deep-research` (pesquisa multi-fonte verificada) · skill `/benchmark-externo` (transforma case externo em programa de PRs) · skill `pesquisa-mercado-br`.

## 5. O Programa (Bloco 1 — consolidado com benchmark)

**Plano único mensal por CNPJ.** Faixa alvo R$99–129/mês (cravar com a fórmula abaixo). **Posicionamento vs mercado gratuito:** nada do que é gratuito hoje deixa de ser (rota, WhatsApp, app) — o Prime é degrau pago em cima, com benefícios ortogonais aos clubes de fabricante (eles dão pontos; nós damos operação). Sem cópia nacional conhecida (§4.1).

| Benefício | Regra | Custo real |
|---|---|---|
| **Franquia de afiação** (âncora) | **200 dentes/mês** inclusos (≈R$240 de tabela a R$1,20/dente), **qualquer marca de ferramenta** (funil aberto à la Leitz). Não cumulativa. Extrato: dentes usados × R$1,20 | Marginal baixo (bancada com folga) |
| Coleta + devolução na rota com SLA | Promessa de **disponibilidade na cadência da rota** ("coletada numa passagem, volta afiada na seguinte") — nunca prazo em horas, nunca "fio permanente" (lição Cozzini) | ~Zero |
| Prioridade separação + tintometria + entrega | Pedido Prime fura fila interna | ~Zero |
| WhatsApp prioritário + suporte técnico | Até 2 consultorias de acabamento/mês | Tempo do time (teto) |
| 5% off abrasivos Colacor | Só categoria da casa; revisável por trimestre. **Exibido como "preço Prime"** no orçamento/pedido com preço cheio riscado (member pricing visível, à la Tesco) | Controlado; puxa 2ª frente |
| **Bônus cross-sell de dentes** | +50 dentes no mês da 1ª compra de uma categoria **sem compra nos últimos 6 meses** (máx. 1 bônus/mês; earning comportamental à la Amazon Rewards — paga a métrica share-of-wallet) | Marginal baixo (R$60 de tabela), teto embutido |
| Kit de boas-vindas | One-time, **entregue na rota pela vendedora** (benefício no canal, à la Amigo Leo) | One-time |

- **Fórmula do preço:** mensalidade ≈ ½ do valor monetizável máximo mensal (franquia × R$1,20 + desconto médio esperado) → assinante que usa vê extrato ≥2× o pago. **Frame de venda (à la Meli+, calibrar com o preço final):** uma serra de esquadrejadeira (~96 dentes) vale R$115,20 de tabela — a R$99 ela paga o plano sozinha; a R$119–129, "uma serra grande + uma lâmina pequena por mês" (o frame nunca pode prometer mais que a conta fecha).
- **Garantia de extrato:** 3 meses sem o monetizado superar a mensalidade → cancela sem multa. Argumento de venda + alinhado à regra money-path da casa.
- **Grandfathering no regulamento (lição Rappi):** mudança de preço/benefício só vale para ciclos novos, com aviso prévio e saída sem multa — nunca remover benefício de assinante ativo.
- Sem 1º mês grátis (mede disposição real a pagar). Contrato mínimo 3 ciclos. **Alavanca reserva** (só se a adesão emperrar no piloto): 1º ciclo a preço reduzido — nunca zero — à la promo de entrada do Business Prime.
- **Ritual do extrato:** o extrato mensal é pauta fixa da ligação da vendedora (fidelidade como porta do giro, à la Juntos Somos Mais).
- Fora da v1 (YAGNI): desconto geral, entrega extra-rota inclusa, pré-reserva de estoque, pontos/gamificação. **v2 documentada (pós-piloto):** prazo de pagamento estendido gateado pelo financeiro ("upon approval", à la Amazon — reforçado pelo achado de que o atacarejo BR fideliza via crédito); "2º jogo em rotação" para heavy users (à la Cozzini, adaptado: jogo do cliente ou pool padronizado); opção anual com desconto (à la Sam's/Rappi — só depois de provado o valor mensal); "carteira de dentes" pré-paga como degrau para não-assinantes (stored value à la Starbucks — avaliar fiscal antes); tiers de status (à la Delta) e tier Pro se emergir demanda industrial.

## 6. Piloto (3 ciclos)

- 15–25 clientes: recorrentes ≥6m, mix p50–p90 Oben com uso de ferramenta de corte, 2–3 cidades de rota distintas (incluir 1 menos conveniente — piloto não é teatro) + **grupo controle pareado** (cidade/segmento/ticket) sem oferta.
- Venda pela vendedora com script de previsibilidade e **framing de convite** ("você foi selecionado" — gate de elegibilidade à la 88VIP: o clube é reconhecimento, não prateleira; inverte a seleção adversa); extrato como demo.
- **Régua externa de sucesso** (case B2B distribuidor): inscritos +25% de vendas vs +5% dos não-inscritos — o painel do piloto compara nosso delta contra essa ordem de grandeza.
- Métricas: **manda** margem incremental líquida vs controle; secundárias: retenção, uso da âncora, % extrato ≥ mensalidade, renovação no 3º ciclo.
- **Critérios de morte:** só heavy user fecha conta · promessa exige exceção fora-de-rota recorrente · comercial só vende como desconto · prova de valor depender de estimativa.

## 7. O Sistema (Bloco 2 — APROVADO pelo founder)

**Princípio:** app = extrato + gestão; venda/entrega do benefício acontece na operação. Nenhum benefício depende do cliente abrir o portal.

### Dados (migrations + RLS; money-path → prove-sql-money-path)
- `prime_planos` — catálogo (preço, franquia_dentes, benefícios versionados).
- `prime_assinaturas` — cliente, plano, preço contratado, status (`ativa|suspensa|cancelada`), início/ciclo. Writer único staff.
- `prime_beneficio_uso` — uso registrado: tipo (`afiacao_dentes|desconto_abrasivo|atendimento_tecnico|prioridade`), quantidade, **valor_tabela** (contrafactual), referência Omie, created_by. Coluna dedicada, 1 writer (nunca jsonb multi-writer).
- `v_prime_extrato_mensal` — assinante×mês: pagou R$X · recebeu R$Y monetizado · Z usos operacionais. `security_invoker`; RLS cliente-vê-só-o-seu.

### Integrações (manual-primeiro)
1. Sync conta **colacor_sc** no `omie-vendas-sync` (3ª conta) — pré-req da âncora automática.
2. Uso da franquia: **v1 manual** (staff registra dentes no admin; volume do piloto é baixo). Matcher automático = v2.
3. Desconto 5%: v1 vendedora aplica + admin audita; automação tabela de preço = v2.
4. Cobrança: v1 boleto junto do faturamento; financeiro registra pagamento. Sem gateway.

### Telas
- Cliente `/prime`: extrato mensal honesto + dentes restantes + benefícios. Aposenta `/loyalty`, `/gamification`, `/savings`.
- Staff `/admin/prime`: CRUD assinantes, registrar uso, **painel do piloto** (assinantes × controle; share-of-wallet; % extrato ≥ mensalidade).
- Vendedora (Meu Dia): badge Prime + franquia restante (gatilho de ligação).

### Fases de PR
PR-1 fundação de dados (PG17) → PR-2 admin mínimo → PR-3 `/prime` extrato → PR-4 sync colacor_sc → PR-5 painel do piloto. V2 pós-piloto: automação desconto, notificação WhatsApp do extrato, matcher automático.

### Honestidade embutida
Mês sem registro = "sem uso registrado" (≠ R$0 medido) · afiação não casada = fila de reconciliação manual · assinatura suspensa congela franquia E extrato (regra de banco, não só de admin).

### Refinamentos do challenge Codex (2026-07-11, dobrados no plano do PR-1)
- **Extrato fala "mensalidade contratada", NUNCA "você pagou"** até existir registro de pagamento real (`prime_cobrancas` = PR posterior, junto da cobrança) — "pagou" sem fato de boleto seria número fabricado.
- **Registro de benefício é append-only:** contrafactual amarrado (`valor = dentes × preço/dente da época`, lastro em pedido Omie obrigatório), correção só por ESTORNO auditável, nem staff deleta.
- **Deferidos documentados:** chave por CNPJ multi-login (hoje `customer_user_id` é a identidade; migra se surgir 2º login) e `status_registro` de reconciliação (entra com o matcher automático v2).

## 8. Pendências e decisões abertas

- [ ] **Fiscal (founder + contador):** qual CNPJ emite a mensalidade, NFS-e/ISS, enquadramento no Simples da Colacor SC — ANTES do 1º boleto.
- [ ] **Calibrar franquia:** validar 200 dentes/mês contra o perfil real de dentição/frequência dos clientes-alvo (dado da colacor_sc pós-sync ou levantamento manual da bancada). O preço final (R$99 vs R$119 vs R$129) sai dessa calibragem pela fórmula do §5.
- [ ] **Nome do programa** (marketing): "Prime Colacor" é placeholder.
- [ ] **Confirmar no regulamento do Clube Pro Pintor** (hipóteses não-verificadas §4.6) se vale importar: resgate cash-like via cartão pré-pago; pontuação automática pela revenda.
- [ ] **Observar no piloto** o risco sem cobertura no benchmark: churn/atrito de cobrança de assinatura B2B paga em mercado condicionado a gratuito.
