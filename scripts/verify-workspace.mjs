import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const appNames = ['desktop', 'design-preview']
const rootDocs = ['README', 'AGENTS', 'CLAUDE', 'CODEMAP', 'CONTRACTS', 'DESIGN', 'INTERFACES', 'TESTING', 'RELEASE', 'CHANGELOG']

for (const app of appNames) {
  const manifest = JSON.parse(read(`apps/${app}/package.json`))
  assert.equal(manifest.name, `@lofold/${app}`)
  assert.equal(manifest.dependencies['@lofold/branding'], 'workspace:*')
}
const preview = 'apps/design-preview/'
for (const entry of ['index.html', 'review.html', 'directions.html']) {
  assert.match(read(preview + entry), /src="\.\.\/\.\.\/packages\/branding\/design-options\.js\?/)
}
const cargo = spawnSync('cargo', ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1'], {
  cwd: fileURLToPath(root), encoding: 'utf8',
})
assert.equal(cargo.status, 0, cargo.stderr || String(cargo.error))
const { packages } = JSON.parse(cargo.stdout)
const expected = new Map([
  ['lofold-client', 'apps/desktop/src-tauri/'],
  ['lofold-mail-network', 'packages/mail-network/'],
  ['lofold-mail-store', 'packages/mail-store/'],
  ['mail-blob-codec', 'packages/mail-blob-codec/'],
])
for (const [name, path] of expected) {
  const crate = packages.find(entry => entry.name === name)
  assert.equal(crate?.manifest_path, fileURLToPath(new URL(path + 'Cargo.toml', root)))
  if (path.startsWith('packages/')) {
    assert.ok(crate.dependencies.every(dep => !dep.path?.startsWith(fileURLToPath(new URL('apps/', root)))), `${name} depends on an app`)
  }
}

const documents = [
  ...rootDocs.map(name => name + '.md'),
  'docs/README.md', 'docs/adr/0001-workspace-layout.md',
  'apps/desktop/AGENTS.md', 'apps/desktop/README.md', 'apps/desktop/src-tauri/AGENTS.md',
  'apps/design-preview/AGENTS.md', 'apps/design-preview/README.md',
  'packages/AGENTS.md', 'scripts/README.md',
  ...['branding', 'mail-blob-codec', 'mail-network', 'mail-store'].map(name => `packages/${name}/README.md`),
]
for (const path of documents) {
  for (const [, destination] of read(path).matchAll(/\]\(([^)]+)\)/g)) {
    const target = destination.split('#')[0]
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    assert.ok(existsSync(new URL(target, new URL(path, root))), `${path} links to missing ${target}`)
  }
}

const host = read('apps/desktop/src-tauri/src/main.rs')
const registration = host.match(/tauri::generate_handler!\[([\s\S]+?)\]/)?.[1]
assert.ok(registration, 'Native command registry missing')
const commands = new Set(registration.split(',').map(entry => entry.trim().split('::').at(-1)))
const src = new URL('apps/desktop/src/', root)
let calls = 0
for (const name of readdirSync(src).filter(name => /\.tsx?$/.test(name))) {
  const source = readFileSync(new URL(name, src), 'utf8')
  assert.doesNotMatch(source, /from\s+['"\x60][^'"\x60]*\b(?:design-preview|prototype)\//, `${name} imports another app`)
  for (const [, command] of source.matchAll(/\binvoke(?:<[^\n(]*>)?\s*\(\s*['"]([a-z_]+)['"]/g)) {
    calls++
    assert.ok(commands.has(command), `${name} calls unregistered command ${command}`)
  }
}
assert.ok(calls > 0, 'Renderer command call sites missing')
console.log(`Workspace layout, ${documents.length} documentation files and ${calls} renderer command call sites verified.`)
