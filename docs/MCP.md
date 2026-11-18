# MCP（可选）

合议内置一个可选的 MCP stdio 客户端。默认关闭；不随应用安装任何 MCP server，也不启动 Windows-MCP。

## 设计边界

- `mcp.enabled` 必须是显式 `true`，否则 Agent 不会启动任何子进程。
- `servers` 是显式白名单；`command` + `args` 直接 `spawn`，不经过 shell。
- 服务端进程继承当前环境变量；需要额外变量时用 `env`，不要把密钥写进公开配置。
- `readOnly: true` 的 server 才允许在「只读」权限下暴露工具；其他 server 在只读模式完全不可见。
- MCP 工具仍经过 Agent 的权限/审计链；不改变 `readOnly` 的强制边界。
- 每个 Agent 任务结束时关闭 MCP 子进程；不会常驻后台。

## 配置

```json
{
  "mcp": {
    "enabled": true,
    "timeoutMs": 20000,
    "servers": [
      {
        "id": "local-tools",
        "label": "Local tools",
        "command": "node",
        "args": ["C:/path/to/your-mcp-server.mjs"],
        "cwd": "C:/path/to",
        "enabled": true,
        "readOnly": false,
        "env": {}
      }
    ]
  }
}
```

`examples/config.example.json` 里默认是 `enabled: false`，不会启动任何东西。

## 接 Windows-MCP

Windows-MCP 是第三方 MIT Python 项目，不是本项目依赖。它要求 Python 3.14，且具备完整桌面控制能力；请自行阅读其 README，确认实际启动入口（不同版本可能不是同一个命令/模块），并先用它的帮助命令跑通。

示例只展示**形状**，不要照抄一个未验证的 `command`：

```json
{
  "mcp": {
    "enabled": true,
    "servers": [
      {
        "id": "windows-mcp",
        "label": "Windows-MCP",
        "command": "C:/path/to/python.exe",
        "args": ["-m", "windows_mcp"],
        "enabled": false,
        "readOnly": false
      }
    ]
  }
}
```

确认入口后，再把 `enabled` 改成 `true`。不建议把 Windows-MCP 默认开启，也不建议给它加 `readOnly: true` 后仍允许写操作——`readOnly` 只是给合议 Agent 的准入标记，不是 Windows-MCP 自身的安全沙盒。

## 测试

内置测试使用一个假 MCP server，验证：

- `initialize` / `tools/list` / `tools/call`
- 只读模式过滤非 `readOnly` server
- 显式 `readOnly: true` 才允许只读调用
- 任务结束关闭子进程
