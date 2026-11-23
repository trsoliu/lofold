// The travel view checks the current mailbox contents. Cached originals belong to one workspace and account.
(() => {
  'use strict';
  const {escape: h, icon} = window.MailUI;
  const folders = {all:'全部文件夹', inbox:'收件箱', starred:'星标邮件', sent:'已发送', drafts:'草稿箱', outbox:'发件箱', archive:'归档', local:'本地档案'};
  const proof = {
    url:'./assets/winter-proof.pdf', size:355912,
    digest:'e9321e2f268cbd6c62b0555ed0ca07bbccdb21c0b9dfd265ff44a62f36e53c78'
  };
  let nextContext, connection;
  const bytes = size => size.toLocaleString('zh-CN') + ' B';
  const key = (...parts) => JSON.stringify(parts);
  const settingKey = (...parts) => window.MailUI.storagePrefix + 'local-mail-offline:' + key(...parts);
  const option = (id, name, current) => '<option value="'+h(id)+'"'+(id===current?' selected':'')+'>'+h(name)+'</option>';
  const windows = new WeakMap();

  function database() {
    if (!connection) connection = new Promise((resolve,reject) => {
      const request = indexedDB.open(window.MailUI.storagePrefix + 'local-mail-offline-blobs-v1',1);
      request.onupgradeneeded = () => request.result.createObjectStore('originals');
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => { connection=null; throw error; });
    return connection;
  }

  async function access(id, blob) {
    const db = await database();
    return new Promise((resolve,reject) => {
      const tx = db.transaction('originals', blob ? 'readwrite' : 'readonly');
      const files = tx.objectStore('originals');
      const request = blob ? files.put(blob,id) : files.get(id);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error('缓存读写失败'));
    });
  }

  function bundled(file) {
    return file.id === 'a-proof' && (file.dataUrl === proof.url ||
      (typeof file.dataUrl === 'string' && file.dataUrl === window.MailProofPDF));
  }

  async function matchesProof(blob) {
    if (!(blob instanceof Blob) || blob.size !== proof.size) return false;
    const hash = await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('') === proof.digest;
  }

  async function cacheProof(id) {
    const response = await fetch(proof.url, {credentials:'omit',redirect:'error'});
    if (!response.ok) throw new Error('无法读取随包原件');
    const blob = await response.blob();
    if (!await matchesProof(blob)) throw new Error('随包原件校验失败');
    await access(id,blob);
    if (!await matchesProof(await access(id))) throw new Error('离线副本回读失败');
  }

  function getPref(parts, fallback) {
    return localStorage.getItem(settingKey(...parts)) ?? fallback;
  }

  function hasInlineBytes(file) {
    if (typeof file.dataUrl!=='string' || !file.dataUrl.startsWith('data:')) return false;
    const comma=file.dataUrl.indexOf(',');
    if (comma<0) return false;
    try {
      const header=file.dataUrl.slice(0,comma);
      const payload=file.dataUrl.slice(comma+1);
      const length=/;base64$/i.test(header) ? atob(payload).length : new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
      return file.bytes==null || length===file.bytes;
    } catch {return false;}
  }

  function scopeFiles(model) {
    const mails = model.messages.filter(m => (model.account==='all' || m.accountId===model.account) &&
      (model.folder==='all' ? m.folder!=='trash' : model.folder==='starred' ? m.starred && m.folder!=='trash' : m.folder===model.folder));
    const bodies = mails.filter(m => Array.isArray(m.body) || typeof m.body==='string').length;
    const files = new Map();
    for (const m of mails) for (const [index,file] of (m.attachments || []).entries()) {
      // The bundled proof has a fixed digest. Inline byte sources can only share a key within this account.
      const embedded = hasInlineBytes(file);
      const source = embedded ? 'inline' : file.dataUrl===proof.url && bundled(file) ? 'bundle' : 'missing';
      const identity = bundled(file) ? proof.digest : embedded ? file.dataUrl : key(m.id,index);
      const id = key(model.work,m.accountId,source,identity);
      const existing = files.get(id);
      if (existing) existing.refs++;
      else files.set(id,{file,source,id,refs:1,account:m.accountId});
    }
    return {mails,bodies,files:[...files.values()]};
  }

  function details(model) {
    const {mails,bodies,files} = model.scope;
    const ready = files.filter(f => f.source==='inline' || model.cached.has(f.id));
    const pending = files.filter(f => f.source==='bundle' && !model.cached.has(f.id));
    const unavailable = files.filter(f => f.source==='missing');
    const duplicateBytes = files.filter(f => model.cached.has(f.id)).reduce((n,f) => n+(f.refs-1)*proof.size,0);
    const complete = !!mails.length && bodies===mails.length && ready.length===files.length;
    const canPin = model.account!=='all' && !['all','starred'].includes(model.folder);
    const label = complete ? '已备齐' : mails.length ? '尚未备齐' : '这个范围还没有邮件';
    let output = '<div class="offline-report" aria-live="polite"><strong>'+label+'</strong>';
    if (mails.length) {
      output += '<p>本机已有 '+mails.length+' 封邮件，'+bodies+' 封正文可读 · 附件 '+ready.length+' / '+files.length+' 份可离线取用</p>';
      if (bodies<mails.length) output += '<p>'+ (mails.length-bodies)+' 封邮件缺少正文，需从来源补回。</p>';
      if (pending.length) output += '<p>待保存 '+pending.length+' 份原件，共 '+bytes(pending.length*proof.size)+'。</p>';
      if (unavailable.length) output += '<p>'+unavailable.length+' 份附件只有记录，缺少可读取的原件。</p>';
    }
    output += '</div>';
    if (pending.length) output += '<button type="button" class="mx-primary-btn" data-offline-task="prepare">'+icon('download',16)+'一键备齐</button>';
    if (canPin) output += '<label class="offline-pin"><input type="checkbox" data-offline-pin'+(model.pinned?' checked':'')+'>固定此文件夹离线</label>';
    if (files.length) {
      output += '<details class="mx-disclosure offline-files"><summary>查看 '+files.length+' 份附件</summary><ul>';
      files.forEach((f,index) => {
        const state = f.source==='inline'?'随邮件可用':model.cached.has(f.id)?'已存离线副本':f.source==='bundle'?'待保存随包原件':'缺少原件';
        const caption = (model.account==='all'?window.MailViews.mailboxName(f.account)+' · ':'') + state +
          (f.refs>1?' · '+f.refs+' 处引用':'');
        output += '<li><span><b>'+h(f.file.name || '未命名文件')+'</b><small>'+h(caption)+'</small></span>'+
          (ready.includes(f)?'<button type="button" class="mx-sub-btn" data-offline-file="'+index+'">下载原件</button>':'')+'</li>';
      });
      output += '</ul></details><p class="offline-hint">已固定附件的复用节省量为 '+bytes(duplicateBytes)+'（当前范围内的载荷）。</p>';
    }
    return output;
  }

  function policy(model) {
    if (model.account==='all') return '<p class="offline-hint">选择一个邮箱可调整它的离线策略。</p>';
    if (model.account==='local') return '<p class="offline-hint">本地导入的原件与草稿保留在本机。</p>';
    return '<details class="mx-disclosure offline-policy"><summary>此邮箱的离线策略</summary><div class="offline-fields">'+
      '<label>手机<select data-offline-pref="phone" aria-label="手机离线策略">'+option('recent','近 30 天正文，附件按需',model.phone)+option('all','全部正文和附件',model.phone)+'</select></label>'+
      '<label>电脑<select data-offline-pref="desktop" aria-label="电脑离线策略">'+option('synced','已同步正文，附件按需',model.desktop)+option('all','全部正文和附件',model.desktop)+'</select></label>'+
      '</div><p>策略保存在当前设备，待服务商同步接入后应用。本地导入、草稿和固定文件夹均保留。</p></details>';
  }

  function renderPanel(model) {
    const root = model.root;
    root.querySelector('[data-offline-output]').innerHTML = details(model);
    root.querySelector('[data-offline-policy]').innerHTML = policy(model);
    root.querySelector('[data-offline-status]').textContent = model.status || '';
  }

  async function check(model, preparePinned=false) {
    const version = ++model.version;
    model.scope = scopeFiles(model);
    model.cached = new Set();
    model.status = '';
    try {
      model.phone = getPref([model.work,model.account,'phone'],'recent');
      model.desktop = getPref([model.work,model.account,'desktop'],'synced');
      model.pinned = getPref([model.work,model.account,'pin',model.folder],'')==='yes';
    } catch {
      model.phone='recent'; model.desktop='synced'; model.pinned=false;
      model.status='浏览器未允许读取离线偏好。';
    }
    model.root.querySelector('[data-offline-output]').textContent='正在核对本机原件…';
    model.root.querySelector('[data-offline-policy]').replaceChildren();
    model.root.querySelector('[data-offline-status]').textContent='';
    const cached = new Set();
    let error = '';
    for (const f of model.scope.files.filter(f => f.source==='bundle')) {
      try {
        const blob = await access(f.id);
        if (await matchesProof(blob)) cached.add(f.id);
        else if (blob) error='离线副本校验失败，请重新备齐。';
      } catch { error='浏览器未能读取附件缓存，可重试或检查浏览器存储权限。'; }
    }
    if (model.version!==version || !model.root.isConnected) return;
    model.cached=cached;
    model.status=error || model.status;
    renderPanel(model);
    if (preparePinned && model.pinned && model.scope.files.some(f=>f.source==='bundle'&&!cached.has(f.id))) await prepare(model);
  }

  async function prepare(model,focusSelector) {
    if (model.busy) return;
    model.busy=true;
    const version=model.version;
    const initial=model.scope.files.filter(f => f.source==='bundle' && !model.cached.has(f.id));
    model.root.querySelectorAll('select,button,input').forEach(el=>{el.disabled=true;});
    model.root.querySelector('[data-offline-status]').textContent='正在本机保存并校验附件…';
    let failures=0;
    for (const f of initial) {
      try { await cacheProof(f.id); }
      catch { failures++; }
    }
    model.busy=false;
    if (!model.root.isConnected || model.version!==version) return;
    model.root.querySelectorAll('select,button,input').forEach(el=>{el.disabled=false;});
    await check(model);
    if (!model.root.isConnected || model.version!==version+1) return;
    const status=model.root.querySelector('[data-offline-status]');
    if (failures) status.textContent=failures+' 份原件保存失败，请检查随包文件和可用空间，再点一键备齐。';
    else if (initial.length) status.textContent='已保存并校验 '+initial.length+' 份原件。';
    if (focusSelector) (model.root.querySelector(focusSelector) || model.root.querySelector('.offline-files summary'))?.focus({preventScroll:true});
  }

  function download(blobOrUrl,name) {
    const isBlob=blobOrUrl instanceof Blob;
    const url=isBlob?URL.createObjectURL(blobOrUrl):blobOrUrl;
    const a=document.createElement('a');
    a.href=url; a.download=name; document.body.append(a); a.click(); a.remove();
    if (isBlob) setTimeout(()=>URL.revokeObjectURL(url),3000);
  }

  function panel(context) {
    nextContext=context;
    return '<section class="offline-panel" data-offline aria-labelledby="offline-title"><h3 id="offline-title">出差前备齐</h3>'+
      '<div class="offline-fields"><label>邮箱<select data-offline-scope="account"></select></label><label>文件夹<select data-offline-scope="folder"></select></label></div>'+
      '<div data-offline-output></div><p data-offline-status role="status"></p><div data-offline-policy></div></section>';
  }

  function mount(content) {
    const root=content.querySelector('[data-offline]');
    if (!root || !nextContext) return;
    const model={...nextContext,root,version:0,busy:false};
    windows.set(root,model);
    const ids=model.accounts.map(a=>a.id);
    if (!ids.length || model.messages.some(m=>m.accountId==='local') || model.account==='local') ids.push('local');
    if (!['all',...ids].includes(model.account)) model.account='all';
    if (!Object.hasOwn(folders,model.folder)) model.folder='inbox';
    root.querySelector('[data-offline-scope=account]').innerHTML=['all',...ids].map(id=>option(id,window.MailViews.mailboxName(id),model.account)).join('');
    root.querySelector('[data-offline-scope=folder]').innerHTML=Object.entries(folders).map(([id,name])=>option(id,name,model.folder)).join('');
    check(model,true);
  }

  document.addEventListener('change', async event => {
    const control=event.target;
    const model=windows.get(control.closest('[data-offline]'));
    if (!model || model.busy) return;
    const scope=control.dataset.offlineScope;
    if (scope==='account' || scope==='folder') {
      if (model.onScopeChange) {
        model.onScopeChange(scope==='account'?control.value:model.account, scope==='folder'?control.value:model.folder,scope);
        return;
      }
      model[scope]=control.value;
      await check(model,true);
    } else if (control.matches('[data-offline-pin],[data-offline-pref]')) {
      const pin=control.hasAttribute('data-offline-pin');
      const pref=control.dataset.offlinePref;
      try {
        const parts=pin?[model.work,model.account,'pin',model.folder]:[model.work,model.account,pref];
        localStorage.setItem(settingKey(...parts),pin?(control.checked?'yes':''):control.value);
        if (pin) model.pinned=control.checked; else model[pref]=control.value;
        const status=model.root.querySelector('[data-offline-status]');
        status.textContent=pin?(control.checked?'已固定此文件夹。':'已取消固定，已保存的文件仍可取用。'):'已保存此邮箱的离线策略。';
        if (pin && control.checked && model.scope.files.some(f=>f.source==='bundle'&&!model.cached.has(f.id))) await prepare(model,'[data-offline-pin]');
      } catch {
        if (pin) control.checked=model.pinned; else control.value=model[pref];
        model.root.querySelector('[data-offline-status]').textContent='设置未保存，请检查浏览器可用空间或存储权限。';
      }
    }
  });

  document.addEventListener('click', async event => {
    const button=event.target.closest('[data-offline-task],[data-offline-file]');
    if (!button) return;
    const model=windows.get(button.closest('[data-offline]'));
    if (!model || model.busy) return;
    if (button.dataset.offlineTask==='prepare') return prepare(model,'[data-offline-task=prepare]');
    const f=model.scope.files[Number(button.dataset.offlineFile)];
    if (!f) return;
    try {
      if (f.source==='inline') return download(f.file.dataUrl,f.file.name);
      const blob=await access(f.id);
      if (!await matchesProof(blob)) throw new Error('缓存缺失');
      download(blob,f.file.name);
    } catch {
      await check(model);
      model.root.querySelector('[data-offline-status]').textContent='离线副本读取失败，请重新备齐。';
    }
  });

  function attachDownload(link,work,account,file) {
    if (!link || !account || file.dataUrl!==proof.url || !bundled(file)) return;
    const id=key(work,account,'bundle',proof.digest);
    const originalHref=link.href;
    const lookup=access(id).then(async blob => (await matchesProof(blob)) ? blob : null).catch(()=>null);
    // A quick click while the read is in flight uses the same verified copy.
    link.addEventListener('click', async event=>{
      if (link.href !== originalHref) return;
      event.preventDefault();
      download(await lookup || originalHref,file.name);
    });
    lookup.then(blob=>{
      if (!blob || !link.isConnected) return;
      const url=URL.createObjectURL(blob);
      link.href=url;
      const open=document.createElement('a');
      open.className=link.className; open.href=url; open.target='_blank'; open.rel='noopener';
      open.textContent='打开离线原件'; link.after(open);
      const observer=new MutationObserver(()=>{
        if (link.isConnected) return;
        observer.disconnect();
        setTimeout(()=>URL.revokeObjectURL(url),3000);
      });
      observer.observe(document.getElementById('modal-root'),{childList:true,subtree:true});
    });
  }
  window.MailOffline={panel,mount,attachDownload};
})();
