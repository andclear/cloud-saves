const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const express = require('express');
const crypto = require('crypto');

// 将exec转换为Promise
const execPromise = util.promisify(exec);

// 导入node-fetch
let fetch;
try {
    import('node-fetch').then(module => {
        fetch = module.default;
    }).catch(() => {
        fetch = require('node-fetch');
    });
} catch (error) {
    console.error('无法导入node-fetch:', error);
    // 备用实现
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

// 插件信息
const info = {
    id: 'cloud-saves',
    name: 'Cloud Saves',
    description: '通过GitHub仓库创建、管理和恢复SillyTavern的云端存档。',
    version: '1.0.0',
};

// 配置文件路径
const CONFIG_PATH = path.join(__dirname, 'config.json');
// 数据目录路径
const DATA_DIR = path.join(process.cwd(), 'data');
// 默认分支名
const DEFAULT_BRANCH = 'main';

// 默认配置
const DEFAULT_CONFIG = {
    repo_url: '',
    branch: DEFAULT_BRANCH,
    username: '',
    github_token: '',
    display_name: '',
    is_authorized: false,
    last_save: null,
    current_save: null,
    has_temp_stash: false,
    // 新增：定时存档配置
    autoSaveEnabled: false,
    autoSaveInterval: 30, // 默认30分钟
    autoSaveTargetTag: '',
};

// 当前操作状态
let currentOperation = null;
let autoSaveBackendTimer = null; // 后端定时器ID

// ========== 配置管理 ==========

// 读取配置
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        const config = JSON.parse(data);
        // 确保旧配置有默认分支和定时存档设置
        if (!config.branch) {
            config.branch = DEFAULT_BRANCH;
        }
        if (config.autoSaveEnabled === undefined) {
            config.autoSaveEnabled = DEFAULT_CONFIG.autoSaveEnabled;
        }
        if (config.autoSaveInterval === undefined) {
            config.autoSaveInterval = DEFAULT_CONFIG.autoSaveInterval;
        }
        if (config.autoSaveTargetTag === undefined) {
            config.autoSaveTargetTag = DEFAULT_CONFIG.autoSaveTargetTag;
        }
        return config;
    } catch (error) {
        // 如果配置文件不存在或解析失败，创建默认配置
        console.warn('Failed to read or parse config, creating default:', error.message);
        await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return { ...DEFAULT_CONFIG };
    }
}

// 保存配置
async function saveConfig(config) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ========== Git 操作核心功能 ==========

// 执行git命令 - 修改：增加可选的 cwd 参数
async function runGitCommand(command, options = {}) {
    let config = {};
    let originalRepoUrl = '';
    let tokenUrl = '';
    let temporarilySetUrl = false;
    const executeIn = options.cwd || DATA_DIR; // 优先使用传入的 cwd，否则默认 DATA_DIR

    try {
        config = await readConfig();
        const token = config.github_token;
        // 读取指定目录下的远程 URL
        let remoteShowResult;
        try {
            remoteShowResult = await execPromise('git remote get-url origin', { cwd: executeIn });
            originalRepoUrl = remoteShowResult.stdout.trim();
        } catch (getRemoteError) {
            // 如果获取远程URL失败（例如还没设置远程），则 originalRepoUrl 保持空
             console.warn(`[cloud-saves] 在目录 ${executeIn} 获取 remote URL 失败:`, getRemoteError.stderr || getRemoteError.message);
             originalRepoUrl = ''; // 确保为空
        }
        
        // 特殊处理推送/拉取/获取/列出远程引用时使用token (只在 DATA_DIR 中执行时才用 token)
        if (executeIn === DATA_DIR && token && originalRepoUrl && originalRepoUrl.startsWith('https://') && 
            (command.startsWith('git push') || command.startsWith('git pull') || command.startsWith('git fetch') || command.startsWith('git ls-remote'))) { 
            if (!originalRepoUrl.includes('@github.com')) {
                tokenUrl = originalRepoUrl.replace('https://', `https://x-access-token:${token}@`);
                console.log(`[cloud-saves] DATA_DIR: 临时设置带token的remote URL，执行命令: ${command}`);
                // 注意：这里的 set-url 仍然是在 DATA_DIR 操作
                await execPromise(`git remote set-url origin ${tokenUrl}`, { cwd: DATA_DIR });
                temporarilySetUrl = true;
            }
        }

        // 对clone命令也要修改URL (通常不在插件目录执行)
        if (token && originalRepoUrl && originalRepoUrl.startsWith('https://') && command.startsWith('git clone')) {
            if (!originalRepoUrl.includes('@github.com')) {
                tokenUrl = originalRepoUrl.replace('https://', `https://x-access-token:${token}@`);
                command = command.replace(originalRepoUrl, tokenUrl);
            }
        }

        // 记录要执行的命令和目录
        console.log(`[cloud-saves][CWD: ${path.basename(executeIn)}] 执行命令: ${command}`);

        // 处理选项参数
        const execOptions = { 
            cwd: executeIn // 使用确定的执行目录
        }; 
        
        // 处理标准输入
        if (options && options.input !== undefined) {
            const result = await new Promise((resolve, reject) => {
                const childProcess = require('child_process').spawn(
                    command.split(' ')[0], 
                    command.split(' ').slice(1), 
                    { cwd: execOptions.cwd }
                );
                
                let stdout = '';
                let stderr = '';
                
                childProcess.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                
                childProcess.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                childProcess.on('close', (code) => {
                    if (code === 0) {
                        resolve({ success: true, stdout, stderr });
                    } else {
                        resolve({ success: false, stdout, stderr });
                    }
                });
                
                childProcess.on('error', (err) => {
                    reject(err);
                });
                
                if (options.input) {
                    childProcess.stdin.write(options.input);
                    childProcess.stdin.end();
                }
            });
            
            return result;
        } else {
            // 常规命令执行
            const { stdout, stderr } = await execPromise(command, execOptions);
            
            // 如果临时设置了URL，命令完成后恢复 (只针对 DATA_DIR)
            if (temporarilySetUrl && executeIn === DATA_DIR) {
                console.log(`[cloud-saves] DATA_DIR: 恢复原始remote URL: ${originalRepoUrl}`);
                await execPromise(`git remote set-url origin ${originalRepoUrl}`, { cwd: DATA_DIR });
                temporarilySetUrl = false;
            }

            return { success: true, stdout, stderr };
        }
    } catch (error) {
        // 修改错误日志，避免打印大型二进制内容
        let stdoutLog = error.stdout || '';
        let stderrLog = error.stderr || '';
        if (command.startsWith('git diff --binary')) {
            stdoutLog = '[二进制差异内容已省略]';
        }
        console.error(`[cloud-saves][CWD: ${path.basename(executeIn)}] Git命令失败: ${command}\n错误: ${error.message}\nStdout: ${stdoutLog}\nStderr: ${stderrLog}`);
        
        // 如果临时设置了URL且命令失败，尝试恢复 (只针对 DATA_DIR)
        if (temporarilySetUrl && executeIn === DATA_DIR) {
            try {
                console.warn(`[cloud-saves] DATA_DIR: 命令失败，尝试恢复原始remote URL: ${originalRepoUrl}`);
                await execPromise(`git remote set-url origin ${originalRepoUrl}`, { cwd: DATA_DIR });
                temporarilySetUrl = false;
            } catch (revertError) {
                console.error(`[cloud-saves] DATA_DIR: 恢复remote URL失败: ${revertError.message}`);
            }
        }

        return { 
            success: false, 
            error: error.message,
            stdout: error.stdout || '',
            stderr: error.stderr || ''
        };
    } finally {
        // 最终安全检查：确保URL被恢复 (只针对 DATA_DIR)
        if (temporarilySetUrl && executeIn === DATA_DIR) {
            try {
                console.warn(`[cloud-saves] DATA_DIR: 最终检查：在finally块中恢复remote URL: ${originalRepoUrl}`);
                await execPromise(`git remote set-url origin ${originalRepoUrl}`, { cwd: DATA_DIR });
            } catch (finalRevertError) {
                console.error(`[cloud-saves] DATA_DIR: 在finally块中恢复remote URL失败: ${finalRevertError.message}`);
            }
        }
    }
}

// 检查Git是否已初始化
async function isGitInitialized() {
    const result = await runGitCommand('git rev-parse --is-inside-work-tree');
    return result.success && result.stdout.trim() === 'true';
}

// 初始化Git仓库
async function initGitRepo() {
    // 检查是否已经初始化 
    const isInitializedResult = await runGitCommand('git rev-parse --is-inside-work-tree');
    if (isInitializedResult.success && isInitializedResult.stdout.trim() === 'true') {
        return { success: true, message: 'Git仓库已在data目录中初始化' };
    }
    console.log('[cloud-saves] 正在data目录中初始化Git仓库:', DATA_DIR);

    // 尝试初始化仓库
    let initResult;
    try {
        console.log(`[cloud-saves] 执行: git init in ${DATA_DIR}`);
        const { stdout, stderr } = await execPromise('git init', { cwd: DATA_DIR });
        console.log('[cloud-saves] git init stdout:', stdout);
        console.log('[cloud-saves] git init stderr:', stderr);
        initResult = { success: true, stdout, stderr, message: 'Git仓库初始化成功' };
    } catch (error) {
        console.error(`[cloud-saves] 在${DATA_DIR}初始化git失败. 错误: ${error.message}`);
        console.error('[cloud-saves] git init stdout on error:', error.stdout);
        console.error('[cloud-saves] git init stderr on error:', error.stderr);
        initResult = {
            success: false,
            message: '初始化Git仓库失败',
            error: error.message,
            stdout: error.stdout || '',
            stderr: error.stderr || ''
        };
    }

    return initResult;
}

// 配置远程仓库
async function configureRemote(repoUrl) {
    // 检查当前远程仓库
    const remoteResult = await runGitCommand('git remote -v');
    
    if (remoteResult.success && remoteResult.stdout.includes('origin')) {
        // 如果已经有origin，更新它
        const updateResult = await runGitCommand(`git remote set-url origin ${repoUrl}`);
        if (!updateResult.success) {
            return { success: false, message: '更新远程URL失败', details: updateResult };
        }
    } else {
        // 否则添加origin
        const addResult = await runGitCommand(`git remote add origin ${repoUrl}`);
        if (!addResult.success) {
            return { success: false, message: '添加远程仓库失败', details: addResult };
        }
    }

    return { success: true, message: '远程仓库配置成功' };
}

// ========== 云存档特定功能 ==========

// 创建新存档 - 修复推送和描述，使用 Base64 编码名称
async function createSave(name, description) {
    try {
        currentOperation = 'create_save';
        console.log(`[cloud-saves] 正在创建新存档: ${name}, 描述: ${description}`);
        
        const config = await readConfig();
        const displayName = config.display_name || config.username || 'Cloud Saves User';
        const placeholderEmail = 'cloud-saves@sillytavern.local';
        const gitConfigArgs = `-c user.name="${displayName}" -c user.email="${placeholderEmail}"`;
        const branchToPush = config.branch || DEFAULT_BRANCH; // 获取配置的分支

        // 使用 Base64 URL 安全编码处理名称
        const encodedName = Buffer.from(name).toString('base64url');
        const tagName = `save_${Date.now()}_${encodedName}`;
        
        const addResult = await runGitCommand('git add -A');
        if (!addResult.success) return { success: false, message: '添加文件到暂存区失败', details: addResult };

        const statusResult = await runGitCommand('git status --porcelain');
        let commitNeeded = statusResult.success && statusResult.stdout.trim() !== '';
        
        if (commitNeeded) {
            console.log('[cloud-saves] 执行提交...');
            const commitResult = await runGitCommand(`git ${gitConfigArgs} commit -m "存档: ${name}"`);
            if (!commitResult.success) {
                if (commitResult.stderr && commitResult.stderr.includes('nothing to commit')) {
                    console.log('[cloud-saves] 提交时无更改。');
                    commitNeeded = false;
                } else {
                    return { success: false, message: '提交更改失败', details: commitResult };
                }
            }
        }

        console.log('[cloud-saves] 创建标签...');
        const tagMessage = description || `存档: ${name}`; 
        const nowTimestamp = new Date().toISOString();
        const fullTagMessage = `${tagMessage}\nLast Updated: ${nowTimestamp}`;
        console.log(`[cloud-saves] 用于创建标签的完整消息: "${fullTagMessage}"`);
        const tagResult = await runGitCommand(`git ${gitConfigArgs} tag -a "${tagName}" -m "${fullTagMessage}"`);
        if (!tagResult.success) return { success: false, message: '创建存档标签失败', details: tagResult };

        console.log('[cloud-saves] 推送更改...');
        // --- BEGIN DETACHED HEAD PUSH FIX ---
        // 检查是否处于 detached HEAD 状态
        const symbolicRefResult = await runGitCommand('git symbolic-ref --short -q HEAD');
        const isOnBranch = symbolicRefResult.success && symbolicRefResult.stdout.trim() !== '';
        let currentBranch = '';
        
        if (isOnBranch) {
             currentBranch = symbolicRefResult.stdout.trim();
              // 只推送当前配置的分支上的提交
              if (currentBranch === branchToPush && commitNeeded) {
                 console.log(`[cloud-saves] 推送分支: ${currentBranch}`);
                 const pushBranchResult = await runGitCommand(`git push origin ${currentBranch}`);
                  if (!pushBranchResult.success) {
                      console.warn(`[cloud-saves] 推送分支 ${currentBranch} 失败:`, pushBranchResult.stderr);
                      // 可选：如果推送分支失败，可能不应该继续推送标签，取决于策略
                      // return { success: false, message: `推送分支 ${currentBranch} 失败`, details: pushBranchResult };
                  }
              } else if (commitNeeded) {
                  console.log(`[cloud-saves] 当前不在配置的分支 (${branchToPush})，跳过推送提交。当前分支: ${currentBranch}`);
             }
        } else {
            console.log('[cloud-saves] 当前处于 detached HEAD 状态，跳过推送分支。');
        }
        // --- END DETACHED HEAD PUSH FIX ---

        const pushTagResult = await runGitCommand(`git push origin "${tagName}"`);
        if (!pushTagResult.success) return { success: false, message: '推送存档标签到远程失败', details: pushTagResult };

        config.last_save = { 
            name: name, 
            tag: tagName, 
            timestamp: nowTimestamp,
            description: description || '' 
        };
        await saveConfig(config);

        // 返回原始名称给前端
        return { 
            success: true, 
            message: '存档创建成功', 
            saveData: { 
                ...config.last_save, 
                name: name, 
                createdAt: nowTimestamp,
                updatedAt: nowTimestamp
            } 
        };
    } catch (error) {
        console.error('[cloud-saves] 创建存档失败:', error);
        return { success: false, message: `创建存档时发生错误: ${error.message}` };
    } finally {
        currentOperation = null;
    }
}

// 获取存档列表 - 获取并解码名称，获取 Tagger 名称
async function listSaves() {
    try {
        currentOperation = 'list_saves';
        console.log('[cloud-saves] 获取存档列表');
        
        const fetchResult = await runGitCommand('git fetch --tags');
        if (!fetchResult.success) return { success: false, message: '从远程获取标签失败', details: fetchResult };

        // 修改 format，添加 %(taggername) 和 %(contents) 获取完整 tag 消息体
        const formatString = "%(refname:short)%00%(creatordate:iso)%00%(taggername)%00%(subject)%00%(contents)";
        const listTagsResult = await runGitCommand(`git tag -l "save_*" --sort=-creatordate --format="${formatString}"`);
        if (!listTagsResult.success) return { success: false, message: '获取存档标签列表失败', details: listTagsResult };

        const saves = listTagsResult.stdout.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\0');
            if (parts.length < 5) return null; 
            
            const tagName = parts[0];
            const createdAt = new Date(parts[1]).toISOString(); // 创建时间
            const taggerName = parts[2] || '未知'; 
            const subject = parts[3]; // 第一行作为 subject
            const body = parts[4] || ''; // 剩余部分作为 body
            
            let name = tagName;
            let description = subject; // 默认描述是 subject
            let updatedAt = createdAt; // 默认更新时间等于创建时间

            // 尝试解析更新时间戳
            const bodyLines = body.split('\n');
            const lastUpdatedLine = bodyLines.find(l => l.startsWith('Last Updated:'));
            if (lastUpdatedLine) {
                const timestampStr = lastUpdatedLine.replace('Last Updated:', '').trim();
                const parsedDate = new Date(timestampStr);
                if (!isNaN(parsedDate)) {
                    updatedAt = parsedDate.toISOString();
                }
                // 如果找到了更新时间戳，将它从描述中移除（或者只取第一行作描述）
                // description = subject; // 只用 subject 作为描述比较简单
            } else {
                 // 如果没有更新时间戳行，尝试将整个 contents 作为描述？
                 // 或者只保留 subject
                 description = subject; 
            }

            // 解码名称
            const tagNameMatch = tagName.match(/^save_\d+_(.+)$/);
            if (tagNameMatch) {
                try {
                    const encodedName = tagNameMatch[1];
                    name = Buffer.from(encodedName, 'base64url').toString('utf8');
                } catch (decodeError) {
                    console.warn(`[cloud-saves] 解码存档名称失败 (${tagName}):`, decodeError);
                    name = tagNameMatch[1]; 
                }
            }

            return {
                name: name,
                tag: tagName,
                commit: null, 
                createdAt: createdAt,
                updatedAt: updatedAt,
                description: description.trim(),
                creator: taggerName
            };
        }).filter(Boolean);

        return { success: true, saves: saves };
    } catch (error) {
        console.error('[cloud-saves] 获取存档列表失败:', error);
        return { success: false, message: `获取存档列表时发生错误: ${error.message}` };
    } finally {
        currentOperation = null;
    }
}

// 切换到指定存档
async function loadSave(tagName) {
    try {
        currentOperation = 'load_save';
        console.log(`[cloud-saves] 正在加载存档: ${tagName}`);
        
        // 1. 检查标签是否存在
        const checkTagResult = await runGitCommand(`git tag -l "${tagName}"`);
        if (!checkTagResult.success || !checkTagResult.stdout.trim()) {
            return { success: false, message: '找不到指定的存档', details: checkTagResult };
        }

        // 2. 在回档前保存当前工作区状态（如有必要）
        const statusResult = await runGitCommand('git status --porcelain');
        let stashCreated = false;
        
        if (statusResult.success && statusResult.stdout.trim() !== '') {
            console.log('[cloud-saves] 检测到未保存的更改，在回档前创建临时保存点');
            
            // 创建临时存档
            const tempStashResult = await runGitCommand('git stash push -u -m "Temporary stash before loading save"');
            stashCreated = tempStashResult.success && !tempStashResult.stdout.includes('No local changes to save');
            
            if (stashCreated) {
                console.log('[cloud-saves] 临时保存点创建成功');
            } else {
                console.warn('[cloud-saves] 创建临时保存点失败或没有更改需要保存');
            }
        }

        // 3. 获取标签指向的提交
        const tagCommitResult = await runGitCommand(`git rev-list -n 1 "${tagName}"`);
        if (!tagCommitResult.success) {
            // 如果失败且之前创建了stash，尝试应用stash
            if (stashCreated) {
                await runGitCommand('git stash pop');
            }
            return { success: false, message: '获取存档提交失败', details: tagCommitResult };
        }
        
        const commit = tagCommitResult.stdout.trim();

        // 4. 切换到标签指向的提交 (这会进入 detached HEAD 状态)
        const checkoutResult = await runGitCommand(`git checkout "${commit}"`);
        if (!checkoutResult.success) {
            // 如果失败且之前创建了stash，尝试应用stash
            if (stashCreated) {
                await runGitCommand('git stash pop');
            }
            return { success: false, message: '切换到存档失败', details: checkoutResult };
        }

        // 5. 更新配置记录当前加载的存档
        const config = await readConfig();
        config.current_save = {
            tag: tagName,
            loaded_at: new Date().toISOString()
        };
        if (stashCreated) {
            config.has_temp_stash = true;
        }
        await saveConfig(config);

        return { 
            success: true, 
            message: '存档加载成功', 
            stashCreated: stashCreated 
        };
    } catch (error) {
        console.error('[cloud-saves] 加载存档失败:', error);
        return { success: false, message: `加载存档时发生错误: ${error.message}` };
    } finally {
        currentOperation = null;
    }
}

// 删除存档
async function deleteSave(tagName) {
    try {
        currentOperation = 'delete_save';
        console.log(`[cloud-saves] 正在删除存档: ${tagName}`);
        
        // 1. 检查标签是否存在
        const checkTagResult = await runGitCommand(`git tag -l "${tagName}"`);
        if (!checkTagResult.success || !checkTagResult.stdout.trim()) {
            return { success: false, message: '找不到指定的存档', details: checkTagResult };
        }

        // 2. 删除本地标签
        const deleteLocalResult = await runGitCommand(`git tag -d "${tagName}"`);
        if (!deleteLocalResult.success) {
            return { success: false, message: '删除本地存档失败', details: deleteLocalResult };
        }

        // 3. 删除远程标签
        const deleteRemoteResult = await runGitCommand(`git push origin :refs/tags/${tagName}`);
        if (!deleteRemoteResult.success) {
            console.warn('[cloud-saves] 删除远程存档标签失败，但本地已删除:', deleteRemoteResult.stderr);
            return { 
                success: true, 
                message: '本地存档已删除，但删除远程存档失败，可能是网络问题或权限问题',
                warning: true,
                details: deleteRemoteResult
            };
        }

        // 4. 更新配置，如果当前加载的存档被删除，清除记录
        const config = await readConfig();
        if (config.current_save && config.current_save.tag === tagName) {
            config.current_save = null;
            await saveConfig(config);
        }

        return { success: true, message: '存档删除成功' };
    } catch (error) {
        console.error('[cloud-saves] 删除存档失败:', error);
        return { success: false, message: `删除存档时发生错误: ${error.message}` };
    } finally {
        currentOperation = null;
    }
}

// 重命名存档 - 使用 Base64 编码新名称
async function renameSave(oldTagName, newName, description) {
    try {
        currentOperation = 'rename_save';
        console.log(`[cloud-saves] 正在重命名存档: ${oldTagName} -> ${newName}`);
        
        const config = await readConfig();
        const displayName = config.display_name || config.username || 'Cloud Saves User';
        const placeholderEmail = 'cloud-saves@sillytavern.local';
        const gitConfigArgs = `-c user.name="${displayName}" -c user.email="${placeholderEmail}"`;

        // 1. 检查旧标签是否存在
        const checkTagResult = await runGitCommand(`git tag -l "${oldTagName}"`);
        if (!checkTagResult.success || !checkTagResult.stdout.trim()) return { success: false, message: '找不到指定的存档', details: checkTagResult };

        // 2. 获取旧标签指向的提交
        const tagCommitResult = await runGitCommand(`git rev-list -n 1 "${oldTagName}"`);
        if (!tagCommitResult.success) return { success: false, message: '获取存档提交失败', details: tagCommitResult };
        const commit = tagCommitResult.stdout.trim();

        // 3. 解码旧名称以供比较
        let oldDecodedName = oldTagName;
        const oldNameMatch = oldTagName.match(/^save_\d+_(.+)$/);
        if (oldNameMatch) {
             try { oldDecodedName = Buffer.from(oldNameMatch[1], 'base64url').toString('utf8'); } catch (e) { /* ignore */ }
        }
        
        const nowTimestamp = new Date().toISOString();
        const newDescription = description || `存档: ${newName}`; // 使用传入的描述或默认
        const fullNewMessage = `${newDescription}\nLast Updated: ${nowTimestamp}`;

        // 4. 检查名称是否实际更改
        if (oldDecodedName === newName) {
            // 名称未变，只更新描述和更新时间戳
            console.log(`[cloud-saves] 名称未变，仅更新标签描述和时间戳: ${oldTagName}`);
            // 使用 -f 强制更新本地标签
            const updateTagResult = await runGitCommand(`git ${gitConfigArgs} tag -a -f "${oldTagName}" -m "${fullNewMessage}" ${commit}`);
            if (!updateTagResult.success) {
                return { success: false, message: '更新本地标签失败', details: updateTagResult };
            }
            // 强制推送更新后的标签到远程
            console.log(`[cloud-saves] 强制推送更新后的标签: ${oldTagName}`);
            const forcePushResult = await runGitCommand(`git push origin "${oldTagName}" --force`);
            if (!forcePushResult.success) {
                // 如果强制推送失败，可能需要警告用户或尝试回滚本地更改？
                console.warn(`[cloud-saves] 强制推送标签 ${oldTagName} 失败，远程可能未更新:`, forcePushResult.stderr);
                return { success: false, message: '强制推送更新后的标签失败，请检查权限或网络', details: forcePushResult, warning: true };
            }
            // 返回成功，但 newTag 和 newName 保持不变
            return { success: true, message: '存档描述和更新时间已更新', oldTag: oldTagName, newTag: oldTagName, newName: newName };

        } else {
            // 名称已更改，执行完整的重命名流程
            console.log(`[cloud-saves] 名称已更改，执行完整重命名流程...`);
        // 使用 Base64 编码新名称
        const encodedNewName = Buffer.from(newName).toString('base64url');
            // 使用当前时间戳创建新标签名，而不是旧的
            const newTagName = `save_${Date.now()}_${encodedNewName}`; 

            console.log(`[cloud-saves] 创建新标签: ${newTagName}`);
            const tagResult = await runGitCommand(`git ${gitConfigArgs} tag -a "${newTagName}" -m "${fullNewMessage}" ${commit}`);
        if (!tagResult.success) return { success: false, message: '创建新存档标签失败', details: tagResult };

            console.log(`[cloud-saves] 推送新标签: ${newTagName}`);
        const pushTagResult = await runGitCommand(`git push origin "${newTagName}"`);
        if (!pushTagResult.success) {
                // 如果推送失败，删除本地创建的新标签
            await runGitCommand(`git tag -d "${newTagName}"`);
            return { success: false, message: '推送新存档标签到远程失败', details: pushTagResult };
        }

            console.log(`[cloud-saves] 删除旧本地标签: ${oldTagName}`);
            await runGitCommand(`git tag -d "${oldTagName}"`); // 忽略本地删除错误
            console.log(`[cloud-saves] 删除旧远程标签: ${oldTagName}`);
            await runGitCommand(`git push origin :refs/tags/${oldTagName}`); // 忽略远程删除错误

            // 更新配置中的 current_save (如果适用)
        if (config.current_save && config.current_save.tag === oldTagName) {
            config.current_save.tag = newTagName;
            await saveConfig(config);
        }

        // 返回原始新名称给前端
        return { success: true, message: '存档重命名成功', oldTag: oldTagName, newTag: newTagName, newName: newName };
        }

    } catch (error) {
        console.error('[cloud-saves] 重命名存档失败:', error);
        return { success: false, message: `重命名存档时发生错误: ${error.message}` };
    } finally {
        currentOperation = null;
    }
}

// 获取存档之间的差异 - 改进引用验证
async function getSaveDiff(ref1, ref2) { // 参数名改为 ref1, ref2
    try {
        currentOperation = 'get_save_diff';
        console.log(`[cloud-saves] 获取差异: ${ref1} <-> ${ref2}`);
        
        // 1. 使用 git rev-parse 验证引用有效性
        const checkRef1Result = await runGitCommand(`git rev-parse --verify ${ref1}`);
        if (!checkRef1Result.success) {
            // 尝试处理特殊空树对象，用于与初始提交比较
            if (ref1 !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904') {
                 // 特别处理 tag^ 可能在初始提交时无效的情况
                 if (ref1.endsWith('^') || ref1.endsWith('~1')) {
                     console.warn(`[cloud-saves] 无法解析引用 ${ref1}，可能为初始提交的父提交。尝试与空树比较。`);
                     ref1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // Git 的空树对象哈希
                 } else {
                    return { success: false, message: `找不到或无效的引用: ${ref1}`, details: checkRef1Result };
                 }
            } 
        }

        const checkRef2Result = await runGitCommand(`git rev-parse --verify ${ref2}`);
        if (!checkRef2Result.success) {
             return { success: false, message: `找不到或无效的引用: ${ref2}`, details: checkRef2Result };
        }

        // 2. 获取变更文件列表 (git diff 可以处理各种有效引用)
        const diffNameOnlyResult = await runGitCommand(`git diff --name-status ${ref1} ${ref2}`);
        if (!diffNameOnlyResult.success) {
            // 如果 diff 失败，检查是否因为 ref1 指向空树 (初始提交对比)
             if (ref1 === '4b825dc642cb6eb9a060e54bf8d69288fbee4904') {
                 console.log(`[cloud-saves] 与空树比较，使用 git show 显示初始提交内容。`);
                 // 对于初始提交，显示其包含的所有文件作为"添加"
                 const showResult = await runGitCommand(`git show --pretty="format:" --name-status ${ref2}`);
                 if (showResult.success) {
                     const files = showResult.stdout.trim().split('\n').filter(Boolean).map(line => {
                        const [status, ...fileParts] = line.split('\t');
                        return { status: 'A', fileName: fileParts.join('\t') }; // 将所有文件视为添加 A
                     });
                     return { success: true, changedFiles: files };
                 } else {
                    return { success: false, message: '获取初始提交文件列表失败', details: showResult };
                 }
             } else {
                return { success: false, message: '获取变更文件列表失败', details: diffNameOnlyResult };
             }
        }
        
        const changedFiles = diffNameOnlyResult.stdout.trim().split('\n')
            .filter(Boolean)
            .map(line => {
                const [status, ...fileParts] = line.split('\t');
                const fileName = fileParts.join('\t');
                return { status, fileName };
            });

        return {
            success: true,
            changedFiles: changedFiles
        };
    } catch (error) {
        console.error('[cloud-saves] 获取存档差异失败:', error);
        return { success: false, message: `获取存档差异时发生错误: ${error.message}` };
    } finally {
        currentOperation = null;
    }
}

// 获取Git状态
async function getGitStatus() {
    try {
        const isInitializedResult = await runGitCommand('git rev-parse --is-inside-work-tree');
        const isInitialized = isInitializedResult.success && isInitializedResult.stdout.trim() === 'true';
        
        let changes = [];
        if (isInitialized) {
            const statusResult = await runGitCommand('git status --porcelain');
            // 检查成功后再处理stdout
            if (statusResult.success && typeof statusResult.stdout === 'string') { 
                changes = statusResult.stdout.trim().split('\n').filter(line => line.trim() !== '');
            } else if (!statusResult.success) {
                // 如果获取状态失败（在已初始化的仓库上），记录错误
                console.error('获取git状态失败:', statusResult.stderr || statusResult.error);
                throw new Error(`获取Git状态失败: ${statusResult.stderr || statusResult.error}`);
            }
        }
        
        // 获取当前分支信息
        let currentBranch = null;
        const branchResult = await runGitCommand('git branch --show-current');
        if (branchResult.success) {
            currentBranch = branchResult.stdout.trim();
        }

        // 获取当前存档信息
        const config = await readConfig();
        const currentSave = config.current_save;

        return { 
            initialized: isInitialized, 
            changes: changes,
            currentBranch: currentBranch,
            currentSave: currentSave
        };
    } catch (error) {
        console.error('获取Git状态时出错:', error);
        throw error;
    }
}

// 检查是否有尚未保存的更改
async function hasUnsavedChanges() {
    const statusResult = await runGitCommand('git status --porcelain');
    return statusResult.success && statusResult.stdout.trim() !== '';
}

// 检查用户临时stash是否存在
async function checkTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { exists: false };
    }
    
    // 检查stash列表
    const stashListResult = await runGitCommand('git stash list');
    if (!stashListResult.success) {
        return { exists: false, error: 'Failed to check stash list' };
    }
    
    // 查找临时stash（假设是第一个，但更严格的实现应该检查stash消息）
    const stashes = stashListResult.stdout.trim().split('\n').filter(Boolean);
    if (stashes.length === 0) {
        // 没有找到stash，更新配置
        config.has_temp_stash = false;
        await saveConfig(config);
        return { exists: false };
    }
    
    return { exists: true };
}

// 应用临时stash
async function applyTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { success: false, message: 'No temporary stash found' };
    }
    
    // 应用stash（假设是stash@{0}，严格实现应该基于消息找到正确的stash）
    const stashApplyResult = await runGitCommand('git stash apply stash@{0}');
    if (!stashApplyResult.success) {
        return { success: false, message: 'Failed to apply stash', details: stashApplyResult };
    }
    
    // 更新配置
    config.has_temp_stash = false;
    await saveConfig(config);
    
    return { success: true, message: 'Temporary stash applied successfully' };
}

// 丢弃临时stash
async function discardTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { success: false, message: 'No temporary stash found' };
    }
    
    // 丢弃stash（假设是stash@{0}）
    const stashDropResult = await runGitCommand('git stash drop stash@{0}');
    if (!stashDropResult.success) {
        return { success: false, message: 'Failed to discard stash', details: stashDropResult };
    }
    
    // 更新配置
    config.has_temp_stash = false;
    await saveConfig(config);
    
    return { success: true, message: 'Temporary stash discarded' };
}

// --- 新增：执行自动覆盖存档的函数 (供定时器调用) ---
async function performAutoSave() {
    if (currentOperation) {
        console.log(`[Cloud Saves Auto] 跳过自动存档，当前有操作正在进行: ${currentOperation}`);
        return;
    }
    currentOperation = 'auto_save'; // 标记操作开始
    let config;
    try {
        config = await readConfig();
        if (!config.is_authorized || !config.autoSaveEnabled || !config.autoSaveTargetTag) {
            console.log('[Cloud Saves Auto] 自动存档条件不满足（未授权/未启用/无目标），跳过。');
            currentOperation = null;
            return;
        }
        
        const targetTag = config.autoSaveTargetTag;
        console.log(`[Cloud Saves Auto] 开始自动覆盖存档到: ${targetTag}`);
        
        // --- 复用 /overwrite 接口的核心逻辑 --- 
        // (注意：这里不处理 res 对象，只执行操作或抛出错误)
        
        let originalDescription = `Overwrite of ${targetTag}`;
        const fetchTagInfoResult = await runGitCommand(`git tag -n1 -l "${targetTag}" --format="%(contents)"`);
        if (fetchTagInfoResult.success && fetchTagInfoResult.stdout.trim()) {
            originalDescription = fetchTagInfoResult.stdout.trim().split('\n')[0];
        }
        const displayName = config.display_name || config.username || 'Cloud Saves User';
        const placeholderEmail = 'cloud-saves@sillytavern.local';
        const gitConfigArgs = `-c user.name="${displayName}" -c user.email="${placeholderEmail}"`;
        const branchToUse = config.branch || DEFAULT_BRANCH;

        const addResult = await runGitCommand('git add -A');
        if (!addResult.success) throw new Error(`添加到暂存区失败: ${addResult.stderr}`);

        const statusResult = await runGitCommand('git status --porcelain');
        const hasChanges = statusResult.success && statusResult.stdout.trim() !== '';
        let newCommitHash = 'HEAD';

        if (hasChanges) {
            const commitMessage = `Auto Save Overwrite: ${targetTag}`;
            const commitResult = await runGitCommand(`git ${gitConfigArgs} commit -m "${commitMessage}"`);
            if (!commitResult.success) {
                if (commitResult.stderr && commitResult.stderr.includes('nothing to commit')) {
                    console.log('[Cloud Saves Auto] 自动存档时无实际更改可提交，将使用当前 HEAD');
                     const headCommitResult = await runGitCommand('git rev-parse HEAD');
                     if (!headCommitResult.success) throw new Error('获取当前 HEAD 提交哈希失败');
                     newCommitHash = headCommitResult.stdout.trim();
                } else {
                    throw new Error(`创建自动存档提交失败: ${commitResult.stderr}`);
                }
            } else {
                 const newCommitResult = await runGitCommand('git rev-parse HEAD');
                 if (!newCommitResult.success) throw new Error('获取新提交哈希失败');
                 newCommitHash = newCommitResult.stdout.trim();
                 console.log('[Cloud Saves Auto] 新自动存档提交哈希:', newCommitHash);
                 const pushCommitResult = await runGitCommand(`git push origin ${branchToUse}`);
                 if (!pushCommitResult.success) console.warn(`[Cloud Saves Auto] 推送自动存档提交到分支 ${branchToUse} 失败:`, pushCommitResult.stderr);
            }
        } else {
             console.log('[Cloud Saves Auto] 自动存档时无实际更改可提交，将使用当前 HEAD');
             const headCommitResult = await runGitCommand('git rev-parse HEAD');
             if (!headCommitResult.success) throw new Error('获取当前 HEAD 提交哈希失败');
             newCommitHash = headCommitResult.stdout.trim();
        }

        await runGitCommand(`git tag -d "${targetTag}"`);
        const deleteRemoteResult = await runGitCommand(`git push origin :refs/tags/${targetTag}`);
        if (!deleteRemoteResult.success && !deleteRemoteResult.stderr.includes('remote ref does not exist')) {
           console.warn(`[Cloud Saves Auto] 删除远程旧标签 ${targetTag} 时遇到问题:`, deleteRemoteResult.stderr);
        }

        const nowTimestampOverwrite = new Date().toISOString();
        const fullTagMessageOverwrite = `${originalDescription}\nLast Updated: ${nowTimestampOverwrite}`;
        const newTagResult = await runGitCommand(`git ${gitConfigArgs} tag -a "${targetTag}" -m "${fullTagMessageOverwrite}" ${newCommitHash}`);
        if (!newTagResult.success) throw new Error(`创建新标签 ${targetTag} 失败: ${newTagResult.stderr}`);

        const pushNewTagResult = await runGitCommand(`git push origin "${targetTag}"`);
        if (!pushNewTagResult.success) {
            await runGitCommand(`git tag -d "${targetTag}"`);
           throw new Error(`推送新标签 ${targetTag} 到远程失败: ${pushNewTagResult.stderr}`);
        }

        // 不需要更新 last_save，让用户手动操作的 last_save 保持
        console.log(`[Cloud Saves Auto] 成功自动覆盖存档: ${targetTag}`);

    } catch (error) {
        console.error(`[Cloud Saves Auto] 自动覆盖存档失败 (${config?.autoSaveTargetTag}):`, error);
    } finally {
        currentOperation = null; // 释放操作状态
    }
}

// --- 新增：设置/清除后端定时器的函数 ---
function setupBackendAutoSaveTimer() {
    if (autoSaveBackendTimer) {
        console.log('[Cloud Saves] 清除现有的后端自动存档定时器。');
        clearInterval(autoSaveBackendTimer);
        autoSaveBackendTimer = null;
    }

    readConfig().then(config => {
        if (config.is_authorized && config.autoSaveEnabled && config.autoSaveTargetTag) {
            const intervalMinutes = config.autoSaveInterval > 0 ? config.autoSaveInterval : 30;
            const intervalMilliseconds = intervalMinutes * 60 * 1000;
            console.log(`[Cloud Saves] 启动后端定时存档，间隔 ${intervalMinutes} 分钟，目标: ${config.autoSaveTargetTag}`);
            autoSaveBackendTimer = setInterval(performAutoSave, intervalMilliseconds);
        } else {
            console.log('[Cloud Saves] 后端定时存档未启动（未授权/未启用/无目标）。');
        }
    }).catch(err => {
        console.error('[Cloud Saves] 启动后端定时器前读取配置失败:', err);
    });
}

// ========== 插件初始化和导出 ==========

async function init(router) {
    console.log('[cloud-saves] 初始化云存档插件...');
    try {
        // --- BEGIN UI Serving --- 
        // 提供静态文件 - 修改路径为 /static
        router.use('/static', express.static(path.join(__dirname, 'public')));

        // 确保解析JSON请求体
        router.use(express.json());

        // UI页面路由
        router.get('/ui', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });
        // --- END UI Serving ---

        // ========== Express API 端点 ==========

        // 获取插件信息
        router.get('/info', (req, res) => {
            res.json(info);
        });

        // 获取配置
        router.get('/config', async (req, res) => {
            try {
                const config = await readConfig();
                // 返回安全配置，包含 display_name 和 branch
                const safeConfig = {
                    repo_url: config.repo_url || '',
                    github_token: config.github_token || '', 
                    display_name: config.display_name || '',
                    branch: config.branch || DEFAULT_BRANCH, // 返回分支
                    is_authorized: config.is_authorized || false,
                    username: config.username || null, // Keep GitHub username if fetched
                    // 新增：返回定时存档配置
                    autoSaveEnabled: config.autoSaveEnabled || false,
                    autoSaveInterval: config.autoSaveInterval || 30,
                    autoSaveTargetTag: config.autoSaveTargetTag || '',
                };
                res.json(safeConfig);
            } catch (error) {
                res.status(500).json({ success: false, message: '读取配置失败', error: error.message });
            }
        });

        // 保存配置
        router.post('/config', async (req, res) => {
            try {
                const { 
                    repo_url, github_token, display_name, branch, is_authorized, 
                    autoSaveEnabled, autoSaveInterval, autoSaveTargetTag // 添加定时存档字段
                } = req.body; 
                let currentConfig = await readConfig();
                
                // 只更新传入的字段
                currentConfig.repo_url = repo_url !== undefined ? repo_url : currentConfig.repo_url;
                currentConfig.github_token = github_token !== undefined ? github_token : currentConfig.github_token;
                currentConfig.display_name = display_name !== undefined ? display_name : currentConfig.display_name;
                currentConfig.branch = branch !== undefined ? (branch.trim() || DEFAULT_BRANCH) : currentConfig.branch; 
                // is_authorized 只能在 authorize 接口中设为 true, 但可以被设为 false (例如登出)
                if (is_authorized !== undefined) {
                    currentConfig.is_authorized = !!is_authorized; 
                }
                // 新增：处理定时存档配置
                if (autoSaveEnabled !== undefined) {
                    currentConfig.autoSaveEnabled = !!autoSaveEnabled;
                }
                if (autoSaveInterval !== undefined) {
                    const interval = parseFloat(autoSaveInterval);
                    // 验证输入是否为有效正数
                    if (isNaN(interval) || interval <= 0) {
                        // 输入无效，返回错误
                        return res.status(400).json({ success: false, message: '无效的自动存档间隔。请输入一个大于 0 的数字。' });
                    }
                    // 输入有效，保存
                    currentConfig.autoSaveInterval = interval;
                }
                if (autoSaveTargetTag !== undefined) {
                    // 移除可能的空格，但不强制要求标签名格式
                    currentConfig.autoSaveTargetTag = autoSaveTargetTag.trim(); 
                }
                
                await saveConfig(currentConfig);
                
                // --- 新增：保存配置后重新设置后端定时器 ---
                setupBackendAutoSaveTimer();
                
                // 返回更新后的安全配置
                const safeConfig = {
                    repo_url: currentConfig.repo_url,
                    github_token: currentConfig.github_token ? '******' : '', // 仍然在此处屏蔽，但在authorize时不依赖它
                    display_name: currentConfig.display_name,
                    branch: currentConfig.branch,
                    is_authorized: currentConfig.is_authorized,
                    username: currentConfig.username,
                    // 新增：返回定时存档配置
                    autoSaveEnabled: currentConfig.autoSaveEnabled,
                    autoSaveInterval: currentConfig.autoSaveInterval,
                    autoSaveTargetTag: currentConfig.autoSaveTargetTag
                };
                res.json({ success: true, message: '配置保存成功', config: safeConfig });
            } catch (error) {
                console.error('[cloud-saves] 保存配置失败:', error);
                res.status(500).json({ success: false, message: '保存配置失败', error: error.message });
            }
        });

        // 授权检查和初始化 - 修改：授权成功后启动后端定时器
        router.post('/authorize', async (req, res) => {
            try {
                const { branch } = req.body; // 从请求体获取分支
                let config = await readConfig(); // 读取当前完整配置
                const targetBranch = branch || config.branch || DEFAULT_BRANCH; // 确定目标分支

                // 授权时必须有 URL 和 Token (从已保存的 config 读取)
                if (!config.repo_url || !config.github_token) {
                    return res.status(400).json({ success: false, message: '仓库URL和GitHub Token未配置，请先点击"配置"按钮保存设置' });
                }

                // 1. 更新配置中的分支 (如果提供了新的)
                if (branch && config.branch !== targetBranch) {
                    config.branch = targetBranch;
                    // 暂时不保存，等授权成功再保存
                }
                
                config.is_authorized = false; // 先标记为未授权

                // 2. 初始化Git仓库 (如果需要)
                const initResult = await initGitRepo();
                if (!initResult.success) {
                    return res.status(500).json({ success: false, message: initResult.message, details: initResult });
                }

                // 3. 配置远程仓库 (确保指向正确 URL)
                const remoteResult = await configureRemote(config.repo_url);
                if (!remoteResult.success) {
                    return res.status(500).json({ success: false, message: remoteResult.message, details: remoteResult });
                }

                // 4. 尝试访问远程仓库 (git fetch) - 修改：更精确的 fetch
                console.log("[cloud-saves] 检查远程连接并获取标签...");
                const fetchTagsResult = await runGitCommand('git fetch origin --tags --prune-tags'); // 获取所有标签，并清理不存在的远程标签
                if (!fetchTagsResult.success) {
                    await saveConfig(config); // 保存未授权状态
                    // 修改：返回 400 Bad Request 而不是 401
                    return res.status(400).json({ 
                        success: false, 
                        message: '配置错误或权限不足：无法访问远程仓库或获取标签，请检查URL、Token权限和分支名称。', 
                        details: fetchTagsResult 
                    });
                }
                console.log("[cloud-saves] 获取标签成功。");
                
                // 5. 检查目标分支是否存在于远程 (ls-remote 已经会使用 token)
                console.log(`[cloud-saves] 检查远程分支 ${targetBranch}...`);
                const checkRemoteBranchResult = await runGitCommand(`git ls-remote --heads origin ${targetBranch}`);
                const remoteBranchExists = checkRemoteBranchResult.success && checkRemoteBranchResult.stdout.includes(`refs/heads/${targetBranch}`);

                if (!remoteBranchExists) {
                    console.log(`[cloud-saves] 远程分支 ${targetBranch} 不存在，尝试创建...`);
                    // 尝试在本地创建一个空的提交（如果需要）并切换到该分支，然后推送到远程创建分支
                    try {
                        // 检查本地分支是否存在
                        const checkLocalBranchResult = await runGitCommand(`git show-ref --verify --quiet refs/heads/${targetBranch}`);
                        if (!checkLocalBranchResult.success) {
                            // 本地分支不存在，从当前 HEAD 创建
                            console.log(`[cloud-saves] 创建本地分支 ${targetBranch}...`);
                            const createLocalBranchResult = await runGitCommand(`git checkout -b ${targetBranch}`);
                            if (!createLocalBranchResult.success) throw new Error(`创建本地分支失败: ${createLocalBranchResult.stderr}`);
                        } else {
                            // 本地分支存在，切换过去
                            console.log(`[cloud-saves] 切换到本地分支 ${targetBranch}...`);
                            const switchBranchResult = await runGitCommand(`git checkout ${targetBranch}`);
                            if (!switchBranchResult.success) throw new Error(`切换到本地分支失败: ${switchBranchResult.stderr}`);
                        }
                        
                        // 推送以在远程创建分支
                        console.log(`[cloud-saves] 推送以创建远程分支 ${targetBranch}...`);
                        const pushNewBranchResult = await runGitCommand(`git push --set-upstream origin ${targetBranch}`);
                        if (!pushNewBranchResult.success) throw new Error(`推送创建远程分支失败: ${pushNewBranchResult.stderr}`);
                        console.log(`[cloud-saves] 远程分支 ${targetBranch} 创建成功`);
                    } catch (createBranchError) {
                        console.error(`[cloud-saves] 自动创建分支 ${targetBranch} 失败:`, createBranchError);
                        await saveConfig(config); // 保存未授权状态
                        return res.status(500).json({ success: false, message: `无法自动创建远程分支 ${targetBranch}，请手动创建或检查权限`, details: createBranchError.message });
                    }
                } else {
                    console.log(`[cloud-saves] 远程分支 ${targetBranch} 已存在`);
                     // 如果远程分支存在，确保本地也存在并跟踪它
                     const trackResult = await runGitCommand(`git branch --track ${targetBranch} origin/${targetBranch}`);
                     // 改进：检查更具体的错误消息
                     const trackError = trackResult.stderr.toLowerCase();
                     if (!trackResult.success && !trackError.includes('already exists') && !trackError.includes('already set up to track')) {
                          console.warn(`[cloud-saves] 设置本地分支跟踪远程分支时出错: ${trackResult.stderr}`);
                     }
                     // 切换到目标分支
                     const checkoutResult = await runGitCommand(`git checkout ${targetBranch}`);
                     if (!checkoutResult.success) {
                          console.error(`[cloud-saves] 切换到分支 ${targetBranch} 失败: ${checkoutResult.stderr}`);
                         await saveConfig(config); // 保存未授权状态
                         return res.status(500).json({ success: false, message: `无法切换到分支 ${targetBranch}`, details: checkoutResult.stderr });
                     }
                }

                // 6. 标记为已授权并保存最终配置
                config.is_authorized = true;
                config.branch = targetBranch; // 确认分支已保存
                
                // 可选：尝试获取GitHub用户名并保存
                try {
                    const validationResponse = await fetch('https://api.github.com/user', {
                        headers: { 'Authorization': `token ${github_token}` }
                    });
                    if (validationResponse.ok) {
                        const userData = await validationResponse.json();
                        config.username = userData.login || null;
                    }
                } catch (fetchUserError) {
                    console.warn('[cloud-saves] 获取GitHub用户名失败:', fetchUserError.message);
                }
                
                await saveConfig(config);
                
                // --- 新增：授权成功后启动后端定时器 ---
                setupBackendAutoSaveTimer();
                
                res.json({ success: true, message: '授权和配置成功', config: config });
            } catch (error) {
                // 授权失败时，确保定时器是停止的
                setupBackendAutoSaveTimer(); // 调用它会检查 is_authorized=false 并停止定时器
                res.status(500).json({ success: false, message: '授权过程中发生错误', error: error.message });
            }
        });

        // 获取Git状态
        router.get('/status', async (req, res) => {
            try {
                const status = await getGitStatus();
                const tempStashStatus = await checkTempStash();
                res.json({ success: true, status: { ...status, tempStash: tempStashStatus } });
            } catch (error) {
                res.status(500).json({ success: false, message: '获取状态失败', error: error.message });
            }
        });

        // 获取存档列表
        router.get('/saves', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            // 确保在获取前拉取最新的标签和分支信息
            const config = await readConfig();
            if (config.is_authorized) {
                 await runGitCommand('git fetch origin --tags');
                 const branch = config.branch || DEFAULT_BRANCH;
                 await runGitCommand(`git fetch origin ${branch}`); // 拉取当前分支的更新
            }
            try {
                const result = await listSaves();
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '获取存档列表失败', error: error.message });
            }
        });

        // 创建新存档 - 已修改为使用配置的分支
        router.post('/saves', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { name, description } = req.body;
                if (!name) {
                    return res.status(400).json({ success: false, message: '需要提供存档名称' });
                }
                const result = await createSave(name, description);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '创建存档失败', error: error.message });
            }
        });

        // 加载存档 - 已修改为在 detached HEAD 下工作
        router.post('/saves/load', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { tagName } = req.body;
                if (!tagName) {
                    return res.status(400).json({ success: false, message: '需要提供存档标签名' });
                }
                const result = await loadSave(tagName);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '加载存档失败', error: error.message });
            }
        });

        // 删除存档
        router.delete('/saves/:tagName', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { tagName } = req.params;
                if (!tagName) {
                    return res.status(400).json({ success: false, message: '需要提供存档标签名' });
                }
                const result = await deleteSave(tagName);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '删除存档失败', error: error.message });
            }
        });

        // 重命名存档
        router.put('/saves/:oldTagName', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { oldTagName } = req.params;
                const { newName, description } = req.body;
                if (!oldTagName || !newName) {
                    return res.status(400).json({ success: false, message: '需要提供旧存档标签名和新名称' });
                }
                const result = await renameSave(oldTagName, newName, description);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '重命名存档失败', error: error.message });
            }
        });

        // 获取存档差异
        router.get('/saves/diff', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const { tag1, tag2 } = req.query;
                if (!tag1 || !tag2) {
                    return res.status(400).json({ success: false, message: '需要提供两个存档标签名' });
                }
                const result = await getSaveDiff(tag1, tag2);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '获取存档差异失败', error: error.message });
            }
        });

        // 应用临时 Stash
        router.post('/stash/apply', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const result = await applyTempStash();
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '应用临时Stash失败', error: error.message });
            }
        });

        // 丢弃临时 Stash
        router.post('/stash/discard', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            try {
                const result = await discardTempStash();
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '丢弃临时Stash失败', error: error.message });
            }
        });

        // --- 新增：覆盖存档接口 ---
        router.post('/saves/:tagName/overwrite', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            currentOperation = 'overwrite_save'; // 设置操作状态
            try {
                const { tagName } = req.params;
                const config = await readConfig();

                if (!config.is_authorized) {
                    return res.status(401).json({ success: false, message: '未授权，请先连接仓库' });
                }

                console.log(`[cloud-saves] 准备覆盖存档: ${tagName}`);

                // 0. 获取旧标签的描述和创建者信息，以便尽可能保留
                let originalDescription = `Overwrite of ${tagName}`;
                const fetchTagInfoResult = await runGitCommand(`git tag -n1 -l "${tagName}" --format="%(contents)"`); 
                if (fetchTagInfoResult.success && fetchTagInfoResult.stdout.trim()) {
                    // 只取第一行作为基础描述，避免重复添加 Last Updated
                    originalDescription = fetchTagInfoResult.stdout.trim().split('\n')[0]; 
                }
                const displayName = config.display_name || config.username || 'Cloud Saves User';
                const placeholderEmail = 'cloud-saves@sillytavern.local';
                const gitConfigArgs = `-c user.name="${displayName}" -c user.email="${placeholderEmail}"`;
                const branchToUse = config.branch || DEFAULT_BRANCH;

                // 1. 添加当前所有更改到暂存区
                const addResult = await runGitCommand('git add -A');
                if (!addResult.success) throw new Error(`添加到暂存区失败: ${addResult.stderr}`);

                // 2. 检查是否有更改需要提交
                const statusResult = await runGitCommand('git status --porcelain');
                const hasChanges = statusResult.success && statusResult.stdout.trim() !== '';
                let newCommitHash = 'HEAD'; // 默认指向当前HEAD

                if (hasChanges) {
                    // 3. 创建新提交
                    const commitMessage = `Overwrite save: ${tagName}`; // 使用标签名，因为解码后的名字可能包含特殊字符
                    console.log(`[cloud-saves] 创建覆盖提交: "${commitMessage}"`);
                    const commitResult = await runGitCommand(`git ${gitConfigArgs} commit -m "${commitMessage}"`);
                    if (!commitResult.success) {
                        // 检查是否是因为 "nothing to commit" 错误
                        if (commitResult.stderr && commitResult.stderr.includes('nothing to commit')) {
                            console.log('[cloud-saves] 覆盖时无实际更改可提交，将使用当前 HEAD');
                            const headCommitResult = await runGitCommand('git rev-parse HEAD');
                            if (!headCommitResult.success) throw new Error('获取当前 HEAD 提交哈希失败');
                            newCommitHash = headCommitResult.stdout.trim();
                        } else {
                            throw new Error(`创建覆盖提交失败: ${commitResult.stderr}`);
                        }
                    } else {
                        // 获取新提交的哈希
                        const newCommitResult = await runGitCommand('git rev-parse HEAD');
                        if (!newCommitResult.success) throw new Error('获取新提交哈希失败');
                        newCommitHash = newCommitResult.stdout.trim();
                        console.log(`[cloud-saves] 新覆盖提交哈希: ${newCommitHash}`);
                        
                        // 4. 推送新提交到当前分支 (如果需要)
                        console.log(`[cloud-saves] 推送覆盖提交到分支: ${branchToUse}`);
                        const pushCommitResult = await runGitCommand(`git push origin ${branchToUse}`);
                        if (!pushCommitResult.success) {
                             console.warn(`[cloud-saves] 推送覆盖提交到分支 ${branchToUse} 失败:`, pushCommitResult.stderr);
                             // 根据策略决定是否继续 (例如，如果只是标签操作，可能可以继续)
                        }
                    }
                } else {
                     console.log('[cloud-saves] 覆盖时无实际更改可提交，将使用当前 HEAD');
                     const headCommitResult = await runGitCommand('git rev-parse HEAD');
                     if (!headCommitResult.success) throw new Error('获取当前 HEAD 提交哈希失败');
                     newCommitHash = headCommitResult.stdout.trim();
                }

                // 5. 删除旧标签 (本地和远程)
                console.log(`[cloud-saves] 删除旧标签 (本地): ${tagName}`);
                await runGitCommand(`git tag -d "${tagName}"`); // 忽略错误，可能本地不存在
                console.log(`[cloud-saves] 删除旧标签 (远程): ${tagName}`);
                const deleteRemoteResult = await runGitCommand(`git push origin :refs/tags/${tagName}`);
                 if (!deleteRemoteResult.success && !deleteRemoteResult.stderr.includes('remote ref does not exist')) {
                    console.warn(`[cloud-saves] 删除远程旧标签 ${tagName} 时遇到问题 (可能不存在或网络问题):`, deleteRemoteResult.stderr);
                 }

                // 6. 基于新提交创建同名新标签
                console.log(`[cloud-saves] 基于提交 ${newCommitHash} 创建新标签: ${tagName}`);
                const tagMessage = originalDescription; // 使用获取到的或默认的基础描述
                const nowTimestampOverwrite = new Date().toISOString();
                const fullTagMessageOverwrite = `${tagMessage}\nLast Updated: ${nowTimestampOverwrite}`;
                const newTagResult = await runGitCommand(`git ${gitConfigArgs} tag -a "${tagName}" -m "${fullTagMessageOverwrite}" ${newCommitHash}`);
                if (!newTagResult.success) {
                    // 如果创建失败，尝试恢复（可能比较困难，需要回滚提交等）
                    throw new Error(`创建新标签 ${tagName} 失败: ${newTagResult.stderr}`);
                }

                // 7. 推送新标签到远程
                console.log(`[cloud-saves] 推送新标签到远程: ${tagName}`);
                const pushNewTagResult = await runGitCommand(`git push origin "${tagName}"`);
                if (!pushNewTagResult.success) {
                     // 如果推送新标签失败，尝试回滚本地标签创建？
                     await runGitCommand(`git tag -d "${tagName}"`);
                    throw new Error(`推送新标签 ${tagName} 到远程失败: ${pushNewTagResult.stderr}`);
                }

                // 8. 更新 config 中的 last_save (如果适用)
                const saveNameMatch = tagName.match(/^save_\d+_(.+)$/);
                let saveName = tagName;
                if (saveNameMatch) { 
                    try {
                        saveName = Buffer.from(saveNameMatch[1], 'base64url').toString('utf8');
                    } catch (e) { /* ignore */ }
                }
                // 更新 last_save 时，使用更新后的时间戳和描述
                if (config.last_save && config.last_save.tag === tagName) {
                    config.last_save = { 
                        name: saveName, 
                        tag: tagName, 
                        timestamp: nowTimestampOverwrite, // 使用覆盖操作的时间
                        description: originalDescription // 使用基础描述
                    };
                    await saveConfig(config);
                }

                res.json({ success: true, message: '存档覆盖成功' });

            } catch (error) {
                console.error(`[cloud-saves] 覆盖存档 ${req.params.tagName} 失败:`, error);
                res.status(500).json({ success: false, message: `覆盖存档失败: ${error.message}`, error: error.message });
            } finally {
                currentOperation = null; // 释放操作状态
            }
        });

        // --- 新增：强制初始化仓库接口 ---
        router.post('/initialize', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            currentOperation = 'initialize_repo';
            try {
                console.log('[cloud-saves] 收到强制初始化仓库请求...');
                const config = await readConfig();

                // 强制删除可能的旧 .git 目录以确保全新初始化
                // **警告**: 这会删除 data 目录下的 Git 历史！
                const gitDirPath = path.join(DATA_DIR, '.git');
                try {
                    await fs.rm(gitDirPath, { recursive: true, force: true });
                    console.log(`[cloud-saves] 已强制删除旧的 ${gitDirPath} 目录`);
                } catch (rmError) {
                    // 如果删除失败（例如权限问题），记录错误但可能继续尝试 init
                    console.error(`[cloud-saves] 删除旧的 ${gitDirPath} 目录失败:`, rmError);
                }

                // 1. 执行 git init
                const initResult = await initGitRepo(); // 这个函数内部会处理已存在的情况，但我们上面强制删除了
                if (!initResult.success) {
                    return res.status(500).json({ success: false, message: `初始化Git仓库失败: ${initResult.message}`, details: initResult });
                }
                console.log('[cloud-saves] git init 成功');

                // 2. 配置远程仓库 (如果 URL 已配置)
                if (config.repo_url) {
                    console.log(`[cloud-saves] 配置远程仓库: ${config.repo_url}`);
                    const remoteResult = await configureRemote(config.repo_url);
                    if (!remoteResult.success) {
                        // 初始化成功，但配置远程失败，返回警告信息
                        return res.json({ 
                            success: true, 
                            message: '仓库初始化成功，但配置远程仓库失败，请检查仓库 URL。', 
                            warning: true, 
                            details: remoteResult 
                        });
                    }
                    console.log('[cloud-saves] 配置远程仓库成功');
                } else {
                    console.log('[cloud-saves] 未配置仓库 URL，跳过配置远程仓库');
                }

                res.json({ success: true, message: '仓库初始化成功' + (config.repo_url ? ' 并已配置远程仓库' : '') });

            } catch (error) {
                console.error('[cloud-saves] 初始化仓库时发生错误:', error);
                res.status(500).json({ success: false, message: `初始化仓库时发生错误: ${error.message}` });
            } finally {
                currentOperation = null;
            }
        });

        // --- 新增：插件初始化完成后启动定时器 ---
        setupBackendAutoSaveTimer();

        // --- 新增：检查和执行更新接口 ---
        router.post('/update/check-and-pull', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            }
            currentOperation = 'check_update';
            const pluginDir = __dirname; // 插件目录
            const targetRemote = 'https://github.com/fuwei99/cloud-saves.git'; // 目标更新源
            const targetBranch = 'main';

            try {
                console.log('[cloud-saves] 开始检查更新...');

                // 1. 检查插件目录是否为 Git 仓库
                const isRepoResult = await runGitCommand('git rev-parse --is-inside-work-tree', { cwd: pluginDir });
                if (!isRepoResult.success || isRepoResult.stdout.trim() !== 'true') {
                    console.warn('[cloud-saves] 插件目录不是有效的 Git 仓库，无法自动更新。');
                    return res.json({ success: true, status: 'not_git_repo', message: '无法自动更新：插件似乎不是通过 Git 安装的。' });
                }

                // 2. 检查远程地址是否匹配
                const remoteUrlResult = await runGitCommand('git remote get-url origin', { cwd: pluginDir });
                if (!remoteUrlResult.success || remoteUrlResult.stdout.trim() !== targetRemote) {
                    console.warn(`[cloud-saves] 插件仓库的远程地址 (${remoteUrlResult.stdout.trim()}) 与目标 (${targetRemote}) 不匹配，无法安全更新。`);
                     return res.json({ success: false, status: 'wrong_remote', message: `无法更新：插件远程地址 (${remoteUrlResult.stdout.trim() || '未设置'}) 与预期 (${targetRemote}) 不符。` });
                 }

                // 3. 获取本地 HEAD 哈希
                const localHeadResult = await runGitCommand('git rev-parse HEAD', { cwd: pluginDir });
                if (!localHeadResult.success) {
                    throw new Error('无法获取本地版本信息。');
                }
                const localHash = localHeadResult.stdout.trim();
                console.log(`[cloud-saves] 本地版本: ${localHash}`);

                // 4. 获取远程 HEAD 哈希
                console.log(`[cloud-saves] 获取远程 ${targetBranch} 分支版本...`);
                // 注意：ls-remote 不需要 token，因为是公共仓库
                const remoteHeadResult = await runGitCommand(`git ls-remote origin refs/heads/${targetBranch}`, { cwd: pluginDir });
                if (!remoteHeadResult.success || !remoteHeadResult.stdout.trim()) {
                     throw new Error(`无法获取远程 ${targetBranch} 分支版本信息。`);
                 }
                 // 修复：正确分割并获取哈希
                const remoteHash = remoteHeadResult.stdout.trim().split(/\s+/)[0]; // 使用正则表达式分割空白
                console.log(`[cloud-saves] 远程版本: ${remoteHash}`);

                // 5. 比较哈希
                if (localHash === remoteHash) {
                    console.log('[cloud-saves] 当前已是最新版本。');
                    return res.json({ success: true, status: 'latest', message: '已是最新版本。' });
                }

                // 6. 执行更新 (git pull)
                console.log('[cloud-saves] 检测到新版本，尝试执行 git pull...');
                const pullResult = await runGitCommand(`git pull origin ${targetBranch}`, { cwd: pluginDir });
                
                if (!pullResult.success) {
                    console.error('[cloud-saves] git pull 失败:', pullResult.stderr);
                     // 检查是否是本地更改冲突
                     if (pullResult.stderr.includes('Your local changes to the following files would be overwritten')) {
                         return res.json({ success: false, status: 'pull_failed_local_changes', message: '更新失败：您对插件文件进行了本地修改，请先处理或移除这些修改。' });
                     } else {
                         // 修复：确保返回正确的错误信息
                         return res.json({ 
                            success: false, 
                            status: 'pull_failed', 
                            message: `更新失败：执行 git pull 时出错。错误: ${pullResult.stderr || pullResult.error || '未知错误'}` 
                        });
                     }
                 }
                
                console.log('[cloud-saves] git pull 成功！');
                return res.json({ success: true, status: 'updated', message: '插件更新成功！请务必重启 SillyTavern 服务以应用更改。' });

            } catch (error) {
                console.error('[cloud-saves] 检查或执行更新时出错:', error);
                res.status(500).json({ success: false, status:'error', message: `检查更新时发生内部错误: ${error.message}` });
            } finally {
                currentOperation = null;
            }
        });
        
        // --- 初始化逻辑 --- (检查配置，连接远程等) - 修改：初始化后启动后端定时器
        const config = await readConfig();

    } catch (error) {
        console.error('[cloud-saves] 初始化失败:', error);
    }
}

// 插件导出对象 - 移除 router
const plugin = {
    info: info,
    init: init,
};

module.exports = plugin;
