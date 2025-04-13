# SillyTavern 数据同步插件

这个插件允许你使用 Git 来同步 SillyTavern 的 `/data` 目录，方便在多个设备间共享角色、聊天记录和设置。

## 功能

- 使用 GitHub 仓库同步数据
- 一键上传/下载数据
- 支持 GitHub OAuth 授权和个人访问令牌认证
- 自动定时同步功能
- 美观现代的用户界面
- 显示详细的 Git 状态信息
- 查看最近的提交历史

## 安装

1. 确保你已经在系统上安装了 [Git](https://git-scm.com/downloads)。
2. 将此插件目录 (`data-sync`) 放入 SillyTavern 的 `plugins` 文件夹。
3. 在 SillyTavern 的 `config.yaml` 文件中，确保 `enableServerPlugins: true`。
4. 在插件目录中安装依赖：
   ```bash
   cd plugins/data-sync
   npm install
   ```
5. 重启 SillyTavern 服务器。

## 配置 GitHub 仓库

使用前，您需要创建一个 GitHub 仓库：

1. 在 [GitHub](https://github.com) 上创建一个新的仓库。强烈建议将仓库设置为**私有**，以保护您的数据隐私。
2. 在插件界面中输入仓库 URL，格式为 `https://github.com/用户名/仓库名.git` 或 `git@github.com:用户名/仓库名.git`。

## GitHub 授权

插件提供两种授权方式：

### 1. GitHub OAuth 授权 (推荐)

1. 在插件界面中点击 "通过 GitHub 授权" 按钮。
2. 在弹出的新窗口中登录 GitHub 并授权应用。
3. 授权成功后，窗口将自动关闭，插件状态将更新为 "已授权"。

> **注意**：首次使用前，管理员需要创建 GitHub OAuth 应用，并在插件配置中设置 Client ID 和 Client Secret。
> 详见下方 "管理员配置" 部分。

### 2. 个人访问令牌 (PAT)

如果不想使用 OAuth 授权，您也可以使用个人访问令牌：

1. 访问 [GitHub 个人访问令牌设置页面](https://github.com/settings/tokens/new?scopes=repo&description=SillyTavern%20Data%20Sync)。
2. 确保选择了 `repo` 权限。
3. 生成令牌并复制。
4. 将令牌粘贴到插件界面的 "访问令牌" 输入框中。
5. 点击 "保存配置" 按钮。

## 使用方法

1. 启动 SillyTavern 后，访问 `http://localhost:YOUR_PORT/api/plugins/data-sync/ui`。
2. 在配置面板中：
   - 输入您的 GitHub 仓库 URL
   - 选择并完成授权方式（OAuth 或访问令牌）
   - 如需自动同步，勾选 "启用自动同步" 并设置同步间隔
3. 点击 "保存配置"，然后点击 "初始化仓库"。
4. 使用 "上传" 按钮将数据推送到 GitHub，或使用 "下载" 按钮拉取最新的更改。

## 管理员配置

### GitHub OAuth 应用设置

要启用 OAuth 授权功能，管理员需要：

1. 在 [GitHub 开发者设置](https://github.com/settings/developers) 中创建一个新的 OAuth 应用。
2. 设置主页 URL 为您的 SillyTavern 地址（如 `http://localhost:8000`）。
3. 设置回调 URL 为 `http://您的域名/api/plugins/data-sync/oauth-callback`。
4. 获取 Client ID 和 Client Secret。
5. 设置环境变量或修改插件代码中的这些值：
   ```
   GITHUB_CLIENT_ID=您的客户端ID
   GITHUB_CLIENT_SECRET=您的客户端密钥
   OAUTH_REDIRECT_URI=http://您的域名/api/plugins/data-sync/oauth-callback
   ```

## 注意事项

- 首次使用时，确保 `/data` 目录中的数据已备份，以防意外覆盖。
- 合并冲突：如果在不同设备上同时修改了同一文件，可能会发生合并冲突。此时可能需要手动解决冲突。
- 大文件：避免同步大型二进制文件（如音频、图像），以保持仓库大小合理。
- 安全考虑：访问令牌具有访问您 GitHub 帐户的权限，请妥善保管。建议仅给予必要的最小权限。

## 隐私与安全

- 此插件仅同步 SillyTavern 的 `/data` 目录。
- 建议使用私有 GitHub 仓库，以保护您的数据隐私。
- OAuth 授权和访问令牌都受到保护，存储在服务器端的配置文件中，不会暴露给浏览器。
- 敏感信息（如 API 密钥）不应存储在同步的文件中。

## 未来计划

- 支持更多同步服务提供商（如 Dropbox、Google Drive）
- 完善定时自动同步功能
- 添加文件选择性同步功能
- 实现分支管理和冲突解决
- 支持多用户授权

## 许可证

本插件采用 MIT 许可证。

## 问题反馈

如有问题或建议，请在 GitHub 仓库中创建 issue。 