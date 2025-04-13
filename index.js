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
};

// 当前操作状态
let currentOperation = null;

// ========== 配置管理 ==========

// 读取配置
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        // 如果配置文件不存在，创建默认配置
        await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return { ...DEFAULT_CONFIG };
    }
}

// 保存配置
async function saveConfig(config) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ========== Git 操作核心功能 ==========

// 执行git命令
async function runGitCommand(command, options = {}) {
    let config = {};
    let originalRepoUrl = '';
    let tokenUrl = '';
    let temporarilySetUrl = false;

    try {
        config = await readConfig();
        const token = config.github_token;
        originalRepoUrl = config.repo_url;

        // 特殊处理推送/拉取/获取时使用token
        if (token && originalRepoUrl && originalRepoUrl.startsWith('https://') && 
            (command.startsWith('git push') || command.startsWith('git pull') || command.startsWith('git fetch'))) {
            if (!originalRepoUrl.includes('@github.com')) {
                tokenUrl = originalRepoUrl.replace('https://', `https://x-access-token:${token}@`);
                
                console.log(`[cloud-saves] 临时设置带token的remote URL，执行命令: ${command}`);
                const setUrlResult = await execPromise(`git remote set-url origin ${tokenUrl}`, { cwd: DATA_DIR });
                console.log('[cloud-saves] set-url (with token) stdout:', setUrlResult.stdout);
                console.log('[cloud-saves] set-url (with token) stderr:', setUrlResult.stderr);
                temporarilySetUrl = true;
            }
        }

        // 对clone命令也要修改URL
        if (token && originalRepoUrl && originalRepoUrl.startsWith('https://') && command.startsWith('git clone')) {
            if (!originalRepoUrl.includes('@github.com')) {
                tokenUrl = originalRepoUrl.replace('https://', `https://x-access-token:${token}@`);
                command = command.replace(originalRepoUrl, tokenUrl);
            }
        }

        // 记录要执行的命令
        console.log(`[cloud-saves] 执行命令: ${command}`);

        // 处理选项参数
        const execOptions = { 
            cwd: options.cwd || DATA_DIR 
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
            
            // 如果临时设置了URL，命令完成后恢复
            if (temporarilySetUrl) {
                console.log(`[cloud-saves] 恢复原始remote URL: ${originalRepoUrl}`);
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
        console.error(`Git命令失败: ${command}\n错误: ${error.message}\nStdout: ${stdoutLog}\nStderr: ${stderrLog}`);
        
        // 如果临时设置了URL且命令失败，尝试恢复
        if (temporarilySetUrl) {
            try {
                console.warn(`[cloud-saves] 命令失败，尝试恢复原始remote URL: ${originalRepoUrl}`);
                await execPromise(`git remote set-url origin ${originalRepoUrl}`, { cwd: DATA_DIR });
                temporarilySetUrl = false;
            } catch (revertError) {
                console.error(`[cloud-saves] 恢复remote URL失败: ${revertError.message}`);
            }
        }

        return { 
            success: false, 
            error: error.message,
            stdout: error.stdout || '',
            stderr: error.stderr || ''
        };
    } finally {
        // 最终安全检查：确保URL被恢复
        if (temporarilySetUrl) {
            try {
                console.warn(`[cloud-saves] 最终检查：在finally块中恢复remote URL: ${originalRepoUrl}`);
                await execPromise(`git remote set-url origin ${originalRepoUrl}`, { cwd: DATA_DIR });
            } catch (finalRevertError) {
                console.error(`[cloud-saves] 在finally块中恢复remote URL失败: ${finalRevertError.message}`);
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
        console.log(`[cloud-saves] 用于创建标签的消息: "${tagMessage}"`);
        const tagResult = await runGitCommand(`git ${gitConfigArgs} tag -a "${tagName}" -m "${tagMessage}"`);
        if (!tagResult.success) return { success: false, message: '创建存档标签失败', details: tagResult };

        console.log('[cloud-saves] 推送更改...');
        // --- BEGIN DETACHED HEAD PUSH FIX ---
        // 检查是否处于 detached HEAD 状态
        const symbolicRefResult = await runGitCommand('git symbolic-ref --short -q HEAD');
        const isOnBranch = symbolicRefResult.success && symbolicRefResult.stdout.trim() !== '';
        let currentBranch = '';
        
        if (isOnBranch) {
             currentBranch = symbolicRefResult.stdout.trim();
             console.log(`[cloud-saves] 当前位于分支: ${currentBranch}`);
             if (commitNeeded) {
                 console.log(`[cloud-saves] 推送分支: ${currentBranch}`);
                 const pushBranchResult = await runGitCommand(`git push origin ${currentBranch}`);
                 if (!pushBranchResult.success) console.warn(`[cloud-saves] 推送分支 ${currentBranch} 失败:`, pushBranchResult.stderr);
             }
        } else {
            console.log('[cloud-saves] 当前处于 detached HEAD 状态，跳过推送分支。');
        }
        // --- END DETACHED HEAD PUSH FIX ---

        const pushTagResult = await runGitCommand(`git push origin "${tagName}"`);
        if (!pushTagResult.success) return { success: false, message: '推送存档标签到远程失败', details: pushTagResult };

        config.last_save = { name: name, tag: tagName, timestamp: new Date().toISOString(), description: description || '' };
        await saveConfig(config);

        // 返回原始名称给前端
        return { success: true, message: '存档创建成功', saveData: { ...config.last_save, name: name } };
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

        // 修改 format，添加 %(taggername)
        const formatString = "%(refname:short)%00%(creatordate:iso)%00%(taggername)%00%(subject)%00%(body)";
        const listTagsResult = await runGitCommand(`git tag -l "save_*" --sort=-creatordate --format="${formatString}"`);
        if (!listTagsResult.success) return { success: false, message: '获取存档标签列表失败', details: listTagsResult };

        const saves = listTagsResult.stdout.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\0');
            // 现在应该有 5 个部分
            if (parts.length < 5) return null; 
            
            const tagName = parts[0];
            const timestamp = parts[1];
            const taggerName = parts[2] || '未知'; // 获取 tagger 名称
            const description = parts[4] || parts[3]; // subject/body 作为描述
            let name = tagName;

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
                timestamp: new Date(timestamp).toISOString(),
                description: description.trim(),
                creator: taggerName // <-- 添加创建者字段
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

        // 4. 切换到标签指向的提交
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

        const checkTagResult = await runGitCommand(`git tag -l "${oldTagName}"`);
        if (!checkTagResult.success || !checkTagResult.stdout.trim()) return { success: false, message: '找不到指定的存档', details: checkTagResult };

        const tagCommitResult = await runGitCommand(`git rev-list -n 1 "${oldTagName}"`);
        if (!tagCommitResult.success) return { success: false, message: '获取存档提交失败', details: tagCommitResult };
        
        const commit = tagCommitResult.stdout.trim();

        // 使用 Base64 编码新名称
        const encodedNewName = Buffer.from(newName).toString('base64url');
        const tagMatch = oldTagName.match(/^save_(\d+)_/);
        const timestamp = tagMatch ? tagMatch[1] : Date.now();
        const newTagName = `save_${timestamp}_${encodedNewName}`;

        const tagMessage = description || `存档: ${newName}`; 

        const tagResult = await runGitCommand(`git ${gitConfigArgs} tag -a "${newTagName}" -m "${tagMessage}" ${commit}`);
        if (!tagResult.success) return { success: false, message: '创建新存档标签失败', details: tagResult };

        const pushTagResult = await runGitCommand(`git push origin "${newTagName}"`);
        if (!pushTagResult.success) {
            await runGitCommand(`git tag -d "${newTagName}"`);
            return { success: false, message: '推送新存档标签到远程失败', details: pushTagResult };
        }

        await runGitCommand(`git tag -d "${oldTagName}"`);
        await runGitCommand(`git push origin :refs/tags/${oldTagName}`);

        if (config.current_save && config.current_save.tag === oldTagName) {
            config.current_save.tag = newTagName;
            await saveConfig(config);
        }

        // 返回原始新名称给前端
        return { success: true, message: '存档重命名成功', oldTag: oldTagName, newTag: newTagName, newName: newName };
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
                // 返回安全配置，包含 display_name
                const safeConfig = {
                    repo_url: config.repo_url || '',
                    github_token: config.github_token ? '******' : '', // Mask token
                    display_name: config.display_name || '',
                    is_authorized: config.is_authorized || false,
                    username: config.username || null // Keep GitHub username if fetched
                };
                res.json(safeConfig);
            } catch (error) {
                res.status(500).json({ success: false, message: '读取配置失败', error: error.message });
            }
        });

        // 保存配置
        router.post('/config', async (req, res) => {
            try {
                const { repo_url, github_token, display_name, is_authorized } = req.body;
                let currentConfig = await readConfig();
                // 只更新前端会修改的字段，保留内部字段
                currentConfig.repo_url = repo_url !== undefined ? repo_url : currentConfig.repo_url;
                currentConfig.github_token = github_token !== undefined ? github_token : currentConfig.github_token;
                currentConfig.display_name = display_name !== undefined ? display_name : currentConfig.display_name;
                currentConfig.is_authorized = is_authorized !== undefined ? is_authorized : currentConfig.is_authorized;
                
                await saveConfig(currentConfig);
                res.json({ success: true, message: '配置保存成功' });
            } catch (error) {
                res.status(500).json({ success: false, message: '保存配置失败', error: error.message });
            }
        });

        // 授权检查和初始化
        router.post('/authorize', async (req, res) => {
            try {
                const { repo_url, github_token, display_name } = req.body;
                let config = await readConfig();

                if (!repo_url || !github_token) {
                    return res.status(400).json({ success: false, message: '需要提供仓库URL和GitHub Token' });
                }

                config.repo_url = repo_url;
                config.github_token = github_token;
                config.display_name = display_name || '';
                config.is_authorized = false;

                const initResult = await initGitRepo();
                if (!initResult.success) {
                    return res.status(500).json({ success: false, message: initResult.message, details: initResult });
                }

                const remoteResult = await configureRemote(repo_url);
                if (!remoteResult.success) {
                    return res.status(500).json({ success: false, message: remoteResult.message, details: remoteResult });
                }

                const fetchResult = await runGitCommand('git fetch origin');
                if (!fetchResult.success) {
                    await saveConfig(config);
                    return res.status(401).json({ success: false, message: '授权失败：无法访问远程仓库，请检查URL和Token权限', details: fetchResult });
                }

                config.is_authorized = true;
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
                res.json({ success: true, message: '授权和配置成功', config: config });
            } catch (error) {
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
            try {
                const result = await listSaves();
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '获取存档列表失败', error: error.message });
            }
        });

        // 创建新存档
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

        // 加载存档
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

        // --- 初始化逻辑 --- (检查配置，连接远程等)
        const config = await readConfig();
        console.log('[cloud-saves] 配置加载成功:', config);
        await initGitRepo();
        if (config.repo_url && config.is_authorized) {
            console.log('[cloud-saves] 检测到已授权的仓库，尝试连接...');
            const remoteResult = await runGitCommand('git remote -v');
            if (!remoteResult.success || !remoteResult.stdout.includes('origin')) {
                console.warn('[cloud-saves] 未配置远程仓库或无法获取，尝试重新配置');
                await configureRemote(config.repo_url);
            }
            const fetchResult = await runGitCommand('git fetch origin');
            if (!fetchResult.success) {
                console.error('[cloud-saves] 无法连接到配置的远程仓库，可能需要重新授权。');
                config.is_authorized = false;
                await saveConfig(config);
            } else {
                console.log('[cloud-saves] 成功连接到远程仓库。');
            }
        }

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
