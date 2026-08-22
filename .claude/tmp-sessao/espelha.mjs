import {readFileSync, writeFileSync} from 'fs';
const grab=(s,label)=>s.match(new RegExp(`// MIRROR-START ${label}[^\\n]*\\n([\\s\\S]*?)\\n[^\\n]*// MIRROR-END`))[1];
const put=(f,label,bloco,semExport)=>{const s=readFileSync(f,'utf8');
  const re=new RegExp(`(// MIRROR-START ${label}[^\\n]*\\n)([\\s\\S]*?)(\\n[^\\n]*// MIRROR-END)`);
  if(!re.test(s)){console.error('NAO ACHOU',label,f);process.exit(1);}
  const b=semExport?bloco.replace(/^export function /m,'function '):bloco;
  writeFileSync(f,s.replace(re,(_m,a,_b,c)=>a+b+c)); console.log('ok',label,'->',f);};
const h=readFileSync('src/lib/omie/omie-identity-snapshot.ts','utf8');
put('supabase/functions/omie-vendas-sync/index.ts','omie prova-positiva-cache',grab(h,'omie prova-positiva-cache'),true);
put('supabase/functions/omie-vendas-sync/index.ts','omie identity-snapshot-parse',grab(h,'omie identity-snapshot-parse'),true);
put('supabase/functions/omie-analytics-sync/index.ts','omie identity-snapshot-parse',grab(h,'omie identity-snapshot-parse'),true);
