// 云存档前端脚本
document.addEventListener('DOMContentLoaded', function() {
    // 全局变量
    let isAuthorized = false;
    let currentSaves = [];
    let confirmCallback = null;
    let renameTarget = null;

    // 获取DOM元素引用
    const authSection = document.getElementById('auth-section');
    const authForm = document.getElementById('auth-form');
    const authStatus = document.getElementById('auth-status');
    const repoUrlInput = document.getElementById('repo-url');
    const githubTokenInput = document.getElementById('github-token');
    const displayNameInput = document.getElementById('display-name');
    const authorizeBtn = document.getElementById('authorize-btn');
    const logoutBtn = document.getElementById('logout-btn');

    const createSaveSection = document.getElementById('create-save-section');
    const saveNameInput = document.getElementById('save-name');
    const saveDescriptionInput = document.getElementById('save-description');
    const createSaveBtn = document.getElementById('create-save-btn');

    const savesSection = document.getElementById('saves-section');
    const savesContainer = document.getElementById('saves-container');
    const noSavesMessage = document.getElementById('no-saves-message');
    const refreshSavesBtn = document.getElementById('refresh-saves-btn');
    const searchBox = document.getElementById('search-box');
    const sortSelector = document.getElementById('sort-selector');

    const stashNotification = document.getElementById('stash-notification');
    const applyStashBtn = document.getElementById('apply-stash-btn');
    const discardStashBtn = document.getElementById('discard-stash-btn');

    const gitStatus = document.getElementById('git-status');
    const changesStatus = document.getElementById('changes-status');
    const changesCount = document.getElementById('changes-count');
    const currentSaveStatus = document.getElementById('current-save-status');

    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingMessage = document.getElementById('loading-message');

    const renameModal = new bootstrap.Modal(document.getElementById('renameModal'));
    const renameTagNameInput = document.getElementById('rename-tag-name');
    const renameNewNameInput = document.getElementById('rename-new-name');
    const renameDescriptionInput = document.getElementById('rename-description');
    const confirmRenameBtn = document.getElementById('confirm-rename-btn');

    const confirmModal = new bootstrap.Modal(document.getElementById('confirmModal'));
    const confirmMessageText = document.getElementById('confirm-message');
    const confirmActionBtn = document.getElementById('confirm-action-btn');

    const diffModal = new bootstrap.Modal(document.getElementById('diffModal'));
    const diffSummary = document.getElementById('diff-summary');
    const diffFiles = document.getElementById('diff-files');

    // API调用工具函数
    async function apiCall(endpoint, method = 'GET', data = null) {
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        // 对于非GET请求，先获取CSRF令牌
        if (method !== 'GET' && method !== 'HEAD') {
            try {
                const csrfResponse = await fetch('/csrf-token');
                if (!csrfResponse.ok) {
                    throw new Error(`获取CSRF令牌失败: ${csrfResponse.statusText}`);
                }
                const csrfData = await csrfResponse.json();
                if (!csrfData || !csrfData.token) {
                    throw new Error('无效的CSRF令牌响应');
                }
                options.headers['X-CSRF-Token'] = csrfData.token;
            } catch (csrfError) {
                console.error('无法获取或设置CSRF令牌:', csrfError);
                showToast('错误', `无法执行操作，获取安全令牌失败: ${csrfError.message}`, 'error');
                throw csrfError; // 阻止后续请求
            }
        }

        if (data && (method === 'POST' || method === 'PUT')) {
            options.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(`/api/plugins/cloud-saves/${endpoint}`, options);
            // 检查是否是 CSRF 错误导致的 HTML 响应
            if (!response.ok && response.headers.get('content-type')?.includes('text/html')) {
                 if (response.status === 403) {
                     throw new Error('认证或权限错误 (403 Forbidden)。可能是CSRF令牌问题或GitHub Token权限不足。');
                 } else {
                    throw new Error(`请求失败，服务器返回了非JSON响应 (状态码: ${response.status})`);
                 }
            }
            
            const result = await response.json();
            
            if (!response.ok) {
                // 使用后端返回的 message 或构造一个
                throw new Error(result.message || `请求失败，状态码: ${response.status}`); 
            }
            
            return result;
        } catch (error) {
            console.error(`API调用失败 (${endpoint}):`, error);
            // 避免重复显示CSRF令牌获取失败的Toast
            if (!error.message.includes('安全令牌失败')) {
                 showToast('错误', `操作失败: ${error.message}`, 'error');
            }
            throw error;
        }
    }

    // 加载/显示函数
    function showLoading(message = '正在加载...') {
        loadingMessage.textContent = message;
        loadingOverlay.style.display = 'flex';
    }

    function hideLoading() {
        loadingOverlay.style.display = 'none';
    }

    function showToast(title, message, type = 'info') {
        const toastContainer = document.querySelector('.toast-container');
        
        const toast = document.createElement('div');
        toast.classList.add('toast', 'show');
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
        toast.setAttribute('aria-atomic', 'true');
        
        // 根据类型设置边框颜色
        if (type === 'success') {
            toast.style.borderLeft = '4px solid var(--bs-success)';
        } else if (type === 'error' || type === 'danger') {
            toast.style.borderLeft = '4px solid var(--bs-danger)';
        } else if (type === 'warning') {
            toast.style.borderLeft = '4px solid var(--bs-warning)';
        } else {
            toast.style.borderLeft = '4px solid var(--bs-primary)';
        }
        
        // 设置内容
        toast.innerHTML = `
            <div class="toast-header">
                <strong class="me-auto">${title}</strong>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
            <div class="toast-body">${message}</div>
        `;
        
        toastContainer.appendChild(toast);
        
        // 自动关闭
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 5000);
        
        // 点击关闭按钮
        toast.querySelector('.btn-close').addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);
        });
    }

    // 初始化
    async function init() {
        try {
            const config = await apiCall('config');
            
            if (config.repo_url) repoUrlInput.value = config.repo_url;
            if (config.github_token) githubTokenInput.value = config.github_token;
            if (config.display_name) displayNameInput.value = config.display_name;
            
            isAuthorized = config.is_authorized;
            
            updateAuthUI(isAuthorized);
            
            if (isAuthorized) {
                await refreshStatus();
                await loadSavesList();
            }
        } catch (error) {
            console.error('初始化失败:', error);
            showToast('错误', `初始化失败: ${error.message}`, 'error');
        }
    }

    // 更新授权UI
    function updateAuthUI(authorized) {
        if (authorized) {
            authStatus.innerHTML = `<i class="bi bi-check-circle-fill text-success me-2"></i>已成功授权`;
            authStatus.classList.remove('alert-danger');
            authStatus.classList.add('alert-success');
            authStatus.style.display = 'block';
            
            logoutBtn.style.display = 'inline-block';
            
            // 显示创建存档和存档列表部分
            createSaveSection.style.display = 'block';
            savesSection.style.display = 'block';
        } else {
            authStatus.style.display = 'none';
            logoutBtn.style.display = 'none';
            
            // 隐藏创建存档和存档列表部分
            createSaveSection.style.display = 'none';
            savesSection.style.display = 'none';
        }
    }

    // 刷新Git状态
    async function refreshStatus() {
        try {
            const statusResult = await apiCall('status');
            
            if (statusResult.success && statusResult.status) {
                const status = statusResult.status;
                
                // 更新Git初始化状态
                if (status.initialized) {
                    gitStatus.innerHTML = `<i class="bi bi-check-circle-fill text-success me-2"></i>Git仓库就绪`;
                } else {
                    gitStatus.innerHTML = `<i class="bi bi-circle-fill text-secondary me-2"></i>Git仓库未初始化`;
                }
                
                // 更新更改状态
                if (status.changes && status.changes.length > 0) {
                    changesCount.textContent = status.changes.length;
                    changesStatus.style.display = 'inline';
                } else {
                    changesStatus.style.display = 'none';
                }
                
                // 更新当前存档状态
                if (status.currentSave) {
                    const saveNameMatch = status.currentSave.tag.match(/^save_\d+_(.+)$/);
                    const saveName = saveNameMatch ? saveNameMatch[1] : status.currentSave.tag;
                    currentSaveStatus.innerHTML = `当前存档: <strong>${saveName}</strong>`;
                } else {
                    currentSaveStatus.textContent = '未加载任何存档';
                }
                
                // 检查临时stash状态
                if (status.tempStash && status.tempStash.exists) {
                    stashNotification.style.display = 'block';
                } else {
                    stashNotification.style.display = 'none';
                }
            }
        } catch (error) {
            console.error('刷新状态失败:', error);
            showToast('错误', `刷新状态失败: ${error.message}`, 'error');
        }
    }

    // 加载存档列表
    async function loadSavesList() {
        try {
            showLoading('正在获取存档列表...');
            
            const result = await apiCall('saves');
            
            if (result.success && result.saves) {
                currentSaves = result.saves;
                
                renderSavesList(currentSaves);
            } else {
                throw new Error(result.message || '获取存档列表失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('加载存档列表失败:', error);
            showToast('错误', `加载存档列表失败: ${error.message}`, 'error');
        }
    }

    // 渲染存档列表
    function renderSavesList(saves) {
        // 先清空容器
        while (savesContainer.firstChild) {
            savesContainer.removeChild(savesContainer.firstChild);
        }
        
        // 检查是否有存档
        if (saves.length === 0) {
            savesContainer.appendChild(noSavesMessage);
            return;
        }
        
        // 获取当前加载的存档
        let currentLoadedSave = null;
        
        apiCall('config').then(config => {
            if (config.current_save && config.current_save.tag) {
                currentLoadedSave = config.current_save.tag;
                
                // 更新已渲染的存档卡片
                const currentSaveCard = document.querySelector(`.save-card[data-tag="${currentLoadedSave}"]`);
                if (currentSaveCard) {
                    const badge = document.createElement('div');
                    badge.classList.add('save-current-badge');
                    badge.textContent = '当前存档';
                    currentSaveCard.appendChild(badge);
                }
            }
        });
        
        // 创建存档卡片
        saves.forEach(save => {
            const saveCard = document.createElement('div');
            saveCard.classList.add('card', 'save-card', 'mb-3');
            saveCard.dataset.tag = save.tag;
            
            const saveDate = new Date(save.timestamp);
            const formattedDate = saveDate.toLocaleString();
            const descriptionText = save.description || '无描述';
            const creatorName = save.creator || '未知';
            
            saveCard.innerHTML = `
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start">
                        <div style="flex-grow: 1; margin-right: 15px;">
                            <h5 class="card-title mb-1">${save.name}</h5>
                            <div class="save-timestamp mb-1">创建于 ${formattedDate}</div>
                            <div class="save-creator mb-2">操作人: ${creatorName}</div>
                            <div class="save-description">${descriptionText}</div>
                        </div>
                        <div class="action-buttons flex-shrink-0">
                            <button class="btn btn-sm btn-success load-save-btn" data-tag="${save.tag}" title="加载此存档">
                                <i class="bi bi-cloud-download"></i>
                            </button>
                            <button class="btn btn-sm btn-primary rename-save-btn" data-tag="${save.tag}" data-name="${save.name}" data-description="${descriptionText}" title="重命名此存档">
                                <i class="bi bi-pencil"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-info diff-save-btn" data-tag="${save.tag}" title="比较差异">
                                <i class="bi bi-file-diff"></i>
                            </button>
                            <button class="btn btn-sm btn-danger delete-save-btn" data-tag="${save.tag}" title="删除此存档">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
            
            // 如果是当前加载的存档，添加标记
            if (save.tag === currentLoadedSave) {
                const badge = document.createElement('div');
                badge.classList.add('save-current-badge');
                badge.textContent = '当前存档';
                saveCard.appendChild(badge);
            }
            
            savesContainer.appendChild(saveCard);
        });
        
        // 注册按钮事件
        registerSaveCardEvents();
    }
    
    // 注册存档卡片按钮事件
    function registerSaveCardEvents() {
        // 加载存档按钮
        document.querySelectorAll('.load-save-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const tagName = this.dataset.tag;
                showConfirmDialog(
                    `确认加载存档`,
                    `您确定要加载此存档吗？所有当前未保存的更改将被暂存。`,
                    async () => {
                        await loadSave(tagName);
                    }
                );
            });
        });
        
        // 重命名存档按钮
        document.querySelectorAll('.rename-save-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                renameTarget = this.dataset.tag;
                renameTagNameInput.value = renameTarget;
                renameNewNameInput.value = this.dataset.name || '';
                renameDescriptionInput.value = this.dataset.description || '';
                renameModal.show();
            });
        });
        
        // 删除存档按钮
        document.querySelectorAll('.delete-save-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const tagName = this.dataset.tag;
                showConfirmDialog(
                    `确认删除存档`,
                    `您确定要删除此存档吗？此操作无法撤销。`,
                    async () => {
                        await deleteSave(tagName);
                    }
                );
            });
        });
        
        // 比较差异按钮
        document.querySelectorAll('.diff-save-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const tagName = this.dataset.tag;
                // 再次尝试获取存档名称，添加日志调试
                const saveName = this.dataset.name;
                console.log('Comparing save:', tagName, 'Name from dataset:', saveName);
                if (!saveName) {
                    console.error('Could not retrieve save name from button dataset!');
                }
                
                try {
                    showLoading('正在加载差异...');
                    
                    // --- BEGIN REVERT DIFF LOGIC ---
                    // 恢复为比较标签和当前 HEAD
                    const tagRef1 = encodeURIComponent(tagName);
                    const tagRef2 = 'HEAD'; // 直接使用 HEAD
                    const result = await apiCall(`saves/diff?tag1=${tagRef1}&tag2=${tagRef2}`);
                    // --- END REVERT DIFF LOGIC ---
                    
                    if (result.success) {
                        // 更新模态框标题，确保 saveName 有值
                        const diffModalLabel = document.getElementById('diffModalLabel');
                        diffModalLabel.textContent = `存档 "${saveName || tagName}" 与当前状态的差异`; // 使用 tagname 作为备用
                        
                        // 隐藏统计信息区域 (保持不变)
                        diffSummary.innerHTML = ''; 
                        diffSummary.style.display = 'none'; 
                        
                        diffFiles.innerHTML = '';
                        if (result.changedFiles && result.changedFiles.length > 0) {
                           const fileList = document.createElement('ul');
                            fileList.classList.add('list-unstyled'); 
                            result.changedFiles.forEach(file => {
                                const li = document.createElement('li');
                                li.classList.add('mb-1');
                                let statusText = '';
                                let statusClass = '';
                                let statusIcon = ''; 
                                switch (file.status.charAt(0)) {
                                    case 'A': statusText = '添加'; statusClass = 'text-success'; statusIcon = '<i class="bi bi-plus-circle-fill me-2"></i>'; break;
                                    case 'M': statusText = '修改'; statusClass = 'text-warning'; statusIcon = '<i class="bi bi-pencil-fill me-2"></i>'; break;
                                    case 'D': statusText = '删除'; statusClass = 'text-danger'; statusIcon = '<i class="bi bi-trash-fill me-2"></i>'; break;
                                    case 'R': statusText = '重命名'; statusClass = 'text-info'; statusIcon = '<i class="bi bi-arrow-left-right me-2"></i>'; break;
                                    case 'C': statusText = '复制'; statusClass = 'text-info'; statusIcon = '<i class="bi bi-files me-2"></i>'; break;
                                    default: statusText = file.status; statusClass = 'text-secondary'; statusIcon = '<i class="bi bi-question-circle-fill me-2"></i>';
                                }
                                li.innerHTML = `<span class="${statusClass}" style="display: inline-block; width: 60px;">${statusIcon}${statusText}</span><code>${file.fileName}</code>`;
                                fileList.appendChild(li);
                            });
                            diffFiles.appendChild(fileList);
                        } else {
                            diffFiles.innerHTML = '<p class="text-center text-secondary mt-3">此存档与当前状态没有文件差异。</p>'; // 更新无差异消息
                        }
                        
                        hideLoading();
                        diffModal.show();
                    } else {
                        throw new Error(result.message || '获取差异失败');
                    }
                } catch (error) {
                    hideLoading();
                    console.error('获取差异失败:', error);
                    showToast('错误', `获取差异失败: ${error.message}`, 'error');
                }
            });
        });
    }

    // 加载存档
    async function loadSave(tagName) {
        try {
            showLoading('正在加载存档...');
            
            const result = await apiCall('saves/load', 'POST', { tagName });
            
            if (result.success) {
                showToast('成功', '存档加载成功', 'success');
                await refreshStatus();
                
                // 高亮当前加载的存档
                document.querySelectorAll('.save-current-badge').forEach(badge => badge.remove());
                
                const saveCard = document.querySelector(`.save-card[data-tag="${tagName}"]`);
                if (saveCard) {
                    const badge = document.createElement('div');
                    badge.classList.add('save-current-badge');
                    badge.textContent = '当前存档';
                    saveCard.appendChild(badge);
                }
            } else {
                throw new Error(result.message || '加载存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('加载存档失败:', error);
            showToast('错误', `加载存档失败: ${error.message}`, 'error');
        }
    }

    // 删除存档
    async function deleteSave(tagName) {
        try {
            showLoading('正在删除存档...');
            
            const result = await apiCall(`saves/${tagName}`, 'DELETE');
            
            if (result.success) {
                // 如果删除成功但有警告
                if (result.warning) {
                    showToast('警告', result.message, 'warning');
                } else {
                    showToast('成功', '存档已删除', 'success');
                }
                
                // 从列表移除
                currentSaves = currentSaves.filter(save => save.tag !== tagName);
                renderSavesList(currentSaves);
                
                // 刷新状态
                await refreshStatus();
            } else {
                throw new Error(result.message || '删除存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('删除存档失败:', error);
            showToast('错误', `删除存档失败: ${error.message}`, 'error');
        }
    }

    // 创建存档
    async function createSave(name, description) {
        try {
            if (!name || name.trim() === '') {
                showToast('错误', '存档名称不能为空', 'error');
                return;
            }
            
            showLoading('正在创建存档...');
            
            const result = await apiCall('saves', 'POST', {
                name: name,
                description: description
            });
            
            if (result.success) {
                showToast('成功', '存档创建成功', 'success');
                
                // 清空输入
                saveNameInput.value = '';
                saveDescriptionInput.value = '';
                
                // 刷新列表
                await loadSavesList();
                await refreshStatus();
            } else {
                throw new Error(result.message || '创建存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('创建存档失败:', error);
            showToast('错误', `创建存档失败: ${error.message}`, 'error');
        }
    }

    // 重命名存档
    async function renameSave(oldTagName, newName, description) {
        try {
            if (!newName || newName.trim() === '') {
                showToast('错误', '存档名称不能为空', 'error');
                return;
            }
            
            showLoading('正在重命名存档...');
            
            const result = await apiCall(`saves/${oldTagName}`, 'PUT', {
                newName: newName,
                description: description
            });
            
            if (result.success) {
                showToast('成功', '存档重命名成功', 'success');
                
                // 刷新列表
                await loadSavesList();
            } else {
                throw new Error(result.message || '重命名存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('重命名存档失败:', error);
            showToast('错误', `重命名存档失败: ${error.message}`, 'error');
        }
    }

    // 授权后端仓库
    async function authorize(repoUrl, token, displayName) {
        try {
            if (!repoUrl || !token) {
                showToast('错误', '仓库URL和访问令牌不能为空', 'error');
                return;
            }
            
            showLoading('正在连接仓库...');
            
            const result = await apiCall('authorize', 'POST', {
                repo_url: repoUrl,
                github_token: token,
                display_name: displayName
            });
            
            if (result.success) {
                isAuthorized = true;
                updateAuthUI(true);
                
                // 刷新状态
                await refreshStatus();
                // 获取存档列表
                await loadSavesList();
                
                showToast('成功', '仓库授权成功！', 'success');
            } else {
                throw new Error(result.message || '授权失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('授权失败:', error);
            
            authStatus.innerHTML = `<i class="bi bi-x-circle-fill text-danger me-2"></i>授权失败: ${error.message}`;
            authStatus.classList.remove('alert-success');
            authStatus.classList.add('alert-danger');
            authStatus.style.display = 'block';
            
            showToast('错误', `授权失败: ${error.message}`, 'error');
        }
    }

    // 登出/断开连接
    async function logout() {
        try {
            showLoading('正在断开连接...');
            
            await apiCall('config', 'POST', {
                is_authorized: false,
                github_token: '',
                display_name: displayNameInput.value
            });
            
            isAuthorized = false;
            updateAuthUI(false);
            githubTokenInput.value = '';
            
            hideLoading();
            showToast('成功', '已断开与仓库的连接', 'success');
        } catch (error) {
            hideLoading();
            console.error('断开连接失败:', error);
            showToast('错误', `断开连接失败: ${error.message}`, 'error');
        }
    }

    // 应用临时stash
    async function applyStash() {
        try {
            showLoading('正在恢复临时更改...');
            
            const result = await apiCall('stash/apply', 'POST');
            
            if (result.success) {
                stashNotification.style.display = 'none';
                showToast('成功', '临时更改已恢复', 'success');
                
                // 刷新状态
                await refreshStatus();
            } else {
                throw new Error(result.message || '恢复临时更改失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('恢复临时更改失败:', error);
            showToast('错误', `恢复临时更改失败: ${error.message}`, 'error');
        }
    }

    // 丢弃临时stash
    async function discardStash() {
        try {
            showLoading('正在丢弃临时更改...');
            
            const result = await apiCall('stash/discard', 'POST');
            
            if (result.success) {
                stashNotification.style.display = 'none';
                showToast('成功', '临时更改已丢弃', 'success');
                
                // 刷新状态
                await refreshStatus();
            } else {
                throw new Error(result.message || '丢弃临时更改失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('丢弃临时更改失败:', error);
            showToast('错误', `丢弃临时更改失败: ${error.message}`, 'error');
        }
    }

    // 显示确认对话框
    function showConfirmDialog(title, message, callback) {
        document.getElementById('confirmModalLabel').textContent = title;
        confirmMessageText.textContent = message;
        
        confirmCallback = callback;
        
        confirmModal.show();
    }

    // 过滤和排序存档列表
    function filterAndSortSaves() {
        if (!currentSaves || currentSaves.length === 0) return;
        
        const searchTerm = searchBox.value.toLowerCase();
        const sortMethod = sortSelector.value;
        
        // 筛选
        let filteredSaves = currentSaves;
        if (searchTerm) {
            filteredSaves = currentSaves.filter(save => 
                save.name.toLowerCase().includes(searchTerm) || 
                (save.description && save.description.toLowerCase().includes(searchTerm))
            );
        }
        
        // 排序
        filteredSaves.sort((a, b) => {
            switch (sortMethod) {
                case 'newest':
                    return new Date(b.timestamp) - new Date(a.timestamp);
                case 'oldest':
                    return new Date(a.timestamp) - new Date(b.timestamp);
                case 'name-asc':
                    return a.name.localeCompare(b.name);
                case 'name-desc':
                    return b.name.localeCompare(a.name);
                default:
                    return 0;
            }
        });
        
        renderSavesList(filteredSaves);
    }

    // 绑定事件
    authorizeBtn.addEventListener('click', () => {
        authorize(repoUrlInput.value, githubTokenInput.value, displayNameInput.value);
    });
    
    logoutBtn.addEventListener('click', () => {
        showConfirmDialog(
            '确认断开连接',
            '您确定要断开与仓库的连接吗？这将不会删除任何数据。',
            logout
        );
    });
    
    createSaveBtn.addEventListener('click', () => {
        createSave(saveNameInput.value, saveDescriptionInput.value);
    });
    
    confirmRenameBtn.addEventListener('click', () => {
        renameSave(renameTagNameInput.value, renameNewNameInput.value, renameDescriptionInput.value);
        renameModal.hide();
    });
    
    confirmActionBtn.addEventListener('click', () => {
        if (typeof confirmCallback === 'function') {
            confirmCallback();
        }
        confirmModal.hide();
    });
    
    refreshSavesBtn.addEventListener('click', loadSavesList);
    
    searchBox.addEventListener('input', filterAndSortSaves);
    
    sortSelector.addEventListener('change', filterAndSortSaves);
    
    applyStashBtn.addEventListener('click', applyStash);
    
    discardStashBtn.addEventListener('click', () => {
        showConfirmDialog(
            '确认丢弃临时更改',
            '您确定要丢弃所有临时保存的更改吗？此操作无法撤销。',
            discardStash
        );
    });

    // 初始化
    init();
}); 