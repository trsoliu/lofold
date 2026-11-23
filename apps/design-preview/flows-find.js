/* 按日期找信、附件笔记及长图导出的本机审阅样例。 */
(() => {
  'use strict';
  const subject = '冬日散步指南 · 第二版打样确认';
  const original = '纸样与装订说明.txt';
  const stamp = '2026-11-20 10:42 · UTC+8';
  const mailbox = '工作室 · 收件箱';
  const fullRange = '11 月 18 日至 11 月 20 日';
  const crossMonth = '10 月 31 日至 11 月 20 日';
  const emptyRange = '11 月 21 日至 11 月 22 日';
  const sampleDate = '11 月 20 日';
  const emptyDate = '11 月 21 日';
  const result = { label: subject, value: '林知夏 · ' + stamp, to: 'mail' };
  const backToMail = { label: '返回原信', to: 'mail' };
  const backToFile = { label: '返回原附件', to: 'file' };
  const backToSearch = { label: '返回日期筛选', to: 'start' };
  const pick = (label, options) => ({ label, type: 'select', options, value: options[0] });

  const flow = { id: 'searchTools', title: '日期搜索、附件笔记与长图', start: 'start', states: {
    start: {
      title: '按日期查找邮件', hint: '工作室 · 本机已缓存的邮件',
      rows: [{ label: '当前搜索词', value: '打样' }],
      fields: [pick('日期范围', [fullRange, crossMonth, emptyRange])],
      note: '按收信时间筛选，含起止两日，以北京时间（UTC+8）计算。',
      actions: [
        { label: '筛选搜索结果', to: 'matches', primary: true, branch: { field: '日期范围', cases: { [emptyRange]: 'empty' } } },
        { label: '跳至收件箱的某一天', to: 'jump' },
      ],
    },
    matches: {
      title: '找到 1 封邮件', hint: '工作室 · 搜索「打样」',
      rows: [{ label: '2026 年', value: '{{日期范围}} · UTC+8' }, result, { label: '匹配位置', value: '邮件主题含「打样」' }],
      actions: [backToSearch],
    },
    empty: {
      title: '这段时间没有匹配的邮件', hint: '工作室 · 搜索「打样」',
      rows: [{ label: '2026 年', value: '{{日期范围}} · UTC+8' }],
      actions: [{ label: '扩大日期范围', to: 'start', set: { '日期范围': crossMonth }, primary: true }, { label: '跳至收件箱的某一天', to: 'jump' }],
    },
    jump: {
      title: '按日期定位收件箱', hint: mailbox,
      fields: [pick('定位日期', [sampleDate, emptyDate])],
      note: '定位使用收件箱的时间顺序，可以查看当天的所有邮件。',
      actions: [{ label: '跳到所选日期', to: 'day', primary: true, branch: { field: '定位日期', cases: { [emptyDate]: 'emptyDay' } } }, backToSearch],
    },
    emptyDay: {
      title: '11 月 21 日没有来信', hint: mailbox,
      rows: [{ label: '最近有来信', value: '11 月 20 日 · 2 封' }],
      actions: [{ label: '查看 11 月 20 日', to: 'day', set: { '定位日期': sampleDate }, primary: true }, { label: '改选日期', to: 'jump' }],
    },
    day: {
      title: '11 月 20 日的来信', hint: mailbox + ' · 2026 年 · UTC+8',
      rows: [result, { label: '苏州差旅报销，还差一张住宿发票', value: '陈澄 · 09:38' }],
      actions: [{ label: '改选日期', to: 'jump' }, backToSearch],
    },
    mail: {
      title: subject, hint: '林知夏 → 工作室 · ' + stamp,
      rows: [
        { label: '正文节选', value: '纸样今天上午到了，暖一点的米白和照片很搭。地图折页我想放在第 24 页后面。' },
        { label: '附件', value: original, to: 'file' },
      ],
      actions: [{ label: '将这封信导出为长图', to: 'export', primary: true }, backToSearch],
    },
    file: {
      title: original, hint: '工作室 · 已缓存在本机',
      rows: [{ label: '内容节选', value: 'A 样为偏暖的米白，B 样为中性自然白。地图折页另做一道压线。' }, { label: '所属原信', value: subject, to: 'mail' }],
      actions: [
        { label: '附件笔记', to: 'noteEdit', branch: { field: '笔记状态', cases: { '已保存': 'noteSaved' } }, primary: true },
        { label: '挂到邮件待办', to: 'taskEdit', branch: { field: '附件待办状态', cases: { '已关联': 'taskSaved' } } },
      ],
    },
    noteEdit: {
      title: '编辑附件笔记', hint: original,
      fields: [{ label: '笔记内容', type: 'textarea', value: '' }],
      note: '笔记单独保存在本机，并关联这份附件。',
      actions: [{ label: '保存笔记', to: 'noteSaved', primary: true, requires: ['笔记内容'], set: { '已保存笔记': '{{笔记内容}}', '笔记状态': '已保存' } }, backToFile],
    },
    noteSaved: {
      title: '附件笔记', hint: original,
      rows: [{ label: '我的笔记', value: '{{已保存笔记}}' }, { label: '原附件', value: original, to: 'file' }],
      actions: [{ label: '编辑笔记', to: 'noteEdit', set: { '笔记内容': '{{已保存笔记}}' } }, backToMail],
    },
    taskEdit: {
      title: '给待办添加原附件', hint: mailbox,
      fields: [{ label: '待办名称', type: 'text', value: '到店核对折页与纸色' }],
      rows: [{ label: '原附件', value: original }, { label: '关联邮件', value: subject }],
      actions: [{ label: '保存并关联原附件', to: 'taskSaved', primary: true, requires: ['待办名称'], set: { '附件待办状态': '已关联' } }, backToFile],
    },
    taskSaved: {
      title: '{{待办名称}}', hint: '工作室 · 邮件待办',
      rows: [{ label: '已关联原附件', value: original, to: 'file' }, { label: '来源邮件', value: subject, to: 'mail' }],
      note: '可从待办直接打开已缓存的附件，应用内复用同一份原件。',
      actions: [backToMail],
    },
    export: {
      title: '导出邮件长图', hint: subject,
      rows: [{ label: '图中包含', value: '主题、发件人、收信时间、完整正文与附件名称' }, { label: '附件内容与私人笔记', value: '保留在邮箱中' }],
      actions: [{ label: '预览长图', to: 'one', primary: true }, { label: '查看超长正文的分段示例', to: 'segments' }, backToMail],
    },
    one: {
      title: '长图预览 · 1 张', hint: 'PNG · 本机导出',
      rows: [{ label: '第 1 张', value: '从邮件标题到正文末尾，含附件名称。' }],
      actions: [{ label: '模拟保存 1 张', to: 'saved', primary: true }, { label: '返回导出选项', to: 'export' }],
    },
    saved: {
      title: '已保存 1 张长图', rows: [{ label: '文件名', value: '冬日散步指南-第二版打样确认.png' }, { label: '位置', value: '本机 · 所选目录（示例）' }],
      actions: [backToMail],
    },
    segments: {
      title: '正文较长，分为 3 张', hint: '含多轮引用的合成长邮件 · PNG',
      rows: [{ label: '01 · 邮件开头', value: '标题、发件人和本次回复' }, { label: '02 · 中段', value: '前几轮打样意见' }, { label: '03 · 邮件结尾', value: '最早的引用及附件名称' }],
      note: '在段落之间分页，文件名按阅读顺序编号。',
      actions: [{ label: '模拟保存全部 3 张', to: 'allSaved', primary: true }, { label: '查看中途空间不足示例', to: 'failed' }, { label: '返回导出选项', to: 'export' }],
    },
    failed: {
      title: '已保存 1 张，剩余 2 张', rows: [{ label: '01', value: '已保存' }, { label: '02、03', value: '目标目录空间不足，尚未写入' }],
      note: '可释放空间后只重试剩余两张，第一张继续保留。',
      actions: [{ label: '模拟腾出空间后重试 02、03', to: 'allSaved', primary: true }, backToMail],
    },
    allSaved: {
      title: '3 张图片均已保存', rows: [{ label: '本机 · 所选目录', value: '打样确认-01.png\n打样确认-02.png\n打样确认-03.png' }],
      actions: [backToMail],
    },
  }};
  (window.MailDesignFlows ||= []).push(flow);
})();
