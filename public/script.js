const scanBtn = document.getElementById('scanBtn');
const folderPathInput = document.getElementById('folderPath');
const folderSelectBtn = document.getElementById('folderSelectBtn');
const folderPicker = document.getElementById('folderPicker');
const loadingDiv = document.getElementById('loading');
const resultsDiv = document.getElementById('results');
const duplicatesList = document.getElementById('duplicatesList');
const deleteBtn = document.getElementById('deleteBtn');
const emptyState = document.getElementById('emptyState');

// Modal elements
const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalMessage = document.getElementById('modalMessage');
const modalCancelBtn = document.getElementById('modalCancelBtn');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');
const modalOkBtn = document.getElementById('modalOkBtn');

let currentDuplicates = [];
let modalResolve = null;

function normalizeFolderPathFromPicker(file) {
    if (!file || !file.path) return '';
    const normalized = file.path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return '';
    return normalized.slice(0, lastSlash);
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showModal(title, message, type = 'confirm') {
    return new Promise((resolve) => {
        modalTitle.textContent = title;
        modalMessage.textContent = message;
        modalOverlay.classList.remove('hidden');
        
        modalResolve = resolve;

        if (type === 'confirm') {
            modalCancelBtn.classList.remove('hidden');
            modalConfirmBtn.classList.remove('hidden');
            modalOkBtn.classList.add('hidden');
            modalConfirmBtn.focus();
        } else {
            modalCancelBtn.classList.add('hidden');
            modalConfirmBtn.classList.add('hidden');
            modalOkBtn.classList.remove('hidden');
            modalOkBtn.focus();
        }
    });
}

function closeModal() {
    modalOverlay.classList.add('hidden');
    modalResolve = null;
}

modalCancelBtn.addEventListener('click', () => {
    if (modalResolve) modalResolve(false);
    closeModal();
});

modalConfirmBtn.addEventListener('click', () => {
    if (modalResolve) modalResolve(true);
    closeModal();
});

modalOkBtn.addEventListener('click', () => {
    if (modalResolve) modalResolve(true);
    closeModal();
});

if (folderSelectBtn && folderPicker) {
    folderSelectBtn.addEventListener('click', () => {
        folderPicker.value = '';
        folderPicker.click();
    });

    folderPicker.addEventListener('change', async () => {
        if (!folderPicker.files.length) return;
        const selectedFolder = normalizeFolderPathFromPicker(folderPicker.files[0]);
        if (!selectedFolder) {
            await showModal('情報', 'ブラウザの制限によりフォルダパスを取得できません。手入力してください。', 'alert');
            return;
        }
        folderPathInput.value = selectedFolder;
    });
}

scanBtn.addEventListener('click', async () => {
    const path = folderPathInput.value.trim();
    if (!path) {
        await showModal('エラー', 'フォルダパスを入力してください', 'alert');
        return;
    }

    loadingDiv.classList.remove('hidden');
    resultsDiv.classList.add('hidden');
    emptyState.classList.add('hidden');
    scanBtn.disabled = true;

    try {
        const response = await fetch(`/api/scan?path=${encodeURIComponent(path)}`);
        const data = await response.json();

        if (data.error) {
            await showModal('エラー', 'スキャンエラー: ' + data.error, 'alert');
            return;
        }

        currentDuplicates = data.duplicates;
        renderResults();
    } catch (error) {
        await showModal('エラー', 'スキャン中にエラーが発生しました: ' + error.message, 'alert');
    } finally {
        loadingDiv.classList.add('hidden');
        scanBtn.disabled = false;
    }
});

function renderResults() {
    duplicatesList.innerHTML = '';
    
    if (currentDuplicates.length === 0) {
        emptyState.classList.remove('hidden');
        return;
    }

    resultsDiv.classList.remove('hidden');

    currentDuplicates.forEach((group) => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'duplicate-group';

        const infoDiv = document.createElement('div');
        infoDiv.className = 'group-info';
        infoDiv.innerHTML = `
            <span>サイズ: ${formatSize(group.size)}</span>
            <span>重複数: ${group.files.length}</span>
        `;
        groupDiv.appendChild(infoDiv);

        group.files.forEach(file => {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = file.path;
            checkbox.addEventListener('change', updateDeleteButton);

            const thumbWrapper = document.createElement('div');
            thumbWrapper.className = 'file-thumbnail';
            const preview = document.createElement('video');
            preview.src = `/api/video?path=${encodeURIComponent(file.path)}`;
            preview.preload = 'metadata';
            preview.muted = true;
            preview.playsInline = true;
            preview.setAttribute('tabindex', '-1');
            preview.addEventListener('loadedmetadata', () => {
                try {
                    if (preview.duration > 0.2) {
                        preview.currentTime = 0.1;
                    }
                } catch (_) {
                    // Ignore seek errors
                }
            });
            preview.addEventListener('seeked', () => {
                preview.pause();
            });
            thumbWrapper.appendChild(preview);

            const infoWrapper = document.createElement('div');
            infoWrapper.className = 'file-info';

            const pathSpan = document.createElement('span');
            pathSpan.className = 'file-path';
            pathSpan.textContent = file.path;

            const sizeSpan = document.createElement('span');
            sizeSpan.className = 'file-size';
            sizeSpan.textContent = `サイズ: ${formatSize(file.size)}`;

            infoWrapper.appendChild(pathSpan);
            infoWrapper.appendChild(sizeSpan);

            fileItem.appendChild(checkbox);
            fileItem.appendChild(thumbWrapper);
            fileItem.appendChild(infoWrapper);
            groupDiv.appendChild(fileItem);
        });

        duplicatesList.appendChild(groupDiv);
    });
    
    updateDeleteButton();
}

function updateDeleteButton() {
    const checked = document.querySelectorAll('input[type="checkbox"]:checked');
    deleteBtn.disabled = checked.length === 0;
    deleteBtn.textContent = checked.length > 0 ? `選択したファイルを削除 (${checked.length})` : '選択したファイルを削除';
}

deleteBtn.addEventListener('click', async () => {
    const checked = document.querySelectorAll('input[type="checkbox"]:checked');
    const filesToDelete = Array.from(checked).map(cb => cb.value);

    const confirmed = await showModal('確認', `${filesToDelete.length}個のファイルをゴミ箱に移動しますか？`, 'confirm');
    if (!confirmed) return;

    deleteBtn.disabled = true;
    deleteBtn.textContent = '削除中...';

    try {
        const response = await fetch('/api/delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ files: filesToDelete })
        });

        const data = await response.json();
        if (data.success) {
            await showModal('完了', '削除が完了しました', 'alert');
            // Re-scan automatically
            scanBtn.click(); 
        } else {
            let msg = '削除エラー: ' + (data.error || '不明なエラー');
            if (data.failedFiles) {
                msg += '\n\n以下のファイルは削除できませんでした:\n' + data.failedFiles.join('\n');
            }
            await showModal('エラー', msg, 'alert');
        }
    } catch (error) {
        await showModal('エラー', '削除中にエラーが発生しました: ' + error.message, 'alert');
    } finally {
        deleteBtn.disabled = false;
        updateDeleteButton(); // Reset button text
    }
});
