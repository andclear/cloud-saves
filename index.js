const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const zlib = require('zlib');
const { Octokit } = require('@octokit/rest');
const yauzl = require('yauzl');
const tar = require('tar-stream');
const archiver = require('archiver');

let fetch;
try {
    import('node-fetch').then(module => {
        fetch = module.default;
    }).catch(() => {
        fetch = require('node-fetch');
    });
} catch (error) {
    console.error('无法导入node-fetch:', error);
    fetch = async (url, options) => {
        const https = require('https');
        const http = require('http');
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.request(url, options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        json: async () => JSON.parse(data)
                    });
                });
            });
            req.on('error', reject);
            if (options && options.body) req.write(options.body);
            req.end();
        });
    };
}

const info = {
    id: 'st-laopobao-save',
    name: 'ST-Laopobao-Save',
    description: 'ST-Laopobao-Save plugin for SillyTavern, manage character data through compressed archives.',
    version: '2.0.0',
};

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(process.cwd(), 'data');
const DEFAULT_BRANCH = 'main';

const DEFAULT_CONFIG = {
    repo_url: '',
    username: '',
    github_token: '',
    display_name: '',
    is_authorized: false,
    last_restore: null,
    backup_before_restore: true,
    target_directory: 'default-user', // 'data' or 'default-user'
};

let autoSaveBackendTimer = null;

async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        const config = JSON.parse(data);
        config.backup_before_restore = config.backup_before_restore === undefined ? DEFAULT_CONFIG.backup_before_restore : config.backup_before_restore;
        config.target_directory = config.target_directory || DEFAULT_CONFIG.target_directory;
        return config;
    } catch (error) {
        console.warn('Failed to read or parse config, creating default:', error.message);
        await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return { ...DEFAULT_CONFIG };
    }
}

async function saveConfig(config) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function getOctokitInstance() {
    const config = await readConfig();
    if (!config.github_token) {
        throw new Error('GitHub token not configured');
    }
    return new Octokit({
        auth: config.github_token,
    });
}

function handleError(error, operation = 'Operation') {
    console.error(`[laopobao-save] ${operation} failed:`, error.message);
    return {
        success: false,
        message: `${operation} failed`,
        details: error.message || error.stack || 'Unknown error',
        error: error
    };
}

// GitHub API functions
async function parseRepoUrl(repoUrl) {
    const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) {
        throw new Error('Invalid GitHub repository URL');
    }
    return {
        owner: match[1],
        repo: match[2]
    };
}

async function listArchiveFiles() {
    try {
        const config = await readConfig();
        if (!config.repo_url || !config.github_token) {
            return { success: false, message: 'GitHub配置不完整' };
        }

        const octokit = await getOctokitInstance();
        const { owner, repo } = await parseRepoUrl(config.repo_url);

        console.log(`[laopobao-save] 获取仓库 ${owner}/${repo} 的文件列表`);
        const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: ''
        });

        const archiveFiles = data.filter(file => 
            file.type === 'file' && 
            (file.name.endsWith('.zip') || file.name.endsWith('.tar.gz'))
        ).map(file => ({
            name: file.name,
            size: file.size,
            download_url: file.download_url,
            sha: file.sha,
            updated_at: file.last_modified || new Date().toISOString()
        }));

        return {
            success: true,
            files: archiveFiles
        };
    } catch (error) {
        return handleError(error, '获取压缩包列表');
    }
}

// Archive download and extraction functions
async function downloadArchive(downloadUrl, filename) {
    try {
        console.log(`[laopobao-save] 下载压缩包: ${filename}`);
        const response = await fetch(downloadUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const tempDir = path.join(__dirname, 'temp');
        await fs.mkdir(tempDir, { recursive: true });
        const tempFilePath = path.join(tempDir, filename);

        const buffer = await response.arrayBuffer();
        await fs.writeFile(tempFilePath, Buffer.from(buffer));

        console.log(`[laopobao-save] 压缩包下载完成: ${tempFilePath}`);
        return tempFilePath;
    } catch (error) {
        throw new Error(`下载压缩包失败: ${error.message}`);
    }
}

async function extractZip(zipPath, targetDir) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                const entryPath = path.join(targetDir, entry.fileName);
                
                if (/\/$/.test(entry.fileName)) {
                    // Directory entry
                    fs.mkdir(entryPath, { recursive: true }, (err) => {
                        if (err) return reject(err);
                        zipfile.readEntry();
                    });
                } else {
                    // File entry
                    fs.mkdir(path.dirname(entryPath), { recursive: true }, (err) => {
                        if (err) return reject(err);
                        
                        zipfile.openReadStream(entry, (err, readStream) => {
                            if (err) return reject(err);
                            
                            const writeStream = fs.createWriteStream(entryPath);
                            readStream.pipe(writeStream);
                            writeStream.on('close', () => zipfile.readEntry());
                            writeStream.on('error', reject);
                        });
                    });
                }
            });
            
            zipfile.on('end', () => resolve());
            zipfile.on('error', reject);
        });
    });
}

async function extractTarGz(tarGzPath, targetDir) {
    return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(tarGzPath);
        const gunzip = zlib.createGunzip();
        const extract = tar.extract();

        extract.on('entry', (header, stream, next) => {
            const entryPath = path.join(targetDir, header.name);
            
            if (header.type === 'directory') {
                fs.mkdir(entryPath, { recursive: true }, (err) => {
                    if (err) return reject(err);
                    stream.resume();
                    next();
                });
            } else if (header.type === 'file') {
                fs.mkdir(path.dirname(entryPath), { recursive: true }, (err) => {
                    if (err) return reject(err);
                    
                    const writeStream = fs.createWriteStream(entryPath);
                    stream.pipe(writeStream);
                    writeStream.on('close', next);
                    writeStream.on('error', reject);
                });
            } else {
                stream.resume();
                next();
            }
        });

        extract.on('finish', resolve);
        extract.on('error', reject);

        readStream.pipe(gunzip).pipe(extract);
    });
}

// Backup and restore functions
async function createBackup(targetDir) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = path.join(__dirname, 'backups', timestamp);
        await fs.mkdir(backupDir, { recursive: true });
        
        console.log(`[laopobao-save] 创建备份: ${targetDir} -> ${backupDir}`);
        await copyDirectory(targetDir, backupDir);
        
        return { success: true, backupPath: backupDir, timestamp };
    } catch (error) {
        throw new Error(`创建备份失败: ${error.message}`);
    }
}

async function copyDirectory(src, dest) {
    try {
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(src, { withFileTypes: true });
        
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                await copyDirectory(srcPath, destPath);
            } else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    } catch (error) {
        throw new Error(`复制目录失败: ${error.message}`);
    }
}

async function restoreFromArchive(archiveFile, targetDirectory) {
    try {
        console.log(`[laopobao-save] 开始恢复数据: ${archiveFile} -> ${targetDirectory}`);
        
        // 确定目标路径
        let targetPath;
        if (targetDirectory === 'data') {
            targetPath = DATA_DIR;
        } else if (targetDirectory === 'default-user') {
            targetPath = path.join(DATA_DIR, 'default-user');
        } else {
            throw new Error(`不支持的目标目录: ${targetDirectory}`);
        }
        
        // 创建备份
        const config = await readConfig();
        let backupInfo = null;
        if (config.backup_before_restore) {
            backupInfo = await createBackup(targetPath);
            console.log(`[laopobao-save] 已创建备份: ${backupInfo.backupPath}`);
        }
        
        // 下载压缩包
        const archivePath = await downloadArchive(archiveFile.download_url, archiveFile.name);
        
        // 解压到临时目录
        const tempExtractDir = path.join(__dirname, 'temp', 'extract');
        await fs.mkdir(tempExtractDir, { recursive: true });
        
        if (archiveFile.name.endsWith('.zip')) {
            await extractZip(archivePath, tempExtractDir);
        } else if (archiveFile.name.endsWith('.tar.gz')) {
            await extractTarGz(archivePath, tempExtractDir);
        } else {
            throw new Error('不支持的压缩包格式');
        }
        
        // 覆盖目标目录
        await fs.rm(targetPath, { recursive: true, force: true });
        await copyDirectory(tempExtractDir, targetPath);
        
        // 清理临时文件
        await fs.rm(path.join(__dirname, 'temp'), { recursive: true, force: true });
        
        // 更新配置
        config.last_restore = {
            archive: archiveFile.name,
            target: targetDirectory,
            timestamp: new Date().toISOString(),
            backup: backupInfo ? backupInfo.backupPath : null
        };
        await saveConfig(config);
        
        return {
            success: true,
            message: '数据恢复成功',
            backup: backupInfo
        };
    } catch (error) {
        throw new Error(`恢复失败: ${error.message}`);
    }
}

// Web routes and API endpoints
let currentOperation = null;

// Express app setup
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function deleteArchive(filename) {
    try {
        currentOperation = 'delete_archive';
        console.log(`[laopobao-save] 正在删除压缩包: ${filename}`);
        
        const config = await readConfig();
        const { owner, repo } = await parseRepoUrl(config.repo_url);
        const octokit = await getOctokitInstance();
        
        // 获取文件信息
        const { data: fileData } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: filename
        });
        
        // 删除文件
        await octokit.rest.repos.deleteFile({
            owner,
            repo,
            path: filename,
            message: `删除压缩包: ${filename}`,
            sha: fileData.sha
        });
        
        console.log(`[laopobao-save] 压缩包 ${filename} 删除成功`);
        return { success: true, message: '压缩包删除成功' };
    } catch (error) {
        return handleError(error, `删除压缩包 ${filename}`);
    } finally {
        currentOperation = null;
    }
}

async function renameArchive(oldFilename, newFilename) {
    try {
        currentOperation = 'rename_archive';
        console.log(`[laopobao-save] 正在重命名压缩包: ${oldFilename} -> ${newFilename}`);
        
        const config = await readConfig();
        const { owner, repo } = await parseRepoUrl(config.repo_url);
        const octokit = await getOctokitInstance();
        
        // 获取原文件内容
        const { data: fileData } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: oldFilename
        });
        
        // 创建新文件
        await octokit.rest.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: newFilename,
            message: `重命名压缩包: ${oldFilename} -> ${newFilename}`,
            content: fileData.content
        });
        
        // 删除原文件
        await octokit.rest.repos.deleteFile({
            owner,
            repo,
            path: oldFilename,
            message: `删除原压缩包: ${oldFilename}`,
            sha: fileData.sha
        });
        
        console.log(`[laopobao-save] 压缩包重命名成功: ${oldFilename} -> ${newFilename}`);
        return { success: true, message: '压缩包重命名成功', oldFilename, newFilename };
    } catch (error) {
        return handleError(error, `重命名压缩包 ${oldFilename} -> ${newFilename}`);
    } finally {
        currentOperation = null;
    }
}

async function getArchiveInfo(filename) {
    try {
        currentOperation = 'get_archive_info';
        console.log(`[laopobao-save] 获取压缩包信息: ${filename}`);
        
        const config = await readConfig();
        const { owner, repo } = await parseRepoUrl(config.repo_url);
        const octokit = await getOctokitInstance();
        
        const { data: fileData } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: filename
        });
        
        const fileInfo = {
            name: fileData.name,
            size: fileData.size,
            download_url: fileData.download_url,
            sha: fileData.sha,
            last_modified: fileData.last_modified || 'Unknown'
        };
        
        return {
            success: true,
            fileInfo: fileInfo
        };
    } catch (error) {
        return handleError(error, `获取压缩包信息 ${filename}`);
    } finally {
        currentOperation = null;
    }
}

async function getSystemStatus() {
    try {
        const config = await readConfig();
        
        const status = {
            configured: !!config.repo_url && !!config.github_token,
            last_restore: config.last_restore || null,
            backup_enabled: config.backup_before_restore || false,
            target_directory: config.target_directory || 'data'
        };
        
        return status;
    } catch (error) {
        console.error('获取系统状态时出错:', error);
        throw handleError(error, '获取系统状态');
    }
}

async function hasBackupFiles() {
    try {
        const backupDir = path.join(__dirname, 'backups');
        const stats = await fs.stat(backupDir).catch(() => null);
        if (!stats || !stats.isDirectory()) return false;
        
        const backupFiles = await fs.readdir(backupDir);
        return backupFiles.length > 0;
    } catch (error) {
        console.error('[laopobao-save] 检查备份文件时出错:', error);
        return false;
    }
}

async function checkBackupStatus() {
    try {
        const backupDir = path.join(__dirname, 'backups');
        const stats = await fs.stat(backupDir).catch(() => null);
        if (!stats || !stats.isDirectory()) {
            return { hasBackups: false, backups: [] };
        }
        
        const files = await fs.readdir(backupDir);
        const backupFiles = [];
        
        for (const file of files) {
            const filePath = path.join(backupDir, file);
            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
                backupFiles.push({
                    name: file,
                    path: filePath,
                    created: stats.birthtime,
                    size: stats.size
                });
            }
        }
        
        backupFiles.sort((a, b) => b.created - a.created);
        return { hasBackups: backupFiles.length > 0, backups: backupFiles };
    } catch (error) {
        console.error('[laopobao-save] 检查备份状态时出错:', error);
        return { hasBackups: false, backups: [], error: error.message };
    }
}

async function restoreFromBackup(backupPath) {
    try {
        console.log(`[laopobao-save] 正在从备份恢复: ${backupPath}`);
        
        const stats = await fs.stat(backupPath).catch(() => null);
        if (!stats) {
            return { success: false, message: '备份路径不存在' };
        }
        
        const config = await readConfig();
        let targetPath;
        if (config.target_directory === 'data') {
            targetPath = DATA_DIR;
        } else {
            targetPath = path.join(DATA_DIR, 'default-user');
        }
        
        // 恢复文件
        await copyDirectory(backupPath, targetPath);
        
        console.log(`[laopobao-save] 备份恢复成功: ${backupPath}`);
        return { success: true, message: '备份恢复成功' };
    } catch (error) {
        return handleError(error, `恢复备份 ${backupPath}`);
    }
}

async function deleteBackup(backupName) {
    try {
        const backupDir = path.join(__dirname, 'backups');
        const backupPath = path.join(backupDir, backupName);
        
        const stats = await fs.stat(backupPath).catch(() => null);
        if (!stats) {
            return { success: false, message: '备份不存在' };
        }
        
        await fs.rm(backupPath, { recursive: true, force: true });
        console.log(`[laopobao-save] 备份已删除: ${backupName}`);
        
        return { success: true, message: '备份删除成功' };
    } catch (error) {
        return handleError(error, `删除备份 ${backupName}`);
    }
}

// 自动保存功能已移除，因为新版本专注于压缩包恢复而非自动保存

// 自动保存定时器功能已移除

async function init(router) {
    console.log('[st-laopobao-save] Initializing ST-Laopobao-Save plugin (archive restore version)...');
        console.log('[st-laopobao-save] Plugin UI access URL (modify port if not 8000): http://127.0.0.1:8000/api/plugins/laopobao-save/ui');

    try {
        router.use('/static', express.static(path.join(__dirname, 'public')));
        router.use(express.json());
        router.get('/ui', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        router.get('/info', (req, res) => {
            res.json(info);
        });

        router.get('/config', async (req, res) => {
            try {
                const config = await readConfig();
                const safeConfig = {
                    repo_url: config.repo_url || '',
                    display_name: config.display_name || '',
                    is_authorized: config.is_authorized || false,
                    username: config.username || null,
                    backup_before_restore: config.backup_before_restore || true,
                    target_directory: config.target_directory || DATA_DIR,
                    has_github_token: !!config.github_token,
                };
                res.json(safeConfig);
            } catch (error) {
                res.status(500).json({ success: false, message: '读取配置失败', error: error.message });
            }
        });

        router.post('/config', async (req, res) => {
            try {
                const {
                    repo_url, github_token, display_name, is_authorized,
                    backup_before_restore, target_directory
                } = req.body;
                let currentConfig = await readConfig();

                currentConfig.repo_url = repo_url !== undefined ? repo_url.trim() : currentConfig.repo_url;
                if (github_token) {
                    currentConfig.github_token = github_token;
                }
                currentConfig.display_name = display_name !== undefined ? display_name.trim() : currentConfig.display_name;
                if (is_authorized !== undefined) {
                    currentConfig.is_authorized = !!is_authorized;
                }
                if (backup_before_restore !== undefined) {
                    currentConfig.backup_before_restore = !!backup_before_restore;
                }
                if (target_directory !== undefined) {
                    currentConfig.target_directory = target_directory.trim() || DATA_DIR;
                }

                await saveConfig(currentConfig);

                const safeConfig = {
                    repo_url: currentConfig.repo_url,
                    display_name: currentConfig.display_name,
                    is_authorized: currentConfig.is_authorized,
                    username: currentConfig.username,
                    backup_before_restore: currentConfig.backup_before_restore,
                    target_directory: currentConfig.target_directory
                };
                res.json({ success: true, message: '配置保存成功', config: safeConfig });
            } catch (error) {
                console.error('[laopobao-save] 保存配置失败:', error);
                res.status(500).json({ success: false, message: '保存配置失败', error: error.message });
            }
        });

        router.post('/authorize', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            currentOperation = 'authorize';
            try {
                const { repo_url, github_token, display_name } = req.body;
                if (!repo_url || !github_token) {
                    return res.status(400).json({ success: false, message: '需要提供仓库URL和GitHub Token' });
                }

                console.log('[laopobao-save] 开始授权过程...');
                const config = await readConfig();
                config.repo_url = repo_url;
                config.github_token = github_token;
                config.display_name = display_name || '';
                config.is_authorized = false;

                console.log('[laopobao-save] 验证GitHub Token...');
                const validationResponse = await fetch('https://api.github.com/user', {
                    headers: { 'Authorization': `token ${github_token}` }
                });

                if (!validationResponse.ok) {
                    return res.status(401).json({ success: false, message: 'GitHub Token验证失败' });
                }

                console.log('[laopobao-save] GitHub Token验证成功');
                
                // 验证仓库访问权限
                try {
                    const { owner, repo } = parseRepoUrl(repo_url);
                    const octokit = getOctokitInstance();
                    await octokit.rest.repos.get({ owner, repo });
                    console.log('[laopobao-save] 仓库访问验证成功');
                } catch (repoError) {
                    return res.status(403).json({ success: false, message: '无法访问指定的GitHub仓库，请检查仓库URL和Token权限' });
                }

                config.is_authorized = true;

                try {
                    const userData = await validationResponse.json();
                    config.username = userData.login || null;
                } catch (fetchUserError) {
                    console.warn('[laopobao-save] 获取GitHub用户名时发生网络错误:', fetchUserError.message);
                }

                await saveConfig(config);

                const safeConfig = {
                    repo_url: config.repo_url,
                    display_name: config.display_name,
                    is_authorized: config.is_authorized,
                    username: config.username,
                    backup_before_restore: config.backup_before_restore,
                    target_directory: config.target_directory
                };

                res.json({ success: true, message: '授权和配置成功', config: safeConfig });

            } catch (error) {
                 console.error("[laopobao-save] 授权过程中发生严重错误:", error);
                 try {
                      let cfg = await readConfig();
                      cfg.is_authorized = false;
                      await saveConfig(cfg);
                 } catch (saveErr) { /* Ignore */ }
                res.status(500).json({ success: false, message: '授权过程中发生错误', error: error.message });
            } finally {
                currentOperation = null;
            }
        });

        router.get('/status', async (req, res) => {
            try {
                const status = await getSystemStatus();
                const backupStatus = await checkBackupStatus();
                res.json({ success: true, status: { ...status, backup: backupStatus } });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message || '获取状态失败', details: error.details });
            }
        });

        router.get('/archives', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const result = await listArchiveFiles();
                res.json(result);
            } catch (error) {
                res.status(500).json(error);
            }
        });

        router.post('/archives/restore', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { filename } = req.body;
                if (!filename) {
                    return res.status(400).json({ success: false, message: '需要提供压缩文件名' });
                }
                const result = await restoreFromArchive(filename);
                res.json(result);
            } catch (error) {
                console.error('[laopobao-save] Unexpected error in POST /archives/restore:', error);
                res.status(500).json({ success: false, message: '恢复压缩文件时发生意外错误', details: error.message });
            }
        });

        router.delete('/archives/:filename', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { filename } = req.params;
                if (!filename) {
                    return res.status(400).json({ success: false, message: '需要提供压缩文件名' });
                }
                const result = await deleteArchive(filename);
                res.json(result);
            } catch (error) {
                console.error('[laopobao-save] Unexpected error in DELETE /archives/:filename:', error);
                res.status(500).json({ success: false, message: '删除压缩文件时发生意外错误', details: error.message });
            }
        });

        router.put('/archives/:oldFilename', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { oldFilename } = req.params;
                const { newFilename } = req.body;
                if (!oldFilename || !newFilename) {
                    return res.status(400).json({ success: false, message: '需要提供旧文件名和新文件名' });
                }
                const result = await renameArchive(oldFilename, newFilename);
                res.json(result);
            } catch (error) {
                console.error('[laopobao-save] Unexpected error in PUT /archives/:oldFilename:', error);
                res.status(500).json({ success: false, message: '重命名压缩文件时发生意外错误', details: error.message });
            }
        });

        router.get('/archives/:filename/info', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { filename } = req.params;
                if (!filename) {
                    return res.status(400).json({ success: false, message: '需要提供压缩文件名' });
                }
                const result = await getArchiveInfo(filename);
                res.json(result);
            } catch (error) {
                console.error('[laopobao-save] Unexpected error in GET /archives/:filename/info:', error);
                res.status(500).json({ success: false, message: '获取压缩文件信息时发生意外错误', details: error.message });
            }
        });

        router.post('/backup/restore', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { backupPath } = req.body;
                if (!backupPath) {
                    return res.status(400).json({ success: false, message: '需要提供备份路径' });
                }
                const result = await restoreFromBackup(backupPath);
                res.json(result);
            } catch (error) {
                 console.error('[laopobao-save] Unexpected error in POST /backup/restore:', error);
                res.status(500).json({ success: false, message: '恢复备份时发生意外错误', details: error.message });
            }
        });

        router.delete('/backup/:backupName', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { backupName } = req.params;
                if (!backupName) {
                    return res.status(400).json({ success: false, message: '需要提供备份名称' });
                }
                const result = await deleteBackup(backupName);
                res.json(result);
            } catch (error) {
                 console.error('[laopobao-save] Unexpected error in DELETE /backup/:backupName:', error);
                res.status(500).json({ success: false, message: '删除备份时发生意外错误', details: error.message });
            }
        });

    } catch (error) {
        console.error('[laopobao-save] 插件初始化失败:', error);
    }
}

const plugin = {
    info: info,
    init: init,
};

module.exports = plugin;
