# SillyTavern 云存档插件

## 概述

此插件让你能够将 SillyTavern 的 `/data` 目录（包含角色、聊天记录等）保存到你自己的 GitHub 仓库中，实现云端存档和版本管理。

## 功能

- **创建云存档**: 保存当前 `/data` 目录的状态。
- **加载云存档**: 将 `/data` 目录恢复到之前的某个存档点。
- **管理云存档**: 列出、重命名、删除、比较云存档。
- **定时自动存档**: 可配置自动将当前状态覆盖到指定的云存档。

## 安装

**前提: 启用插件加载**

确保你的 SillyTavern `config.yaml` 文件中设置了 `enableServerPlugins: true`。

**安装方式 (任选其一):**

1.  **下载压缩包**:
    *   下载此插件的 `.zip` 压缩包。
    *   解压压缩包。
    *   将解压后的 `cloud-saves` 文件夹放入 SillyTavern 根目录下的 `plugins` 文件夹内。

2.  **使用 Git Clone**:
    *   打开你的终端或命令行工具。
    *   进入 SillyTavern 根目录下的 `plugins` 文件夹 (`cd path/to/SillyTavern/plugins`)。
    *   执行命令: `git clone https://github.com/fuwei99/cloud-saves.git`

**最后**: 重启 SillyTavern 服务。

## 配置

1.  **打开插件界面**: 在 SillyTavern 界面左侧菜单找到 "Plugins" (或 "插件")，点击进入，然后选择 "Cloud Saves"。
2.  **准备 GitHub 仓库**:
    *   在 GitHub 上创建一个新的**私有**仓库（推荐）。你**不需要**预先在里面放任何文件。
    *   复制这个仓库的 URL (例如 `https://github.com/your-username/your-repo-name`)。
3.  **创建 GitHub 令牌**:
    *   前往 GitHub [个人访问令牌](https://github.com/settings/tokens) 页面。
    *   创建一个新令牌 (Classic 或 Fine-grained 均可)。
    *   授予令牌**至少 `repo` 权限**（或者对你刚创建的仓库的读写权限）。
    *   **复制生成的令牌** (只会显示一次)。
4.  **授权插件**:
    *   在插件界面的"仓库授权设置"部分：
        *   粘贴你的**仓库 URL**。
        *   粘贴你生成的 **GitHub 访问令牌**。
        *   (可选) 输入一个**显示名称**，用于记录操作人。
        *   (可选) 设置用于存档的**分支**名称 (默认为 `main`)。
        *   点击**配置**按钮保存设置。
        *   点击**授权并连接**按钮。
    *   成功后会显示授权成功提示。

## 使用

授权成功后，你可以：

- **创建新存档**: 在"创建新存档"区域输入名称和描述，点击"保存当前状态"。
- **加载存档**: 在"存档列表"中找到存档，点击 <i class="bi bi-cloud-download"></i> (加载) 按钮。
- **编辑/重命名存档**: 点击 <i class="bi bi-pencil"></i> 按钮。
- **覆盖存档**: 点击 <i class="bi bi-upload"></i> 按钮，用当前本地数据覆盖云端存档（标签名不变）。
- **删除存档**: 点击 <i class="bi bi-trash"></i> 按钮。
- **比较差异**: 点击 <i class="bi bi-file-diff"></i> 按钮查看与当前本地状态的差异。
- **定时存档**: 在"定时自动存档设置"区域配置并启用。

## 注意

- 需要你的服务器环境已安装 Git。
- 操作需要网络连接 GitHub。

## 技术细节

- **后端**：Node.js, Express.js
- **核心逻辑**：通过 `child_process` 执行 Git 命令
- **前端**：HTML, CSS (Bootstrap 5), JavaScript

---

*由 AI 助手协助创建* 