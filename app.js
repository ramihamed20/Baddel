(() => {
  'use strict';

  // GitHub Pages hosts only HTML/CSS/JS. Shared requests go to a separate
  // public API (Supabase Edge Function). No account or sign-in is required.
  const BACKEND = (window.BADDEL_API_URL || '').trim();
  const GROUPS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'];
  const PARTS = ['current-section', 'current-group', 'target-section', 'target-group'];
  const USER_RE = /^[a-zA-Z0-9_]{5,32}$/;
  const PAGE_SIZE = 16;
  const MAX_FETCH = 500;
  const OWNERS_KEY = 'baddel_owner_tokens_v1';
  const $ = name => document.getElementById(name);
  const state = { requests: [], filtered: [], shown: PAGE_SIZE, loading: false, mode: 'all' };
  let toastTimer;
  let ownerTokens = readOwners();

  function html(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    })[ch]);
  }
  function toast(message, error) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error-state', Boolean(error));
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4800);
  }
  function pair(r, side) {
    return r[side + '_section'] + '-' + r[side + '_group'];
  }
  function when(value) {
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
    if (elapsed < 2) return 'الآن';
    if (elapsed < 60) return 'منذ ' + elapsed + ' دقيقة';
    if (elapsed < 1440) return 'منذ ' + Math.floor(elapsed / 60) + ' ساعة';
    return 'منذ ' + Math.floor(elapsed / 1440) + ' يوم';
  }
  function readOwners() {
    try {
      const saved = JSON.parse(localStorage.getItem(OWNERS_KEY) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch { return {}; }
  }
  function saveOwners() {
    try {
      localStorage.setItem(OWNERS_KEY, JSON.stringify(ownerTokens));
      return true;
    } catch {
      toast('المتصفح يمنع التخزين المحلي. قد تفقد إمكانية حذف طلبك بعد إغلاق الصفحة.', true);
      return false;
    }
  }
  function owned(r) {
    return typeof ownerTokens[r.id] === 'string';
  }
  async function api(params, options = {}) {
    if (!/^https:\/\/[-a-zA-Z0-9.]+\/functions\/v1\/baddel-api\/?$/.test(BACKEND)) {
      throw new Error('قاعدة بيانات الطلبات غير مربوطة بالموقع حتى الآن.');
    }
    const url = new URL(BACKEND);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(name, value);
    }
    let response;
    try {
      response = await fetch(url.toString(), { cache: 'no-store', ...options });
    } catch {
      throw new Error('تعذّر الاتصال بخدمة الطلبات. تأكد من الإنترنت وجرّب مرة ثانية.');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || 'الخدمة غير متاحة الآن (رمز ' + response.status + ')');
    }
    return body;
  }
  async function fetchRequests() {
    const result = [];
    let offset = 0;
    while (offset < MAX_FETCH) {
      const batch = await api({ action: 'requests', limit: 100, offset });
      if (!Array.isArray(batch.requests)) throw new Error('صيغة الطلبات غير متوقعة');
      result.push(...batch.requests);
      offset += batch.requests.length;
      if (!batch.has_more || batch.requests.length === 0) break;
    }
    return result;
  }
  function stats() {
    $('stat-requests').textContent = state.requests.length.toLocaleString('en-US');
    let pairs = 0;
    for (let i = 0; i < state.requests.length; i++) {
      for (let j = i + 1; j < state.requests.length; j++) {
        if (isMatch(state.requests[i], state.requests[j])) pairs++;
      }
    }
    $('stat-matches').textContent = pairs.toLocaleString('en-US');
  }
  function isMatch(a, b) {
    return a.current_section === b.target_section &&
      a.current_group === b.target_group &&
      a.target_section === b.current_section &&
      a.target_group === b.current_group &&
      a.telegram.toLowerCase() !== b.telegram.toLowerCase();
  }
  function collect(prefix) {
    const values = {};
    for (const part of PARTS) values[part.replace('-', '_')] = $(prefix + '-' + part).value;
    return values;
  }
  function fillGroups(name) {
    for (const group of GROUPS) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = group;
      $(name).appendChild(opt);
    }
  }
  function card(r) {
    const who = html(r.telegram);
    const myRequest = owned(r);
    return '<article class="request-card" data-id="' + html(r.id) + '">' +
      '<div class="request-head"><div class="request-user"><span class="user-avatar" aria-hidden="true">' +
      html(r.telegram.charAt(0).toUpperCase()) + '</span><div><strong>@' + who +
      '</strong><small>' + html(when(r.created_at)) + '</small></div></div>' +
      '<span class="request-label' + (myRequest ? ' own-label' : '') + '">' +
      (myRequest ? 'طلبك' : 'طلب تبديل') + '</span></div>' +
      '<div class="request-route"><div class="route-side"><span>من</span><strong>' +
      html(pair(r, 'current')) + '</strong></div><span class="route-swap" aria-hidden="true">↔</span>' +
      '<div class="route-side target"><span>إلى</span><strong>' +
      html(pair(r, 'target')) + '</strong></div></div>' +
      '<div class="request-footer"><div class="request-footer-buttons">' +
      '<a class="contact-btn" href="https://t.me/' + encodeURIComponent(r.telegram) +
      '" target="_blank" rel="noopener noreferrer">تواصل على تيليجرام ↗</a>' +
      '<button class="small-action" type="button" data-action="matches" data-id="' +
      html(r.id) + '">شوف التطابقات</button>' +
      (myRequest ? '<button class="small-action delete-btn" type="button" data-action="delete" data-id="' +
        html(r.id) + '">حذف طلبي</button>' : '') +
      '</div></div></article>';
  }
  function render() {
    const selected = collect('filter');
    const showingMine = state.mode === 'mine';
    state.filtered = state.requests.filter(r =>
      (!showingMine || owned(r)) &&
      (showingMine || Object.entries(selected).every(([key, value]) => !value || r[key] === value)));
    $('results-title').textContent = showingMine ? 'طلباتي' : 'كل الطلبات';
    $('results-count').textContent = state.filtered.length + ' طلب';
    $('more-btn').hidden = state.shown >= state.filtered.length;
    const visible = state.filtered.slice(0, state.shown);
    if (!visible.length) {
      $('requests-grid').innerHTML =
        '<div class="empty-state"><div class="empty-symbol">⌕</div>' +
        '<h3>' + (showingMine ? 'ما عندكش طلبات محفوظة في هذا المتصفح' : 'ما فيش طلبات مطابقة توا') + '</h3>' +
        '<p>' + (showingMine ? 'طلباتك تظهر هنا على نفس الهاتف والمتصفح اللي نشرت منه.' :
          'غيّر الفلاتر أو انشر طلبك، وباقي الطلبة يقدروا يتواصلوا معاك.') + '</p>' +
        '<button class="btn btn-accent" type="button" data-action="create">انشر طلبك</button></div>';
      return;
    }
    $('requests-grid').innerHTML = visible.map(card).join('');
  }
  async function reload() {
    if (state.loading) return;
    state.loading = true;
    $('requests-grid').innerHTML = '<div class="loading-state"><span class="loading-spinner"></span> جاري تحميل الطلبات...</div>';
    $('results-count').textContent = 'جاري التحميل...';
    $('more-btn').hidden = true;
    try {
      state.requests = await fetchRequests();
      state.shown = PAGE_SIZE;
      stats();
      render();
    } catch (error) {
      $('requests-grid').innerHTML =
        '<div class="empty-state"><div class="empty-symbol">!</div>' +
        '<h3>الطلبات غير متاحة حاليًا</h3><p>' + html(error.message) +
        '</p><button class="btn btn-dark" type="button" data-action="retry">إعادة المحاولة</button></div>';
      $('results-count').textContent = 'تعذّر التحميل';
      $('stat-requests').textContent = '—';
      $('stat-matches').textContent = '—';
    } finally {
      state.loading = false;
    }
  }
  function showCreate() {
    $('create-error').hidden = true;
    if (!$('create-dialog').open) $('create-dialog').showModal();
    $('create-current-section').focus();
  }
  async function showMatches(id, created) {
    const entry = created || state.requests.find(r => r.id === id);
    if (!entry) return toast('هذا الطلب لم يعد متاحًا. جرّب تحديث الطلبات.', true);
    $('match-heading').textContent = 'ندوروا على التبديل المناسب';
    $('match-description').textContent = 'نبحث عن ' + pair(entry, 'target') +
      ' ← ' + pair(entry, 'current') + ' (بالعكس تمامًا).';
    $('match-list').innerHTML = '<div class="loading-state"><span class="loading-spinner"></span> جاري البحث...</div>';
    if (!$('match-dialog').open) $('match-dialog').showModal();
    try {
      const data = await api({ action: 'matches', id: entry.id });
      const matches = Array.isArray(data.matches) ? data.matches : [];
      $('match-heading').textContent = matches.length ?
        'لقينا طلبات مناسبة!' : (created ? 'تم نشر طلبك بنجاح!' : 'ما فيش تطابق مباشر حاليًا');
      $('match-list').innerHTML = matches.length ?
        '<div class="matched-heading">✦ ' + matches.length + ' طلب مناسب للتبديل</div>' +
        '<div class="mini-matches">' + matches.map(r =>
          '<div class="mini-match"><div><strong>@' + html(r.telegram) +
          '</strong><span>' + html(pair(r, 'current')) + ' ← ' + html(pair(r, 'target')) +
          '</span></div><a href="https://t.me/' + encodeURIComponent(r.telegram) +
          '" target="_blank" rel="noopener noreferrer">تواصل ↗</a></div>').join('') + '</div>' :
        '<div class="no-matches"><strong>ما فيش تطابق مباشر إلى الآن</strong>' +
          'طلبك يظل ظاهر لكل الطلبة، ويقدروا يكلموك على تيليجرام.</div>';
    } catch (error) {
      $('match-heading').textContent = created ? 'تم نشر طلبك بنجاح!' : 'تعذّر البحث';
      $('match-list').innerHTML = '<div class="no-matches">' + html(error.message) + '</div>';
    }
  }
  async function submitCreate(event) {
    event.preventDefault();
    const data = collect('create');
    const user = $('create-telegram').value.trim().replace(/^@/, '');
    const error = $('create-error');
    error.hidden = true;
    let message = '';
    if (Object.values(data).some(v => !v)) message = 'اختار الشعبة والقروب في الحالتين.';
    else if (data.current_section === data.target_section &&
             data.current_group === data.target_group) message = 'اختار قروب مختلف عن قروبك الحالي.';
    else if (!USER_RE.test(user)) message = 'يوزر تيليجرام لازم يكون من 5 إلى 32 حرف أو رقم أو _.';
    else if (!$('create-consent').checked) message = 'لازم توافق على نشر يوزر تيليجرام.';
    if (message) { error.textContent = message; error.hidden = false; return; }
    const submit = $('create-submit');
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = 'جاري نشر طلبك...';
    try {
      const result = await api({ action: 'requests' }, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, telegram: user, consent: true })
      });
      if (!result.request || !result.owner_token) throw new Error('استجابة النشر غير مكتملة');
      ownerTokens[result.request.id] = result.owner_token;
      saveOwners();
      $('create-dialog').close();
      $('create-form').reset();
      state.mode = 'all';
      $('nav-mine').classList.remove('active');
      $('nav-all').classList.add('active');
      toast('تم نشر طلبك بنجاح!');
      await reload();
      await showMatches(result.request.id, result.request);
    } catch (cause) {
      error.textContent = cause.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'انشر طلب التبديل';
    }
  }
  async function deleteRequest(id) {
    const token = ownerTokens[id];
    if (!token) return toast('ما عندكش صلاحية حذف الطلب من هذا المتصفح.', true);
    if (!window.confirm('متأكد إنك تبي تحذف طلب التبديل؟')) return;
    try {
      await api({ action: 'requests', id }, { method: 'DELETE',
        headers: { 'X-Owner-Token': token } });
      delete ownerTokens[id];
      saveOwners();
      await reload();
      toast('تم حذف طلبك.');
    } catch (error) { toast(error.message, true); }
  }
  function setFilters() {
    state.shown = PAGE_SIZE;
    render();
  }
  function swapFilters() {
    for (const part of ['section', 'group']) {
      const a = $('filter-current-' + part);
      const b = $('filter-target-' + part);
      const temp = a.value;
      a.value = b.value;
      b.value = temp;
    }
  }
  function boot() {
    for (const prefix of ['filter', 'create']) {
      fillGroups(prefix + '-current-group');
      fillGroups(prefix + '-target-group');
    }
    const setMode = mode => {
      state.mode = mode;
      state.shown = PAGE_SIZE;
      $('nav-all').classList.toggle('active', mode === 'all');
      $('nav-mine').classList.toggle('active', mode === 'mine');
      render();
      $('requests').scrollIntoView({ behavior: 'smooth' });
    };
    $('nav-mine').addEventListener('click', () => setMode('mine'));
    $('nav-all').addEventListener('click', () => setMode('all'));
    for (const id of ['header-create', 'hero-create', 'banner-create']) {
      $(id).addEventListener('click', showCreate);
    }
    $('refresh').addEventListener('click', reload);
    $('filter-form').addEventListener('submit', ev => {
      ev.preventDefault(); setMode('all'); setFilters();
    });
    $('flip-filter').addEventListener('click', () => {
      swapFilters(); setMode('all'); setFilters();
    });
    $('reset-filters').addEventListener('click', () => {
      for (const part of PARTS) $('filter-' + part).value = '';
      setMode('all'); setFilters();
    });
    $('more-btn').addEventListener('click', () => { state.shown += PAGE_SIZE; render(); });
    $('create-form').addEventListener('submit', submitCreate);
    $('mobile-filter-toggle').addEventListener('click', () => {
      const opened = $('search-panel').classList.toggle('expanded');
      $('mobile-filter-toggle').textContent = opened ? 'إخفاء الفلاتر −' : 'فتح الفلاتر +';
      $('mobile-filter-toggle').setAttribute('aria-expanded', String(opened));
    });
    $('match-done').addEventListener('click', () => {
      $('match-dialog').close();
      $('requests').scrollIntoView({ behavior: 'smooth' });
    });
    document.querySelectorAll('[data-close]').forEach(button =>
      button.addEventListener('click', () => $(button.dataset.close).close()));
    document.querySelectorAll('dialog').forEach(dialog =>
      dialog.addEventListener('click', ev => { if (ev.target === dialog) dialog.close(); }));
    $('requests-grid').addEventListener('click', ev => {
      const button = ev.target.closest('[data-action]');
      if (!button) return;
      if (button.dataset.action === 'create') showCreate();
      else if (button.dataset.action === 'retry') void reload();
      else if (button.dataset.action === 'matches') void showMatches(button.dataset.id);
      else if (button.dataset.action === 'delete') void deleteRequest(button.dataset.id);
    });
    void reload();
  }
  boot();
})();
