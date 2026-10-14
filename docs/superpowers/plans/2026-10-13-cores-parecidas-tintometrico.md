# Cores parecidas e nuances no balcão tintométrico — pesquisa + plano

> Status: **plano** (nenhum código ainda). Atualizado em 2026-10-14 com as respostas da Dnaxis e o manual do Sayersystem. Origem: pedido do founder em 2026-10-13 — "o Sayersystem acha cores parecidas (nuances, RGB → parecidas); mapeie o que há de bom e o que copiar".
> Insumos: 2 varreduras do repo (Fable), 2 rodadas de pesquisa web (Fable), brainstorm + challenge do plano pelo Codex (gpt-6-astra, high — o challenge reescreveu F0/F1: contrato da edge, backfill, proveniência, denominador por tentativa, F1 = swatch+top-3 juntos), consulta read-only à prod (psql-ro).
> Domínio: ler `docs/agent/tintometrico.md` antes. Hoje o fluxo é **INBOUND-only**: o usuário `integra` é somente leitura e o Sayersystem não tem API, então quem dosa é o Sayersystem. A Dnaxis confirmou que **não há nem haverá entrada externa**: a ordem nasce no app, é dosada no Sayersystem e volta pelo sync de `vendas.controle_interno` (F1b).

## 1. Ponto de partida (fatos verificados)

| Fato | Evidência |
|---|---|
| Prod tem **9.247 cores** distintas e **~998 mil fórmulas** — e **zero** dado de aparência (nenhuma coluna rgb/lab/hex em `tint_*`) | psql-ro, 2026-10-13 |
| Balcão busca só por **texto** (`cor_id`/`nome_cor`); sem swatch, sem distância de cor, sem lib de cor no `package.json` | `src/components/tintColorSelect/useTintColorSelect.ts:115` |
| O banco do Sayersystem **tem** `padraocor(r,g,b,x,y,z,familia,pagina)` e `corante(r,g,b)`; `personcor` não tem cor | fixture do schema real `connector/sayersync/mapping_test.go:119-151` |
| O conector extrai de `padraocor` só id/código/descrição/subcoleção | `connector/sayersync/mapping.go:226`, `sync.go:1711` |
| A edge **ignora** `padracores` (só trata produtos/bases/embalagens/skus/corantes) → `tint_staging_cores_catalogo` = 0 linhas; não há tabela oficial de cor | `supabase/functions/tint-sync-agent/index.ts:370` |
| ⚠️ A edge **copia todo campo** do item para a linha (`row[k]=v`) → campo novo em `corantes` sem coluna na staging **quebra o insert do chunk em prod** | `index.ts:394` |
| M01 roda SayerSync **0.2.2** (versão cujo `install` apagava `update_manifest_url`) → 1ª atualização exige ação manual única no balcão (`install --manter-config`, #3045) | `tint_integration_settings.agent_version` |
| `r,g,b` são **digitados pelos coloristas da Sayerlack** (a origem, se medição, só a Sayerlack sabe). `x,y,z` = CIE XYZ **calculado do RGB** (sRGB, branco D65, escala 0–100, 3 casas), mas o colorista pode digitá-lo à mão | Dnaxis, resposta por e-mail 2026-10-14 |
| `familia` = tom (azuis, verdes…), `pagina` = página do leque físico; ambos opcionais | Dnaxis 2026-10-14 |
| **Nuances** do Sayersystem: ΔE sobre XYZ, **sem tolerância**, do menor para o maior; a UI mostra 9 cores (grade 3×3) com swatch e "DELTA n,nn", sem entrada nem filtro | Dnaxis 2026-10-14 · manual p.14 |
| **Não aceitam** ordem de dosagem nem cor/fórmula vinda de sistema externo (já existiu e foi descontinuado por perda de rastreabilidade), e não há plano de voltar | Dnaxis 2026-10-14 |
| O operador pode digitar **nº do pedido** e **cliente** ao dosar ou enviar para a fila; gravam em `vendas.controle_interno` e `vendas.cliente`. **Nada é obrigatório** (pedido default 0, cliente default "CLIENTE BALCÃO") | Dnaxis 2026-10-14 · manual p.15–16 |
| **Não há coleções RAL/NCS/Pantone**: o colorista põe a cartela na **TAG** (coluna `formula.tag`) ou na descrição da cor | Dnaxis 2026-10-14 · `mapping_test.go:134` |
| A fórmula personalizada **não tem** cliente, TAG nem RGB; é visível só para a loja | manual p.20–21 |
| Smart Eye **não** é da Dnaxis (sem integração) | Dnaxis 2026-10-14 |

## 2. O que existe de bom lá fora (resumo da pesquisa)

- **Sayersystem (Dnaxis, Indaiatuba/SP — 16 sistemas tintométricos, origem automotiva)**: nuances, RGB → parecidas, **Smart Eye** (colorímetro: "idêntica ou mais próxima, com grau de similaridade"; OEM não divulgado — hipótese Datacolor ColorReader), equivalência com tinta de parede, cartela digital com RGB por código. Sem manual público (o `matriz.sayerlack.com.br/sayersystem/` deu 404). Hipótese forte: "nuance" = conceito automotivo de **variante** (cor-mãe com filhas mais clara/escura/quente/fria).
- **Benjamin Moore**: página de cor separa **"Similar colors"**, **"Different shades"** (mesma tira, claro↔escuro) e **"Combinations"**. COLORx: ajuste ±5/10/25/50% com teto de volume.
- **Datacolor ColorReader/PAINT**: **top-3** com ΔE, LRV, fan deck virtual, fórmula do cliente ("Record").
- **X-Rite iMatch**: "search and correct" — parte de receita parecida existente.
- **Nix / conversores**: entrada por código RAL/NCS/Pantone com runner-up.
- **SW ColorSnap / Suvinil**: conta-gotas em foto → mais próxima.
- **Técnica**: comparar em CIELAB com **CIEDE2000** (<1 imperceptível · 1–2 só lado a lado · 2–3,5 parecida); navegar nuances em **OKLCh** (ΔL claro/escuro · ΔC vivo/acinzentado · Δh quente/frio). Lib: **culori (MIT)** — `nearest` + `differenceCiede2000`; validar contra os vetores de Sharma. 9k cores → busca linear no cliente em ms (Web Worker), sem índice no banco.
- **Madeira**: laca pigmentada (opaca) → RGB de catálogo é referência defensável; **tingidor/verniz depende da espécie** (patentes SW US7116420 / Sayerlack US7623241 medem por espécie ou sobre papel) → nunca prometer equivalência.
- **Licença de cartelas**: RAL/NCS/Pantone exigem licença para uso em software; **Suvinil publica .ASE oficial**. Cross-ref só como "aproximado, sem logo".

## 3. Nossa vantagem (o que o Sayersystem não faz)

Ele responde "qual cor parece". Nós temos cor **+ fórmula por SKU + preço + histórico do cliente** juntos. Aposta (convergência Claude + Codex): **achar uma alternativa VENDÁVEL e aprovada entre receitas que já existem** — não formular cor nova.

## 4. Fases

Regra da casa: fase N+1 só com **sinal positivo de uso com denominador** da fase N (`docs/historico/fase-sem-sinal.md`); superfície nasce com sensor no ledger.

### F0 — Dados de cor (fundação, sem UI)
1. **Discovery mínimo** (conector): amostra de `padraocor` com `r,g,b,x,y,z,familia,pagina` (best-effort, FORA do fingerprint). Dump de views/funções e RGB de `corante` = **não bloqueiam** o piloto (adiados). O piloto usa só RGB: x,y,z é derivado dele (Dnaxis), então não acrescenta informação. A única utilidade é **detectar digitação manual**: XYZ que diverge do calculado a partir do RGB (tolerância de arredondamento a 3 casas) marca a cor como "XYZ editado pelo colorista" na proveniência. Isso é medido no discovery, sem bloquear nada.
2. **Contrato explícito na edge** (não o mapa genérico): `mapPadracor` envia `id_padraocor`/`descricao`, a staging exige `cor_id` NOT NULL e usa `nome_cor` → tradução explícita + allowlist de campos + validação de tamanho de lote. Cor inválida = **rejeição observável que NÃO impede a promoção de receitas**. Payload legado sem RGB **não apaga** referência válida (ausente ≠ remoção).
3. **Proveniência antes da chave**: `cor_id` é **texto literal** (`composeCorPadrao`, `sync.go:140` — não normalizar ` - BS`). Guardar conta, loja, tipo (padrão/personalizada), **ID bruto da fonte** e subcoleção. Medir antes da constraint: hoje **3 de 9.018** `cor_id` padrão têm >1 nome (psql-ro 2026-10-13) → divergência de RGB entre subcoleções/lojas precisa ser medida; só consolidar `(account, cor_id)` depois de provar equivalência. Personalizada não herda RGB de padrão homônima.
4. **Migration** (aditiva): `tint_cores_referencia` + promoção na RPC assíncrona compatível com payload antigo — **1 writer**, RLS.
5. **Backfill seletivo**: o sync é incremental por HWM (`sync.go:847`) e a edge ignorava as cores → registros antigos estão atrás do cursor. Replay **só de `padracor`**, sem resetar hashes das ~998 mil fórmulas.
6. **Coleções**: a edge também descarta as coleções/subcoleções (staging vazia do nosso lado). Ingerir junto com `padracor`, pelo mesmo contrato explícito. Serve para o Filtro por coleção/subcoleção no seletor (o Sayersystem tem esse filtro, manual p.13). **RAL/NCS não vêm por coleção** (Dnaxis): vêm da **TAG** e da descrição, ver o item 7.
7. **TAG da fórmula → referência de cartela**: extrair `formula.tag` (hoje no schema, não extraída), também por `colOpt`. Um parser **conservador** reconhece códigos RAL/NCS/Pantone na TAG e na descrição (ex.: `RAL 7016`, `NCS S 2010-Y30R`) e grava `referencia_cartela` com a origem (tag|descricao) e o texto bruto. A busca "RAL 7016" acha a fórmula Sayerlack rotulada **sem licença**, porque o rótulo é da Sayerlack e não usamos valor de cor da cartela. Descasamento (TAG diz RAL X, descrição diz RAL Y) = **ambíguo**, não exibido. Medir a cobertura no discovery: quantas cores trazem cartela na TAG ou na descrição.
8. **Vendas para a F1b**: extrair `vendas` (hoje mapeada só para discovery) com `controle_interno`, `cliente`, data, cor/produto/base/embalagem. **LGPD**: `cliente` é nome livre digitado no balcão → guardar só o necessário para o casamento, com RLS de staff, e seguir a política de retenção (ler a skill `lgpd-data-mapping` antes). `vendas_item` (ml por corante) fica para depois.
9. **Conector**: `colOpt` nos campos novos; testes de versões mistas (binário velho × edge nova), retry, replay e payload sem RGB. **Rollback** = desligar a aparência mantendo schema aditivo e sync antigo.
- **Ordem obrigatória**: migration (+RPC) → edge → binário. Inverter quebra o sync.
- **Quem faz**: código/PR = sessão · migration = envelope ou founder no SQL Editor · edge = `pendencias:deploy` · **binário + `install --manter-config` 1× na M01 = founder** · discovery roda no balcão, arquivo volta por WhatsApp/e-mail.
- **Pronto quando** (prova por query, não por `install` concluído): versão realmente executada, fila drenada, e cobertura publicada **separada** em: com RGB válido · ausente na fonte · rejeitada · associação ambígua — sobre o universo **cores padrão ativas ligadas a fórmula canônica do escopo piloto** (não "9.247").

### F1 — Piloto no seletor: swatch + top-3 parecidas (juntos)
- Swatch só no **seletor de cor** (não espalhar por 4 superfícies ainda) + **top-3 mínimo** por CIEDE2000 (culori, validado nos vetores de Sharma).
- **Vendabilidade** (filtra ANTES do top-3): fórmula canônica ativa + SKU/embalagem compatíveis + preço liberado pelos gates existentes; excluir a própria cor; deduplicar; **"nenhuma alternativa adequada"** é resposta válida.
- Selos verbais **sem "igual"** (contradiz "referência aproximada"): "muito próxima" / "próxima" / "parecida". Tingidor: aviso "depende da madeira", sem ranking.
- **Sensor (denominador = tentativa de seleção, não "atendimento")**: UUID por abertura do seletor, fechado por seleção ou cancelamento. Ledger: abertura · elegível · exposto a parecidas · consultou · resultado vazio · erro · selecionou parecida. Deduplicar rerender, excluir teste. **Queries dos gates publicadas no PR.**
- **Aprovação** = confirmação explícita do atendente ("cliente aprovou a alternativa"); clique não é aprovação. Retrabalho sem registro+vínculo+baseline = gate **inconclusivo**, nunca aprovado. Amostra insuficiente = inconclusivo.
- **Sinal para F2**: ≥X% das tentativas elegíveis consultam parecidas e ≥Y aprovações explícitas (X/Y definidos com o founder no PR do piloto, com o baseline das 2 primeiras semanas).

### F1b — Ordem de dosagem com vínculo por `controle_interno`
Pedido do founder (2026-10-13): mandar para a fila de dosagem uma cor escolhida no app, cadastrada ou personalizada. A Dnaxis **não aceita entrada externa** e não pretende aceitar, então o fluxo é: **o app cria, o operador dosa lá e o sync fecha o ciclo** (é o caminho que a própria Dnaxis indicou).
- **Ordem de dosagem no app**: o atendente escolhe cor + produto + embalagem + quantidade e gera uma ordem com **número próprio curto** (fácil de digitar, com dígito verificador para pegar erro de digitação). A ordem aparece numa fila para o operador, que abre a cor no Sayersystem e, no campo **Pedido** (manual p.15–16), digita o nº da ordem. Status: pendente → dosada → cancelada.
- **Fechamento automático**: o sync de `vendas` (F0 item 8) traz `controle_interno`; casamento **exato** com o nº da ordem (com DV válido) + conferência de cor/produto/embalagem. Bateu → "dosada" com vínculo. Nº sem ordem, ordem com cor diferente ou DV inválido → **fila de divergência** para o operador resolver, nunca casamento por aproximação. Pedido vazio/0 (o campo **não é obrigatório**) → a venda fica "sem ordem", e a ordem continua pendente até ser vinculada ou receber baixa manual. Sem vínculo = "não confirmada", nunca "dosada".
- **Cor personalizada pendente de cadastro**: o app registra o pedido de cor nova (referência do cliente, código RAL/NCS como texto, foto/amostra, observação). O operador cria a fórmula no Sayersystem e o sync traz a `personcor`. A personalizada **não tem campo de cliente** (manual p.20), então o vínculo vem pela venda (`controle_interno` da dosagem). Sugestão operacional: usar o nº da nossa ordem no **Código** da personalizada, que é obrigatório lá. O casamento é **confirmado pelo operador**, nunca por similaridade de nome.
- **Money-path**: o preço da ordem segue os gates de preço fail-closed já existentes; cor personalizada sem fórmula = preço `null` até o cadastro. O preço/desconto **efetivamente dosado** é o da venda no Sayersystem; divergência com o da ordem é exibida, nunca sobrescrita em silêncio.
- **Treino do balcão** (founder): digitar o nº da ordem no campo Pedido é o que faz tudo funcionar. O sensor abaixo mede a adesão.
- **Sensor** (denominador = ordens criadas): % dosadas **com vínculo automático** (a adesão ao campo Pedido) · por baixa manual · canceladas · em divergência · tempo até dosar · personalizadas pendentes há mais de N dias. E, do lado do Sayersystem: % das vendas da loja com `controle_interno` preenchido.
- **Depende só do item 8 da F0** (vendas), não do RGB: pode andar em paralelo ao piloto da F1. É a fase de **maior valor imediato**: liga o pedido do app à dosagem real.

### F2 — Nuances + expansão
- Nuances em OKLCh (mais clara/escura · mais viva/acinzentada · mais quente/fria, só cores existentes) + **busca por família** com swatches (o Sayersystem já tem, manual p.27); swatch nas demais superfícies (card, Cores do cliente, catálogo).

### F3 — Alternativa comercial
- "Parecida e mais barata", "com base em estoque", "sem o corante em falta". Proximidade **primeiro**, economia depois, motivo visível. **Money-path**: preço/estoque ausentes = `null`, nunca "barato"/"disponível"; revalidar no fechamento.
- Entrada externa: hex/RGB, conta-gotas em foto (baixa confiança), **.ASE Suvinil** oficial (não sobrescreve referência Sayerlack).

### F4+ (adiado — só com sinal e decisão)
- Smart Eye como entrada (é da Sayerlack, não da Dnaxis: perguntar à Sayerlack); RGB de corantes; dump de views/funções.
- Ideias do manual para avaliar depois: alerta "cor alterada nos últimos 30 dias / baixa cobertura" antes de dosar (p.18) · "dosar novamente" a fórmula exata da venda anterior (p.23) · comparar o preço da mesma cor em todos os produtos (p.15) · resumo de corantes consumidos por período (p.22).
- Interpolação de receitas (kNN baricêntrico) / ajuste ±% / correção — **fora do escopo enquanto a fórmula for do Sayersystem** (a F1b manda a cor para a fila, não manda dose).

## 5. Cortado (de propósito)
Formulação automática, slider que altera dose, correção de mistint, equivalência garantida por foto, cross-ref RAL/NCS/Pantone com logo/código como garantia, "percentual de igualdade", ranking oculto por margem.

## 6. Perguntas abertas
- ✅ **Dnaxis respondeu em 2026-10-14** (fatos no §1) e mandou o manual de usuário (versão 20/08/2025, 48 p.). O canal de entrada no Sayersystem está **fechado** por decisão deles. Caminho definitivo: ler `vendas`/`personcor`.
- **RAL/NCS/Pantone**: o Sayersystem não tem coleção; a cartela vem na TAG/descrição (F0 item 7, sem licença). Para cor que não existe lá: **central de cores da Sayerlack** (indicação da Dnaxis). Cotar licença RAL/NCS (antigo "caminho B") só se a cobertura da TAG for baixa **e** houver demanda medida.
- **Sayerlack (central de cores)**: os RGB são medidos ou estimados? Existe padrão para escrever a cartela na TAG? O que é o Smart Eye e ele exporta Lab?
- **Integração com ERP** do Sayersystem (manual p.37–38: arquivo TXT/CSV/XLSX ou "integração com banco de dados", com manual técnico à parte) é a exportação oficial de fórmulas. Comparar com o que o SayerSync já lê **antes** de mudar algo: a leitura do banco segue como caminho principal.
