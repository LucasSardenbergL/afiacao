# Programa Canal WhatsApp — benchmark "WhatsApp da Lu" (Magalu) → Colacor/Oben

> Origem: pesquisa de benchmark em 2026-07-12 (pedido do founder: "o que dá pra copiar da Lu?"), priorizada com parecer do Codex (gpt-5.6-sol, reasoning high) e aprovada pelo founder ("quero fazer tudo"). Specs de design que este programa retoma: [2026-05-28-whatsapp-ia-orcamento-design.md](../superpowers/specs/2026-05-28-whatsapp-ia-orcamento-design.md) (v1, PR1 inbox mergeado #479) e [2026-05-28-whatsapp-pr2-rota-disparo-design.md](../superpowers/specs/2026-05-28-whatsapp-pr2-rota-disparo-design.md) (PR2a lista entregue; PR2b/c pendentes).

## O benchmark em 3 fatos

1. **Fundação transacional primeiro:** a conta da Lu no WhatsApp fez SÓ acompanhamento de pedido de 2018 a 2024 (15M de opt-ins) antes de virar canal de venda. A confiança/opt-in veio de mensagem ÚTIL, não de marketing.
2. **AI commerce (nov/2025):** jornada completa in-chat (busca por texto/áudio/foto → recomendação → carrinho → Pix/cartão → rastreio proativo → NPS). R$ 100M em 8 meses, 7,7M usuários, conversão 3×, NPS 84,5, ~20% recompra no canal, 75% dos pagamentos via Pix copia-e-cola.
3. **Arquitetura:** orquestrador multi-agente com modelo-por-tarefa (custo/latência), carrosséis + WhatsApp Flows, identidade CPF/e-mail, rollout gated (300k→1M→30M).

Fontes: [Exame](https://exame.com/inteligencia-artificial/lu-do-magalu-ganha-cerebro-com-ia-e-vira-vendedora-dentro-do-whatsapp/) · [case Meta](https://whatsappbusiness.com/resources/success-stories/magalu/) · [TI Inside 07/2026](https://tiinside.com.br/07/07/2026/magalu-vende-mais-de-r-100-milhoes-por-whatsapp/) · [Mundo do Marketing](https://mundodomarketing.com.br/com-ia-magalu-permite-compra-total-pelo-whatsapp-sem-sair-da-conversa).

## Parecer do Codex (síntese fiel; cru preservado na sessão de 2026-07-12)

- Tese: *"a prioridade não é copiar a Lu; é fechar o ciclo rota → proposta → resposta → pedido no Omie"*. Aposta central: **HSM → fila+métricas → proposta 1-toque → disparo por rota** — provar que a proposta converte com humano escolhendo enviar ANTES de automatizar o gatilho.
- Onde a analogia B2C quebra no nosso B2B de rota: reposição lidera (não descoberta); preço é contextual (CNPJ/volume/prazo — sempre Omie, nunca IA); Pix in-chat NÃO é o checkout nosso (boleto/prazo é parte do valor) → **cortado**; rastreio honesto por estados de rota (sem ETA falso); o canal AUMENTA as vendedoras (não substitui); identidade = contato+cliente+CNPJ+carteira (telefone é compartilhado); **não copiar o orquestrador multi-agente agora** (máquina de estados + ferramentas determinísticas + 1 modelo bastam); copiar o PRINCÍPIO do rollout gated (1 rota × 1 vendedora × 1 CNPJ), não os números.
- Métricas do canal são **critério de aceite desde o 1º PR**, não projeto de dashboard.

## O programa (espinha aprovada 2026-07-12)

- 🔄 **PR-1 — Núcleo HSM:** catálogo `whatsapp_templates` + log idempotente `whatsapp_template_sends` (dedupe-first, opt-out enforced) + edge `whatsapp-send-template` + statuses de entrega no `whatsapp-inbound`. Prova PG17 (dedupe/CHECKs/RLS/falsificação). *(este PR)*
- ⏳ **PR-2 — Fila "respondeu→topo":** ligar pendentes ao Meu Dia via RPC sem cap com `last_outbound_at` real (mata o falso-negativo documentado em `useWhatsappPendentes`).
- ⏳ **PR-3 — Funil do canal:** eventos enviado→entregue→respondeu→proposta→pedido Omie, atribuição rota/carteira/CNPJ.
- ⏳ **PR-4 — Proposta 1-toque:** enviar a cesta de `/rota/propostas` via template com recotação Omie no envio; linha sem preço trava (ausente≠zero). 🟥 prove-sql + Codex adversarial.
- ⏳ **PR-5 — Status transacional v0 (utility):** pedido confirmado / sai na rota de amanhã / entregue — estados honestos, sem ETA (o "Ato 1 da Lu": opt-in barato via mensagem útil).
- ⏳ **PR-6 — Motor de disparo por rota (spec PR2b):** véspera, supressão de quem comprou, cadência, pacing pelo tier Meta (`selectDisparoBatch` já existe), piloto gated. 🟥 prove-sql + Codex adversarial.
- ⏳ **Épicos:** E1 áudio→rascunho na inbox (transcrição; nunca executa pedido) · E2 pedido conversacional (intenção→cesta→cotação Omie→confirmação→revisão humana→pedido idempotente; knowledge-base e Flows DENTRO; autonomia por níveis) · E3 2ª via de boleto (condicional a documento/status determinísticos no Omie).
- ⏸️ **Cortado do horizonte:** Pix in-chat; orquestrador multi-agente; loja conversacional aberta.

## Ações externas do founder (fora do código)

1. **Submeter os 2 templates na 360dialog** para aprovação da Meta (textos de referência no seed da migration `20260713010000_whatsapp_templates_hsm.sql`; wording ajustável — brand-voice é do founder). Categoria: `colacor_proposta_recompra` = marketing (~R$0,33/msg); `colacor_status_pedido` = utility.
2. Após aprovado, **ativar**: `UPDATE public.whatsapp_templates SET ativo = true WHERE nome = '<nome>';` (SQL Editor).
3. Deploys manuais do PR-1: migration no SQL Editor + 2 edges pelo chat do Lovable (checklist no corpo do PR).

## Regra de execução

1 entrega = 1 sessão (handoff entre PRs via `/handoff-sessao`). Todo PR que toca preço/pedido (PR-4, PR-6, E2) exige `prove-sql-money-path` + passe adversarial do Codex — não é opcional no money-path.
