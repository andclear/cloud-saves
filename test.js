const plugin = require('./index.js');
const express = require('express');

// 创建测试服务器
const app = express();
app.use(express.json());

// 初始化插件
const router = express.Router();
plugin.init(router);
app.use('/api/plugins/cloud-saves', router);

// 启动测试服务器
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`[test] 测试服务器启动在端口 ${PORT}`);
    console.log(`[test] 插件信息:`, plugin.info);
    console.log(`[test] 访问 http://localhost:${PORT}/api/plugins/cloud-saves/config 测试配置接口`);
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n[test] 正在关闭测试服务器...');
    process.exit(0);
});