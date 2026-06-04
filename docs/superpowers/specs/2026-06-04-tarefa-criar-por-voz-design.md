# Criar tarefas por voz — áudio → IA estrutura → revisa → cria (design)

> Data: 2026-06-04 · Módulo: Tarefas (Fase 1, já em produção) · Brainstorm: Lucas + Claude
> Status: design aprovado nas decisões-chave (ver §2) + **endurecido com passe adversário do codex** (§15). Aguarda revisão do founder antes do plano.

## 1. Problema / objetivo

Hoje o founder cria tarefas pras vendedoras (Regina, Tatyana — farmers só de ligação + WhatsApp) preenchendo o `CriarTarefaDialog` na mão: escolhe o cliente, digita a descrição, escolhe categoria, modo de prazo e data. É fricção — ele quer **falar um áudio** ("manda a Regina ligar pra Padaria do Zé amanhã e oferecer a linha nova, e manda whatsapp pra Maria na sexta") e o app **transcrever + estruturar isso em tarefas** que caem no **Meu Dia da vendedora no dia certo**.

## 2. Decisões do brainstorm (aprovadas)

1. **Modo de identificação = (A) + correção:** o founder fala TUDO, a IA **infere**, mas mostra um **rascunho editável** onde ele corrige cliente/vendedora (e qualquer campo) **antes de salvar**. Escada de certeza: IA propõe, humano confirma. **Zero auto-criação.**
2. **Multi-tarefa por áudio:** um áudio gera **N tarefas** (clientes/vendedoras até diferentes). A IA quebra em N rascunhos; a revisão é uma **lista** de cards editáveis.
3. **"Calendário delas" = o prazo (data) da tarefa.** Não existe (nem se cria aqui) tela de calendário visual separada — o `due_date` é o que joga a tarefa pro topo do Meu Dia no dia certo. "amanhã"/"sexta"/"dia 15" vira essa data.

## 3. Princípio de arquitetura (do passe do codex — central)

**A IA faz só a parte semântica: entender e SEPARAR as tarefas + extrair strings cruas.** Toda decisão determinística crítica sai da IA:

- **Datas** → resolvidas por um **parser pt-BR próprio** (determinístico, ancorado em hoje-SP), não pela IA. A IA só devolve a *frase falada* ("sexta que vem").
- **Cliente e vendedora** → resolvidos por **match local com limiar + ambiguidade explícita**, não pela IA. A IA só devolve o *nome falado* (string), **nunca um id**.
- **Validação de forma** → **schema/Zod dos dois lados** (edge + front); resposta fora do schema vira fallback explícito, nunca "best-effort".

A IA erra data e entidade de forma *plausível* (parece certo, está errado) — exatamente o que passa batido numa revisão rápida. Tirar essas decisões dela é o que torna a feature segura.

## 4. Fluxo

1. Em `/tarefas`, botão **"🎙️ Criar por voz"** → abre o `VozTarefaDialog`.
2. **Grava** (MediaRecorder) ou **digita** (fallback de texto, mesmo motor de extração).
3. Áudio → **transcrição** via a edge **`elevenlabs-transcribe`** (já existe e roda; reuso o padrão do `VoiceServiceInput`).
4. Texto → **extração por IA** via edge nova **`tarefa-extrair-voz`** (Anthropic, tool-use/JSON schema) → **lista de extrações cruas** + spans de cobertura.
5. **Camada determinística (front, helpers puros TDD):** resolve **data** (parser), **cliente** (fuzzy + limiar) e **vendedora** (match na lista) — cada um com um **status** (resolvido / ambíguo / não-resolvido).
6. **Tela de revisão** (lista de cards) — mostra a **transcrição inteira fixa no topo** + "Detectei N tarefas", e por card:
   - **Vendedora** — match + status; ambíguo/sem-match = ação obrigatória.
   - **Cliente** — melhor match + alternativas + **`nome falado` sempre visível ao lado**; score baixo ou top-2 empatados = **não auto-seleciona**, exige escolha.
   - **Descrição, categoria, prazo, target_texto** — editáveis; alertas de dependência (ver §9).
   - **Prazo** com status: data resolvida (mostra a data), "ambígua/não entendi" (bloqueia até resolver), "não falou data" (cai em próxima-interação OK).
   - Remover um rascunho da lista.
7. **Confirma** → validação dura (§10) → cria a(s) tarefa(s) via `criarTarefas` (batch). Cai no Meu Dia da vendedora na data certa. **Guarda a transcrição crua na auditoria** (§11).

## 5. Componentes

**Reuso (nada novo):** `elevenlabs-transcribe` (edge), picker de cliente Omie da `/tarefas`, `useTarefaMutations().criarTarefas`, padrão de gravação do `VoiceServiceInput`.

**Novo:**
- Edge **`tarefa-extrair-voz`** (Anthropic, tool-use): transcrição + contexto → lista de extrações cruas. Gated **master/gestor** (`pode_ver_carteira_completa`/master). Validação Zod-equivalente da saída no edge.
- Helpers puros TDD: **`resolverDataPtBr`** (parser de data relativa), **`casarCliente`** / **`casarVendedora`** (match + limiar + ambiguidade), **`montarRascunhosVoz`** (orquestra extração→resolução→status). Espelhados/validados nos dois lados onde fizer sentido.
- Componente **`VozTarefaDialog.tsx`** (grava → spinner → transcrição fixa + lista editável com status → salva).

## 6. Contrato da IA — só extração crua (tool-use + schema)

**Entrada** (montada no front — NÃO manda 10 mil clientes):
```
{ transcricao, hoje: "YYYY-MM-DD" (SP), tz: "America/Sao_Paulo", vendedoras: [{ id, nome }] }
```

**Saída (tool-use, schema fixo):**
```
{
  detectei_n: number,                 // contagem explícita (P3: força notar fusão/omissão)
  texto_nao_coberto: string | null,   // trecho imperativo que a IA NÃO transformou em tarefa
  tarefas: [{
    evidence_text: string,            // o TRECHO da transcrição de onde veio esta tarefa
    descricao: string,
    categoria_palpite: "ligar"|"oferecer"|"preco"|"whatsapp"|"outro"|null,
    cliente_nome_falado: string | null,   // STRING ouvida — NUNCA id
    vendedora_nome_falado: string | null, // STRING ouvida — NUNCA id
    raw_date_text: string | null,          // a FRASE de data ("sexta que vem") — NÃO uma data
    target_texto: string | null,           // item/preço pra oferecer/preco
  }]
}
```
A IA **não resolve data, não casa cliente, não casa vendedora.** Saída fora do schema → fallback explícito (§11), nunca best-effort.

## 7. Datas — parser determinístico pt-BR (helper `resolverDataPtBr`, TDD)

Entrada: `raw_date_text` + `hoje` (SP, via `spBusinessDate`/`sp-day.ts`). Saída: `{ modo, due_date|null, interacao_tipo|null, status }` com **status**:
- **`sem_data`** — `raw_date_text` é `null`/vazio → `modo='interacao'` (default atual: próxima ligação). **OK** cair aqui.
- **`resolvida`** — frase clara → `modo='data'`, `due_date` ISO. Ex. (hoje 2026-06-04, quinta): "amanhã"→06-05; "sexta"→06-05; "sexta que vem"→06-12; "dia 15"→06-15.
- **`ambigua`** / **`nao_resolvida`** — falou data mas o parser não cravou (≠ não falou) → **bloqueia o card** até o founder escolher. **Nunca** cai em próxima-interação calado.
- **`passado`** — resolve pra data passada (ex. "dia 1" já passou) → **não** rola pra frente silencioso; marca e exige confirmação visual.

Cobre: amanhã, depois de amanhã, hoje, dia-da-semana ("sexta"=próxima sexta incl. hoje? **decisão: a próxima ocorrência, hoje conta**), "X que vem" (semana seguinte), "dia N", "semana que vem", "fim do mês", "segunda da semana que vem". Testes de mesa obrigatórios (P3): quinta→"sexta", sexta→"sexta", "sexta que vem", "dia 15" antes/depois do 15, "fim do mês", "segunda que vem", data no passado.

## 8. Cliente — match local com limiar (helper `casarCliente`, NUNCA inventa)

A IA só dá `cliente_nome_falado`. O front busca nos clientes do Omie (mesmo search da página) e classifica:
- **`unico`** — 1 match forte (score ≥ limiar, folga clara sobre o 2º) → pré-seleciona, mas **mostra `nome falado` ao lado** pra conferência.
- **`ambiguo`** — top-2 próximos OU score médio → **não auto-seleciona**; lista candidatos; ação explícita do founder.
- **`sem_match`** — nada acima do piso → "cliente não encontrado, busque" + picker manual.

**Tarefa não salva sem `customer_user_id` resolvido** (o `criarTarefas` exige). **Nunca** um id fabricado pela IA.

## 9. Vendedora — match local (helper `casarVendedora`)

A IA só dá `vendedora_nome_falado` (não `id` — P2: "Maria" pode ser um cliente, não a vendedora). Match determinístico contra a lista pequena (1º nome + limiar): `unico` pré-seleciona com `nome falado` ao lado; `ambiguo`/`sem_match` → dropdown sem pré-seleção, founder escolhe.

## 10. Categoria + validação dura no save (front E edge)

- **Categoria** = palpite editável. Validar dependências: `oferecer`/`preco` **exigem `target_texto`** (o que o matcher do Fase 1 procura na ligação) → alerta se vazio. Categoria fora do enum → fallback `outro` + alerta (não normaliza calado).
- **Prazo:** `modo='data'` **exige `due_date` ISO válida e futura**; `modo='interacao'` **exige `interacao_tipo`**. Sem isso **não salva** (senão cai no backstop/`effective_due` e parece tarefa válida no dia errado).
- **Cliente** resolvido (id) obrigatório. **Vendedora** (`assigned_to`) obrigatória.
- Card com qualquer status `ambiguo`/`nao_resolvida`/`passado` pendente → **bloqueia o save** daquele card (os demais salvam).

## 11. Degradação / auditoria (nunca perde palavra, nunca cria errado calado)

- **Transcrição falha** → toast + cai no campo de texto (digita).
- **IA falha / fora do schema / vazia** → **1 rascunho único com a transcrição crua na descrição** + aviso "não consegui estruturar, revise". Não perde o que ele falou.
- **Split com perda** (IA fundiu/omitiu) → o `texto_nao_coberto` + os `evidence_text` por tarefa alimentam a UI: transcrição inteira fixa no topo, destaque do que **não** virou tarefa, "Detectei N tarefas". Texto imperativo não coberto → **flag de revisão obrigatória**.
- **Sempre revisão humana antes de salvar.** Nenhum caminho auto-cria.
- **Auditoria (P3):** grava a `transcricao` crua + a extração da IA num `tarefa_eventos` (`tipo_evento='criada_por_voz'`, payload com transcrição + raw) → diagnóstico posterior de tarefa errada.

## 12. Empresa
Derivada do **cliente casado** (account/empresa do registro Omie); fallback = company context do founder. Resolvida no save, não pela IA.

## 13. Permissão
Só **master/gestor** (quem cria tarefa hoje). A edge `tarefa-extrair-voz` valida o caller (JWT staff + `pode_ver_carteira_completa`/master).

## 14. Não-objetivos (v1)
- Tela de **calendário visual** separada (o prazo já resolve "o dia").
- **Vendedora** criar tarefa por voz (é o founder que atribui — cobrança top-down).
- **Editar** tarefa existente por voz.
- Transcrição **ao vivo/streaming**.
- Vincular a tarefa a um PV/pedido específico por voz.

## 15. Passe do codex (2026-06-04) — incorporado

Consult adversário de metodologia (gpt-5.5, `model_reasoning_effort=medium`). **Veredito:** IA faz extração+split; datas e entidades saem da IA pra código determinístico + confirmação humana. **P1 incorporados:** (1) parser de data próprio + `raw_date_text` + status `ambigua/passado` que bloqueia, nunca rola silencioso [§7]; (2) validação dura `modo=data⇒due_date`/`modo=interacao⇒interacao_tipo`/enum estrito [§10]; (3) `evidence_text` por tarefa + `texto_nao_coberto` + transcrição fixa + "Detectei N" pra split-loss [§6, §11]; (4) cliente: não auto-resolver com score baixo/top-2 próximos, `nome falado` sempre visível [§8]. **P2:** vendedora por match local (não id da IA) [§9]; distinguir "não falou data" de "não entendi" [§7]; dependência de categoria/`target_texto` [§10]; **structured output + Zod dos dois lados** [§6]. **P3:** `raw_transcricao` na auditoria [§11]; "Detectei N tarefas" [§6/§11]; testes de mesa de datas [§7].
