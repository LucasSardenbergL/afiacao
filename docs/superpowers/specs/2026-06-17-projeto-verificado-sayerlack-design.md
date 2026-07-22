# Projeto Verificado Sayerlack — design (v2)

> Spec de produto/estratégia. Combate ao **desvio de especificação** de acabamentos Sayerlack (pintor/marcenaria aplica tinta automotiva ou de concorrente imitando só a cor) **fundido** ao **programa de relacionamento com arquitetos**.
>
> **v2 (2026-06-17):** revisada após painel adversário de 3 modelos (Claude+Codex+Gemini) que deu `block` na v1. Dois P1 confirmados pelos 3 (motor de adoção frágil; "verde" fabricável) e achados únicos fortes (ledger prova cor ≠ sistema completo; lead-time é o driver real do desvio) foram incorporados. **O que mudou da v1 → v2 está em §11.** Procedência completa em §10.
>
> Origem: brainstorming founder (Lucas) + 3 rounds de consulta adversária ao Codex + painel tri-modelo + round de remediação tri-modelo.

---

## 1. Problema

Arquitetos/designers (**especificadores**) definem uma cor/acabamento Sayerlack para um projeto. A especificação passa para a **marcenaria**, que pinta internamente **ou** contrata um **pintor terceirizado**. Na execução, é comum **substituir o produto especificado** por tinta automotiva (PU/poliéster) ou laca/verniz de concorrente mais barato, **imitando apenas a cor**. O especificador e o cliente final acreditam ter recebido Sayerlack, mas não receberam.

Três dores, hoje com peso parecido (confirmado pelo founder):
1. **Perda de venda** — a substituição tira faturamento do Colacor/Oben e da Renner Sayerlack.
2. **Confiança do especificador traída** — a recomendação do arquiteto é usada e desrespeitada; risco reputacional dele e da marca.
3. **Cliente final enganado** — durabilidade/qualidade/garantia diferentes do que foi especificado.

### Duas motivações do desvio (ambas importam)
- **Preço:** o substituto é mais barato.
- **Lead time (giro da oficina):** o automotivo cura em minutos; o PU Sayerlack em horas/dias. O incentivo do executor é **girar a oficina mais rápido** — não só economizar no insumo. *(Achado do painel — a v1 só via preço.)*

A substituição é **quase invisível a olho nu** porque só a cor é copiada.

### Contexto que define a solução

- **Colacor/Oben é distribuidora regional** da **Renner Sayerlack** (maior fabricante de tintas/vernizes para madeira da América Latina; a marca já mira indústria moveleira, marceneiro, arquitetos, designers, consumidor). **Fabricante é Renner Sayerlack — não Sherwin.**
- **O Colacor opera o Sayersystem localmente** — o sistema tintométrico automatizado da Sayerlack (+8.000 cores). Logo, cada cor dosada é um **evento registrado pelo Colacor**: fórmula, base, corantes, volume, comprador, data. Tabelas relacionadas já existem no app: `tint_formulas`, `tint_corantes`, `tint_bases`, `tint_skus`, `tint_produtos`.
- **⚠️ O ledger prova a COR, não o SISTEMA completo nem a APLICAÇÃO.** Fundo, catalisador, diluente, brilho e preparo podem não passar pela dosagem tintométrica; e dosar/comprar genuíno não prova que foi aplicado na peça. Isso molda todo o desenho (ver §2, §4).
- **O moat NÃO é "exclusividade de origem"** ("toda cor genuína nasce no Colacor" é falso — há compra fora, estoque anterior, transferência entre CNPJs). **O moat é a capacidade regional de rastrear** projeto + dosagem + compra + assistência + consequência comercial. *(Reposicionado no painel.)*
- **O Colacor tem relacionamento direto com especificadores** (confirmado) — o ciclo de fiscalização pode fechar.
- App B2B já existe (**Afiação**) com módulo tintométrico (12 páginas) e portal Sayerlack (canal de **compra** Colacor↔Sayerlack — `pedido_compra_sugerido` —, **não** a relação com o especificador).

---

## 2. Tese central (o que estamos construindo)

**Não é "programa de comissão para arquiteto" nem "prova antifraude definitiva".** É um programa de **especificação protegida** cujo núcleo é:

> **Benefício comercial controlado pelo Colacor + escada de evidências + auditoria probabilística.**

O jogo não é "provar quimicamente cada peça" — é **elevar o custo da mentira** até que usar o genuíno seja mais conveniente e mais barato (em risco) do que fraudar. O Colacor é o **operador técnico e registrador**, não a seguradora do acabamento.

### As 3 mudanças estruturais da v2 (resultado do painel)

1. **O motor de adoção é controlado pelo Colacor, não por contrato alheio.** A v1 apostava na *retenção de pagamento pelo cliente final* (cláusula de aceite no contrato cliente↔marcenaria). Os 3 modelos: isso vive fora do app e fora do controle do Colacor, e arquiteto SMB raramente impõe. **Substituído** por um benefício **ex-post** que o Colacor enforce direto (§3). A retenção continua como *opção* que o arquiteto pode usar, mas **não é o motor**.

2. **O "verde" é honesto, em camadas, e não é fabricável de graça.** Nada de carimbo único "Projeto 100% Verificado". Escada de estados nomeados pelo que de fato atestam (§4) + travas físicas/operacionais (§5).

3. **Lead-time vira sinal de detecção e proposta de valor**, não ponto cego (§6).

### Decisões travadas pelo founder

1. **Arquiteto 100% limpo.** Zero cash/pontos/prêmio/viagem/cashback ao arquiteto por especificar, por NF, por volume ou por conversão (risco CAU/Lei 12.378 — reserva técnica vedada). Valor para o arquiteto = não-financeiro (ferramentas, reputação, escada de evidências) **ou** fee cobrado do **cliente final dele**, transparente. ⚠️ O painel alertou: o fee de "fiscalização" facilitado pela loja pode ser lido como **RT indireta** → a marca do programa **não** menciona honorários; pendência jurídica (§9).
2. **Objetivo = escada de evidências** ("rastreabilidade com consequência comercial"), não prova antifraude. Prova química só com taggant (longo prazo, depende da Renner).

---

## 3. Os 4 papéis (o loop) + o motor de adoção

O objeto é único, mas **interfaces e incentivos diferem por papel** — não vender a mesma tela para todos.

| Papel | O que ganha | O que NÃO pode existir |
|---|---|---|
| **Arquiteto / especificador** | proteção reputacional + escada de evidências p/ defender a autoria; amostra acabada no substrato (SLA segmentado, ver §6); memorial técnico c/ janela de cura + cláusulas de aceite; relatório de não-conformidade; dashboard | qualquer valor/ponto/brinde/viagem/prêmio/desconto pessoal atrelado a especificação, venda, NF, volume ou conversão (= RT). "Leads de obra" p/ o arquiteto = **oco** num distribuidor regional → descartado |
| **Marcenaria** (compradora real) | **o motor — ver abaixo**; preço/prazo/prioridade/assistência via contrato mercantil claro | rebate disfarçado sem contrato; benefício *upfront* não condicionado |
| **Pintor / aplicador** (executor) | status de aplicador certificado (lista, indicação, treinamento, prioridade) | pagamento via arquiteto; selo sem auditoria; ser o **único** auditor de si mesmo (§5) |
| **Cliente final** (auditor/beneficiário) | certificado em camadas + QR; assistência condicionada; **alerta de lead-time** (§6); canal de contestação | tratá-lo como auditor técnico (ele não tem capacidade de avaliar substrato/cura — papel é aceite documental, não perícia) |

### O motor de adoção (controlado pelo Colacor) — convergência do painel

Benefício **ex-post**, liberado **só** após a evidência mínima fechar (projeto pré-cadastrado **antes** da compra, ticket mínimo, controles passados). Premia *"aceitou rastreabilidade e passou pelos controles"*, **nunca** *"comprou Sayerlack"* (senão vira desconto morto que só premia quem já compraria). Em ordem de força no SMB brasileiro:

1. **Prazo no boleto** (must) — marcenarias com alta taxa de projetos conformes no semestre ganham **+dias de prazo** ("o oxigênio do SMB"). É o incentivo que mais dói/atrai e o Colacor controla 100%.
2. **Seguro de retrabalho** (must) — projeto em estado verde forte que apresentar problema de acabamento → Colacor fornece produto p/ conserto + apoio técnico. Projeto fraudado/sem evidência → "o técnico não sai da loja". Atrelado à Assistência de Conformidade (§7), com tetos.
3. **Rede/portfólio de marcenarias verificadas** (fase 2) — badge + indicação a arquitetos. Demora a gerar força; melhor depois de haver histórico real.

**Risco residual (documentar e medir no piloto):** marcenaria "comprar o verde" em projetos pequenos só para destravar prazo em compras grandes de genérico → mitigar com ticket mínimo, % de conformidade sobre carteira e auditoria. Medir o incentivo contra **grupo de controle** (a recompra incremental cobre o custo do benefício?).

---

## 4. Anatomia do Projeto Verificado + escada de estados

Entidades do núcleo (tabelas/migrations ficam para o plano):
- **Projeto** — `project_id` (curto, vira QR + etiqueta), arquiteto, cliente, marcenaria, pintor, ambiente, área, sistema Sayerlack especificado, **faixa** de consumo, estado.
- **Especificação** — sistema técnico completo (não só a cor) → gera **memorial** (com janela de cura, §6) e **cláusulas de aceite**.
- **Vínculo de dosagem** — liga `project_id` a evento(s) de dosagem do Sayersystem. MVP: **manual assistido** no balcão, com trilha **append-only** (§5).
- **Cesta de componentes** — fundo, catalisador, diluente, acabamento/brilho com NF/SKU/lote **quando vendidos pelo Colacor** (base do Check de Proporção, §5).
- **Batch de dosagem** — cada dosagem vira batch com **etiqueta destrutível única por projeto**; pode ser pai de alocações (rateio).
- **Evidências de execução** — fotos (lata lacrada com etiqueta + lata aberta ao lado da peça + substrato + final), data/geo como suporte, aceite documental do cliente.
- **Certificado** — agrega tudo e expõe a **escada de estados** (não um "verde" único).
- **Contestação** — aberta pelo cliente/arquiteto; põe o projeto em revisão.

### Escada de estados (substitui o semáforo simples)

Estados nomeados pelo que **de fato** atestam — para não sobrevender:

| Estado | O que atesta |
|---|---|
| `Cor Dosada Verificada` | a cor foi dosada no Sayersystem/Colacor, vinculada ao projeto (fórmula, volume, data, lote quando houver) |
| `Sistema Documentado` | além da cor, há vínculo de NF/SKU/lote dos componentes críticos (fundo, catalisador, diluente, brilho) + Check de Proporção OK |
| `Evidência de Execução Recebida` | chegaram as fotos mínimas (lacre/etiqueta + lata aberta na peça) |
| `Conformidade Assistida` | passou por revisão humana / amostra-testemunha / auditoria |
| `Pendente / Incompleto` · `Divergência Encontrada` · `Componente Externo Declarado` | estados de exceção honestos |

**Regra anti-sobrevenda:** nenhum estado se chama "100% verificado"; o certificado mostra a **escada**, com o aviso "não comprova quimicamente a aplicação" no topo. (Naming público da marca — "Projeto Verificado" vs alternativa mais conservadora tipo "Certificado de Origem de Insumos" — é decisão em aberto, §9.)

**Consumo esperado = faixa de plausibilidade / score de risco, nunca critério isolado de "aprovado".** Rendimento em madeira varia demais (substrato, lixamento, seladora, bordas, método, demãos, perdas, habilidade). Serve para **alerta e seleção de auditoria**, não para liberar estado sozinho.

---

## 5. Travas anti-fraude (combinação mínima — isoladas viram teatro)

Nenhuma trava sozinha resolve; a **combinação** eleva o custo da fraude. Must do MVP:

1. **Etiqueta destrutível única por projeto** — impressa no balcão na dosagem (com projeto/arquiteto), colada na lata; o executor envia (via WhatsApp/PWA) foto da **lata lacrada com a etiqueta** + **lata aberta (cor à mostra) ao lado da peça**. Eleva o custo porque cria evento presencial + número único. *Risco residual: refill — mas rotular cada lata por projeto dá trabalho suficiente para a conveniência do genuíno começar a vencer.*
2. **🌟 Check de Proporção (Cesta)** — *a trava mais forte do painel.* O estado `Sistema Documentado` só libera se a NF/histórico recente contiver a **proporção técnica mínima** do sistema: para cada Nx de acabamento (cor), Y de fundo + Z de catalisador/diluente compatíveis. Transforma a fraqueza "ledger só vê cor" numa trava sistêmica positiva, sobre dados que o Colacor já tem. *Risco residual: comprar o kit e usar fundo/catalisador em outro cliente — mitigado por auditoria.*
3. **Estado forte nunca automático acima de ticket/volume** — projetos acima de valor/área/litros ficam em `Pendente` até **revisão humana** (contato com cliente/arquiteto ou amostra-testemunha).
4. **Auditoria amostral aleatória** — 5–10% dos projetos (ou todos acima de X) recebem ligação/visita curta/pedido extra; seleção **imprevisível e registrada**. É o que mais muda incentivo: o fraudador não sabe quando será checado. *(Pendência jurídica: visita-surpresa em marcenaria — §9.)*
5. **Foto com timestamp/geolocalização** — metadado de **suporte**, não trava principal (geotag é removível/forjável).
6. **Amostra-testemunha** — chapa/retalho aplicado, etiquetado com projeto/lacre/data — **só para ticket alto / projeto contestável** (fase 2 para rotina ampla).

**Trilha append-only (must):** todo evento de vínculo gera registro com usuário, data/hora, origem e justificativa; correção **não edita** o anterior (cria evento de retificação); acima de um limite, **dupla conferência** (atendente lança, responsável aprova). Viável em Airtable/planilha protegida/form com log no MVP; ERP depois. Ancorar o vínculo na **NF-e** (projeto no campo de observação) dá uma trilha externa difícil de adulterar.

---

## 6. Lead-time: sinal de detecção + ataque ao motivo

A v1 ignorava que o **giro da oficina** é um driver tão forte quanto o preço. v2 ataca dos dois lados:

- **Sinal de detecção (custo zero, must):** o memorial e o certificado ao cliente incluem a **janela esperada de processo** por sistema (aplicação, intervalo entre demãos, cura/manuseio). Texto que **arma o cliente**: *"Sistema PU de alta performance leva ~X horas para cura inicial. Se seu móvel foi pintado e embalado em muito menos tempo, pode ter recebido produto inferior (automotivo) que falha com o tempo."* Transforma a "entrega-milagre rápida" em bandeira vermelha. *Risco residual: o pintor mentir sobre o tempo parado.*
- **Ataque ao motivo (fase 2, com fabricante):** kit-obra com prazo (evitar falta de catalisador/diluente que empurra para o automotivo); treino de processo; e, se existir no portfólio Sayerlack, **direcionar para sistema de cura mais rápida**. *Honestidade: se o produto tiver desvantagem operacional grande, rastreabilidade não elimina o incentivo econômico — daí a importância do motor comercial (§3) e do fabricante.*

---

## 7. Garantia → "Assistência de Conformidade Colacor"

O Colacor **não** banca "garantia de acabamento" (passivo desproporcional ao custo do produto; o acabamento depende de variáveis fora do controle do Colacor que a ficha técnica Sayerlack ressalta). **CDC torna oferta de garantia vinculante** → redação jurídica obrigatória (§9).

O que o Colacor oferece **sozinho**, condicionado a dossiê em estado forte:
- **Suporte técnico prioritário** para projeto verificado.
- **Laudo/relatório de conformidade documental** (vale como prova em disputa).
- **Mediação técnica** entre cliente, marcenaria e pintor.
- **Reposição limitada de produto** só para falha **atribuível ao Colacor** (erro de dosagem, divergência de fórmula, produto defeituoso), com **teto**.
- **Seguro de retrabalho** (o incentivo de §3) — produto + apoio técnico para projeto conforme, com tetos e uma ocorrência por projeto.
- **Encaminhamento qualificado à Renner/Sayerlack** quando depender do fabricante.

**Blindagem de comunicação (must):** **não** usar "garantia", "garantia estendida", "seguro", "certificação de aplicação" nem "laudo" como promessa. Usar **"assistência técnica/comercial condicionada à documentação"**. Separar explicitamente garantia legal/do fabricante da assistência do distribuidor. Texto deve dizer que **não** comprova aplicação, **não** substitui análise técnica do fabricante, **não** cobre mau preparo/aplicação fora de boletim e **não** cria obrigação automática de repintura/indenização.

---

## 8. Operacional do Project ID + casos de borda

Fluxo mínimo (o peso fica no Colacor, não na marcenaria):
1. Arquiteto/Colacor cria o `project_id` por **link/WhatsApp**.
2. Afiação gera **QR + memorial + etiquetas destrutíveis**.
3. Marcenaria pede citando "usar PID ABC123".
4. **Operador do balcão** vincula no momento da dosagem (manual assistido) + registra a **cesta de componentes** (Check de Proporção) + imprime etiquetas.
5. Se o Sayersystem é software separado: vínculo manual (foto do comprovante/fórmula, NF/lote) → evoluir para **import CSV/batch diário** se exportável (§9).
6. Lata recebe **etiqueta destrutível**; executor fotografa (lacre + lata aberta na peça + substrato + final).

Casos de borda:
- **Compra fora / estoque anterior / transferência entre CNPJs:** estados honestos — `Compra Externa Declarada`, `Componente Externo Declarado` — nunca `Sistema Documentado`. O moat é o serviço de rastreabilidade, não a origem.
- **Compra para estoque (sem projeto):** "Carteira de Estoque Rastreado" por marcenaria (batch QR, NF/lote, volume, validade no momento da compra); vínculo posterior = selo diferente ("vinculado de estoque", não "dosado para o projeto"). **Estoque antigo / vínculo retroativo pós-reclamação não vira estado forte** — no máximo "documento apresentado".
- **Uma dosagem para vários projetos:** rateio por alocação (litros/%), batch pai → filhas, soma ≤ volume (tolerância pequena). **Alocação posterior à retirada não dá estado forte** (a v1 permitia até 48h após início — o painel mostrou que isso "lava" volume). Premium: dosagem dedicada.

**Linha de fricção** — aceitável: ~2 min no balcão + 3–4 fotos do pintor + 1 aceite do cliente. **Fatal:** app com senha para o pintor, digitar fórmula manualmente, estimar m² exato, exigir consumo exato, arquiteto perseguir foto.

---

## 9. Pendências (devem ser resolvidas; o discovery curto delas é pré-build)

> O painel apontou que parte destas **define o núcleo** (estados, custo, fonte de verdade) → fatiar um **discovery técnico-jurídico de 1–2 semanas antes do build**, não tratá-las como paralelas.

1. **Dados do Sayersystem (pré-build):** confirmar o que é exportável (CSV/API/relatório) e a cadência; cronometrar o passo manual no balcão. **Dependência dura do núcleo.**
2. **Jurídico — Assistência de Conformidade:** redação vinculante sob CDC; tetos; o que é/não é coberto; separação distribuidor × fabricante.
3. **Jurídico — fee do arquiteto e marca:** validar "gestão/fiscalização" cobrada do cliente sem recair em RT indireta (CAU/Lei 12.378); **desvincular a marca do programa de qualquer menção a honorários**.
4. **Jurídico — auditoria:** validar visita-surpresa em marcenaria; política de uso de fotos/geolocalização/dados pessoais (LGPD).
5. **Naming público:** "Projeto Verificado" (escada de estados) vs "Certificado de Origem de Insumos" (mais honesto, menos vendável) — *evidência que decide: mostrar as duas versões a ~5 arquitetos.*
6. **Unit economics:** custo de visita/laudo/kit de retoque/amostra; envelope sustentável no piloto; medir incentivo de canal contra grupo de controle.
7. **Renner Sayerlack (pós-piloto, com números):** `Project ID` nacional no Sayersystem, QR de lote/dosagem, cofinanciamento de amostra/showroom, garantia estendida do fabricante, **linha de cura rápida** e — longo prazo — **taggant**. **O MVP não espera a Renner.**

### Métricas para o dossiê da Renner
% de projetos especificados que viraram dosagem genuína · casos de desvio detectado/evitado · ticket médio por projeto verificado · adesão de arquitetos e marcenarias · pedidos de assistência/contestação · recompra incremental vs controle · evidência de proteção da reputação Sayerlack.

---

## 10. Escopo do MVP v2 (60–90 dias, distribuidor regional)

Roda **dentro do Afiação**, sobre os dados do Sayersystem; concierge humano no piloto.

**Entra (must):**
- `project_id` / QR + etiquetas destrutíveis + cadastro simples de projeto.
- Memorial técnico (com janela de cura) + cláusulas de aceite.
- **Escada de estados** (sem "verde" genérico): `Cor Dosada Verificada` / `Sistema Documentado` / `Evidência Recebida` / `Conformidade Assistida` / exceções.
- **Check de Proporção** (cesta: cor + fundo + catalisador + diluente + brilho, NF/SKU/lote quando Colacor vender).
- Vínculo manual assistido com **trilha append-only** + dupla conferência acima de limite.
- Coleta de fotos (lacre + lata aberta na peça) via link WhatsApp/PWA.
- **Motor comercial ex-post:** prazo no boleto + seguro de retrabalho, condicionados a estado forte + ticket mínimo.
- Estado forte **não-automático** acima de ticket + **auditoria amostral aleatória** (versão leve: ligação/fotos extras/algumas visitas).
- Alerta de **lead-time** no certificado ao cliente.
- Contestação + relatório de conformidade.
- Assistência de Conformidade com **comunicação conservadora**.

**Fase 2:** amostra-testemunha em rotina ampla · visitas técnicas frequentes · rede/ranking público de marcenarias · integração ERP/Sayersystem profunda · treinamento de produtividade/cura · negociação com fabricante (linha rápida, evidência por lote, taggant).

**Sai (explicitamente fora):** cashback/pontos ao arquiteto · garantia ampla de acabamento · prova química/laboratório/taggant · consumo exato como critério forte · retroverificação de estoque antigo · marketplace de leads · BIM completo · app pesado para pintor · CRM enterprise · **retenção de pagamento como motor** (vira opção do arquiteto, não núcleo).

### Sequência de onboarding (quem puxa a cadeia)
A tração nasce no **arquiteto premium que já sofre com execução ruim** + cliente final — os únicos com incentivo natural para exigir conformidade. **Não** começar por marcenaria genérica.
1. 10–20 arquitetos premium com dor de execução.
2. Vender o pacote: amostra + memorial + proteção reputacional + escada de evidências.
3. Project ID nos próximos projetos desses arquitetos.
4. Onboardar **as marcenarias desses projetos** (não avulsas) → ativar o motor comercial (prazo/seguro).
5. Treinar o balcão Colacor (etiqueta, cesta, trilha).
6. Certificar os pintores dessas marcenarias.
7. Rodar 30–50 projetos com concierge humano.
8. Medir (métricas §9).

---

## 11. Mudanças v1 → v2 (rastreabilidade)

| # | v1 | v2 | Por quê |
|---|---|---|---|
| 1 | Motor = retenção de pagamento (contrato cliente↔marcenaria) | Motor = benefício ex-post controlado pelo Colacor (prazo no boleto + seguro de retrabalho); retenção vira opção | P1 confirmado pelos 3 modelos: enforcement fora do app; arquiteto SMB não impõe |
| 2 | Semáforo verde/amarelo/vermelho | Escada de estados nomeados pelo que atestam; sem "100% verificado" | P1 (verde sobrevendido/fabricável) — Codex/Gemini |
| 3 | Ledger ancora o "acabamento Sayerlack" | Separa `Cor Dosada Verificada` de `Sistema Documentado` + **Check de Proporção** | Único forte (Codex): ledger prova cor, não sistema; trava de proporção (Gemini) |
| 4 | Evidência = 4 fotos pelo executor | Fotos + **etiqueta destrutível** + estado forte não-automático + **auditoria aleatória** | P1 (executor controla a própria evidência) — 3 modelos |
| 5 | Desvio = preço | Desvio = preço **e lead-time**; lead-time vira sinal de detecção + ataque ao motivo | Único forte (Gemini) |
| 6 | Rateio até 48h após início | Alocação posterior à retirada não dá estado forte | "Lava" volume (Codex) |
| 7 | Vínculo manual | Vínculo manual **append-only** + dupla conferência + âncora NF-e | Ponto único de adulteração (Codex) |
| 8 | Moat = "toda cor genuína nasce no Colacor" | Moat = capacidade de rastrear (serviço), com estados para compra externa | Premissa frágil (Codex) |
| 9 | Pendências "não bloqueiam o núcleo" | Discovery técnico-jurídico de 1–2 semanas **pré-build** | Pendências definem o núcleo (Codex) |

---

## 12. Procedência desta spec

- **3 rounds Codex** (problema → fusão → 4 fragilidades): convergência inicial — passaporte/ledger, escada de evidências, loop de 4 papéis, motor = retenção + cláusula de aceite, reposicionamento "aceite técnico rastreado".
- **Painel tri-modelo (v1):** `block`. 2 P1 confirmados pelos 3 (motor frágil; verde fabricável); únicos fortes (Codex: ledger≠sistema completo, vínculo manual adulterável, rateio lava volume, premissa de origem frágil; Gemini: lead-time é driver, refill de balde). Sem divergências factuais entre os modelos.
- **Round de remediação tri-modelo:** Codex (mecanismos: benefício ex-post, combinação de travas, dois níveis de estado, append-only) + Gemini (filtro de mercado SMB: prazo no boleto, etiqueta destrutível, **Check de Proporção**, inversão da narrativa de lead-time). Veredito dos dois: **a tese sobrevive; nenhum P1 é fatal para o produto corrigido**.
- Precedentes (web, via Codex/Gemini): CAU/RS sobre reserva técnica; CDC sobre garantia vinculante; ficha técnica Sayerlack (variáveis de aplicação); Lutron Preferred Pro e Pentair TradeGrade (garantia + treinamento + diretório + canal protegido como benefícios reais de execução).
- Pesquisa do ChatGPT (2 PDFs) aproveitada no princípio **compliance-by-design** (separar quem prescreve de quem executa/revende; zero RT) e adaptada: o material era furniture-cêntrico; em coatings **quem compra a tinta é a marcenaria**, então o lever forte é **verificação + economics de canal**.

**Caveat de fidelidade:** Codex e Gemini receberam resumos fiéis (curados pelo agente) do código e dos PDFs + a própria pesquisa web — não leram o repositório nem os PDFs crus. A leitura da fonte original foi do agente. Os modelos convergiram em todas as rodadas.
