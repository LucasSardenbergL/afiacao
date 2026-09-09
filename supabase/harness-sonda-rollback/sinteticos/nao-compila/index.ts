// NAO_COMPILA: o `Deno.serve(` abre uma chave que nunca fecha — `SyntaxError: Expected '}', got
// '<eof>'`. É a forma REAL encontrada em `omie-sync-nfes-recebidas@b880daeb1` (2026-04-19), um
// commit cujo `index.ts` não parseia nem com o parser do próprio Deno.
//
// O que este sintético prova: um bundle assim é dispensado (classe `NAO_COMPILA`), porque não
// compila em ambiente NENHUM — nunca bootou, nunca respondeu a request, nunca executou efeito.
// Se alguém fizer a classe exigir menos que isso, a asserção do laço fica vermelha.
import { createClient } from "npm:@supabase/supabase-js@2";
const c = createClient("u", "k");
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null);
  await (c as any).from("tabela").select("*");
  return new Response(JSON.stringify({ ok: true }));
