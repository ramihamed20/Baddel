(() => {
  'use strict';
  const GROUPS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'];
  const STORAGE_KEY = 'baddel_my_requests_v1';
  const PAGE_SIZE = 16;
  const ids = (id) => document.getElementById(id);
  const fieldIds = ['current-section', 'current-group', 'target-section', 'target-group'];
  const state = { mode: 'all', items: [], total: 0, offset: 0, hasMore: false, owners: loadOwners(), loading: false, serial: 0 };
  const telegramRe = /^[a-zA-Z0-9_]{5,32}$/;
  let toastTimer;

  function loadOwners() {
    try {
      const obj = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (obj && !Array.isArray(obj) && typeof obj === 'object') {
        return Object.fromEntries(Object.entries(obj).filter(([id, token]) => /^[0-9a-f]{32}$/.test(id) && typeof token === 'string' && token.length >= 25));
      }
    } catch { /* storage can be disabled */ }
    return {};
  }
  function saveOwners() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.owners)); }
    catch { toast('تعذّر حفظ ملكية الطلب على جهازك. قد لا تقدر تحذفه لاحقًا.', true); }
    updateMineCount();
  }
  function updateMineCount() {
    const count = Object.keys(state.owners).length;
    ids('mine-count').textContent = String(count);
    ids('mine-count').hidden = count === 0;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }
  function toast(message, error = false) {
    const node = ids('toast');
    node.textContent = message;
    node.classList.toggle('error-state', error);
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 4100);
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `تعذّر إكمال العملية (${response.status})`);
    return result;
  }
  function fillGroups(id) {
    const node = ids(id);
    for (const group of GROUPS) {
      const option = document.createElement('option');
      option.value = group;
      option.textContent = group;
      node.appendChild(option);
    }
  }
  function requestPath(p) {
    return `${p.current_section}-${p.current_group}`;
  }
  function targetPath(p) {
    return `${p.target_section}-${p.target_group}`;
  }
  function dateLabel(iso) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return 'حديثًا';
    const mins = Math.max(0, Math.floor((Date.now() - time) / 60000));
    if (mins < 2) return 'الآن';
    if (mins < 60) return `منذ ${mins} دقيقة`;
    if (mins < 1440) return `منذ ${Math.floor(mins / 60)} ساعة`;
    if (mins < 43200) return `منذ ${Math.floor(mins / 1440)} يوم`;
    return new Intl.DateTimeFormat('ar-LY', { day: 'numeric', month: 'short' }).format(new Date(time));
  }
  function openDialog(node) {
    if (!node.open) node.showModal();
  }
  function showCreate() {
    ids('create-error').hidden = true;
    openDialog(ids('create-dialog'));
    ids('create-current-section').focus();
  }
  function clearFilters() {
    for (const part of fieldIds) ids(`filter-${part}`).value = '';
  }
  function collect(prefix) {
    return Object.fromEntries(fieldIds.map((part) => [part.replace('-', '_'), ids(`${prefix}-${part}`).value]));
  }
  function filters() {
    const values = collect('filter');
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
    return params;
  }
  function swapFilters() {
    for (const part of ['section', 'group']) {
      const from = ids(`filter-current-${part}`);
      const to = ids(`filter-target-${part}`);
      [from.value, to.value] = [to.value, from.value];
    }
  }
  function setMode(mode) {
    state.mode = mode;
    ids('nav-all').classList.toggle('active', mode === 'all');
    ids('nav-mine').classList.toggle('active', mode === 'mine');
    ids('listing-heading').textContent = mode === 'mine' ? 'طلباتي' : 'طلبات الطلبة';
    ids('results-title').textContent = mode === 'mine' ? 'الطلبات اللي نشرتها' : 'كل الطلبات';
    ids('search-panel').hidden = mode === 'mine';
    void loadRequests(false);
  }
  async function loadRequests(append = false) {
    if (state.loading && append) return;
    const serial = ++state.serial;
    state.loading = true;
    if (!append) {
      state.offset = 0;
      state.items = [];
      ids('requests-grid').innerHTML = '<div class="loading-state"><span class="loading-spinner"></span> جاري تحميل الطلبات...</div>';
    }
    ids('more-btn').hidden = true;
    try {
      if (state.mode === 'mine') {
        const ownerIds = Object.keys(state.owners);
        const results = await Promise.all(ownerIds.map(async (id) => {
          try { const r = await api(`/api/requests/${id}`); return r.request; }
          catch (error) {
            if (error.message.includes('غير متاح') || error.message.includes('غير موجود')) delete state.owners[id];
            return null;
          }
        }));
        if (serial !== state.serial) return;
        saveOwners();
        state.items = results.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));
        state.total = state.items.length;
        state.hasMore = false;
      } else {
        const params = filters();
        params.set('offset', String(append ? state.offset : 0));
        params.set('limit', String(PAGE_SIZE));
        const result = await api(`/api/requests?${params.toString()}`);
        if (serial !== state.serial) return;
        state.items = append ? [...state.items, ...result.requests] : result.requests;
        state.offset = state.items.length;
        state.hasMore = result.has_more;
        state.total = result.total;
      }
      renderRequests();
    } catch (error) {
      if (serial !== state.serial) return;
      if (append) toast(error.message || 'تعذّر تحميل المزيد', true);
      else ids('requests-grid').innerHTML = '<div class="empty-state"><div class="empty-symbol">!</div><h3>ما قدرناش نحمل الطلبات</h3><p>تأكد من الاتصال وجرّب تضغط تحديث الطلبات.</p><button class="btn btn-dark" type="button" data-action="retry">إعادة المحاولة</button></div>';
      ids('results-count').textContent = 'مشكلة اتصال';
    } finally {
      if (serial === state.serial) state.loading = false;
    }
  }
  function renderRequests() {
    ids('results-count').textContent = `${state.total} طلب`;
    ids('more-btn').hidden = !state.hasMore;
    if (!state.items.length) {
      ids('requests-grid').innerHTML = state.mode === 'mine'
        ? '<div class="empty-state"><div class="empty-symbol">↔</div><h3>ما نشرتش طلبات لحد الآن</h3><p>انشر طلبك باش باقي الطلبة يقدروا يلقوك ويتواصلوا معاك.</p><button class="btn btn-accent" type="button" data-action="create">انشر أول طلب</button></div>'
        : '<div class="empty-state"><div class="empty-symbol">⌕</div><h3>ما فيش طلبات مطابقة توا</h3><p>جرّب تغيّر خيارات البحث أو انشر طلبك وخلي الطلبة يشوفوه.</p><button class="btn btn-accent" type="button" data-action="create">انشر طلبك</button></div>';
      return;
    }
    ids('requests-grid').innerHTML = state.items.map(cardHTML).join('');
  }
  function cardHTML(req) {
    const isMine = Object.prototype.hasOwnProperty.call(state.owners, req.id);
    const tg = escapeHtml(req.telegram);
    const initial = escapeHtml(req.telegram[0]?.toUpperCase() || '@');
    const rid = escapeHtml(req.id);
    return `<article class="request-card" data-id="${rid}">
      <div class="request-head"><div class="request-user"><span class="user-avatar" aria-hidden="true">${initial}</span><div><strong>@${tg}</strong><small>${escapeHtml(dateLabel(req.created_at))}</small></div></div><span class="request-label ${isMine ? 'own-label' : ''}">${isMine ? 'طلبك' : 'طلب تبديل'}</span></div>
      <div class="request-route"><div class="route-side"><span>من</span><strong>${escapeHtml(requestPath(req))}</strong></div><span class="route-swap" aria-hidden="true">↔</span><div class="route-side target"><span>إلى</span><strong>${escapeHtml(targetPath(req))}</strong></div></div>
      <div class="request-footer"><div class="request-footer-buttons"><a class="contact-btn" href="https://t.me/${encodeURIComponent(req.telegram)}" target="_blank" rel="noopener noreferrer" aria-label="تواصل مع ${tg} عبر تيليجرام">تواصل على تيليجرام <span aria-hidden="true">↗</span></a><button class="small-action" type="button" data-action="matches" data-id="${rid}">شوف التطابقات</button></div>
      ${isMine ? `<button class="small-action delete-btn" type="button" data-action="delete" data-id="${rid}">حذف</button>` : ''}</div>
    </article>`;
  }
  async function refreshStats() {
    try {
      const result = await api('/api/stats');
      ids('stat-requests').textContent = result.active_requests.toLocaleString('en-US');
      ids('stat-matches').textContent = result.matching_pairs.toLocaleString('en-US');
    } catch { ids('stat-requests').textContent = '—'; ids('stat-matches').textContent = '—'; }
  }
  function showMatches(matches, ownRequest = null) {
    const heading = ids('match-heading');
    const detail = ids('match-description');
    if (ownRequest) {
      heading.textContent = matches.length ? 'فيه طلبات تتبدّل معاك!' : 'هذا الطلب ما عندهش تطابق حاليًا';
      detail.textContent = `التبديل العكسي المطلوب: ${targetPath(ownRequest)} ← ${requestPath(ownRequest)}.`;
    } else {
      heading.textContent = matches.length ? 'تم نشر طلبك — لقينا تطابق!' : 'تم نشر طلبك بنجاح!';
      detail.textContent = matches.length ? 'هذوم طلبة يبو ينتقلوا لقروبك. تقدر تراسلهم مباشرة.' : 'أول ما ينشر طالب طلب بالعكس، تقدر تلقاه في «طلباتي».';
    }
    ids('match-list').innerHTML = matches.length
      ? `<div class="matched-heading">✦ ${matches.length} ${matches.length === 1 ? 'طالب مناسب' : 'طلب مناسب'} للتبديل المباشر</div><div class="mini-matches">${matches.map((r) => `<div class="mini-match"><div><strong>@${escapeHtml(r.telegram)}</strong><span>${escapeHtml(requestPath(r))} ← ${escapeHtml(targetPath(r))}</span></div><a href="https://t.me/${encodeURIComponent(r.telegram)}" target="_blank" rel="noopener noreferrer">تواصل ↗</a></div>`).join('')}</div>`
      : '<div class="no-matches"><strong>ما فيش تطابق مباشر إلى الآن</strong>طلبك يظل ظاهر للطلبة لمدة 30 يوم، وتقدر تبحث بنفسك في باقي الطلبات.</div>';
    openDialog(ids('match-dialog'));
  }
  async function showRequestMatches(id) {
    try {
      const record = state.items.find((r) => r.id === id);
      if (!record) return;
      const result = await api(`/api/requests/${id}/matches`);
      showMatches(result.matches, record);
    } catch (error) { toast(error.message, true); }
  }
  async function deleteRequest(id) {
    const token = state.owners[id];
    if (!token) return toast('ما عندكش صلاحية حذف الطلب على هذا الجهاز.', true);
    if (!confirm('تبي تحذف طلب التبديل هذا؟')) return;
    try {
      await api(`/api/requests/${id}`, { method: 'DELETE', headers: { 'X-Owner-Token': token } });
      delete state.owners[id];
      saveOwners();
      toast('تم حذف الطلب');
      await Promise.all([loadRequests(false), refreshStats()]);
    } catch (error) { toast(error.message, true); }
  }
  async function submitCreate(event) {
    event.preventDefault();
    const input = ids('create-telegram');
    const telegram = input.value.trim().replace(/^@/, '');
    const data = { ...collect('create'), telegram, consent: ids('create-consent').checked };
    const errorNode = ids('create-error');
    errorNode.hidden = true;
    if (!data.current_section || !data.current_group || !data.target_section || !data.target_group) {
      errorNode.textContent = 'اختار الشعبة والقروب في الحالتين.';
      errorNode.hidden = false;
      return;
    }
    if (data.current_section === data.target_section && data.current_group === data.target_group) {
      errorNode.textContent = 'اختار مجموعة مختلفة عن قروبك الحالي.';
      errorNode.hidden = false;
      return;
    }
    if (!telegramRe.test(telegram)) {
      errorNode.textContent = 'يوزر تيليجرام لازم يكون من 5 إلى 32 حرف/رقم أو _.';
      errorNode.hidden = false;
      return;
    }
    if (!data.consent) {
      errorNode.textContent = 'وافق على نشر يوزرك قبل إرسال الطلب.';
      errorNode.hidden = false;
      return;
    }
    const button = ids('create-submit');
    button.disabled = true;
    button.textContent = 'جاري نشر طلبك...';
    try {
      const result = await api('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      state.owners[result.request.id] = result.owner_token;
      saveOwners();
      ids('create-dialog').close();
      ids('create-form').reset();
      showMatches(result.matches);
      await Promise.all([loadRequests(false), refreshStats()]);
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    } finally {
      button.disabled = false;
      button.innerHTML = 'انشر الطلب وابحث عن تطابق <span aria-hidden="true">←</span>';
    }
  }
  function bindEvents() {
    for (const id of ['header-create', 'hero-create', 'banner-create']) ids(id).addEventListener('click', showCreate);
    ids('nav-all').addEventListener('click', () => setMode('all'));
    ids('nav-mine').addEventListener('click', () => setMode('mine'));
    ids('refresh').addEventListener('click', () => { void loadRequests(false); void refreshStats(); });
    ids('mobile-filter-toggle').addEventListener('click', () => {
      const expanded = ids('search-panel').classList.toggle('expanded');
      ids('mobile-filter-toggle').textContent = expanded ? 'إخفاء الفلاتر −' : 'فتح الفلاتر +';
      ids('mobile-filter-toggle').setAttribute('aria-expanded', String(expanded));
    });
    ids('filter-form').addEventListener('submit', (ev) => { ev.preventDefault(); setMode('all'); });
    ids('flip-filter').addEventListener('click', swapFilters);
    ids('reset-filters').addEventListener('click', () => { clearFilters(); setMode('all'); });
    ids('more-btn').addEventListener('click', () => void loadRequests(true));
    ids('create-form').addEventListener('submit', submitCreate);
    ids('match-done').addEventListener('click', () => { ids('match-dialog').close(); setMode('all'); document.getElementById('requests').scrollIntoView({ behavior: 'smooth' }); });
    for (const close of document.querySelectorAll('[data-close]')) close.addEventListener('click', () => ids(close.dataset.close).close());
    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
    }
    ids('requests-grid').addEventListener('click', (ev) => {
      const button = ev.target.closest('[data-action]');
      if (!button) return;
      switch (button.dataset.action) {
        case 'create': showCreate(); break;
        case 'retry': void loadRequests(false); break;
        case 'delete': void deleteRequest(button.dataset.id); break;
        case 'matches': void showRequestMatches(button.dataset.id); break;
        default: break;
      }
    });
  }
  function boot() {
    for (const type of ['filter', 'create']) {
      for (const part of ['current-group', 'target-group']) fillGroups(`${type}-${part}`);
    }
    updateMineCount();
    bindEvents();
    void loadRequests(false);
    void refreshStats();
  }
  boot();
})();
