# Cores parecidas e nuances no balcão tintométrico — pesquisa + plano

> Status: **plano** (nenhum código ainda). Origem: pedido do founder em 2026-10-13 — "o Sayersystem acha cores parecidas (nuances, RGB → parecidas); mapeie o que há de bom e o que copiar".
> Insumos: 2 varreduras do repo (Fable), 2 rodadas de pesquisa web (Fable), brainstorm + challenge do plano pelo Codex (gpt-6-astra, high — o challenge reescreveu F0/F1: contrato da edge, backfill, proveniência, denominador por tentativa, F1 = swatch+top-3 juntos), consulta read-only à prod (psql-ro).
> Domínio: ler `docs/agent/tintometrico.md` antes. Hoje o fluxo é **INBOUND-only**: o usuário `integra` é somente leitura e o Sayersystem não tem API, então quem dosa é o Sayersystem. A ida do app para a fila de dosagem começa **manual** (F1b) e só fica automática se a Dnaxis oferecer um canal de entrada (§6).

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
| Semântica de `x,y,z` **não confirmada** (provável CIE XYZ — mas pode ter sido derivado do próprio RGB) | — |

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
1. **Discovery mínimo** (conector): amostra de `padraocor` com `r,g,b,x,y,z,familia,pagina` (best-effort, FORA do fingerprint). Dump de views/funções e RGB de `corante` = **não bloqueiam** o piloto (adiados). x,y,z ficam **brutos e sem semântica** até haver evidência; o piloto usa só RGB.
2. **Contrato explícito na edge** (não o mapa genérico): `mapPadracor` envia `id_padraocor`/`descricao`, a staging exige `cor_id` NOT NULL e usa `nome_cor` → tradução explícita + allowlist de campos + validação de tamanho de lote. Cor inválida = **rejeição observável que NÃO impede a promoção de receitas**. Payload legado sem RGB **não apaga** referência válida (ausente ≠ remoção).
3. **Proveniência antes da chave**: `cor_id` é **texto literal** (`composeCorPadrao`, `sync.go:140` — não normalizar ` - BS`). Guardar conta, loja, tipo (padrão/personalizada), **ID bruto da fonte** e subcoleção. Medir antes da constraint: hoje **3 de 9.018** `cor_id` padrão têm >1 nome (psql-ro 2026-10-13) → divergência de RGB entre subcoleções/lojas precisa ser medida; só consolidar `(account, cor_id)` depois de provar equivalência. Personalizada não herda RGB de padrão homônima.
4. **Migration** (aditiva): `tint_cores_referencia` + promoção na RPC assíncrona compatível com payload antigo — **1 writer**, RLS.
5. **Backfill seletivo**: o sync é incremental por HWM (`sync.go:847`) e a edge ignorava as cores → registros antigos estão atrás do cursor. Replay **só de `padracor`**, sem resetar hashes das ~998 mil fórmulas.
6. **Coleções**: a edge também descarta as coleções/subcoleções (staging vazia do nosso lado). Ingerir junto com `padracor`, pelo mesmo contrato explícito. É pré-requisito para "coleção RAL/NCS" (§6), para filtrar por coleção no seletor e para a `familia` da F2.
7. **Conector**: `colOpt` nos campos novos; testes de versões mistas (binário velho × edge nova), retry, replay e payload sem RGB. **Rollback** = desligar a aparência mantendo schema aditivo e sync antigo.
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

### F1b — Ordem de dosagem + cor personalizada pendente (manual primeiro)
Pedido do founder (2026-10-13): mandar para a fila de dosagem uma cor escolhida no app, cadastrada ou personalizada.
- **Ordem de dosagem no app**: o atendente escolhe cor + produto + embalagem + quantidade e gera uma ordem com **número próprio**. A ordem aparece numa fila para o operador do balcão, que dosa no Sayersystem como faz hoje (digitando a cor). Status: pendente → dosada → cancelada.
- **Cor personalizada pendente de cadastro**: o app registra o pedido de cor nova (referência do cliente, código RAL/NCS digitado como texto, foto/amostra, observação). O operador cadastra no Sayersystem e o sync traz a `personcor` de volta. O casamento ordem↔personcor é **confirmado pelo operador**, nunca por similaridade de nome.
- **Fechamento do ciclo**: a ordem fica "dosada" quando aparecer a venda correspondente em `VENDAS/VENDAS_ITEM` (se a Dnaxis liberar a leitura e houver campo onde o operador digite o nº da nossa ordem) ou por baixa manual do operador. Sem vínculo = "não confirmada", nunca "dosada".
- **Money-path**: o preço da ordem segue os gates de preço fail-closed já existentes; cor personalizada sem fórmula = preço `null` até o cadastro.
- **Automação** (importar ordem ou criar cor direto no Sayersystem) **só se a Dnaxis oferecer canal oficial** (arquivo, pasta monitorada, tabela de entrada). Não gravar no banco deles por fora.
- **Sensor**: ordens criadas · dosadas com vínculo · dosadas por baixa manual · canceladas · tempo até dosar · personalizadas pendentes há mais de N dias.
- **Independe da F0** (não precisa de RGB): pode andar em paralelo ao piloto da F1.

### F2 — Nuances + expansão
- Nuances em OKLCh (mais clara/escura · mais viva/acinzentada · mais quente/fria, só cores existentes) + variantes da mesma `familia`; swatch nas demais superfícies (card, Cores do cliente, catálogo).

### F3 — Alternativa comercial
- "Parecida e mais barata", "com base em estoque", "sem o corante em falta". Proximidade **primeiro**, economia depois, motivo visível. **Money-path**: preço/estoque ausentes = `null`, nunca "barato"/"disponível"; revalidar no fechamento.
- Entrada externa: hex/RGB, conta-gotas em foto (baixa confiança), **.ASE Suvinil** oficial (não sobrescreve referência Sayerlack).

### F4+ (adiado — só com sinal e decisão)
- Smart Eye como entrada (confirmar OEM/exportação Lab); RGB de corantes; dump de views/funções.
- Interpolação de receitas (kNN baricêntrico) / ajuste ±% / correção — **fora do escopo enquanto a fórmula for do Sayersystem** (a F1b manda a cor para a fila, não manda dose).

## 5. Cortado (de propósito)
Formulação automática, slider que altera dose, correção de mistint, equivalência garantida por foto, cross-ref RAL/NCS/Pantone com logo/código como garantia, "percentual de igualdade", ranking oculto por margem.

## 6. Perguntas abertas
- **Dnaxis** (mensagem redigida em 2026-10-13, quem envia é o founder): importação de ordem de dosagem · criação de cor personalizada vinda do ERP · campo de pedido gravado em `VENDAS/VENDAS_ITEM` · semântica de `r,g,b` e `x,y,z` (iluminante, escala, medido ou digitado) · `familia`/`pagina` · critério das "Nuances" e da busca por RGB · coleções RAL/NCS/Pantone · Smart Eye (tabela, Lab/RGB, OEM) · manual de usuário. As respostas decidem a automação da F1b, a semântica na F0 e a F2.
- **RAL/NCS/Pantone**: o código digitado como texto ("RAL 7016") é livre; o **valor de cor** das cartelas exige licença. **Caminho A (recomendado)**: a Sayerlack fornecer coleções RAL/NCS **com fórmula** (a Sayerlack Itália já tem RAL Classic/NCS no Wood Color Plus) → entram como coleção pela F0. **Caminho B**: cotar licença RAL/NCS para software. Decisão do founder.
- O que exatamente faz o botão "nuances" do Sayersystem? → resposta da Dnaxis ou AnyDesk (read-only, o founder conecta) + dump de views/funções no discovery.
- Pedir à Dnaxis/DTI Sayerlack o "arquivo de fórmulas para ERP" (existe para Anjo/Coral) — canal oficial em vez de ler o Postgres por fora.
