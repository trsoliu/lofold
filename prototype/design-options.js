(() => {
  'use strict';

  const brand = Object.freeze({
    name:'LoFold',
    icon:'assets/brands/lofold.svg',
    slogan:'All your inboxes, in one place.'
  });

  // Color roles follow Radix Colors 3.0.0 and IBM Carbon's surface layering.
  // The action fills and emphasis text were checked against their adjacent colors.
  const themes = [
    {
      id:"white", name:"白色", scheme:"light",
      surface:"#ffffff", paper:"#fcfcfc", rail:"#f4f4f4", soft:"#f1f1f1", selected:"#e8e8e8", border:"#d9d9d9",
      chip:"#242424", chipHover:"#121212", chipText:"#ffffff", marker:"#343434",
      ink:"#202020", muted:"#555555"
    },
    {
      id:"black", name:"黑色", scheme:"dark",
      surface:"#1c1c1c", paper:"#161616", rail:"#101010", soft:"#242424", selected:"#303030", border:"#464646",
      chip:"#eeeeee", chipHover:"#ffffff", chipText:"#181818", marker:"#dedede",
      ink:"#eeeeee", muted:"#bdbdbd"
    },
    {
      id:"red", name:"红色", scheme:"light",
      surface:"#ffffff", paper:"#fffcfc", rail:"#ffdbdc", soft:"#feebec", selected:"#ffcdce", border:"#fdbdbe",
      chip:"#cc3f45", chipHover:"#c03a41", chipText:"#ffffff", marker:"#ad252d",
      ink:"#202020", muted:"#515151"
    },
    {
      id:"orange", name:"橙色", scheme:"light",
      surface:"#ffffff", paper:"#fefcfb", rail:"#ffdfb5", soft:"#ffefd6", selected:"#ffd19a", border:"#ffc182",
      chip:"#bb5318", chipHover:"#af4e19", chipText:"#ffffff", marker:"#993f0d",
      ink:"#202020", muted:"#515151"
    },
    {
      id:"yellow", name:"黄色", scheme:"light",
      surface:"#ffffff", paper:"#fdfdf9", rail:"#fff394", soft:"#fffab8", selected:"#ffe770", border:"#f3d768",
      chip:"#ffe629", chipHover:"#e9d128", chipText:"#202020", marker:"#825c0a",
      ink:"#202020", muted:"#515151"
    },
    {
      id:"green", name:"绿色", scheme:"light",
      surface:"#ffffff", paper:"#fbfefc", rail:"#d6f1df", soft:"#e6f6eb", selected:"#c4e8d1", border:"#adddc0",
      chip:"#288157", chipHover:"#267952", chipText:"#ffffff", marker:"#1e6b4a",
      ink:"#202020", muted:"#515151"
    },
    {
      id:"cyan", name:"青色", scheme:"light",
      surface:"#ffffff", paper:"#fafdfe", rail:"#caf1f6", soft:"#def7f9", selected:"#b5e9f0", border:"#9ddde7",
      chip:"#057c98", chipHover:"#06748e", chipText:"#ffffff", marker:"#0f687e",
      ink:"#202020", muted:"#515151"
    },
    {
      id:"blue", name:"蓝色", scheme:"light",
      surface:"#ffffff", paper:"#fbfdff", rail:"#d5efff", soft:"#e6f4fe", selected:"#c2e5ff", border:"#acd8fc",
      chip:"#0573cf", chipHover:"#066bc2", chipText:"#ffffff", marker:"#0e60ae",
      ink:"#202020", muted:"#515151"
    },
    {
      id:"violet", name:"紫色", scheme:"light",
      surface:"#ffffff", paper:"#fdfcfe", rail:"#ebe4ff", soft:"#f4f0fe", selected:"#e1d9ff", border:"#d4cafe",
      chip:"#6e56cf", chipHover:"#6650c2", chipText:"#ffffff", marker:"#624db4",
      ink:"#202020", muted:"#515151"
    },
    {
      id:"gold", name:"曜金", scheme:"dark",
      surface:"#24231f", paper:"#1b1a17", rail:"#121211", soft:"#2d2b26", selected:"#38352e", border:"#544e42",
      chip:"#e0c58f", chipHover:"#efd6a1", chipText:"#211a0f", marker:"#e0c58f",
      ink:"#f3ebe0", muted:"#c9bca8", tier:"尊享"
    },
  ];

  const pick = id => themes.find(theme => theme.id === id) || themes[0];

  function apply(theme) {
    const root = document.documentElement;
    root.dataset.concept = theme.id;
    root.dataset.theme = theme.scheme;
    for (const key of ['surface','paper','rail','soft','selected','border','chip','chipHover','chipText','marker','ink','muted']) {
      root.style.setProperty('--rill-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), theme[key]);
    }
  }

  window.MailDesignOptions = {brand, themes, pick, apply};
})();
