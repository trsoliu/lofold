# 构建与复验脚本

- [工作区检查](verify-workspace.mjs) 通过 `pnpm verify:workspace` 执行。
- [研究脚本](research/) 依赖合成样本，复跑条件见 [实验记录](../docs/research/实验记录.md) 与 [本地压缩对照](../docs/research/本地压缩实验.md)。
- [回环 TLS 服务](research/启动双邮箱测试服务.py) 读取已经校验的 GreenMail 2.1.15 JAR，需要 Java 和 OpenSSL。服务退出时清理合成邮箱。

```sh
python3 -B scripts/research/启动双邮箱测试服务.py /path/to/greenmail-standalone-2.1.15.jar
```

取得终端显示的 CA 路径和端口后另开终端运行。

```sh
LOFOLD_FIXTURE_CA=/path/to/root.pem \
LOFOLD_FIXTURE_SMTPS=43465 LOFOLD_FIXTURE_IMAPS=43993 \
cargo test --locked -p lofold-mail-network -- --ignored --skip manual_credentials_use_separate_logins_over_encrypted_endpoints
```

独立用户名与 STARTTLS 用例需要对应的自定义服务。
