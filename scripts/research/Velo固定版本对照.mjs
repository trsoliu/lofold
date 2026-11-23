import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

const upstream = path.resolve(process.argv[2] || ".");
const hashes = {
  "src/services/db/migrations.ts":
    "267a1a7210c775e5b5eb915dd94f9ae8c6fbe638399edf5e3de80945688892b0",
  "src/services/db/search.ts":
    "a1637a6c9c9f3e64efa3129b6c01e459e2096109cbc9890d3f1494fd82c32fc7",
  "src/services/db/attachments.ts":
    "6192c6c7a389c44f08802a103b978fc812ff82af53514a200e5b2b33a4484295",
  "src/services/db/scheduledEmails.ts":
    "d3e2906bf4acd122e2a6d5979506aac33179ebb8035c2da8ea3affabca3a2728",
  "src/services/snooze/scheduledSendManager.ts":
    "21e37344aa68dbf970bcdd7a05f984be807c60c05b5a1ecbc509dca5e6eddf4c",
  "src/services/search/searchParser.ts":
    "38934c22bbc3e577142dced2a4a8e4732b2a9c214e15c2963cbdfc4a5e326596",
  "src/services/search/searchQueryBuilder.ts":
    "28bafc9c16565484e78294772daddc975cbaa55d6f29c9048d3035be53984f65",
};
for (const [name, expected] of Object.entries(hashes)) {
  const bytes = fs.readFileSync(path.join(upstream, name));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expected,
    "固定版本源码不符：" + name,
  );
}
const db = new DatabaseSync(":memory:");
const binds = (args) =>
  Object.fromEntries(args.map((value, index) => ["$" + (index + 1), value]));
const probe = (globalThis.probe = {
  db: {
    select: async (sql, args = []) => db.prepare(sql).all(binds(args)),
    execute: async (sql, args = []) => db.prepare(sql).run(binds(args)),
  },
  submissions: 0,
  gmailRequests: 0,
  callback: null,
});
const mocked = {
  "./connection": "export const getDb=async()=>globalThis.probe.db",
  "@/utils/timestamp": "export const getCurrentUnixTimestamp=()=>1700000000",
  "../gmail/tokenManager": `export const getGmailClient=async()=>{const p=globalThis.probe;p.gmailRequests++;return {sendMessage:async()=>{if(++p.submissions===1)throw new Error("network timeout after simulated acceptance")}}}`,
  "@/utils/emailBuilder": 'export const buildRawEmail=()=>"synthetic"',
  "../db/accounts":
    'export const getAccount=async()=>({id:"a",email:"demo@example.invalid",provider:"imap"})',
  "../backgroundCheckers":
    "export function createBackgroundChecker(_,run){globalThis.probe.callback=run;return {start:()=>{},stop:()=>{}}}",
};
registerHooks({
  resolve(specifier, context, next) {
    if (Object.hasOwn(mocked, specifier)) {
      return {
        url: "data:text/javascript," + encodeURIComponent(mocked[specifier]),
        shortCircuit: true,
      };
    }
    if (
      context.parentURL?.startsWith("file:") &&
      specifier.startsWith(".") &&
      !path.extname(specifier)
    ) {
      const file = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier + ".ts",
      );
      if (fs.existsSync(file))
        return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
function fromUpstream(file) {
  return pathToFileURL(path.join(upstream, file)).href;
}
const migrations = fs.readFileSync(
  path.join(upstream, "src/services/db/migrations.ts"),
  "utf8",
);
const sql = [...migrations.matchAll(/sql:\s*`([^\x60]+)`/g)].map((m) => m[1]);
for (const ddl of sql.slice(0, 2)) db.exec(ddl);
const { searchMessages } = await import(
  fromUpstream("src/services/db/search.ts")
);
const { getAttachmentsForAccount } = await import(
  fromUpstream("src/services/db/attachments.ts")
);
db.prepare("INSERT INTO accounts (id,email) VALUES (?,?)").run(
  "a",
  "sample@example.invalid",
);
for (let i = 0; i < 201; i++) {
  const msg = "m" + i,
    thread = "t" + i;
  db.prepare("INSERT INTO threads(id,account_id) VALUES (?,?)").run(
    thread,
    "a",
  );
  db.prepare(
    "INSERT INTO messages(id,account_id,thread_id,subject,date) VALUES (?,?,?,?,?)",
  ).run(msg, "a", thread, i === 0 ? "差旅报销单审批" : "常规通知", i + 1);
  db.prepare(
    "INSERT INTO attachments(id,message_id,account_id,filename) VALUES (?,?,?,?)",
  ).run("a" + i, msg, "a", i === 0 ? "差旅报销单.pdf" : "附件" + i + ".pdf");
}
const search = {};
for (const [query, expected] of Object.entries({
  报销: 0,
  报销单: 1,
  "subject:报销": 1,
})) {
  search[query] = (await searchMessages(query, "a")).length;
  assert.equal(search[query], expected);
}
const page = await getAttachmentsForAccount("a");
const all = await getAttachmentsForAccount("a", 1000);
const matches = (rows) => rows.filter((r) => r.filename.includes("报销"));
const attachment = {
  defaultCount: page.length,
  defaultHits: matches(page).length,
  totalCount: all.length,
  totalHits: matches(all).length,
  original: matches(all)[0].message_id,
  thread: matches(all)[0].thread_id,
};
assert.deepEqual(attachment, {
  defaultCount: 200,
  defaultHits: 0,
  totalCount: 201,
  totalHits: 1,
  original: "m0",
  thread: "t0",
});
db.prepare(
  "INSERT INTO scheduled_emails (id,account_id,to_addresses,subject,body_html,scheduled_at) VALUES (?,?,?,?,?,?)",
).run("s", "a", "dest@example.invalid", "合成邮件", "仅测试", 1);
await import(fromUpstream("src/services/snooze/scheduledSendManager.ts"));
const status = () =>
  db.prepare("SELECT status FROM scheduled_emails WHERE id='s'").get().status;
const states = [status()];
const old = console.error;
let caught;
try {
  console.error = (...args) => {
    caught = String(args[1]);
  };
  await probe.callback();
  states.push(status());
  await probe.callback();
  states.push(status());
} finally {
  console.error = old;
}
assert.deepEqual(states, ["pending", "pending", "sent"]);
assert.equal(probe.gmailRequests, 2);
assert.equal(probe.submissions, 2);
console.log(
  JSON.stringify(
    {
      version: "velo-v0.4.21",
      commit: "4b3efd568a97b8593cff7770908c15dc82045d44",
      node: process.version,
      arch: os.arch(),
      os: os.platform(),
      database: db.prepare("SELECT sqlite_version() AS v").get().v,
      search,
      attachment,
      scheduled: {
        account: "imap",
        states,
        gmailClientRequests: probe.gmailRequests,
        simulatedSubmissions: probe.submissions,
        caught,
      },
    },
    null,
    2,
  ),
);
