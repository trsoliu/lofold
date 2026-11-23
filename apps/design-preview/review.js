(() => {
  'use strict';
  const find = selector => document.querySelector(selector);
  const stage = find('#stage'), viewport = find('#viewport'), catalog = find('#catalog');
  const flows = new Map(window.MailDesignFlows.map(flow => [flow.id, flow]));
  const live = new Map([
    ['hi-fi', ['高保真 · 收件与回复', 'mail-open', 'inbox?account=all']],
    ['hi-fi-brand', [window.MailUI.brand.name+' · 品牌与欢迎页', 'mail', 'welcome']],
    ['inbox', ['多邮箱收件箱', 'inbox', 'inbox?account=all']],
    ['folders', ['账号与文件夹', 'folder', 'sent?account=studio']],
    ['read', ['读信与回复', 'mail-open', 'inbox?account=studio&id=m-proof']],
    ['write', ['写信与发送前检查', 'pen', 'inbox?account=all', 'compose']],
    ['search', ['搜索与固定文件夹', 'search', 'search?account=studio&query=报价&tab=files']],
    ['attachments', ['附件中心', 'paperclip', 'attachments?account=all']],
    ['followup', ['等对方回复', 'clock', 'sent?account=studio&id=m-photo-sent']],
    ['ai', ['AI 查信与引用', 'sparkles', 'ai?account=studio&ask=哪笔差旅报销还缺发票？']],
    ['storage', ['本地存储与试压', 'drive', 'storage?account=all']],
    ['offline', ['文件夹离线准备', 'download', 'storage?account=studio&offlineFolder=inbox']],
    ['welcome', ['首次使用与导入', 'import', 'welcome']]
  ]);
  const flowIcons = {accounts:'inbox',compose:'pen',batch:'layers',compression:'drive',preferences:'settings',searchTools:'search',rules:'filters',people:'calendar',sharing:'paperclip',archive:'archive',ai:'sparkles',migration:'lock',platforms:'settings'};
  const flowOrder = ['accounts','compose','batch','rules','people','sharing','archive','compression','searchTools','ai','migration','preferences','platforms'];
  const sessions = new Map();
  let active = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function symbol(name, size = 17) {
    const span = element('span');
    span.dataset.icon = name;
    span.innerHTML = window.MailUI.icon(name,size);
    return span;
  }
  function button(label, handler, className) {
    const control = element('button', className, label);
    control.type = 'button';
    control.addEventListener('click',handler);
    return control;
  }
  function flowUrl(id, state) { return '#flow/' + id + '/' + state; }
  function setRoute(hash, previous = null) {
    if (hash !== location.hash) history.pushState({previous}, '', hash);
    render();
  }
  function readRoute() {
    const [kind,id,requested] = location.hash.slice(1).split('/');
    if (kind === 'flow' && flows.has(id)) {
      const flow = flows.get(id);
      return {kind,id,state:Object.hasOwn(flow.states,requested) ? requested : flow.start};
    }
    return {kind:'live', id:kind === 'live' && live.has(id) ? id : 'inbox'};
  }
  function flowSession(flow) {
    if (sessions.has(flow.id)) return sessions.get(flow.id);
    const values = Object.create(null);
    for (const state of Object.values(flow.states)) {
      for (const field of state.fields || []) {
        if (!Object.hasOwn(values,field.label)) values[field.label] = field.value ?? (field.type === 'checkbox' ? false : '');
      }
    }
    sessions.set(flow.id, values);
    return values;
  }
  function interpolate(text, values, placeholder = '—') {
    return String(text ?? '').replace(/\{\{([^{}]+)\}\}/g, (_, name) => {
      const value = values[name.trim()];
      if (typeof value === 'boolean') return value ? '已选' : '未选';
      return value === '' || value == null ? placeholder : String(value);
    });
  }
  function group(name, description, items) {
    const section = element('section','catalog-group');
    const heading = element('h2','',name);
    heading.tabIndex = -1;
    section.append(heading,element('p','',description));
    for (const {label,icon,hash,info,key} of items) {
      const a = element('a','catalog-item');
      a.href = hash;
      a.dataset.section = key;
      a.append(symbol(icon),element('span','',label));
      if (info) a.append(element('small','',info));
      a.addEventListener('click', event => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        catalog.close();
        setRoute(hash);
      });
      section.append(a);
    }
    find('#catalog-groups').append(section);
  }
  group('可操作原型','用示例邮件走完日常操作；修改保存在单独的审阅工作区。', [...live].map(([id,[label,icon]]) => ({label,icon,hash:'#live/'+id,key:'live/'+id})));
  group('流程状态稿','用虚构数据预演授权、投递、恢复等分支；可直接跳转到任一状态。', flowOrder.filter(id=>flows.has(id)).map(id=>{
    const flow = flows.get(id);
    return {label:flow.title,icon:flowIcons[id],hash:flowUrl(id,flow.start),key:'flow/'+id,info:Object.keys(flow.states).length+' 个状态'};
  }));

  function renderFlow(flow, key) {
    const state = flow.states[key], values = flowSession(flow);
    const display = value => interpolate(value,values);
    const wrap = element('div','flow-wrap'), nav = element('div','flow-nav');
    nav.append(element('span','','流程状态稿'),element('span','','/'),element('strong','',flow.title));
    const controls = element('div','flow-tools'), picker = element('select');
    picker.setAttribute('aria-label','跳到流程状态');
    for (const [id,screen] of Object.entries(flow.states)) picker.add(new Option(display(screen.title),id));
    picker.value = key;
    const navigate = next => setRoute(flowUrl(flow.id,next), key);
    picker.addEventListener('change',()=>navigate(picker.value));
    const previous = history.state?.previous;
    const back = button('上一步',()=>{
      if (Object.hasOwn(flow.states,previous)) history.back();
      else navigate(flow.start);
    });
    back.disabled = !Object.hasOwn(flow.states,previous) && key === flow.start;
    const reset = button('重新演示',()=>{
      sessions.delete(flow.id);
      history.replaceState(null,'',flowUrl(flow.id,flow.start));
      render();
    });
    controls.append(picker,back,reset);
    nav.append(controls);
    const sheet = element('article','sheet');
    const heading = element('h1','',display(state.title));
    heading.tabIndex = -1;
    sheet.append(heading);
    if (state.hint) sheet.append(element('p','hint',display(state.hint)));
    const inputs = new Map();
    if (state.fields?.length) {
      const fields = element('div','fields');
      for (const field of state.fields) {
        const check = field.type === 'checkbox', label = element('label',check?'check':'field');
        const tag = ['select','textarea'].includes(field.type) ? field.type : 'input';
        const input = element(tag);
        if (tag === 'input') input.type = field.type || 'text';
        if (field.type === 'email' && field.multiple) input.multiple = true;
        if (tag === 'select') for (const option of field.options) input.add(new Option(option,option));
        if (check) input.checked = values[field.label] === true;
        else input.value = interpolate(values[field.label],values,'');
        const remember = () => {
          values[field.label] = check ? input.checked : input.value;
          input.removeAttribute('aria-invalid');
          error.textContent = '';
        };
        input.addEventListener('input', remember);
        input.addEventListener('change', remember);
        inputs.set(field.label,input);
        const caption = element('span','',field.label);
        if (check) label.append(input,caption);
        else label.append(caption,input);
        fields.append(label);
      }
      sheet.append(fields);
    }
    if (state.rows?.length) {
      const rows = element('div','rows');
      for (const row of state.rows) {
        const node = row.to ? button('',()=>navigate(row.to),'row') : element('div','row');
        node.append(element('span','label',display(row.label)),element('span','value',display(row.value)));
        if (row.to) { node.dataset.to = row.to; node.append(symbol('chevron-right',15)); }
        rows.append(node);
      }
      sheet.append(rows);
    }
    if (state.note) sheet.append(element('p','note',display(state.note)));
    const error = element('p','field-error');
    error.setAttribute('role','alert');
    sheet.append(error);
    const actions = element('div','actions');
    for (const action of state.actions || []) {
      actions.append(button(display(action.label),()=>{
        const missing = (action.requires || []).find(label => !String(values[label] ?? '').trim() || values[label] === false);
        const invalid = (action.primary || action.requires) && [...inputs].find(([,input])=>!input.validity.valid)?.[0];
        const issue = missing || invalid;
        if (issue) {
          const input = inputs.get(issue);
          error.textContent = missing ? '请先完成「'+issue+'」。' : '请检查「'+issue+'」的格式。';
          input?.setAttribute('aria-invalid','true'); input?.focus();
          return;
        }
        const next = action.branch?.cases?.[values[action.branch.field]] || action.to;
        const updates = Object.entries(action.set || {}).map(([name,value])=>[name,typeof value === 'string' ? interpolate(value,values,'') : value]);
        for (const [name,value] of updates) values[name] = value;
        navigate(next);
      }, action.primary?'primary':''));
    }
    if (actions.childElementCount) sheet.append(actions);
    wrap.append(nav,sheet);
    viewport.replaceChildren(wrap);
    viewport.scrollTop = 0;
    heading.focus({preventScroll:true});
  }
  function render() {
    const route = readRoute();
    const section = route.kind + '/' + route.id;
    for (const link of document.querySelectorAll('.catalog-item')) {
      if (link.dataset.section === section) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    }
    const out = find('#standalone');
    const hiFi = route.kind === 'live' && ['hi-fi','hi-fi-brand'].includes(route.id);
    const {brand,icon} = window.MailUI;
    find('.identity strong').textContent = hiFi ? brand.name : '本地邮箱';
    const mark = find('.identity .mark');
    if (hiFi) {
      const logo = element('img');
      logo.src = brand.icon;
      logo.alt = '';
      logo.width = logo.height = 25;
      mark.replaceChildren(logo);
    } else {
      mark.innerHTML = icon('mail',23);
    }
    find('link[rel="icon"]').href = hiFi ? brand.icon : 'data:,';
    if (route.kind === 'live') {
      const [label,,hash,entry] = live.get(route.id);
      const design = hiFi ? '&design=hi-fi' : '';
      const url = 'index.html?designPreview=1' + design + (entry?'&entry='+entry:'') + '#' + hash;
      out.href = url;
      if (active !== section) {
        const frame = element('iframe');
        frame.title = label;
        frame.src = url;
        viewport.replaceChildren(frame);
      }
      document.title = label+' · 原型审阅';
    } else {
      const flow = flows.get(route.id);
      out.href = '?solo=1'+flowUrl(flow.id,route.state);
      renderFlow(flow,route.state);
      document.title = interpolate(flow.states[route.state].title,flowSession(flow))+' · 原型审阅';
    }
    active = section;
  }
  document.querySelectorAll('.review-bar [data-icon],.catalog-heading [data-icon]').forEach(span=>{span.innerHTML=window.MailUI.icon(span.dataset.icon,span.classList.contains('mark')?23:16)});
  function mode(value) {
    stage.dataset.mode = value;
    for (const item of document.querySelectorAll('.modes [data-mode]')) item.setAttribute('aria-pressed', String(item.dataset.mode === value));
  }
  document.querySelectorAll('.modes button').forEach(item=>item.addEventListener('click',()=>mode(item.dataset.mode)));
  document.querySelectorAll('.catalog-jumps button').forEach(control=>control.addEventListener('click',()=>{
    const heading = document.querySelectorAll('.catalog-group h2')[Number(control.dataset.group)];
    heading.focus({preventScroll:true}); heading.scrollIntoView({block:'start'});
  }));
  find('#open-catalog').addEventListener('click',()=>catalog.showModal());
  find('#close-catalog').addEventListener('click',()=>catalog.close());
  catalog.addEventListener('click',event=>{if(event.target===catalog){const r=catalog.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)catalog.close();}});
  if (new URLSearchParams(location.search).get('solo') === '1') document.body.classList.add('solo');
  function enterRoute() {
    render();
    if (location.hash === '#catalog' && !catalog.open) {
      find('#open-catalog').focus();
      catalog.showModal();
    }
  }
  window.addEventListener('hashchange',enterRoute);
  mode('desktop');
  enterRoute();
})();
