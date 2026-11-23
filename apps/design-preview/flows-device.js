/* 情景稿使用虚构邮箱和文件。这里的步骤只在页面中切换，不连接服务或读写设备。 */
(() => {
  "use strict";

  const row = (label, value, to) => ({ label, value, to });
  const action = (label, to) => ({ label, to });
  const primary = (label, to, requires) => ({ label, to, primary: true, requires });
  const field = (label, value, type = "text") => ({ label, value, type });
  const select = (label, options) => ({ label, type: "select", value: options[0], options });
  const personal = "zhouyu@example.test";
  const studio = "studio@example.test";
  const subject = "冬日散步指南 · 第二版打样确认";
  const file = "冬日散步指南 · 印刷原稿.pdf";
  const host = "files.example.test";
  const link = "https://files.example.test/s/walk-proof";

  const accounts = {
    id: "accounts", title: "邮箱接入", start: "welcome",
    states: {
      welcome: {
        title: "打开本地邮箱", hint: "在这台设备上开始。以后也可以添加已有邮箱。",
        rows: [row("添加已有邮箱", "163 或 QQ", "choose"), row("导入邮件", "打开本机的 EML", "importMail")],
        actions: [primary("直接进入", "offline"), action("管理示例邮箱", "manage")],
      },
      offline: {
        title: "本地收件箱", hint: "还没有邮件。导入一封 EML，或先写一封草稿。",
        rows: [row("已连接邮箱", "0 个"), row("本地草稿", "可离线保存")],
        actions: [primary("导入示例邮件", "importMail"), action("新建本地草稿", "draft"), action("添加邮箱", "choose")],
      },
      importMail: {
        title: "导入本地邮件", rows: [row("示例文件", "打样确认.eml"), row("存入", "本机导入件")],
        actions: [primary("导入示例", "imported"), action("返回本地收件箱", "offline")],
      },
      imported: {
        title: "已导入 1 封邮件", rows: [row("本机导入件", subject, "readImport")],
        actions: [action("添加邮箱", "choose")],
      },
      readImport: {
        title: subject, hint: "林知夏 · 本机导入件",
        note: "书脊已经加宽 1 毫米。地图折页我想放在第 24 页后面，你翻翻看。",
        actions: [action("返回导入结果", "imported")],
      },
      draft: {
        title: "本地草稿", fields: [field("主题", "周六的纸样"), field("正文", "我会带上第二版纸样。", "textarea")],
        note: "添加邮箱后可以选择发件身份。",
        actions: [primary("保存到本机", "draftSaved", ["主题"])],
      },
      draftSaved: {
        title: "草稿已保存在本机", rows: [row("草稿", "{{主题}}", "draft")],
        actions: [primary("添加邮箱", "choose"), action("继续离线使用", "draft")],
      },
      choose: {
        title: "添加已有邮箱", rows: [row("网易 163 邮箱", personal, "netease"), row("QQ 邮箱", studio, "qq")],
        note: "地址为演示占位。以下步骤只预演服务商授权。",
        actions: [action("先离线使用", "offline")],
      },
      netease: {
        title: "接入网易 163", hint: "在网易邮箱网页版开启 IMAP/SMTP，并创建客户端授权密码。",
        rows: [row("邮箱", personal), row("收取和提交", "imap.163.com / smtp.163.com")],
        actions: [primary("演示授权成功", "neteaseReady"), action("授权未通过", "neteaseFailed")],
      },
      neteaseFailed: {
        title: "163 邮箱尚未连接", note: "请到网易邮箱核对 IMAP/SMTP 开关及客户端授权密码，再回来重试。",
        actions: [primary("重新连接 163", "netease"), action("先离线使用", "offline")],
      },
      neteaseReady: {
        title: "个人邮箱已接入", rows: [row("个人邮箱", personal), row("收取 / 发送", "均已授权")],
        actions: [primary("再添加 QQ 邮箱", "qqSecond"), action("查看这个邮箱", "personalOnly")],
      },
      personalOnly: {
        title: "我的邮箱", rows: [row("个人邮箱", personal), row("发件身份", personal)],
        actions: [primary("添加 QQ 邮箱", "qqSecond")],
      },
      qq: {
        title: "接入 QQ 邮箱", hint: "在 QQ 邮箱中开启 IMAP/SMTP，生成客户端授权码。",
        rows: [row("邮箱", studio), row("收取和提交", "imap.qq.com / smtp.qq.com")],
        actions: [primary("演示授权成功", "qqReady"), action("授权未通过", "qqFailed")],
      },
      qqFailed: {
        title: "QQ 邮箱尚未连接", note: "请到 QQ 邮箱核对协议开关和客户端授权码。",
        actions: [primary("重新连接 QQ", "qq"), action("先离线使用", "offline")],
      },
      qqReady: {
        title: "工作室邮箱已接入", rows: [row("工作室", studio)],
        actions: [primary("再添加 163 邮箱", "neteaseSecond")],
      },
      qqSecond: {
        title: "添加第二个邮箱", hint: "在 QQ 邮箱中开启 IMAP/SMTP，使用该服务商的客户端授权码。",
        rows: [row("正在接入", "QQ 邮箱 · " + studio), row("已连接", "个人邮箱 · " + personal)],
        actions: [primary("演示 QQ 授权成功", "manage"), action("稍后添加", "personalOnly")],
      },
      neteaseSecond: {
        title: "添加第二个邮箱", hint: "在网易邮箱中开启 IMAP/SMTP，使用该服务商的客户端授权密码。",
        rows: [row("正在接入", "网易 163 · " + personal), row("已连接", "工作室 · " + studio)],
        actions: [primary("演示 163 授权成功", "manage"), action("稍后添加", "qqReady")],
      },
      manage: {
        title: "我的邮箱", rows: [row("个人邮箱", personal + " · 已连接"), row("工作室", studio + " · 已连接")],
        hint: "在全部邮箱中查看来信，回复沿用原信所属的邮箱。",
        actions: [primary("设置默认发件邮箱", "identity"), action("查看授权过期示例", "expired")],
      },
      identity: {
        title: "默认发件邮箱",
        fields: [select("默认发件邮箱", [studio, personal])],
        hint: "用于在「全部邮箱」中新建邮件，本封发件人也可以单独切换。",
        actions: [primary("保存", "identitySaved")],
      },
      identitySaved: {
        title: "默认发件邮箱已更新", rows: [row("新建邮件", "{{默认发件邮箱}}"), row("回复邮件", "使用原信所属邮箱")],
        actions: [action("返回邮箱管理", "manage")],
      },
      expired: {
        title: "工作室需要重新授权", rows: [row("工作室", studio + " · 同步暂停"), row("个人邮箱", personal + " · 仍可收发")],
        note: "工作室已有邮件可离线阅读，待发邮件保留在该邮箱的发件箱。",
        actions: [primary("只重连工作室", "reconnect"), action("查看本机邮件", "cached")],
      },
      cached: {
        title: "工作室 · 已缓存邮件", rows: [row(subject, "林知夏")], note: "可继续读信和写草稿。新邮件将在重新授权后同步。",
        actions: [primary("重新授权", "reconnect"), action("返回账号状态", "expired")],
      },
      reconnect: {
        title: "重新连接工作室", hint: "到 QQ 邮箱更新此账号的客户端授权码。",
        rows: [row("目标邮箱", studio), row("上次同步", "今天 09:40")],
        actions: [primary("演示授权成功", "restored"), action("授权仍然失败", "expired")],
      },
      restored: {
        title: "工作室已恢复同步", rows: [row("工作室", studio + " · 已连接"), row("个人邮箱", personal + " · 已连接")],
        actions: [primary("回到邮箱管理", "manage")],
      },
    },
  };

  const sharing = {
    id: "sharing", title: "大附件与安全阅读", start: "limit",
    states: {
      limit: {
        title: "附件超出这封信的限额", rows: [row("文件", file + " · 38 MB"), row("本次示例限额", "25 MB"), row("发件邮箱", studio)],
        hint: "可更换较小的文件，或将原件存到自己的服务器，再把链接放进草稿。",
        actions: [primary("使用自管分享", "destination"), action("换用小文件", "smaller"), action("仅保存在本机", "local")],
      },
      local: {
        title: "原件已留在本机", rows: [row("本机文件", file + " · 38 MB"), row("邮件", "草稿已保留")],
        actions: [action("返回附件选择", "limit")],
      },
      smaller: {
        title: "更换附件", rows: [row("新附件", "散步指南预览.pdf · 3 MB"), row("原件保留在", "本机文件")],
        actions: [primary("放入草稿", "attached"), action("取消更换", "limit")],
      },
      attached: {
        title: "附件已放入草稿", rows: [row("普通附件", "散步指南预览.pdf · 3 MB"), row("发件邮箱", studio)],
        actions: [action("返回附件选择", "limit")],
      },
      destination: {
        title: "选择分享位置", rows: [row("工作室 Nextcloud", host, "consent"), row("尚未配置服务器", "查看可用操作", "unconfigured")],
        actions: [action("保留本地文件", "local")],
      },
      unconfigured: {
        title: "尚未配置分享服务器", hint: "可授权你管理的 Nextcloud。也可以先保留文件，稍后继续写信。",
        actions: [primary("配置示例服务器", "connect"), action("仅保存在本机", "local")],
      },
      connect: {
        title: "连接自管 Nextcloud", rows: [row("服务器", host), row("授权用途", "创建文件分享、设置有效期和撤销链接")],
        actions: [primary("演示服务器授权", "consent"), action("取消授权", "unconfigured")],
      },
      consent: {
        title: "确认分享这份原稿", rows: [row("上传文件", file), row("目的地", host), row("访问范围", "持链接者可下载"), row("撤销入口", "文件详情 → 撤销分享")],
        fields: [select("链接有效期", ["7 天", "1 天", "30 天"]), field("允许将此文件上传到上述服务器", false, "checkbox")],
        actions: [primary("生成分享链接", "linkReady", ["允许将此文件上传到上述服务器"]), action("取消", "local")],
      },
      linkReady: {
        title: "分享链接已生成", rows: [row("访问地址", link), row("有效期", "{{链接有效期}}"), row("本机原件", "已保留")],
        actions: [primary("插入草稿", "linkDraft"), action("撤销分享", "revoke")],
      },
      linkDraft: {
        title: "草稿已插入链接", rows: [row("收件人", "林知夏"), row("分享文件", file), row("链接", link)],
        note: "链接已插入正文，邮件等待你检查并发送。",
        actions: [action("预览收件人打开链接", "read"), action("管理分享", "linkReady")],
      },
      revoke: {
        title: "撤销这个链接？", note: "收件人之后不能再从此链接下载。已下载的副本仍在对方设备上，本机原件继续保留。",
        actions: [primary("确认撤销", "revoked"), action("保留链接", "linkReady")],
      },
      revoked: {
        title: "分享链接已撤销", rows: [row("收件人打开时", "链接失效", "unavailable"), row("本地原件", file)],
        actions: [action("重新创建分享", "consent")],
      },
      read: {
        title: "阅读含外链的邮件", hint: "外部图片已阻止，邮件中的活动内容已禁用。",
        rows: [row("印刷原稿下载", "查看链接目标", "preview"), row("远程图片", "来自 images.example.test", "pictures")],
        actions: [action("保持离线阅读", "readOffline")],
      },
      readOffline: {
        title: "离线阅读", note: "正文与本机附件可用。外部链接和远程图片保持关闭。",
        actions: [action("返回邮件", "read")],
      },
      pictures: {
        title: "仅加载本封的远程图片？", rows: [row("请求目标", "images.example.test")],
        note: "图片服务器可获得此次请求的 IP 和访问时间。",
        actions: [primary("演示本封加载", "picturesLoaded"), action("保持阻止", "read")],
      },
      picturesLoaded: {
        title: "本封图片已显示", note: "其他邮件继续阻止远程图片。", actions: [action("查看原稿链接", "preview")],
      },
      preview: {
        title: "打开分享链接？", rows: [row("完整地址", link), row("打开位置", "系统浏览器")],
        actions: [primary("演示有效链接", "recipient"), action("查看失效状态", "unavailable"), action("留在邮件", "read")],
      },
      recipient: {
        title: "收件人查看分享", rows: [row("文件", file), row("来源", host), row("下载", "38 MB")],
        actions: [action("返回邮件", "read")],
      },
      unavailable: {
        title: "链接已失效", hint: "链接可能已过期或由发件人撤销。可回到原信联系发件人。",
        actions: [action("返回邮件", "read")],
      },
    },
  };

  const migration = {
    id: "migration", title: "迁移与跨设备同步", start: "routes",
    states: {
      routes: {
        title: "在另一台设备继续", rows: [row("导出加密迁移包", "从当前设备开始", "export"), row("从迁移包恢复", "在新设备上打开", "restore"), row("局域网配对", "两台设备都在手边", "pair")],
      },
      export: {
        title: "选择迁移内容", rows: [row("基础资料", "规则、签名、联系人、待办"), row("邮箱凭据", "在目标设备重新授权")],
        fields: [select("随包邮件", ["包含已缓存正文和附件", "只迁移基础资料"])],
        actions: [primary("查看加密方式", "lock"), action("取消", "routes")],
      },
      lock: {
        title: "加密迁移包", hint: "正式导出时在设备上设置并确认口令，恢复时需要同一口令。本例使用预设演示包。",
        rows: [row("选择的内容", "{{随包邮件}}"), row("保存位置", "本机文件"), row("队列", "保留记录与原执行设备")],
        actions: [primary("生成示例迁移包", "archive"), action("返回选择", "export")],
      },
      archive: {
        title: "加密包已保存", rows: [row("示例文件", "本地邮箱-迁移包.mailbackup"), row("随包邮件", "{{随包邮件}}"), row("转移方式", "自行将加密文件带到新设备")],
        actions: [primary("预演在新设备恢复", "restore"), action("返回迁移方式", "routes")],
      },
      restore: {
        title: "打开加密迁移包", rows: [row("示例文件", "本地邮箱-迁移包.mailbackup"), row("恢复到", "这台设备")],
        note: "正式恢复需在本机解锁。原型不读取文件或口令。",
        actions: [primary("演示解锁成功", "review"), action("查看解锁失败", "badArchive")],
      },
      badArchive: {
        title: "无法解锁迁移包", note: "请核对口令和文件完整性后重试。本机已有资料尚未更改。",
        actions: [primary("重选示例包", "restore"), action("退出恢复", "routes")],
      },
      review: {
        title: "核对恢复内容", rows: [row("资料", "4 条规则、2 个签名、8 位联系人、3 个待办"), row("邮箱", "恢复账号名称，之后逐个授权"), row("1 封定时邮件", "仅原设备保有发送权")],
        actions: [primary("恢复到这台设备", "restored"), action("取消", "routes")],
      },
      restored: {
        title: "本机资料已恢复", rows: [row("规则与通讯录", "可离线使用"), row("个人邮箱 / 工作室", "待分别授权", "authorize"), row("定时邮件", "由原设备执行")],
        actions: [action("返回迁移方式", "routes")],
      },
      authorize: {
        title: "重新授权邮箱", rows: [row("个人邮箱", personal, "authorizePersonal"), row("工作室", studio, "authorizeStudio")],
        note: "选择一个账号继续。已恢复的规则、联系人和待办可离线使用。",
      },
      authorizePersonal: {
        title: "重新授权个人邮箱", rows: [row("原服务商", "网易 163"), row("邮箱", personal)],
        actions: [primary("演示个人邮箱已授权", "authorizedPersonal"), action("稍后处理", "restored")],
      },
      authorizeStudio: {
        title: "重新授权工作室", rows: [row("原服务商", "QQ 邮箱"), row("邮箱", studio)],
        actions: [primary("演示工作室已授权", "authorizedStudio"), action("稍后处理", "restored")],
      },
      authorizedPersonal: {
        title: "个人邮箱已重连", rows: [row("本次授权", personal)], actions: [action("返回迁移方式", "routes")],
      },
      authorizedStudio: {
        title: "工作室已重连", rows: [row("本次授权", studio)], actions: [action("返回迁移方式", "routes")],
      },
      pair: {
        title: "配对附近设备", rows: [row("本机", "书桌上的 Mac"), row("另一台设备", "随身 iPhone")],
        note: "两台设备主动进入配对，在同一局域网核对相同的短语。",
        actions: [primary("查看核对短语", "compare"), action("取消", "routes")],
      },
      compare: {
        title: "两端显示同一短语？", rows: [row("演示短语", "雨点 · 山茶 · 灯塔"), row("同步范围", "规则、签名、联系人和待办")],
        actions: [primary("演示双方已确认", "paired"), action("短语不同，取消配对", "routes")],
      },
      paired: {
        title: "已完成配对", rows: [row("同步对象", "随身 iPhone"), row("1 条规则发生冲突", "查看两个版本", "conflict")],
        note: "定时发件仍由原执行设备处理。",
      },
      conflict: {
        title: "「差旅报销」有两个版本", rows: [row("书桌上的 Mac · 09:20", "发件人为陈澄 → 移入财务"), row("随身 iPhone · 09:25", "主题含报销 → 添加差旅标签")],
        fields: [select("处理方式", ["保留两份", "采用 Mac 版本", "采用 iPhone 版本"])],
        note: "保留两份时，新增的规则副本先暂停，便于核对执行顺序。",
        actions: [primary("应用此选择", "resolved"), action("稍后处理", "paired")],
      },
      resolved: {
        title: "规则冲突已处理", rows: [row("处理方式", "{{处理方式}}"), row("下次同步", "交换这次选择")],
        actions: [action("返回迁移方式", "routes")],
      },
    },
  };

  const ai = {
    id: "ai", title: "本地 AI", start: "entry",
    states: {
      entry: {
        title: "用本机 AI 处理邮件", rows: [row("当前邮件", subject), row("邮箱", "工作室 · " + studio)],
        actions: [primary("生成摘要", "noModel"), action("使用已配置的示例模型", "tools")],
      },
      noModel: {
        title: "尚未配置本地模型", hint: "摘要和拟稿需要设备上的模型。可以导入本机文件，也可以直接阅读原信。",
        actions: [primary("选择示例模型", "model"), action("查看原信", "source"), action("手动写回复", "manual")],
      },
      model: {
        title: "导入本地模型", rows: [row("示例模型", "Qwen3-1.7B · GGUF"), row("来源与许可", "本机模型文件 · Apache-2.0"), row("运行位置", "此设备")],
        note: "邮件和附件留在本机。模型校验成功后可离线使用。",
        actions: [primary("演示导入成功", "tools"), action("查看内存不足", "lowMemory"), action("取消", "noModel")],
      },
      lowMemory: {
        title: "可用内存不足", note: "可以关闭其他应用后重试，也可以用普通搜索、阅读和写信。",
        actions: [primary("重新选择模型", "model"), action("查看原信", "source"), action("手动写回复", "manual")],
      },
      tools: {
        title: "处理这封邮件", hint: subject, rows: [row("摘要", "概括来信并核对原文", "summary"), row("拟回复", "根据原信生成可编辑的回复", "proposed"), row("查信与问答", "指定检索范围", "scope"), row("翻译选段", "在本机翻译", "translate")],
      },
      summary: {
        title: "这封邮件说了什么", hint: "示例摘要 · 本机生成",
        rows: [row("纸样", "书脊已加宽 1 毫米。"), row("待确认", "林知夏建议将地图折页放在第 24 页后，邀请周六到店看纸样。"), row("核对原信", subject, "source")],
        actions: [primary("拟一封回复", "proposed"), action("返回 AI 工具", "tools")],
      },
      source: {
        title: subject, hint: "林知夏 → 工作室",
        note: "书脊已经按昨天说的加宽了 1 毫米。地图折页我想放在第 24 页后面，刚好接上河边那段路线。如果方便，周六带上纸样，来店里一起看自然光下的效果。",
        actions: [primary("手动回复", "manual"), action("返回 AI 工具", "entry")],
      },
      proposed: {
        title: "查看拟回复", rows: [row("回复身份", studio), row("收件人", "林知夏 · zhixia@example.test")],
        fields: [field("回复草案", "知夏，收到第二版了。周六我会带上纸样，我们一起看第 24 页后的折页位置。", "textarea")],
        note: "请核对时间与承诺。可以修改后采用，或放弃这份草案。",
        actions: [primary("采用并存入草稿", "draft", ["回复草案"]), action("放弃草案", "tools")],
      },
      draft: {
        title: "回复草稿已保存", rows: [row("发件人", studio), row("收件人", "林知夏"), row("草稿正文", "{{回复草案}}")],
        note: "继续编辑后可在写信页检查并发送。",
        actions: [action("继续编辑草稿", "proposed"), action("核对原信", "source")],
      },
      manual: {
        title: "回复林知夏", rows: [row("发件人", studio)],
        fields: [field("手写回复", "", "textarea")], actions: [primary("保存本地草稿", "manualSaved", ["手写回复"]), action("返回原信", "source")],
      },
      manualSaved: {
        title: "回复已保存到草稿箱", rows: [row("工作室草稿", "{{手写回复}}")], actions: [action("继续编辑", "manual")],
      },
      scope: {
        title: "选择查信范围", rows: [row("示例问题", "查找最近的待确认事项")],
        fields: [select("查信范围", ["工作室", "个人邮箱", "全部邮箱（工作室与个人邮箱）"])],
        note: "只在选定邮箱已缓存的正文中查找，结果可回到原信。",
        actions: [{...primary("在所选范围查找", "answer"), branch: {field: "查信范围", cases: {"个人邮箱": "noAnswer"}}}, action("返回", "tools")],
      },
      answer: {
        title: "查信结果", hint: "范围 · {{查信范围}}",
        rows: [row("工作室 · 折页位置待确认", subject, "source")], actions: [action("更改范围", "scope")],
      },
      noAnswer: {
        title: "此范围暂无匹配", hint: "范围 · {{查信范围}}。当前离线索引未找到可引用的邮件。",
        actions: [primary("更改范围", "scope")],
      },
      translate: {
        title: "翻译选中的文字", rows: [row("原文", "如果方便，周六带上纸样，来店里一起看自然光下的效果。"), row("英文示例", "If you can, bring the paper proof to the shop on Saturday so we can see it in natural light.")],
        actions: [action("查看完整原信", "source"), action("返回 AI 工具", "tools")],
      },
    },
  };

  const platforms = {
    id: "platforms", title: "四端安装与数据管理", start: "choose",
    states: {
      choose: {
        title: "选择你的系统", rows: [row("Android", "签名 APK", "android"), row("iOS", "TestFlight 或 App Store", "ios"), row("macOS", "DMG", "macos"), row("Windows", "离线安装程序", "windows")],
        note: "以下预演安装与升级后的界面。安装包和商店分发待发布。",
        actions: [action("升级已有版本", "update"), action("管理本机数据", "data")],
      },
      android: {
        title: "在 Android 安装", rows: [row("安装包", "Android · 签名 APK"), row("系统确认", "核对来源，按系统提示允许本次安装"), row("后续更新", "使用与原版签名兼容的同包名 APK 覆盖安装")],
        actions: [primary("预览首次启动", "launch"), action("返回系统选择", "choose")],
      },
      ios: {
        title: "在 iPhone 安装", rows: [row("测试版", "在 TestFlight 接受邀请并安装有效构建"), row("正式版", "发布后从 App Store 免费获取"), row("自用构建", "在 Mac 的 Xcode 中为自己的 iPhone 签名安装")],
        actions: [primary("预览首次启动", "launch"), action("返回系统选择", "choose")],
      },
      macos: {
        title: "在 Mac 安装", rows: [row("安装包", "Mac · 签名并公证的 DMG"), row("安装", "将「本地邮箱」拖入「应用程序」"), row("首次打开", "在「应用程序」中打开并核对系统提示")],
        actions: [primary("预览首次启动", "launch"), action("返回系统选择", "choose")],
      },
      windows: {
        title: "在 Windows 安装", rows: [row("安装包", "Windows x64 · setup.exe"), row("离线安装", "选择内含 WebView2 运行时的版本"), row("启动", "核对发布者后安装，从开始菜单打开")],
        actions: [primary("预览首次启动", "launch"), action("返回系统选择", "choose")],
      },
      launch: {
        title: "欢迎使用本地邮箱", hint: "免注册。可以先离线阅读示例邮件。",
        actions: [primary("进入示例工作区", "localWorkspace"), action("返回安装说明", "choose")],
      },
      localWorkspace: {
        title: "本机工作区", rows: [row("邮箱", "尚未接入"), row("草稿和导入件", "仅保存在此设备")],
        actions: [action("返回系统选择", "choose")],
      },
      update: {
        title: "升级已有版本", rows: [row("升级前", "准备本机加密快照"), row("升级后核对", "账号映射、草稿、附件和发件队列")],
        note: "使用原安装渠道兼容的新版。迁移期间暂缓提交队列。",
        actions: [primary("演示升级完成", "updated"), action("查看升级中断", "interrupted")],
      },
      updated: {
        title: "本机资料已迁入新版", rows: [row("账号映射", "个人邮箱和工作室"), row("草稿 / 附件", "2 封 / 3 个"), row("发件箱", "1 封待核对回执 · 暂停自动重试")],
        actions: [action("管理本机数据", "data")],
      },
      interrupted: {
        title: "本机资料升级中断", note: "已暂停打开工作区。可从匹配版本的升级前快照恢复，再重试升级。",
        actions: [primary("演示从快照恢复", "recovered")],
      },
      recovered: {
        title: "已恢复升级前工作区", rows: [row("原始数据", "已从配套快照读回"), row("待发队列", "保留待核对状态")],
        actions: [primary("重新预演升级", "update"), action("返回系统选择", "choose")],
      },
      data: {
        title: "本机数据与退出", rows: [row("清理可重建缓存", "先查看可释放空间", "cache"), row("导出本机资料", "带走草稿和导入件", "export"), row("移除本机邮箱", "选择一个账号", "remove"), row("卸载前检查", "查看设备上独有的资料", "uninstall")],
      },
      cache: {
        title: "清理可下载的缓存？", rows: [row("本次可清理", "8 MB 已同步附件缓存"), row("将保留", "本地草稿、导入件和固定文件夹")],
        actions: [primary("演示清理 8 MB", "cacheDone"), action("取消", "data")],
      },
      cacheDone: {
        title: "已清理 8 MB 示例缓存", note: "相应附件可在联网后按需重新下载。压缩节省和缓存清理分别计量。",
        actions: [action("返回本机数据", "data")],
      },
      export: {
        title: "导出本机资料", rows: [row("示例内容", "已缓存邮件、附件、草稿、规则和账户映射"), row("保存位置", "本机加密迁移包")],
        note: "邮箱授权需在新设备重新办理。",
        actions: [primary("演示完成导出", "exported"), action("取消", "data")],
      },
      exported: {
        title: "示例迁移包已导出", rows: [row("文件", "本地邮箱-迁移包.mailbackup")],
        actions: [action("返回本机数据", "data")],
      },
      remove: {
        title: "选择要移除的本机邮箱", rows: [row("工作室", studio, "removeStudio"), row("个人邮箱", personal, "removePersonal")],
        actions: [action("取消", "data")],
      },
      removeStudio: {
        title: "从本机移除工作室？", rows: [row("影响范围", studio), row("本机独有", "2 封草稿、1 封待发"), row("服务器原件", "在其他客户端仍可读取")],
        note: "先将草稿和待发原文转入本机保留区，取消此设备的发送任务，再移除账号。",
        actions: [primary("保留原文并移除工作室", "studioRemoved"), action("取消", "data")],
      },
      studioRemoved: {
        title: "工作室已从本机移除", rows: [row("仍在本机", "个人邮箱"), row("本机保留区", "2 封草稿、1 封待发原文"), row("已取消", "工作室的本机发送任务")],
        actions: [action("返回系统选择", "choose")],
      },
      removePersonal: {
        title: "从本机移除个人邮箱？", rows: [row("影响范围", personal), row("草稿和待发", "0 封"), row("服务器原件", "在其他客户端仍可读取")],
        actions: [primary("移除个人邮箱", "personalRemoved"), action("取消", "data")],
      },
      personalRemoved: {
        title: "个人邮箱已从本机移除", rows: [row("仍在本机", "工作室 · " + studio)],
        actions: [action("返回系统选择", "choose")],
      },
      uninstall: {
        title: "卸载前检查本机资料", rows: [row("本机独有", "2 封草稿、1 封待发原文"), row("迁出方式", "导出加密包并在另一设备验证可恢复")],
        note: "卸载由操作系统处理。清除应用数据可能同时移除本机独有的资料。",
        actions: [primary("导出本机资料", "export"), action("保留应用并返回", "data")],
      },
    },
  };

  (window.MailDesignFlows ||= []).push(accounts, sharing, migration, ai, platforms);
})();
