const Bookmarks = (() => {
  let bookmarks = [];
  let expanded = localStorage.getItem('quicklinksExpanded') === '1';

  function groupBy(arr) {
    return arr.reduce((acc, item) => {
      const g = item.group_name || 'Default';
      if (!acc[g]) acc[g] = [];
      acc[g].push(item);
      return acc;
    }, {});
  }

  function iconHtml(bm) {
    if (bm.icon) {
      if (bm.icon.startsWith('http')) {
        return `<img src="${escapeHtml(bm.icon)}" alt="" onerror="this.style.display='none'">`;
      }
      return `<span class="chip-icon">${escapeHtml(bm.icon)}</span>`;
    }
    try {
      const origin = new URL(bm.url).origin;
      return `<img src="${origin}/favicon.ico" alt="" onerror="this.style.display='none'">`;
    } catch {
      return `<span class="chip-icon">🔗</span>`;
    }
  }

  function render() {
    const container = document.getElementById('quicklinks-chips');
    const bar = document.getElementById('quicklinks-bar');
    const toggleBtn = document.getElementById('btn-toggle-links');
    container.innerHTML = '';

    const grouped = groupBy(bookmarks);
    const groups = Object.keys(grouped).sort();
    const multiGroup = groups.length > 1;

    groups.forEach(groupName => {
      const groupEl = document.createElement('div');
      groupEl.className = 'quicklinks-group';

      if (multiGroup) {
        const label = document.createElement('span');
        label.className = 'quicklinks-group-label';
        label.textContent = groupName;
        groupEl.appendChild(label);
      }

      grouped[groupName].forEach(bm => {
        const chip = document.createElement('a');
        chip.className = 'quicklinks-chip';
        chip.href = bm.url;
        chip.target = '_blank';
        chip.rel = 'noopener noreferrer';
        chip.innerHTML = `${iconHtml(bm)}<span>${escapeHtml(bm.title)}</span>`;

        chip.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          ContextMenu.show(e.clientX, e.clientY, [
            { label: 'Edit', action: () => showEditModal(bm) },
            { label: 'Delete', danger: true, action: () => deleteBookmark(bm) },
          ]);
        });

        groupEl.appendChild(chip);
      });

      container.appendChild(groupEl);
    });

    bar.classList.toggle('expanded', expanded);
    toggleBtn.classList.toggle('expanded', expanded);
    toggleBtn.style.display = multiGroup ? '' : 'none';
  }

  async function deleteBookmark(bm) {
    if (!confirm(`Delete “${bm.title}”?`)) return;
    await API.delete(`/api/bookmarks/${bm.id}`);
    await Bookmarks.load();
  }

  function buildForm(bm = {}) {
    return `
      <div class="form-group">
        <label class="form-label">Name</label>
        <input class="form-input" id="bf-title" type="text" value="${escapeHtml(bm.title || '')}" placeholder="Defaults to the hostname">
      </div>
      <div class="form-group">
        <label class="form-label">URL *</label>
        <input class="form-input" id="bf-url" type="url" value="${escapeHtml(bm.url || '')}" placeholder="https://...">
      </div>
      <div class="form-group">
        <label class="form-label">Icon (emoji or image URL; leave empty to use the favicon)</label>
        <input class="form-input" id="bf-icon" type="text" value="${escapeHtml(bm.icon || '')}" placeholder="🚀 or https://...">
      </div>
      <div class="form-group">
        <label class="form-label">Group</label>
        <input class="form-input" id="bf-group" type="text" value="${escapeHtml(bm.group_name || 'Default')}" placeholder="Default">
      </div>
      <div class="form-actions">
        <button class="btn-cancel" id="bf-cancel">Cancel</button>
        <button class="btn-submit" id="bf-submit">${bm.id ? 'Save' : 'Add'}</button>
      </div>`;
  }

  function setupFormEvents(existing = {}) {
    document.getElementById('bf-cancel').addEventListener('click', Modal.hide);

    const urlInput = document.getElementById('bf-url');
    const titleInput = document.getElementById('bf-title');

    urlInput.addEventListener('blur', () => {
      const val = urlInput.value.trim();
      if (!val || titleInput.value.trim()) return;
      try {
        const hostname = new URL(val).hostname;
        titleInput.value = hostname.replace(/^www\./, '');
      } catch {}
    });

    document.getElementById('bf-submit').addEventListener('click', async () => {
      const url = urlInput.value.trim();
      if (!url) { urlInput.classList.add('error'); return; }
      urlInput.classList.remove('error');

      const title = titleInput.value.trim() || (() => {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
      })();
      const icon = document.getElementById('bf-icon').value.trim() || null;
      const group_name = document.getElementById('bf-group').value.trim() || 'Default';

      try {
        if (existing.id) {
          await API.put(`/api/bookmarks/${existing.id}`, { title, url, icon, group_name });
        } else {
          await API.post('/api/bookmarks', { title, url, icon, group_name });
        }
        Modal.hide();
        await Bookmarks.load();
      } catch (e) {
        alert('Operation failed: ' + e.message);
      }
    });
  }

  function showEditModal(bm) {
    Modal.show('Edit link', buildForm(bm));
    setupFormEvents(bm);
  }

  document.getElementById('btn-add-link').addEventListener('click', () => {
    Modal.show('Add link', buildForm());
    setupFormEvents();
  });

  document.getElementById('btn-toggle-links').addEventListener('click', () => {
    expanded = !expanded;
    localStorage.setItem('quicklinksExpanded', expanded ? '1' : '0');
    render();
  });

  return {
    async load() {
      bookmarks = await API.get('/api/bookmarks');
      render();
    },
  };
})();
