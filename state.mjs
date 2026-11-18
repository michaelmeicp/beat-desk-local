export const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=20&&n<=400;
export const tempo=t=>valid(t?.chosen)?t.chosen:valid(t?.detected)?t.detected:null;
export function ordered(rows,mode) {
 const base=[...rows]; if(mode==='bpm')return base.sort((a,b)=>(tempo(a)??Infinity)-(tempo(b)??Infinity));
 if(mode!=='gap'||base.length<2)return base;
 const out=[base.shift()];while(base.length){let pick=0,min=Infinity;for(let i=0;i<base.length;i++){const a=tempo(out.at(-1)),b=tempo(base[i]),d=b===null?Infinity:a===null?0:Math.abs(a-b);if(d<min){pick=i;min=d}}out.push(base.splice(pick,1)[0])}return out;
}
export function csv(rows){const cell=x=>{let s=String(x??'');if(/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};
 return '\uFEFF'+[['順序','曲名','偵測 BPM','採用 BPM','長度（秒）','起播（秒）','筆記'],...rows.map((r,i)=>[i+1,r.name,r.detected,tempo(r),r.duration,r.cue,r.notes])].map(row=>row.map(cell).join(',')).join('\r\n');}
export function metadata(t){return Object.fromEntries(['id','sourceKey','name','detected','chosen','cue','notes','duration','status','confidence','analyzedSeconds'].map(k=>[k,t[k]]))}
