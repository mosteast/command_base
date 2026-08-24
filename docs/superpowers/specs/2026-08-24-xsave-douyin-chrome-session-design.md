# xsave_douyin Chrome Session Persistence Design

## Summary

`xsave_douyin` 的 headed Chrome 会话改为复用本机固定 user-data 目录，而不是每次复制到临时目录并在关闭后删除。第一次从日常 Chrome 的 Douyin profile 播种到 `Default/`，之后保留登录、cookie 和验证状态。

## Goals

- 第二次及以后打开 headed Chrome 时，沿用上次会话的登录状态，不必重新登录。
- 第一次从日常 Chrome Douyin profile 拷贝登录材料，尽量第一次就已登录。
- 不读写、不锁定日常 Chrome 的 user-data。
- 不新增 CLI flag；现有 `xsave_douyin` 调用方式不变。

## Non-goals

- 不改 cookie-only headless 路径，也不改 CDP 优先挂接（调试端口开着仍先 `connectOverCDP`）。
- 不把 Chrome profile 放到 iCloud `DEFAULT_STATE_DIR` 或仓库 `tmp/`。
- 不新增 `--refresh-profile`。要重新播种：删除专用目录。
- 不启动日常 Chrome，不修改 gather runtime 的 `chrome_profile` 语义。

## Recommended approach

**固定本机 user-data + 首次播种到 `Default/`**。

Why:

- Playwright `launchPersistentContext(userDataDir)` 把 `userDataDir` 当作 Chrome user-data 根目录，真正用的 profile 是 `userDataDir/Default/`。
- 现在把日常 profile 文件拷到 user-data **根目录**，Chrome 会新建空的 `Default/`，日常 cookie 用不上。
- 关闭后删除临时拷贝，本次登录也不会留下。
- 固定目录 + 正确的 `Default/` 布局同时修掉这两处。

## Alternatives considered

### 1. 把上次临时目录留在 `/tmp`

Pros: 改动面更小。  
Cons: 系统清理或重启后登录丢失，不符合「保留上次状态」。

### 2. 只持久化 cookie / `storageState`

Pros: 目录更小。  
Cons: 验证码、本地存储、fingerprint 仍会丢；headed 窗口还是像新浏览器。

## Default path

| Role | Path |
|------|------|
| 专用 user-data | `~/Library/Application Support/command_base/xsave_douyin/chrome` |
| 播种源 | gather runtime / `--chrome-profile` 解析出的日常 Chrome profile 目录 |
| 测试覆盖 | 调用方传入 `persistent_user_data_dir`，不写真实 Application Support |

目录由 `os.homedir()` 拼出，不写死用户名。

## Session flow

`open_session` 顺序不变：CDP → persistent → cookie-only。

Persistent 路径改为：

1. 解析日常 Chrome profile 源目录（现有 `resolve_profile_source_dir`）。源目录不存在则失败，提示与现在相同。
2. 解析专用 user-data：`persistent_user_data_dir` 或默认 Application Support 路径。
3. 若 `user-data/Default` 尚不存在：把源 profile 拷到 `user-data/Default/`。跳过 Cache / Code Cache / GPUCache / OptimizationGuide，以及 `SingletonLock` / `SingletonCookie` / `SingletonSocket`。
4. 若 `user-data/Default` 已存在：不覆盖。
5. 启动前删除 user-data 根目录残留的 Singleton lock 文件。
6. `launchPersistentContext(user-data, …)`，启动选项保持现状（headed、`channel: "chrome"`、`chromiumSandbox: true`）。
7. `close()` 只关 context，不删除专用目录。启动失败也不删除该目录。

重新播种：手动删除专用 user-data 目录，下次运行会再次从日常 Chrome profile 拷贝。

## Error handling

- 源 profile 缺失：保持现有 `chrome profile directory missing`，不创建空专用目录冒充已播种。
- 专用目录被锁或上次异常退出：启动前清掉 Singleton lock，然后只启动一次；失败则抛出 Playwright 错误，保留目录。
- 不打印 cookie 值。

## Testing

扩展 `test/xsave_douyin_chrome_client.test.js`，用临时目录注入 `persistent_user_data_dir` 和 `profile_source_dir`：

- 首次打开：`launchPersistentContext` 的 user-data 是专用目录，源 profile 的 `Preferences` 出现在 `user-data/Default/Preferences`，不在 user-data 根目录。
- 再次打开：不覆盖已有 `Default`（测试先放哨兵文件，断言仍在）。
- `close()` 之后专用目录仍在。
- 启动失败之后专用目录仍在。
- headed 启动仍带 `chromiumSandbox: true`，`args` 不含 `--no-sandbox`。
- CDP 可用时仍不走拷贝/播种。

不新增 CLI 测试：帮助文本和 flag 不变。调用方无需改命令。

## Implementation notes

- 主要改 `lib/xsave_douyin/chrome_client.js` 与对应测试。
- 两个及以上仓库源文件 → 任务分支 + 隔离 worktree，完成后合回原分支。
- 不加依赖。
