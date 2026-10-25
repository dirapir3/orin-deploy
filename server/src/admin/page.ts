/** HTML, CSS and JS of the admin key page. Scripts are served as files (the CSP forbids inline scripts). */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const head = (title: string, extra = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/admin/admin.css">${extra}</head>`;

export function loginPage(error: string, csrf: string, note = ''): string {
  return `${head('Orin admin · Sign in')}
<body class="login"><main class="card narrow">
<div class="brand"><span class="logo"></span><h1>Orin admin</h1></div>
<p class="muted">Owner sign-in for the Orin server settings and API keys.</p>
${note ? `<p class="note">${esc(note)}</p>` : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/admin/login" autocomplete="on">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="text" name="username" value="owner" autocomplete="username" hidden>
<label>Password<input type="password" name="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus></label>
<button type="submit" class="primary wide">Sign in</button>
</form></main></body></html>`;
}

const pwFields = (current: boolean) => `${current ? '<label>Current password<input type="password" name="current" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" required></label>' : ''}
<label>New password<input type="password" name="password" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="12" maxlength="200" required></label>
<label>Repeat new password<input type="password" name="confirm" autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false" minlength="12" maxlength="200" required></label>
<p class="muted">At least 12 characters. Capital letters count, so type it the same way each time.</p>`;

/** One-time setup link: choose the owner password. */
export function setupPage(error: string, csrf: string, token: string): string {
  return `${head('Orin admin · Set password')}
<body class="login"><main class="card narrow">
<div class="brand"><span class="logo"></span><h1>Set the owner password</h1></div>
<p class="muted">This one-time link lets you choose the password for the Orin admin site. It replaces any older admin password.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/admin/setup" autocomplete="on">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="t" value="${esc(token)}">
<input type="text" name="username" value="owner" autocomplete="username" hidden>
${pwFields(false)}
<button type="submit" class="primary wide">Save password</button>
</form></main></body></html>`;
}

/** Change the owner password while signed in. */
export function passwordPage(error: string, csrf: string, legacy: boolean): string {
  return `${head('Orin admin · Change password')}
<body class="login"><main class="card narrow">
<div class="brand"><span class="logo"></span><h1>Change password</h1></div>
${legacy ? '<p class="muted">You are still using the old admin password. Choose a new one; the old one stops working.</p>' : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/admin/password" autocomplete="on">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="text" name="username" value="owner" autocomplete="username" hidden>
${pwFields(true)}
<button type="submit" class="primary wide">Change password</button>
</form>
<p class="muted"><a href="/admin">Back to keys</a></p>
</main></body></html>`;
}

export function messagePage(title: string, text: string): string {
  return `${head(`Orin admin · ${title}`)}
<body class="login"><main class="card narrow">
<div class="brand"><span class="logo"></span><h1>${esc(title)}</h1></div>
<p>${esc(text)}</p>
</main></body></html>`;
}

export function settingsPage(csrf: string, legacyPassword = false): string {
  return `${head('Orin admin · API keys', `\n<meta name="csrf" content="${esc(csrf)}">`)}
<body>
<header class="top"><div class="brand"><span class="logo"></span><h1>Orin keys</h1></div><div class="row"><a class="small" href="/admin/password">Change password</a><button id="logout" class="ghost">Sign out</button></div></header>
<main>
${legacyPassword ? '<p class="err">You are still using the old admin password. <a href="/admin/password">Change it now</a>.</p>' : ''}
<section id="active" class="card"><p class="muted">Loading…</p></section>
<nav id="jump" class="jump"></nav>
<div id="sections"></div>
<p class="muted foot">Keys are saved to <code>server/.env</code> (owner-only) and take effect immediately. Full keys never leave the server.</p>
</main>
<div id="toast" class="toast" hidden></div>
<script src="/admin/admin.js" defer></script>
</body></html>`;
}

export const ADMIN_CSS = `
:root{--bg:#f7f3ee;--card:#fff;--ink:#1f1a24;--muted:#6f6876;--line:#e6dfd7;--acc:#7a3e6e;--acc2:#e9875f;--ok:#1d7a4a;--okbg:#e3f4ea;--err:#b3261e;--errbg:#fbe6e4;--saved:#5b5470;--savedbg:#eeeaf5}
@media (prefers-color-scheme:dark){:root{--bg:#141118;--card:#1e1a23;--ink:#f1edf4;--muted:#a59fac;--line:#332d3a;--acc:#d39bc7;--acc2:#f0a07c;--ok:#7fd6a4;--okbg:#173326;--err:#ff8a80;--errbg:#3a1a1a;--saved:#c9c1dc;--savedbg:#2a2533}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);padding-bottom:env(safe-area-inset-bottom)}
main{max-width:760px;margin:0 auto;padding:12px}
.top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px}.brand h1{font-size:19px;margin:0}
.logo{width:28px;height:28px;border-radius:50%;background:radial-gradient(circle at 35% 35%,var(--acc2),var(--acc));display:inline-block}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin:12px 0}
.narrow{max-width:420px;margin:12vh auto}
h2{font-size:18px;margin:22px 4px 4px}h3{font-size:16px;margin:0}
.muted{color:var(--muted);font-size:14px}.intro{margin:0 4px 6px}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
a{color:var(--acc)}code{font-size:13px;background:var(--savedbg);padding:1px 5px;border-radius:6px}
label{display:block;font-size:14px;color:var(--muted);margin:10px 0 4px}
input,select{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:11px 12px;min-height:44px}
input:focus,select:focus{outline:2px solid var(--acc);outline-offset:1px}
.pw{display:flex;gap:6px}.pw input{flex:1}
button{font:inherit;font-size:15px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:9px 14px;min-height:42px;cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.ghost{background:transparent}
button.danger{color:var(--err)}button.small{min-height:34px;padding:4px 10px;font-size:14px}
button:disabled{opacity:.55}.wide{width:100%;margin-top:14px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.chip{font-size:13px;border-radius:999px;padding:3px 10px;white-space:nowrap;background:var(--savedbg);color:var(--saved)}
.chip.ok{background:var(--okbg);color:var(--ok)}.chip.error{background:var(--errbg);color:var(--err)}.chip.unset{background:transparent;border:1px dashed var(--line);color:var(--muted)}
.keys{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.ks-cooling{color:#b7791f}.ks-invalid{color:#c53030}.ks-ready{color:#2f855a}
.key{display:inline-flex;align-items:center;gap:4px;font:13px ui-monospace,monospace;background:var(--savedbg);border-radius:8px;padding:2px 2px 2px 8px}
.key button{min-height:28px;padding:0 8px;border:0;background:transparent;color:var(--err)}
.msg{font-size:13px;margin-top:8px;word-break:break-word}.msg.ok{color:var(--ok)}.msg.error{color:var(--err)}
.err{color:var(--err);background:var(--errbg);padding:8px 10px;border-radius:10px}
.note{color:var(--ok);background:var(--okbg);padding:8px 10px;border-radius:10px}
.jump{display:flex;gap:6px;overflow-x:auto;padding:2px 0 4px;position:sticky;top:57px;background:var(--bg);z-index:4}
.jump a{white-space:nowrap;text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:6px 12px;font-size:14px;background:var(--card)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:14px;margin-top:8px}.kv b{font-weight:600}
.toast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:12px;font-size:14px;max-width:90vw;z-index:9}
.foot{text-align:center;margin:24px 0}
`;

export const ADMIN_JS = `
(function(){
'use strict';
var csrf=document.querySelector('meta[name=csrf]').getAttribute('content');
var root=document.getElementById('sections');
function el(tag,attrs,kids){var e=document.createElement(tag);if(attrs)for(var k in attrs){if(k==='text')e.textContent=attrs[k];else if(k==='class')e.className=attrs[k];else if(k.slice(0,2)==='on')e.addEventListener(k.slice(2),attrs[k]);else if(attrs[k]!==undefined&&attrs[k]!==null)e.setAttribute(k,attrs[k]);}(kids||[]).forEach(function(c){if(c)e.appendChild(typeof c==='string'?document.createTextNode(c):c);});return e;}
function toast(t){var x=document.getElementById('toast');x.textContent=t;x.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(function(){x.hidden=true;},3500);}
function api(path,body){return fetch('/admin/api/'+path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined}).then(function(r){if(r.status===401){location.reload();throw new Error('Signed out');}return r.json().then(function(j){if(!r.ok)throw new Error(j.message||j.error||('HTTP '+r.status));return j;});});}
var CHIP={unset:'Not set',saved:'Saved',ok:'Working',error:'Error'};
function chip(card){var s=card.status.state;var label=CHIP[s]||s;var f=card.fields.filter(function(x){return x.secret&&x.keys&&x.keys.length;})[0];if((s==='saved')&&f){label='Saved \u2022\u2022\u2022\u2022'+(f.keys[0].last4||'')+(f.keys.length>1?' +'+(f.keys.length-1):'');}return el('span',{class:'chip '+s,text:label});}
function renderActive(a){var box=document.getElementById('active');box.innerHTML='';
var chain=(a.chain||[]).map(function(c){return c.label+(c.coolingFor>0?' (resting)':'');}).join(' \u2192 ')||'none';
box.appendChild(el('div',{class:'row'},[el('h3',{text:'Now answering: '+a.providerName}),el('span',{class:'chip ok',text:a.mode==='auto'?'Auto':'Manual'})]));
var kv=el('div',{class:'kv'});[['Model',a.model],['Fast model',a.fastModel],['Fallback chain',chain],['Agent (tools)',a.agent],['Voice',a.voice],['Web search',a.search],['Code sandbox',a.sandbox],['Google redirect URL',a.googleRedirect]].forEach(function(p){kv.appendChild(el('b',{text:p[0]}));kv.appendChild(el('span',{text:p[1]||'\u2014'}));});box.appendChild(kv);}
function renderCard(card){
 var inputs={};var box=el('div',{class:'card',id:'card-'+card.id});
 var titleRow=el('div',{class:'row'},[el('h3',{text:card.title}),card.testable||card.status.state!=='unset'?chip(card):null]);box.appendChild(titleRow);
 if(card.link)box.appendChild(el('div',{class:'muted'},[el('a',{href:card.link,target:'_blank',rel:'noopener noreferrer',text:(card.linkText||'Where to get this')+' \u2197'})]));
 if(card.note)box.appendChild(el('p',{class:'muted',text:card.note}));
 var hasPool=false;
 card.fields.forEach(function(f){
  var id='f-'+f.env;var label=el('label',{for:id,text:f.label+' '},[el('code',{text:f.env})]);box.appendChild(label);
  if(f.options){var sel=el('select',{id:id});f.options.forEach(function(o){var op=el('option',{value:o,text:o});if((f.value||f.options[0])===o)op.selected=true;sel.appendChild(op);});inputs[f.env]=sel;box.appendChild(sel);}
  else if(f.secret){if(f.pool)hasPool=true;var inp=el('input',{id:id,type:'password',placeholder:f.keys.length?'Paste a new key to replace (or add below)':(f.placeholder||'Paste key'),autocomplete:'off',autocapitalize:'off',spellcheck:'false'});
   var eye=el('button',{type:'button',class:'small ghost','aria-label':'Show',text:'Show',onclick:function(){inp.type=inp.type==='password'?'text':'password';eye.textContent=inp.type==='password'?'Show':'Hide';}});
   inputs[f.env]=inp;box.appendChild(el('div',{class:'pw'},[inp,eye]));
   if(f.keys.length){var ks=el('div',{class:'keys'});f.keys.forEach(function(k,i){ks.appendChild(el('span',{class:'key ks-'+(k.state||'unused'),title:k.lastError||''},['\u2022\u2022\u2022\u2022'+(k.last4||'set')+(k.state==='cooling'?' \u00b7 resting '+Math.ceil(k.coolingFor/60000)+'m':k.state==='invalid'?' \u00b7 rejected':k.state==='ready'?' \u00b7 ok ('+k.ok+')':''),el('button',{type:'button',title:'Remove this key','aria-label':'Remove key',text:'\u2715',onclick:function(){if(!confirm('Remove this key?'))return;busy(true);api('remove',{card:card.id,env:f.env,index:i}).then(function(){toast('Key removed');load();}).catch(fail);}})]));});box.appendChild(ks);}
  } else {var t=el('input',{id:id,type:'text',value:f.value||'',placeholder:f.placeholder||'',autocomplete:'off',autocapitalize:'off',spellcheck:'false'});inputs[f.env]=t;box.appendChild(t);}
  if(f.help)box.appendChild(el('div',{class:'muted',text:f.help}));
 });
 var msg=el('div',{class:'msg '+(card.status.state==='ok'||card.status.state==='error'?card.status.state:''),text:card.status.message||''});
 var buttons=[];
 function collect(){var v={};for(var k in inputs)v[k]=inputs[k].value;return v;}
 function busy(b){buttons.forEach(function(x){x.disabled=b;});}
 function fail(e){busy(false);msg.className='msg error';msg.textContent=e.message;toast(e.message);}
 var save=el('button',{class:'primary',type:'button',text:'Save',onclick:function(){busy(true);api('save',{card:card.id,values:collect(),mode:'replace'}).then(function(r){toast(r.unchanged?'Nothing to save':'Saved \u00b7 live now');if(card.testable&&!r.unchanged){return runTest();}load();}).catch(fail);}});buttons.push(save);
 if(hasPool){buttons.push(el('button',{type:'button',text:'+ Add as extra key',onclick:function(){busy(true);api('save',{card:card.id,values:collect(),mode:'append'}).then(function(){toast('Key added to the pool');load();}).catch(fail);}}));}
 function runTest(){busy(true);msg.className='msg';msg.textContent='Testing\u2026';return api('test',{card:card.id}).then(function(r){toast(r.state==='ok'?'Working':'Test failed');load();}).catch(fail);}
 if(card.testable)buttons.push(el('button',{type:'button',text:'Test',onclick:runTest}));
 if(card.status.state!=='unset'&&card.id!=='routing'&&card.id!=='voice_routing')buttons.push(el('button',{type:'button',class:'danger',text:'Remove',onclick:function(){if(!confirm('Remove everything saved for '+card.title+'?'))return;busy(true);api('remove',{card:card.id}).then(function(){toast('Removed');load();}).catch(fail);}}));
 box.appendChild(el('div',{class:'actions'},buttons));box.appendChild(msg);return box;}
function render(state){renderActive(state.active);var y=window.scrollY;root.innerHTML='';var jump=document.getElementById('jump');jump.innerHTML='';
 state.sections.forEach(function(s){jump.appendChild(el('a',{href:'#sec-'+s.id,text:s.title}));root.appendChild(el('h2',{id:'sec-'+s.id,text:s.title}));root.appendChild(el('p',{class:'muted intro',text:s.intro}));s.cards.forEach(function(c){root.appendChild(renderCard(c));});});window.scrollTo(0,y);}
function load(){return api('state').then(render).catch(function(e){toast(e.message);});}
document.getElementById('logout').addEventListener('click',function(){api('logout',{}).finally(function(){location.reload();});});
load();
})();
`;
