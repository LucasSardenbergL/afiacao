# Cobertura de teste do `shareOrderViaWhatsApp` — Design Spec

> **Data:** 2026-05-26
> **Status:** continuação autônoma (lane seguro/não-colidente — arquivo de teste novo). `src/utils/whatsappShare.ts` (compartilha pedido via WhatsApp) sem teste. Customer-facing: mensagem/URL errada = comunicação errada com o cliente.

## Goal

Travar a montagem da mensagem + a URL `wa.me` que abre no WhatsApp. Sem mudança de código.

## Regras (do código)

- Monta `msg` com: header `*Pedido Colacor*`, `Cliente: <nome>`, linha de `Pedido(s): a + b` **só** se `orderNumbers` não-vazio, lista de itens (`• {qtd}x {desc}{ (Cor: id — nome) se tintCorId} - {qtd×preço em BRL}`), `*Total: {BRL}*`, `Data: {dd/mm/aaaa hh:mm pt-BR}`.
- Abre `window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank')`. Não retorna nada (efeito colateral).

## Cenários

1. Abre `wa.me/?text=` em `_blank`; mensagem contém header + cliente + `Data:`.
2. Item: `• qtd x desc` + BRL de `qtd×preço` + `*Total:`.
3. `tintCorId` presente → inclui `Cor: <id>` + nome.
4. Sem `tintCorId` → sem `Cor:`.
5. `orderNumbers` → `Pedido(s): a + b`; vazio → sem a linha.
6. Múltiplos itens → múltiplas linhas.

## Testing

`src/utils/__tests__/whatsappShare.test.ts` (vitest; `vi.spyOn(window,'open')`, decodifica o `text=`). Asserts por `toContain` (evita NBSP do BRL e fragilidade de TZ na data — só checa o ano). 7 casos, verde; lint limpo; sem tocar o módulo.

## Out-of-scope

- Formatação exata da data (ICU/TZ-dependente); o comportamento real do WhatsApp.
