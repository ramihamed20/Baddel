(() => {
  'use strict';

  // GitHub-only edition: Pages hosts the site; public GitHub Issues hold exchange requests.
  // No private API credentials, custom server, or database are placed in the browser.
  const REPO = 'ramihamed20/Baddel';
  const API = 'https://api.github.com/repos/' + REPO + '/issues';
  const ISSUES_URL = 'https://github.com/' + REPO + '/issues';
  const GROUPS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'];
  const PARTS = ['current-section', 'current-group', 'target-section', 'target-group'];
  const USER_RE = /^[a-zA-Z0-9_]{5,32}$/;
  const ISSUE_RE = /<!-- BADDEL_SWAP_V1 -->\s*\nمن:\s*([AB])-([ABCD][12])\s*\nإلى:\s*([AB])-([ABCD][12])\s*\nتيليجرام:\s*@?([A-Za-z0-9_]{5,32})/;
  const PAGE_SIZE = 16;
  const MAX_DAYS = 30;
  const $ = (name) => document.getElementById(name);
  const state = { requests: [], filtered: [], shown: PAGE_SIZE, loading: false };
  let toastTimer;

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
  function parseIssue(issue) {
    if (issue.pull_request || typeof issue.body !== 'string') return null;
    const m = issue.body.match(ISSUE_RE);
    if (!m) return null;
    const created = Date.parse(issue.created_at);
    if (!Number.isFinite(created) || Date.now() - created > MAX_DAYS * 86400000) return null;
    if (m[1] === m[3] && m[2] === m[4]) return null;
    return {
      id: Number(issue.number),
      current_section: m[1], current_group: m[2],
      target_section: m[3], target_group: m[4],
      telegram: m[5], created_at: issue.created_at,
      url: 'https://github.com/' + REPO + '/issues/' + Number(issue.number)
    };
  }
  async function fetchRequests() {
    const issues = [];
    // Up to 500 open Issues; requests older than 30 days are ignored in the site.
    for (let page = 1; page <= 5; page++) {
      const response = await fetch(API + '?state=open&sort=created&direction=desc&per_page=100&page=' + page, {
        headers: { 'Accept': 'application/vnd.github+json' },
        cache: 'no-store'
      });
      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          throw new Error('GitHub حدّد عدد طلبات القراءة مؤقتًا. جرب بعد شوية.');
        }
        throw new Error('تعذّر تحميل الطلبات من GitHub (' + response.status + ').');
      }
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('استجابة GitHub غير متوقعة');
      issues.push(...batch);
      if (batch.length < 100) break;
    }
    return issues.map(parseIssue).filter(Boolean);
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
    const issueURL = html(r.url);
    return '<article class="request-card" data-id="' + r.id + '">' +
      '<div class="request-head"><div class="request-user"><span class="user-avatar" aria-hidden="true">' +
      html(r.telegram.charAt(0).toUpperCase()) + '</span><div><strong>@' + who +
      '</strong><small>' + html(when(r.created_at)) + '</small></div></div>' +
      '<span class="request-label">طلب #' + r.id + '</span></div>' +
      '<div class="request-route"><div class="route-side"><span>من</span><strong>' +
      html(pair(r, 'current')) + '</strong></div><span class="route-swap" aria-hidden="true">↔</span>' +
      '<div class="route-side target"><span>إلى</span><strong>' +
      html(pair(r, 'target')) + '</strong></div></div>' +
      '<div class="request-footer"><div class="request-footer-buttons">' +
      '<a class="contact-btn" href="https://t.me/' + encodeURIComponent(r.telegram) +
      '" target="_blank" rel="noopener noreferrer">تواصل على تيليجرام ↗</a>' +
      '<button class="small-action" type="button" data-action="matches" data-id="' + r.id +
      '">شوف التطابقات</button></div>' +
      '<a class="small-action" href="' + issueURL +
      '" target="_blank" rel="noopener noreferrer">عرض الطلب ↗</a></div></article>';
  }
  function render() {
    const selected = collect('filter');
    state.filtered = state.requests.filter(r =>
      Object.entries(selected).every(([key, value]) => !value || r[key] === value));
    $('results-count').textContent = state.filtered.length + ' طلب';
    $('more-btn').hidden = state.shown >= state.filtered.length;
    const visible = state.filtered.slice(0, state.shown);
    if (!visible.length) {
      $('requests-grid').innerHTML =
        '<div class="empty-state"><div class="empty-symbol">⌕</div>' +
        '<h3>ما فيش طلبات مطابقة توا</h3><p>غيّر الفلاتر أو انشر طلبك، وباقي الطلبة يقدروا يتواصلوا معاك.</p>' +
        '<button class="btn btn-accent" type="button" data-action="create">انشر طلبك</button></div>';
      return;
    }
    $('requests-grid').innerHTML = visible.map(card).join('');
  }
  async function reload() {
    if (state.loading) return;
    state.loading = true;
    $('requests-grid').innerHTML = '<div class="loading-state"><span class="loading-spinner"></span> جاري تحميل الطلبات من GitHub...</div>';
    $('results-count').textContent = 'جاري التحميل...';
    $('more-btn').hidden = true;
    try {
      state.requests = await fetchRequests();
      state.shown = PAGE_SIZE;
      stats();
      render();
    } catch (error) {
      $('requests-grid').innerHTML = '<div class="empty-state"><div class="empty-symbol">!</div>' +
        '<h3>ما قدرناش نحمّل الطلبات</h3><p>' + html(error.message) +
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
  function showMatches(id) {
    const entry = state.requests.find(r => r.id === Number(id));
    if (!entry) return toast('هذا الطلب لم يعد ظاهرًا. جرّب تحديث الصفحة.', true);
    const matches = state.requests.filter(other => other.id !== entry.id && isMatch(entry, other));
    $('match-heading').textContent = matches.length ? 'فيه طلبات تتبدّل معاك!' : 'ما فيش تطابق مباشر حاليًا';
    $('match-description').textContent = 'نبحث عن ' + pair(entry, 'target') +
      ' ← ' + pair(entry, 'current') + ' (بنفس الشعبة والقروب بالعكس).';
    $('match-list').innerHTML = matches.length ?
      '<div class="matched-heading">✦ ' + matches.length + ' طلب مناسب للتبديل</div>' +
      '<div class="mini-matches">' + matches.map(r =>
        '<div class="mini-match"><div><strong>@' + html(r.telegram) +
        '</strong><span>' + html(pair(r, 'current')) + ' ← ' + html(pair(r, 'target')) +
        '</span></div><a href="https://t.me/' + encodeURIComponent(r.telegram) +
        '" target="_blank" rel="noopener noreferrer">تواصل ↗</a></div>').join('') + '</div>' :
      '<div class="no-matches"><strong>ما فيش تطابق مباشر إلى الآن</strong>تقدر ترجع وتحدّث الطلبات في أي وقت.</div>';
    if (!$('match-dialog').open) $('match-dialog').showModal();
  }
  function submitCreate(event) {
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
    else if (!$('create-consent').checked) message = 'لازم توافق على نشر يوزر تيليجرام بشكل عام.';
    if (message) {
      error.textContent = message;
      error.hidden = false;
      return;
    }
    const from = data.current_section + '-' + data.current_group;
    const to = data.target_section + '-' + data.target_group;
    const title = '[بدّل] ' + from + ' → ' + to;
    const body = '<!-- BADDEL_SWAP_V1 -->\n' +
      'من: ' + from + '\n' +
      'إلى: ' + to + '\n' +
      'تيليجرام: @' + user + '\n\n' +
      'هذا طلب تبديل مجموعات منشور بواسطة الطالب. التواصل يتم على تيليجرام، والتبديل النهائي حسب أنظمة الجامعة.\n' +
      'لإزالة الطلب من موقع بدّل، أغلق هذه الـ Issue على GitHub.';
    const url = ISSUES_URL + '/new?' + new URLSearchParams({ title, body }).toString();
    // GitHub requires the student to log in and press "Submit new issue".
    window.location.assign(url);
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
    // Pages doesn't support a backend; the account holder manages their own Issues.
    $('nav-mine').textContent = 'إدارة طلباتي ↗';
    $('nav-mine').addEventListener('click', () =>
      window.location.assign(ISSUES_URL + '?q=' + encodeURIComponent('is:issue author:@me')));
    $('nav-all').addEventListener('click', () => {
      document.getElementById('requests').scrollIntoView({ behavior: 'smooth' });
    });
    for (const id of ['header-create', 'hero-create', 'banner-create']) {
      $(id).addEventListener('click', showCreate);
    }
    $('refresh').addEventListener('click', reload);
    $('filter-form').addEventListener('submit', ev => { ev.preventDefault(); setFilters(); });
    $('flip-filter').addEventListener('click', () => { swapFilters(); setFilters(); });
    $('reset-filters').addEventListener('click', () => {
      for (const part of PARTS) $('filter-' + part).value = '';
      setFilters();
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
      else if (button.dataset.action === 'matches') showMatches(button.dataset.id);
    });
    void reload();
  }
  boot();
})();
