(() => {
  'use strict';

  const {brand, themes, pick} = window.MailDesignOptions;
  const params = new URLSearchParams(location.search);
  const scenes = new Map([
    ['inbox', 'inbox?account=all'],
    ['read', 'inbox?account=studio&id=m-proof'],
    ['welcome', 'welcome']
  ]);

  let theme = pick(params.get('theme'));
  let scene = scenes.has(params.get('scene')) ? params.get('scene') : 'inbox';
  let device = params.get('device');
  if (!['phone','desktop'].includes(device)) device = matchMedia('(max-width:800px)').matches ? 'phone' : 'desktop';

  const find = selector => document.querySelector(selector);
  const frame = find('#mail-preview');
  const devices = [...document.querySelectorAll('.devices button')];

  document.title = brand.name + ' · 主题预览';
  find('link[rel="icon"]').href = brand.icon;
  find('#product-icon').src = brand.icon;
  find('#product-name').textContent = brand.name;
  frame.title = brand.name + ' 主题预览';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  const cards = themes.map(item => {
    const button = element('button','theme-card');
    button.type = 'button';
    button.addEventListener('click',() => {theme = item; update();});
    const sample = element('span','sample');
    sample.setAttribute('aria-hidden','true');
    for (const key of ['rail','paper','border','selected','chip']) {
      sample.style.setProperty('--sample-'+key,item[key]);
    }
    sample.append(element('i','sample-rail'),element('i','sample-selected'),element('i','sample-action'));
    const copy = element('span','theme-copy');
    copy.append(element('strong','',item.name));
    if (item.tier) copy.append(element('small','',item.tier));
    button.append(sample,copy);
    find('#themes').append(button);
    return button;
  });

  function update() {
    cards.forEach((button,index) => button.setAttribute('aria-pressed',String(themes[index] === theme)));
    devices.forEach(button => button.setAttribute('aria-pressed',String(button.dataset.device === device)));
    find('#scene').value = scene;
    find('#preview').dataset.device = device;

    const app = 'index.html?' + new URLSearchParams({design:'options',theme:theme.id}) + '#' + scenes.get(scene);
    find('#standalone').href = app;
    if (frame.getAttribute('src') !== app) frame.setAttribute('src',app);

    const selection = new URLSearchParams({theme:theme.id,device,scene});
    // Local files can use the controls even when the browser restricts history changes.
    try { history.replaceState(null,'','?'+selection); } catch {}
  }

  devices.forEach(button => button.addEventListener('click',() => {device = button.dataset.device; update();}));
  find('#scene').addEventListener('change',event => {scene = event.target.value; update();});
  update();
})();
