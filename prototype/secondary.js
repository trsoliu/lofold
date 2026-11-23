/* Secondary views are rendered from local state. The application shell owns the events. */
(() => {
  const {icon, escape} = window.MailUI;
  const accounts = () => Array.isArray(window.MailDemo?.accounts) ? window.MailDemo.accounts : [];
  const accountLabel = a => a.name || a.label || a.email || a.id;
  function mailboxName(id) {
    if (id === 'all') return '全部邮箱';
    if (id === 'local') return '本地档案';
    const choices = accounts();
    const account = choices.find(a => a.id === id);
    if (!account) return '未知邮箱';
    const label = accountLabel(account);
    const duplicate = ['全部邮箱','本地档案'].includes(label) || choices.some(a => a.id !== id && accountLabel(a) === label);
    return duplicate && account.email && account.email !== label ? label + '（' + account.email + '）' : label;
  }
  const option = (value, label, selected) => '<option value="' + escape(value) + '"' + (selected ? ' selected' : '') + '>' + escape(label) + '</option>';
  const questionExpense = '哪笔差旅报销还缺发票？';
  const questionQuote = '哪些报价还没有回复？';

  function storage(context) {
    const formats = {'store-mail-photo':['EML','mail'], 'store-csv':['CSV','file'], 'store-short':['EML','file']};
    const samples = window.MailDemo.storage.map(sample => {
      const [type, glyph] = formats[sample.id] || ['文件','file'];
      return {...sample, type, icon:glyph};
    });
    const before = samples.reduce((sum, sample) => sum + sample.before, 0);
    const after = samples.reduce((sum, sample) => sum + sample.after, 0);
    const rows = samples.map(s => '<li class="mx-file-row"><span class="mx-file-icon">' + icon(s.icon, 18) + '</span><span class="mx-file-name"><strong>' + escape(s.name) + '</strong><small>' + s.type + '</small></span><span class="mx-comparison"><span>' + s.before + ' KiB</span>' + icon('chevron-right', 13) + '<b>' + s.after + ' KiB</b></span></li>').join('');
    return '<section class="mx-page mx-storage"><header class="mx-page-head"><div class="mx-section-symbol">' + icon('drive', 22) + '</div><h2>本地存储</h2><p>查看邮件原件和附件在设备上占用的空间。</p></header>' +
      (window.MailOffline?.panel(context) || '') + '<section class="mx-study" aria-labelledby="mx-study-title"><div class="mx-study-caption"><h3 id="mx-study-title">样本压缩节省</h3><span class="mx-subnote">自动无损压缩</span></div>' +
      '<div class="mx-stat">' + (before - after) + ' <span>KiB</span></div><div class="mx-meter-row"><span>压缩前</span><div class="mx-meter"><i style="width:100%"></i></div><b>' + before + ' KiB</b></div><div class="mx-meter-row mx-after"><span>压缩后</span><div class="mx-meter"><i style="width:' + (before ? 100 * after / before : 0) + '%"></i></div><b>' + after + ' KiB</b></div></section>' +
      '<section class="mx-storage-samples"><div class="mx-section-heading"><h3>文件占用对比</h3><span>' + samples.length + ' 个合成样本</span></div><ul class="mx-file-list">' + rows + '</ul></section>' +
      '<details class="mx-disclosure"><summary>这些数字是怎么测出来的？</summary><p>来自同一台 Mac 上三个独立载荷文件的磁盘分配量。短邮件压缩后内容更小，前后仍各占一个 4 KiB 磁盘块。样本不包含数据库、索引、认证加密和预览缓存。</p></details>' +
      (window.MailCompressionDemo?.panel() || '') + '</section>';
  }

  function messageText(m) {
    return [m.subject, m.preview, ...(Array.isArray(m.body) ? m.body : [m.body]), ...(m.attachments || []).map(f => f.name)].filter(Boolean).join(' ');
  }

  function dateLabel(value) {
    const d = new Date(value);
    return Number.isNaN(d.valueOf()) ? '' : d.toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai', month:'short', day:'numeric'});
  }

  function citation(m, status, showAccount) {
    const summary = m.preview || (Array.isArray(m.body) ? m.body.find(Boolean) : m.body) || '';
    const details = [m.fromName || m.fromEmail, showAccount ? mailboxName(m.accountId) : '', dateLabel(m.date), status].filter(Boolean);
    return '<button type="button" class="mx-citation" data-action="open-message" data-id="' + escape(m.id) + '"><span class="mx-cite-icon">' + icon('mail', 17) +
      '</span><span class="mx-cite-copy"><strong>' + escape(m.subject || '无主题') + '</strong><span>' + escape(details.join(' · ')) +
      '</span><small>' + escape(String(summary).slice(0, 85)) + '</small></span>' + icon('chevron-right', 15) + '</button>';
  }

  function answer(scoped, question, showAccount) {
    if (/报价/.test(question)) {
      const sent = scoped.filter(m => (m.folder === 'sent' || (m.folder === 'archive' && m.archivedFrom === 'sent')) && /报价/.test(messageText(m)));
      const results = sent.map(original => {
        const reply = window.MailFollowup.findReply(original, scoped, accounts());
        return {original, reply};
      });
      const pending = results.filter(item => !item.reply);
      return {heading: !results.length ? '当前范围未找到已发报价' : pending.length ? '有 ' + pending.length + ' 封报价未找到后续回信' : '查到的报价都有后续回信',
        note:'在所选邮箱的本地邮件中，核对原收件人后续来信引用的原信。',
        items: results.flatMap(({original, reply}) => reply ? [citation(original, '已发报价', showAccount), citation(reply, '对应回信', showAccount)] : [citation(original, '未见回信', showAccount)])};
    }
    if (/缺|待补|补齐/.test(question) && /发票|报销|差旅/.test(question)) {
      const matches = scoped.flatMap(m => {
        const parts = (Array.isArray(m.body) ? m.body : [m.body || '']).join('。').split(/[。！？\n]+/);
        const evidence = parts.find(line => /(?:只缺|还缺|尚缺|缺少|还差).{0,22}(?:发票|凭证)|(?:发票|凭证).{0,12}(?:待补|未收到)/.test(line));
        return evidence ? [{message:m, evidence}] : [];
      });
      return {heading: matches.length ? '有 ' + matches.length + ' 封邮件明确提到了缺少凭证' : '当前范围未找到明确的缺票记录',
        note: matches.length ? '原信写道：“' + matches[0].evidence + '。”' : '调大范围或打开原信核对。仅凭附件名称，无法判断材料是否收齐。',
        items: matches.map(({message}) => citation(message, '原文提及缺项', showAccount))};
    }
    if (/报销|发票|差旅/.test(question)) {
      const matches = scoped.filter(m => /报销|差旅|发票/.test(messageText(m)));
      return {heading: matches.length ? '找到 ' + matches.length + ' 封差旅报销相关邮件' : '当前范围未找到差旅报销邮件',
        note:'按主题、正文和附件名匹配“差旅”“报销”或“发票”。点击原信核对材料。', items: matches.map(m => citation(m, '', showAccount))};
    }
    const phrase = question.trim().toLocaleLowerCase();
    const matches = scoped.filter(m => messageText(m).toLocaleLowerCase().includes(phrase));
    return {heading: matches.length ? '找到 ' + matches.length + ' 封匹配邮件' : '当前范围未找到匹配邮件', note:'当前原型以完整关键词在本机匹配。可缩短关键词，或选择示例问题。', items: matches.map(m => citation(m, '', showAccount))};
  }

  function aiAnswer(messages,scope,asked){
    const scoped = messages.filter(m => (scope === 'all' || m.accountId === scope) && !['drafts','outbox','trash'].includes(m.folder)).sort((a,b) => new Date(b.date)-new Date(a.date));
    const result = answer(scoped,asked,scope==='all');
    return '<p class="mx-user-question">' + escape(asked) + '</p><h3>' + escape(result.heading) + '</h3><p class="mx-answer-note">' + escape(result.note) + '</p>' + (result.items.length ? '<div class="mx-citations">' + result.items.join('') + '</div>' : '');
  }

  function ai(messages, scope = 'all', question = '', scopeControl = '') {
    const asked = String(question || '').trim();
    const examples = [questionExpense, questionQuote].map((q,i) => '<button class="mx-suggestion" type="button" data-action="ai-ask" data-question="' + escape(q) + '">' + icon(i ? 'mail':'file',16) + escape(q) + icon('chevron-right',14) + '</button>').join('');
    const resultHtml = asked ? '<section class="mx-answer" aria-live="polite">' + aiAnswer(messages,scope,asked) + '</section>' : '';
    return '<section class="mx-page mx-ai"><header class="mx-page-head"><div class="mx-section-symbol">' + icon('sparkles',23) + '</div><h2>AI 查信</h2><p>查找邮件，回答附原信。</p></header>' +
      '<div class="mx-query-box">' + scopeControl +
      '<form class="mx-question-form" data-ai-form><input name="question" aria-label="查信问题" autocomplete="off" placeholder="在邮箱里查找什么？"><button type="submit" class="mx-query-submit" aria-label="提交问题" data-action="ai-ask">' + icon('arrow-up-right',19) + '</button></form></div>' +
      '<div class="mx-suggestions">' + examples + '</div>' + resultHtml + '<p class="mx-local-hint">' + icon('lock',15) + '离线演示 · 在本机按条件检索，未运行 AI 模型。</p></section>';
  }

  function compose(draft = {}) {
    const choices = accounts();
    const active = draft.accountId;
    const placeholder = draft.chooseDefault ? '<option value="" selected disabled>选择默认发件邮箱…</option>' : '';
    const localOption = active === 'local' ? option('local', '本地草稿', true) : '';
    const opts = placeholder + localOption + choices.map(a => option(a.id, a.email || accountLabel(a), a.id === active)).join('');
    const body = Array.isArray(draft.body) ? draft.body.join('\n\n') : String(draft.body ?? '');
    return '<section class="mx-modal mx-compose"><header class="mx-modal-head"><div><span class="mx-inline-symbol">' + icon('pen',20) + '</span><h2>' + (draft.isReply ? '回复邮件' : '写邮件') + '</h2></div><button type="button" class="mx-icon-btn" data-action="close-modal" aria-label="关闭写信窗口">' + icon('x') + '</button></header>' +
      '<div class="mx-compose-fields"><label><span>发件人</span><select name="accountId" aria-label="发件账号"' + (draft.chooseDefault ? ' aria-describedby="compose-sender-hint"' : '') + '>' + opts + '</select></label>' +
      (draft.chooseDefault ? '<p id="compose-sender-hint" class="mx-sender-hint">首次选择将作为「所有收件箱」的默认发件人，可在工作区设置中更改。</p>' : '') +
      '<label><span>收件人</span><input name="to" type="text" inputmode="email" autocomplete="off" placeholder="输入邮箱地址" value="' + escape(draft.to || '') + '"></label><div id="compose-contact"></div>' +
      '<label><span>主题</span><input name="subject" type="text" autocomplete="off" placeholder="邮件主题" value="' + escape(draft.subject || '') + '"></label></div>' +
      '<div class="compose-inserts"><button type="button" data-action="pick-compose-file" class="mx-attach">' + icon('paperclip',15) + '添加附件</button><input id="compose-file" type="file" multiple hidden><label>快捷文本<select data-action="phrase" aria-label="插入快捷文本"><option value="">选择短语…</option><option value="receipt">确认收到</option><option value="review">请对方确认</option><option value="thanks">致谢</option></select></label>' + window.MailFollowup.compose(draft.followDays) + '</div>' +
      '<div id="compose-files"></div><textarea name="body" aria-label="邮件正文" placeholder="在这里撰写邮件…">' + escape(body) + '</textarea>' +
      '<div id="compose-review" class="mx-compose-review" tabindex="-1" role="region" aria-label="发送前检查" hidden></div><p id="compose-error" class="mx-compose-error" role="alert"></p>' +
      '<footer class="mx-compose-foot"><span class="mx-demo-note">仅本机演示</span><button type="button" class="mx-sub-btn" data-action="save-draft">保存草稿</button><button type="button" class="mx-primary-btn" data-action="send-demo">' + icon('send',15) + '模拟发送</button></footer></section>';
  }

  function welcome() {
    const {hiFi, brand} = window.MailUI;
    const mark = hiFi
      ? '<img class="mx-welcome-logo" src="' + escape(brand.icon) + '" width="78" height="78" alt="">'
      : '<span class="mx-welcome-mark">' + icon('mail',26) + '</span>';
    const title = hiFi ? brand.name : '打开本地邮箱';
    const intro = hiFi ? brand.slogan : '直接在设备上阅读、搜索和整理邮件，无需注册产品账号。';
    return '<section class="mx-modal mx-welcome"><header class="mx-welcome-top">' + mark
      + '<button type="button" class="mx-icon-btn" aria-label="关闭欢迎页" data-action="close-modal">' + icon('x')
      + '</button></header><h2>' + escape(title) + '</h2><p>' + escape(intro) + '</p>'
      + '<div class="mx-welcome-actions"><button type="button" data-action="import">' + icon('import') + '<span><strong>导入本地邮件</strong><small>从设备选择一封 EML 文件</small></span>' + icon('chevron-right',16) + '</button><button type="button" data-action="add-account">' + icon('plus') + '<span><strong>添加邮箱</strong><small>查看账号接入流程</small></span>' + icon('chevron-right',16) + '</button><button type="button" data-action="enter-empty">' + icon('folder') + '<span><strong>进入空白工作区</strong><small>稍后再添加邮件</small></span>' + icon('chevron-right',16) + '</button></div><button type="button" data-action="demo" class="mx-primary-btn mx-demo-open">体验示例收件箱' + icon('chevron-right',16) + '</button></section>';
  }

  window.MailViews = {storage, ai, aiAnswer, compose, welcome, mailboxName};
})();
