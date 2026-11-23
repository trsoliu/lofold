/* 本地原型的虚构邮箱和示例文件，全部内容在浏览器内生成。 */
(() => {
  "use strict";

  const accounts = [
    { id: "personal", name: "个人邮箱", email: "zhouyu@example.test", color: "#557b67" },
    { id: "studio", name: "工作室", email: "studio@example.test", color: "#9c6850" },
  ];
  const byAccount = Object.fromEntries(accounts.map(account => [account.id, account]));
  const ownName = "周予";

  // 生成一页含中文文字的标准 PDF。流与交叉引用表均使用 ASCII，字节偏移可直接计算。
  function smallPdf(lines) {
    const hex = line => Array.from(line, char =>
      char.charCodeAt(0).toString(16).padStart(4, "0")).join("").toUpperCase();
    const stream = "BT /F1 17 Tf 50 730 Td 28 TL\n"
      + lines.map(line => "<" + hex(line) + "> Tj T*").join("\n") + "\nET\n";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        + "/Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
      "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light "
        + "/Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>",
      "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
        + "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>",
      "<< /Length " + stream.length + " >>\nstream\n" + stream + "endstream",
    ];
    let output = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(output.length);
      output += (index + 1) + " 0 obj\n" + object + "\nendobj\n";
    });
    const xref = output.length;
    output += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
    output += offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join("");
    return output + "trailer\n<< /Size " + (objects.length + 1)
      + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  }

  function file(id, name, type, content, previewText = content) {
    const bytes = new TextEncoder().encode(content).byteLength;
    const size = bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(1) + " KiB";
    return {
      id, name, type, content, previewText, bytes, size,
      kind: name.split(".").pop().toLowerCase(),
      dataUrl: "data:" + type + "," + encodeURIComponent(content),
    };
  }

  function pdf(id, name, lines) {
    return file(id, name, "application/pdf", smallPdf(lines), lines.join("\n"));
  }

  function note(id, name, content) {
    return file(id, name, "text/plain", content);
  }

  function csv(id, name, content) {
    return file(id, name, "text/csv", "\uFEFF" + content, content);
  }

  const proof = {
    id: "a-proof", name: "冬日散步指南_二校.pdf", kind: "pdf", type: "application/pdf",
    bytes: 355912, size: "347.6 KiB", dataUrl: location.protocol === "file:" ? window.MailProofPDF : "./assets/winter-proof.pdf",
    previewUrl: "./assets/winter-proof.png", previewText: "《冬日散步指南》第二版打样封面",
  };
  const paper = note("a-paper", "纸样与装订说明.txt",
    "纸样与装订说明\n\nA 样为偏暖的米白，B 样为中性自然白。\n地图折页另做一道压线。\n留意书脊与封面衔接。\n");
  const expense = csv("a-expense", "苏州差旅明细.csv",
    "日期,项目,金额,凭证状态\r\n2026-11-10,去程车票,128.00,已附\r\n2026-11-11,返程车票,128.00,已附\r\n2026-11-10,住宿,368.00,待酒店开票\r\n");
  const rail = pdf("a-rail", "往返车票凭证.pdf",
    ["苏州差旅行程记录", "11 月 10 日 去程 128 元", "11 月 11 日 返程 128 元", "合成样例，不能用于报销。"]);
  const quote = pdf("a-print", "手册印制报价.pdf",
    ["手册印制报价", "数量：三百册", "单价：十八元五角", "合计：五千五百五十元", "本文件为原型合成样例。"]);
  const photo = pdf("a-photo", "静物拍摄报价.pdf",
    ["静物拍摄报价", "半天拍摄，六张精修图", "报价：二千四百元", "本文件为原型合成样例。"]);
  const guide = note("a-reading", "本周朗读片段.txt",
    "本周朗读片段\n\n自选一段不超过三分钟的文字。\n可以带一件与这段文字有关的小物。\n周六下午两点在一楼长桌集合。\n");
  const layout = csv("a-stock", "摊位清单.csv",
    "物品,数量,备注\r\n木夹,12,展板\r\n桌布,2,米白\r\n标价牌,8,留两个空白位\r\n");
  const checklist = note("a-lens", "镜头检查单.txt",
    "镜头检查单\n\n出发前带好 35mm 镜头、遮光罩和备用电池。\n沿河路面可能湿滑，带一条擦镜布。\n");
  const oldInvoice = pdf("a-old-expense", "住宿发票样例.pdf",
    ["十月杭州差旅归档", "住宿凭证已收到", "本条属于十月，与十一月的苏州差旅无关。", "本文件为原型合成样例。"]);

  function message(id, accountId, folder, fromName, fromEmail, date, subject, preview, body, extra = {}) {
    const account = byAccount[accountId];
    return {
      id, accountId, folder, fromName, fromEmail, to: account.email, date: date + ":00+08:00",
      subject, preview, body, unread: false, starred: false, attachments: [],
      avatar: "#e9e6df", rfcMessageId: "<" + id + "@example.test>", ...extra,
    };
  }

  const messages = [
    message("m-proof", "studio", "inbox", "林知夏", "zhixia@example.test", "2026-11-20T10:42",
      "冬日散步指南 · 第二版打样确认", "纸样今天上午到了，暖一点的米白和照片很搭。想再和你确认一下折页的位置。",
      ["周予，早上好！",
        "纸样今天上午到了，暖一点的米白和照片很搭。我把第二版打样放在附件里，书脊已经按昨天说的加宽了 1 毫米。",
        "地图折页我想放在第 24 页后面，刚好接上河边那段路线。你翻翻看，顺的话我们周一就可以定纸。",
        "如果方便，周六带上纸样，来店里一起看自然光下的效果。", "知夏"],
      { unread: true, starred: true, avatar: "#eee3d6", attachments: [proof, paper] }),
    message("m-expense", "studio", "inbox", "陈澄", "chencheng@example.test", "2026-11-20T09:38",
      "苏州差旅报销，还差一张住宿发票", "车票和明细我收到了，酒店那张发票补上就可以归档了。",
      ["周予你好，", "我核对了苏州这趟的报销材料，两张车票一共 256 元，住宿 368 元。附件是我整理的明细和车票凭证。",
        "目前只缺酒店那张住宿发票。等酒店开好后，请回复这封信补一份 PDF。", "陈澄"],
      { unread: true, avatar: "#dcebe1", attachments: [expense, rail] }),
    message("m-reading", "personal", "inbox", "宋以安", "yian@example.test", "2026-11-20T08:51",
      "周六读书会，给你留了靠窗的位置", "这周聊城市里的散步，记得带上你那本旧地图。",
      ["周予，", "周六下午两点，我们在沿岸书店一楼读书。给你留了靠窗的座位。",
        "这周聊城市里的散步，你上次提到的那本旧地图很合适。如果愿意，也可以选一段小短文读给大家。", "以安"],
      { unread: true, avatar: "#e5e3ef", attachments: [guide] }),
    message("m-print-reply", "studio", "inbox", "周远山", "yuanshan@example.test", "2026-11-19T16:32",
      "回复：手册印制报价", "报价收到了，300 册按这版走。请把预计交付日也发给我。",
      ["周予你好，", "报价收到了，300 册、每册 18.50 元，合计 5,550 元。这版我们确认。",
        "麻烦再发一下预计交付日期，我来安排到店陈列。谢谢！", "远山"],
      { starred: true, avatar: "#e3e9df", threadId: "quote-print", inReplyTo: "<m-print-sent@example.test>" }),
    message("m-stall", "studio", "inbox", "许小满", "xiaoman@example.test", "2026-11-19T14:17",
      "冬日纸集｜摊位清单更新了", "桌布和木夹已经备齐，标价牌我多留了两张。",
      ["小满来报到。", "摊位清单又过了一遍：桌布和木夹都有，标价牌多留了两个空白位。",
        "周日早上我先去领摊位号，到了在入口等你。", "小满"],
      { avatar: "#f1e2d9", attachments: [layout] }),
    message("m-lens", "personal", "inbox", "顾南", "gunan@example.test", "2026-11-19T10:05",
      "周日沿河拍照，带一支 35mm 就好", "日出前在桥东碰头吧，沿河那排梧桐现在正好。",
      ["周予，", "看了天气，周日清早云不厚。我们 06:40 在老桥东侧碰头，沿河走四十分钟。",
        "我带三脚架，你带一支 35mm 就好。树下路面有点湿，鞋底记得防滑。", "顾南"],
      { unread: true, avatar: "#dbe7ea", attachments: [checklist] }),
    message("m-library", "personal", "inbox", "小岛图书馆", "library@example.test", "2026-11-18T18:20",
      "你预约的《纸的四季》已到馆", "取书架 B-12，预约保留到本周日闭馆前。",
      ["周予，你好。", "你预约的《纸的四季》现在可以领取，放在一层自取架 B-12。",
        "预约保留到 11 月 22 日 18:00。如计划有变，回信告诉我们即可。", "小岛图书馆"],
      { avatar: "#dce7db" }),
    message("m-wall", "studio", "inbox", "唐禾", "tanghe@example.test", "2026-11-18T11:46",
      "展墙那行字，可以再靠左一点", "我在现场比了一下，靠左两厘米后，入口就能读到完整句子。",
      ["周予好，", "我下午又去了一趟展厅。把标题往左挪两厘米，从入口看就不会被门框遮住。",
        "字重维持现在这样，周五我带卷尺一起确认。", "唐禾"],
      { avatar: "#ece4d2" }),
    message("m-market", "personal", "inbox", "晴日菜园", "garden@example.test", "2026-11-17T17:24",
      "这周的蔬菜盒里有一把小茴香", "下周一傍晚照常配送，附上农场的一个家常做法。",
      ["周予你好，", "这周菜盒里会多一把新剪的小茴香，和土豆一起煮很香。",
        "下周一傍晚照常配送。你上次留的两个空篮子，我们也会顺路取回。", "晴日菜园"],
      { avatar: "#e3e8d3" }),
    message("m-type", "studio", "inbox", "贺悠", "heyou@example.test", "2026-11-17T09:30",
      "小标题的字距，我试了两个版本", "窄版更适合目录，宽版在折页上有呼吸感。",
      ["周予，", "小标题排了宽窄两个版本，我倾向于目录用窄版、折页保留宽版。",
        "周四来工作室时可以一起看实物，再决定书签用哪一种。", "贺悠"],
      { avatar: "#e7dfee" }),
    message("m-mug", "personal", "inbox", "林阿姨", "auntlin@example.test", "2026-11-16T15:18",
      "你上次做的杯子出窑啦", "釉色比试片淡一点，很像雨后的石阶。",
      ["小周，", "上回做的小杯子已经出窑了，釉色偏浅，很耐看。我放在教室右边第二格。",
        "不用急着来拿，周末上课时带走就好。", "林阿姨"],
      { starred: true, avatar: "#eeded7" }),
    message("m-transfer", "studio", "inbox", "余青", "yuqing@example.test", "2026-11-16T10:09",
      "十一月插画稿费已转出", "款项今天已付，请有空核对一下。",
      ["周予，", "十一月的两张内页插画稿费今天已经转出。感谢这次一起赶进度！",
        "收到了给我回个消息就好。", "余青"],
      { avatar: "#dfe5ef" }),
    message("m-dinner", "personal", "inbox", "闻舟", "wenzhou@example.test", "2026-11-15T17:28",
      "下周的晚饭就定在小巷里吧", "那家店周末开始有萝卜炖牛腩，我约了四人的桌。",
      ["大家好，", "下周六晚上六点半，还是旧邮局背面那家菜馆。我约了靠里面的桌，不用排队。", "闻舟"],
      { avatar: "#e4e8dd" }),
    message("m-stamps", "personal", "inbox", "袁一白", "yibai@example.test", "2026-11-14T12:24",
      "寄给你的两枚旧邮票", "邮筒取信是下午四点，算起来周一该到了。",
      ["周予，", "我把上次说的两枚旧邮票夹在明信片里寄出了。蓝色那枚是沿海灯塔。", "收到后告诉我一声。", "一白"],
      { avatar: "#e2e4ef" }),
    message("m-photo-sent", "studio", "sent", ownName, byAccount.studio.email, "2026-11-13T14:06",
      "静物拍摄报价，供你参考", "半天拍摄包含六张精修图，共 2,400 元。",
      ["季遥你好，", "附件是静物拍摄的报价。半天拍摄包含六张精修图，共 2,400 元。",
        "如需增加场景，我可以另列明细。方便时告诉我你的想法。", "周予"],
      { to: "jiyao@example.test", threadId: "quote-photo", avatar: "#dcebe1", attachments: [photo] }),
    message("m-print-sent", "studio", "sent", ownName, byAccount.studio.email, "2026-11-12T15:15",
      "手册印制报价", "300 册含装订，每册 18.50 元，请核对随信明细。",
      ["远山你好，", "按 300 册核算，手册含装订每册 18.50 元，合计 5,550 元。附件有本次报价。",
        "如果数量和装订方式合适，回信确认后我们安排纸张。", "周予"],
      { to: "yuanshan@example.test", threadId: "quote-print", avatar: "#dcebe1", attachments: [quote] }),
    message("m-draft-work", "studio", "drafts", ownName, byAccount.studio.email, "2026-11-20T09:12",
      "下次开工作室的时间", "我想把周末开放的时间换到下午……",
      ["小满，", "我想把下次开放工作室的时间换到周六下午，大家赶过来会宽裕一点。"],
      { to: "xiaoman@example.test", avatar: "#dcebe1" }),
    message("m-arch-invoice", "studio", "archive", "陈澄", "chencheng@example.test", "2026-10-29T11:40",
      "杭州差旅报销已归档", "十月杭州的住宿和车票凭证已收齐。",
      ["周予你好，", "十月杭州的住宿和车票都已核对，存档编号是 HZ-10。附件是住宿凭证副本。", "陈澄"],
      { avatar: "#dcebe1", attachments: [oldInvoice] }),
    message("m-arch-repair", "personal", "archive", "陆师傅", "luxiu@example.test", "2026-10-25T15:07",
      "台灯已经修好，可以来取了", "换了一个拨动开关，原来的铜底座保留着。",
      ["小周你好，", "台灯换了一个开关，底座和罩子都是原来的。明天下午我在店里。", "陆师傅"],
      { avatar: "#e7e2d6" }),
  ];

  const attachments = messages.flatMap(mail =>
    mail.attachments.map(attachment => ({
      ...attachment, messageId: mail.id, accountId: mail.accountId, date: mail.date,
    })));
  const storage = [
    { id: "store-mail-photo", name: "含照片附件的邮件", unit: "KiB", before: 228, after: 172, saved: 56 },
    { id: "store-csv", name: "16,000 行 CSV 附件", unit: "KiB", before: 500, after: 68, saved: 432 },
    { id: "store-short", name: "短中文邮件", unit: "KiB", before: 4, after: 4, saved: 0 },
  ];
  window.MailDemo = { accounts, messages, attachments, storage, asOf: "2026-11-20T10:45:00+08:00" };
})();
