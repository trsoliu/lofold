(() => {
  'use strict';
  const row = (label,value,to) => ({label,value,to});
  const action = (label,to,primary=false) => ({label,to,primary});
  const selection = (label,options) => ({label,options,type:'select',value:options[0]});
  const backToList = action('返回邮件列表','select');
  const names = ['两个邮箱 · 2 封','仅工作室 · 1 封','仅个人邮箱 · 1 封'];
  const personal = row('个人邮箱','周末取书时间'), studio = row('工作室','冬日散步指南 · 第二版打样确认');
  const batch = {id:'batch',title:'批量整理邮件',start:'select',states:{
    select:{title:'选择要整理的邮件',hint:'所有收件箱',rows:[studio,personal],fields:[selection('选择范围',names)],actions:[
      {...action('归档所选邮件','confirm',true),branch:{field:'选择范围',cases:{[names[1]]:'studioOnly',[names[2]]:'personalOnly'}}}
    ]},
    confirm:{title:'归档 2 封邮件？',rows:[row('工作室','1 封 → 工作室的归档文件夹'),row('个人邮箱','1 封 → 个人邮箱的归档文件夹')],note:'邮件在各自的邮箱内移动。',actions:[action('确认归档','done',true),action('预览单个邮箱离线','partial'),backToList]},
    studioOnly:{title:'归档工作室的邮件？',rows:[studio,row('目标','工作室 · 归档')],actions:[action('确认归档','single',true),backToList]},
    personalOnly:{title:'归档个人邮箱的邮件？',rows:[personal,row('目标','个人邮箱 · 归档')],actions:[action('确认归档','single',true),backToList]},
    done:{title:'已归档 2 封',rows:[row('工作室','1 封已归档'),row('个人邮箱','1 封已归档')],actions:[action('撤销本次归档','undone'),backToList]},
    single:{title:'已归档 1 封',rows:[row('本次操作','{{选择范围}}')],actions:[action('撤销本次归档','undone'),backToList]},
    partial:{title:'1 封已归档，1 封待处理',rows:[row('工作室','已归档'),row('个人邮箱','连接中断，邮件仍在收件箱')],actions:[action('仅重试个人邮箱','done',true),action('先保留待处理项','pending')]},
    pending:{title:'归档操作待处理',rows:[row('个人邮箱','周末取书时间 · 等待重新连接'),row('工作室','已归档，本次不会再提交')],actions:[action('恢复连接并重试','done',true),backToList]},
    undone:{title:'已恢复到原收件箱',rows:[row('已撤销的范围','{{选择范围}}')],actions:[backToList]}
  }};
  const chooseFiles = action('返回导入与导出','import');
  const archive = {id:'archive',title:'批量导入与原件导出',start:'import',states:{
    import:{title:'导入与导出',hint:'本地档案',rows:[
      row('导入邮件','选择 MBOX 邮箱包或一组 EML 原件','inspect'),row('导出原始邮件','保留原始信头、正文和 MIME 附件','export')
    ]},
    inspect:{title:'核对要导入的邮件',rows:[row('文件','周末往来.mbox · 4 封'),row('检查结果','2 封可新增、1 封已存在、1 封格式错误')],fields:[selection('保存到',['本机导入件','工作室 · 本地档案','个人邮箱 · 本地档案'])],note:'重复检查以目标档案内的原件字节为准。未能识别的原件继续保留。上述数量为三个示例目标的预置结果。',actions:[action('导入可读取的邮件','result',true),chooseFiles]},
    result:{title:'已导入 2 封邮件',rows:[row('保存位置','{{保存到}}'),row('已跳过 1 封','与现有原件字节相同'),row('未导入 1 封','第 4 封邮件格式损坏','failed')],actions:[action('查看已导入的原件','export',true),chooseFiles]},
    failed:{title:'查看未导入项',rows:[row('来源','周末往来.mbox · 第 4 封'),row('原因','邮件头与正文缺少分隔行')],note:'可重新选择修复后的文件。已成功导入的原件无需再次处理。',actions:[action('试用修复后的样本','repaired',true),action('返回导入结果','result')]},
    repaired:{title:'已补入 1 封',rows:[row('目标','{{保存到}}'),row('这批文件','3 封新增、1 封重复、0 封失败')],actions:[action('查看原件导出','export',true),chooseFiles]},
    export:{title:'导出原始邮件',rows:[row('示例邮件','冬日散步指南 · 第二版打样确认'),row('输出格式','EML · 包含原始附件')],note:'本机存储的压缩格式对导出透明。校验失败时保留原件，并告知具体邮件。',actions:[action('预览导出成功','saved',true),action('预览原件校验失败','damaged'),chooseFiles]},
    saved:{title:'原始 EML 已导出',rows:[row('文件','冬日散步指南.eml'),row('完整性','导出字节与导入原件一致')],actions:[chooseFiles]},
    damaged:{title:'原件校验未通过',rows:[row('邮件','冬日散步指南 · 第二版打样确认'),row('导出结果','未写入不完整的 EML')],note:'保留当前原件与错误记录，可从已有完好副本恢复后重试。',actions:[action('返回导出选项','export',true),chooseFiles]}
  }};
  const storage = {id:'compression',title:'压缩策略与空间不足',start:'overview',states:{
    overview:{title:'本机空间',hint:'示例工作区 · 两个邮箱',rows:[
      row('压缩与原件','查看一封邮件实际保存了什么','sample'),row('后台整理','选择执行时机','policy'),row('空间不足','查看中断后的恢复路径','limited')
    ],note:'原件无损保存。服务商配额、设备磁盘用量和文件缓存是不同的统计口径。'},
    sample:{title:'原件与保存载荷',rows:[row('原始字节','102,400 B'),row('压缩后载荷','20,480 B'),row('载荷节省','81,920 B（80%）'),row('设备磁盘实占','需计入块、索引和元数据，此示例未测')],actions:[action('查看已经压缩的附件','unchanged',true),action('返回本机空间','overview')]},
    unchanged:{title:'保留原样',rows:[row('附件','图册.zip'),row('原始字节','40,960 B'),row('试压结果','41,028 B'),row('采用载荷','40,960 B · 节省 0 B')],actions:[action('返回本机空间','overview',true)]},
    policy:{title:'后台无损整理',fields:[selection('整理时机',['设备空闲时','仅充电且空闲时','手动启动'])],note:'原件写入和完整性核对完成后才替换本机副本。',actions:[action('保存到此设备','policySaved',true),action('返回本机空间','overview')]},
    policySaved:{title:'已保存设备偏好',rows:[row('整理时机','{{整理时机}}')],actions:[action('返回本机空间','overview',true)]},
    limited:{title:'空间不足，整理已暂停',rows:[row('当前文件','图册素材.eml'),row('可用临时空间','4 MiB'),row('还需临时空间','8 MiB')],note:'可继续读原信。空间充足后从未完成处重试。',actions:[action('预览释放空间后的重试','restored',true),action('保持暂停','paused')]},
    paused:{title:'等待可用空间',rows:[row('原件','可读取、导出'),row('队列','保留未完成文件')],actions:[action('查看暂停原因','limited',true)]},
    restored:{title:'已完成整理',rows:[row('原件校验','通过'),row('之前已完成的文件','保留已有结果')],actions:[action('查看载荷示例','sample',true),action('返回本机空间','overview')]}
  }};
  (window.MailDesignFlows ||= []).push(batch, archive, storage);
})();
