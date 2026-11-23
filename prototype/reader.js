(() => {
  "use strict";

  const localeDate = new Intl.DateTimeFormat("zh-CN", {
    month: "long", day: "numeric", timeZone: "Asia/Shanghai"
  });
  const localeTime = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai"
  });
  const avatarColors = [
    ["#f0ded4", "#8b4c37"], ["#dfe8df", "#4b6553"],
    ["#e7e1ee", "#675579"], ["#e3e9ed", "#4c6576"],
    ["#f1e8ce", "#795f30"]
  ];
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => entities[character]);
  }

  function icon(name, size = 18) {
    return window.MailUI.icon(name, size);
  }

  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return { short: "", exact: "" };
    return {
      short: localeDate.format(date) + " " + localeTime.format(date),
      exact: date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) + "（北京时间）"
    };
  }

  function avatar(name, color) {
    const letters = Array.from(String(name || "邮"));
    const index = letters.reduce((sum, letter) => sum + letter.codePointAt(0), 0) % avatarColors.length;
    const [fallback, foreground] = avatarColors[index];
    const background = /^#[0-9a-f]{6}$/i.test(color || "") ? color : fallback;
    return '<span class="reader-avatar" aria-hidden="true" style="background:' + background
      + ';color:' + foreground + '">' + escape(letters[0]) + '</span>';
  }

  function tool(action, id, glyph, label, options = {}) {
    const pressed = typeof options.pressed === "boolean" ? ' aria-pressed="' + options.pressed + '"' : '';
    const extra = options.more ? ' aria-haspopup="true"' : '';
    return '<button type="button" class="reader-tool ' + (options.className || "")
      + '" data-action="' + action + '" data-id="' + escape(id) + '" title="' + escape(label)
      + '" aria-label="' + escape(label) + '"' + pressed + extra + '>' + icon(glyph, 17) + '</button>';
  }

  function renderTools(mail, returnLabel) {
    const hiFi = window.MailUI.hiFi;
    const reply = hiFi && mail.folder !== "drafts"
      ? '<button type="button" class="reader-command reader-command-primary reader-quick-reply" data-action="reply" data-id="'
        + escape(mail.id) + '">' + icon("reply", 16) + '<span>回复</span></button>'
      : '';
    return '<div class="reader-toolbar"><div class="reader-toolbar-label">'
      + tool("back-list", mail.id, "chevron-left", returnLabel ? "返回" + returnLabel : "返回邮件列表", { className: returnLabel ? "reader-cross-back" : "reader-back" })
      + '<span>' + (returnLabel ? escape(returnLabel) : hiFi ? '邮件' : '邮件详情') + '</span></div><div class="reader-tools" role="group" aria-label="邮件操作">'
      + tool("archive", mail.id, "archive", mail.folder === "archive" ? "移回原文件夹" : "归档")
      + tool("toggle-read", mail.id, mail.unread ? "mail-open" : "mail", mail.unread ? "标为已读" : "标为未读")
      + tool("star", mail.id, "star", mail.starred ? "取消星标" : "添加星标", { pressed: !!mail.starred })
      + '<span class="reader-tool-divider" aria-hidden="true"></span>'
      + tool("more", mail.id, "more", "更多操作", { more: true })
      + reply + '</div></div>';
  }

  function metadata(mail, account) {
    const name = mail.fromName || mail.fromEmail || "未知发件人";
    const date = formatDate(mail.date);
    const recipient = Array.isArray(mail.to) ? mail.to.join("、") : String(mail.to || "");
    const singleAddress = recipient.trim().replace(/^[^<>,;]*<([^<>]+)>$/, "$1");
    const originalFolder = mail.folder === "archive" ? mail.archivedFrom : mail.folder;
    const outgoing = ["sent", "outbox", "drafts"].includes(originalFolder);
    const toMe = !outgoing && account?.email && singleAddress.toLowerCase() === account.email.toLowerCase();
    const mailbox = account || mail.accountId === "local" ? window.MailViews.mailboxName(mail.accountId) : "";
    let summary = recipient ? "发给 " + recipient : "未填写收件人";
    if (toMe) {
      summary = window.MailDemo.accounts.length > 1 ? "发给我 · " + mailbox : "发给我";
    }
    return '<div class="reader-metadata">' + avatar(name, mail.avatar) + '<div class="reader-who"><div class="reader-from">'
      + escape(name) + '</div><details class="reader-addresses"><summary aria-label="' + escape(summary) + '，收发件详情">'
      + '<span>' + escape(summary) + '</span>' + icon("chevron-down", 12)
      + '</summary><div class="reader-address-card"><dl>'
      + '<dt>发件人</dt><dd>' + escape(mail.fromEmail || name) + '</dd>'
      + '<dt>收件人</dt><dd>' + escape(recipient || "未填写") + '</dd>'
      + (mailbox ? '<dt>所属邮箱</dt><dd>' + escape(mailbox) + '</dd>' : '')
      + '</dl></div></details></div><time class="reader-date" datetime="' + escape(mail.date) + '" title="'
      + escape(date.exact) + '">' + escape(date.short) + '</time></div>';
  }

  function bodyParagraphs(mail) {
    const raw = Array.isArray(mail.body) ? mail.body : [mail.body || ""];
    return raw.filter(part => typeof part === "string" && part.trim())
      .map(part => '<p>' + escape(part) + '</p>').join("");
  }

  function fileExtension(file) {
    const match = /\.([a-z0-9]{1,6})$/i.exec(file.name || "");
    return match ? match[1].toUpperCase() : "FILE";
  }

  function humanSize(file) {
    if (typeof file.size === "string") return file.size;
    const bytes = Number(file.bytes ?? file.size);
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function attachments(mail) {
    const files = mail.attachments || [];
    if (!files.length) return "";
    const previewId = mail.id === "m-proof" ? files.find(f => fileExtension(f) === "PDF")?.id : null;
    return '<section class="reader-attachments" aria-label="邮件附件"><h3>' + icon("paperclip", 14)
      + '<span>' + files.length + ' 个附件</span></h3><div class="reader-files">'
      + files.map(file => {
        const ext = fileExtension(file);
        const preview = previewId != null && file.id === previewId;
        const label = file.name || "未命名附件";
        return '<button type="button" class="reader-file' + (preview ? " reader-file-preview" : "")
          + '" data-action="attachment" data-id="' + escape(file.id) + '" aria-label="查看附件：' + escape(label) + '">'
          + (preview ? '<img class="reader-cover" src="./assets/winter-proof.png" alt="" />' : '')
          + '<span class="reader-file-details"><span class="reader-filetype" aria-hidden="true">' + escape(ext) + '</span>'
          + '<span class="reader-file-meta"><strong>' + escape(label) + '</strong><small>' + escape(humanSize(file))
          + '</small></span><span class="reader-file-open" aria-hidden="true">' + icon("arrow-up-right", 16) + '</span>'
          + '</span></button>';
      }).join("") + '</div></section>';
  }

  function actions(mail) {
    if (window.MailUI.hiFi) return '<footer class="reader-footer"></footer>';
    const id = escape(mail.id);
    return '<footer class="reader-footer"><button type="button" class="reader-command reader-command-primary" '
      + 'data-action="reply" data-id="' + id + '">' + icon("reply", 16) + '<span>回复</span></button>'
      + '<button type="button" class="reader-command" data-action="forward" data-id="' + id + '">'
      + icon("forward", 16) + '<span>转发</span></button></footer>';
  }

  function render(mail, account, returnLabel = "") {
    if (!mail) {
      return '<div class="reader-empty">' + icon("mail-open", 32)
        + '<h2>选择一封邮件</h2><p>邮件内容会显示在这里。</p></div>';
    }
    return '<div class="mail-reader">' + renderTools(mail, returnLabel) + '<article class="reader-article" aria-labelledby="reader-subject">'
      + '<header class="reader-heading"><h2 id="reader-subject" tabindex="-1">' + escape(mail.subject || "无主题")
      + '</h2>' + metadata(mail, account) + '</header><div class="reader-body">' + bodyParagraphs(mail)
      + '</div>' + attachments(mail) + actions(mail) + '</article></div>';
  }

  window.MailReader = { render };
})();
