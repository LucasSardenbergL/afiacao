import { removerComentarios } from "../src/lib/gates/limpeza-fonte";
import { readFileSync } from "node:fs";

const real = readFileSync(new URL("../supabase/functions/recommend/index.ts", import.meta.url), "utf8");
// As TRÊS asserções do gate, copiadas VERBATIM de edge-money-path-invariants.test.ts
const PIN   = /clusterSize\s*=\s*Math\.max\(\s*observados\s*\?\?\s*0\s*,\s*1\s*\)/;
const VETO  = /clusterSize\s*=\s*Math\.max\(\s*denominador\s*,/;
const VETO2 = /clusterSize\s*=\s*Math\.max\(\s*(clusterUserIds|usuariosAmostrados)\.length/;

function avalia(fonte: string) {
  const limpo = removerComentarios(fonte);
  return { pin: PIN.test(limpo), veto: VETO.test(limpo), veto2: VETO2.test(limpo) };
}
const ok = (b: boolean) => (b ? "SIM" : "nao");

// 1) COMO ESTÁ: o gate tem de aprovar
const a = avalia(real);
console.log(`REAL       pin=${ok(a.pin)} vetoPop=${ok(a.veto)} vetoAmostra=${ok(a.veto2)}`);

// 2) SABOTAGEM 1 (em MEMÓRIA): volta para a população
const sab1 = real.replace("Math.max(observados ?? 0, 1)", "Math.max(denominador, 1)");
if (sab1 === real) { console.log("ERRO: sabotagem 1 nao aplicou — o teste seria teatro"); process.exit(9); }
const b = avalia(sab1);
console.log(`SABOTADO-1 pin=${ok(b.pin)} vetoPop=${ok(b.veto)} vetoAmostra=${ok(b.veto2)}`);

// 3) SABOTAGEM 2: volta para amostra local
const sab2 = real.replace("Math.max(observados ?? 0, 1)", "Math.max(usuariosAmostrados.length, 1)");
if (sab2 === real) { console.log("ERRO: sabotagem 2 nao aplicou"); process.exit(9); }
const c = avalia(sab2);
console.log(`SABOTADO-2 pin=${ok(c.pin)} vetoPop=${ok(c.veto)} vetoAmostra=${ok(c.veto2)}`);

// VEREDITO: o gate so tem dente se APROVA o real e REPROVA as duas sabotagens
const passaReal = a.pin && !a.veto && !a.veto2;
const pegaSab1  = !b.pin || b.veto;
const pegaSab2  = !c.pin || c.veto2;
console.log(`\nVEREDITO aprovaReal=${ok(passaReal)} pegaSabotagem1=${ok(pegaSab1)} pegaSabotagem2=${ok(pegaSab2)}`);
process.exit(passaReal && pegaSab1 && pegaSab2 ? 0 : 1);
