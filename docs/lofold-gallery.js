const viewer = document.querySelector('.viewer')
const imageArea = viewer.querySelector('.viewer-image')
const picture = imageArea.querySelector('img')
const zoom = viewer.querySelector('#zoom')
const closeButton = viewer.querySelector('#close')

function setZoom(original) {
  imageArea.classList.toggle('original', original)
  zoom.setAttribute('aria-pressed', String(original))
  zoom.title = original ? '适应窗口' : '查看原始尺寸'
  imageArea.scrollTo(0, 0)
}

if (typeof viewer.showModal === 'function') {
  for (const link of document.querySelectorAll('[data-preview]')) {
    link.setAttribute('aria-haspopup', 'dialog')
    link.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      picture.src = link.href
      picture.alt = link.querySelector('img').alt
      const figure = link.closest('figure')
      viewer.querySelector('#viewer-title').textContent = figure.querySelector('h3, h4')?.textContent ?? '三栏收件箱'
      setZoom(false)
      viewer.showModal()
    })
  }

  closeButton.addEventListener('click', () => viewer.close())
  viewer.addEventListener('click', event => {
    if (event.target !== viewer) return
    const bounds = viewer.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) viewer.close()
  })
  zoom.addEventListener('click', () => setZoom(!imageArea.classList.contains('original')))
  viewer.addEventListener('close', () => {
    if (!viewer.open) picture.removeAttribute('src')
  })
}

const aiTabList = document.querySelector('.ai-tabs')
const aiTabs = Array.from(aiTabList.querySelectorAll('[role="tab"]'))

function showAiExample(active) {
  for (const tab of aiTabs) {
    const selected = tab === active
    const panel = document.getElementById(tab.getAttribute('aria-controls'))
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', tab.id)
    panel.hidden = !selected
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
}

for (const [index, tab] of aiTabs.entries()) {
  tab.addEventListener('click', () => showAiExample(tab))
  tab.addEventListener('keydown', event => {
    const nextIndex = {
      ArrowRight: (index + 1) % aiTabs.length,
      ArrowLeft: (index + aiTabs.length - 1) % aiTabs.length,
      Home: 0,
      End: aiTabs.length - 1,
    }[event.key]
    if (nextIndex === undefined) return
    event.preventDefault()
    showAiExample(aiTabs[nextIndex])
    aiTabs[nextIndex].focus()
  })
}
showAiExample(aiTabs[0])
aiTabList.hidden = false
