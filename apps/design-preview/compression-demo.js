/* 存储页试压只保留当前面板下载所需的内存对象。 */
(() => {
  "use strict";

  const LIMIT = 8 * 1024 * 1024;
  const runs = new WeakMap();
  const formatBytes = value => value.toLocaleString("zh-CN") + " B";
  const supported = () =>
    typeof CompressionStream === "function" &&
    typeof DecompressionStream === "function" &&
    typeof Blob.prototype.stream === "function" &&
    typeof Blob.prototype.arrayBuffer === "function";

  function panel() {
    const { icon } = window.MailUI;
    const disabled = supported() ? "" : " disabled";
    const initial = supported() ? "" : "当前浏览器未提供 GZIP 试压接口，请使用支持压缩流的浏览器。";
    return `<section class="mx-compression" data-compression-panel aria-labelledby="compression-title">
      <h3 id="compression-title">试压一份文件</h3>
      <p class="mx-compression-note">在浏览器内用 GZIP 试压，文件仅在当前页面处理。单个文件最大 8 MiB。</p>
      <div class="mx-compression-actions">
        <button type="button" class="mx-sub-btn" data-compression-task="example"${disabled}>${icon("mail", 16)}试用示例 EML</button>
        <button type="button" class="mx-sub-btn" data-compression-task="choose"${disabled}>${icon("folder", 16)}选择本机文件</button>
        <input type="file" aria-label="选择要试压的文件" data-compression-input hidden>
      </div>
      <p class="mx-compression-status" data-compression-status role="status" aria-live="polite">${initial}</p>
      <div class="mx-compression-result" data-compression-result hidden>
        <strong class="mx-compression-name" data-compression-name></strong>
        <dl class="mx-compression-metrics">
          <div><dt>原始文件</dt><dd data-compression-original></dd></div>
          <div><dt>所选载荷</dt><dd data-compression-stored></dd></div>
          <div><dt>节省字节</dt><dd data-compression-saved></dd></div>
        </dl>
        <button type="button" class="mx-sub-btn" data-compression-task="download">${icon("download", 15)}下载还原原件</button>
      </div>
      <details class="mx-disclosure"><summary>试压结果的统计口径</summary><p>这里比较原始字节与 GZIP 载荷。压缩无收益时保留原样。产品的 Rust 压缩组件使用 Zstandard，上方样本按磁盘实际分配空间计量。</p></details>
    </section>`;
  }

  function sampleMail() {
    const items = Array.from({ length: 24 }, (_, i) =>
      `第 ${String(i + 1).padStart(2, "0")} 项：请核对十二月 ${i + 1} 日的车次、座位以及随车行李，抵达后保留报销凭证。`
    );
    const content = [
      "From: sample@example.test", "To: reader@example.test",
      "Date: Fri, 20 Nov 2026 10:00:00 +0800",
      "Subject: December travel checklist", "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit",
      "", "十二月行程核对单", "", ...items, "",
    ].join("\r\n");
    return new File([content], "十二月行程示例.eml", { type: "message/rfc822" });
  }

  async function transform(blob, stream) {
    const result = blob.stream().pipeThrough(stream);
    return new Uint8Array(await new Response(result).arrayBuffer());
  }

  function sameBytes(left, right) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  async function run(root, file) {
    if (!supported() || !file || runs.get(root)?.busy) return;
    const field = key => root.querySelector("[data-compression-" + key + "]");
    const buttons = root.querySelectorAll("[data-compression-task]");
    const status = field("status");
    const current = { busy: true, restored: null };
    runs.set(root, current);
    field("result").hidden = true;
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = "正在本机压缩并校验原件…";
    try {
      if (file.size > LIMIT) {
        status.textContent = "文件超过 8 MiB，未读取。请选择较小的测试文件。";
        return;
      }
      const original = new Uint8Array(await file.arrayBuffer());
      const compressed = await transform(file, new CompressionStream("gzip"));
      const useGzip = compressed.byteLength < original.byteLength;
      const payload = useGzip ? compressed : original;
      const blob = new Blob([payload]);
      const restored = useGzip
        ? await transform(blob, new DecompressionStream("gzip"))
        : new Uint8Array(await blob.arrayBuffer());
      if (!sameBytes(original, restored)) throw new Error("恢复校验失败");
      if (!root.isConnected) return;
      current.restored = new Blob([restored], { type: "application/octet-stream" });
      current.name = file.name;
      field("name").textContent = file.name;
      field("original").textContent = formatBytes(original.byteLength);
      field("stored").textContent = formatBytes(payload.byteLength);
      field("saved").textContent = formatBytes(original.byteLength - payload.byteLength);
      field("result").hidden = false;
      const mode = useGzip ? "采用 GZIP 载荷" : `GZIP 为 ${formatBytes(compressed.byteLength)}，保留原样`;
      status.textContent = mode + "。还原内容已通过逐字节校验。";
    } catch {
      status.textContent = "读取、压缩或还原校验未成功。请重新选择文件再试。";
    } finally {
      current.busy = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  function download(root) {
    const run = runs.get(root);
    if (!run?.restored || run.busy) return;
    const url = URL.createObjectURL(run.restored);
    const link = document.createElement("a");
    link.href = url;
    link.download = run.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-compression-task]");
    const root = button?.closest("[data-compression-panel]");
    if (!root || button.disabled) return;
    switch (button.dataset.compressionTask) {
      case "example": run(root, sampleMail()); break;
      case "choose": root.querySelector("[data-compression-input]").click(); break;
      case "download": download(root); break;
    }
  });
  document.addEventListener("change", event => {
    const input = event.target;
    if (!input.matches?.("[data-compression-input]")) return;
    const root = input.closest("[data-compression-panel]");
    const file = input.files[0];
    input.value = "";
    if (root && file) run(root, file);
  });

  window.MailCompressionDemo = { panel };
})();
