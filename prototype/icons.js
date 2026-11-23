(() => {
  const paths = {
    inbox:'<path d="M4 4h16l3 10v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-5L4 4Z"/><path d="M2 14h6l2 3h4l2-3h6"/>',
    mail:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 6 8 6 8-6"/>',
    'mail-open':'<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z"/><path d="m3 11 9 6 9-6"/>',
    pen:'<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"/><path d="m11 15 1-4 8-8 3 3-8 8-4 1Z"/>',
    star:'<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9L12 3Z"/>',
    send:'<path d="m21 3-7 18-3.8-7.2L3 10l18-7Z"/><path d="m10.2 13.8 5.5-5.5"/>',
    draft:'<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7m-7 4h5"/>',
    archive:'<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9m-10 4h6"/>',
    outbox:'<path d="M4 15h4l2 3h4l2-3h4v5H4zM12 13V3m-4 4 4-4 4 4"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', paperclip:'<path d="m9 14 6.6-6.6a2.3 2.3 0 0 1 3.2 3.2l-8.4 8.5a4.3 4.3 0 0 1-6.1-6.1l8.9-8.9a3.4 3.4 0 0 1 4.8 0"/>',
    sparkles:'<path d="m12 3 1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8.8-2.2Z"/>',
    drive:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 14h18m-5 3h2"/>',
    settings:'<path d="m9.3 3-.5 2.4-2 .9-2.2-.8-2 3.4 1.8 1.6v2.7L2.6 15l2 3.5 2.4-.8 1.8 1 .5 2.3h4.2L14 19l2-1.1 2.4.7 2-3.4-1.8-1.8v-2.6l1.8-1.8-2-3.3-2.3.8-2-1L13.5 3z"/><circle cx="11.5" cy="12" r="3"/>',
    menu:'<path d="M3 6h18M3 12h18M3 18h18"/>', panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
    file:'<path d="M5 3h9l5 5v13H5zM14 3v6h5"/>',
    folder:'<path d="M3 5h6l2 3h10v11H3z"/>',
    filters:'<path d="M3 6h18M6 12h12m-9 6h6"/>', sort:'<path d="M7 4v15m-3-3 3 3 3-3m3-10h8m-8 5h6m-6 5h4"/>',
    'chevron-left':'<path d="m15 5-7 7 7 7"/>','chevron-right':'<path d="m9 5 7 7-7 7"/>','chevron-down':'<path d="m6 9 6 6 6-6"/>',
    'arrow-down':'<path d="M12 3v17m-6-6 6 6 6-6"/>','arrow-up-right':'<path d="M6 18 18 6M8 6h10v10"/>',
    reply:'<path d="m9 5-6 6 6 6m-5-6h7c5 0 8 2 10 8v-2c0-4-2-9-9-9"/>',
    forward:'<path d="m15 5 6 6-6 6m5-6h-7c-5 0-8 2-10 8v-2c0-4 2-9 9-9"/>',
    download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>', import:'<path d="M4 15v5h16v-5M12 3v12m-5-5 5 5 5-5"/>',
    more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', x:'<path d="m6 6 12 12m0-12L6 18"/>',
    check:'<path d="m4 12 5 5L20 6"/>', lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>',
    sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2m0-14-2 2M7 17l-2 2"/>',moon:'<path d="M20 15a8 8 0 0 1-11-11A9 9 0 1 0 20 15Z"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4H4v13h4"/>',
    printer:'<path d="M7 8V3h10v5M7 18H3v-9h18v9h-4M7 15h10v7H7z"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>'
  };
  const escape = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const icon=(name,size=18)=>'<svg aria-hidden="true" focusable="false" width="'+Number(size)+'" height="'+Number(size)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">'+(paths[name]||paths.file)+'</svg>';
  const params = new URLSearchParams(location.search);
  const design = params.get('design');
  const hiFi = design === 'options' || design === 'hi-fi';
  const options = window.MailDesignOptions;
  const concept = hiFi ? options.pick(params.get('theme')) : null;
  const storagePrefix = design === 'options' ? 'design-options:' : design === 'hi-fi' ? 'hi-fi:' : params.get('designPreview') === '1' ? 'review:' : '';
  const brand = options.brand;
  if (hiFi) {
    document.documentElement.dataset.design = 'hi-fi';
    document.querySelector('link[rel="icon"]').href = brand.icon;
  }
  if (concept) options.apply(concept);
  window.MailUI = {icon, escape, storagePrefix, hiFi, brand, concept};
})();
