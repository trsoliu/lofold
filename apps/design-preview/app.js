(() => {
  'use strict';
  const {icon,escape:h,hiFi,brand,concept} = window.MailUI;
  const demo=window.MailDemo, initialAccounts=demo.accounts.slice(), base=demo.messages;
  const filesById=new Map(base.flatMap(m=>m.attachments).map(a=>[a.id,a]));
  const navigation=window.MailNavigation;
  const savedSearches=window.MailSavedSearch;
  const treeStates=new Map();
  let drawerAccount=null;
  const dbKey=window.MailUI.storagePrefix+'local-mail-prototype-v1';
  function load(){try{return JSON.parse(localStorage.getItem(dbKey))||{};}catch{return {};}}
  const db=load();
  const themeOptions=window.MailDesignOptions;
  const requestedTheme=new URLSearchParams(location.search).get('theme');
  let appearance=concept&&(requestedTheme?concept:themeOptions.pick(db.appearance));
  for(const w of ['demo','empty']) db[w]??={changes:{},added:[],accounts:[]};
  let work=db.active==='empty'?'empty':'demo';
  let route={page:'inbox'}, modal='', modalData=null, lastTrigger=null, drawer=false, timer, draftTimer, formDirty=false;
  let messages=[], accounts=[], ordered=[], scrolls=new Map(), storageFailed=false;
  const q=(s,el=document)=>el.querySelector(s);
  const content=q('#content'), rail=q('#sidebar'), mobile=matchMedia('(max-width:800px)');
  const sections={search:['搜索结果','search'],inbox:['收件箱','inbox'],starred:['星标邮件','star'],drafts:['草稿箱','draft'],sent:['已发送','send'],outbox:['发件箱','outbox'],archive:['归档','archive'],local:['本地档案','folder'],attachments:['附件中心','paperclip'],ai:['AI 查信','sparkles'],storage:['本地存储','drive'],followup:['等对方回复','clock']};
  function store(snapshot=db){try{localStorage.setItem(dbKey,JSON.stringify(snapshot));storageFailed=false;return true;}catch{storageFailed=true;return false;}}
  function updateStore(edit){
    // Mail, accounts and preferences share one legacy key across both workspaces.
    if(!storageFailed)Object.assign(db,load());
    edit(db[work]);
    store();
  }
  const importedHeaders=new WeakMap();
  function parseHeaders(header){
    const fields=new Map();
    for(const line of header.replace(/^\uFEFF/,'').replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/)){
      const colon=line.indexOf(':');
      if(colon<=0)continue;
      const field=line.slice(0,colon).toLowerCase();
      if(!fields.has(field))fields.set(field,line.slice(colon+1).trim());
    }
    return name=>fields.get(name.toLowerCase())||'';
  }
  function threadHeaders(get){
    const ids=value=>value.match(/<[^<>\s]+>/g)||[];
    return {
      rfcMessageId:ids(get('Message-ID'))[0]||'',
      inReplyTo:ids(get('In-Reply-To')).join(' '),
      references:ids(get('References')),
      dateReliable:Number.isFinite(Date.parse(get('Date')))
    };
  }
  function savedSearch(id){return id&&savedSearches.list(work).find(record=>record.id===id);}
  function pageTitle(){return savedSearch(route.saved)?.name||navigation.title(route,sections);}
  function hydrate(){
    accounts=[...(work==='demo'?initialAccounts:[]),...db[work].accounts]; demo.accounts=accounts;
    messages=[...(work==='demo'?base:[]),...db[work].added].map(m=>{
      const mail={...m,...db[work].changes[m.id]};
      if(typeof m.raw==='string'&&mail.dateReliable===undefined){
        // Older imports kept the full EML but only indexed presentation fields.
        if(!importedHeaders.has(m)){
          const header=m.raw.split(/\r?\n\r?\n/,1)[0];
          importedHeaders.set(m,threadHeaders(parseHeaders(header)));
        }
        Object.assign(mail,importedHeaders.get(m));
      }
      mail.attachments=mail.attachmentIds?.map(id=>filesById.get(id)||db[work].composeFiles?.[id]).filter(Boolean)||mail.attachments||[];
      return mail;
    });
    refreshFollowups();
  }
  function refreshFollowups(){
    window.MailFollowup.refresh(work,messages,accounts,()=>{
      refreshFollowups();
      drawRail();
      if(route.page==='followup'||q('.follow-reader'))drawArea();
    });
  }
  function change(id,props){updateStore(space=>Object.assign(space.changes[id]??={},props));hydrate();}
  function add(m){updateStore(space=>space.added.unshift(m));hydrate();}
  function inScope(mail,account=route.account){return account==='all'||mail.accountId===account;}
  function byId(id){return id&&messages.find(m=>m.id===id&&inScope(m));}
  const mailboxName=id=>window.MailViews.mailboxName(id);
  function acct(id){return accounts.find(a=>a.id===id);}
  function toast(s){const t=q('#toast');t.textContent=s+(storageFailed?' 浏览器存储不可用，修改仅保留到关闭页面。':'');t.classList.add('show');clearTimeout(timer);timer=setTimeout(()=>t.classList.remove('show'),3200);}
  const productName=hiFi?brand.name:'本地邮箱';
  const mark=hiFi?'<img class="brandmark" src="'+h(brand.icon)+'" width="33" height="33" alt="">':'<span class="brandmark" aria-hidden="true"><svg viewBox="0 0 36 36"><rect x="1" y="1" width="34" height="34" rx="9" fill="#a3422f"/><path d="M7 13.5 18 9l11 4.5V24l-11 4-11-4z" fill="#f7e9cf"/><path d="m7 14 11 7 11-7M7 24l8-6m14 6-8-6" fill="none" stroke="#a3422f" stroke-width="1.5" stroke-linejoin="round"/></svg></span>';
  function button(action,label,glyph,cls='btn-neutral',extra=''){return '<button type="button" class="'+cls+'" data-action="'+action+'" '+extra+'>'+ (glyph?icon(glyph,16):'')+h(label)+'</button>';}
  function ib(action,label,glyph){return '<button type="button" class="icon-btn" data-action="'+action+'" title="'+h(label)+'" aria-label="'+h(label)+'">'+icon(glyph,18)+'</button>';}
  function validScope(id){return id==='all'||id==='local'||!!acct(id);}
  const scopeMemory={};
  function savedScope(){
    if(!scopeMemory[work]){
      try{scopeMemory[work]=localStorage.getItem(dbKey+'-scope-'+work);}catch{}
    }
    return validScope(scopeMemory[work])?scopeMemory[work]:'all';
  }
  function rememberScope(account){
    if(account===scopeMemory[work])return;
    scopeMemory[work]=account;
    // A navigation preference must never rewrite another tab's mail or drafts.
    try{localStorage.setItem(dbKey+'-scope-'+work,account);}catch{}
  }
  function treeState(){
    if(treeStates.has(work))return treeStates.get(work);
    let saved;
    try{saved=JSON.parse(localStorage.getItem(dbKey+'-tree-'+work));}catch{}
    const initial=route.account&&route.account!=='all'?[route.account]:[];
    if(hiFi&&work==='demo'&&!initial.length&&acct('studio'))initial.push('studio');
    const state={openAccounts:new Set(Array.isArray(saved?.openAccounts)?saved.openAccounts:initial),more:saved?.more===true};
    treeStates.set(work,state);return state;
  }
  function saveTree(){
    const state=treeState();
    try{localStorage.setItem(dbKey+'-tree-'+work,JSON.stringify({openAccounts:[...state.openAccounts],more:state.more}));}catch{}
  }
  function keepFolderVisible(){
    if(route.page==='search')return;
    if(['ai','attachments','storage','followup'].includes(route.page)||route.query)return;
    const state=treeState();
    if(route.account==='all'){
      if(route.page!=='inbox'&&!state.more){state.more=true;saveTree();}
    }else if(!state.openAccounts.has(route.account)){
      state.openAccounts.add(route.account);saveTree();
    }
  }
  function setRoute(next){
    const before=route;
    if(next.page==='search'&&next.saved){
      const record=savedSearch(next.saved);
      if(record&&validScope(record.account))next={...next,account:record.account,query:record.query,tab:record.tab};
      else next={page:'inbox',account:validScope(next.account)?next.account:'all'};
    }
    const account=validScope(next.account)?next.account:savedScope();
    route={...next,account};
    if(route.id&&!byId(route.id))delete route.id;
    rememberScope(account);
    if(before.account&&(before.account!==account||before.page!==route.page))keepFolderVisible();
    if(!before.account&&account==='all'&&route.page!=='inbox')keepFolderVisible();
  }
  function readLocation(){
    const [key,query='']=location.hash.slice(1).split('?');
    const params=Object.fromEntries(new URLSearchParams(query));
    const page=Object.hasOwn(sections,key)?key:'inbox';
    // Older AI bookmarks used a separate scope parameter.
    const account=params.account||(page==='ai'?params.scope:null)||savedScope();
    delete params.scope;
    if(!validScope(account))delete params.id;
    setRoute({...params,page,account});
    if(key!=='welcome')history.replaceState(history.state,'',routeUrl(route));
    draw();
    if(key==='welcome')show('welcome');
  }
  function routeUrl(r){const {page,...vals}=r;const s=new URLSearchParams(Object.entries(vals).filter(([,v])=>v!=null&&v!=='')).toString();return '#'+page+(s?'?'+s:'');}
  function stateKey(){return [work,route.page,route.account,route.tab||'',route.query||'',route.sort||'',route.file||'',route.ask||'',route.offlineFolder||'',route.saved||''].join('|');}
  function rememberScroll(){const s=q('.msg-scroll,.section-view');if(s?.getClientRects().length)scrolls.set(stateKey(),s.scrollTop);}
  function go(next,replace=false,returnTo=null){
    rememberScroll();setRoute({account:route.account,...next});
    const url=routeUrl(route);history[replace||url===location.hash?'replaceState':'pushState']({returnTo},'',url);
    closeDrawer();draw();
  }
  function nav(page,other={}){go({page,...other});}
  function switchScope(account){
    const next={...route,account};
    delete next.id;
    delete next.saved;
    const draftQuestion=q('[name=question]')?.value;
    go(next);
    if(draftQuestion&&q('[name=question]'))q('[name=question]').value=draftQuestion;
    q('#content [data-action=account-scope]')?.focus({preventScroll:true});
  }
  function scopeSelect(){return navigation.scopeSelect(accounts,messages,route.account);}
  function filtered(){
    let all=messages.filter(mail=>inScope(mail));
    if(savedSearches.isSearch(route)){const t=(route.query||'').trim().toLocaleLowerCase();if(t)all=all.filter(m=>[m.subject,m.fromName,m.fromEmail,m.to,...m.body,...m.attachments.map(a=>a.name)].join(' ').toLocaleLowerCase().includes(t));}
    else if(navigation.isAllUnread(route))all=all.filter(navigation.isReceived);
    else all=all.filter(m=>route.page==='starred'?m.starred:m.folder===route.page);
    if(route.tab==='unread')all=all.filter(m=>m.unread||m.id===route.id);if(route.tab==='files')all=all.filter(m=>m.attachments.length);
    return all.sort((a,b)=>(Date.parse(b.date)-Date.parse(a.date))*(route.sort==='old'?-1:1));
  }
  function closeDrawer(){
    drawer=false;drawerAccount=null;document.body.classList.remove('drawer-open');
    q('#main').inert=false;q('#mobile-nav').inert=false;q('.mobile-location')?.setAttribute('aria-expanded','false');
  }
  function toggleDrawer(){
    if(drawer){closeDrawer();q('.mobile-location')?.focus({preventScroll:true});return;}
    drawer=true;drawerAccount=route.account==='all'?null:route.account;
    drawRail();document.body.classList.add('drawer-open');
    q('.mobile-location')?.setAttribute('aria-expanded','true');q('#main').inert=true;q('#mobile-nav').inert=true;
    q('.mobile-drawer-head button')?.focus({preventScroll:true});
  }
  function toggleAccount(id){
    if(!validScope(id)||id==='all')return;
    const state=treeState();
    if(mobile.matches){drawerAccount=id;}
    else{
      if(state.openAccounts.has(id))state.openAccounts.delete(id);else state.openAccounts.add(id);
      saveTree();
    }
    drawRail();
    const area=mobile.matches?'.mobile-account-list':'.desktop-folder-tree';
    const row=[...rail.querySelectorAll(area+' .tree-account')].find(el=>el.dataset.account===id);
    row?.focus({preventScroll:true});
    const branch=mobile.matches?q('.mobile-folder-group'):row?.nextElementSibling;
    if(!row||!branch?.matches('.tree-folders,.mobile-folder-group'))return;
    const scroller=q('.rail-scroll'),viewport=scroller.getBoundingClientRect();
    const bottom=branch.getBoundingClientRect().bottom;
    if(bottom>viewport.bottom){
      const anchor=mobile.matches?branch:row;
      scroller.scrollTop+=Math.min(bottom-viewport.bottom,Math.max(0,anchor.getBoundingClientRect().top-viewport.top));
    }
  }
  function openSavedSearch(id){
    const record=savedSearch(id);
    if(!record){toast('此搜索已取消固定。');drawRail();return;}
    if(!validScope(record.account)){toast('这个搜索使用的邮箱已移除。');return;}
    go({page:'search',saved:id});
    (mobile.matches?q('.mobile-location'):q('.saved-shortcut.active'))?.focus({preventScroll:true});
  }
  function openFolder(page,account,tab=''){
    if(!validScope(account)||!sections[page])return;
    if(account!=='all'&&!treeState().openAccounts.has(account)){treeState().openAccounts.add(account);saveTree();}
    nav(page,{account,...(tab?{tab}:{})});
    const focus=mobile.matches?q('.mobile-location'):q('#sidebar [aria-current=page].active');
    focus?.focus({preventScroll:true});
  }
  function drawRail(){
    const scroll=q('.rail-scroll')?.scrollTop||0;
    const groups=navigation.render({route,accounts,messages,sections,...treeState(),pending:drawerAccount,saved:savedSearches.list(work)});
    const storageSample=hiFi?'':'<div class="storage-gauge" aria-hidden="true"><i></i></div><small class="storage-num">压缩样本 · 已节省 488 KiB</small>';
    const footer='<div class="rail-footer"><button class="nav-btn '+(route.page==='storage'?'active':'')+'" data-action="nav" data-page="storage">'+icon('drive',17)+'<span>本地存储</span>'+icon('chevron-right',14)+'</button>'+storageSample+'<button class="nav-btn" data-action="settings">'+icon('settings',16)+'<span>工作区设置</span></button></div>';
    const drawerTitle=hiFi?'<div class="drawer-brand">'+mark+'<h2>邮箱与文件夹</h2></div>':'<h2>邮箱与文件夹</h2>';
    rail.innerHTML='<button class="brand" data-action="home" aria-label="'+h(productName)+'，返回所有收件箱">'+mark+h(productName)+'</button>'+
      '<div class="mobile-drawer-head">'+drawerTitle+ib('drawer','关闭邮箱与文件夹','x')+'</div>'+
      '<button class="primary rail-compose" data-action="compose">'+icon('pen',18)+'写邮件<kbd class="key">N</kbd></button>'+
      '<div class="rail-scroll">'+groups+'</div>'+footer;
    q('.rail-scroll').scrollTop=scroll;
    const mobilePages=[['inbox','邮箱'],['attachments','附件'],['ai','AI 查信'],['storage','存储']];
    q('#mobile-nav').innerHTML=mobilePages.map(([page,label])=>{
      const active=route.page===page||(page==='inbox'&&!['ai','storage','attachments','followup'].includes(route.page));
      return '<button class="bottom-item'+(active?' active':'')+'" data-action="nav" data-page="'+page+'"'+(active?' aria-current="page"':'')+'>'+icon(sections[page][1],19)+label+'</button>';
    }).join('');
  }
  function mobileCaption(){
    const name=pageTitle();
    if(route.page==='search')return '<span class="location-folder">'+h(name)+'</span>';
    if(!route.query&&route.account!=='all'&&name!==sections[route.page][0]&&!['ai','attachments','storage','followup'].includes(route.page)){
      return '<span class="location-account">'+h(mailboxName(route.account))+'</span><span class="location-folder"> · '+h(sections[route.page][0])+'</span>';
    }
    return '<span class="location-folder">'+h(name)+'</span>';
  }
  function drawTop(){
    const locationButton='<button class="mobile-location mobile-menu" data-action="drawer" aria-expanded="false" aria-controls="sidebar">'+icon('menu',18)+mobileCaption()+'</button>';
    const desktopCrumb=hiFi?'':'<div class="crumb">'+icon('panel',15)+'<span>工作台</span><span class="sep">/</span><strong>'+h(['ai','storage','attachments','followup'].includes(route.page)?sections[route.page][0]:'邮件')+'</strong></div>';
    const searchLabel=mobile.matches?'搜索邮件':'搜索邮件与附件';
    const shortcut=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘ K':'Ctrl K';
    const search='<label class="findbox">'+icon('search',16)+'<input id="mail-search" type="search" aria-label="搜索邮件与附件" placeholder="'+searchLabel+'" value="'+h(route.query||'')+'"><kbd class="key">'+shortcut+'</kbd></label>';
    const status='<span class="top-status"><i class="status-dot"></i>本机模式</span>';
    const workspace='<button class="workspace-btn" data-action="welcome">'+(work==='demo'?'演示工作区':'我的工作区')+icon('chevron-down',13)+'</button>';
    q('#top').innerHTML=locationButton+desktopCrumb+'<div class="top-right">'+search+status+workspace+'</div>';
  }
  function dayOf(value){const date=new Date(value);return Number.isNaN(+date)?'':new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
  function groupName(day){const anchor=work==='demo'?dayOf(demo.asOf):dayOf(new Date()); if(day===anchor)return '今天';if(Date.parse(anchor)-Date.parse(day)===86400000)return '昨天';return day.slice(5).replace('-','月')+'日';}
  function displayTime(v){const d=new Date(v);return Number.isNaN(+d)?'':new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'}).format(d);}
  function mailRow(m,selected){
    const color=/^#[\da-f]{6}$/i.test(m.avatar)?m.avatar:'#dce6df';
    const accountTag=route.account==='all'?'<span class="row-account" title="'+h(mailboxName(m.accountId))+'">'+h(mailboxName(m.accountId))+'</span>':'';
    return '<button type="button" class="mail-row '+(m.id===selected?'selected ':'')+(m.unread?'unread':'')+'" data-action="select" data-id="'+h(m.id)+'" '+(m.id===selected?'aria-current="true"':'')+'><span class="row-first"><span class="row-avatar" aria-hidden="true" style="background:'+color+'">'+h((m.fromName||'邮').slice(0,1))+'</span><span class="row-author">'+h(m.fromName||m.fromEmail)+'</span>'+accountTag+'<time class="row-time">'+displayTime(m.date)+'</time>'+(m.unread?'<i class="row-unread" aria-label="未读"></i>':'')+'</span><span class="row-subject">'+h(m.subject||'无主题')+'</span><span class="row-bottom"><span class="row-preview">'+h(m.preview||'空白草稿')+'</span>'+(m.attachments.length?icon('paperclip',13):'')+(m.starred?'<span class="star-on">'+icon('star',13)+'</span>':'')+'</span></button>';
  }
  function empty(title,tip,act=''){return '<div class="empty-box">'+icon('inbox',31)+'<h3>'+h(title)+'</h3><p>'+h(tip)+'</p>'+act+'</div>';}
  function drawMail(){
    ordered=filtered();let selected=ordered.find(m=>m.id===route.id)||ordered[0];if(mobile.matches&&!route.id)selected=null;
    const title=pageTitle(),searching=savedSearches.isSearch(route);
    let prev='',html='';
    for(const m of ordered){const d=dayOf(m.date);if(prev!==d){html+='<div class="date-group">'+h(groupName(d))+'</div>';prev=d;}html+=mailRow(m,selected?.id);}
    const shown=ordered.filter(m=>m.unread).length;
    const scopeLabel=navigation.isAllUnread(route)?shown+' 封未读邮件':searching?'匹配 '+ordered.length+' 封':ordered.length+' 封邮件'+(shown?' · '+shown+' 封未读':'');
    const listAction=route.page==='local'?ib('import','导入 EML','import'):ib('sort',route.sort==='old'?'最早在前，切换为最新在前':'最新在前，切换为最早在前','sort');
    const folderOffline=acct(route.account)&&!route.query&&['inbox','archive','sent','drafts','outbox','local'].includes(route.page);
    const listTools='<div class="folder-tools">'+(folderOffline?ib('offline-folder','准备此文件夹离线使用','download'):'')+listAction+'</div>';
    const filters=navigation.isAllUnread(route)?'':[['','全部'],['unread','未读'],['files','含附件']].map(([v,t])=>'<button class="chip '+((route.tab||'')===v?'active':'')+'" aria-pressed="'+((route.tab||'')===v)+'" data-action="tab" data-tab="'+v+'">'+t+'</button>').join('');
    const blank=searching||route.tab?empty('没有匹配的邮件',route.saved?'符合条件的邮件会自动出现在这里。':'试试其他关键词或筛选条件。',route.saved?'':button('clear','清除筛选','search')):empty('这里还没有邮件',route.page==='local'?'导入一封 EML，离线查看原信。':'这里会显示当前文件夹中的邮件。',route.page==='local'||work==='empty'?button('import','导入邮件','import'):'');
    content.innerHTML='<div class="mail-panes"><section class="mail-column" aria-label="邮件列表"><div class="list-head"><div class="list-head-top"><div><h1>'+h(title)+'</h1><p class="info">'+h(scopeLabel)+'</p></div>'+listTools+'</div>'+(searching?'<div class="search-scope-actions">'+scopeSelect()+button(route.saved?'unpin-search':'pin-search',route.saved?'取消固定':'固定搜索',null,'btn-small')+'</div>':'')+(filters?'<div class="chips">'+filters+'</div>':'')+'</div><div class="msg-scroll">'+(html||blank)+'</div></section><section class="read-column" aria-label="阅读邮件">'+window.MailReader.render(selected,acct(selected?.accountId),history.state?.returnTo?.page ? sections[history.state.returnTo.page]?.[0] : '')+'</section></div>'+(!route.id?'<button class="mobile-compose" data-action="compose" aria-label="写邮件">'+icon('pen',21)+'</button>':'');
    if(selected){
      q('.reader-footer')?.insertAdjacentHTML('beforebegin',window.MailFollowup.reader(selected,messages));
    }
    if(selected?.folder==='outbox'){const b=q('.reader-body');if(b)b.insertAdjacentHTML('beforebegin','<p class="outbox-note">'+icon('clock',15)+' 已保存在本机发件箱，演示不会投递。</p>');}
    if(selected?.folder==='drafts'){const f=q('.reader-footer');if(f)f.innerHTML=button('edit-draft','继续编辑','pen','btn-neutral','data-id="'+h(selected.id)+'"');}
    document.body.classList.toggle('mobile-reading',!!selected&&!!route.id);
    q('.msg-scroll').scrollTop=scrolls.get(stateKey())||0;
  }
  function allFiles(){return messages.filter(m=>inScope(m)).flatMap(m=>m.attachments.map(a=>({...a,messageId:m.id,accountId:m.accountId,date:m.date}))).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));}
  function drawAttachments(){
    const term=(route.file||'').trim().toLowerCase(); const filtered=allFiles().filter(f=>f.name.toLowerCase().includes(term));
    const rows=filtered.map(f=>'<div class="attachment-line"><span class="file-symbol">'+h((f.kind||'FILE').toUpperCase())+'</span><button class="att-name" data-action="attachment" data-id="'+h(f.id)+'" data-mail="'+h(f.messageId)+'"><strong>'+h(f.name)+'</strong><small>'+h(f.size)+(route.account==='all'?' · '+h(mailboxName(f.accountId)):'')+'</small></button>'+button('open-message','原信','arrow-up-right','btn-small','data-id="'+h(f.messageId)+'"')+'</div>').join('');
    return '<section class="aux-inner"><div class="aux-head"><div><h1>附件中心</h1><p>'+filtered.length+' 个附件</p></div>'+scopeSelect()+'</div><label class="findbox file-find">'+icon('search',16)+'<input id="file-search" aria-label="按文件名查找附件" placeholder="按文件名查找" value="'+h(route.file||'')+'"></label><div class="attachment-list">'+(rows||empty('没有匹配的附件','可调整文件名，或打开含附件的示例邮件。'))+'</div></section>';
  }
  function drawArea(){
    document.body.classList.remove('mobile-reading');
    if(!['storage','ai','attachments','followup'].includes(route.page)){drawMail();return;}
    ordered=[];
    let html;
    if(route.page==='storage'){
      html=window.MailViews.storage({
        messages,accounts,work,account:route.account,folder:route.offlineFolder||'inbox',
        onScopeChange(account,folder,control){
          go({page:'storage',account,offlineFolder:folder});
          content.querySelector(control==='folder'?'[data-offline-scope=folder]':'[data-offline-scope=account]')?.focus({preventScroll:true});
        }
      });
    }else if(route.page==='followup'){
      html=window.MailFollowup.page(route.account,scopeSelect(),messages,work==='demo'?demo.asOf:null);
    }else if(route.page==='ai'){
      html=window.MailViews.ai(messages,route.account,route.ask||'',scopeSelect());
    }else{
      html=drawAttachments();
    }
    content.innerHTML='<div class="section-view">'+html+'</div>';
    if(route.page==='storage')window.MailOffline.mount(content);
    q('.section-view').scrollTop=scrolls.get(stateKey())||0;
  }
  function updatePageTitle(){
    const name=pageTitle();
    const locationButton=q('.mobile-location');
    if(locationButton){locationButton.innerHTML=icon('menu',18)+mobileCaption();locationButton.setAttribute('aria-label','邮箱与文件夹，当前'+name);}
    const crumb=q('.crumb strong');
    if(crumb)crumb.textContent=savedSearches.isSearch(route)||['ai','storage','attachments','followup'].includes(route.page)?name:'邮件';
    document.title=name+' · '+productName;
  }
  function draw(){drawRail();drawTop();drawArea();updatePageTitle();}
  function selectedMail(){return ordered.find(m=>m.id===route.id)||ordered[0];}
  function readMail(id,fromList=false){
    const m=byId(id);if(!m)return;
    if(m.folder==='drafts'&&fromList){editDraft(m);return;}
    const origin=(!fromList&&['ai','attachments','followup'].includes(route.page))?{...route}:null;
    if(m.unread)change(id,{unread:false});
    const next=fromList||route.id===id?{...route,id}:{page:m.folder,id};
    go(next,false,origin||(!fromList&&route.id===id?history.state?.returnTo:null));
    q('#reader-subject')?.focus({preventScroll:true});
  }
  function today(){return new Date().toISOString();}
  const identityCache = new Map();
  const validRecipient = address => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address);
  function identityKey(recipient=''){
    return dbKey+'-identity-'+work+'-'+(recipient?'contact-'+recipient.trim().toLowerCase():'default');
  }
  function identity(recipient=''){
    const key=identityKey(recipient);
    let id=identityCache.get(key);
    try{id=localStorage.getItem(key);}catch{}
    return acct(id);
  }
  function rememberIdentity(id,recipient=''){
    const key=identityKey(recipient);
    try{
      if(id)localStorage.setItem(key,id);else localStorage.removeItem(key);
    }catch{
      toast('浏览器未能保存发件偏好，本次选择仍可用于当前邮件。');
      return false;
    }
    identityCache.set(key,id);
    return true;
  }
  function senderSettings(){
    if(!accounts.length)return '';
    const selected=identity()?.id;
    const options=accounts.map(a=>'<option value="'+h(a.id)+'"'+(a.id===selected?' selected':'')+'>'+h(a.email)+'</option>').join('');
    return '<label class="field">统一写信的默认发件邮箱<select data-action="default-sender"><option value="">下次写信时选择</option>'+options+'</select></label>';
  }
  function editDraft(m){
    show('compose',{id:m.id,accountId:m.accountId,to:m.to,subject:m.subject,followDays:m.followDays,body:m.body.join('\n\n'),attachments:[...m.attachments],threadId:m.threadId,isReply:m.isReply});
  }
  function composeFor(action,m){
    if(!m){
      let accountId=route.account;
      if(accountId==='all'){
        accountId=accounts.length ? (identity()?.id || '') : 'local';
        if(accounts.length===1)accountId=accounts[0].id;
      }
      show('compose',{accountId,chooseDefault:!accountId,attachments:[]});
      return;
    }
    const reply=action==='reply', subject=m.subject||'无主题',prefix=reply?'回复：':'转发：';
    const ownAddress=acct(m.accountId)?.email.toLowerCase();
    const recipient=ownAddress&&ownAddress===m.fromEmail?.toLowerCase()?m.to:m.fromEmail;
    show('compose',{accountId:m.accountId,to:reply?recipient:'',subject:subject.startsWith(prefix)?subject:prefix+subject,isReply:reply,body:reply?'':'\n\n—— 转发的邮件 ——\n'+m.fromName+'\n'+subject+'\n\n'+m.body.join('\n\n'),attachments:reply?[]:[...m.attachments],threadId:m.threadId});
  }
  function composeValues(){
    const d=q('.mx-compose');
    return {to:q('[name=to]',d).value.trim(),subject:q('[name=subject]',d).value.trim(),body:q('[name=body]',d).value,accountId:q('[name=accountId]',d).value};
  }
  function drawContactPreference(){
    const box=q('#compose-contact');
    const {to,accountId}=composeValues();
    if(accounts.length<2||!validRecipient(to)||!acct(accountId)){box.replaceChildren();return;}
    const usual=identity(to);
    let html=usual?'<span>常用发件人 '+h(usual.email)+'</span>':'';
    if(!usual||usual.id!==accountId){
      html+=button('pin-contact-sender',usual?'更新常用邮箱':'为此收件人记住发件邮箱',null,'mx-identity-action');
    }
    if(usual)html+=button('forget-contact-sender','取消指定',null,'mx-identity-action');
    if(box.innerHTML!==html)box.innerHTML=html;
  }
  function drawComposeFiles(){
    q('#compose-files').innerHTML=modalData.attachments.map(a=>'<div class="mx-compose-file">'+icon('paperclip',14)+'<span>'+h(a.name)+'</span><button type="button" data-action="remove-compose-file" data-id="'+h(a.id)+'" aria-label="移除 '+h(a.name)+'">'+icon('x',14)+'</button></div>').join('');
  }
  function hideSendReview(){
    const panel=q('#compose-review');
    panel.hidden=true;
    panel.replaceChildren();
    delete modalData.review;
  }
  function markComposeEdited(){
    formDirty=true;
    hideSendReview();
    q('#compose-error').textContent='';
    clearTimeout(draftTimer);
    draftTimer=setTimeout(()=>saveCompose(false,true),400);
  }
  function checkBeforeSend(data,confirmed){
    // A quoted or forwarded message can refer to its own attachments.
    const ownBody=data.body.split(/^[ \t]*—— 转发的邮件 ——/m)[0].split('\n').filter(line=>!/^\s*>/.test(line)).join('\n');
    const mentionsFile=/(?:见|看|查收|查阅|查看|请收|放在)\s*(?:随信)?附件|附件\s*(?:里|中|是|为|有)|随信附上|请见随附|\b(?:attached|enclosed)\b/i.test(ownBody);
    const missing=mentionsFile&&!modalData.attachments.length;
    const usual=identity(data.to), conflict=usual&&data.accountId!==usual.id;
    if(!missing&&!conflict)return true;
    const signature=JSON.stringify([data.to,data.accountId,missing,usual?.id,data.body]);
    if(confirmed&&modalData.review===signature)return true;
    modalData.review=signature;
    const panel=q('#compose-review');
    panel.innerHTML='<strong>发送前检查</strong>'+
      (missing?'<p>正文提到了附件，这封邮件还没有附上文件。</p>':'')+
      (conflict?'<p>'+h(data.to)+' 的常用发件人是 '+h(usual.email)+'。当前选中 '+h(acct(data.accountId).email)+'。</p>':'')+
      '<div class="mx-review-actions">'+(missing?button('pick-compose-file','补上附件','paperclip','mx-sub-btn'):'')+
      (conflict?button('use-contact-sender','切换到'+usual.email,null,'mx-sub-btn'):'')+
      button('send-reviewed','仍然模拟发送',null,'mx-identity-action')+'</div>';
    panel.hidden=false;
    panel.focus();
    return false;
  }
  async function addComposeFiles(input){
    const files=Array.from(input.files);
    if(!files.length||modalData.reading)return;
    const compose=modalData;
    compose.reading=true;
    q('[data-action="pick-compose-file"]').disabled=true;
    try{
      const batch=[];
      for(const file of files){
        // This offline HTML stores selected files in the browser's small localStorage quota.
        if(file.size>2*1024*1024)throw Error('原型支持单个 2 MiB 以内的测试附件，请重新选择。');
        const dataUrl=await new Promise((resolve,reject)=>{
          const reader=new FileReader();
          reader.onload=()=>resolve(reader.result);
          reader.onerror=()=>reject(Error('文件读取失败，请重新选择。'));
          reader.readAsDataURL(file);
        });
        const size=file.size<1024?file.size+' B':(file.size/1024).toFixed(1)+' KiB';
        batch.push({id:'upload-'+cryptoID(),name:file.name,kind:file.name.split('.').slice(1).pop()?.slice(0,8).toLowerCase()||'file',type:file.type||'application/octet-stream',bytes:file.size,size,dataUrl});
      }
      if(compose!==modalData)return;
      compose.attachments.push(...batch);
      drawComposeFiles();
      markComposeEdited();
      q('[data-action="pick-compose-file"]').disabled=false;
      q('[data-action="pick-compose-file"]').focus();
    }catch(err){
      if(compose===modalData)q('#compose-error').textContent=err.message||'无法添加附件。';
    }finally{
      compose.reading=false;
      if(compose===modalData){input.value='';q('[data-action="pick-compose-file"]').disabled=false;}
    }
  }
  function writeCompose(fields){
    const saved=load();
    const previous=saved[work]||db[work],existing=!!modalData.id;
    const next={...previous,composeFiles:{...previous.composeFiles}};
    if(existing)next.changes={...previous.changes,[fields.id]:{...previous.changes[fields.id],...fields}};
    else next.added=[fields,...previous.added];
    for(const file of modalData.attachments){
      if(!filesById.has(file.id))next.composeFiles[file.id]=file;
    }
    const referenced=new Set();
    for(const original of [...(work==='demo'?base:[]),...next.added]){
      const mail={...original,...next.changes[original.id]};
      for(const id of mail.attachmentIds||[])referenced.add(id);
    }
    for(const id of Object.keys(next.composeFiles)){
      if(!referenced.has(id))delete next.composeFiles[id];
    }
    const snapshot={...db,...saved,[work]:next};
    if(!store(snapshot)){
      q('#compose-error').textContent='草稿未能存入浏览器。请腾出本机浏览器空间或移除较大的附件后重试。';
      return false;
    }
    Object.assign(db,snapshot);
    hydrate();
    modalData.id=fields.id;
    return true;
  }
  function saveCompose(send=false,background=false,confirmed=false){
    if(modal!=='compose')return false;
    if(modalData.reading){if(!background)toast('正在读取附件，请稍候。');return false;}
    const data=composeValues();
    if(send){
      const error=!acct(data.accountId)?(accounts.length?'请选择发件邮箱。':'请先添加示例邮箱，也可以保存本地草稿。'):!validRecipient(data.to)?'请输入一个有效的收件地址。':!data.subject?'请填写邮件主题。':'';
      if(error){q('#compose-error').textContent=error;q('[name='+(!acct(data.accountId)?'accountId':!validRecipient(data.to)?'to':'subject')+']').focus();return false;}
      if(!checkBeforeSend(data,confirmed))return false;
    }
    if(!data.subject&&!data.body.trim()&&!data.to&&!modalData.attachments.length&&!modalData.id){if(!background)dismiss();return false;}
    const account=acct(data.accountId);
    const fields={...data,accountId:account?.id||'local',id:modalData.id||'draft-'+cryptoID(),fromEmail:account?.email||'',fromName:'我',folder:send?'outbox':'drafts',body:data.body.split(/\n\s*\n/),preview:data.body.slice(0,100),unread:false,starred:false,date:today(),attachmentIds:modalData.attachments.map(a=>a.id),threadId:modalData.threadId,isReply:!!modalData.isReply,followDays:Number(q('[name=followDays]').value)};
    if(!writeCompose(fields))return false;
    if(background){
      q('.mx-demo-note').textContent='草稿已存本机';
      drawRail();return true;
    }
    dismiss();
    if(inScope(fields)){
      go({page:fields.folder,id:fields.id});
      toast(send?'已放入演示发件箱，仅在本机保存。':'草稿已保存。');
    }else{
      go({...route,id:undefined},true);
      toast('已存入「'+mailboxName(fields.accountId)+'」的'+sections[fields.folder][0]+'。');
    }
    return true;
  }
  function cryptoID(){return globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);}
  function switchWork(w){work=w;updateStore(()=>{db.active=w;});hydrate();scrolls.clear();dismiss();nav('inbox',{account:savedScope()});}
  function attachData(id,mailId){const source=byId(mailId)||selectedMail();const f=source?.attachments.find(a=>a.id===id);return f?{...f,messageId:source.id}:allFiles().find(a=>a.id===id);}
  function plain(title,body){return '<div class="plain-dialog"><div class="dialog-head"><h2>'+h(title)+'</h2>'+ib('close-modal','关闭弹窗','x')+'</div>'+body+'</div>';}
  function appearanceSettings(){
    if(!concept)return '<div class="option-row"><span>外观<small>浅色、深色或跟随系统</small></span><select data-action="theme" aria-label="外观主题">'+[['system','跟随系统'],['light','浅色'],['dark','深色']].map(([value,label])=>'<option value="'+value+'" '+((db.theme||'system')===value?'selected':'')+'>'+label+'</option>').join('')+'</select></div>';
    if(window.top!==window)return '';
    const choices=themeOptions.themes.map(item=>'<option value="'+item.id+'" '+(appearance===item?'selected':'')+'>'+h(item.name+(item.tier?' · '+item.tier:''))+'</option>');
    return '<label class="option-row"><span>主题色</span><select data-action="appearance" aria-label="主题色">'+choices.join('')+'</select></label>';
  }
  function modalHtml(){
    if(modal==='welcome')return window.MailViews.welcome()+(hiFi?'':button('close-modal','返回工作台',null,'welcome-close'));
    if(modal==='compose')return window.MailViews.compose(modalData||{});
    if(modal==='settings')return plain('工作区设置',senderSettings()+appearanceSettings()+'<div class="option-row"><span>当前工作区<small>'+(work==='demo'?'合成邮件，仅供演示':'本地空白工作区')+'</small></span>'+button('welcome','切换工作区','layers','btn-small')+'</div><div class="option-row"><span>本地档案<small>可导入 UTF-8 纯文本邮件</small></span>'+button('import','导入 EML','import','btn-small')+'</div>'+ (window.MailUI.storagePrefix ? '' : '<div class="option-row"><span>设计预览</span><a href="review.html">原型审阅</a></div>'));
    if(modal==='pin-search')return plain('固定常用搜索',savedSearches.editor(modalData,['all',...navigation.accountIds(accounts,messages,modalData.account)],mailboxName));
    if(modal==='import')return plain('导入本地邮件','<p>归入'+h(route.account==='all'||route.account==='local'?'未绑定邮箱的本地档案':'「'+mailboxName(route.account)+'」的本地档案')+'。</p><p>可使用随附样信，或选择不超过 256 KiB 的 UTF-8 纯文本 EML。原型将邮件保存在当前浏览器，未加密，请使用测试文件。</p><div class="dialog-actions">'+button('import-sample','导入随附样信','mail','primary')+'<label class="btn-neutral">'+icon('import',15)+'选择 EML<input id="eml-file" type="file" accept=".eml,message/rfc822" class="visually-hidden"></label></div><p id="import-error" class="hint-error" role="alert"></p>');
    if(modal==='add-account')return plain('添加示例邮箱','<p>仅在本机建立演示身份。正式客户端的服务商授权尚未接入。</p><form id="account-form"><label class="field">邮箱名称<input name="label" required maxlength="24" placeholder="例如：个人邮箱"></label><label class="field">示例地址<input name="email" type="email" required placeholder="you@example.test"></label><p class="hint-error" id="account-error" role="alert"></p><button type="submit" class="primary">添加并切换邮箱</button></form>');
    if(modal==='more'){const m=byId(modalData?.id);return plain('邮件操作','<div class="dialog-actions">'+button('forward','转发','forward','btn-neutral','data-id="'+h(m.id)+'"')+button('export-eml',m.raw?'导出原始 EML':'导出正文 EML','download','btn-neutral','data-id="'+h(m.id)+'"')+'</div>');}
    if(modal==='attachment'){
      const a=modalData;
      return plain(a.name,'<p>'+h(a.size)+' · '+h(a.kind?.toUpperCase()||'文件')+'</p>'+(a.previewUrl?'<img class="asset-preview" src="'+h(a.previewUrl)+'" alt="附件封面预览">':a.previewText?'<pre>'+h(a.previewText)+'</pre>':'')+'<div class="dialog-actions">'+(a.dataUrl?'<a class="btn-neutral" download="'+h(a.name)+'" href="'+h(a.dataUrl)+'">'+icon('download',16)+'下载附件</a>':'')+button('open-message','定位原信','arrow-up-right','btn-neutral','data-id="'+h(a.messageId)+'"')+'</div>');
    }return '';
  }
  function show(name,data=null){
    if(!modal)lastTrigger=drawer?q('.mobile-location'):document.activeElement;
    closeDrawer();modal=name;modalData=data;formDirty=false;
    q('#modal-root').innerHTML='<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-label="'+h(({compose:'写邮件',welcome:'工作区',settings:'工作区设置',attachment:'附件预览',import:'导入邮件','add-account':'添加示例邮箱',more:'更多操作','pin-search':'固定常用搜索'})[name]||'窗口')+'">'+modalHtml()+'</div></div>';
    if(name==='attachment')window.MailOffline.attachDownload(q('#modal-root a[download]'),work,byId(data.messageId)?.accountId,data);
    q('#shell').inert=true; document.body.classList.add('modal-open');
    if(name==='compose'){drawContactPreference();drawComposeFiles();}
    const target=name==='pin-search'?q('#save-search-form [name=name]'):name==='compose'?(data.chooseDefault?q('[name=accountId]'):data.isReply?q('[name=body]'):q('[name=to]')):q('.dialog button,.dialog input');target?.focus({preventScroll:true});
  }
  function dismiss(){if(!modal)return;clearTimeout(draftTimer);modal='';modalData=null;formDirty=false;q('#modal-root').innerHTML='';q('#shell').inert=false;document.body.classList.remove('modal-open');if(lastTrigger?.isConnected)lastTrigger.focus({preventScroll:true});}
  function requestClose(){if(modal==='compose'&&modalData.reading){toast('正在读取附件，请稍候。');return;}if(modal==='compose'&&formDirty){saveCompose(false);return;}dismiss();}
  function theme(){
    if(appearance){themeOptions.apply(appearance);return;}
    const systemTheme=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
    document.documentElement.dataset.theme=db.theme&&db.theme!=='system'?db.theme:systemTheme;
  }
  function saveImport(raw){
    if(raw.length>262144)throw Error('样信超过 256 KiB。');
    const parts=raw.replace(/^\uFEFF/,'').split(/\r?\n\r?\n/);if(parts.length<2)throw Error('文件缺少邮件头或正文。');
    const get=parseHeaders(parts.shift()),body=parts.join('\n\n');
    const type=get('Content-Type'),enc=get('Content-Transfer-Encoding');
    if(type&&!/^text\/plain\b/i.test(type)||enc&&!/^(7bit|8bit|binary)$/i.test(enc)||/=\?[^?]+\?[bq]\?/i.test(get('Subject'))||(/charset\s*=/i.test(type)&&!/charset\s*=\s*["']?(utf-8|us-ascii)\b/i.test(type)))throw Error('此原型只预览 UTF-8 纯文本 EML；此种编码或附件请用随附样信体验。');
    if(!get('Subject')&&!get('From'))throw Error('未识别到发件人或主题。');
    const accountId=route.account==='all'?'local':route.account;
    const prior=messages.find(m=>m.accountId===accountId&&m.raw===raw);if(prior){dismiss();go({page:prior.folder,id:prior.id});toast('这封邮件已导入，已打开原信。');return;}
    const from=get('From'),address=from.match(/<([^<>]+)>/),dt=Date.parse(get('Date')),id='local-'+cryptoID();
    add({id,accountId,folder:'local',fromName:address?from.split('<')[0].trim().replace(/^"|"$/g,'')||address[1]:from,fromEmail:address?.[1]||from,to:get('To'),subject:get('Subject')||'无主题',body:body.trim().split(/\n\s*\n/),preview:body.trim().slice(0,100),date:Number.isNaN(dt)?today():new Date(dt).toISOString(),...threadHeaders(get),unread:false,starred:false,raw,attachments:[]});dismiss();go({page:'local',id});toast('已导入本地档案。');
  }
  const sample='From: 林夕 <linxi@example.test>\nTo: 周予 <zhouyu@example.test>\nDate: Fri, 20 Nov 2026 11:45:00 +0800\nSubject: 周末散步的集合地点\nMessage-ID: <walking-route-1120@example.test>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n\n周予，你好：\n\n周六上午九点，我们在公园西门的木椅旁见面。当天的路线已经走过，沿河的一段很适合拍照。\n\n林夕\n';
  function download(m){
    const isImported=typeof m.raw==='string';
    const bytes=isImported?m.raw:['From: '+m.fromEmail,'To: '+m.to,'Subject: '+m.subject,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: 8bit','',m.body.join('\r\n\r\n')].join('\r\n');
    const url=URL.createObjectURL(new Blob([bytes],{type:'message/rfc822'})),a=document.createElement('a');a.href=url;a.download=(m.subject||'邮件').replace(/[\\/:*?"<>|]/g,'_')+'.eml';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);toast(isImported?'原始 EML 已导出。':'示例正文已导出为 EML，附件可从附件卡单独下载。');
  }
  function ask(question){const value=String(question||'').trim();if(value){go({...route,ask:value});}else q('[name=question]')?.focus();}
  document.addEventListener('click',event=>{
    const addresses=q('.reader-addresses[open]');
    if(addresses&&!addresses.contains(event.target))addresses.open=false;
    const b=event.target.closest('[data-action]');
    if(!b){if(event.target.classList.contains('overlay'))requestClose();return;}
    const a=b.dataset.action,id=b.dataset.id,m=byId(id)||selectedMail();
    if(a==='offline-folder'){go({page:'storage',account:route.account,offlineFolder:route.page});return;}
    if(a==='home'){nav('inbox',{account:'all'});return;}
    if(a==='pin-search'){show('pin-search',{...route,account:drawerAccount||route.account});return;}
    if(a==='open-saved-search'){openSavedSearch(b.dataset.search);return;}
    if(a==='unpin-search'){
      try{savedSearches.remove(work,route.saved);}
      catch(error){toast(error.message);return;}
      const next={...route};delete next.saved;
      go(next,true);q('.search-scope-actions [data-action=pin-search]')?.focus();toast('已取消固定。');return;
    }
    if(a==='tree-account'){toggleAccount(b.dataset.account);return;}
    if(a==='folder'||a==='shortcut'){openFolder(b.dataset.page,b.dataset.account,b.dataset.tab);return;}
    if(a==='more-shortcuts'){const state=treeState();state.more=!state.more;saveTree();drawRail();q('.more-shortcuts')?.focus({preventScroll:true});return;}
    if(a==='nav'){nav(b.dataset.page,drawerAccount?{account:drawerAccount}:{});return;}
    if(a==='select'){readMail(id,true);return;}
    if(a==='open-message'){dismiss();readMail(id);return;}
    if(a==='tab'||a==='sort'||a==='clear'){const r={...route};delete r.id;if(a==='tab'){if(r.tab!==b.dataset.tab)delete r.saved;r.tab=b.dataset.tab;}if(a==='sort')r.sort=r.sort==='old'?'':'old';if(a==='clear'){if(r.page==='search')r.page='inbox';delete r.query;delete r.tab;delete r.saved;}go(r);return;}
    if(a==='back-list'){
      const id=route.id,prev=history.state?.returnTo;
      if(prev){go(prev,true);const hit=[...content.querySelectorAll('[data-action="open-message"]')].find(el=>el.dataset.id===id);hit?.focus({preventScroll:true});}
      else{const r={...route};delete r.id;go(r,true);const row=[...content.querySelectorAll('.mail-row')].find(el=>el.dataset.id===id);(row||q('.chip.active'))?.focus({preventScroll:true});}
      return;
    }
    if(a==='star'||a==='toggle-read'||a==='archive'){
      if(!m)return;rememberScroll();
      if(a==='star')change(m.id,{starred:!m.starred});
      if(a==='toggle-read')change(m.id,{unread:!m.unread});
      if(a==='archive'){const old=m.folder==='archive',folder=old?(m.archivedFrom||(m.raw||m.accountId==='local'?'local':'inbox')):'archive';change(m.id,{folder,archivedFrom:old?null:m.folder});const r={...route};delete r.id;go(r,true);toast(old?'已移回'+sections[folder][0]+'。':'邮件已归档。');return;}
      draw();toast(a==='star'?(m.starred?'已取消星标。':'已添加星标。'):(m.unread?'已标为已读。':'已标为未读。'));return;
    }
    if(a==='drawer'){toggleDrawer();return;}
    if(['welcome','settings','add-account','import'].includes(a)){show(a);return;}
    if(a==='close-modal'){requestClose();return;}
    if(a==='demo'||a==='enter-empty'){switchWork(a==='demo'?'demo':'empty');return;}
    if(a==='compose'){composeFor(a,null);return;}
    if(a==='reply'||a==='forward'){if(m){dismiss();composeFor(a,m);}return;}
    if(a==='edit-draft'){if(m)editDraft(m);return;}
    if(a==='save-draft'||a==='send-demo'||a==='send-reviewed'){event.preventDefault();saveCompose(a!=='save-draft',false,a==='send-reviewed');return;}
    if(a==='pick-compose-file'){if(!modalData.reading)q('#compose-file').click();return;}
    if(a==='remove-compose-file'){
      modalData.attachments=modalData.attachments.filter(file=>file.id!==id);
      drawComposeFiles();markComposeEdited();q('.mx-attach').focus();return;
    }
    if(a==='pin-contact-sender'||a==='forget-contact-sender'){
      const {to,accountId}=composeValues();
      if(validRecipient(to)&&acct(accountId)&&rememberIdentity(a==='pin-contact-sender'?accountId:'',to)){
        hideSendReview();drawContactPreference();q('#compose-contact button')?.focus();
      }
      return;
    }
    if(a==='use-contact-sender'){
      const usual=identity(composeValues().to);
      if(usual){const field=q('[name=accountId]');field.value=usual.id;field.dispatchEvent(new Event('change',{bubbles:true}));field.focus();}
      return;
    }
    if(a==='more'){if(m)show('more',{id:m.id});return;}
    if(a==='attachment'){const f=attachData(id,b.dataset.mail);if(f)show('attachment',f);return;}
    if(a==='close-followup'&&m){
      const current=byId(id);
      if(!current)return;
      if(!window.MailFollowup.setDays(work,current,0)){toast('提醒未能保存，请检查浏览器可用空间。');return;}
      refreshFollowups();draw();q('.follow-page h1')?.focus({preventScroll:true});toast('已关闭这封邮件的提醒。');return;
    }
    if(a==='ai-ask'){event.preventDefault();ask(b.dataset.question||q('[name=question]')?.value);return;}
    if(a==='import-sample'){saveImport(sample);return;}
    if(a==='export-eml'){dismiss();if(m)download(m);return;}
  });
  document.addEventListener('input',e=>{
    const t=e.target;
    if(modal==='compose'){
      if(t.matches('[name=body],[name=to],[name=subject]')){
        markComposeEdited();
        if(t.name==='to')drawContactPreference();
      }
      return;
    }
    if(t.id==='mail-search'){
      rememberScroll();
      const tab=route.page==='search'?route.tab:'';
      route={page:t.value||tab?'search':'inbox',account:route.account,query:t.value,tab};
      history.replaceState({},'',routeUrl(route));drawRail();drawArea();updatePageTitle();
    }
    if(t.id==='file-search'){const start=t.selectionStart;route={page:'attachments',account:route.account,file:t.value};history.replaceState({},'',routeUrl(route));drawArea();const n=q('#file-search');n.focus();n.setSelectionRange(start,start);}
  });
  document.addEventListener('submit',e=>{
    if(e.target.id==='save-search-form'){
      e.preventDefault();
      const fields=Object.fromEntries(new FormData(e.target));
      try{
        const record=savedSearches.save(work,cryptoID(),fields);
        dismiss();openSavedSearch(record.id);toast('已固定到快捷文件夹。');
      }catch(error){q('#save-search-error').textContent=error.message;}
      return;
    }
    if(e.target.matches('[data-ai-form]')){e.preventDefault();ask(q('[name=question]',e.target).value);}
    if(e.target.id==='account-form'){e.preventDefault();const fd=new FormData(e.target),name=String(fd.get('label')).trim(),email=String(fd.get('email')).trim().toLowerCase();if(!name||!email.endsWith('@example.test')||accounts.some(a=>a.email===email)){q('#account-error').textContent='请使用尚未添加的 @example.test 示例地址。';return;}const a={id:'account-'+cryptoID(),name,email,color:'#8e9579'};updateStore(space=>space.accounts.push(a));hydrate();dismiss();nav('inbox',{account:a.id});toast('示例邮箱已添加，未连接服务商。');}
  });
  document.addEventListener('change',async e=>{
    const t=e.target;
    if(t.dataset.action==='default-sender'){rememberIdentity(t.value);return;}
    if(modal==='compose'&&t.name==='accountId'){
      if(modalData.chooseDefault&&acct(t.value)){
        rememberIdentity(t.value);modalData.chooseDefault=false;
        q('#compose-sender-hint')?.remove();t.removeAttribute('aria-describedby');
        t.querySelector('option[disabled]')?.remove();
      }
      markComposeEdited();drawContactPreference();return;
    }
    if(t.matches('select[data-follow-days]')){
      const mail=byId(t.dataset.followDays);
      if(!mail)return;
      const saved=window.MailFollowup.setDays(work,mail,t.value);
      refreshFollowups();draw();
      q('[data-follow-days]')?.focus({preventScroll:true});
      toast(saved?(t.value==='0'?'已关闭这封邮件的提醒。':'已保存回复提醒。'):'提醒未能保存，请检查浏览器可用空间。');return;
    }
    if(modal==='compose'&&t.name==='followDays'){markComposeEdited();return;}
    if(t.id==='compose-file'){await addComposeFiles(t);return;}
    if(t.dataset.action==='phrase'&&t.value){
      const snippets={receipt:'已收到，谢谢。',review:'方便时请确认以上内容，如需调整请告诉我。',thanks:'感谢你的时间和帮助。'};
      const body=q('.mx-compose [name=body]');body.setRangeText(snippets[t.value],body.selectionStart,body.selectionEnd,'end');t.value='';body.focus();body.dispatchEvent(new Event('input',{bubbles:true}));
    }
    if(t.dataset.action==='account-scope'&&validScope(t.value)){switchScope(t.value);}
    if(t.dataset.action==='theme'){updateStore(()=>{db.theme=t.value;});theme();}
    if(t.dataset.action==='appearance'&&concept){
      appearance=themeOptions.pick(t.value);
      updateStore(()=>{db.appearance=appearance.id;});
      const url=new URL(location.href);
      url.searchParams.set('theme',appearance.id);
      try{history.replaceState(history.state,'',url);}catch{}
      theme();
    }
    if(t.id==='eml-file'&&t.files[0]){try{const f=t.files[0];if(f.size>262144)throw Error('文件超过 256 KiB。');const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await f.arrayBuffer());saveImport(raw);}catch(err){const el=q('#import-error');if(el)el.textContent=err instanceof TypeError?'文件不是有效的 UTF-8 纯文本 EML。':err.message||'无法读取该 EML。';}}
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      const addresses=q('.reader-addresses[open]');
      if(modal)requestClose();
      else if(drawer)toggleDrawer();
      else if(addresses){addresses.open=false;q('summary',addresses).focus({preventScroll:true});}
      else if(mobile.matches&&route.id)q('[data-action=back-list]')?.click();
      return;
    }
    if(drawer&&e.key==='Tab'){
      const items=[...rail.querySelectorAll('button,select')].filter(el=>el.getClientRects().length&&!el.disabled),edge=e.shiftKey?items[0]:items.at(-1);
      if(document.activeElement===edge){e.preventDefault();(e.shiftKey?items.at(-1):items[0]).focus();}return;
    }
    if(modal&&e.key==='Tab'){const list=[...document.querySelectorAll('.dialog button,.dialog a[href],.dialog input,.dialog select,.dialog textarea,.dialog summary')].filter(el=>!el.disabled&&el.getClientRects().length);if(!list.length)return;const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}return;}
    if(modal||drawer)return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();q('#mail-search')?.focus();return;}
    if(e.key.toLowerCase()==='n'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.target.closest('input,textarea,select,[contenteditable]')){e.preventDefault();composeFor('compose',null);}
  });
  window.addEventListener('storage',event=>{
    const followVisible=route.page==='followup'||!!q('.follow-reader');
    if(event.key===dbKey){
      const latest=load();
      if(!latest[work])return;
      rememberScroll();Object.assign(db,latest);hydrate();drawRail();
      // Update an open answer without interrupting the next question being typed.
      if(route.page==='ai'&&route.ask){
        const panel=q('.mx-answer');
        const result=window.MailViews.aiAnswer(messages,route.account,route.ask);
        if(panel&&panel.innerHTML!==result){
          const focused=panel.contains(document.activeElement)?document.activeElement.dataset.id:null;
          panel.innerHTML=result;
          if(focused)[...panel.querySelectorAll('[data-id]')].find(b=>b.dataset.id===focused)?.focus({preventScroll:true});
        }
      }else if(!modal&&!['ai','storage','attachments'].includes(route.page)){drawArea();updatePageTitle();}
    }else if(window.MailFollowup.changed(work,event.key)){
      refreshFollowups();drawRail();
      if(followVisible&&!modal)drawArea();
    }else if(savedSearches.changed(work,event.key)){
      if(route.saved&&!savedSearch(route.saved)){
        const next={...route};delete next.saved;go(next,true);
      }else drawRail();
    }
  });
  function flushDraft(){if(modal==='compose'&&formDirty){clearTimeout(draftTimer);saveCompose(false,true);}}
  window.addEventListener('pagehide',flushDraft);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)flushDraft();});
  window.addEventListener('popstate',()=>{rememberScroll();flushDraft();dismiss();closeDrawer();readLocation();});
  mobile.addEventListener('change',()=>{closeDrawer();draw();});matchMedia('(prefers-color-scheme:dark)').addEventListener('change',theme);
  const shade=document.createElement('button');shade.className='drawer-shade';shade.dataset.action='drawer';shade.ariaLabel='关闭导航';document.body.append(shade);
  hydrate();theme();readLocation();
  if(window.MailUI.storagePrefix && new URLSearchParams(location.search).get('entry')==='compose')composeFor('compose',null);
})();
