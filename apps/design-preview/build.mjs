import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'

// Keep relative paths intact so the preview also works from an extracted directory.
const resolve = createRequire(import.meta.url).resolve
const dist = new URL('dist/', import.meta.url)
const preview = new URL('apps/design-preview/', dist)
const branding = new URL('packages/branding/', dist)

await rm(dist, { recursive: true, force: true })
await mkdir(preview, { recursive: true })
await mkdir(branding, { recursive: true })
for (const name of await readdir(new URL('.', import.meta.url))) {
  if (name === 'assets' || /\.(html|css|js)$/.test(name)) {
    await cp(new URL(name, import.meta.url), new URL(name, preview), { recursive: true })
  }
}
await cp(resolve('@lofold/branding/design-options'), new URL('design-options.js', branding))
await cp(resolve('@lofold/branding/logo.svg'), new URL('lofold.svg', branding))
