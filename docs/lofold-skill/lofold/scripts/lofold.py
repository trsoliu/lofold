# SPDX-License-Identifier: Apache-2.0
"""Call LoFold's local MCP tools without registering an MCP server in the Agent."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys


PROTOCOL = "2025-11-25"
MAX_MESSAGE = 3 * 1024 * 1024
MAX_INPUT = 1024 * 1024 - 1024
TIMEOUT = 10
TOOLS = (
    "lofold_status",
    "lofold_open_search",
    "lofold_list_shared_mail",
    "lofold_read_shared_mail",
    "lofold_create_draft",
    "lofold_update_draft",
    "lofold_open_draft",
)


class LoFoldError(Exception):
    """A LoFold or MCP error with a message that can be shown to the user."""


async def send(process, method, params=None, request_id=None):
    message = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        message["params"] = params
    if request_id is not None:
        message["id"] = request_id
    frame = json.dumps(message, ensure_ascii=False, allow_nan=False).encode() + b"\n"
    process.stdin.write(frame)
    await process.stdin.drain()


async def request(process, request_id, method, params):
    await send(process, method, params, request_id)
    while line := await process.stdout.readline():
        response = json.loads(line)
        if not isinstance(response, dict) or response.get("jsonrpc") != "2.0":
            raise LoFoldError("LoFold 返回了无效的 MCP 消息。")
        if response.get("id") != request_id:
            continue
        if "error" in response or not isinstance(response.get("result"), dict):
            raise LoFoldError("LoFold 拒绝了 MCP 请求。请核对当前版本的工具和参数。")
        return response["result"]
    raise LoFoldError("LoFold MCP 已退出。请核对「设置 → Agent MCP」中复制的路径。")


async def connect(process, method, params):
    info = await asyncio.wait_for(
        request(process, 1, "initialize", {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": {"name": "lofold-skill", "version": "1"},
        }),
        TIMEOUT,
    )
    if (
        info.get("protocolVersion") != PROTOCOL
        or info.get("serverInfo", {}).get("name") != "lofold"
        or "tools" not in info.get("capabilities", {})
    ):
        raise LoFoldError("该可执行文件未提供兼容的 LoFold MCP 工具。")
    await send(process, "notifications/initialized")
    result = await asyncio.wait_for(request(process, 2, method, params), TIMEOUT)
    if result.get("isError"):
        for entry in result.get("content", []):
            if entry.get("type") == "text" and isinstance(entry.get("text"), str):
                raise LoFoldError(entry["text"])
        raise LoFoldError("LoFold 无法完成该操作。")
    return result.get("structuredContent", result)


async def run(command, method, params):
    process = await asyncio.create_subprocess_exec(
        str(command), "--mcp",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, limit=MAX_MESSAGE,
    )
    try:
        return await connect(process, method, params)
    finally:
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 1)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.stdout.read()
            await process.wait()


def parse_arguments(read_stdin):
    if not read_stdin:
        return {}
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise LoFoldError("工具参数超过大小上限。")
    arguments = json.loads(raw)
    if not isinstance(arguments, dict):
        raise LoFoldError("工具参数须为 JSON 对象。")
    return arguments


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--command", default=os.environ.get("LOFOLD_MCP_COMMAND"),
                        help="从 LoFold MCP 设置中复制的 command 绝对路径")
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("status", help="检查连接")
    actions.add_parser("tools", help="列出工具和参数")
    call = actions.add_parser("call", help="调用 LoFold 工具")
    call.add_argument("tool", choices=TOOLS)
    call.add_argument("--args-stdin", action="store_true", help="从标准输入读取 JSON 参数")
    args = parser.parse_args()

    try:
        if sys.platform != "darwin":
            raise LoFoldError("请在运行 LoFold 的同一台 Mac 上执行本脚本。")
        if not args.command:
            raise LoFoldError("请在 LoFold 设置中复制 Agent MCP 配置，并用 --command 提供 command 路径。")
        command = Path(args.command).expanduser()
        if (
            not command.is_absolute()
            or command.name != "lofold-client"
            or not command.is_file()
            or not os.access(command, os.X_OK)
        ):
            raise LoFoldError("LoFold command 须指向已安装的可执行文件。请重新复制配置。")

        if args.action == "tools":
            result = asyncio.run(run(command, "tools/list", {}))
        else:
            tool = "lofold_status" if args.action == "status" else args.tool
            arguments = parse_arguments(getattr(args, "args_stdin", False))
            result = asyncio.run(run(command, "tools/call", {"name": tool, "arguments": arguments}))
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0
    except LoFoldError as error:
        print(f"LoFold: {error}", file=sys.stderr)
    except asyncio.TimeoutError:
        print("LoFold: 等待 MCP 响应超时。请先在 LoFold 核对操作结果，再决定是否重试。", file=sys.stderr)
    except (ValueError, OSError):
        print("LoFold: 无法运行本机 MCP 或解析消息。请核对路径、版本和 JSON 参数。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
