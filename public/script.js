// 数据同步前端脚本
document.addEventListener('DOMContentLoaded', function() {
    // 初始化Bootstrap组件 (假设 window.bootstrap 已由主应用或CDN加载)
    // No explicit initialization needed here if components are initialized via data attributes
    
    // 初始化界面元素
    initUI();
    
    // 绑定按钮事件
    bindEventListeners();
    
    // 加载配置
    loadConfig();
    
    // 检查Git状态
    checkGitStatus();
    
    // 检查GitHub授权状态
    checkAuthStatus();
});

// CSRF令牌
let csrfToken = '';

// 获取CSRF令牌
function getCSRFToken() {
    const metaTag = document.querySelector('meta[name="csrf-token"]');
    if (metaTag instanceof HTMLMetaElement) { 
        const tokenFromMeta = metaTag.getAttribute('content');
        if (tokenFromMeta) {
            csrfToken = tokenFromMeta;
            return Promise.resolve(csrfToken);
        }
    }
    
    // Fetch from the main application's endpoint
    return fetch('/csrf-token') // Correct endpoint
        .then(response => {
            if (!response.ok) {
                throw new Error(`获取CSRF令牌失败: ${response.status}`);
            }
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
                return response.json();
            } else {
                throw new Error('CSRF令牌响应不是有效的JSON');
            }
        })
        .then(data => {
            if (data && data.token && typeof data.token === 'string') { 
                csrfToken = data.token;
                let metaTagToUpdate = document.querySelector('meta[name="csrf-token"]');
                if (!metaTagToUpdate) {
                    metaTagToUpdate = document.createElement('meta');
                    if (metaTagToUpdate instanceof HTMLMetaElement) {
                         metaTagToUpdate.name = "csrf-token";
                         if (document.head) {
                             document.head.appendChild(metaTagToUpdate);
                         } else {
                             console.error('Cannot find document head to append CSRF meta tag');
                             throw new Error('Document head not found'); 
                         }
                    } else {
                         throw new Error('Failed to create meta tag element');
                    }
                }
                if (metaTagToUpdate instanceof HTMLMetaElement) {
                    metaTagToUpdate.setAttribute('content', csrfToken);
                }
                return csrfToken;
            } else {
                throw new Error('无法从响应中解析CSRF令牌或令牌格式无效');
            }
        })
        .catch(error => {
            console.error('获取CSRF令牌时出错:', error);
            csrfToken = ''; 
            throw error; 
        });
}

// API请求函数
// data parameter is expected to be an object for POST/PUT/PATCH, or null/undefined otherwise.
async function apiRequest(endpoint, method = 'GET', data = null) { 
    try {
        if (!csrfToken) {
             await getCSRFToken();
        }
        if (!csrfToken) {
            throw new Error('CSRF Token is still empty after fetch attempt');
        }
    } catch (error) {
        console.error('无法获取CSRF令牌，请求中止:', error);
        showToast('错误', '无法获取安全令牌，请刷新页面重试', 'danger');
        throw error instanceof Error ? error : new Error('CSRF Token acquisition failed');
    }
    
    const options = {
        method: method,
        headers: {
            'X-CSRF-Token': csrfToken
        },
        // 'same-origin' is the most common and secure default for credentials
        credentials: 'same-origin'
    };
    
    if (data && typeof data === 'object' && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(data);
    }
    
    let response;
    try {
        response = await fetch(`/api/plugins/data-sync${endpoint}`, options);
    } catch (networkError) {
        console.error('网络请求错误:', networkError);
        showToast('错误', '网络连接失败，请检查您的网络', 'danger');
        throw networkError;
    }
    
    if (!response.ok) {
        let errorText = `请求失败，状态码: ${response.status}`;
        try {
             const bodyText = await response.text();
             try {
                 const errorJson = JSON.parse(bodyText);
                 if (errorJson && errorJson.message) {
                     errorText = `请求失败 (${response.status}): ${errorJson.message}`; // Include status in message
                 } else if (bodyText) {
                     errorText = `请求失败 (${response.status}): ${bodyText}`; // Include status in message
                 }
             } catch(parseError) {
                 if (bodyText) { 
                    errorText = `请求失败 (${response.status}): ${bodyText}`; // Include status in message
                 }
             }
        } catch(readError) { 
             console.warn('读取错误响应体失败:', readError);
        }
        const apiError = new Error(errorText); // Error message now contains status
        showToast('错误', errorText, 'danger'); 
        throw apiError; 
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        const text = await response.text();
        try {
            return text ? JSON.parse(text) : {}; 
        } catch (parseError) {
            console.error('无法解析JSON响应:', parseError, '响应体:', text);
            showToast('错误', '收到无效的服务器响应', 'danger');
            throw new Error('无效的JSON响应');
        }
    } else if (response.status === 204) { 
        return {}; 
    }
    
    try {
         return await response.text();
    } catch (readError) {
        console.error('无法读取响应文本:', readError);
        showToast('错误', '无法读取服务器响应', 'danger');
        throw new Error('无法读取响应');
    }
}

// 初始化UI
function initUI() {
    const autoSyncCheckbox = document.getElementById('auto_sync');
    const syncIntervalContainer = document.getElementById('sync_interval_container');
    
    if (autoSyncCheckbox instanceof HTMLInputElement && syncIntervalContainer instanceof HTMLElement) {
        syncIntervalContainer.style.display = autoSyncCheckbox.checked ? 'block' : 'none'; 
        autoSyncCheckbox.addEventListener('change', function() {
            syncIntervalContainer.style.display = this.checked ? 'block' : 'none';
        });
    } else {
        console.warn('自动同步复选框或间隔容器未找到');
    }
    
    const toggleTokenBtn = document.getElementById('toggle_token_visibility');
    const tokenInput = document.getElementById('github_token_input');
    
    if (toggleTokenBtn instanceof HTMLButtonElement && tokenInput instanceof HTMLInputElement) {
        toggleTokenBtn.addEventListener('click', function() {
            const currentType = tokenInput.getAttribute('type');
            const newType = currentType === 'password' ? 'text' : 'password';
            tokenInput.setAttribute('type', newType);
            const iconElement = this.querySelector('i'); 
            if (iconElement instanceof HTMLElement) { 
                 iconElement.className = newType === 'password' ? 'bi bi-eye' : 'bi bi-eye-slash';
            }
        });
    } else {
        console.warn('令牌可见性切换按钮或输入框未找到');
    }
    
    // 每30秒检查一次撤销按钮状态
    checkUndoAvailability();
    setInterval(checkUndoAvailability, 30000);
}

// 绑定事件监听器
function bindEventListeners() {
    const bindClick = (id, handler) => {
        const element = document.getElementById(id);
        if (element instanceof HTMLElement) { 
            element.addEventListener('click', handler);
        } else {
            console.warn(`无法绑定点击事件: 未找到ID为 '${id}' 的元素`);
        }
    };

    bindClick('save_config_btn', saveConfig);
    bindClick('init_repo_btn', initRepo);
    bindClick('sync_to_remote_btn', syncToRemote);
    bindClick('sync_from_remote_btn', syncFromRemote);
    bindClick('authorize_btn', authorizeGitHub);
    bindClick('set_token_btn', setGitHubToken);
    bindClick('undo_sync_btn', undoLastSync);
    bindClick('force_push_btn', forcePush);
    bindClick('force_pull_btn', forcePull);
    
    checkOAuthCallback();
}

// 加载配置
async function loadConfig() {
    try {
        showSpinner('git_status', true, true); 
        const config = await apiRequest('/config');
        
        const repoUrlInput = document.getElementById('repo_url');
        const branchInput = document.getElementById('branch');
        const autoSyncCheckbox = document.getElementById('auto_sync');
        const syncIntervalContainer = document.getElementById('sync_interval_container');
        const syncIntervalInput = document.getElementById('sync_interval');
        const lastSyncTimeElement = document.getElementById('last_sync_time');

        if (config && typeof config === 'object' && // Ensure config is an object
            repoUrlInput instanceof HTMLInputElement && 
            branchInput instanceof HTMLInputElement && 
            autoSyncCheckbox instanceof HTMLInputElement && 
            syncIntervalContainer instanceof HTMLElement && 
            syncIntervalInput instanceof HTMLInputElement && 
            lastSyncTimeElement instanceof HTMLElement) {
                
            repoUrlInput.value = config.repoUrl || '';
            branchInput.value = config.branch || 'main';
            autoSyncCheckbox.checked = !!config.autoSync; 
            syncIntervalContainer.style.display = autoSyncCheckbox.checked ? 'block' : 'none';
            syncIntervalInput.value = config.syncInterval || '60';
            
            if (config.lastSync) {
                const lastSyncDate = new Date(config.lastSync);
                lastSyncTimeElement.textContent = !isNaN(lastSyncDate.getTime()) 
                    ? lastSyncDate.toLocaleString() 
                    : '无效日期';
            } else {
                lastSyncTimeElement.textContent = '从未同步';
            }
            
            updateTokenStatus(!!config.hasToken); 
        } else {
            console.warn('加载配置时部分UI元素未找到或配置数据无效');
        }
    } catch (error) {
        console.error('加载配置失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `加载配置失败: ${message}`, 'danger');
    } finally {
        // Let checkGitStatus handle the final spinner state for git_status
    }
}

// 保存配置
async function saveConfig() {
    const repoUrlInput = document.getElementById('repo_url');
    const branchInput = document.getElementById('branch');
    const autoSyncCheckbox = document.getElementById('auto_sync');
    const syncIntervalInput = document.getElementById('sync_interval');

    if (!(repoUrlInput instanceof HTMLInputElement) || 
        !(branchInput instanceof HTMLInputElement) || 
        !(autoSyncCheckbox instanceof HTMLInputElement) || 
        !(syncIntervalInput instanceof HTMLInputElement)) {
        console.error('无法找到配置表单元素');
        showToast('错误', '无法保存配置，请刷新页面重试', 'danger');
        return;
    }

    try {
        const syncIntervalValue = parseInt(syncIntervalInput.value, 10);
        if (isNaN(syncIntervalValue) || syncIntervalValue < 5) {
            showToast('警告', '同步间隔必须是大于或等于5的整数', 'warning');
            syncIntervalInput.focus(); 
            return; 
        }

        const configData = {
            repoUrl: repoUrlInput.value.trim(), 
            branch: branchInput.value.trim() || 'main', 
            autoSync: autoSyncCheckbox.checked,
            syncInterval: syncIntervalValue
        };
        
        showSpinner('save_config_btn', true);
        // Explicitly pass the object data here for clarity
        await apiRequest('/config', 'POST', configData); 
        showToast('成功', '配置保存成功', 'success');
        
        await checkGitStatus(); 
    } catch (error) {
        console.error('保存配置失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `保存配置失败: ${message}`, 'danger');
    } finally {
        showSpinner('save_config_btn', false);
    }
}

// 检查Git状态
async function checkGitStatus() {
    const statusElement = document.getElementById('git_status');
    if (!(statusElement instanceof HTMLElement)) {
        console.warn('Git状态元素未找到');
        return; 
    }

    let isInitialized = false; 
    try {
        showSpinner('git_status', true, true); 
        const status = await apiRequest('/git/status');
        
        if (status && typeof status === 'object') {
            let statusHtml = '';
            isInitialized = !!status.initialized;
            
            if (status.initialized) {
                statusHtml = `<span class="badge text-bg-success status-badge">已初始化</span>`; 
            } else {
                statusHtml = `<span class="badge text-bg-warning status-badge">未初始化</span>`;
            }
            
            if (Array.isArray(status.changes) && status.changes.length > 0) {
                statusHtml += ` <span class="badge text-bg-info status-badge">${status.changes.length}个文件有变化</span>`;
            }
            
            statusElement.innerHTML = statusHtml;
        } else {
             statusElement.innerHTML = `<span class="badge text-bg-secondary status-badge">状态未知</span>`;
        }
    } catch (error) {
        console.error('检查Git状态失败:', error);
        // Check the error message for status code if needed (removed direct status property)
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('404')) { // Simple check for 404 in message
             statusElement.innerHTML = `<span class="badge text-bg-warning status-badge">未初始化</span>`;
             isInitialized = false;
        } else {
            statusElement.innerHTML = `<span class="badge text-bg-danger status-badge">检查错误</span>`;
            isInitialized = false; 
        }
    } finally {
        updateButtonsState(isInitialized);
        showSpinner('git_status', false, true);
    }
}

// 初始化仓库
async function initRepo() {
    try {
        showSpinner('init_repo_btn', true);
        await apiRequest('/git/init', 'POST');
        showToast('成功', '仓库初始化成功', 'success');
        await checkGitStatus(); 
    } catch (error) {
        console.error('初始化仓库失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `初始化仓库失败: ${message}`, 'danger');
    } finally {
        showSpinner('init_repo_btn', false);
    }
}

// 同步到远程
async function syncToRemote() {
    try {
        showSpinner('sync_to_remote_btn', true);
        
        // 发起同步请求
        const response = await apiRequest('/git/sync/push', 'POST');
        
        // 检查是否有警告
        if (response && response.warning === 'local_state_not_restored') {
            showToast('警告', '同步成功，但无法恢复本地状态。您的更改保存在stash中。请手动恢复。', 'warning');
        } else {
            showToast('成功', '成功同步到远程仓库', 'success');
        }
        
        // 检查撤销可用性
        if (response && response.undoAvailable) {
            updateUndoButton('push', true);
        }
        
        await Promise.all([
            checkGitStatus(),
            loadConfig() 
        ]);
    } catch (error) {
        console.error('同步到远程失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        
        // 特殊处理需要用户干预的错误 (检查状态码 409)
        if (message.includes('(409)')) { // 修改判断条件，只检查状态码
            // 检查是合并冲突还是非快进
            if (message.includes('合并冲突') || message.toLowerCase().includes('merge conflict')) { // 保留对消息内容的检查以区分不同 409
                 await handleMergeConflict();
            } else if (message.includes('非快进') || message.toLowerCase().includes('non_fast_forward') || message.toLowerCase().includes('updates were rejected')) {
                 await handleNonFastForward();
            } else {
                // 未知类型的 409 错误，也显示通用冲突处理
                console.warn('Unknown 409 conflict type, showing generic merge conflict handler:', message);
                await handleMergeConflict(); 
            }
        } 
        else {
            showToast('错误', `同步到远程失败: ${message}`, 'danger');
        }
    } finally {
        showSpinner('sync_to_remote_btn', false);
    }
}

// 处理非快进错误
async function handleNonFastForward() {
    return new Promise((resolve) => {
        showConfirmDialog({
            title: '推送被拒绝',
            message: `远程仓库包含您本地没有的更新。请选择操作：`,
            confirmText: '强制推送',
            cancelText: '取消',
            type: 'warning',
            confirmButtonClass: 'btn-danger'
        }).then(async (result) => {
            if (result) {
                // 用户选择强制推送
                try {
                    showSpinner('sync_to_remote_btn', true);
                    showToast('信息', '正在强制推送...', 'info');
                    
                    const result = await apiRequest('/git/sync/force-overwrite-remote', 'POST');
                    showToast('成功', '强制推送成功', 'success');
                    
                    await Promise.all([
                        checkGitStatus(),
                        loadConfig()
                    ]);
                } catch (error) {
                    console.error('强制推送失败:', error);
                    const errMsg = error instanceof Error ? error.message : String(error);
                    showToast('错误', `强制推送失败: ${errMsg}`, 'danger');
                } finally {
                    showSpinner('sync_to_remote_btn', false);
                    resolve('force-push');
                }
            } else {
                // 用户取消
                showToast('信息', '推送已取消，建议先进行同步拉取', 'info');
                resolve('cancel');
            }
        });
    });
}

// 从远程同步
async function syncFromRemote() {
    try {
        showSpinner('sync_from_remote_btn', true);
        
        // 发起同步请求（现在默认使用合并策略）
        const response = await apiRequest('/git/sync/pull', 'POST');
        
        showToast('成功', '成功从远程仓库同步', 'success');
        
        // 检查撤销可用性
        if (response && response.undoAvailable) {
            updateUndoButton('pull', true);
        }
        
        await Promise.all([
            checkGitStatus(),
            loadConfig() 
        ]);
    } catch (error) {
        console.error('从远程同步失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        
        // 特殊处理需要用户干预的错误 (检查状态码 409)
        if (message.includes('(409)')) { // 修改判断条件，只检查状态码
            // 假定 pull 操作的 409 都是合并冲突
            await handleMergeConflict();
        } else {
            showToast('错误', `从远程同步失败: ${message}`, 'danger');
        }
    } finally {
        showSpinner('sync_from_remote_btn', false);
    }
}

// 处理合并冲突
async function handleMergeConflict() {
    const dialogElement = document.getElementById('confirmDialog');
    if (!(dialogElement instanceof HTMLElement)) {
        console.error('确认对话框元素未找到');
        showToast('错误', '无法显示冲突解决对话框，请刷新页面重试', 'danger');
        return;
    }

    // 设置对话框内容
    const titleElement = document.getElementById('confirmDialogLabel');
    const messageElement = document.getElementById('confirm-dialog-message');
    const confirmButton = document.getElementById('confirm-dialog-confirm-btn');
    const cancelButton = document.getElementById('confirm-dialog-cancel-btn');
    const iconElement = document.getElementById('confirm-dialog-icon');
    const modalFooter = confirmButton?.parentElement;

    // 创建"以本地覆盖远程"按钮
    const overwriteRemoteButton = document.createElement('button');
    overwriteRemoteButton.type = 'button';
    overwriteRemoteButton.className = 'btn btn-warning';
    overwriteRemoteButton.textContent = '以本地覆盖远程';
    overwriteRemoteButton.id = 'overwrite-remote-btn';

    if (titleElement instanceof HTMLElement) {
        titleElement.textContent = '合并冲突';
    }
    if (messageElement instanceof HTMLElement) {
        messageElement.innerHTML = `
            <p>同步过程中发生<strong>合并冲突</strong>！</p>
            <p>请选择如何解决此冲突：</p>
            <ul>
                <li><strong>以远程覆盖本地</strong>：放弃本地更改，完全采用远程版本</li>
                <li><strong>以本地覆盖远程</strong>：保留本地更改，强制推送到远程</li>
                <li><strong>取消同步</strong>：保持当前状态，稍后手动解决</li>
            </ul>
        `;
    }
    if (confirmButton instanceof HTMLElement) {
        confirmButton.textContent = '以远程覆盖本地';
        confirmButton.className = 'btn btn-danger';
    }
    if (cancelButton instanceof HTMLElement) {
        cancelButton.textContent = '取消同步';
        cancelButton.className = 'btn btn-secondary';
    }
    if (iconElement instanceof HTMLElement) {
        iconElement.innerHTML = '<i class="bi bi-exclamation-triangle-fill text-warning" style="font-size: 2.5rem;"></i>';
    }
    
    // 添加"以本地覆盖远程"按钮到对话框
    if (modalFooter instanceof HTMLElement && confirmButton && cancelButton) {
        // 移除之前可能存在的按钮
        const existingButton = document.getElementById('overwrite-remote-btn');
        if (existingButton) {
            existingButton.remove();
        }
        
        // 在确认和取消按钮之间插入新按钮
        modalFooter.insertBefore(overwriteRemoteButton, cancelButton);
    }

    // 显示对话框
    let dialog = null;
    if (typeof window.bootstrap !== 'undefined' && typeof window.bootstrap.Modal === 'function') {
        try {
            console.log('[handleMergeConflict] Attempting to initialize Bootstrap modal for #confirmDialog');
            dialog = new window.bootstrap.Modal(dialogElement);
            console.log('[handleMergeConflict] Modal initialized, attempting to show...');
            dialog.show();
            console.log('[handleMergeConflict] Modal show() called.');
        } catch (modalError) {
             console.error('[handleMergeConflict] Error initializing or showing Bootstrap modal:', modalError);
             showToast('错误', '无法初始化或显示冲突对话框', 'danger');
             // 如果模态框显示失败，直接返回，避免后续逻辑出错
             // 可以考虑 resolve('error') 或 reject()，但这里简单返回
             return;
        }
    } else {
        console.error('Bootstrap Modal 组件未找到');
        showToast('错误', '无法显示冲突解决对话框', 'danger');
        return; // Bootstrap 未加载，直接返回
    }

    // 等待用户选择
    return new Promise((resolve) => {
        const handleOverwriteLocal = async () => {
            dialog.hide();
            cleanupEventListeners();
            
            try {
                showSpinner('sync_from_remote_btn', true);
                showToast('信息', '正在以远程覆盖本地...', 'info');
                
                const result = await apiRequest('/git/sync/force-overwrite-local', 'POST');
                showToast('成功', '已成功用远程内容覆盖本地', 'success');
                
                await Promise.all([
                    checkGitStatus(),
                    loadConfig()
                ]);
            } catch (error) {
                console.error('强制覆盖本地失败:', error);
                const errMsg = error instanceof Error ? error.message : String(error);
                showToast('错误', `强制覆盖本地失败: ${errMsg}`, 'danger');
            } finally {
                showSpinner('sync_from_remote_btn', false);
                resolve('overwrite-local');
            }
        };

        const handleOverwriteRemote = async () => {
            dialog.hide();
            cleanupEventListeners();
            
            try {
                showSpinner('sync_from_remote_btn', true);
                showToast('信息', '正在以本地覆盖远程...', 'info');
                
                const result = await apiRequest('/git/sync/force-overwrite-remote', 'POST');
                showToast('成功', '已成功用本地内容覆盖远程', 'success');
                
                await Promise.all([
                    checkGitStatus(),
                    loadConfig()
                ]);
            } catch (error) {
                console.error('强制覆盖远程失败:', error);
                const errMsg = error instanceof Error ? error.message : String(error);
                showToast('错误', `强制覆盖远程失败: ${errMsg}`, 'danger');
            } finally {
                showSpinner('sync_from_remote_btn', false);
                resolve('overwrite-remote');
            }
        };

        const handleCancel = () => {
            dialog.hide();
            cleanupEventListeners();
            showToast('信息', '同步已取消', 'info');
            resolve('cancel');
        };

        // 处理模态框隐藏事件
        const hiddenHandler = () => {
            cleanupEventListeners();
            resolve('cancel');
        };

        // 清理事件监听器
        const cleanupEventListeners = () => {
            if (confirmButton instanceof HTMLElement) {
                confirmButton.removeEventListener('click', handleOverwriteLocal);
            }
            if (overwriteRemoteButton instanceof HTMLElement) {
                overwriteRemoteButton.removeEventListener('click', handleOverwriteRemote);
            }
            if (cancelButton instanceof HTMLElement) {
                cancelButton.removeEventListener('click', handleCancel);
            }
            dialogElement.removeEventListener('hidden.bs.modal', hiddenHandler);
        };

        // 添加事件监听器
        if (confirmButton instanceof HTMLElement) {
            confirmButton.addEventListener('click', handleOverwriteLocal);
        }
        overwriteRemoteButton.addEventListener('click', handleOverwriteRemote);
        if (cancelButton instanceof HTMLElement) {
            cancelButton.addEventListener('click', handleCancel);
        }
        dialogElement.addEventListener('hidden.bs.modal', hiddenHandler);
    });
}

// 设置GitHub令牌
async function setGitHubToken() {
    const tokenInput = document.getElementById('github_token_input');
    if (!(tokenInput instanceof HTMLInputElement)) {
        console.warn('GitHub令牌输入框未找到');
        return;
    }

    const token = tokenInput.value.trim();
    if (!token) {
        showToast('警告', '请输入GitHub令牌', 'warning');
        tokenInput.focus();
        return;
    }
        
    try {
        showSpinner('set_token_btn', true);
        // Ensure data is passed as an object
        await apiRequest('/auth/token', 'POST', { token: token }); 
        showToast('成功', 'GitHub令牌设置成功', 'success');
        updateTokenStatus(true);
        await checkAuthStatus();
        tokenInput.value = ''; 
        
        // Attempt to close the modal using standard checks
        if (typeof window.bootstrap !== 'undefined' && window.bootstrap.Modal) {
            const tokenModalElement = document.getElementById('tokenModal');
            if (tokenModalElement) {
                 // Use window.bootstrap directly
                 const tokenModalInstance = window.bootstrap.Modal.getInstance(tokenModalElement); 
                 if (tokenModalInstance) {
                     tokenModalInstance.hide();
                 }
            } else {
                 console.warn('令牌模态框元素未找到');
            }
        } else {
             console.warn('Bootstrap Modal component not available to close modal.');
        }
    } catch (error) {
        console.error('设置GitHub令牌失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `设置GitHub令牌失败: ${message}`, 'danger');
    } finally {
        showSpinner('set_token_btn', false);
    }
}

// 更新令牌状态
function updateTokenStatus(hasToken) {
    const tokenStatus = document.getElementById('github_token_status');
    if (tokenStatus instanceof HTMLElement) {
        tokenStatus.innerHTML = hasToken 
            ? `<span class="badge text-bg-success status-badge">已设置</span>` 
            : `<span class="badge text-bg-danger status-badge">未设置</span>`;
    }
}

// 更新按钮状态 (基于仓库是否初始化)
function updateButtonsState(isRepoInitialized) {
    const initRepoBtn = document.getElementById('init_repo_btn');
    const syncToRemoteBtn = document.getElementById('sync_to_remote_btn');
    const syncFromRemoteBtn = document.getElementById('sync_from_remote_btn');
    const forcePushBtn = document.getElementById('force_push_btn');
    const forcePullBtn = document.getElementById('force_pull_btn');

    // 始终启用初始化按钮
    if (initRepoBtn instanceof HTMLButtonElement) {
        initRepoBtn.disabled = false; 
    }
    // 其他按钮依赖于仓库初始化状态
    const disableIfNotInit = !isRepoInitialized;
    if (syncToRemoteBtn instanceof HTMLButtonElement) {
        syncToRemoteBtn.disabled = disableIfNotInit;
    }
    if (syncFromRemoteBtn instanceof HTMLButtonElement) {
        syncFromRemoteBtn.disabled = disableIfNotInit;
    }
    if (forcePushBtn instanceof HTMLButtonElement) {
        forcePushBtn.disabled = disableIfNotInit;
    }
    if (forcePullBtn instanceof HTMLButtonElement) {
        forcePullBtn.disabled = disableIfNotInit;
    }
}

// 授权GitHub
function authorizeGitHub() {
    window.location.href = '/api/plugins/data-sync/auth/github/authorize';
}

// 检查授权状态
async function checkAuthStatus() {
    const authStatusElement = document.getElementById('auth_status');
    const authorizeBtn = document.getElementById('authorize_btn');
    if (!(authStatusElement instanceof HTMLElement)) {
         console.warn('授权状态元素未找到');
         return;
    }

    let isAuthorized = false;
    try {
        const status = await apiRequest('/auth/status');
        
        if (status && typeof status === 'object' && status.authorized) {
            isAuthorized = true;
            authStatusElement.innerHTML = 
                `<span class="badge text-bg-success status-badge">已授权</span> ${status.username || ''}`;
        } else {
            authStatusElement.innerHTML = 
                `<span class="badge text-bg-warning status-badge">未授权</span>`;
        }
    } catch (error) {
        console.error('检查授权状态失败:', error);
        authStatusElement.innerHTML = `<span class="badge text-bg-danger status-badge">检查错误</span>`;
        isAuthorized = false; 
    } finally {
         if (authorizeBtn instanceof HTMLButtonElement) {
             authorizeBtn.disabled = isAuthorized;
         }
    }
}

// 检查OAuth回调
function checkOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    
    if (code && state) {
        window.history.replaceState({}, document.title, window.location.pathname);
        handleOAuthCallback(code, state);
    }
}

// 处理OAuth回调
async function handleOAuthCallback(code, state) {
    try {
        showToast('信息', '正在处理GitHub授权...', 'info');
        // Ensure data is passed as an object
        const result = await apiRequest('/auth/github/callback', 'POST', { code: code, state: state }); 
        
        if (result && result.success) {
            showToast('成功', 'GitHub授权成功', 'success');
            await checkAuthStatus(); 
        } else {
            const message = (result && result.message) ? result.message : '未知错误';
            showToast('错误', `授权失败: ${message}`, 'danger');
        }
    } catch (error) {
        console.error('处理OAuth回调失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `授权处理失败: ${message}`, 'danger');
    }
}

// 显示加载中的旋转器
function showSpinner(elementId, show, isStatusCheck = false) { 
    const element = document.getElementById(elementId);
    if (!(element instanceof HTMLElement)) return; 
    
    const spinnerHtml = `
        <div class="spinner-border spinner-border-sm" role="status" aria-hidden="true"> 
            <span class="visually-hidden">加载中...</span>
        </div>
    `;

    if (show) {
        const currentContent = element.innerHTML.trim();
        if (!element.hasAttribute('data-original-content') && !currentContent.includes('spinner-border')) {
             element.setAttribute('data-original-content', currentContent);
        }
        
        if (isStatusCheck) {
            const statusText = element.hasAttribute('data-original-content') && element.getAttribute('data-original-content') 
                               ? element.getAttribute('data-original-content') 
                               : '检查中...';
             element.innerHTML = spinnerHtml + `<span class="ms-1">${statusText}</span>`;
        } else {
             element.innerHTML = spinnerHtml + '<span class="ms-1">处理中...</span>';
        }
        
        if (element instanceof HTMLButtonElement) {
             element.disabled = true;
        }
    } else {
        const originalContent = element.getAttribute('data-original-content');
        if (originalContent !== null) { 
            element.innerHTML = originalContent;
            element.removeAttribute('data-original-content');
        } else if (isStatusCheck) {
             element.innerHTML = '<span class="text-muted">-</span>';
        } 
        
        if (element instanceof HTMLButtonElement) {
             element.disabled = false;
        }
    }
}

// 显示消息提示
function showToast(title, message, type) {
    const toastContainer = document.getElementById('toast-container');
    if (!(toastContainer instanceof HTMLElement)) {
        console.error('Toast container not found!');
        return;
    }
    
    const safeTitle = String(title).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const safeMessage = String(message).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Basic validation for type to prevent unexpected classes
    const allowedTypes = ['success', 'info', 'warning', 'danger', 'primary', 'secondary', 'light', 'dark'];
    const safeType = allowedTypes.includes(type) ? type : 'secondary'; // Default to secondary

    const toastId = 'toast-' + Date.now();
    const toastHtml = `
        <div id="${toastId}" class="toast fade" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="toast-header text-white text-bg-${safeType}">
                <strong class="me-auto">${safeTitle}</strong>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast" aria-label="关闭"></button>
            </div>
            <div class="toast-body">
                ${safeMessage}
            </div>
        </div>
    `;
    
    toastContainer.insertAdjacentHTML('beforeend', toastHtml);
    
    const toastElement = document.getElementById(toastId);
    
    // Check if Bootstrap and Toast constructor are available using standard checks
    if (toastElement instanceof HTMLElement && 
        typeof window.bootstrap !== 'undefined' && 
        typeof window.bootstrap.Toast === 'function') {
            
        try {
             // Use window.bootstrap directly
            const toast = new window.bootstrap.Toast(toastElement, { 
                autohide: true, 
                delay: 5000 
            });
            toast.show();
            
            toastElement.addEventListener('hidden.bs.toast', function handleHide() {
                toastElement.removeEventListener('hidden.bs.toast', handleHide);
                if (toastElement.parentNode) {
                    toastElement.parentNode.removeChild(toastElement);
                }
            });
        } catch (e) {
             console.error('创建或显示 Bootstrap Toast 时出错:', e);
             if (toastElement.parentNode) {
                toastElement.parentNode.removeChild(toastElement);
             }
        }
    } else {
         console.error('无法找到 toast 元素或 Bootstrap Toast 组件。Toast 消息可能无法显示。');
         // Attempt to remove manually after a delay as a fallback
         if (toastElement && toastElement.parentNode) {
             setTimeout(() => {
                if (toastElement.parentNode) toastElement.parentNode.removeChild(toastElement);
             }, 5500); // Slightly longer than delay
         }
    }
}

// 显示确认对话框
function showConfirmDialog(options) {
    return new Promise((resolve, reject) => {
        const dialogElement = document.getElementById('confirmDialog');
        if (!(dialogElement instanceof HTMLElement)) {
            console.error('确认对话框元素未找到');
            // 回退到原生 confirm
            if (window.confirm(options.message)) {
                resolve(true);
            } else {
                resolve(false);
            }
            return;
        }

        // 设置对话框内容
        const titleElement = document.getElementById('confirmDialogLabel');
        const messageElement = document.getElementById('confirm-dialog-message');
        const confirmButton = document.getElementById('confirm-dialog-confirm-btn');
        const cancelButton = document.getElementById('confirm-dialog-cancel-btn');
        const iconElement = document.getElementById('confirm-dialog-icon');

        // 防止元素不存在导致错误
        if (titleElement instanceof HTMLElement) {
            titleElement.textContent = options.title || '确认操作';
        }
        if (messageElement instanceof HTMLElement) {
            messageElement.textContent = options.message || '';
        }
        if (confirmButton instanceof HTMLElement) {
            confirmButton.textContent = options.confirmText || '确认';
            confirmButton.className = 'btn ' + (options.confirmButtonClass || 'btn-primary');
        }
        if (cancelButton instanceof HTMLElement) {
            cancelButton.textContent = options.cancelText || '取消';
            cancelButton.className = 'btn ' + (options.cancelButtonClass || 'btn-secondary');
        }
        if (iconElement instanceof HTMLElement) {
            let iconClass = 'bi bi-question-circle-fill text-primary';
            if (options.type === 'warning') {
                iconClass = 'bi bi-exclamation-triangle-fill text-warning';
            } else if (options.type === 'danger') {
                iconClass = 'bi bi-exclamation-circle-fill text-danger';
            } else if (options.type === 'info') {
                iconClass = 'bi bi-info-circle-fill text-info';
            } else if (options.type === 'success') {
                iconClass = 'bi bi-check-circle-fill text-success';
            }
            iconElement.innerHTML = `<i class="${iconClass}" style="font-size: 2.5rem;"></i>`;
        }

        // 创建并显示模态框
        let dialog = null;
        if (typeof window.bootstrap !== 'undefined' && typeof window.bootstrap.Modal === 'function') {
            dialog = new window.bootstrap.Modal(dialogElement);
            dialog.show();
        } else {
            console.error('Bootstrap Modal 组件未找到');
            // 回退到原生 confirm
            if (window.confirm(options.message)) {
                resolve(true);
            } else {
                resolve(false);
            }
            return;
        }

        // 处理按钮点击事件
        const confirmHandler = () => {
            dialog.hide();
            cleanupEventListeners();
            resolve(true);
        };

        const cancelHandler = () => {
            dialog.hide();
            cleanupEventListeners();
            resolve(false);
        };

        // 处理模态框隐藏事件
        const hiddenHandler = () => {
            cleanupEventListeners();
            resolve(false);
        };

        // 清理事件监听器
        const cleanupEventListeners = () => {
            if (confirmButton instanceof HTMLElement) {
                confirmButton.removeEventListener('click', confirmHandler);
            }
            if (cancelButton instanceof HTMLElement) {
                cancelButton.removeEventListener('click', cancelHandler);
            }
            dialogElement.removeEventListener('hidden.bs.modal', hiddenHandler);
        };

        // 添加事件监听器
        if (confirmButton instanceof HTMLElement) {
            confirmButton.addEventListener('click', confirmHandler);
        }
        if (cancelButton instanceof HTMLElement) {
            cancelButton.addEventListener('click', cancelHandler);
        }
        dialogElement.addEventListener('hidden.bs.modal', hiddenHandler);
    });
}

// 撤销上次同步操作
async function undoLastSync() {
    try {
        // 显示确认对话框
        const confirmed = await showConfirmDialog({
            title: '撤销同步',
            message: '您确定要撤销上次同步操作吗？这将恢复到同步前的状态。',
            confirmText: '确认撤销',
            cancelText: '取消',
            type: 'warning',
            confirmButtonClass: 'btn-danger'
        });
        
        if (!confirmed) {
            return;
        }
        
        // 显示加载状态
        showSpinner('undo_sync_btn', true);
        const undoContainer = document.getElementById('undo_sync_container');
        if (undoContainer) {
            undoContainer.querySelector('small').textContent = '正在撤销...';
        }
        
        // 执行撤销
        const result = await apiRequest('/undo-sync', 'POST');
        
        if (result && result.success) {
            const operationText = result.operation === 'push' ? '推送' : '拉取';
            showToast('成功', `成功撤销了上次${operationText}操作`, 'success');
            
            // 更新状态
            updateUndoButton(null, false);
            await checkGitStatus();
        } else {
            // 处理 stash apply 失败的特殊情况
            if (result && result.error === 'stash_apply_failed') {
                 showToast('警告', '撤销成功，但恢复本地更改时可能发生冲突。请检查您的文件状态，或使用git stash list查看并手动恢复。', 'warning');
                 updateUndoButton(null, false); // 撤销操作本身算完成
                 await checkGitStatus();
            } else {
                showToast('错误', result.message || '撤销操作失败', 'danger');
                // 撤销失败时，可能需要重新检查撤销可用性
                await checkUndoAvailability();
            }
        }
    } catch (error) {
        console.error('撤销同步失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `撤销同步失败: ${message}`, 'danger');
        // 撤销失败时，可能需要重新检查撤销可用性
        await checkUndoAvailability();
    } finally {
        showSpinner('undo_sync_btn', false);
    }
}

// 检查是否有可撤销的操作
async function checkUndoAvailability() {
    try {
        const result = await apiRequest('/undo-availability', 'GET');
        
        if (result && result.available) {
            updateUndoButton(result.operation, true, result.timestamp);
        } else {
            updateUndoButton(null, false);
        }
    } catch (error) {
        console.error('检查撤销可用性失败:', error);
        // 失败时不显示撤销按钮
        updateUndoButton(null, false);
    }
}

// 更新撤销按钮状态
function updateUndoButton(operation, available, timestamp) {
    const container = document.getElementById('undo_sync_container');
    const infoText = document.getElementById('undo_sync_info');
    
    if (!container || !infoText) {
        console.warn('撤销按钮容器或信息文本未找到');
        return;
    }
    
    if (!available) {
        container.style.display = 'none';
        return;
    }
    
    container.style.display = 'block';
    
    let operationText = '';
    if (operation === 'push') {
        operationText = '推送到远程';
    } else if (operation === 'pull') {
        operationText = '从远程拉取';
    } else if (operation === 'force-push') {
        operationText = '强制推送';
    } else if (operation === 'force-pull') {
        operationText = '强制拉取';
    } else {
        operationText = '同步';
    }
    
    let timeText = '';
    if (timestamp) {
        try {
            const syncTime = new Date(timestamp);
            timeText = syncTime.toLocaleString();
        } catch (e) {
            timeText = timestamp;
        }
    }
    
    infoText.textContent = `可撤销最近一次${operationText}操作${timeText ? ` (${timeText})` : ''}`;
}

// 新增：强制推送到远程
async function forcePush() {
    try {
        const confirmed = await showConfirmDialog({
            title: '确认强制推送',
            message: '警告：此操作将强制用您的本地数据覆盖远程仓库！远程仓库中任何本地没有的更改都将丢失。此操作通常用于解决合并冲突，请谨慎使用。您确定要继续吗？',
            confirmText: '确认强制推送',
            cancelText: '取消',
            type: 'danger',
            confirmButtonClass: 'btn-danger'
        });

        if (!confirmed) {
            showToast('信息', '强制推送已取消', 'info');
            return;
        }

        showSpinner('force_push_btn', true);
        const response = await apiRequest('/git/sync/force-overwrite-remote', 'POST');
        showToast('成功', '强制推送成功，远程仓库已更新为本地状态', 'success');

        if (response && response.undoAvailable) {
            updateUndoButton('force-push', true); // Pass a distinct operation type
        }

        await Promise.all([
            checkGitStatus(),
            loadConfig()
        ]);

    } catch (error) {
        console.error('强制推送失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `强制推送失败: ${message}`, 'danger');
    } finally {
        showSpinner('force_push_btn', false);
    }
}

// 新增：强制从远程拉取（覆盖本地）
async function forcePull() {
    try {
        const confirmed = await showConfirmDialog({
            title: '确认强制拉取',
            message: '警告：此操作将强制用远程仓库的数据覆盖您的本地数据！所有本地未推送的更改和未追踪的文件都将丢失。此操作通常用于解决合并冲突或同步初始化，请谨慎使用。您确定要继续吗？',
            confirmText: '确认强制拉取',
            cancelText: '取消',
            type: 'danger', // Use danger for potentially destructive action
            confirmButtonClass: 'btn-danger'
        });

        if (!confirmed) {
            showToast('信息', '强制拉取已取消', 'info');
            return;
        }

        showSpinner('force_pull_btn', true);
        const response = await apiRequest('/git/sync/force-overwrite-local', 'POST');
        showToast('成功', '强制拉取成功，本地数据已更新为远程状态', 'success');

         if (response && response.undoAvailable) {
            updateUndoButton('force-pull', true); // Pass a distinct operation type
        }

        await Promise.all([
            checkGitStatus(),
            loadConfig()
        ]);

    } catch (error) {
        console.error('强制拉取失败:', error);
        const message = error instanceof Error ? error.message : String(error);
        showToast('错误', `强制拉取失败: ${message}`, 'danger');
    } finally {
        showSpinner('force_pull_btn', false);
    }
} 