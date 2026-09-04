# Engine API v1

除健康检查和配对接口外，请求使用：

```http
Authorization: Bearer tae_xxx
```

## 系统与配对

- `GET /v1/health`
- `POST /v1/pair`
- `GET /v1/info`
- `GET /v1/capabilities`

## 任务和文档

- `GET /v1/tasks`
- `POST /v1/tasks`
- `PATCH /v1/tasks/:id`
- `DELETE /v1/tasks/:id`
- `GET /v1/tasks/:id/documents/:kind`
- `PUT /v1/tasks/:id/documents/:kind`
- `GET /v1/tasks/:id/todos`
- `POST /v1/tasks/:id/todos`
- `PATCH /v1/tasks/:id/todos/:todoId`
- `DELETE /v1/tasks/:id/todos/:todoId`

`kind` 支持 `technical`、`readme` 和 `agent`。

## 终端

- `POST /v1/terminal-sessions`
- `WS /v1/terminal-sessions/:sessionId/stream?ticket=...`

## Token 管理

Token 列表、创建和撤销需要 `owner` 角色：

- `GET /v1/tokens`
- `POST /v1/tokens`
- `DELETE /v1/tokens/:id`
