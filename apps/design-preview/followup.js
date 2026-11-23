// In-app follow-up reminders are isolated by workspace, account and outgoing message.
(() => {
  'use strict';
  const {escape:h,icon}=window.MailUI;
  const day=86400000;
  const choices=[1,3,7];
  const localTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const outgoingFolder=mail=>mail.folder==='archive'?mail.archivedFrom:mail.folder;
  const timeLabel=value=>localTime.format(new Date(value));
  const daysOf=value=>choices.includes(Number(value))?Number(value):0;
  const messageIds=value=>(Array.isArray(value)?value.join(' '):String(value||'')).match(/<[^\s<>]+@[^\s<>]+>/g)||[];
  const addressOf=value=>String(value||'').trim().toLowerCase();
  let entries=new Map(), nextTimer;

  function key(work,mail){
    return window.MailUI.storagePrefix+'local-mail-followup:'+JSON.stringify([work,mail.accountId,mail.id]);
  }
  function read(work,mail){
    try{return JSON.parse(localStorage.getItem(key(work,mail)))||{};}catch{return {};}
  }
  function write(work,mail,data){
    try{localStorage.setItem(key(work,mail),JSON.stringify(data));return true;}catch{return false;}
  }
  function findReply(original,mails,accounts){
    const id=messageIds(original.rfcMessageId)[0];
    if(!id||original.dateReliable===false||!original.to)return;
    const sender=addressOf(original.fromEmail), recipient=addressOf(original.to);
    const own=new Set([sender,...accounts.map(a=>addressOf(a.email))]);
    const sentAt=Date.parse(original.date);
    let first;
    for(const mail of mails){
      if(mail.accountId!==original.accountId||mail.id===original.id||mail.dateReliable===false)continue;
      if(['drafts','outbox','sent'].includes(outgoingFolder(mail)))continue;
      if(addressOf(mail.fromEmail)!==recipient||own.has(addressOf(mail.fromEmail)))continue;
      const date=Date.parse(mail.date);
      if(!(date>sentAt))continue;
      if(![...messageIds(mail.inReplyTo),...messageIds(mail.references)].includes(id))continue;
      if(!first||date<Date.parse(first.date))first=mail;
    }
    return first;
  }
  function refresh(work,mails,accounts,onDue){
    clearTimeout(nextTimer);
    const now=Date.now();
    entries=new Map();
    let nextDue=Infinity;
    for(const mail of mails){
      const folder=outgoingFolder(mail);
      if(!['sent','outbox'].includes(folder))continue;
      const setting=read(work,mail);
      const days=daysOf(setting.days??mail.followDays);
      if(!days)continue;
      const record={mail,days,state:'queued',due:null};
      if(folder==='sent'){
        const sentAt=Date.parse(mail.date);
        let receipt=setting.reply;
        if(!receipt){
          const reply=findReply(mail,mails,accounts);
          if(reply){
            receipt={id:reply.id,date:reply.date};
            write(work,mail,{days,reply:receipt});
          }
        }
        if(receipt){
          record.state='replied';
          record.reply=receipt;
        }else if(Number.isFinite(sentAt)&&mail.dateReliable!==false){
          record.due=sentAt+days*day;
          record.state=record.due<=now?'due':'waiting';
          if(record.state==='waiting')nextDue=Math.min(nextDue,record.due);
        }else{
          record.state='undated';
        }
      }
      entries.set(mail.id,record);
    }
    if(Number.isFinite(nextDue))nextTimer=setTimeout(onDue,Math.min(nextDue-now+50,2147483647));
  }
  function setDays(work,mail,value){
    const days=daysOf(value);
    const current=read(work,mail);
    return write(work,mail,{days,...(days&&current.reply?{reply:current.reply}:{})});
  }
  function scopeRows(account){
    return [...entries.values()].filter(r=>account==='all'||r.mail.accountId===account);
  }
  function dueCount(account='all'){
    return scopeRows(account).filter(r=>r.state==='due').length;
  }
  function selectOptions(days,initial){
    return '<option value="0">'+initial+'</option>'+choices.map(n=>'<option value="'+n+'"'+(n===days?' selected':'')+'>'+n+' 天后</option>').join('');
  }
  function compose(days){
    return '<label class="follow-compose">等回复<select name="followDays" aria-label="发送后未收到回复时提醒">'+selectOptions(daysOf(days),'不提醒')+'</select></label>';
  }
  const refButton=(id,label)=>'<button type="button" class="follow-link" data-action="open-message" data-id="'+h(id)+'">'+h(label)+'</button>';
  function status(record,mails){
    if(record.state==='queued')return '待发后计时 · 已设置 '+record.days+' 天';
    if(record.state==='undated')return '缺少可信发件时间，暂缓计时';
    if(record.state==='replied'){
      const available=mails.some(m=>m.id===record.reply.id&&m.accountId===record.mail.accountId);
      return '已收到回复 · '+h(timeLabel(record.reply.date))+(available?' '+refButton(record.reply.id,'查看回信'):'');
    }
    return (record.state==='due'?'已到期':'提醒时间')+' · '+h(timeLabel(record.due));
  }
  function reader(mail,mails){
    const folder=outgoingFolder(mail),record=entries.get(mail.id);
    if(folder!=='sent')return folder==='outbox'&&record?'<p class="follow-reader">'+status(record,mails)+'</p>':'';
    return '<div class="follow-reader"><label>'+icon('clock',15)+'等对方回复<select data-follow-days="'+h(mail.id)+'" aria-label="为这封已发送邮件设置回复提醒">'+selectOptions(record?.days,'不提醒')+'</select></label>'+
      (record?'<p>'+status(record,mails)+'</p>':'')+'</div>';
  }
  function row(record,mails){
    const m=record.mail;
    return '<article class="follow-row"><div class="follow-subject">'+refButton(m.id,m.subject||'无主题')+
      '<small>'+h(window.MailViews.mailboxName(m.accountId))+' → '+h(m.to)+'</small><p>'+status(record,mails)+'</p></div>'+
      '<button type="button" class="follow-close" data-action="close-followup" data-id="'+h(m.id)+'" aria-label="关闭'+h(m.subject)+'的提醒">关闭提醒</button></article>';
  }
  function page(account,scopeControl,mails,snapshot){
    const groups=[['due','到期提醒'],['waiting','等待中'],['queued','待发送'],['undated','待确认时间'],['replied','已收到回复']];
    const rows=scopeRows(account).sort((a,b)=>(a.due??Infinity)-(b.due??Infinity)||Date.parse(b.mail.date)-Date.parse(a.mail.date));
    let html='';
    for(const [state,label] of groups){
      const list=rows.filter(r=>r.state===state);
      if(list.length)html+='<section class="follow-group"><h2>'+label+' <small>'+list.length+'</small></h2>'+list.map(r=>row(r,mails)).join('')+'</section>';
    }
    if(!html)html='<div class="empty-box">'+icon('clock',28)+'<h3>当前范围还没有回复提醒</h3><p>在已发送的邮件中选择提醒期限，或在写信时预设。</p><button type="button" class="btn-neutral" data-action="nav" data-page="sent">查看已发送</button></div>';
    return '<section class="aux-inner follow-page"><header class="aux-head"><div><h1 tabindex="-1">等对方回复</h1><p>到期时根据本机已有往来在应用内提醒。</p></div>'+scopeControl+'</header>'+html+
      '<p class="follow-source">'+(snapshot?'示例快照截至 '+h(timeLabel(snapshot))+'。':'')+'已计入本机导入的邮件，尚未连接服务商同步。时间为北京时间。</p></section>';
  }
  function changed(work,storageKey){
    return typeof storageKey==='string'&&storageKey.startsWith(window.MailUI.storagePrefix+'local-mail-followup:['+JSON.stringify(work)+',');
  }
  window.MailFollowup={compose,reader,page,refresh,setDays,dueCount,findReply,changed};
})();
