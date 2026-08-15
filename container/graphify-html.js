"use strict";

// A self-contained renderer for Graphify's clustered graph.json. Upstream's
// graph.html downloads vis-network at view time; an AgentHost artifact must be
// usable offline and must not send a customer's structural map to a CDN.

function htmlText(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function safeGraph(graph) {
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph && graph.links) ? graph.links : [];
  return {
    nodes: nodes.map((node) => ({
      id: String(node && node.id || ""),
      label: String(node && (node.label || node.id) || "Unnamed"),
      community: Number.isSafeInteger(node && node.community) ? node.community : 0,
      fileType: String(node && node.file_type || "concept"),
      sourceFile: typeof (node && node.source_file) === "string" ? node.source_file : "",
    })).filter((node) => node.id),
    links: links.map((link) => ({
      source: String(link && link.source || ""),
      target: String(link && link.target || ""),
      relation: String(link && link.relation || "related"),
      confidence: ["EXTRACTED", "INFERRED", "AMBIGUOUS"].includes(String(link && link.confidence || "").toUpperCase())
        ? String(link.confidence).toUpperCase() : "AMBIGUOUS",
    })).filter((link) => link.source && link.target),
  };
}

function renderGraphifyHtml({ graph, title, targetLabel, folderLabel, snapshot } = {}) {
  const safe = safeGraph(graph);
  const stamp = snapshot && typeof snapshot === "object" ? snapshot : {};
  const displayTitle = String(title || `${targetLabel || "Graphify"} graph`).slice(0, 160);
  const stampText = `${stamp.kind === "git" ? "Commit" : "Folder mtime"}: ${String(stamp.value || "unknown")}`;
  const payload = jsonForHtml(safe);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${htmlText(displayTitle)}</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0B0D10;color:#f6f1ea}*{box-sizing:border-box}body{margin:0;overflow:hidden;background:#0B0D10}.top{position:fixed;z-index:4;left:12px;right:12px;top:12px;padding:12px 14px;border:1px solid #ffffff24;border-radius:14px;background:#15181ddf;backdrop-filter:blur(12px)}h1{font-size:15px;margin:0 0 5px}.meta{font:11px ui-monospace,SFMono-Regular,monospace;color:#aaa49b}.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}button,input{min-height:40px;border:1px solid #ffffff25;border-radius:10px;background:#20242a;color:#f6f1ea;padding:0 10px}input{min-width:190px}.legend{position:fixed;z-index:4;right:12px;bottom:12px;padding:9px 11px;border:1px solid #ffffff20;border-radius:12px;background:#15181de8;font:11px ui-monospace,SFMono-Regular,monospace}.key{display:flex;align-items:center;gap:7px;margin:4px 0}.line{width:28px;border-top:2px solid #ff9a78}.inferred{border-top-style:dashed;opacity:.62}.ambiguous{border-top-style:dotted;opacity:.35}canvas{width:100vw;height:100vh;display:block;touch-action:none}.detail{position:fixed;z-index:4;left:12px;bottom:12px;max-width:min(430px,calc(100vw - 24px));padding:10px 12px;border:1px solid #ffffff20;border-radius:12px;background:#15181de8;font-size:12px;display:none}.detail strong{display:block;margin-bottom:4px}.detail code{color:#bfb8ae;overflow-wrap:anywhere}
</style></head><body><header class="top"><h1>${htmlText(displayTitle)}</h1><div class="meta">${htmlText(targetLabel)} · ${htmlText(folderLabel)} · ${htmlText(stampText)} · manifest ${htmlText(String(stamp.manifestSha256 || "").slice(0, 16))} · derived snapshot; source wins</div><div class="controls"><input id="search" aria-label="Find a node" placeholder="Find a node"><button id="find">Find</button><button id="reset">Reset view</button></div></header><canvas id="graph" aria-label="Interactive relationship graph"></canvas><div class="legend" aria-label="Relationship confidence legend"><div class="key"><span class="line"></span>EXTRACTED</div><div class="key"><span class="line inferred"></span>INFERRED</div><div class="key"><span class="line ambiguous"></span>AMBIGUOUS</div></div><aside class="detail" id="detail"></aside><script id="graph-data" type="application/json">${payload}</script><script>
(()=>{'use strict';const data=JSON.parse(document.getElementById('graph-data').textContent);const canvas=document.getElementById('graph'),ctx=canvas.getContext('2d'),detail=document.getElementById('detail');let dpr=1,w=1,h=1,scale=1,ox=0,oy=0,drag=null,moved=false,highlight='';const nodeById=new Map(data.nodes.map(n=>[n.id,n]));const degree=new Map(data.nodes.map(n=>[n.id,0]));for(const e of data.links){degree.set(e.source,(degree.get(e.source)||0)+1);degree.set(e.target,(degree.get(e.target)||0)+1)}const groups=new Map;for(const n of data.nodes){const k=String(n.community||0);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(n)}const ordered=[...groups.entries()].sort((a,b)=>Number(a[0])-Number(b[0]));const orbit=Math.max(220,ordered.length*42);ordered.forEach(([_,nodes],gi)=>{const ga=(Math.PI*2*gi/Math.max(1,ordered.length))-Math.PI/2,cx=Math.cos(ga)*orbit,cy=Math.sin(ga)*orbit;nodes.sort((a,b)=>(degree.get(b.id)||0)-(degree.get(a.id)||0)||a.id.localeCompare(b.id));nodes.forEach((n,i)=>{const ring=Math.floor(Math.sqrt(i)),slot=i-ring*ring,count=Math.max(1,ring*2+1),a=Math.PI*2*slot/count+gi*.31,r=ring*34;n.x=cx+Math.cos(a)*r;n.y=cy+Math.sin(a)*r})});function resize(){dpr=Math.min(2,window.devicePixelRatio||1);w=canvas.clientWidth;h=canvas.clientHeight;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);draw()}function screen(n){return{x:w/2+ox+n.x*scale,y:h/2+oy+n.y*scale}}function draw(){ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.lineWidth=1;for(const e of data.links){const a=nodeById.get(e.source),b=nodeById.get(e.target);if(!a||!b)continue;const p=screen(a),q=screen(b);ctx.beginPath();ctx.setLineDash(e.confidence==='EXTRACTED'?[]:e.confidence==='INFERRED'?[7,6]:[2,7]);ctx.strokeStyle=e.confidence==='EXTRACTED'?'rgba(255,154,120,.46)':e.confidence==='INFERRED'?'rgba(255,154,120,.24)':'rgba(255,154,120,.13)';ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke()}ctx.setLineDash([]);for(const n of data.nodes){const p=screen(n),r=n.id===highlight?8:Math.min(7,3+Math.sqrt(degree.get(n.id)||0));ctx.beginPath();ctx.fillStyle=n.id===highlight?'#fff4ee':'#ff6a3d';ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();if(n.id===highlight||scale>1.35){ctx.fillStyle='#f6f1ea';ctx.font='11px ui-monospace,monospace';ctx.fillText(n.label.slice(0,44),p.x+r+4,p.y+4)}}}function hit(x,y){let best=null,bd=15;for(const n of data.nodes){const p=screen(n),dd=Math.hypot(p.x-x,p.y-y);if(dd<bd){best=n;bd=dd}}return best}function point(ev){const r=canvas.getBoundingClientRect(),p=ev.touches?ev.touches[0]:ev;return{x:p.clientX-r.left,y:p.clientY-r.top}}canvas.addEventListener('pointerdown',ev=>{canvas.setPointerCapture(ev.pointerId);const p=point(ev),n=hit(p.x,p.y);drag={p,n,ox,oy,nx:n&&n.x,ny:n&&n.y};moved=false});canvas.addEventListener('pointermove',ev=>{if(!drag)return;const p=point(ev),dx=p.x-drag.p.x,dy=p.y-drag.p.y;moved=moved||Math.abs(dx)+Math.abs(dy)>4;if(drag.n){drag.n.x=drag.nx+dx/scale;drag.n.y=drag.ny+dy/scale}else{ox=drag.ox+dx;oy=drag.oy+dy}draw()});canvas.addEventListener('pointerup',ev=>{if(drag&&drag.n&&!moved){highlight=drag.n.id;detail.style.display='block';detail.innerHTML='<strong>'+escapeHtml(drag.n.label)+'</strong><code>'+escapeHtml(drag.n.sourceFile||drag.n.id)+'</code>';draw()}drag=null});canvas.addEventListener('wheel',ev=>{ev.preventDefault();const before=scale;scale=Math.max(.15,Math.min(5,scale*Math.exp(-ev.deltaY*.001)));const p=point(ev);ox=p.x-w/2-(p.x-w/2-ox)*scale/before;oy=p.y-h/2-(p.y-h/2-oy)*scale/before;draw()},{passive:false});function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}document.getElementById('reset').onclick=()=>{scale=1;ox=0;oy=0;highlight='';detail.style.display='none';draw()};document.getElementById('find').onclick=()=>{const q=document.getElementById('search').value.trim().toLowerCase(),n=data.nodes.find(x=>x.label.toLowerCase().includes(q)||x.id.toLowerCase().includes(q));if(n){highlight=n.id;ox=-n.x*scale;oy=-n.y*scale;draw()}};window.addEventListener('resize',resize);resize()})();
</script></body></html>`;
}

module.exports = { renderGraphifyHtml, safeGraph };
