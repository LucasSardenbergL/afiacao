---
name: doc2md
description: >-
  Converte documento BINÁRIO (PDF, DOCX, XLSX, PPTX, MSG) em Markdown legível, com guarda
  contra extração vazia, neste repo (Afiação/Colacor). Use SEMPRE que o Lucas anexar/apontar
  ou mencionar um arquivo desses — boletim técnico Sayerlack, pedido de compra de cliente
  (Lider), tabela de preço, circular de aumento, extrato, DANFE, proposta, planilha de
  fornecedor — e você precisar LER o conteúdo. Use também para gerar `.expected` de fixture a
  partir de PDF real, e para comparar DUAS versões do mesmo boletim ("o que mudou?"). Por quê:
  sem o ritual o agente erra três vezes seguidas — `uvx markitdown x.pdf` falha por falta do
  extra `[pdf]`; PDF escaneado/imagem sai com **exit 0 e ~1 byte** (falha SILENCIOSA, lida como
  "documento vazio"); e a saída despeja milhares de tokens no contexto de toda request seguinte.
---

# doc2md — documento binário → Markdown, com evidência positiva

## O ritual

Sempre pelo script — ele embute a guarda que a memória esquece:

```bash
.claude/skills/doc2md/doc2md.sh <arquivo> [dir-saida]
```

Depois **leia por recorte**, nunca despejando o arquivo inteiro:

```bash
head -c 2000 <saida.md>              # panorâmica
grep -n '<termo>' <saida.md> | cut -c1-160   # busca dirigida
```

Saída default: `$TMPDIR/doc2md/`. Prefira o scratchpad da sessão quando o artefato importar.

Exit codes: `0` ok · `1` markitdown falhou · `2` uso/arquivo inexistente · `3` é imagem
(recusa) · `4` **guarda de bytes** (extraiu menos que o piso).

## A guarda (o motivo do script existir)

`markitdown` num PDF **sem camada de texto** sai com **exit 0 e 1 byte**. Medido neste repo.
Exit 0 aqui não prova extração — só bytes provam. O script mede e falha em vermelho.

**Exit 4 nunca significa "o documento está vazio".** Significa *não consegui ler* — o PDF é
escaneado. Nesse caso leia o **original** com a ferramenta `Read` (visão do modelo). É a mesma
regra do CLAUDE.md: ausência de sinal ≠ aprovação.

## Money-path: três armadilhas medidas no PDF real da Lider

Antes de deixar qualquer número virar preço/quantidade no app ou num `.expected`:

1. **Decimal é BR.** O preço vem `111,400000`, não `111.4`. Converter é lógica nossa —
   `Number("111,400000")` é `NaN`, e `NaN` mascarado vira fabricação.
2. **Primeira ocorrência mente em documento multi-página.** No pedido 213294,
   `grep -m1 "TOTAL DAS MERCADORIAS"` acerta o rodapé da **pág. 1**, que está **em branco**
   (tem `C O N T I N U A . . .`); o valor real (`13638,00`) só existe na pág. 2. Ancore no
   rodapé **final**, ou confira a contagem de ocorrências antes de ler uma.
3. **Descrição vem quebrada em N linhas.** `FLANELA MICROFIBRA` / `AUTOMOTIVA 40 X 40CM -` /
   `C/ COSTURAS` são linhas separadas. O join é código, não mágica.

**Regra:** doc2md serve para **entender e navegar** o documento. Número que vira dinheiro
passa por conferência humana ou por parser testado — nunca por leitura direta minha.

## Onde este ritual NÃO se aplica

- **Runtime do app.** `kb-ingest-document` roda `pdf-parse` numa **edge Deno**; markitdown é
  Python e não roda lá. Isto é ferramenta de SESSÃO, não caminho de produção. Não proponha
  trocar a edge por isso.
- **Imagem / foto de circular.** Não é OCR (exit 3). Os uploads de aumentos e promoções aceitam
  `.png/.jpg` — esse caso é `Read` com visão, ou a extração paga.
- **Documento que você já tem em texto.** Não converta o que já é `.md`/`.csv`/`.txt`.

## Casos que rendem neste repo

| Situação | O que doc2md entrega |
|---|---|
| PDF novo de pedido programado (Lider ou cliente novo) | matéria-prima do `.expected.ts` — o gabarito atual foi transcrito **a olho** |
| Boletim Sayerlack v2 chegou | `doc2md` nos dois + `diff` → *o que* mudou (`kb_product_spec_versions` guarda as versões mas não sabe ler a diferença) |
| Campo errado no `kb-extract-specs` (custa $) | comparar o md local com o draft salvo → diagnóstico **sem re-pagar** |
| `.xlsx`/`.docx` de fornecedor no e-mail | leitura direta, sem você colar texto |

## Red flags — pare

- Vou rodar `uvx markitdown` na mão → **não**: falta o extra, e falta a guarda.
- Deu exit 0, então converteu → **não**: confira bytes (é o que o script faz).
- Saiu quase vazio, o documento deve ser vazio → **não**: é PDF escaneado. `Read` no original.
- Vou `cat` o md inteiro pra ler → **não**: recorte com `head -c` / `grep | cut`.
- Peguei o preço direto do markdown e já usei → **não**: vírgula BR + primeira-ocorrência.
