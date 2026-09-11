// GERADO por `bun scripts/sonda-fingerprint.ts --write` — NÃO editar à mão.
//
// Fingerprint da FONTE de cada edge instrumentada: SHA-256 sobre o fecho transitivo dos imports
// LOCAIS a partir do `index.ts`, incluindo `_shared/`. É a metade que o gate `sonda:bump` não
// alcança: ele cobre mudança dentro da pasta da edge, e `_shared/` ficou fora dele de propósito
// (~12 bumps à mão por PR). Aqui o fan-out é de graça porque o CI REGENERA.
//
// Servido por `criarRespostaSonda` no campo `fonte` — é isso que torna a identidade função do
// CONTEÚDO, e não da disciplina de quem bumpa. Regravar este arquivo à mão para calar o gate
// derrota o mecanismo inteiro: rode o `--write`.
//
// ⚠️ Fingerprint da FONTE, não hash do BUNDLE — não há `deno.lock` versionado e há range aberto
// (`npm:@supabase/supabase-js@2`), então a mesma fonte pode resolver dependência externa diferente.

export const FONTE_SHA256: Record<string, string> = {
  "ai-ops-agent": "e332594ddd54f4e42cd18281584d726b95afe11df751943d273b737567825f13",
  "algorithm-a-audit": "81cf9e67d3dcb6e95350f7e09d1116965b538b6a7b80cd64fe02b2b2eac5f4ec",
  "analytics-outbox-drain": "b03bbf880f09d2f08d3320def1f7d617506869d063ca0023af65292511c9fded",
  "analyze-services": "fc9fe8712c43bb7f814c3d280c4709ffe7c10be6015bf1d80fafcbbd6d2fda4f",
  "analyze-unified-order": "51560d34ee92ebddc17ce8bb949c15ec87ad26ec6b848982372d594323f79171",
  "calculate-scores": "9d5e83b0793bfc7768e66becba5f2c5cb47c53522f1a500b3653a8bbd9a9a3fe",
  "carteira-positivacao-snapshot": "a71428f575ae38283bca5eacb9cb031ec02892c54bb51d7c457efb39c5316a30",
  "carteira-rebuild": "8d2589d04aa1188000c918f88967030ea0b26ff54aa7f642c4f50727986eb78a",
  "cmc-snapshot-backfill": "4fba1259c114fb955430b440f65e8344c6e9bc29ca92292d094c3c4b4e601d06",
  "conciliar-pedido-portal": "c5e8f0f688486a6dcedfdc459e675e8827db712668d26c14dd197ad8db49ee6d",
  "copilot-analyze": "b3bd44e6e7e434e62ea1bb5077473af8f94fe1d84a8c4959a969e651c905317b",
  "disparar-pedidos-aprovados": "000b30c9f846a95858b7523aa8951fd69c643d5e3c805f992bd3472dc884750f",
  "dispatch-notifications": "f29d8d0a57a4ccfe8f6fd76645d6c76ad13c891460b6913f24b43ae43cdca114",
  "elevenlabs-transcribe": "6e8f1f351e78f3ab0be470147340f86ce8a3e51d644b5b757f1dd235d9e6a8e2",
  "enviar-pedido-portal-sayerlack": "348c7eca7894b7d49386605f9b5aef4d5c567288cf5d5d829101427a9e2ff1d9",
  "enviar-push": "38302707026818b24e43f4936dea80f7648c68b2c1351385c7ddd5e396bdd9d5",
  "fin-cashflow-engine": "5327584f8d1bfc36b2f150428575bc459aafd16df4fae37223a20e89425a9a5d",
  "fin-funding": "740615f4f2e2d469bc2e4930dd742e01733ec4b828f16724d3be818a1d4ac32d",
  "fin-valor-cockpit": "102121c4312beb7bcfaeb3ecd35d1121cabd00c5bdf0c6b1f2f1b2a330f37caf",
  "generate-bundle-argument": "4d1b5d967a8a4b09837853e16e89aa29e744118348bbc5790c1a404f1e966586",
  "generate-tactical-plan": "2dae750d3a3699a15c1c743aa29c9c7830038aff33f25311ca40e89b93839db1",
  "gerar-pedidos-diario": "445e8028fe4f6fa01dcdd65774e0a51121905fe1fd1c0596047c34a04aa36411",
  "identify-tool": "6b4917dfc938e0e34dc7228b290feddbde1548f7385feadc64896571f5391fd1",
  "monthly-report": "578a6e8963a0f1fd0fee9bc8fbd971892b9cdae5128894e40e74d9989cc4d7ab",
  "nvoip-calls": "5a136e22d19fbb0682c5669554bcd5912ff9ca186ecb1014b327d49946bba36b",
  "omie-analytics-sync": "a11020a5a937b0a37d2e49e0935b2f9f02599e9710104bc6e2853e2602769a0e",
  "omie-aplicar-parametros": "132174780a3175d470853b88833b8e366fcce36cfa2608ec3308bea2cb75518c",
  "omie-cliente": "fade69529ee1b7d62c65c640c98af721bf9df1030c078c93ec5c9dd55eaae92f",
  "omie-desconto-backfill": "b595ab5ff2c9ab6bccca1c6e9e5be95b8566fc9372a3691c9ced22d40ce77391",
  "omie-financeiro": "5fca4eaab0e30de52d28ec7a79eb40c337eb835364628e9b7177c72b4d8420b6",
  "omie-malha-sync": "346aaa13fa16bab1f19085e39e2461e23a5d9ca189ef9afaf25030f163ec44cb",
  "omie-nfe-recebimento": "e69f5f4fe0c581043237e33d55bef413b245f7e264ae88138f5439a1f49cdb4c",
  "omie-nfe-recebimento-sync": "a038cd71e17d02bca2e1fd12e83d97ce33aa52aca96bbf58ee239a5a93300143",
  "omie-nfe-reconcile": "844e96d1d018a01374951da346d5d3d267b12431ebab1f7b8f032d117414e3c0",
  "omie-nfe-webhook": "c2267dae835b18c9f4214a6c9621f530a384e150e345cbbcecb7b2eca0e5d319",
  "omie-sync": "94da305dad42c602aea31addd52300c8a232df289f162d62919314068982019c",
  "omie-sync-ctes-recebidos": "8516f13ecd80ccfcdb052fb19f07611d79ae7cc2cbf9e889087530e137b836c7",
  "omie-sync-estoque": "f440fc710577b62ae593256313c369833a3e2a53847d665ab35459db8d71dbd0",
  "omie-sync-metadados": "1f279e5cf99ad368d769d6bd74e295e19d1cfd1ce2ea160dcf14847bf8b8f122",
  "omie-sync-nfes-recebidas": "12f9838c4d7ccf68fb4bea2480ae79d8ebb414a1f24bff7607f474990ef213b7",
  "omie-sync-pedidos-compra": "43445982069bbdc6d4136aa24fe6969c675526a111bfb9eb24c659329c0d4feb",
  "omie-sync-sku-items": "b19805d273783fc16ac01d33272b84d775482fe76195b94fa950cbb6bb1da7c3",
  "omie-sync-status-produtos": "9ad6546de095335c66c160af39f6f91e51d006b375501575aa253766aed57a45",
  "omie-sync-vendas-items": "56a22cc97bdb12e9b60e374c18f8c4443e2dbe9159ca36067f1de9cf7adbce22",
  "omie-vendas-sync": "c402e7915b9a37ba333dabb5869187f49807c3725bc2715396973b0dc23de290",
  "omie-webhook": "08cdf40788b99bc6096e17ac7166ded10896cbf37339743ecbe46d799805f266",
  "pedido-programado-enviar": "c4e2a9ed647e5fc0096b55ddcce3e20668d0f88363eeda82e1909962d3b178a0",
  "pedido-programado-extrair": "909dc036d026d0fe9f4d1b4202f943d0d4d89fc72e650fced4f57f276c9f225f",
  "process-nfe": "e00a9048f96b00d79b8270460ccc47cef00a3b35ab3218988324df355b35f80f",
  "process-recurring-orders": "f7860da917f827ccbec9a52a069e618b6fadd18fe31491a97f1757971cbc534c",
  "recommend": "f9e38ecc222e2c38964268fa3c7cdc040f5c800f0e30462e9e0d00d9b8c58403",
  "reposicao-depara-sayerlack-auto": "d08f9e56ca21f97883c52e148c615626f9429ff4a59c34256ea0eb0cf3d3f60a",
  "sayerlack-captura-precos": "067de5a255cf9b09e7d73995f2f6986d14cf1869dbfaf7242317866b3a263e1c",
  "scoring-recalc-batch": "3899eef2be43073b93b47445f4b36f29860c29f00b6d244cd2cffd0092bce4c6",
  "sonda-relay": "6ca17c394ae9113b2561b4fa909f3962a971062dad2b32bf488b17b44bdad256",
  "sync-reprocess": "8e1fdae0b5b98632eb2f9d43f8d5d682d69dbda8c5e57cd6e29cce2c594f0dfc",
  "tactical-plans-batch": "6d882834d7cef695d9879e1498b1b4e8cc9073bc50906279982a8cc015d6a8be",
  "visit-score-recalc-batch": "fc6e87d83a3d700cf802731a40ac10098be412a11e6e95e7826efb1364114a95",
  "whatsapp-send": "dea0911c8768412918d9730b76b0f8231ef74042715a587c003dd80f00917ecf",
  "whatsapp-send-template": "c05231ef490b58717b03f8e85de333d10ed4a5d0d113ed592ad78d9ab234ed12",
};
