/* 状态稿共用收件箱中的虚构联系人。时间和回执采用固定的预览情景。 */
(() => {
  'use strict';

  const studio = 'studio@example.test';
  const proofMail = '冬日散步指南 · 第二版打样确认';
  const subject = '周六一起看纸样';
  const body = '知夏，你好！\n周六上午我带两份纸样到店里，一起看看折页的位置。';
  const templateSubject = '冬日散步指南 · 打样复核';
  const templateBody = '知夏，你好！\n请一起核对第二版的纸色、书脊和第 24 页后的折页。方便的话，告诉我到店的时间。';
  const mailFields = [
    { label: '收件人', type: 'email', multiple: true, value: 'zhixia@example.test' },
    { label: '主题', type: 'text', value: subject },
    { label: '正文', type: 'textarea', value: body },
  ];
  const copyFields = [
    { label: '抄送', type: 'email', multiple: true, value: '' },
    { label: '密送', type: 'email', multiple: true, value: '' },
  ];
  const mailRows = [
    { label: '发件人', value: studio },
    { label: '抄送与密送', value: '编辑地址', to: 'copies' },
    { label: '整封模板', value: '打样复核', to: 'template' },
    { label: '签名', value: '{{落款}}', to: 'signature' },
  ];
  const defaultSignature = '周予 · 工作室';
  const ready = { label: '检查并发送', to: 'check', requires: ['收件人', '主题', '正文'], primary: true };
  const checkRows = [
    { label: '发件人', value: studio },
    { label: '收件人', value: '{{收件人}}' },
    { label: '抄送', value: '{{抄送}}' },
    { label: '密送（仅自己可见）', value: '{{密送}}' },
    { label: '主题', value: '{{主题}}' },
    { label: '正文', value: '{{正文}}' },
    { label: '签名', value: '{{落款}}' },
  ];
  const returnToEditor = { label: '继续编辑', to: 'edit' };
  const sendTime = { label: '发送时间', type: 'select', value: '11 月 23 日 周一 09:00',
    options: ['11 月 23 日 周一 09:00', '11 月 23 日 周一 14:00', '11 月 24 日 周二 09:00'] };
  const compose = {
    id: 'compose', title: '高级写信', start: 'edit',
    states: {
      edit: {
        title: '写邮件', fields: mailFields, rows: mailRows,
        actions: [ready],
      },
      copies: {
        title: '抄送与密送', hint: '多个地址用英文逗号分隔。', fields: copyFields,
        note: '抄送地址对所有收件人可见。其他收件人看不到密送地址。',
        actions: [{ label: '返回草稿', to: 'edit', primary: true }],
      },
      template: {
        title: '打样复核', hint: '工作室 · 整封模板',
        rows: [{ label: '主题', value: templateSubject }, { label: '正文', value: templateBody }],
        note: '应用后会替换当前主题和正文，保留发件人、收件人及签名。',
        actions: [{ label: '应用到草稿', to: 'edit', set: { '主题': templateSubject, '正文': templateBody }, primary: true }, { label: '取消', to: 'edit' }],
      },
      signature: {
        title: '本封邮件的签名', hint: '工作室 · 新写邮件',
        fields: [{ label: '落款', type: 'select', value: defaultSignature,
          options: [defaultSignature, '周予 · 冬日散步指南编辑', '无签名'] }],
        actions: [{ label: '返回草稿', to: 'edit', primary: true }],
      },
      check: {
        title: '发送前核对', rows: checkRows,
        actions: [{ label: '模拟立即发送', to: 'sending', primary: true }, { label: '定时发送', to: 'schedule' }, returnToEditor],
      },
      schedule: {
        title: '定时发送', fields: [sendTime],
        rows: [{ label: '执行设备', value: '本机' }, { label: '时区', value: '北京时间 · UTC+8' }],
        note: '发送时需要本机运行并联网。休眠或离线错过时间后，可在发件箱重新安排。',
        actions: [{ label: '加入定时队列', to: 'queued', primary: true }, { label: '返回核对', to: 'check' }],
      },
      queued: {
        title: '发件箱 · 已定时', rows: [{ label: '主题', value: '{{主题}}' }, { label: '本机执行', value: '{{发送时间}} · UTC+8' }],
        actions: [{ label: '查看错过时间的示例', to: 'overdue' }, { label: '更改时间', to: 'schedule' }, { label: '取消定时并编辑', to: 'edit' }],
      },
      overdue: {
        title: '已错过发送时间', rows: [{ label: '原定时间', value: '{{发送时间}} · UTC+8' }, { label: '状态', value: '当时设备离线，邮件尚未发送' }],
        actions: [{ label: '重新安排', to: 'schedule', primary: true }, { label: '现在核对并发送', to: 'check' }, { label: '转回草稿', to: 'edit' }],
      },
      sending: {
        title: '等待发送', rows: [{ label: '发件人', value: studio }, { label: '主题', value: '{{主题}}' }],
        note: '演示停留在撤销窗口，可撤销或继续查看窗口结束后的结果。',
        actions: [{ label: '撤销并返回草稿', to: 'edit', primary: true }, { label: '查看服务商已接收示例', to: 'sent' }, { label: '查看连接中断示例', to: 'unknown' }],
      },
      unknown: {
        title: '发送结果待确认', rows: [{ label: '主题', value: '{{主题}}' }, { label: '状态', value: '提交后连接中断，服务商回执未到' }],
        note: '为避免重复投递，自动重试已暂停。可按发件账号和邮件标识核对已发送文件夹。',
        actions: [{ label: '核对已发送示例', to: 'reconciled', primary: true }, { label: '查看尚无记录示例', to: 'unconfirmed' }],
      },
      unconfirmed: {
        title: '尚无发送记录', rows: [{ label: '核对范围', value: '工作室 · 已发送' }, { label: '状态', value: '未找到对应邮件，仍待确认' }],
        note: '继续保留待确认记录。文件夹同步可能有延迟。',
        actions: [{ label: '返回待确认邮件', to: 'unknown', primary: true }],
      },
      reconciled: {
        title: '已找到发送记录', rows: [{ label: '已发送', value: '{{主题}}' }, { label: '匹配依据', value: '工作室 · 同一邮件标识' }],
        note: '已将队列结果更新为已发送。',
        actions: [{ label: '查看已发送邮件', to: 'sent', primary: true }],
      },
      sent: {
        title: '工作室 · 已发送', rows: [{ label: '主题', value: '{{主题}}' }, { label: '收件人', value: '{{收件人}}' }, { label: '投递状态', value: '服务商已接收' }, { label: '阅读回执', value: '未收到回执' }],
        actions: [{ label: '查看本次草稿示例', to: 'edit' }],
      },
    },
  };

  const sampleMatch = { label: proofMail, value: '林知夏 · 工作室收件箱' };
  const accountPick = { label: '更改适用邮箱', to: 'scope' };
  const preview = {
    title: '预览对已有邮件的影响', hint: '工作室 · 已缓存收件箱',
    rows: [sampleMatch, { label: '执行后', value: '移动 1 封到「打样」，个人邮箱不受影响。' }],
    note: '目前只预览。启用后默认只处理新来信。',
    actions: [{ label: '仅对新来信启用', to: 'enabled', primary: true }, { label: '同时处理这 1 封', to: 'confirmApply' }, { label: '修改规则', to: 'edit' }],
  };
  const rules = {
    id: 'rules', title: '来信规则', start: 'edit', states: {
      edit: {
        title: '编辑来信规则', fields: [{ label: '规则名称', type: 'text', value: '打样归档' }],
        rows: [{ label: '适用邮箱', value: '工作室', to: 'scope' }, { label: '同时满足', value: '发件人为 zhixia@example.test，且主题含「打样」' }, { label: '执行动作', value: '移动到工作室的「打样」文件夹' }],
        actions: [{ label: '预览匹配邮件', to: 'preview', requires: ['规则名称'], primary: true }, { label: '查看优先级冲突示例', to: 'order' }],
      },
      scope: {
        title: '选择适用邮箱', rows: [
          { label: '工作室', value: studio, to: 'edit' },
          { label: '个人邮箱', value: 'zhouyu@example.test', to: 'personal' },
        ],
      },
      personal: {
        title: '编辑来信规则', fields: [{ label: '规则名称', type: 'text', value: '打样归档' }],
        rows: [{ label: '适用邮箱', value: '个人邮箱', to: 'scope' }, { label: '同时满足', value: '发件人为 zhixia@example.test，且主题含「打样」' }, { label: '执行动作', value: '移动到个人邮箱的「打样」文件夹' }],
        actions: [{ label: '预览匹配邮件', to: 'empty', requires: ['规则名称'], primary: true }],
      },
      empty: {
        title: '没有匹配的来信', hint: '个人邮箱 · 已缓存收件箱',
        note: '当前筛选命中 0 封。可以更改邮箱，或保存规则等待符合条件的新信。',
        actions: [accountPick, { label: '仅对新来信启用', to: 'personalEnabled', primary: true }],
      },
      personalEnabled: {
        title: '已启用来信规则', rows: [{ label: '名称', value: '{{规则名称}}' }, { label: '适用范围', value: '个人邮箱 · 新来信' }, { label: '已有邮件', value: '本次移动 0 封' }],
        actions: [{ label: '暂停规则', to: 'personalPaused' }],
      },
      personalPaused: {
        title: '规则已暂停', rows: [{ label: '规则', value: '{{规则名称}} · 个人邮箱' }],
        actions: [{ label: '重新启用', to: 'personalEnabled', primary: true }, { label: '编辑规则', to: 'personal' }],
      },
      preview,
      order: {
        title: '来信规则的顺序', hint: '工作室 · 首条匹配的移动规则生效',
        rows: [{ label: '1 · 合作来信', value: '来自林知夏 → 移到「合作」' }, { label: '2 · {{规则名称}}', value: '来自林知夏且主题含打样 → 移到「打样」' }, { label: '样信预览', value: '「冬日散步指南」将移到「合作」' }],
        actions: [{ label: '将打样规则上移', to: 'reordered', primary: true }, { label: '返回编辑', to: 'edit' }],
      },
      reordered: {
        title: '已调整优先级', hint: '工作室 · 首条匹配的移动规则生效',
        rows: [{ label: '1 · {{规则名称}}', value: '来自林知夏且主题含打样 → 移到「打样」' }, { label: '2 · 合作来信', value: '来自林知夏 → 移到「合作」' }, { label: '样信预览', value: '「冬日散步指南」将移到「打样」' }],
        actions: [{ label: '查看受影响的邮件', to: 'preview', primary: true }, { label: '还原顺序', to: 'order' }],
      },
      confirmApply: {
        title: '处理已有邮件？', rows: [sampleMatch, { label: '移动位置', value: '工作室 · 收件箱 → 打样' }],
        actions: [{ label: '启用并移动 1 封', to: 'applied', primary: true }, { label: '返回预览', to: 'preview' }],
      },
      enabled: {
        title: '已启用来信规则', rows: [{ label: '规则', value: '{{规则名称}}' }, { label: '适用范围', value: '工作室 · 新来信' }, { label: '已有邮件', value: '保留在收件箱' }],
        actions: [{ label: '暂停规则', to: 'paused' }, { label: '预览已有邮件', to: 'preview' }],
      },
      applied: {
        title: '已移动 1 封', rows: [{ label: proofMail, value: '工作室 · 打样' }, { label: '{{规则名称}}', value: '已启用，继续处理符合条件的新来信' }],
        actions: [{ label: '撤销本次移动', to: 'enabled', primary: true }],
      },
      paused: {
        title: '规则已暂停', rows: [{ label: '规则', value: '{{规则名称}} · 工作室' }],
        note: '暂停后，新的来信会留在原文件夹。',
        actions: [{ label: '重新启用', to: 'enabled', primary: true }, { label: '编辑规则', to: 'edit' }],
      },
    },
  };

  const returnToPeople = { label: '返回联系人与日程', to: 'home' };
  const returnToGroup = { label: '返回联系人组', to: 'group' };
  const timeZone = '北京时间 · UTC+8';
  const meeting = '冬日散步指南 · 纸样复核';
  const meetingDate = '11 月 23 日 周一 10:00–10:30';
  const newMeetingDate = '11 月 23 日 周一 11:00–11:30';
  const eventRows = [
    { label: '邀请人', value: '林知夏 <zhixia@example.test>' },
    { label: '受邀账号', value: studio },
    { label: '地点', value: '沿岸书店 · 窗边长桌' },
  ];
  const taskFields = [
    { label: '待办标题', type: 'text', value: '带纸样到店核对折页' },
    { label: '提醒时间', type: 'select', value: '11 月 23 日 周一 09:00',
      options: ['11 月 23 日 周一 09:00', '11 月 23 日 周一 09:30', '不提醒'] },
  ];
  const people = {
    id: 'people', title: '联系人与日程', start: 'home', states: {
      home: {
        title: '联系人与日程', hint: '工作室',
        rows: [{ label: '联系人组', value: '打样小组 · 2 人', to: 'group' }],
        actions: [
          { label: '查看会议邀请', to: 'invitation', branch: { field: '邀请状态', cases: { '已接受': 'accepted', '已拒绝': 'declined', '已改期': 'updated', '已取消': 'cancelled' } } },
          { label: '查看邮件待办', to: 'tasks', branch: { field: '待办状态', cases: { '待完成': 'taskSaved', '已完成': 'taskDone' } } },
        ],
      },
      group: {
        title: '打样小组', hint: '本地联系人组 · 工作室',
        rows: [{ label: '林知夏', value: 'zhixia@example.test', to: 'contact' }, { label: '贺悠', value: 'heyou@example.test', to: 'designer' }],
        actions: [{ label: '核对群组收件人', to: 'groupDraft', primary: true }, returnToPeople],
      },
      contact: {
        title: '林知夏', rows: [{ label: '邮箱', value: 'zhixia@example.test' }, { label: '所属分组', value: '工作室 · 打样小组' }, { label: '最近来信', value: proofMail, to: 'source' }],
        actions: [returnToGroup],
      },
      designer: {
        title: '贺悠', rows: [{ label: '邮箱', value: 'heyou@example.test' }, { label: '所属分组', value: '工作室 · 打样小组' }, { label: '最近来信', value: '小标题的字距，我试了两个版本' }],
        actions: [returnToGroup],
      },
      groupDraft: {
        title: '给打样小组写邮件', hint: '已展开 2 个地址',
        rows: [{ label: '发件人', value: studio }, { label: '林知夏', value: 'zhixia@example.test' }, { label: '贺悠', value: 'heyou@example.test' }],
        fields: [{ label: '投递方式', type: 'select', value: '群发单显', options: ['群发单显', '普通群发'] }],
        actions: [{ label: '预览收件人视图', to: 'individual', primary: true, branch: { field: '投递方式', cases: { '普通群发': 'shared' } } }, returnToGroup],
      },
      shared: {
        title: '普通群发预览', rows: [{ label: '林知夏和贺悠看到的收件人', value: 'zhixia@example.test、heyou@example.test' }],
        note: '这封邮件的收件人可以看到彼此的地址。',
        actions: [{ label: '更改投递方式', to: 'groupDraft' }, returnToGroup],
      },
      individual: {
        title: '群发单显预览', rows: [{ label: '林知夏看到的收件人', value: 'zhixia@example.test' }, { label: '贺悠看到的收件人', value: 'heyou@example.test' }],
        actions: [{ label: '查看部分失败示例', to: 'partial', primary: true }, { label: '更改投递方式', to: 'groupDraft' }],
      },
      partial: {
        title: '1 封已接收，1 封未发送', rows: [{ label: '林知夏', value: '服务商已接收' }, { label: '贺悠', value: '提交前连接失败，可重试' }],
        actions: [{ label: '仅重试贺悠这一封', to: 'groupSent', primary: true }, returnToGroup],
      },
      groupSent: {
        title: '两封均已接收', rows: [{ label: '林知夏', value: '首次发送成功' }, { label: '贺悠', value: '重试后服务商已接收' }],
        actions: [returnToGroup],
      },
      invitation: {
        title: meeting, hint: '邮件中的会议邀请 · 等待答复',
        rows: [{ label: '时间', value: meetingDate + ' · UTC+8' }, ...eventRows],
        actions: [{ label: '接受邀请', to: 'accepted', set: { '邀请状态': '已接受' }, primary: true }, { label: '拒绝邀请', to: 'declined', set: { '邀请状态': '已拒绝' } }, returnToPeople],
      },
      accepted: {
        title: '已接受会议邀请', rows: [{ label: meeting, value: meetingDate + ' · UTC+8' }, { label: '日程', value: '已添加至工作室的应用内日历' }],
        note: '邀请答复已列入工作室的演示发件队列。',
        actions: [{ label: '查看改期通知示例', to: 'change', primary: true }, { label: '添加到系统日历', to: 'permission' }, returnToPeople],
      },
      declined: {
        title: '已拒绝会议邀请', rows: [{ label: meeting, value: meetingDate + ' · UTC+8' }, { label: '工作室日历', value: '未占用该时段' }],
        note: '拒绝答复已列入工作室的演示发件队列。',
        actions: [{ label: '改为接受', to: 'accepted', set: { '邀请状态': '已接受' } }, returnToPeople],
      },
      permission: {
        title: '添加到系统日历', rows: [{ label: '日程', value: meeting }, { label: '时间', value: meetingDate + ' · UTC+8' }],
        note: '此操作需要系统日历权限。可继续仅在邮箱内查看日程。',
        actions: [{ label: '允许添加（示例）', to: 'systemAdded', primary: true }, { label: '拒绝权限（示例）', to: 'denied' }, { label: '仅用应用内日历', to: 'accepted' }],
      },
      systemAdded: {
        title: '已添加到系统日历', rows: [{ label: '日程', value: meeting }, { label: '时间', value: meetingDate + ' · UTC+8' }],
        note: '本页演示授予权限后的结果。',
        actions: [{ label: '返回应用内日程', to: 'accepted', primary: true }, returnToPeople],
      },
      denied: {
        title: '系统日历权限未开启', rows: [{ label: '应用内日程', value: '已保留' }, { label: '邮件待办', value: '可正常使用' }],
        actions: [{ label: '返回应用内日程', to: 'accepted', primary: true }, returnToPeople],
      },
      change: {
        title: '邀请人调整了时间', rows: [{ label: '原时间', value: meetingDate }, { label: '新时间', value: newMeetingDate }, { label: '时区', value: timeZone }],
        note: '确认后更新已有日程，同一邀请只保留一项。',
        actions: [{ label: '接受新时间', to: 'updated', set: { '邀请状态': '已改期' }, primary: true }, { label: '稍后处理', to: 'accepted' }],
      },
      updated: {
        title: '日程已更新', rows: [{ label: meeting, value: newMeetingDate + ' · UTC+8' }, { label: '旧时段', value: '已释放' }],
        actions: [{ label: '查看会议取消通知示例', to: 'cancelled', set: { '邀请状态': '已取消' } }, returnToPeople],
      },
      cancelled: {
        title: '会议已由邀请人取消', rows: [{ label: meeting, value: newMeetingDate + ' · UTC+8' }, { label: '工作室日历', value: '已移出当天安排' }],
        actions: [returnToPeople],
      },
      tasks: {
        title: '暂无邮件待办', hint: '工作室 · 待完成',
        note: '可从一封邮件创建待办，同时保留来信和附件。',
        actions: [{ label: '打开打样确认来信', to: 'source', primary: true }, returnToPeople],
      },
      source: {
        title: proofMail, hint: '林知夏 → 工作室',
        rows: [{ label: '来信', value: '地图折页想放在第 24 页后面。如果方便，带上纸样来店里一起看自然光下的效果。' }, { label: '附件', value: '纸样与装订说明.txt' }],
        actions: [{ label: '处理关联待办', to: 'taskEdit', primary: true, branch: { field: '待办状态', cases: { '待完成': 'taskSaved', '已完成': 'taskDone' } } }, returnToPeople],
      },
      taskEdit: {
        title: '编辑邮件待办', fields: taskFields,
        rows: [{ label: '时区', value: timeZone }, { label: '关联原信', value: proofMail }, { label: '随信附件', value: '纸样与装订说明.txt' }],
        actions: [{ label: '保存待办', to: 'taskSaved', requires: ['待办标题'], set: { '待办状态': '待完成' }, primary: true }, { label: '返回原信', to: 'source' }],
      },
      taskSaved: {
        title: '{{待办标题}}', hint: '工作室 · 待完成',
        rows: [{ label: '提醒（UTC+8）', value: '{{提醒时间}}' }, { label: '关联原信', value: proofMail, to: 'source' }, { label: '随信附件', value: '纸样与装订说明.txt' }],
        actions: [{ label: '标记完成', to: 'taskDone', set: { '待办状态': '已完成' }, primary: true }, { label: '更改提醒', to: 'taskEdit' }, returnToPeople],
      },
      taskDone: {
        title: '待办已完成', rows: [{ label: '待办', value: '{{待办标题}}' }, { label: '关联原信', value: proofMail, to: 'source' }],
        actions: [{ label: '恢复为待完成', to: 'taskSaved', set: { '待办状态': '待完成' } }, returnToPeople],
      },
    },
  };

  (window.MailDesignFlows ||= []).push(compose, rules, people);
})();
