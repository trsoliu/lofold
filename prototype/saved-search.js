(() => {
  'use strict';
  const {escape:h,icon}=window.MailUI;
  const prefix=work=>window.MailUI.storagePrefix+'local-mail-saved-search:'+work+':';
  const workspaces=new Map();

  function list(work){
    if(!workspaces.has(work)){
      const records=[];
      try{
        for(let index=0;index<localStorage.length;index++){
          const key=localStorage.key(index);
          if(!key?.startsWith(prefix(work)))continue;
          try{
            const record=JSON.parse(localStorage.getItem(key));
            if(record&&key===prefix(work)+record.id&&typeof record.name==='string'&&typeof record.account==='string')records.push(record);
          }catch{}
        }
      }catch{}
      records.sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id));
      workspaces.set(work,records);
    }
    return workspaces.get(work);
  }

  function save(work,id,fields){
    const name=fields.name.trim(), query=fields.query.trim();
    if(!name)throw Error('请填写一个名称。');
    if(!query&&!fields.tab&&fields.account==='all')throw Error('请填写关键词、选择邮箱或添加筛选条件。');
    if(list(work).some(r=>r.name===name))throw Error('已有同名的常用搜索，请换个名称。');
    const record={id,name,query,account:fields.account,tab:fields.tab,created:Date.now()};
    try{localStorage.setItem(prefix(work)+id,JSON.stringify(record));}
    catch{throw Error('浏览器未能保存，请检查可用空间后重试。');}
    list(work).push(record);
    return record;
  }

  function remove(work,id){
    try{localStorage.removeItem(prefix(work)+id);}
    catch{throw Error('未能取消固定，请重试。');}
    workspaces.delete(work);
  }

  function changed(work,key){
    if(key===null){workspaces.clear();return true;}
    for(const workspace of workspaces.keys()){
      if(key.startsWith(prefix(workspace)))workspaces.delete(workspace);
    }
    return key.startsWith(prefix(work));
  }

  function shortcutRows(records,active){
    return records.map(r=>'<button type="button" class="nav-btn shortcut-item saved-shortcut'+(r.id===active?' active':'')+
      '" data-action="open-saved-search" data-search="'+h(r.id)+'" title="'+h(r.name)+'"'+(r.id===active?' aria-current="page"':'')+'>'+
      icon('search',16)+'<span>'+h(r.name)+'</span></button>').join('');
  }

  const isSearch=route=>route.page==='search'||!!route.query;
  const tabs=[['','全部邮件'],['unread','未读'],['files','含附件']];
  function editor(route,ids,mailboxName){
    const filter=['unread','files'].includes(route.tab)?route.tab:'';
    const query=(route.query||'').trim();
    const suggested=query||(filter==='files'?'含附件的邮件':filter==='unread'?'未读邮件':'');
    const options=(pairs,current)=>pairs.map(([id,name])=>'<option value="'+h(id)+'"'+(id===current?' selected':'')+'>'+h(name)+'</option>').join('');
    return '<form id="save-search-form"><label class="field">快捷文件夹名称<input required name="name" maxlength="40" value="'+h(suggested)+'" placeholder="例如：客户报价"></label>'+
      '<label class="field">关键词<input name="query" value="'+h(query)+'" placeholder="主题、正文、地址或附件名"></label>'+
      '<div class="saved-search-fields"><label class="field">查找范围<select name="account">'+options(ids.map(id=>[id,mailboxName(id)]),route.account)+'</select></label>'+
      '<label class="field">邮件筛选<select name="tab">'+options(tabs,filter)+'</select></label></div>'+
      '<p id="save-search-error" class="hint-error" role="alert"></p><button type="submit" class="primary">'+icon('plus',15)+'固定搜索</button></form>';
  }

  window.MailSavedSearch={list,save,remove,changed,shortcutRows,editor,isSearch};
})();
