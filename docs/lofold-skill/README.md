# 安装 LoFold Skill

LoFold Skill 适用于支持 [Agent Skills](https://agentskills.io/specification) 的本机 Agent。需要同一台 Mac 上有支持「设置 → Agent MCP」的 LoFold，开启后才能执行操作。GitHub Releases 上的 macOS 0.6.0 首发包早于 Agent MCP。可按[仓库构建说明](../../README.md#本机运行)从当前主分支构建支持版本。

## 让 Agent 安装

把下面这段话发给你的 Agent。

> 请按 https://trsoliu.github.io/lofold/lofold-skill/README.md 安装 LoFold Skill。保留已有 Skill 和 MCP 配置。装好后告诉我安装位置，请我在 LoFold 开启 Agent MCP，再用连接状态验证。

## 手动安装

在本机命令行执行。命令把 Skill 文件安装到新目录，可以先[查看源码](lofold/)。

```sh
(
  set -eu
  base='https://trsoliu.github.io/lofold/lofold-skill/lofold'
  target="${HOME}/.agents/skills/lofold"
  # 使用 Claude Code 时，把 target 改为 "${HOME}/.claude/skills/lofold"
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' EXIT
  mkdir "$stage/scripts"
  for file in LICENSE NOTICE scripts/lofold.py SKILL.md; do
    curl -fsS --proto '=https' "$base/$file" -o "$stage/$file"
  done
  mkdir -p "$(dirname "$target")"
  mkdir "$target"
  cp -R "$stage/LICENSE" "$stage/NOTICE" "$stage/scripts" "$target/"
  cp "$stage/SKILL.md" "$target/"
  printf 'LoFold Skill 已安装到 %s\n' "$target"
)
```

如果目录已存在，先核对位置和版本，再更新同一份 Skill。Codex 从 `~/.agents/skills/lofold` 发现 Skill，Claude Code 从 `~/.claude/skills/lofold` 发现。自建 Agent 可加载 `lofold/SKILL.md`，同时保留相对目录中的 `scripts/lofold.py`。

## 验证与使用

1. 在 LoFold 打开「设置 → Agent MCP」，启用连接。
2. 新开 Agent 会话，试一句「检查我的 LoFold 是否已连接」。已经配置 LoFold MCP 的 Agent 调用 `lofold_status`。也可以用 Python 3.9+ 运行随附脚本，无需修改 Agent 的 MCP 配置。
3. 选择脚本时，把以下路径替换成 LoFold 设置复制出的 MCP 配置里的 `command`。如果 Agent 每次都在同一命令行环境启动，可在那里设置 `LOFOLD_MCP_COMMAND`，以后调用脚本便可省略路径参数。

   ```sh
   python3 ~/.agents/skills/lofold/scripts/lofold.py \
     --command "/Applications/LoFold.app/Contents/MacOS/lofold-client" status
   ```

4. 状态返回 `"enabled": true` 后，可试「在 LoFold 的归档里打开搜索‘日落音乐会’」或「给 demo@example.test 写一封确认周五会议的草稿，打开给我审阅」。

Skill 和 MCP 复用同一套本机授权。搜索结果在 LoFold 查看。邮件正文须经逐封共享才能读给 Agent。草稿交回 LoFold，由你审阅并发送。退出应用或关闭 Agent MCP 会解除本次连接。完整权限和工具说明见 [Agent MCP](../16-Agent-MCP.md)。 [LoFold 项目主页](https://trsoliu.github.io/lofold/#agent)
