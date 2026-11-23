(() => {
  'use strict';

  const row = (label, value, to) => ({ label, value, to });
  const action = (label, to, primary = false) => ({ label, to, primary });
  const choice = (label, options) => ({ label, type: 'select', options, value: options[0] });
  const returnHome = action('返回外观与用量', 'overview');
  const snapshot = '2026 年 11 月 21 日 10:00（北京时间），合成数据';

  function usage(title, period, received, sent, account, switchPeriod, next) {
    return {
      title,
      hint: account.address + ' · ' + period,
      rows: [
        row('期间收件', received + ' 封'),
        row('期间发件', sent + ' 封'),
        row('本机已同步邮件', account.count + ' 封 · 截至统计时点'),
        row('本机缓存实占', account.size + ' · 仅此设备'),
        row('服务商配额', account.quota),
      ],
      note: '收发封数按此设备已同步的收件箱和已发送统计。统计时点为 ' + snapshot + '。',
      actions: [action(switchPeriod, next, true), action('切换邮箱', 'accounts')],
    };
  }

  const studio = { address: 'studio@example.test', count: 48, size: '12 MiB', quota: '已用 2 GiB / 共 5 GiB · 服务商返回' };
  const personal = { address: 'zhouyu@example.test', count: 21, size: '3 MiB', quota: '服务商未提供' };
  const week = '11 月 15 日至 21 日';
  const month = '11 月 1 日至 21 日';

  const preferences = {
    id: 'preferences', title: '外观与用量', start: 'overview',
    states: {
      overview: {
        title: '外观与用量',
        rows: [
          row('主题与字号', '{{主题}} · {{正文字号}}', 'appearance'),
          row('应用内欢迎页', '{{进入工作区时}}', 'welcome'),
          row('应用图标', '查看设备支持情况', 'icons'),
          row('邮箱使用统计', '按账号查看收发与占用', 'accounts'),
        ],
      },
      appearance: {
        title: '主题与字号',
        fields: [
          choice('主题', ['跟随系统', '浅色', '深色']),
          choice('正文字号', ['跟随系统字号', '较大', '特大']),
        ],
        note: '跟随系统时，阅读和写信使用设备的字号设置。',
        actions: [action('查看所选设置', 'appearanceResult', true)],
      },
      appearanceResult: {
        title: '邮件显示设置',
        rows: [row('主题', '{{主题}}'), row('阅读与写信', '{{正文字号}}')],
        actions: [action('调整显示设置', 'appearance'), returnHome],
      },
      welcome: {
        title: '应用内欢迎页',
        fields: [choice('进入工作区时', ['直接进入收件箱', '显示欢迎页'])],
        hint: '应用启动后使用此设置。操作系统负责展示启动画面。',
        actions: [{
          label: '预览进入工作区', to: 'inbox', primary: true,
          branch: { field: '进入工作区时', cases: { '显示欢迎页': 'welcomePreview' } },
        }],
      },
      welcomePreview: {
        title: '打开本地邮箱',
        hint: '邮件和已保存的附件可以在这台设备上阅读。',
        actions: [action('进入收件箱', 'inbox', true), action('调整欢迎页', 'welcome')],
      },
      inbox: {
        title: '所有收件箱',
        rows: [row('工作室', '冬日散步指南 · 第二版打样确认'), row('个人邮箱', '周末取书时间')],
        actions: [action('调整欢迎页', 'welcome'), returnHome],
      },
      icons: {
        title: '应用图标',
        rows: [row('系统支持备用图标', '选择应用预置图标', 'iconPicker'), row('系统未开放更换', '查看默认图标状态', 'iconUnavailable')],
      },
      iconPicker: {
        title: '选择应用图标',
        fields: [choice('预置图标', ['经典信封', '青色邮票'])],
        actions: [action('预览系统确认后的结果', 'iconResult', true)],
      },
      iconResult: {
        title: '已选应用图标',
        rows: [row('系统图标示例', '{{预置图标}}')],
        actions: [action('重新选择', 'iconPicker'), returnHome],
      },
      iconUnavailable: {
        title: '此设备使用默认图标',
        rows: [row('应用图标', '经典信封')],
        note: '当前系统或安装方式未开放更换图标。仍可调整阅读主题与欢迎页。',
        actions: [action('调整主题与字号', 'appearance', true), returnHome],
      },
      accounts: {
        title: '邮箱使用统计',
        rows: [row('工作室', studio.address, 'studioWeek'), row('个人邮箱', personal.address, 'personalWeek')],
        actions: [returnHome],
      },
      studioWeek: usage('工作室用量', week, 7, 2, studio, '查看本月', 'studioMonth'),
      studioMonth: usage('工作室用量', month, 29, 11, studio, '查看近七天', 'studioWeek'),
      personalWeek: usage('个人邮箱用量', week, 7, 0, personal, '查看本月', 'personalMonth'),
      personalMonth: usage('个人邮箱用量', month, 15, 2, personal, '查看近七天', 'personalWeek'),
    },
  };
  (window.MailDesignFlows ||= []).push(preferences);
})();
