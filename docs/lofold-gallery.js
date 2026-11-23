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
      viewer.querySelector('#viewer-title').textContent = figure.querySelector('h4')?.textContent ?? '三栏收件箱'
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
