# dsh-oai-oauth

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加 OpenAI ChatGPT Plus/Pro OAuth 登录和 GPT/Codex 模型支持。

安装后，DSH 设置界面会出现独立的 **OpenAI OAuth** 页面。点击一次“使用浏览器登录”，完成授权后即可选择模型和推理强度，并把它保存为新会话的默认模型。

> [!IMPORTANT]
> 这是 **ChatGPT 订阅 OAuth**。模型请求发送到 `https://chatgpt.com/backend-api/codex`，不是任意 OpenAI-compatible API 的通用 OAuth。公共 OpenAI API 仍使用 API Key 或官方支持的 workload identity token。

## 安装

### 从 npm 安装

```sh
dsh plugin --profile web add -w @kevensun/dsh-oai-oauth
dsh web
```

### 从源码安装

克隆仓库并安装到本地 DSH profile：

```sh
git clone https://github.com/kvenux/dsh-oai-oauth.git
cd dsh-oai-oauth
pnpm install
dsh plugin --profile web add -w ../dsh-oai-oauth
dsh web
```

`pnpm install` 是必需步骤。本地路径安装使用 `link:` 链接，`dsh plugin add` 不会进入源码目录安装依赖。安装依赖时会自动执行本项目的 `prepare` 脚本并完成构建，因此首次安装不需要再单独运行 `pnpm run build`。

修改源码后，重新执行 `pnpm run build` 并重启 `dsh web` 即可验证改动。

### 从 GitHub 安装

```sh
dsh plugin --profile web add -w github:kvenux/dsh-oai-oauth
dsh web
```

GitHub 依赖会从源码执行 `prepare` 构建。pnpm 10+ 第一次会拒绝未授权的安装脚本；按 DSH 输出的提示，在该 profile 的 `pnpm-workspace.yaml` 中加入：

```yaml
allowBuilds:
  "@kevensun/dsh-oai-oauth": true
```

然后重新执行 `dsh plugin ... add`。这项授权允许依赖在安装时执行本机代码，因此建议安装前检查源码。

请使用带 `@kevensun` scope 的 npm 包。无 scope 的同名包由其他维护者发布，不是本项目的分发渠道。

## 使用

1. 启动 `dsh web` 并打开 Web UI。
2. 打开 Settings → OpenAI OAuth。
3. 如需代理，打开“插件代理”。启用开关会立即保存；修改代理地址后点击“保存代理设置”。重新打开设置页或重启 DSH 后，页面会从持久化配置重新读取开关和地址。
4. 点击“使用浏览器登录”。插件先打开一个同源的“正在准备 OpenAI 登录”页面，再跳转到 OpenAI 授权页；PKCE 回调监听 `localhost:1455`。如果浏览器阻止自动跳转，设置页和过渡页都会保留可点击的授权链接。
5. 完成 ChatGPT 授权。设置页会自动更新为已连接。
6. 选择 GPT/Codex 模型和推理强度，点击“设为默认模型”。

插件代理只作用于 OAuth 授权码交换、token 刷新和 Codex 模型请求；它不设置 `HTTP_PROXY`、`HTTPS_PROXY` 或 Node 全局 dispatcher，因此不会改变 DSH Web 和其他插件的网络。开启代理后模型请求固定使用 SSE，以避免 WebSocket 绕过逐请求代理。浏览器中的 OpenAI 登录页仍使用浏览器自身的网络设置。

代理配置保存在 `$DSH_HOME/settings.yaml` 的 `oai-oauth` 命名空间。页面中的开关状态以 Host 返回值为准，不依赖浏览器本地存储。

登录成功后，插件通过同一 OAuth 凭据读取当前 ChatGPT 账号的 Codex 模型目录，并使用服务端返回的 reasoning effort；设置页的“刷新模型目录”可以强制重新读取。网络不可用时回退到随插件安装的 `@earendil-works/pi-ai` catalog。现有会话保留原有模型；默认选择用于之后创建的新会话。

## 凭据与安全

- Access token、refresh token 和过期时间作为一个 JSON 文档存入 DSH credentials 的 `DSH_OAI_OAUTH` 引用；设置 API 和浏览器从不读取 token。
- `pi-ai` 在模型请求前检查过期时间，在 DSH 进程内串行刷新并持久化轮换后的 refresh token。
- 登录使用 Authorization Code + PKCE、随机 state 和 loopback 回调；插件不要求用户复制 token。
- 设置页的状态修改请求要求自定义 header，使其他站点对本机端口发起请求时必须通过 CORS preflight。
- 点击“断开连接”会取消正在进行的登录并删除 DSH 管理的 OAuth credential。

该凭据仍应视为高价值 secret。不要提交 `$DSH_HOME/.credentials.yaml`，也不要把其内容贴进 issue 或日志。

## 目录结构

```text
dsh-oai-oauth/
├── package.json          # npm exports、dsh.bundle、dsh.client
├── cordis.patch.yml      # 安装到 profile 的两个 Cordis 条目
├── tsdown.config.ts      # Node 插件和浏览器 client bundle
├── src/
│   ├── index.ts          # OAuth service 与 LLM adapter 注册
│   ├── adapter.ts        # DSH message/stream ↔ pi-ai Codex Responses
│   ├── credential-store.ts
│   ├── oauth-service.ts
│   ├── openai-oauth.ts   # 支持独立 fetch 的 PKCE OAuth
│   ├── proxy.ts          # 插件级代理设置与 dispatcher
│   ├── web.ts            # 不返回 secret 的同源设置 API
│   └── client/index.tsx  # OpenAI OAuth 设置页
└── tests/
```

`cordis.patch.yml` 同时加载根插件和 `/web` 插件。根插件只依赖 DSH 的 LLM 与 credentials capability；Web 条目等到 Web server 与默认模型服务就绪后再注册设置接口。因此同一个 bundle 也可以装进没有 Web UI 的组合中，只是无法从界面发起登录。

## 开发

```sh
pnpm install
pnpm run check
```

本项目没有自动登录、也不会在测试中访问真实 OpenAI 账号。真实登录和模型请求需要用户在自己的 DSH 实例中主动完成。
