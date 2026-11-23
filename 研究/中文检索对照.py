"""用同一批合成主题与正文复现三种检索策略。仅验证匹配语义。"""
import json
import sqlite3


MAIL = [
    ("会议邀请附件清单", "本月会议安排与周报"),
    ("十一月出差报销申请", "请核对差旅明细"),
    ("报销金额通知", "报销凭证见附件"),
    ("季度会议通知", "讨论下周计划"),
]
QUERIES = ["报销", "会议", "附件", "附", "季度", "不存在", "报销申请"]


def substring_hits(term):
    return [i for i, fields in enumerate(MAIL, 1) if any(term in field for field in fields)]


def main():
    db = sqlite3.connect(":memory:")
    db.execute("CREATE VIRTUAL TABLE prefix_index USING fts5(subject, body, tokenize='porter unicode61')")
    db.execute("CREATE VIRTUAL TABLE trigram_index USING fts5(subject, body, tokenize='trigram')")
    for table in ("prefix_index", "trigram_index"):
        db.executemany(f"INSERT INTO {table}(subject,body) VALUES (?,?)", MAIL)
    rows = []
    for term in QUERIES:
        # 样本均为不含语法操作符的中文。三条路径分别对应列出的固定版本。
        prefix = db.execute("SELECT rowid FROM prefix_index WHERE prefix_index MATCH ? ORDER BY rowid",
                            (f'"{term}"*',)).fetchall()
        trigram = db.execute("SELECT rowid FROM trigram_index WHERE trigram_index MATCH ? ORDER BY rowid",
                             (term,)).fetchall()
        expected = substring_hits(term)
        trigram_hits = [row[0] for row in trigram]
        if len(term) < 3:
            # 上游在 Rust 逐字段做 Unicode 小写和子串扫描。此处只模拟本表的中文样本。
            scanned = db.execute("SELECT rowid FROM trigram_index WHERE instr(subject, ?) > 0 "
                                 "OR instr(body, ?) > 0 ORDER BY rowid", (term, term)).fetchall()
            meron_semantics = [row[0] for row in scanned]
        else:
            meron_semantics = trigram_hits
        rows.append({"query": term, "expected": expected, "meron_strategy": meron_semantics,
                     "allodia_strategy": [row[0] for row in prefix], "velo_strategy": trigram_hits})
    print(json.dumps({"sqlite": sqlite3.sqlite_version, "rows": rows}, ensure_ascii=False, indent=2))
    db.close()


if __name__ == "__main__":
    main()
