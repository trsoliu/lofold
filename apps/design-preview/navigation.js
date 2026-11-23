// Mail navigation is rendered from the committed route. Only the open mobile drawer has a pending account.
(() => {
  'use strict';
  const {icon,escape:h}=window.MailUI;
  const folders=['inbox','starred','drafts','sent','outbox','archive','local'];
  const combined={
    inbox:'所有收件箱',starred:'所有星标',drafts:'所有草稿箱',sent:'所有已发送',
    outbox:'所有发件箱',archive:'所有归档',local:'本地档案'
  };
  const mailboxName=id=>window.MailViews.mailboxName(id);
  function accountIds(accounts,messages,selected){
    const ids=accounts.map(a=>a.id);
    if(!ids.length||selected==='local'||messages.some(m=>m.accountId==='local'))ids.push('local');
    return ids;
  }
  function isReceived(mail){
    return !['sent','drafts','outbox','trash'].includes(mail.folder==='archive'?mail.archivedFrom:mail.folder);
  }
  function isAllUnread(route){
    return route.page==='inbox'&&route.account==='all'&&route.tab==='unread'&&!route.query;
  }
  function title(route,sections){
    if(route.query)return '搜索结果';
    if(isAllUnread(route))return '所有未读';
    if(!folders.includes(route.page))return sections[route.page][0];
    if(route.account==='all')return combined[route.page];
    if(route.account==='local'&&route.page==='local')return '本地档案';
    return mailboxName(route.account)+' · '+sections[route.page][0];
  }
  function scopeSelect(accounts,messages,selected){
    const ids=['all',...accountIds(accounts,messages,selected)];
    const options=ids.map(id=>'<option value="'+h(id)+'" '+(id===selected?'selected':'')+'>'+h(mailboxName(id))+'</option>').join('');
    return '<label class="scope-inline"><span>查找范围</span><select data-action="account-scope" aria-label="查找范围">'+options+'</select></label>';
  }
  function render({route,accounts,messages,sections,openAccounts,more,pending,saved=[]}){
    const ids=accountIds(accounts,messages,route.account);
    const totals=new Map();
    for(const m of messages){
      for(const scope of ['all',m.accountId]){
        if(!totals.has(scope))totals.set(scope,{inbox:0,unread:0,drafts:0,outbox:0});
        const n=totals.get(scope);
        if(m.folder==='inbox'&&m.unread)n.inbox++;
        if(m.unread&&isReceived(m))n.unread++;
        if(m.folder==='drafts'||m.folder==='outbox')n[m.folder]++;
      }
    }
    const count=(id,key)=>totals.get(id)?.[key]||0;
    const number=n=>n?'<small class="tree-count">'+n+'</small>':'';
    function folder(id,page,shortcut=false,tab=''){
      const name=shortcut?(tab?'所有未读':combined[page]):sections[page][0];
      const glyph=tab?'mail':sections[page][1];
      const active=route.page===page&&route.account===id&&!route.query&&(!shortcut||!!tab===isAllUnread(route));
      const countKey=tab||page;
      const n=!shortcut&&page==='inbox'?0:count(id,countKey);
      return '<button type="button" class="nav-btn '+(shortcut?'shortcut-item':'tree-item')+(active?' active':'')+'" data-action="'+(shortcut?'shortcut':'folder')+'" data-page="'+page+'" data-account="'+h(id)+'" data-tab="'+tab+'" '+(active?'aria-current="page"':'')+'>'+
        icon(glyph,16)+'<span>'+h(name)+'</span>'+number(n)+'</button>';
    }
    function accountRow(id,desktop){
      const selected=desktop?route.account===id:pending===id;
      const expanded=openAccounts.has(id);
      const account=accounts.find(a=>a.id===id);
      const name=mailboxName(id);
      const color=/^#[0-9a-f]{6}$/i.test(account?.color||'')?account.color:'#678474';
      const n=count(id,'inbox');
      const state=desktop?'aria-expanded="'+expanded+'"':'aria-pressed="'+selected+'"';
      const stateIcon=desktop?'<span class="tree-chevron">'+icon('chevron-right',13)+'</span>':selected?icon('check',15):'';
      return '<button type="button" class="tree-account'+(selected?' current':'')+'" data-action="tree-account" data-account="'+h(id)+'" '+state+' title="'+h(name)+'" aria-label="'+h(name+(n?'，收件箱 '+n+' 封未读':''))+'" style="--account-color:'+color+'">'+
        '<span class="tree-avatar" aria-hidden="true">'+h(name.slice(0,1))+'</span><span class="tree-name">'+h(name)+'</span>'+number(n)+stateIcon+'</button>';
    }
    function accountFolders(id){
      return folders.filter(page=>id!=='local'||!['inbox','sent','outbox'].includes(page)).map(page=>folder(id,page)).join('');
    }
    function tool(page){
      const [name,glyph]=sections[page],active=route.page===page;
      const due=page==='followup'?window.MailFollowup.dueCount(route.account):0;
      const badge=due?'<small class="tree-count" aria-label="'+due+' 项到期提醒">'+due+'</small>':'';
      return '<button class="nav-btn'+(active?' active':'')+'" data-action="nav" data-page="'+page+'" '+(active?'aria-current="page"':'')+'>'+icon(glyph,17)+'<span>'+name+'</span>'+badge+'</button>';
    }
    const desktopTree=ids.map(id=>accountRow(id,true)+(openAccounts.has(id)?'<div class="tree-folders">'+accountFolders(id)+'</div>':'')).join('');
    const mobileFolders=pending&&ids.includes(pending)?'<div class="mobile-folder-group"><p class="folder-nav-heading">'+h(mailboxName(pending))+'的文件夹</p>'+accountFolders(pending)+'</div>':'';
    const createSearch='<button type="button" class="icon-btn" data-action="pin-search" title="新建常用搜索" aria-label="新建常用搜索">'+icon('plus',16)+'</button>';
    return '<div class="nav-group"><div class="shortcut-heading"><p class="nav-label">快捷文件夹</p>'+createSearch+'</div>'+folder('all','inbox',true)+folder('all','inbox',true,'unread')+window.MailSavedSearch.shortcutRows(saved,route.saved)+
      '<button type="button" class="nav-btn more-shortcuts" aria-expanded="'+more+'" data-action="more-shortcuts">'+icon('layers',16)+'<span>更多文件夹</span>'+icon(more?'chevron-down':'chevron-right',13)+'</button>'+
      (more?folders.slice(1).map(page=>folder('all',page,true)).join(''):'')+'</div>'+
      '<section class="account-nav-root" aria-label="按邮箱浏览"><div class="nav-account-heading"><span>我的邮箱</span><button type="button" class="icon-btn" data-action="add-account" aria-label="添加示例邮箱" title="添加示例邮箱">'+icon('plus',16)+'</button></div>'+
      '<div class="desktop-folder-tree">'+desktopTree+'</div><div class="mobile-account-list">'+ids.map(id=>accountRow(id,false)).join('')+'</div>'+mobileFolders+'</section>'+
      '<div class="nav-group"><p class="nav-label">工具</p>'+tool('attachments')+(sections.followup?tool('followup'):'')+tool('ai')+'</div>';
  }
  window.MailNavigation={render,scopeSelect,title,isReceived,isAllUnread,accountIds};
})();
