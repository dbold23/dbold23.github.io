// TerraMesh leaf mark, drawn and animated in code. Generated from instagram/renderer/scene.html; do not edit here.
// Usage: TerraMeshMark.play(canvas, {style:'classic'|'bio'|'geo'|'ocean'|'sky', fg:'#163F32', bg:'#F3F5EE', duration:2.55, size:null})
//        TerraMeshMark.draw(canvas, opts)  // settled leaf, no motion (use under prefers-reduced-motion)
(function(global){
const C={paper:'#F3F5EE',forest:'#163F32',lime:'#D5EE9B',night:'#0D2A2E',fog:'#C9D5D6'};
let ctx=document.createElement('canvas').getContext('2d');
const smooth=(a,b,t)=>{const x=Math.max(0,Math.min(1,(t-a)/(b-a)));return x*x*(3-2*x);};
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const lerp=(a,b,t)=>a+(b-a)*t;
const seg=(t,a,b)=>clamp((t-a)/(b-a));
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
const easeOut=t=>1-Math.pow(1-t,3);
// Brand settle spring: response 0.36 s, damping 0.86 (brand/BRAND.md)
function spring(t, response=0.36, zeta=0.86){
  if(t<=0) return 0; const w=2*Math.PI/response, wd=w*Math.sqrt(1-zeta*zeta);
  return 1-Math.exp(-zeta*w*t)*(Math.cos(wd*t)+zeta/Math.sqrt(1-zeta*zeta)*Math.sin(wd*t));
}
function rgba(hex,a){const n=parseInt(hex.slice(1),16);return `rgba(${n>>16},${n>>8&255},${n&255},${a})`}
function mix(h1,h2,t){const a=parseInt(h1.slice(1),16),b=parseInt(h2.slice(1),16);
  const r=Math.round(lerp(a>>16,b>>16,t)),g=Math.round(lerp(a>>8&255,b>>8&255,t)),bl=Math.round(lerp(a&255,b&255,t));
  return `rgb(${r},${g},${bl})`}
let rs=1; function rnd(){rs=(rs*16807)%2147483647;return (rs-1)/2147483646}
// ---------- the mark: one bold leaf, its midrib a trail that ends in a point ----------
// geometry in leaf units (about -1..1), tilted by the caller
const MARK={tip:[0.24,-1.06], base:[0,0.9],
  R:[[0.86,0.56],[0.66,-0.60]],     // right edge controls, base -> tip
  L:[[-0.30,-0.80],[-0.72,0.44]],   // left edge controls, tip -> base
  // irregular on purpose: [where on the rib, side (1 right, -1 left), reach (share of the way to the edge), veinlets [where on the vein, length, fan]]
  veins:[[0.10,1,0.80,[[0.55,0.30,1]]],[0.19,-1,0.74,[[0.38,0.22,1],[0.71,0.26,-1]]],[0.31,1,0.82,[[0.62,0.24,1]]],
         [0.43,-1,0.78,[[0.50,0.28,1]]],[0.50,1,0.76,[[0.33,0.18,-1],[0.66,0.22,1]]],[0.62,-1,0.72,[[0.58,0.20,1]]],
         [0.71,1,0.70,[]],[0.82,-1,0.62,[]]]};
// the leaf's two edges, and the true centre line between them: the midrib runs down the middle from stem to tip
const bz3=(a,b,c,d,q)=>{const u=1-q; return [u*u*u*a[0]+3*u*u*q*b[0]+3*u*q*q*c[0]+q*q*q*d[0], u*u*u*a[1]+3*u*u*q*b[1]+3*u*q*q*c[1]+q*q*q*d[1]];};
MARK.edgeR=q=>bz3(MARK.base,MARK.R[0],MARK.R[1],MARK.tip,q);
MARK.edgeL=q=>bz3(MARK.tip,MARK.L[0],MARK.L[1],MARK.base,1-q);
MARK.leaf=new Path2D(); {const P=MARK.leaf; P.moveTo(...MARK.base); P.bezierCurveTo(...MARK.R[0],...MARK.R[1],...MARK.tip); P.bezierCurveTo(...MARK.L[0],...MARK.L[1],...MARK.base); P.closePath();}
MARK.inside=(x,y)=>{ctx.save(); ctx.setTransform(1,0,0,1,0,0); const r=ctx.isPointInPath(MARK.leaf,x,y); ctx.restore(); return r;};
// centre line: midpoints of matching points on the two edges (arc-length matched), lightly smoothed
MARK.rib=(()=>{const N=400, arc=f=>{const p=[f(0)]; let L=[0]; for(let i=1;i<=N;i++){p.push(f(i/N)); L.push(L[i-1]+Math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]));} return {p,L,T:L[N]};};
  const r=arc(MARK.edgeR), l=arc(MARK.edgeL), at=(A,s)=>{let i=1; while(i<N&&A.L[i]<s*A.T) i++; const f=(s*A.T-A.L[i-1])/(A.L[i]-A.L[i-1]||1); return [lerp(A.p[i-1][0],A.p[i][0],f),lerp(A.p[i-1][1],A.p[i][1],f)];};
  const pts=[]; for(let i=0;i<=60;i++){const s=lerp(0.035,0.90,i/60); const a=at(r,s), b=at(l,s); pts.push([(a[0]+b[0])/2,(a[1]+b[1])/2]);}
  for(let it=0;it<3;it++) for(let i=1;i<pts.length-1;i++){pts[i]=[(pts[i-1][0]+2*pts[i][0]+pts[i+1][0])/4,(pts[i-1][1]+2*pts[i][1]+pts[i+1][1])/4];}
  pts[0]=[MARK.base[0]+0.01,MARK.base[1]-0.07]; return pts;})();
MARK.ribAt=q=>{const P=MARK.rib, f=clamp(q)*(P.length-1), i=Math.min(P.length-2,Math.floor(f)), u=f-i; return [lerp(P[i][0],P[i+1][0],u),lerp(P[i][1],P[i+1][1],u)];};
MARK.ribEnd=()=>MARK.rib[MARK.rib.length-1];
// how far you can go from (x,y) along (dx,dy) before leaving the leaf
MARK.reach=(x,y,dx,dy)=>{ctx.save(); ctx.setTransform(1,0,0,1,0,0); let d=0; while(d<2.5 && MARK.inside(x+dx*(d+0.01),y+dy*(d+0.01))) d+=0.01; ctx.restore(); return d;};
// each vein: leaves the rib reaching toward the tip, arches out and down, and stops short of the edge
MARK.veinGeo=MARK.veins.map(v=>{const [sx,sy]=MARK.ribAt(v[0]), [ax,ay]=MARK.ribAt(v[0]+0.01); let tx=ax-sx, ty=ay-sy; const tl=Math.hypot(tx,ty); tx/=tl; ty/=tl;
  const nx=-ty*v[1], ny=tx*v[1]; let dx=nx*0.92+tx*0.46, dy=ny*0.92+ty*0.46; const dl=Math.hypot(dx,dy); dx/=dl; dy/=dl;
  const L=MARK.reach(sx,sy,dx,dy)*v[2]; const ex=sx+dx*L, ey=sy+dy*L, cx=sx+(nx*0.42+tx*0.46)/dl*L, cy=sy+(ny*0.42+ty*0.46)/dl*L;
  const Q=(q,k)=>{const u=1-q; return k? u*u*sy+2*u*q*cy+q*q*ey : u*u*sx+2*u*q*cx+q*q*ex;};
  const lets=v[3].map(([p,len,fan])=>{const bx=Q(p,0), by=Q(p,1); let ddx=Q(p+0.02,0)-bx, ddy=Q(p+0.02,1)-by; const d2=Math.hypot(ddx,ddy); ddx/=d2; ddy/=d2;
    const ang=-0.6*fan*v[1], ca=Math.cos(ang), sa=Math.sin(ang); let rx=ddx*ca-ddy*sa, ry=ddx*sa+ddy*ca;
    let ox=rx*0.8+ddx*0.45, oy=ry*0.8+ddy*0.45; const ol=Math.hypot(ox,oy); ox/=ol; oy/=ol; const Lb=Math.min(len*1.4*L*ol, MARK.reach(bx,by,ox,oy)*0.7);
    return {bx,by,cx:bx+(rx*0.6+ddx*0.25)/ol*Lb,cy:by+(ry*0.6+ddy*0.25)/ol*Lb,ex:bx+ox*Lb,ey:by+oy*Lb};});
  return {sx,sy,cx,cy,ex,ey,L,side:v[1],Q,lets};});
function markPath(s){ctx.beginPath(); ctx.moveTo(MARK.base[0]*s,MARK.base[1]*s);
  ctx.bezierCurveTo(MARK.R[0][0]*s,MARK.R[0][1]*s,MARK.R[1][0]*s,MARK.R[1][1]*s,MARK.tip[0]*s,MARK.tip[1]*s);
  ctx.bezierCurveTo(MARK.L[0][0]*s,MARK.L[0][1]*s,MARK.L[1][0]*s,MARK.L[1][1]*s,MARK.base[0]*s,MARK.base[1]*s); ctx.closePath();}
// t: 0..1 entrance. The leaf springs up from its stem (overshoot, squash and stretch), the trail draws, the point lands.
// style: 'classic' | 'mesh' | 'trails' | 'bio' | 'geo' | 'ocean' | 'sky'
// Geology entrance: the leaf is built from rock shards (Voronoi cells of the leaf box) that drop in base-first and land hard
MARK.shards=(()=>{rs=31; const seeds=[]; for(let i=0;i<11;i++) seeds.push([lerp(-0.85,0.95,rnd()),lerp(-1.1,0.95,(i+rnd()*0.8)/11)]);
  const clipHalf=(poly,a,b)=>{ // keep the side nearer a than b
    const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2, nx=b[0]-a[0], ny=b[1]-a[1], f=p=>(p[0]-mx)*nx+(p[1]-my)*ny, out=[];
    for(let i=0;i<poly.length;i++){const p=poly[i], q=poly[(i+1)%poly.length], fp=f(p), fq=f(q); if(fp<=0) out.push(p); if((fp<0)!==(fq<0)){const u=fp/(fp-fq); out.push([lerp(p[0],q[0],u),lerp(p[1],q[1],u)]);}} return out;};
  return seeds.map((a,i)=>{ let poly=[[-1.2,-1.3],[1.2,-1.3],[1.2,1.3],[-1.2,1.3]]; seeds.forEach((b,j)=>{if(j!==i) poly=clipHalf(poly,a,b);});
    const c=poly.reduce((m,p)=>[m[0]+p[0]/poly.length,m[1]+p[1]/poly.length],[0,0]);
    return {poly,c,land:lerp(0.18,0.72,clamp((0.95-c[1])/2.05))+ (rnd()-0.5)*0.06, spin:(rnd()-0.5)*0.9, dx:(rnd()-0.5)*0.5};});})();
function drawMark(cx,cy,s,t=1,{fg=C.lime,bg=C.forest,tilt=0.32,veins=true,style='classic',accent=null,anim=null,bold=0}={}){
  // small sizes keep bold veins so the mark always reads as a leaf, never a bean; detail styles fall back to classic
  const small=Math.max(bold,1-smooth(40,130,s));
  const vA=veins?1:0, vlA=bold?0:smooth(110,170,s);
  if(small>0.5 && !bold && style!=='classic' && style!=='bio') style='classic';
  veins=vA>0.01; const ac=accent||bg; const an=anim||style;
  const BA=ctx.globalAlpha; ctx.save(); ctx.translate(cx,cy); ctx.rotate(tilt);
  const g=seg(t,0,0.55); if(g<=0){ctx.restore();return;}
  let level=null, shards=false;
  if(an==='ocean'){ // fluid: a slow swell lifts the leaf, and it fills from the stem up like a rising tide with a moving surface
    const e=ease(g); ctx.translate(0,(1-e)*0.25*s); ctx.rotate(0.06*Math.sin(g*Math.PI*3)*(1-g));
    const sw=1+0.05*Math.sin(g*Math.PI*2.5)*(1-g); ctx.translate(0,0.9*s); ctx.scale(lerp(0.9,1,e)*sw,lerp(0.9,1,e)/sw); ctx.translate(0,-0.9*s);
    level=lerp(1.05,-1.3,ease(seg(g,0,0.95)));
  } else if(an==='sky'){ // airy: drifts down out of the air, swaying like a falling leaf, soft and out of focus until it settles
    const e=easeOut(g), w=1-e; ctx.globalAlpha=BA*smooth(0,0.45,g);
    ctx.translate(Math.sin(g*Math.PI*2.2)*0.32*s*w, -w*1.1*s); ctx.rotate(0.35*Math.sin(g*Math.PI*2.6)*w); const k=lerp(0.82,1,e); ctx.scale(k,k);
    if(w>0.02) ctx.filter=`blur(${(w*s*0.05).toFixed(2)}px)`;
  } else if(an==='geo'){ // chunky: rock shards fall and land hard, base first; each landing shakes the leaf a little
    shards=true; let sh=0; MARK.shards.forEach((p,i)=>{const d=g-p.land; if(d>0) sh+=Math.exp(-d*40)*Math.sin(d*90+i);}); ctx.translate(sh*0.025*s, Math.abs(sh)*0.012*s);
  } else { const k=spring(g*0.9,0.42,0.42); const sq=1+(k-1)*0.5;
    ctx.translate(0,0.9*s); ctx.scale(clamp(k,0,2)/Math.max(0.35,sq),clamp(k,0,2)*sq); ctx.rotate(0.12*Math.sin(g*Math.PI*2.2)*(1-g)); ctx.translate(0,-0.9*s); }
  // stem
  ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle=fg; ctx.lineWidth=s*0.085; ctx.beginPath(); ctx.moveTo(0,0.86*s); ctx.quadraticCurveTo(-0.02*s,1.08*s,-0.14*s,1.2*s); ctx.stroke();
  const tideClip=()=>{ if(level===null) return; ctx.beginPath(); ctx.moveTo(-1.3*s,1.4*s); const A=0.07*(1-smooth(0.8,1,g));
    for(let x=-1.3;x<=1.31;x+=0.05) ctx.lineTo(x*s,(level+A*Math.sin(x*7-g*22)+A*0.5*Math.sin(x*13+g*15))*s); ctx.lineTo(1.3*s,1.4*s); ctx.closePath(); ctx.clip(); };
  ctx.fillStyle=fg;
  if(shards && g>=0.999) shards=false;   // settled: one clean fill, no seams between the shards
  if(shards){ MARK.shards.forEach(p=>{ const d=seg(g,p.land-0.2,p.land); if(d<=0) return; const f=d*d; // falling under gravity, then stopped dead
      ctx.save(); ctx.translate(p.dx*(1-f)*s, -(1-f)*1.6*s); ctx.translate(p.c[0]*s,p.c[1]*s); ctx.rotate(p.spin*(1-f)); ctx.translate(-p.c[0]*s,-p.c[1]*s);
      ctx.beginPath(); p.poly.forEach((q,j)=>j?ctx.lineTo(q[0]*s,q[1]*s):ctx.moveTo(q[0]*s,q[1]*s)); ctx.closePath(); ctx.clip(); markPath(s); ctx.fill(); ctx.restore(); });
    const ck=1-smooth(0.75,1,g); if(ck>0){ ctx.save(); markPath(s); ctx.clip(); ctx.globalAlpha=BA*ck; ctx.strokeStyle=bg; ctx.lineWidth=s*0.018; // the cracks close up once it has settled
      MARK.shards.forEach(p=>{ if(g<p.land) return; ctx.beginPath(); p.poly.forEach((q,j)=>j?ctx.lineTo(q[0]*s,q[1]*s):ctx.moveTo(q[0]*s,q[1]*s)); ctx.closePath(); ctx.stroke(); }); ctx.restore(); ctx.globalAlpha=BA; }
  } else { ctx.save(); tideClip(); markPath(s); ctx.fill(); ctx.restore(); }
  const tr=easeOut(seg(t,0.30,0.62)); ctx.strokeStyle=bg; ctx.fillStyle=bg;
  ctx.save(); markPath(s); ctx.clip(); tideClip();
  const vw=lerp(1,2.1,small); const lw0=ctx.lineWidth; const setLW=ctx.__proto__.__lookupSetter__('lineWidth'), getLW=ctx.__proto__.__lookupGetter__('lineWidth');
  if(veins){ if(vw!==1) Object.defineProperty(ctx,'lineWidth',{configurable:true,get(){return getLW.call(ctx);},set(v){setLW.call(ctx,v*vw);}});
    try{ MARK_STYLES[style](s,t,{BA,vA,vlA,bg,fg,ac}); } finally { delete ctx.lineWidth; } }
  ctx.globalAlpha=BA;
  // the trail (midrib), down the middle of the leaf from stem to tip
  if(tr>0){ctx.strokeStyle=bg; ctx.lineWidth=s*lerp(0.06,0.1,small); ctx.beginPath(); const P=MARK.rib, n=Math.max(1,Math.round((P.length-1)*tr)); for(let i=0;i<=n;i++){i?ctx.lineTo(P[i][0]*s,P[i][1]*s):ctx.moveTo(P[i][0]*s,P[i][1]*s);} ctx.stroke();}
  ctx.restore();
  // the point at the end of the trail: an observation
  const tp=seg(t,0.55,0.75); if(tp>0){const r=spring(tp*0.9,0.42,0.45)*0.085*s, e=MARK.ribEnd(); ctx.fillStyle=bg; ctx.beginPath(); ctx.arc(e[0]*s,e[1]*s,Math.max(0,r),0,Math.PI*2); ctx.fill();}
  ctx.filter='none'; ctx.restore(); ctx.globalAlpha=BA;
}
function MARK_TIPS(s,t,o,shape){ MARK.veinGeo.forEach((G,i)=>{ const tp=seg(t,0.66+i*0.04,0.8+i*0.04); if(tp<=0) return; const k=spring(tp,0.42,0.45);
    const one=(x,y,bx,by,r,a)=>{ let dx=x-bx, dy=y-by; const d=Math.hypot(dx,dy)||1; ctx.globalAlpha=a; shape(x,y,Math.max(0,r*k),dx/d,dy/d); };
    one(G.ex,G.ey,G.Q(0.9,0),G.Q(0.9,1),0.034,o.BA*o.vA); G.lets.forEach(b=>one(b.ex,b.ey,b.cx,b.cy,0.022,o.BA*o.vA*o.vlA)); }); }
const veinT=(t,i)=>ease(seg(t,0.40+i*0.05,0.62+i*0.05));
function strokeVein(G,s,tv){ctx.beginPath(); const N=20; for(let j=0;j<=N*tv;j++){const q=j/N; const x=G.Q(q,0), y=G.Q(q,1); j?ctx.lineTo(x*s,y*s):ctx.moveTo(x*s,y*s);} ctx.stroke();}

const MARK_STYLES={
  classic(s,t,o){ MARK.veinGeo.forEach((G,i)=>{const tv=veinT(t,i); if(tv<=0) return; ctx.globalAlpha=o.BA*o.vA; ctx.lineWidth=s*0.028; strokeVein(G,s,tv);
      if(o.vlA>0.01) G.lets.forEach((b,m)=>{const tb=ease(seg(t,0.62+i*0.05+m*0.04,0.80+i*0.05+m*0.04)); if(tb<=0) return; ctx.globalAlpha=o.BA*o.vA*o.vlA; ctx.lineWidth=s*0.016;
        ctx.beginPath(); ctx.moveTo(b.bx*s,b.by*s); ctx.quadraticCurveTo(lerp(b.bx,b.cx,tb)*s,lerp(b.by,b.cy,tb)*s,lerp(b.bx,b.ex,tb)*s,lerp(b.by,b.ey,tb)*s); ctx.stroke();}); }); },
  // Mesh: the real veins, with the spaces between their tips joined into a fine scan mesh near the edge (like a leaf's own loop veins)
  mesh(s,t,o){ MARK_STYLES.classic(s,t,o); const tm=smooth(0.7,0.98,t); if(tm<=0) return; const P=[];
    MARK.veinGeo.forEach(G=>{ P.push([G.ex,G.ey,G.side]); G.lets.forEach(b=>P.push([b.ex,b.ey,G.side])); });
    ctx.globalAlpha=o.BA*o.vA*tm*0.9; ctx.lineWidth=s*0.012; ctx.beginPath();
    P.forEach((p,i)=>{ P.map((q,j)=>[Math.hypot(q[0]-p[0],q[1]-p[1]),j]).filter(([d,j])=>j>i&&P[j][2]==p[2]&&d<0.34).sort((a,b)=>a[0]-b[0]).slice(0,2).forEach(([d,j])=>{ctx.moveTo(p[0]*s,p[1]*s); ctx.lineTo(P[j][0]*s,P[j][1]*s);}); }); ctx.stroke();
    ctx.globalAlpha=o.BA*o.vA*tm; P.forEach(p=>{ctx.beginPath(); ctx.arc(p[0]*s,p[1]*s,s*0.017,0,7); ctx.fill();}); },
  // side trails: each vein is a path off the main trail and ends at a find (dot) or an open ask (ring)
  trails(s,t,o){ MARK.veinGeo.forEach((G,i)=>{const tv=veinT(t,i); if(tv<=0) return; ctx.globalAlpha=o.BA*o.vA; ctx.lineWidth=s*0.022; ctx.setLineDash([s*0.05,s*0.035]); strokeVein(G,s,tv); ctx.setLineDash([]);
      const tp=seg(t,0.62+i*0.04,0.75+i*0.04); if(tp<=0) return; const r=spring(tp,0.42,0.45)*s*0.045;
      if(i%3==1){ctx.lineWidth=s*0.018; ctx.beginPath(); ctx.arc(G.ex*s,G.ey*s,Math.max(0,r),0,7); ctx.stroke();} else {ctx.beginPath(); ctx.arc(G.ex*s,G.ey*s,Math.max(0,r*0.8),0,7); ctx.fill();}}); },
  // Biodiversity: veins and veinlets end in observations, like a branching life list
  bio(s,t,o){ MARK_STYLES.classic(s,t,o); MARK.veinGeo.forEach((G,i)=>{ const tp=seg(t,0.66+i*0.04,0.8+i*0.04); if(tp<=0) return; const r=spring(tp,0.42,0.45)*s;
      ctx.globalAlpha=o.BA*o.vA; ctx.beginPath(); ctx.arc(G.ex*s,G.ey*s,Math.max(0,r*0.034),0,7); ctx.fill();
      G.lets.forEach(b=>{ctx.globalAlpha=o.BA*o.vA*o.vlA; ctx.beginPath(); ctx.arc(b.ex*s,b.ey*s,Math.max(0,r*0.022),0,7); ctx.fill();}); }); },
  // per mission: always the real leaf veins; only the tips change, the way Biodiversity's end in observations
  // Geology: the veins are gullies. Water runs off the slopes into the trail, tributaries branching out and carving the land
  geo(s,t,o){ rs=77; const taper=(pts,w0,w1,tv)=>{ const n=Math.max(1,Math.floor((pts.length-1)*tv)); for(let i=0;i<n;i++){ ctx.lineWidth=s*lerp(w0,w1,i/(pts.length-1)); ctx.beginPath(); ctx.moveTo(pts[i][0]*s,pts[i][1]*s); ctx.lineTo(pts[i+1][0]*s,pts[i+1][1]*s); ctx.stroke(); } };
    const channel=(x,y,dx,dy,len,wig,N)=>{ const pts=[[x,y]]; let ax=dx, ay=dy; for(let i=1;i<=N;i++){ const a=(rnd()-0.5)*wig; const c=Math.cos(a), sn=Math.sin(a); [ax,ay]=[ax*c-ay*sn, ax*sn+ay*c]; const st=len/N; const nx=x+ax*st, ny=y+ay*st; if(!MARK.inside(nx,ny)) break; x=nx; y=ny; pts.push([x,y]); } return pts; };
    MARK.veinGeo.forEach((G,i)=>{ const tv=veinT(t,i); if(tv<=0) return; ctx.globalAlpha=o.BA*o.vA;
      const main=[]; for(let j=0;j<=24;j++){ const q=j/24; const w=0.012*Math.sin(q*Math.PI*2.5+i)*q; const ex=G.Q(Math.min(1,q+0.02),0)-G.Q(q,0), ey=G.Q(Math.min(1,q+0.02),1)-G.Q(q,1), el=Math.hypot(ex,ey)||1; main.push([G.Q(q,0)-ey/el*w,G.Q(q,1)+ex/el*w]); } taper(main,0.034,0.010,tv);
      if(o.vlA<=0.01) return; (G.L>0.3?[0.3,0.5,0.68,0.84]:[0.35,0.62]).forEach((p,m)=>{ const tb=ease(seg(t,0.6+i*0.04+m*0.03,0.85+i*0.04+m*0.03)); if(tb<=0||p>tv) return; ctx.globalAlpha=o.BA*o.vA*o.vlA;
        const bx=G.Q(p,0), by=G.Q(p,1); let dx=G.Q(p+0.02,0)-bx, dy=G.Q(p+0.02,1)-by; const dl=Math.hypot(dx,dy); dx/=dl; dy/=dl; const sd=(m%2?1:-1), an=0.75*sd, c=Math.cos(an), sn=Math.sin(an);
        const tdx=dx*c-dy*sn, tdy=dx*sn+dy*c; const trib=channel(bx,by,tdx,tdy,G.L*0.42*(1-p*0.3),0.28,8); taper(trib,0.016,0.006,tb);
        if(trib.length>4&&G.L>0.3){ const k=trib[Math.floor(trib.length/2)]; const an2=-0.7*sd; const sub=channel(k[0],k[1],tdx*Math.cos(an2)-tdy*Math.sin(an2),tdx*Math.sin(an2)+tdy*Math.cos(an2),G.L*0.18,0.3,4); taper(sub,0.009,0.004,tb); } }); }); },
  // Ocean: the real veins, each one rising into a breaking-wave crest near its end: the lip thickens, curls over toward the leaf tip and throws a little spray
  ocean(s,t,o){ const [rx0,ry0]=MARK.ribAt(0.2), [rx1,ry1]=MARK.ribAt(0.8), Q0=0.66;
    MARK.veinGeo.forEach((G,i)=>{ const tv=veinT(t,i); if(tv<=0) return; ctx.globalAlpha=o.BA*o.vA; ctx.lineWidth=s*0.028;
      ctx.beginPath(); const N0=20; for(let j=0;j<=N0*Math.min(tv,Q0);j++){const q=j/N0; j?ctx.lineTo(G.Q(q,0)*s,G.Q(q,1)*s):ctx.moveTo(G.Q(q,0)*s,G.Q(q,1)*s);} ctx.stroke();
      if(o.vlA>0.01) G.lets.forEach((b,m)=>{ const tb=ease(seg(t,0.62+i*0.05+m*0.04,0.80+i*0.05+m*0.04)); if(tb<=0) return; ctx.globalAlpha=o.BA*o.vA*o.vlA; ctx.lineWidth=s*0.016;
        ctx.beginPath(); ctx.moveTo(b.bx*s,b.by*s); ctx.quadraticCurveTo(lerp(b.bx,b.cx,tb)*s,lerp(b.by,b.cy,tb)*s,lerp(b.bx,b.ex,tb)*s,lerp(b.by,b.ey,tb)*s); ctx.stroke();});
      const tc=ease(seg(t,0.62+i*0.04,0.86+i*0.04)); if(tc<=0) return; ctx.globalAlpha=o.BA*o.vA;
      // straight run along the vein, then the lip rises and curls over in a widening-then-tightening arc (a wave seen side-on)
      const x0=G.Q(Q0,0), y0=G.Q(Q0,1); let hx=G.Q(Q0+0.02,0)-x0, hy=G.Q(Q0+0.02,1)-y0; const hl=Math.hypot(hx,hy); hx/=hl; hy/=hl;
      let ux=-hy, uy=hx; if(ux*(rx1-rx0)+uy*(ry1-ry0)<0){ux=-ux; uy=-uy;}
      const R=Math.min(0.085,G.L*0.24); const cx=x0+hx*R*0.35+ux*R, cy=y0+hy*R*0.35+uy*R; const a0=Math.atan2(y0-cy,x0-cx);
      const sgn=((hx*uy-hy*ux)>0)?1:-1, sweep=Math.PI*1.55*tc, N=40; let prev=[x0,y0];
      for(let k=1;k<=N;k++){ const f=k/N; const a=a0+sgn*sweep*f, r=R*(1.05-0.62*f*f); const x=cx+Math.cos(a)*r*(1+0.25*Math.sin(Math.PI*f)), y=cy+Math.sin(a)*r*(1+0.25*Math.sin(Math.PI*f));
        const w=0.026*(1+1.3*Math.sin(Math.PI*Math.min(1,f*1.25)))*(1-0.9*f*f); ctx.lineWidth=s*Math.max(0.004,w); ctx.beginPath(); ctx.moveTo(prev[0]*s,prev[1]*s); ctx.lineTo(x*s,y*s); ctx.stroke(); prev=[x,y]; }
      if(tc>0.95){ const ta=a0+sgn*Math.PI*0.95; [[1.35,0.012],[1.6,0.009],[1.85,0.006]].forEach(([k,r],m)=>{ const aa=ta-sgn*0.25*m; const sx=cx+Math.cos(aa)*R*k, sy=cy+Math.sin(aa)*R*k; if(MARK.inside(sx,sy)){ctx.beginPath(); ctx.arc(sx*s,sy*s,r*s,0,7); ctx.fill();} }); } }); },
  // Sky: the veins carry clouds; each vein ends in a small cloud, and the veinlets in puffs
  sky(s,t,o){ MARK_STYLES.classic(s,t,{...o,vlA:0}); const cloud=(x,y,r)=>{ const ux=-0.315, uy=-0.949, rx=0.949, ry=0.315; ctx.beginPath();   // upright on screen, flat bottom
      [[-0.95,0.42,0.5],[-0.25,0.75,0.68],[0.55,0.85,0.62],[1.1,0.45,0.45]].forEach(([u,v,k])=>{ const cx=x+(rx*u+ux*v)*r, cy=y+(ry*u+uy*v)*r; ctx.moveTo((cx+k*r)*s,cy*s); ctx.arc(cx*s,cy*s,k*r*s,0,7); });
      ctx.fill(); const bl=[x-rx*1.45*r,y-ry*1.45*r], br=[x+rx*1.55*r,y+ry*1.55*r]; ctx.beginPath(); ctx.moveTo(bl[0]*s,bl[1]*s); ctx.lineTo(br[0]*s,br[1]*s); ctx.lineTo((br[0]+ux*0.45*r)*s,(br[1]+uy*0.45*r)*s); ctx.lineTo((bl[0]+ux*0.45*r)*s,(bl[1]+uy*0.45*r)*s); ctx.fill(); };
    MARK.veinGeo.forEach((G,i)=>{ const tp=seg(t,0.66+i*0.04,0.8+i*0.04); if(tp<=0) return; const k=spring(tp,0.42,0.45); ctx.globalAlpha=o.BA*o.vA;
      let dx=G.ex-G.Q(0.9,0), dy=G.ey-G.Q(0.9,1); const dl=Math.hypot(dx,dy); dx/=dl; dy/=dl; const r=Math.min(0.085,G.L*0.2)*k; cloud(G.ex,G.ey+0.0,r);
      G.lets.forEach(b=>{ ctx.globalAlpha=o.BA*o.vA*o.vlA; ctx.lineWidth=s*0.014; ctx.beginPath(); ctx.moveTo(b.bx*s,b.by*s); ctx.quadraticCurveTo(b.cx*s,b.cy*s,b.ex*s,b.ey*s); ctx.stroke();
        let ex=b.ex-b.cx, ey=b.ey-b.cy; const el=Math.hypot(ex,ey)||1;  }); }); },
};
function setup(cv,o){ const dpr=global.devicePixelRatio||1, r=cv.getBoundingClientRect(); const w=Math.round((r.width||cv.width)*dpr), h=Math.round((r.height||cv.height)*dpr);
  if(cv.width!==w||cv.height!==h){cv.width=w; cv.height=h;} const s=o.size?o.size*dpr:Math.min(w,h)*0.36; return {w,h,s,cx:w/2+0.067*s,cy:h/2-0.233*s}; }
function paint(cv,t,o){ const g=setup(cv,o); ctx=cv.getContext('2d'); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,g.w,g.h); ctx.globalAlpha=1;
  drawMark(g.cx,g.cy,g.s,t,{fg:o.fg||C.forest,bg:o.bg||C.paper,style:o.style||'classic',bold:o.bold||0}); }
const reduce=()=>global.matchMedia&&global.matchMedia('(prefers-reduced-motion: reduce)').matches;
global.TerraMeshMark={
  draw(cv,o={}){ paint(cv,1,o); },
  play(cv,o={}){ if(reduce()) return paint(cv,1,o); const D=(o.duration||2.55)*1000, t0=performance.now();
    return new Promise(res=>{ const step=now=>{ const t=Math.min(1,(now-t0)/D); paint(cv,t,o); t<1?requestAnimationFrame(step):res(); }; requestAnimationFrame(step); }); }
};
})(window);
