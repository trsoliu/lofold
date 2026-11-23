import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureScript, scenarioScript } from './common.mjs';

const here = import.meta.dirname;
const desktop = resolve(here, '../..');
const dist = join(desktop, 'dist');
const artifacts = resolve(process.env.LOFOLD_READER_ARTIFACTS || join(desktop, '../../target/reader-layout'), 'wk');
const cases = [
  ['alert', 420, 'white'], ['alert', 420, 'gold'],
  ['alert', 1200, 'white'], ['alert', 1200, 'gold'],
  ['legacy', 420, 'gold'], ['data-table', 420, 'gold'], ['fields', 420, 'white'],
  ['media', 1200, 'gold'], ['workspace', 420, 'white'], ['workspace', 966, 'white'],
  ['attachments', 420, 'gold'],
];

function processOutput(bin, args, { timeout = 60_000, label = bin } = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 40 * 1024 * 1024 });
  if (result.stderr?.trim()) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${result.error?.message ?? result.signal ?? `exit ${result.status}`}`);
  }
  return result.stdout;
}

function compile(target, files, ...flags) {
  processOutput('xcrun', ['--sdk', 'macosx', 'clang', '-fobjc-arc', '-O2',
    '-framework', 'AppKit', '-framework', 'WebKit', ...flags, '-o', target, ...files], { label: 'Compile the WebKit test tool' });
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function verifyNativeOutput(native, toolDir) {
  const begin = 'LOFOLD_NATIVE_BEGIN';
  const right = 'LOFOLD_NATIVE_OUTERMOST';
  const end = 'LOFOLD_NATIVE_END';
  const chart = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAIAAAD4YuoOAAAAHUlEQVR4nGMQqT5BU8QwasGoBaMWjFowasFQsAAAh9KuH4I8hyEAAAAASUVORK5CYII=';
  const markerColors = ['be1662', '147bc8', '108546', 'b25311'];
  const rows = Array.from({ length: 60 }, (_, index) => `<p>合成邮件正文第 ${index + 1} 行</p>`).join('');
  const source = join(toolDir, 'native-synthetic.html');
  writeFileSync(source, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    body{font:16px sans-serif;margin:16px}table{border-collapse:collapse}td{padding:8px}
    .marker{display:inline-block;width:40px;height:20px}p{line-height:28px;margin:8px 0}
    </style><body>
    <p>${begin} <span class="marker" style="background:#${markerColors[0]}"></span></p>
    <table style="width:1160px"><tbody><tr><td style="width:900px">合成数据</td><td><span class="marker" style="background:#${markerColors[3]}"></span> ${right}</td></tr></tbody></table>
    <p><img alt="合成图表" width="32" height="16" src="data:image/png;base64,${chart}"></p>
    ${rows}<p>${end} <span class="marker" style="background:#${markerColors[2]}"></span></p>
    </body></html>`);

  const run = (input, mode, label, colors = []) => {
    const result = JSON.parse(processOutput(native, [input, mode, join(artifacts, `${label}.${mode}`), ...colors],
      { label: `Native ${label} ${mode}` }));
    writeJson(join(artifacts, `${label}-${mode}.json`), result);
    return result;
  };

  const png = run(source, 'png', 'synthetic', markerColors);
  assert.equal(png.code, 0, 'the production renderer creates a PNG');
  const { width, height, probes } = png.output;
  assert.ok(width > 1400 && height > 2000, 'the PNG covers the full wide table and the last paragraph');
  for (const probe of probes) assert.ok(probe.count >= 100, `the PNG contains marker #${probe.color}`);
  assert.ok(probes[3].bounds[0] > width * 0.65, 'the native PNG includes the far-right table column');
  assert.ok(Math.abs(probes[2].bounds[1] - probes[0].bounds[1]) > height * 0.75,
    'the opening and closing markers span the full native PNG');

  const pdf = run(source, 'pdf', 'synthetic');
  assert.equal(pdf.code, 0, 'the production print path assembles a PDF');
  assert.ok(pdf.output.pages.length > 1, 'the native print output spans multiple pages');
  const [first] = pdf.output.pages;
  const last = pdf.output.pages.at(-1);
  assert.ok(first.includes(begin) && first.includes(right), 'print contains the opening and far-right column');
  assert.ok(last.includes(end), 'native print contains the last paragraph');

  const overLimit = join(toolDir, 'native-over-limit.html');
  writeFileSync(overLimit, '<p style="width:2500px">越过长图和打印尺寸上限的合成内容</p>');
  for (const mode of ['png', 'pdf']) {
    assert.equal(run(overLimit, mode, 'over-limit').code, 1,
      `the native renderer reports the size limit for ${mode} instead of clipping`);
  }

  console.log('Native output: PNG chart/first/last/right markers, paginated PDF, and size limits passed.');
  return run;
}

assert.equal(process.platform, 'darwin', 'The native reader regression requires macOS and Xcode command-line tools.');
assert.ok(existsSync(join(dist, 'index.html')), 'Build the desktop frontend before running the native reader regression.');
const tools = mkdtempSync(join(tmpdir(), 'lofold-reader-wk-'));
mkdirSync(artifacts, { recursive: true });
try {
  const wk = join(tools, 'wk-runner');
  const nativeOutput = join(tools, 'native-output');
  compile(wk, [join(here, 'wk-runner.m')]);
  compile(nativeOutput, [join(here, 'native-output.m'), join(desktop, 'src-tauri/src/message_image.m')],
    '-DLOFOLD_NATIVE_OUTPUT_TEST', '-framework', 'ImageIO', '-framework', 'PDFKit');
  const render = verifyNativeOutput(nativeOutput, tools);

  for (const [name, width, theme] of cases) {
    const label = `${name}-${width}-${theme}`;
    const wantExports = (name === 'alert' && width === 1200 && theme === 'white') || name === 'data-table';
    const height = 780;
    const setup = join(tools, 'setup.js');
    const scenario = join(tools, 'scenario.js');
    writeFileSync(setup, await fixtureScript(name, { theme }));
    writeFileSync(scenario, await scenarioScript(name, { theme, width, height, captureExports: wantExports }));
    const result = JSON.parse(processOutput(wk, [dist, setup, scenario, String(width), String(height), join(artifacts, `${label}.png`)], {
      timeout: 30_000, label: `WKWebView ${label}`,
    }));
    const { exports: output, ...evidence } = result;
    writeJson(join(artifacts, `${label}.json`), evidence);
    assert.ok(Array.isArray(result.checks) && result.checks.length, `WKWebView ${label} returned no assertions`);
    assert.deepEqual(result.checks.filter(check => !check.ok), [], `WKWebView ${label} layout assertions`);
    if (wantExports) {
      assert.ok(output?.image && output?.print && output?.endMarker, `${label} produced both app export documents and an end marker`);
      // Colors come from the alert's CID image, the table's last cell, and each fixture's closing paragraph.
      const colors = [name === 'alert' ? '2e788b' : 'b25311', '108546'];
      const image = join(tools, `${label}-image.html`);
      writeFileSync(image, output.image);
      const png = render(image, 'png', `app-${label}`, colors);
      assert.equal(png.code, 0, `${label} renders the app-generated PNG`);
      const [content, tail] = png.output.probes;
      assert.ok(content.count >= 100 && tail.count >= 100 && tail.bounds[1] > content.bounds[1],
        `${label} PNG contains the ${name === 'alert' ? 'inline chart' : 'last table column'} and final paragraph`);
      if (name === 'data-table') {
        assert.ok(png.output.width >= 1350 && content.bounds[0] > png.output.width * 0.65,
          'the app-generated PNG reaches the right side of the wide data table');
      }

      const print = join(tools, `${label}-print.html`);
      writeFileSync(print, output.print);
      const pdf = render(print, 'pdf', `app-${label}`);
      assert.equal(pdf.code, 0, `${label} renders the app-generated print PDF`);
      const finalPage = pdf.output.pages.at(-1).replace(/\s/gu, '');
      assert.ok(finalPage.includes(output.endMarker.replace(/\s/gu, '')),
        `native print includes the final content of ${label}`);
      if (name === 'data-table') {
        assert.ok(pdf.output.pages.some(page => page.replace(/\s/gu, '').includes('RIGHTMOST-SENTINEL')),
          'native print includes the rightmost data table cell');
      }
    }
    console.log(`WKWebView: ${label} passed.`);
  }
} finally {
  rmSync(tools, { recursive: true, force: true });
}
