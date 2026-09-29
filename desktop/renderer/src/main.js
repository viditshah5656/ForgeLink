import './style.css';

const bridge = window.localFiles;
const app = document.querySelector('#app');
const API = 'http://127.0.0.1:24025/dashboard/api';

const NAV = [
  ['overview','Overview','home'],['access','Access & Security','shield'],['tools','Tool Control','grid'],
  ['system','System Control','monitor'],['terminal','Terminal','terminal'],['workspace','Workspace','folder'],['agents','Agent Runtime','agents'],
  ['events','Live Events','activity'],['logs','Logs & Diagnostics','file'],['safety','Safety','shield'],['settings','System Settings','settings']
];

const PAGE_INFO = {
  overview:'Status, activity and resource usage',
  access:'Manage approved files, folders and permissions',
  tools:'Browse and inspect the MCP capability catalog',
  system:'Native Windows, macOS and Linux visibility with owner-controlled gates',
  terminal:'Command execution and background jobs',
  workspace:'Browse files inside approved workspaces',
  agents:'Engineering workflows, workers and swarms',
  events:'Recent runtime activity and event history',
  logs:'Service health, logs and diagnostics',
  safety:'Headless safety policy, circuit breaker and blocked actions',
  settings:'Connections, startup behavior and local policies'
};

function icon(name){
  var paths={
    home:'<path d="M3.5 10.8 12 4l8.5 6.8"/><path d="M5.5 9.7V20h13V9.7"/><path d="M9.5 20v-6h5v6"/>',
    shield:'<path d="M12 3 5 6v5c0 4.6 2.8 8.2 7 10 4.2-1.8 7-5.4 7-10V6l-7-3Z"/><path d="m9.5 12 1.7 1.7 3.5-3.8"/>',
    grid:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    monitor:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    terminal:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    folder:'<path d="M3 7.5h7l2-2h9v13.5H3z"/>',
    agents:'<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3.5 20c.4-3.7 2.3-5.5 5.5-5.5s5.1 1.8 5.5 5.5M14.5 15.5c3.6-.5 5.7 1 6 4.5"/>',
    activity:'<path d="M3 12h4l2.2-5 4.2 10 2.2-5H21"/>',
    file:'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19 12a7.8 7.8 0 0 0-.1-1l2-1.5-2-3.4-2.5 1a8.4 8.4 0 0 0-1.8-1L14.3 3h-4.1L9.7 6a8.4 8.4 0 0 0-1.8 1L5.4 6l-2 3.4 2 1.5a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.5-1a8.4 8.4 0 0 0 1.8 1l.5 3h4.1l.5-3a8.4 8.4 0 0 0 1.8-1l2.5 1 2-3.4-2-1.5a7.8 7.8 0 0 0 .1-1Z"/>',
    refresh:'<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 1-2-5"/>',
    minimize:'<path d="M5 12h14"/>',
    maximize:'<rect x="5" y="5" width="14" height="14" rx="1"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    check:'<path d="m6.5 12.5 3.4 3.4 7.6-8"/>',
    link:'<path d="M10.4 13.6 8.8 15.2a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0"/><path d="m13.6 10.4 1.6-1.6a3.5 3.5 0 1 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"/><path d="m9 15 6-6"/>',
    cube:'<path d="m12 3 7.5 4.3v9.4L12 21l-7.5-4.3V7.3z"/><path d="m4.8 7.5 7.2 4.2 7.2-4.2M12 11.7V21"/>',
    database:'<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    clock:'<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    pulse:'<path d="M3 12h4l2-6 4 12 2.5-6H21"/>',
    list:'<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    lightning:'<path d="m13 2-8 11h6l-1 9 9-12h-6z"/>',
    cpu:'<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 2v3M12 2v3M15 2v3M9 19v3M12 19v3M15 19v3M2 9h3M2 12h3M2 15h3M19 9h3M19 12h3M19 15h3"/>',
    memory:'<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 10v4M11 10v4M14 10v4M17 10v4M7 4v3M10 4v3M13 4v3M16 4v3M7 17v3M10 17v3M13 17v3M16 17v3"/>',
    id:'<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true">'+(paths[name]||paths.grid)+'</svg>';
}

const state = {
  page:'overview',runtime:null,server:null,telemetry:null,tools:[],events:[],logs:[],
  terminalMode:'off',systemControlMode:'off',roots:[],readOnlyRoots:[],search:'',config:null,
  connectionEditor:null,pendingRuntimeStart:false,notice:null,browserPath:null,maintenance:null,
  browserItems:[],browserSkipped:0,selectedFile:null,selectedTool:null,lastToolFetch:0,
  browserScrollByPath:{},browserPreviewScrollTop:0,
  apiOnline:false,apiError:null,apiLastSuccessAt:null,safetyEvents:[],permissions:null,
  automationMode:'off',headlessBackground:false
};

function esc(v){return String(v==null?'':v).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function bytes(n){if(!n)return '0 B';var i=0,v=Number(n),u=['B','KB','MB','GB','TB'];while(v>=1024&&i<4){v/=1024;i++}return v.toFixed(i?1:0)+' '+u[i]}
function healthAge(iso){var t=iso?Date.parse(iso):NaN;if(!Number.isFinite(t))return '—';var ms=Math.max(0,Date.now()-t);return ms<1000?'<1s':Math.floor(ms/1000)+'s'}
function fmtTime(iso){if(!iso)return '—';try{return new Date(iso).toLocaleTimeString()}catch(_){return '—'}}
function uptime(s){s=Math.floor(s||0);var a=[];if(s>=86400)a.push(Math.floor(s/86400)+'d');if(s>=3600)a.push(Math.floor(s%86400/3600)+'h');a.push(Math.floor(s%3600/60)+'m');return a.join(' ')}
function stat(label,value,sub,cls){var compact=String(value==null?'':value).length>9?' compact':'';return '<div class="stat '+(cls||'')+compact+'"><small>'+label+'</small><strong>'+esc(value)+'</strong><span>'+esc(sub)+'</span></div>'}
function kv(label,value,mono){return '<div class="kv"><span>'+esc(label)+'</span><b class="'+(mono?'mono':'')+'">'+esc(value)+'</b></div>'}
function meter(label,value,text){var w=value==null?0:Math.max(0,Math.min(100,Number(value)));return '<div class="meter-block"><div><span>'+label+'</span><b>'+esc(text)+'</b></div><div class="meter"><i style="width:'+w+'%"></i></div></div>'}
function healthItem(label,good,value,bad){return '<div class="health-item '+(good?'good':'bad')+'"><i></i><small>'+esc(label)+'</small><strong>'+esc(good?value:bad)+'</strong></div>'}
function eventRow(e){
  return `<div class="event-row"><b>#${esc(e.id||'—')}</b><div><strong>${esc(e.type||e.action||'event')}</strong><small>${esc(e.message||JSON.stringify(e.data||{}))}</small></div><time>${esc(fmtTime(e.timestamp||e.at))}</time></div>`;
}
function overviewKpi(iconName,label,value,sub,tone,navTarget){
  return '<button class="overview-kpi '+esc(tone||'blue')+'"'+(navTarget?' data-nav="'+esc(navTarget)+'"':'')+'><span class="overview-kpi-icon">'+icon(iconName)+'</span><span class="overview-kpi-copy"><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong><em>'+esc(sub)+'</em></span><span class="overview-kpi-arrow">›</span></button>';
}
function overviewInfoRow(iconName,label,value,mono){
  return '<div class="overview-info-row"><span>'+icon(iconName)+'</span><small>'+esc(label)+'</small><b class="'+(mono?'mono':'')+'">'+esc(value)+'</b></div>';
}
function overviewActivityRow(e,index){
  var message=e&&e.message?e.message:(e&&e.type?e.type:(e&&e.action?e.action:'ForgeLink activity'));
  var when=healthAge(e&&(e.timestamp||e.at));
  return '<div class="overview-activity-row"><i class="'+(index===2?'blue':'green')+'"></i><strong>'+esc(message)+'</strong><time>'+esc(when==='—'?'—':when+' ago')+'</time></div>';
}
function overviewQuickAction(iconName,label,target){
  return '<button class="overview-action" data-nav="'+esc(target)+'"><span>'+icon(iconName)+'</span><strong>'+esc(label)+'</strong><b>›</b></button>';
}

async function api(path,opt){
 opt=opt||{};
 var headers=Object.assign({'accept':'application/json'},opt.headers||{});
 if((opt.method||'GET').toUpperCase()!=='GET'){
   try{var local=await bridge.localControlToken();if(local&&local.token)headers['x-forgelink-local-control']=local.token}catch(_){}
 }
 if(opt.body!=null&&!headers['content-type']&&!headers['Content-Type']) headers['content-type']='application/json';
 var r;
 try{r=await fetch(API+path,Object.assign({},opt,{headers:headers}));}
 catch(e){throw Error('Dashboard connection failed: '+(e&&e.message?e.message:'network error'));}
 var d=await r.json().catch(function(){return{}});
 if(!r.ok)throw Error(d.error||('Request failed ('+r.status+')'));
 return d;
}

function userIsEditing(){
 var el=document.activeElement;
 if(state.connectionEditor)return true;
 if(!el||el===document.body)return false;
 return !!el.closest('input,textarea,select,[contenteditable="true"]');
}
function formatRemainingTime(expiresAt){
  var t=Number(expiresAt);
  if(!Number.isFinite(t))t=Date.parse(expiresAt||'');
  if(!Number.isFinite(t))return '00:00';
  var diff=Math.max(0,t-Date.now()),totalSec=Math.floor(diff/1000);
  if(totalSec<=0)return '00:00';
  var s=totalSec%60,m=Math.floor((totalSec%3600)/60),h=Math.floor(totalSec/3600);
  if(totalSec>=86400){
    var d=Math.floor(totalSec/86400);
    h=Math.floor((totalSec%86400)/3600);
    return d+'d '+String(h).padStart(2,'0')+'h '+String(m).padStart(2,'0')+'m';
  }
  if(totalSec>=3600){
    return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
  }
  return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function maintenanceBanner(){
  var m=state.maintenance;
  if(!m||m.enabled!==true)return '';
  var expiresAt=m.expiresAt,remainingMs=Math.max(0,(expiresAt?Number(expiresAt):0)-Date.now());
  if(remainingMs<=0)return '';
  var timeStr=formatRemainingTime(expiresAt),ttl=Number(m.durationMs)||15*60*1000;
  var pct=Math.min(100,Math.max(0,Math.round((remainingMs/ttl)*100)));
 return '<div class="maintenance-banner" role="alert">'+
   '<div class="maintenance-banner-main">'+
     '<div class="maintenance-banner-icon">'+icon('shield')+'</div>'+
     '<div class="maintenance-banner-copy">'+
       '<div class="maintenance-banner-heading">'+
         '<strong>Protected-Source Maintenance Active</strong>'+
         '<span class="maintenance-countdown" data-maintenance-countdown="'+esc(expiresAt)+'">'+esc(timeStr)+' remaining</span>'+
       '</div>'+
       '<p>ForgeLink runtime and security sources are temporarily unlocked for ChatGPT. The backend will automatically restart into protected mode when this window closes.</p>'+
     '</div>'+
   '</div>'+
   '<div class="maintenance-banner-actions">'+
     '<button class="ghost danger" id="toggleMaintenanceBanner" type="button">Disable now</button>'+
   '</div>'+
   '<div class="maintenance-banner-meter"><i style="width:'+pct+'%"></i></div>'+
 '</div>';
}
function updateChrome(){
 var runtimeState=state.runtime&&state.runtime.state||'stopped',connected=runtimeState==='running',degraded=runtimeState==='degraded',starting=runtimeState==='starting';
 var maintenanceActive=state.maintenance&&state.maintenance.enabled===true&&((state.maintenance.expiresAt||0)>Date.now());
 var statusLabel=connected
   ? (maintenanceActive ? 'Protected Maintenance' : 'Connected')
   : degraded ? 'Needs attention'
   : starting ? 'Reconnecting…' : 'Stopped';
 var sync=document.querySelector('.sync-status');
 if(sync){sync.classList.toggle('api-bad',!state.apiOnline);sync.innerHTML='<i></i>'+esc(state.apiOnline?'Updated '+healthAge(state.telemetry&&state.telemetry.timestamp)+' ago':'Dashboard unavailable')}
 var status=document.querySelector('.aside-bottom .status');
 if(status){
   status.className='status '+(maintenanceActive&&connected?'maintenance':connected?'on':degraded?'warn':starting?'reconnecting':'');
   var strong=status.querySelector('strong');if(strong)strong.textContent=statusLabel;
 }
 var power=document.querySelector('#power');
 if(power){
   power.className='power '+(connected?'stop':degraded?'repair':'');
   power.textContent=connected?'Stop service':degraded?'Repair service':starting?'Starting…':'Start service';
   power.disabled=starting;
 }
 var runtimeToggle=document.querySelector('[data-toggle="runtime"]');
 if(runtimeToggle){
   runtimeToggle.classList.toggle('on', ['running','degraded'].includes(runtimeState));
 }
}
function captureWorkspaceScroll(){
 var body=document.querySelector('.browser-body');
 if(body&&state.browserPath)state.browserScrollByPath[state.browserPath]=body.scrollTop;
 var preview=document.querySelector('.file-preview pre');
 if(preview)state.browserPreviewScrollTop=preview.scrollTop;
}
function restoreWorkspaceScroll(){
 var body=document.querySelector('.browser-body');
 if(body){
  body.scrollTop=Number(state.browserScrollByPath[state.browserPath]||0);
  body.onscroll=function(){if(state.browserPath)state.browserScrollByPath[state.browserPath]=body.scrollTop};
 }
 var preview=document.querySelector('.file-preview pre');
 if(preview){
  preview.scrollTop=Number(state.browserPreviewScrollTop||0);
  preview.onscroll=function(){state.browserPreviewScrollTop=preview.scrollTop};
 }
}
function renderContent(){
 var content=document.querySelector('.content');
 if(!content){render();return}
 captureWorkspaceScroll();
 var scrollTop=content.scrollTop;
 content.innerHTML=maintenanceBanner()+(state.apiError?'<div class="api-alert"><div><strong>Dashboard data is unavailable</strong><span>'+esc(state.apiError)+'</span></div><button id="retryApi">Try again</button></div>':'')+page();
 bind();
 requestAnimationFrame(function(){var next=document.querySelector('.content');if(next)next.scrollTop=scrollTop;restoreWorkspaceScroll()});
}
async function refresh(options){
 options=options||{};
 var failures=[];
 var previousToolSignature=JSON.stringify(state.tools.map(function(t){return [t.name,t.description,t.access]}));
 var d=await bridge.getState().catch(function(){return null});
 if(d){
   state.runtime=d.runtime||state.runtime;
   state.config=d.configuration||state.config;
   state.maintenance=d.maintenance||state.maintenance;
   if(d.configuration){
     if(d.configuration.automationMode!=null) state.automationMode=d.configuration.automationMode;
     if(d.configuration.headlessBackground!=null) state.headlessBackground=!!d.configuration.headlessBackground;
   }
   if(d.automationMode!=null) state.automationMode=d.automationMode;
   if(d.headlessBackground!=null) state.headlessBackground=!!d.headlessBackground;
   if(Array.isArray(d.connections)&&state.config){
     var byId={};d.connections.forEach(function(x){byId[x.id]=x});
     state.config.connections=(state.config.connections||[]).map(function(x){return Object.assign({},x,byId[x.id]&&byId[x.id].runtime?{runtime:byId[x.id].runtime}:{})});
   }
 }
 try{state.server=await api('/status');state.roots=state.server.roots||[];state.readOnlyRoots=state.server.readOnlyRoots||[];state.terminalMode=state.server.terminalMode||'off';state.systemControlMode=state.server.systemControlMode||'off'}catch(e){failures.push('status: '+e.message)}
 try{var toolPayload=await api('/tools');state.tools=Array.isArray(toolPayload.tools)?toolPayload.tools:[];state.lastToolFetch=Date.now()}catch(e){failures.push('tools: '+e.message)}
 try{state.telemetry=await api('/telemetry')}catch(e){failures.push('telemetry: '+e.message)}
 if(state.page==='settings')try{state.permissions=await api('/permissions')}catch(e){failures.push('permissions: '+e.message)}
 if(state.page==='logs')try{state.logs=(await api('/logs?source=server')).lines||[]}catch(e){failures.push('logs: '+e.message)}
 if(state.page==='safety')try{var safetyData=await api('/safety');if(state.server)state.server.safety=safetyData.status||state.server.safety;state.safetyEvents=safetyData.events||[]}catch(e){failures.push('safety: '+e.message)}
 state.apiOnline=failures.length===0;
 state.apiError=failures.length?failures.join(' · '):null;
 if(state.apiOnline)state.apiLastSuccessAt=new Date().toISOString();
 var toolsChanged=previousToolSignature!==JSON.stringify(state.tools.map(function(t){return [t.name,t.description,t.access]}));
 if(state.page==='workspace'&&state.browserPath&&!options.background)await loadBrowser(state.browserPath,true);
 if(!document.querySelector('.shell')){render();return}
 updateChrome();
 if((!options.background||(state.page==='tools'&&toolsChanged))&&!state.connectionEditor&&!userIsEditing())renderContent();
}

function paintToast(){
 var old=document.querySelector('.toast');if(old)old.remove();
 if(!state.notice)return;
 var el=document.createElement('div');
 el.className='toast '+(state.notice.bad?'bad':'');
 el.textContent=(state.notice.bad?'! ':'✓ ')+state.notice.msg;
 document.body.appendChild(el);
}
function toast(msg,bad){
 state.notice={msg:msg,bad:!!bad};
 paintToast();
 setTimeout(function(){if(state.notice&&state.notice.msg===msg){state.notice=null;paintToast()}},3500);
}
function nav(){
 return NAV.map(function(x){return '<button class="nav '+(state.page===x[0]?'active':'')+'" data-nav="'+x[0]+'"><i>'+icon(x[2])+'</i><span>'+x[1]+'</span>'+(x[0]==='tools'?'<em>'+state.tools.length+'</em>':'')+'</button>'}).join('');
}
function shell(){
 var title=NAV.find(function(x){return x[0]===state.page})[1],runtimeState=state.runtime&&state.runtime.state||'stopped',connected=runtimeState==='running',degraded=runtimeState==='degraded',live=connected;
 var maintenanceActive=state.maintenance&&state.maintenance.enabled===true&&((state.maintenance.expiresAt||0)>Date.now());
 var statusLabel=connected?(maintenanceActive?'Protected Maintenance':'Connected'):degraded?'Needs attention':runtimeState==='starting'?'Reconnecting…':'Stopped',powerLabel=live?'Stop service':degraded?'Repair service':'Start service';
 var freshness=state.apiOnline?'Updated '+healthAge(state.telemetry&&state.telemetry.timestamp)+' ago':'Dashboard unavailable';
  var maintenancePill=maintenanceActive?'<span class="maintenance-pill" title="Protected-source maintenance window is active"><i></i><span>Maintenance: <strong data-maintenance-header-countdown="'+esc(state.maintenance.expiresAt)+'">'+esc(formatRemainingTime(state.maintenance.expiresAt))+'</strong></span></span>':'';
  var autoMode=state.automationMode||'off',autoActive=autoMode==='headless';
  var automationPill='<span class="automation-pill '+(autoActive?'headless':'off')+'" title="Automation: '+(autoActive?'Autonomous headless mode active':'Disabled')+'"><i></i><span>Automation: <strong>'+(autoActive?'HEADLESS':'OFF')+'</strong></span></span>';
  return '<div class="shell"><aside class="sidebar"><div class="brand"><img src="./logo.png" alt="ForgeLink logo"><div><strong>ForgeLink</strong><small>Control Center</small></div></div><nav class="sidebar-nav">'+nav()+'</nav><div class="aside-bottom"><span class="status-heading">Service Status</span><div class="status '+(maintenanceActive&&connected?'maintenance':connected?'on':degraded?'warn':runtimeState==='starting'?'reconnecting':'')+'"><i></i><div><strong>'+statusLabel+'</strong><small>Local service · v'+esc(state.server&&state.server.version||'4.1.0')+'</small></div></div><button class="power '+(live?'stop':degraded?'repair':'')+'" id="power">'+powerLabel+'</button><small>Runs locally on this computer. Your approved files remain under your control.</small></div></aside><main><header class="app-header"><div class="page-title"><h1>'+title+'</h1><p>'+esc(PAGE_INFO[state.page]||'ForgeLink Control Center')+'</p></div><div class="head-actions">'+automationPill+maintenancePill+'<span class="sync-status '+(state.apiOnline?'':'api-bad')+'"><i></i>'+esc(freshness)+'</span><button class="icon-button" id="refresh" title="Refresh">'+icon('refresh')+'</button><span class="avatar" title="Vidit Shah">VS</span><div class="window-controls"><button data-window-action="minimize" title="Minimize">'+icon('minimize')+'</button><button data-window-action="maximize" title="Maximize">'+icon('maximize')+'</button><button class="window-close" data-window-action="close" title="Close">'+icon('close')+'</button></div></div></header><section class="content">'+maintenanceBanner()+(state.apiError?'<div class="api-alert"><div><strong>Dashboard data is unavailable</strong><span>'+esc(state.apiError)+'</span></div><button id="retryApi">Try again</button></div>':'')+page()+'</section></main></div>';
}

function overview(){
 var s=state.server||{},r=state.runtime||{},t=state.telemetry||{},sys=t.system||{},svc=t.service||{},c=Object.values(r.connections||{}),live=c.filter(function(x){return x.state==='running'}).length,en=(state.config&&state.config.connections||[]).filter(function(x){return x.enabled!==false}).length,j=t.jobs||[],ev=(t.recentEvents||state.events||[]).slice().reverse(),runningJobs=j.filter(function(x){return x.status==='running'}).length;
 var runtimeGood=r.state==='running',runtimeWarn=r.state==='degraded',healthGood=!!(r.backend&&r.backend.healthy),connectionsGood=en>0&&live===en;
 return '<div class="overview-hero '+(runtimeGood?'good':runtimeWarn?'warn':'')+'"><div class="overview-check">'+icon(runtimeGood?'check':'pulse')+'</div><div class="overview-hero-copy"><span>SYSTEM STATUS</span><h2>'+esc(connectedSummary(r.state))+'</h2><p>'+(runtimeGood?'All services are operational. ':'')+'Monitor ForgeLink services, ChatGPT connections and local machine usage from one place.</p></div><div class="overview-status-card"><i class="'+(runtimeGood?'good':runtimeWarn?'warn':'bad')+'"></i><div><strong>'+esc(runtimeGood?'All services operational':runtimeWarn?'Attention required':'Service stopped')+'</strong><small>'+esc(live+'/'+en+' ChatGPT connection'+(en===1?'':'s')+' live')+'</small></div><b>›</b></div></div>'+
 '<div class="overview-kpi-grid">'+
 overviewKpi('link','Connections',live+'/'+en,'connected / enabled','blue','settings')+
 overviewKpi('cube','Available tools',state.tools.length,'MCP capabilities','violet','tools')+
 overviewKpi('database','Running jobs',runningJobs,j.length+' total records','green','terminal')+
 overviewKpi('clock','Uptime',uptime(svc.uptimeSeconds),'local service','orange','logs')+
 '</div>'+
 '<div class="overview-main-grid"><section class="panel overview-service-panel"><div class="overview-panel-head"><div class="overview-panel-title"><span class="panel-icon blue">'+icon('pulse')+'</span><div><h3>ForgeLink services</h3><p>Service health and connection status</p></div></div><span class="overview-health-pill '+(runtimeGood?'good':runtimeWarn?'warn':'bad')+'"><i></i>'+esc(runtimeGood?'Healthy':runtimeWarn?'Attention':'Stopped')+'</span></div><div class="health-grid overview-health-grid">'+healthItem('MCP backend',healthGood,'Healthy','Offline')+healthItem('Connections',connectionsGood,live+' of '+en,'Partial')+healthItem('Terminal',!!s.terminalEnabled,(s.terminalMode||'On'),'Off')+healthItem('Dashboard',!!s.dashboardPort,'Port '+(s.dashboardPort||'—'),'Offline')+'</div><div class="overview-service-meta">'+overviewInfoRow('link','MCP endpoint','127.0.0.1:'+(s.port||24024)+'/mcp',true)+overviewInfoRow('shield','Authentication',s.authentication||'—',false)+overviewInfoRow('activity','Last health check',healthAge(r.checkedAt)+' ago',false)+'</div></section>'+
 '<section class="panel overview-machine-panel"><div class="overview-panel-head"><div class="overview-panel-title"><span class="panel-icon blue">'+icon('monitor')+'</span><div><h3>Local computer usage</h3><p>CPU, memory and system resources</p></div></div><span class="muted">Updated '+healthAge(t.timestamp)+' ago</span></div><div class="metric-bars overview-meters">'+meter('CPU usage',sys.cpuPercent,sys.cpuPercent==null?'Sampling':sys.cpuPercent.toFixed(0)+'%')+meter('Memory usage',sys.totalMemory?sys.usedMemory/sys.totalMemory*100:null,sys.totalMemory?Math.round(sys.usedMemory/sys.totalMemory*100)+'%':'—')+'</div><div class="overview-machine-list">'+overviewInfoRow('cpu','CPU cores',sys.cpuCount||'—',false)+overviewInfoRow('memory','ForgeLink memory',bytes(sys.processRss),false)+overviewInfoRow('database','Node heap',bytes(sys.heapUsed)+' / '+bytes(sys.heapTotal),false)+overviewInfoRow('id','Process ID',sys.pid||'—',true)+'</div></section></div>'+
 '<div class="overview-bottom-grid"><section class="panel overview-activity-panel"><div class="overview-panel-head"><div class="overview-panel-title"><span class="panel-icon blue">'+icon('list')+'</span><div><h3>Recent activity</h3><p>Latest events and service activity</p></div></div><button class="text" data-nav="events">View all&nbsp; →</button></div><div class="overview-activity-list">'+(ev.length?ev.slice(0,3).map(overviewActivityRow).join(''):'<div class="empty">No recent runtime activity.</div>')+'</div></section>'+
 '<section class="panel overview-actions-panel"><div class="overview-panel-head"><div class="overview-panel-title"><span class="panel-icon blue">'+icon('lightning')+'</span><div><h3>Quick actions</h3><p>Common tasks and shortcuts</p></div></div></div><div class="overview-actions-grid">'+overviewQuickAction('terminal','Open Terminal','terminal')+overviewQuickAction('activity','View Live Events','events')+overviewQuickAction('folder','Open Workspace','workspace')+overviewQuickAction('settings','System Settings','settings')+'</div></section></div>';
}

function connectedSummary(runtimeState){return runtimeState==='running'?'ForgeLink is running normally':runtimeState==='degraded'?'ForgeLink needs attention':'ForgeLink is currently stopped'}

function access(){
 var s=state.server||{},c=state.config||{};
 function list(a,ro){return a.length?a.map(function(x){return '<div class="data-row"><span class="file-icon">⌁</span><div class="grow"><strong>'+esc(x)+'</strong><small>'+(ro?'READ ONLY':'READ + WRITE')+' · approved boundary</small></div><button class="ghost danger" data-root="'+encodeURIComponent(x)+'">Remove</button></div>'}).join(''):'<div class="empty">No roots configured.</div>'}
 return '<div class="page-hero"><div><small class="eyebrow">Access & security</small><h2>Control what ForgeLink can access.</h2><p>Review approved workspaces, read-only locations, authentication and local control policies.</p></div><button class="primary" id="choose">＋ Add workspace</button></div><div class="stats">'+stat('WRITE ROOTS',state.roots.length,'approved','violet')+stat('READ ONLY',state.readOnlyRoots.length,'observation','cyan')+stat('TERMINAL',(s.terminalMode||'off').toUpperCase(),'execution gate','amber')+stat('WINDOWS',(s.systemControlMode||'off').toUpperCase(),'system gate','cyan')+stat('AUTH',s.authentication||'—','transport','green')+'</div><div class="grid-2"><section class="panel"><div class="ph"><div><small>WRITE ACCESS</small><h3>Approved workspaces</h3></div><b class="count">'+state.roots.length+'</b></div>'+list(state.roots,false)+'</section><section class="panel"><div class="ph"><div><small>READ ONLY</small><h3>Observation roots</h3></div><b class="count">'+state.readOnlyRoots.length+'</b></div>'+list(state.readOnlyRoots,true)+'</section></div><div class="grid-3"><section class="panel"><small>AUTHENTICATION</small><h3>'+esc(s.authentication||'Unknown')+'</h3><p>Transport authentication from the running MCP service.</p></section><section class="panel"><small>LAUNCH AT LOGIN</small><h3>'+((c.launchAtLogin)?'ENABLED':'DISABLED')+'</h3><button class="ghost" id="loginToggle">'+(c.launchAtLogin?'Disable':'Enable')+' launch at login</button></section><section class="panel"><small>TERMINAL POLICY</small><h3>'+esc((s.terminalMode||'off').toUpperCase())+'</h3><p>Independent execution gate.</p><button class="ghost" data-nav="terminal">Configure →</button></section></div><section class="panel"><div class="ph"><div><small>SECURITY BOUNDARY</small><h3>What ForgeLink enforces</h3></div></div><div class="notice-grid"><div><b>1</b><p>Filesystem operations stay inside approved roots.</p></div><div><b>2</b><p>Terminal execution follows the selected policy.</p></div><div><b>3</b><p>Runtime credentials are never returned to the renderer.</p></div></div></section>';
}

function tools(){
 var q=state.search.trim().toLowerCase(),ts=state.tools.filter(function(t){return !q||JSON.stringify(t).toLowerCase().indexOf(q)>=0}),groups={};
 ts.forEach(function(t){var n=t.name||String(t),g=n.includes('.')?n.split('.')[0]:(n.includes('_')?n.split('_')[0]:'core');(groups[g]||(groups[g]=[])).push(t)});
 Object.keys(groups).forEach(function(g){groups[g].sort(function(a,b){return String(a.name||a).localeCompare(String(b.name||b))})});
 var names=Object.keys(groups).sort(),columns=[[],[]],weights=[0,0];
 names.forEach(function(g){var target=weights[0]<=weights[1]?0:1;columns[target].push(g);weights[target]+=groups[g].length+1.5});
 function namespaceCard(g){return '<section class="tool-namespace-card"><div class="tool-namespace-head"><div class="tool-namespace-title"><span class="tool-namespace-icon">'+icon('grid')+'</span><div><small>NAMESPACE</small><h3>'+esc(g)+'</h3></div></div><b class="tool-namespace-count">'+groups[g].length+'</b></div><div class="tool-list">'+groups[g].map(function(t){var access=String(t.access||'Read'),tone=access.toLowerCase().replace(/[^a-z0-9]+/g,'-');return '<button class="tool-row" data-tool="'+esc(t.name||'')+'"><span class="tool-glyph">'+icon('grid')+'</span><div class="grow"><strong>'+esc(t.name||t)+'</strong><small>'+esc(t.description||'MCP capability')+'</small></div><em class="tool-access '+esc(tone)+'">'+esc(access)+'</em><span class="tool-row-arrow">→</span></button>'}).join('')+'</div></section>'}
 var freshness=state.lastToolFetch?healthAge(new Date(state.lastToolFetch).toISOString()):'—';
 var d=state.selectedTool?'<section class="panel detail-panel tool-detail-panel"><div class="ph"><div><small>CAPABILITY DETAIL</small><h3>'+esc(state.selectedTool.name||'Tool')+'</h3></div><button class="ghost" id="closeTool">Close</button></div><div class="detail-grid">'+kv('Status','EXPOSED')+kv('Access',state.selectedTool.access||'Read')+kv('Namespace',(state.selectedTool.name||'core').split(/[._]/)[0])+kv('Description',state.selectedTool.description||'No description')+'</div><div class="schema"><small>INPUT SCHEMA</small><pre>'+esc(JSON.stringify(state.selectedTool.inputSchema||state.selectedTool.input_schema||state.selectedTool.parameters||{},null,2))+'</pre></div></section>':'';
 var catalog=ts.length?'<div class="namespace-grid">'+columns.map(function(column){return '<div class="namespace-column">'+column.map(namespaceCard).join('')+'</div>'}).join('')+'</div>':'<section class="tool-empty-state"><strong>No matching capabilities.</strong><small>Try a broader search or clear the filter.</small></section>';
 return '<div class="tool-catalog-page"><div class="page-hero tool-catalog-hero"><div><small class="eyebrow">Live MCP catalog</small><h2><span>'+state.tools.length+'</span> available tools.</h2><p>Browse the actual tools registered by the running ForgeLink MCP backend. The catalog reconciles automatically with the live registry.</p></div><div class="tool-hero-metrics"><div class="catalog-badge"><strong>'+ts.length+'</strong><small>matching now</small></div><div class="catalog-live"><i></i><div><strong>Live registry</strong><small>'+(freshness==='—'?'waiting for sync':freshness+' ago')+'</small></div></div></div></div><div class="toolbar tool-toolbar"><label class="search tool-search">⌕<input id="search" value="'+esc(state.search)+'" placeholder="Search tool, namespace or description…"></label><span class="tool-toolbar-meta"><b>'+names.length+'</b> namespaces · <b>'+ts.length+'</b> shown</span><button class="ghost tool-refresh" id="refreshTools">'+icon('refresh')+'<span>Refresh</span></button></div>'+d+catalog+'</div>';
}

function systemControlPage(){
 var s=state.server||{},mode=state.systemControlMode||'off',active=mode!=='off',full=mode==='full';
 var caps=[
  ['Control status','system_control_status','Host platform, policy and native capability state'],
  ['Overview','system_overview','Bounded host-native operational snapshot'],
  ['Installed apps','system_installed_apps','Bounded native application inventory'],
  ['Services','system_services','Windows services / launchd / systemd'],
  ['Processes','system_processes','PID + executable metadata'],
  ['Network','system_network','Host-native network configuration'],
  ['Power','system_power','Power and battery state where available']
 ];
 return '<div class="page-hero"><div><small class="eyebrow">System control</small><h2>Native visibility across Windows, macOS and Linux.</h2><p>ForgeLink detects the host automatically and exposes only the bounded capabilities implemented for that operating system.</p></div><div class="seg">'+['off','read','full'].map(function(m){return '<button class="'+(mode===m?'sel':'')+'" data-system-mode="'+m+'">'+m.toUpperCase()+'</button>'}).join('')+'</div></div>'+
 '<div class="stats">'+stat('POLICY',mode.toUpperCase(),full?'read + supported host actions':active?'native read only':'disabled',full?'green':active?'cyan':'amber')+stat('SYSTEM TOOLS',caps.length,'cross-platform capabilities','violet')+stat('HOST SAFETY','NATIVE','OS privacy + ACLs enforced','cyan')+stat('TERMINAL',(s.terminalMode||'off').toUpperCase(),'separate execution gate','amber')+'</div>'+
 '<div class="grid-2"><section class="panel"><div class="ph"><div><small>CAPABILITY SURFACE</small><h3>What ChatGPT can inspect</h3></div><b class="count">'+caps.length+'</b></div>'+caps.map(function(x){return '<div class="data-row"><span class="dot '+(active?'live':'')+'"></span><div class="grow"><strong>'+esc(x[0])+'</strong><small>'+esc(x[2])+'</small></div><b class="mono">'+esc(x[1])+'</b></div>'}).join('')+'</section>'+
 '<section class="panel"><div class="ph"><div><small>SECURITY MODEL</small><h3>Independent local gates</h3></div></div><div class="notice-grid"><div><b>1</b><p><strong>System Control</strong> governs bounded native observation. Windows, macOS and Linux privacy controls remain enforced by the operating system.</p></div><div><b>2</b><p><strong>Terminal Policy</strong> remains a separate owner-controlled gate for command execution. System Control never implies shell authority.</p></div><div><b>3</b><p>ForgeLink does not bypass UAC, TCC, SIP, POSIX permissions, SELinux, AppArmor, credential stores or private keys.</p></div></div><div class="actions"><button class="ghost" data-nav="terminal">Configure Terminal →</button><button class="ghost" data-nav="tools">Inspect live tools →</button></div></section></div>'+
 '<section class="panel"><div class="ph"><div><small>ROUTING MODEL</small><h3>Detect host → choose native adapter → enforce owner gate → verify</h3></div></div><div class="flow"><span>Windows / macOS / Linux</span><i>→</i><span>Native capability adapter</span><i>→</i><span>Owner-approved gate</span><i>→</i><span>Bounded result</span></div><p class="muted">Windows keeps its specialized legacy tools for compatibility. macOS and Linux use the same system_* contract with platform-native implementations and explicit unsupported-capability reporting.</p></section>';
}

function terminal(){
 var t=state.telemetry||{},jobs=t.jobs||[],running=jobs.filter(function(x){return x.status==='running'}),sv=state.server||{};
 return '<div class="page-hero"><div><small class="eyebrow">Terminal</small><h2>Run commands and review background jobs.</h2><p>Use the selected terminal policy and review command or job status in one place.</p></div><div class="seg">'+['off','safe','full'].map(function(m){return '<button class="'+(state.terminalMode===m?'sel':'')+'" data-term="'+m+'">'+m.toUpperCase()+'</button>'}).join('')+'</div></div><div class="stats">'+stat('POLICY',(sv.terminalMode||'off').toUpperCase(),'execution gate','amber')+stat('RUNNING',running.length,'live jobs','green')+stat('RECORDS',jobs.length,'recent jobs','cyan')+stat('UPTIME',uptime(t.service&&t.service.uptimeSeconds),'backend','violet')+'</div><section class="panel terminal"><div class="term-head"><span>● ForgeLink shell</span><small>policy: '+esc(state.terminalMode)+' · live</small></div><div class="term-out" id="out"><span class="dim">Terminal ready.</span><br><span class="green">forge&gt;</span></div><div class="term-input"><input id="cmd" placeholder="Run a command…"><button class="primary" id="run">Run</button></div></section><section class="panel"><div class="ph"><div><small>JOB SUPERVISOR</small><h3>Live process activity</h3></div><b class="count">'+running.length+' running</b></div>'+(jobs.length?jobs.slice(0,20).map(function(j){return '<div class="job-row"><i class="'+(j.status==='running'?'live':'')+'"></i><div><strong>'+esc(j.kind||'job')+'</strong><small>'+esc(j.id||'')+'</small></div><b>'+esc(j.status||'unknown')+'</b><time>'+esc(j.durationMs?Math.round(j.durationMs/1000)+'s':'—')+'</time></div>'}).join(''):'<div class="empty">No jobs have been recorded.</div>')+'</section>';
}

async function loadBrowser(target,background){target=target||state.browserPath||state.roots[0];if(!target)return;captureWorkspaceScroll();var changed=target!==state.browserPath;try{var d=await api('/directory?path='+encodeURIComponent(target));state.browserPath=target;state.browserItems=d.items||[];state.browserSkipped=Number(d.skipped||0);if(changed||!background){state.selectedFile=null;state.browserPreviewScrollTop=0}if(!background)renderContent()}catch(e){if(background){state.apiError='workspace: '+e.message;state.apiOnline=false;updateChrome();return}toast(e.message,true)}}
async function previewFile(path){try{captureWorkspaceScroll();state.browserPreviewScrollTop=0;state.selectedFile=await api('/file?path='+encodeURIComponent(path));render()}catch(e){toast(e.message,true)}}
function workspace(){
 var root=state.browserPath||state.roots[0],items=state.browserItems||[];
 return '<div class="page-hero workspace-hero"><div><small class="eyebrow">Workspace</small><h2>Browse approved files and folders.</h2><p>Open approved directories and preview text files without leaving ForgeLink.</p></div><div class="actions"><button class="ghost" id="browse">Refresh</button><button class="primary" id="chooseWorkspace">＋ Add root</button></div></div><div class="stats workspace-stats">'+stat('WRITE ROOTS',state.roots.length,'approved','violet')+stat('READ ONLY',state.readOnlyRoots.length,'observation','cyan')+stat('ITEMS',items.length,'current directory','green')+stat('SKIPPED',state.browserSkipped,'locked / unavailable','amber')+'</div><section class="panel browser workspace-browser"><div class="browser-head"><div><small>ACTIVE DIRECTORY</small><strong>'+esc(root||'No approved workspace')+'</strong></div><button class="ghost" id="rootHome">ROOT</button></div><div class="browser-layout"><div class="browser-body">'+(root?(items.length?items.map(function(x){return '<button class="file-row" data-file-path="'+esc(x.path)+'" data-file-type="'+esc(x.type)+'"><span class="file-icon">'+(x.type==='directory'?'⌁':'·')+'</span><div class="grow"><strong>'+esc(x.name)+'</strong><small>'+esc(x.type==='directory'?'folder':bytes(x.size))+'</small></div><span>→</span></button>'}).join(''):'<div class="empty">Empty folder.</div>'):'<div class="empty">Add an approved workspace to begin.</div>')+'</div><div class="file-preview">'+(state.selectedFile?'<div class="ph"><div><small>FILE PREVIEW</small><h3>'+esc(state.selectedFile.path)+'</h3></div><span>'+bytes(state.selectedFile.size)+'</span></div><pre>'+esc(state.selectedFile.content||'')+'</pre>':'<div class="empty workspace-preview-empty"><strong>Select a text file.</strong><small>Its contents appear here.</small></div>')+'</div></div></section>';
}

function agents(){
 var t=state.telemetry||{},a=t.agents||[],sw=t.swarms||[],eng=t.engineering||{},wf=eng.workflows||[],active=a.filter(function(x){return x.state==='running'||x.workerActive}).length,as=sw.filter(function(x){return ['running','queued'].includes(x.status)}).length,aw=wf.filter(function(x){return ['running','ready_for_verification','review_required'].includes(x.status)}).length;
 return '<div class="page-hero"><div><small class="eyebrow">Agent runtime</small><h2>Workflows, workers and swarms.</h2><p>Track engineering workflows, worker assignments, task progress and generated artifacts.</p></div><div class="hero-status '+(active||as?'good':'')+'"><i></i><div><strong>'+active+' AGENTS · '+as+' SWARMS · '+aw+' WORKFLOWS</strong><small>sample '+healthAge(t.timestamp)+' ago</small></div></div></div><div class="stats">'+stat('ACTIVE AGENTS',active,'workers','cyan')+stat('AGENT RECORDS',a.length,'runtime records','violet')+stat('ACTIVE SWARMS',as,'queued + running','green')+stat('ACTIVE WORKFLOWS',aw,'coordinated engineering','violet')+stat('WORKFLOW RECORDS',wf.length,'durable coordination','amber')+'</div><div class="grid-2"><section class="panel"><div class="ph"><div><small>ENGINEERING WORKFLOWS</small><h3>Coordinator state</h3></div><b class="count">'+wf.length+'</b></div>'+(wf.length?wf.map(function(x){return '<div class="data-row"><span class="dot '+(['running','ready_for_verification','review_required'].includes(x.status)?'live':'')+'"></span><div class="grow"><strong>'+esc(x.title||x.id)+'</strong><small>'+esc(x.status||'unknown')+' · '+esc(String(x.artifactCount||0))+' artifacts · '+esc(x.lastSwarmStatus||'no swarm')+'</small></div><b>'+esc(String((x.lastTaskCounts&&x.lastTaskCounts.completed)||0))+'</b></div>'}).join(''):'<div class="empty">No coordinated engineering workflows currently exist.</div>')+'</section><section class="panel"><div class="ph"><div><small>WORKERS</small><h3>Agent assignments</h3></div><b class="count">'+a.length+'</b></div>'+(a.length?a.map(function(x){return '<div class="data-row"><span class="dot '+((x.state==='running'||x.workerActive)?'live':'')+'"></span><div class="grow"><strong>'+esc(x.id||'agent')+'</strong><small>'+esc(x.role||x.groupId||'scoped')+' · '+esc(x.state||'unknown')+(x.workerActive?' · worker active':'')+'</small></div><b>'+esc(x.workspace||'local')+'</b></div>'}).join(''):'<div class="empty">No agent assignments currently exist.</div>')+'</section><section class="panel"><div class="ph"><div><small>SWARMS</small><h3>Parallel orchestration</h3></div><b class="count">'+sw.length+'</b></div>'+(sw.length?sw.map(function(x){return '<div class="data-row"><span class="dot '+(['running','queued'].includes(x.status)?'live':'')+'"></span><div class="grow"><strong>'+esc(x.id||'swarm')+'</strong><small>'+esc(x.status||'unknown')+' · '+esc(String(x.tasks?.length||0))+' tasks</small></div><b>'+esc(x.workspace||'local')+'</b></div>'}).join(''):'<div class="empty">No swarm records currently exist.</div>')+'</section></div><section class="panel"><div class="ph"><div><small>EXECUTION MODEL</small><h3>Coordinator → worker → tools → reconcile</h3></div></div><div class="flow"><span>Coordinator</span><i>→</i><span>Scoped worker</span><i>→</i><span>Tool execution</span><i>→</i><span>Artifact</span><i>→</i><span>Reconcile</span></div></section>';
}

function events(){
 var ev=state.events.length?state.events.slice().reverse():(state.telemetry&&state.telemetry.recentEvents||[]).slice().reverse();
 return '<div class="page-hero"><div><small class="eyebrow">Live events</small><h2>Runtime activity as it happens.</h2><p>Recent backend events appear here in real time and remain available for the current session.</p></div><div class="actions"><span class="live-badge"><i></i> STREAM '+(state.events.length?'ACTIVE':'WAITING')+'</span><button class="ghost" id="clear">Clear local buffer</button></div></div><div class="stats">'+stat('BUFFERED',state.events.length,'client events','cyan')+stat('SERVER RECENT',(state.telemetry&&state.telemetry.recentEvents||[]).length,'backend history','violet')+stat('LAST EVENT',ev[0]?fmtTime(ev[0].timestamp):'—','local time','green')+stat('SAMPLE AGE',healthAge(state.telemetry&&state.telemetry.timestamp),'telemetry','amber')+'</div><section class="panel events-panel"><div class="event-head"><span class="green">● LIVE STREAM</span><span>Newest first</span></div>'+(ev.length?ev.map(eventRow).join(''):'<div class="empty">Waiting for events from the execution plane.</div>')+'</section>';
}
function logs(){
 var errors=state.logs.filter(function(x){return /error|fatal|exception|failed/i.test(x)}).length,warns=state.logs.filter(function(x){return /warn/i.test(x)}).length;
 return '<div class="page-hero"><div><small class="eyebrow">Logs & diagnostics</small><h2>Review service health and logs.</h2><p>Check service health, error counts and redacted server output.</p></div><button class="ghost" id="reloadLogs">Refresh logs</button></div><div class="stats">'+stat('LINES',state.logs.length,'server.log','cyan')+stat('ERRORS',errors,'matched lines','red')+stat('WARNINGS',warns,'matched lines','amber')+stat('RUNTIME',(state.runtime&&state.runtime.state)||'stopped','actual state','green')+'</div><div class="grid-2"><section class="panel"><div class="ph"><div><small>HEALTH CHECKS</small><h3>Service diagnostics</h3></div></div>'+diagnosticRows()+'</section><section class="panel log"><div class="log-head"><span>server.log · redacted</span><small>'+state.logs.length+' lines</small></div><pre>'+esc(state.logs.join('\\n')||'No log lines available.')+'</pre></section></div>';
}
function diagnosticRows(){var s=state.server||{},r=state.runtime||{};var rows=[['MCP server',s.server==='online',s.server||'offline'],['Dashboard',!!s.dashboardPort,s.dashboardPort?':'+s.dashboardPort:'offline'],['Tunnel',s.tunnel==='ready',s.tunnel||'not ready'],['Terminal',!!s.terminalEnabled,s.terminalMode||'disabled'],['System Control',(s.systemControlMode||'off')!=='off',s.systemControlMode||'off'],['Runtime health',!!(r.backend&&r.backend.healthy),r.backend&&r.backend.healthy?'healthy':'offline']];return rows.map(function(x){return '<div class="diag-row"><i class="'+(x[1]?'good':'bad')+'"></i><div class="grow"><strong>'+esc(x[0])+'</strong><small>'+esc(x[2])+'</small></div><b>'+esc(x[1]?'PASS':'FAIL')+'</b></div>'}).join('')}

function newConnection(){
  state.connectionEditor={id:'',name:'',tunnelId:'',enabled:true};
  render();
  requestAnimationFrame(function(){document.querySelector('#conn-name')?.focus()});
}
function editConnection(id){
  var c=(state.config&&state.config.connections||[]).find(function(x){return x.id===id});
  if(!c)return;
  state.connectionEditor={id:c.id,name:c.name||'',tunnelId:c.tunnelId||'',enabled:c.enabled!==false};
  render();
  requestAnimationFrame(function(){document.querySelector('#conn-name')?.focus()});
}
function cancelConnection(){
  state.connectionEditor=null;
  state.pendingRuntimeStart=false;
  render();
}
async function saveConnectionProfile(){
  var ed=state.connectionEditor||{};
  var name=document.querySelector('#conn-name')?.value.trim()||'';
  var tunnelId=document.querySelector('#conn-tid')?.value.trim()||'';
  var apiKey=document.querySelector('#conn-key')?.value||'';
  if(!name)return toast('Account label is required.',true);
  if(!tunnelId)return toast('Tunnel ID is required.',true);
  if(!ed.id&&!apiKey.trim())return toast('Runtime API key is required for a new connection.',true);
  try{
    var payload={id:ed.id||undefined,name:name,tunnelId:tunnelId,apiKey:apiKey,enabled:ed.enabled!==false};
    var r=await bridge.saveConnection(payload);
    if(!r.ok)throw Error(r.error||'Could not save the connection.');
    var shouldStart=state.pendingRuntimeStart;
    state.connectionEditor=null;
    state.pendingRuntimeStart=false;
    await refresh();
    toast(ed.id?'Connection updated.':'Connection added.');
    if(shouldStart){
      var b=await bridge.start();
      if(!b.ok)throw Error(b.error||'ForgeLink could not start.');
      state.runtime=b.status;
      await refresh();
    }
  }catch(e){toast(e.message,true)}
}

function safety(){
 var s=state.server&&state.server.safety||state.telemetry&&state.telemetry.service&&state.telemetry.service.safety||{},events=state.safetyEvents||[],tripped=!!s.tripped;
 var autoMode=state.automationMode||s.automationMode||'off',autoActive=autoMode==='headless';
 var cards='<div class="stats">'+stat('AUTOMATION',autoActive?'HEADLESS':'OFF',autoActive?'autonomous headless tasks':'disabled',autoActive?'cyan':'amber')+stat('UI MUTATION','OFF','hard-disabled remotely')+stat('TERMINAL','FULL HEADLESS','shell without UI control')+stat('RECENT DENIALS',s.recentDenials||0,'last safety window')+stat('CIRCUIT BREAKER',tripped?'TRIPPED':'READY',tripped?(s.tripReason||'remote mutation blocked'):'monitoring active')+'</div>';
 var eventRows=events.length?events.slice().reverse().slice(0,20).map(function(e){return '<div class="data-row"><span class="dot '+(e.type==='denied'||e.type==='trip'?'':'live')+'"></span><div class="grow"><strong>'+esc((e.type||'event').toUpperCase()+(e.ruleId?' · '+e.ruleId:''))+'</strong><small>'+esc(e.reason||e.safeAlternative||'Safety policy event')+'</small></div><b>'+esc(fmtTime(e.at))+'</b></div>'}).join(''):'<div class="empty">No recent blocked actions.</div>';
 return '<div class="intro"><div><small>Safety</small><h2>Headless-first protection.</h2><p>ForgeLink blocks remote keyboard, mouse, focus, browser/settings navigation and policy escapes below the model layer.</p></div><div class="safety-hero-actions"><div class="seg"><button class="'+(autoMode==='off'?'sel':'')+'" data-automation-mode="off">AUTOMATION OFF</button><button class="'+(autoMode==='headless'?'sel':'')+'" data-automation-mode="headless">AUTOMATION HEADLESS</button></div><span class="overview-health-pill '+(tripped?'bad':'good')+'"><i></i>'+(tripped?'TRIPPED':'PROTECTED')+'</span></div></div>'+cards+'<div class="grid-2"><section class="panel"><div class="ph"><div><small>ACTIVE POLICY</small><h3>Remote mutation controls</h3></div></div><div class="kv-list">'+kv('Automation mode',autoMode.toUpperCase())+kv('Headless background',state.headlessBackground?'ENABLED':'DISABLED')+kv('UI automation',s.uiAutomationMode||'off')+kv('Terminal semantics',s.terminalSemanticMode||'full_headless')+kv('Headless policy',s.policy||'headless-first')+kv('Trip reason',s.tripReason||'None')+'</div><div class="actions safety-actions"><button class="ghost danger" id="tripSafety">Emergency stop remote mutations</button>'+(tripped?'<button class="primary" id="resetSafety">Reset safety trip</button>':'')+'</div></section><section class="panel"><div class="ph"><div><small>LIMITS</small><h3>Loop and abuse protection</h3></div></div><div class="kv-list">'+kv('High-risk actions / 5 min',s.limits&&s.limits.highRiskActionsPer5Minutes||'—')+kv('Identical actions / 30 sec',s.limits&&s.limits.identicalActionsPer30Seconds||'—')+kv('Denials before trip / 60 sec',s.limits&&s.limits.denialsBeforeTripPer60Seconds||'—')+kv('Recent high-risk actions',s.recentHighRiskActions||0)+'</div></section></div><section class="panel"><div class="ph"><div><small>SAFETY EVENTS</small><h3>Recent redacted decisions</h3></div><button class="ghost" id="refreshSafety">Refresh</button></div>'+eventRows+'</section>';
}

function permissionExpiry(value){
 var numeric=Number(value),t=Number.isFinite(numeric)&&numeric>100000000000?numeric:Date.parse(value||'');
 if(!Number.isFinite(t))return '';
 var ms=t-Date.now();if(ms<=0)return 'Expired';
 var minutes=Math.ceil(ms/60000);return minutes<60?'Expires in '+minutes+'m':'Expires '+new Date(t).toLocaleString();
}
function permissionPanel(){
 var p=state.permissions;
 if(!p)return '<section class="panel permissions-panel"><div class="ph"><div><small>CHATGPT PERMISSIONS</small><h3>Effective local access</h3></div><span class="secure">loading…</span></div><div class="permission-empty">Loading permissions…</div></section>';
 var f=p.folders||{},rw=f.readWrite||[],ro=f.readOnly||[],temp=f.temporary||[],rows=[],permanentCount=rw.length+ro.length;
 function folderRow(root,access,temporary,grantId,expiresAt){
  var write=access==='read_write',detail=temporary?(permissionExpiry(expiresAt)||'Temporary grant'):(permanentCount===1?'Required baseline · add another workspace before removing':'Saved grant');
  var revoke=temporary||permanentCount>1?'<button class="ghost danger permission-revoke" data-revoke-permission data-permission-kind="folder" '+(grantId?'data-permission-grant="'+esc(encodeURIComponent(grantId))+'"':'data-permission-path="'+esc(encodeURIComponent(root))+'"')+' data-permission-label="'+esc(encodeURIComponent(root))+'">Revoke</button>':'<button class="ghost permission-revoke" disabled>Required</button>';
  rows.push('<div class="permission-card"><span class="permission-icon">'+icon('folder')+'</span><div class="permission-copy"><div class="permission-title"><strong>Folder access</strong><span class="permission-level '+(write?'write':'read')+'">'+(write?'READ & WRITE':'READ ONLY')+'</span><span class="permission-tenure">'+(temporary?'Temporary':'Persistent')+'</span></div><div class="permission-scope mono">'+esc(root)+'</div><small>'+esc(detail)+'</small></div>'+revoke+'</div>');
 }
 rw.forEach(function(root){folderRow(root,'read_write',false,null,null)});
 ro.forEach(function(root){folderRow(root,'read',false,null,null)});
 temp.forEach(function(g){folderRow(g.root,g.access,true,g.grantId,g.expiresAt)});
 var t=p.terminal||{};if(t.mode&&t.mode!=='off'){rows.push('<div class="permission-card"><span class="permission-icon terminal">'+icon('terminal')+'</span><div class="permission-copy"><div class="permission-title"><strong>Terminal access</strong><span class="permission-level write">'+esc(t.mode==='full'?'FULL HEADLESS':'GUARDED')+'</span><span class="permission-tenure">'+(t.leaseExpiresAt?'Temporary':'Persistent')+'</span></div><div class="permission-scope">Command execution on this PC</div><small>'+esc(t.leaseExpiresAt?(permissionExpiry(t.leaseExpiresAt)||'Temporary lease'):'Saved local policy')+'</small></div><button class="ghost danger permission-revoke" data-revoke-permission data-permission-kind="terminal" data-permission-label="Terminal access">Revoke</button></div>');}
 var w=p.windows||{};if(w.mode&&w.mode!=='off'){rows.push('<div class="permission-card"><span class="permission-icon windows">'+icon('monitor')+'</span><div class="permission-copy"><div class="permission-title"><strong>Windows Control</strong><span class="permission-level '+(w.mode==='full'?'write':'read')+'">'+esc(w.mode.toUpperCase())+'</span><span class="permission-tenure">'+(w.leaseExpiresAt?'Temporary':'Persistent')+'</span></div><div class="permission-scope">Windows observation and owner-controlled actions</div><small>'+esc(w.leaseExpiresAt?(permissionExpiry(w.leaseExpiresAt)||'Temporary lease'):'Saved local policy')+'</small></div><button class="ghost danger permission-revoke" data-revoke-permission data-permission-kind="windows" data-permission-label="Windows Control">Revoke</button></div>');}
 var m=p.maintenance||{};if(m.active){rows.push('<div class="permission-card"><span class="permission-icon maintenance">'+icon('shield')+'</span><div class="permission-copy"><div class="permission-title"><strong>Protected-source maintenance</strong><span class="permission-level write">WRITE</span><span class="permission-tenure">Temporary</span></div><div class="permission-scope">ForgeLink runtime and security source</div><small>'+esc(permissionExpiry(m.expiresAt)||'Approved maintenance window')+'</small></div><button class="ghost danger permission-revoke" data-revoke-permission data-permission-kind="maintenance" data-permission-label="Protected-source maintenance">Revoke</button></div>');}
 return '<section class="panel permissions-panel"><div class="ph"><div><small>CHATGPT PERMISSIONS</small><h3>'+rows.length+' active permission'+(rows.length===1?'':'s')+' available to ChatGPT</h3><p>Live effective access. Revoking here immediately removes that authority from connected ChatGPT sessions.</p></div><div class="permission-head-actions"><span class="secure">live · 1.5s</span><button class="ghost" id="refreshPermissions">Refresh</button></div></div><div class="permission-list">'+(rows.length?rows.join(''):'<div class="permission-empty">No active local permissions.</div>')+'</div></section>';
}

function settings(){
 var c=state.config||{},cs=Array.isArray(c.connections)?c.connections:[],ed=state.connectionEditor;
 var safety=state.server&&state.server.safety||state.telemetry&&state.telemetry.service&&state.telemetry.service.safety||{};
 var safetyState=safety.tripped?'TRIPPED':'PROTECTED';
 var maintenance=state.maintenance||{},maintenanceActive=maintenance.enabled===true,maintenanceRemaining=maintenanceActive?Math.max(1,Math.ceil((maintenance.remainingMs||0)/60000)):0;
 var maintenancePanel='<section class="panel setting"><div><small>PROTECTED SOURCE MAINTENANCE</small><h3>'+(maintenanceActive?'Maintenance window active':'Protected files are remote read-only')+'</h3><p>'+(maintenanceActive?'Protected ForgeLink runtime/security source can be changed for about '+maintenanceRemaining+' more minute'+(maintenanceRemaining===1?'':'s')+'. The backend will restart automatically when the window closes.':'When protected-source work is required, ForgeLink asks for your approval inside ChatGPT. This desktop app does not enable maintenance; it only enforces or disables an approved window.')+'</p></div>'+(maintenanceActive?'<button class="ghost danger" id="toggleMaintenance">Disable now</button>':'<span class="secure">Approve in ChatGPT</span>')+'</section>';
 var headlessAutomationPanel='<section class="panel setting"><div><small>HEADLESS AUTOMATION</small><div class="setting-title-row"><h3>Allow autonomous headless task and subagent execution</h3><span class="setting-pill '+(state.automationMode==='headless'?'good':'off')+'">'+(state.automationMode==='headless'?'HEADLESS':'OFF')+'</span></div><p class="setting-desc">Enables autonomous background tasks, terminal workflows, and subagents. Invasive synthetic UI manipulation (mouse, keyboard, window focus) remains fail-closed.</p></div><button class="toggle '+(state.automationMode==='headless'?'on':'')+'" data-toggle="headless-automation"><i></i></button></section>';
 var headlessBackgroundPanel='<section class="panel setting"><div><small>HEADLESS BACKGROUND</small><div class="setting-title-row"><h3>Keep automation running silently when window is closed</h3><span class="setting-pill '+(state.headlessBackground?'good':'off')+'">'+(state.headlessBackground?'ACTIVE':'INACTIVE')+'</span></div><p class="setting-desc">When enabled, closing the ForgeLink window hides the application to the background so headless jobs and tunnels continue uninterrupted.</p></div><button class="toggle '+(state.headlessBackground?'on':'')+'" data-toggle="headless-background"><i></i></button></section>';
 var safetyPanel='<section class="panel safety-panel"><div class="ph"><div><small>MODEL & TOOL SAFETY</small><h3>Headless-first protection</h3></div><span class="overview-health-pill '+(safety.tripped?'bad':'good')+'"><i></i>'+safetyState+'</span></div><div class="safety-grid"><div><span>UI automation</span><b>OFF</b><small>Keyboard, mouse, focus and browser UI mutation blocked</small></div><div><span>Terminal semantics</span><b>FULL HEADLESS</b><small>Shell allowed; UI/input/policy escapes blocked</small></div><div><span>Recent denials</span><b>'+esc(safety.recentDenials||0)+'</b><small>Repeated unsafe actions trip the circuit breaker</small></div><div><span>Trip reason</span><b class="safety-reason">'+esc(safety.tripReason||'None')+'</b><small>Reset is local-only and requires confirmation</small></div></div><div class="actions safety-actions"><button class="ghost danger" id="tripSafety">Emergency stop remote mutations</button>'+(safety.tripped?'<button class="primary" id="resetSafety">Reset safety trip</button>':'')+'</div></section>';
 function connectionCard(x){
   var rt=x.runtime||{},live=rt.state==='running',busy=rt.state==='starting',fresh=live&&rt.checkedAt&&Date.now()-Date.parse(rt.checkedAt)<5000;
   var status=live?(fresh?'LIVE':'STALE'):busy?'STARTING':'OFFLINE';
   return '<div class="connection-card"><div class="connection-main"><div class="connection-icon '+(fresh?'pulse':'')+'">'+(live?'●':'○')+'</div><div class="connection-info"><div class="connection-title"><strong>'+esc(x.name)+'</strong><span class="connection-status '+(live&&fresh?'live':busy?'busy':'')+'">'+status+'</span></div><div class="connection-meta"><span>tunnel</span><b class="mono">'+esc(x.tunnelIdMasked||x.tunnelId||'Not configured')+'</b><span>health '+esc(x.healthPort||'—')+'</span><span>check '+healthAge(rt.checkedAt)+'</span></div><small>'+ (x.enabled!==false?'Enabled':'Disabled') +' · '+(x.hasRuntimeKey===false?'API key required':'API key encrypted locally')+'</small></div></div><div class="connection-actions"><button class="ghost" data-edit-connection="'+esc(x.id)+'">Edit</button><button class="toggle '+(x.enabled!==false?'on':'')+'" data-connection-toggle="'+esc(x.id)+'"><i></i></button><button class="ghost danger" data-delete-connection="'+esc(x.id)+'">Remove</button></div></div>';
 }
 var list=cs.length?cs.map(connectionCard).join(''):'<div class="empty">No ChatGPT Web tunnel profiles yet. Add the first account below.</div>';
 var editor=ed?'<section class="panel connection-editor"><div class="ph"><div><small>'+(ed.id?'EDIT CONNECTION':'ADD CONNECTION')+'</small><h3>'+(ed.id?'Update this ChatGPT Web connection':'Save another ChatGPT Web account')+'</h3></div><span class="secure">key encrypted</span></div><div class="form"><label>Account label<input id="conn-name" value="'+esc(ed.name||'')+'" placeholder="e.g. Personal ChatGPT"></label><label>Tunnel ID<input id="conn-tid" value="'+esc(ed.tunnelId||'')+'" placeholder="tunnel_…"></label><label>Runtime API key<input id="conn-key" type="password" value="" placeholder="'+(ed.id?'Leave blank to keep the saved key':'sk-…')+'"></label><label>Connection role<input value="Shared MCP backend · independent tunnel" disabled></label></div><p class="connection-note">Each saved profile has its own OpenAI tunnel ID and encrypted runtime key. All enabled profiles connect to the same local MCP endpoint: <span class="mono">127.0.0.1:24024/mcp</span>.</p><div class="actions"><button class="primary" id="save-connection">Save profile</button><button class="ghost" id="cancel-connection">Cancel</button></div></section>':'';
  return '<div class="intro"><div><small>Settings</small><h2>Connections and startup.</h2><p>Manage ChatGPT connections, local service behavior and startup preferences.</p></div><button class="primary" id="add-connection">＋ Add ChatGPT account</button></div>'+safetyPanel+'<div class="settings">'+maintenancePanel+headlessAutomationPanel+headlessBackgroundPanel+'<section class="panel setting"><div><small>RUNTIME</small><h3>Start or stop the MCP backend and all enabled tunnels.</h3></div><button class="toggle '+(state.runtime&&['running','degraded'].includes(state.runtime.state)?'on':'')+'" data-toggle="runtime"><i></i></button></section><section class="panel setting"><div><small>LAUNCH AT LOGIN</small><h3>Launch ForgeLink automatically when you sign in.</h3></div><button class="toggle '+(c.launchAtLogin?'on':'')+'" data-toggle="login"><i></i></button></section></div><section class="panel connections-panel"><div class="ph"><div><small>CHATGPT WEB ACCOUNTS</small><h3>'+cs.length+' saved tunnel profile'+(cs.length===1?'':'s')+'</h3></div><span class="secure">one backend · many tunnels</span></div><div class="connection-list">'+list+'</div></section>'+permissionPanel()+editor+'<div class="two"><section class="panel"><small>SHARED MCP ENDPOINT</small><h3>One shared local service</h3><div class="kv"><span>Endpoint</span><b class="mono">localhost:'+(state.server&&state.server.port||24024)+'/mcp</b></div><div class="kv"><span>Active tunnels</span><b>'+Object.values(state.runtime&&state.runtime.connections||{}).filter(function(x){return x.state==='running'}).length+'</b></div><div class="actions"><button class="ghost" id="choose2">Choose workspace folders</button><button class="ghost" data-nav="access">Access policy →</button></div></section><section class="panel"><small>POLICY</small><h3>Terminal / Windows Control</h3><p class="big">'+state.terminalMode.toUpperCase()+' / '+state.systemControlMode.toUpperCase()+'</p><div class="actions"><button class="ghost" data-nav="terminal">Terminal →</button><button class="ghost" data-nav="system">Windows →</button></div></section></div>';
}

function page(){switch(state.page){case'access':return access();case'tools':return tools();case'system':return systemControlPage();case'terminal':return terminal();case'workspace':return workspace();case'agents':return agents();case'events':return events();case'logs':return logs();case'safety':return safety();case'settings':return settings();default:return overview()}}

async function toggleRuntime(){
  try{
    if(state.runtime&&state.runtime.state==='running'){
      var a=await bridge.stop();
      if(a&&a.status)state.runtime=a.status;
      await refresh();
      return;
    }
    if(state.runtime&&state.runtime.state==='degraded'){
      toast('Repairing the incomplete MCP transport…');
      var stopRes=await bridge.stop();
      if(stopRes&&stopRes.status)state.runtime=stopRes.status;
    }
    var b=await bridge.start();
    if(b&&b.status)state.runtime=b.status;
    if(!b.ok){
      if(/runtime key|API key/i.test(String(b.error||''))){
        var first=(state.config&&state.config.connections||[]).find(function(x){return x.enabled!==false});
        if(first){state.pendingRuntimeStart=true;editConnection(first.id);toast('Enter the runtime API key once, then save to start ForgeLink.',true);return;}
      }
      throw Error(b.error||'Failed to start service');
    }
    state.runtime=b.status;
    await refresh();
  }catch(e){
    await refresh({background:true}).catch(function(){});
    toast(e.message,true);
  }
}
async function choose(){try{var roots=await bridge.chooseFolders();if(!roots.length)return;var all=[].concat(state.roots||[],roots);all=[...new Set(all)];var r=await bridge.saveSharedConfiguration({roots:all,terminalMode:state.terminalMode,systemControlMode:state.systemControlMode,launchAtLogin:state.config&&state.config.launchAtLogin===true});if(!r.ok)throw Error(r.error);await refresh();toast('Workspace folders saved.')}catch(e){toast(e.message,true)}}
async function removeRoot(path){try{await api('/roots',{method:'DELETE',body:JSON.stringify({path:path})});await refresh();toast('Workspace removed.')}catch(e){toast(e.message,true)}}
async function terminalMode(mode){try{await api('/terminal/settings',{method:'POST',body:JSON.stringify({mode:mode})});state.terminalMode=mode;render();toast('Terminal policy: '+mode)}catch(e){toast(e.message,true)}}
async function systemMode(mode){if(mode==='full'&&!window.confirm('Full System Control enables supported host-native actions through dedicated ForgeLink tools. Operating-system privacy controls remain enforced, and command execution still requires the separate Terminal policy. Enable Full System Control?'))return;try{await api('/system/settings',{method:'POST',body:JSON.stringify({mode:mode})});state.systemControlMode=mode;render();toast('System Control: '+mode)}catch(e){toast(e.message,true)}}
async function toggleLocalSecurityMaintenance(){try{if(!(state.maintenance&&state.maintenance.enabled===true)){toast('Protected-source maintenance must be approved from the ForgeLink card in ChatGPT.',true);return}var r=await bridge.setLocalSecurityMaintenance(false);if(r.cancelled)return;if(!r.ok)throw Error(r.error||'Maintenance transition failed');state.maintenance=r.maintenance||state.maintenance;state.runtime=r.status||state.runtime;await refresh();toast('Protected-source maintenance disabled.')}catch(e){toast(e.message,true)}}
async function runCmd(){var i=document.querySelector('#cmd'),o=document.querySelector('#out'),command=i&&i.value.trim();if(!command)return;i.value='';o.innerHTML+='<div class="prompt"><span>forge&gt;</span> '+esc(command)+'</div>';try{var r=await api('/terminal/run',{method:'POST',body:JSON.stringify({command:command,timeoutSeconds:30})});o.innerHTML+='<pre>'+esc(r.stdout||r.output||JSON.stringify(r,null,2))+'</pre>'+(r.stderr?'<pre class="err">'+esc(r.stderr)+'</pre>':'')}catch(e){o.innerHTML+='<pre class="err">'+esc(e.message)+'</pre>'}o.scrollTop=o.scrollHeight}

async function removeConnection(id){var c=(state.config&&state.config.connections||[]).find(function(x){return x.id===id});if(!c)return;if(!window.confirm('Remove the '+c.name+' tunnel profile from this computer?'))return;try{var r=await bridge.deleteConnection(id);if(!r.ok)throw Error(r.error);if(state.connectionEditor&&state.connectionEditor.id===id)state.connectionEditor=null;await refresh();toast('Tunnel profile removed.')}catch(e){toast(e.message,true)}}
async function toggleConnection(id,enabled){try{var r=await bridge.setConnectionEnabled(id,enabled);if(!r.ok)throw Error(r.error);await refresh();toast(enabled?'Tunnel enabled.':'Tunnel disabled.')}catch(e){toast(e.message,true)}}
async function revokePermission(kind,pathValue,grantId,label){try{
 if(kind==='maintenance'){if(!window.confirm('Revoke the active protected-source maintenance window now?'))return;await toggleLocalSecurityMaintenance();return;}
 var message=kind==='folder'?'Revoke ChatGPT access to '+label+'? Files will not be deleted.':kind==='terminal'?'Revoke all Terminal access from ChatGPT? Active terminal sessions and jobs will be closed or cancelled.':'Revoke Windows Control from ChatGPT immediately?';
 if(!window.confirm(message))return;
 var payload={kind:kind};if(pathValue)payload.path=pathValue;if(grantId)payload.grantId=grantId;
 var r=await api('/permissions/revoke',{method:'POST',body:JSON.stringify(payload)});state.permissions=r.permissions||state.permissions;
 await refresh();toast(label+' revoked.');
}catch(e){toast(e.message,true)}}

function bind(){
 document.querySelectorAll('[data-nav]').forEach(function(b){b.onclick=function(){var content=document.querySelector('.content');if(content)content.scrollTop=0;state.page=b.dataset.nav;state.selectedTool=null;render();if(state.page==='workspace')loadBrowser(state.browserPath||state.roots[0]);if(state.page==='settings')refresh()}});
 var refreshButton=document.querySelector('#refresh');if(refreshButton)refreshButton.onclick=function(){refresh()};
 var retryButton=document.querySelector('#retryApi');if(retryButton)retryButton.onclick=function(){refresh()};
 var powerButton=document.querySelector('#power');if(powerButton)powerButton.onclick=toggleRuntime;
 document.querySelectorAll('[data-window-action]').forEach(function(b){b.onclick=function(){bridge.windowAction(b.dataset.windowAction)}});
 var chooseButton=document.querySelector('#choose');if(chooseButton)chooseButton.onclick=choose;
 var chooseWorkspaceButton=document.querySelector('#chooseWorkspace');if(chooseWorkspaceButton)chooseWorkspaceButton.onclick=choose;
 document.querySelectorAll('[data-root]').forEach(function(b){b.onclick=function(){removeRoot(decodeURIComponent(b.dataset.root))}});
 document.querySelectorAll('[data-term]').forEach(function(b){b.onclick=function(){terminalMode(b.dataset.term)}});
 document.querySelectorAll('[data-system-mode]').forEach(function(b){b.onclick=function(){systemMode(b.dataset.systemMode)}});
 var runButton=document.querySelector('#run');if(runButton)runButton.onclick=runCmd;
 var commandInput=document.querySelector('#cmd');if(commandInput)commandInput.onkeydown=function(e){if(e.key==='Enter')runCmd()};
 var searchInput=document.querySelector('#search');if(searchInput)searchInput.oninput=function(e){state.search=e.target.value;var pos=e.target.selectionStart;renderContent();requestAnimationFrame(function(){var n=document.querySelector('#search');if(n){n.focus();try{n.setSelectionRange(pos,pos)}catch(_){}}})};
 var refreshTools=document.querySelector('#refreshTools');if(refreshTools)refreshTools.onclick=function(){refresh()};
 document.querySelectorAll('[data-tool]').forEach(function(b){b.onclick=function(){state.selectedTool=state.tools.find(function(t){return t.name===b.dataset.tool})||null;renderContent()}});
 var closeTool=document.querySelector('#closeTool');if(closeTool)closeTool.onclick=function(){state.selectedTool=null;renderContent()};
 var browse=document.querySelector('#browse');if(browse)browse.onclick=function(){loadBrowser(state.browserPath||state.roots[0])};
 var rootHome=document.querySelector('#rootHome');if(rootHome)rootHome.onclick=function(){loadBrowser(state.roots[0])};
 document.querySelectorAll('[data-file-path]').forEach(function(b){b.onclick=function(){b.dataset.fileType==='directory'?loadBrowser(b.dataset.filePath):previewFile(b.dataset.filePath)}});
 var clear=document.querySelector('#clear');if(clear)clear.onclick=function(){state.events=[];renderContent()};
 var reloadLogs=document.querySelector('#reloadLogs');if(reloadLogs)reloadLogs.onclick=async function(){try{state.logs=(await api('/logs?source=server')).lines||[];renderContent()}catch(e){toast(e.message,true)}};
 var addConnection=document.querySelector('#add-connection');if(addConnection)addConnection.onclick=newConnection;
 var saveConnection=document.querySelector('#save-connection');if(saveConnection)saveConnection.onclick=saveConnectionProfile;
 var cancel=document.querySelector('#cancel-connection');if(cancel)cancel.onclick=cancelConnection;
 document.querySelectorAll('[data-edit-connection]').forEach(function(b){b.onclick=function(){editConnection(b.dataset.editConnection)}});
 document.querySelectorAll('[data-delete-connection]').forEach(function(b){b.onclick=function(){removeConnection(b.dataset.deleteConnection)}});
 document.querySelectorAll('[data-connection-toggle]').forEach(function(b){b.onclick=function(){toggleConnection(b.dataset.connectionToggle,!b.classList.contains('on'))}});
 document.querySelectorAll('[data-revoke-permission]').forEach(function(b){b.onclick=function(){revokePermission(b.dataset.permissionKind,b.dataset.permissionPath?decodeURIComponent(b.dataset.permissionPath):null,b.dataset.permissionGrant?decodeURIComponent(b.dataset.permissionGrant):null,b.dataset.permissionLabel?decodeURIComponent(b.dataset.permissionLabel):'Permission')}});
 var refreshPermissions=document.querySelector('#refreshPermissions');if(refreshPermissions)refreshPermissions.onclick=function(){refresh()};
 var runtimeToggle=document.querySelector('[data-toggle="runtime"]');if(runtimeToggle)runtimeToggle.onclick=toggleRuntime;
 var loginToggle=document.querySelector('[data-toggle="login"]');if(loginToggle)loginToggle.onclick=async function(){try{var r=await bridge.setLaunchAtLogin(!(state.config&&state.config.launchAtLogin===true));if(!r.ok)throw Error(r.error);await refresh()}catch(e){toast(e.message,true)}};
 var loginButton=document.querySelector('#loginToggle');if(loginButton)loginButton.onclick=async function(){try{var r=await bridge.setLaunchAtLogin(!(state.config&&state.config.launchAtLogin===true));if(!r.ok)throw Error(r.error);await refresh()}catch(e){toast(e.message,true)}};
 var tripSafety=document.querySelector('#tripSafety');if(tripSafety)tripSafety.onclick=async function(){try{var r=await bridge.tripSafety();if(!r.ok)throw Error(r.error||'Safety stop failed');await refresh();toast('Remote mutations are now safety-tripped.')}catch(e){toast(e.message,true)}};
 var resetSafety=document.querySelector('#resetSafety');if(resetSafety)resetSafety.onclick=async function(){try{var r=await bridge.resetSafety();if(r.cancelled)return;if(!r.ok)throw Error(r.error||'Safety reset failed');await refresh();toast('Safety trip reset. UI automation remains disabled.')}catch(e){toast(e.message,true)}};
  var maintenanceButton=document.querySelector('#toggleMaintenance');if(maintenanceButton)maintenanceButton.onclick=toggleLocalSecurityMaintenance;
  var maintenanceBannerButton=document.querySelector('#toggleMaintenanceBanner');if(maintenanceBannerButton)maintenanceBannerButton.onclick=toggleLocalSecurityMaintenance;
   var refreshSafety=document.querySelector('#refreshSafety');if(refreshSafety)refreshSafety.onclick=function(){refresh()};
  var headlessAutomationToggle=document.querySelector('[data-toggle="headless-automation"]');
  if(headlessAutomationToggle)headlessAutomationToggle.onclick=async function(){
    try{
      var nextMode=state.automationMode==='headless'?'off':'headless';
      var r=await bridge.setAutomationMode(nextMode);
      if(!r.ok)throw Error(r.error||'Failed to set automation mode');
      state.automationMode=r.automationMode||nextMode;
      await refresh();
      toast('Automation mode set to '+nextMode.toUpperCase()+'.');
    }catch(e){toast(e.message,true)}
  };
  var headlessBackgroundToggle=document.querySelector('[data-toggle="headless-background"]');
  if(headlessBackgroundToggle)headlessBackgroundToggle.onclick=async function(){
    try{
      var nextState=!state.headlessBackground;
      var r=await bridge.setHeadlessBackground(nextState);
      if(!r.ok)throw Error(r.error||'Failed to set headless background');
      state.headlessBackground=r.headlessBackground!==undefined?r.headlessBackground:nextState;
      await refresh();
      toast('Headless background '+(nextState?'enabled':'disabled')+'.');
    }catch(e){toast(e.message,true)}
  };
  document.querySelectorAll('[data-automation-mode]').forEach(function(b){
    b.onclick=async function(){
      try{
        var targetMode=b.dataset.automationMode;
        if(targetMode===state.automationMode)return;
        var r=await bridge.setAutomationMode(targetMode);
        if(!r.ok)throw Error(r.error||'Failed to set automation mode');
        state.automationMode=r.automationMode||targetMode;
        await refresh();
        toast('Automation mode set to '+targetMode.toUpperCase()+'.');
      }catch(e){toast(e.message,true)}
    };
  });
}
function render(){
  var content=document.querySelector('.content');
  captureWorkspaceScroll();
  var scrollTop=content?content.scrollTop:0;
  var active=document.activeElement;
  var activeId=active&&active.id;
  var selectionStart=active&&typeof active.selectionStart==='number'?active.selectionStart:null;
  var selectionEnd=active&&typeof active.selectionEnd==='number'?active.selectionEnd:null;
  app.innerHTML=shell();
  bind();
  requestAnimationFrame(function(){
    var next=document.querySelector('.content');
    if(next)next.scrollTop=scrollTop;
    restoreWorkspaceScroll();
    if(activeId){var el=document.getElementById(activeId);if(el){el.focus();if(selectionStart!=null&&typeof el.setSelectionRange==='function'){try{el.setSelectionRange(selectionStart,selectionEnd==null?selectionStart:selectionEnd)}catch(_){}}}}
  });
}

bridge.onStatus(function(s){
  state.runtime=s;
  if(s&&s.maintenance){
    state.maintenance=s.maintenance;
  }
  if(s&&s.automationMode!=null){
    state.automationMode=s.automationMode;
  }
  if(s&&s.headlessBackground!=null){
    state.headlessBackground=!!s.headlessBackground;
  }
  if(s&&s.connections&&state.config){
    state.config.connections=(state.config.connections||[]).map(function(x){return Object.assign({},x,s.connections[x.id]?{runtime:s.connections[x.id]}:{})});
  }
  updateChrome();
  if(!userIsEditing()&&!state.connectionEditor){
    renderContent();
  }
});

(function(){var es;function onEvent(e){try{var item=JSON.parse(e.data);state.events.push(item);state.events=state.events.slice(-300);if(state.page==='events'){var panel=document.querySelector('.events-panel');if(panel){var empty=panel.querySelector('.empty');if(empty)empty.remove();var head=panel.querySelector('.event-head');if(head)head.insertAdjacentHTML('afterend',eventRow(item))}}}catch(_){}}try{es=new EventSource(API+'/events/stream');es.addEventListener('forgelink',onEvent);es.addEventListener('gap',function(){state.apiError='Event history gap detected; telemetry will resync automatically.';updateChrome()});es.onerror=function(){}}catch(_){}})();
(async function(){await refresh();setInterval(function(){if(!document.hidden)refresh({background:true})},1500)})();
setInterval(function(){
  var m=state.maintenance;
  if(!m||m.enabled!==true||!m.expiresAt)return;
  var remainingMs=Math.max(0,Number(m.expiresAt)-Date.now());
  if(remainingMs<=0){
    refresh();
    return;
  }
  var timeStr=formatRemainingTime(m.expiresAt);
  var ttl=Number(m.durationMs)||15*60*1000;
  var pct=Math.min(100,Math.max(0,Math.round((remainingMs/ttl)*100)));
  document.querySelectorAll('[data-maintenance-countdown]').forEach(function(el){el.textContent=timeStr+' remaining'});
  document.querySelectorAll('[data-maintenance-header-countdown]').forEach(function(el){el.textContent=timeStr});
  document.querySelectorAll('.maintenance-banner-meter i').forEach(function(el){el.style.width=pct+'%'});
},1000);
