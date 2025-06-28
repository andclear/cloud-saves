# 老婆包存档插件 (Laopobao Save)

一个专为 SillyTavern 设计的老婆包数据管理插件，通过压缩包恢复功能轻松管理你的角色数据。

## 🎀 插件简介

老婆包存档插件是一个全新的 SillyTavern 插件，专门用于管理和恢复老婆包（角色包）数据。与传统的 Git 版本控制不同，本插件采用压缩包的方式来存储和恢复数据，操作更简单，更适合普通用户使用。

## ✨ 主要功能

### 📦 压缩包管理
- **下载压缩包**：从 GitHub 仓库下载 ZIP/TAR.GZ 格式的压缩包
- **自动解压**：支持 ZIP 和 TAR.GZ 格式的自动解压缩
- **数据恢复**：将压缩包内容恢复到 SillyTavern 数据目录
- **文件管理**：列出、删除、重命名压缩包文件
- **信息查看**：查看压缩包的详细信息（大小、修改时间等）

### 💾 本地备份
- **自动备份**：在恢复数据前自动创建本地备份
- **备份管理**：列出、恢复、删除本地备份
- **安全保障**：确保数据恢复过程的安全性

### ⚙️ 配置管理
- **GitHub 集成**：配置 GitHub Token 和仓库地址
- **权限验证**：验证 GitHub 访问权限
- **状态监控**：实时显示插件和仓库状态

## 🚀 安装指南

### 前置要求

1. **Node.js 环境**
   - 安装 Node.js (推荐 LTS 版本)
   - 确保 npm 可用

2. **SillyTavern 配置**
   - 在 `config.yaml` 中启用插件支持：
   ```yaml
   enableServerPlugins: true
   enableServerPluginsAutoUpdate: false
   ```

### 安装步骤

1. **下载插件**
   ```bash
   cd SillyTavern/plugins
   git clone https://github.com/your-username/sillytarven-laopobao-save.git
   ```

2. **安装依赖**
   ```bash
   cd sillytarven-laopobao-save
   npm install
   ```

3. **重启 SillyTavern**
   - 关闭当前 SillyTavern 服务
   - 重新启动 SillyTavern

## 🔧 配置说明

### GitHub 配置

1. **创建 GitHub 仓库**
   - 在 GitHub 上创建一个新仓库（建议设为私有）
   - 复制仓库的 HTTPS URL

2. **生成访问令牌**
   - 访问 GitHub [个人访问令牌](https://github.com/settings/tokens) 页面
   - 生成新的 Classic Token
   - 授予 `repo` 权限
   - 复制并保存生成的令牌

3. **插件配置**
   - 打开插件界面：`http://localhost:8000/api/plugins/laopobao-save/ui`
   - 填写 GitHub Token 和仓库 URL
   - 点击「保存配置」
   - 点击「授权验证」

## 📖 使用教程

### 基本操作

1. **查看系统状态**
   - 在插件界面查看授权状态
   - 确认仓库连接正常
   - 检查本地备份情况

2. **管理压缩包**
   - 点击「刷新列表」查看可用的压缩包
   - 选择压缩包进行恢复、重命名或删除操作
   - 使用「从压缩包恢复」功能恢复特定文件

3. **备份管理**
   - 查看本地备份列表
   - 从备份恢复数据
   - 删除不需要的备份

### 数据恢复流程

1. **选择数据源**
   - 从 GitHub 仓库的压缩包恢复
   - 从本地备份恢复

2. **执行恢复**
   - 系统自动创建当前数据的备份
   - 下载并解压缩数据包
   - 将数据恢复到 SillyTavern 目录

3. **验证结果**
   - 检查恢复状态
   - 确认数据完整性

## 🛡️ 安全特性

- **自动备份**：每次恢复前自动备份当前数据
- **权限验证**：严格的 GitHub 访问权限验证
- **错误处理**：完善的错误处理和回滚机制
- **数据校验**：压缩包完整性验证

## 📁 支持的文件格式

- **ZIP 格式**：标准的 ZIP 压缩包
- **TAR.GZ 格式**：Gzip 压缩的 TAR 包
- **自动识别**：根据文件扩展名自动选择解压方式

## 🔍 故障排除

### 常见问题

1. **插件无法启动**
   - 检查 Node.js 是否正确安装
   - 确认 `npm install` 执行成功
   - 验证 SillyTavern 配置文件

2. **GitHub 连接失败**
   - 检查网络连接
   - 验证 Token 权限和有效性
   - 确认仓库 URL 正确

3. **数据恢复失败**
   - 检查压缩包格式是否支持
   - 确认磁盘空间充足
   - 查看错误日志信息

### 日志查看

插件运行时会在控制台输出详细的日志信息，包含 `[laopobao-save]` 标识，可用于问题诊断。

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支
3. 提交更改
4. 发起 Pull Request

## 📄 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE) 文件。

## 🙏 致谢

感谢 SillyTavern 社区的支持和贡献！

---

**注意**：使用本插件前请务必备份重要数据，数据恢复操作会覆盖现有文件。
