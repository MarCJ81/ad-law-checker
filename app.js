/* ============================================================
   광고 문구 법률 검수기 · app.js
   화면 조립, 이벤트, 저장. 검사 로직은 core.js에 있다.
   ============================================================ */
(function () {
  'use strict';

  const D = window.AD_DATA;
  const C = window.CORE;
  const B = window.AI_BRIDGE;
  const FA = window.FreeAI || null;   // engines/free-ai-client.js
  if (FA) FA.configure({ endpoint: 'https://free-ai-taste.onetap-ai.workers.dev', app: 'ad-law-checker' });
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = C.esc;

  const KEY = 'alc.v1';
  const MAX_UNDO = 40;

  const state = {
    tab: 'scan',
    theme: 'light',
    industry: 'health',
    text: '',
    sponsored: true,
    includeInfo: true,
    hlMode: 'mark',
    filter: 'all',
    kind: 'product',
    brand: '',
    media: 'blog',
    project: '',
    reviewer: '',
    mode: 'fix',
  };

  let last = null;
  let undo = [];
  let saveTimer = null;
  let scanTimer = null;
  let preAi = null;
  let aiApplied = false;
  let freeBusy = false;

  /* ── 저장 ─────────────────────────────────────────── */
  const SAVE_KEYS = ['tab', 'theme', 'industry', 'text', 'sponsored', 'includeInfo',
    'hlMode', 'filter', 'kind', 'brand', 'media', 'project', 'reviewer', 'mode'];

  function load() {
    let had = false;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const o = JSON.parse(raw);
        for (const k of SAVE_KEYS) {
          if (o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null) state[k] = o[k];
        }
        had = true;
      }
    } catch (e) { /* 손상된 저장값은 무시 */ }
    if (!['health', 'beauty', 'medical', 'commerce'].includes(state.industry)) state.industry = 'health';
    if (!['high', 'warn', 'info', 'all'].includes(state.filter)) state.filter = 'all';
    if (typeof state.text !== 'string') state.text = '';
    return had;
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const o = {};
        for (const k of SAVE_KEYS) o[k] = state[k];
        localStorage.setItem(KEY, JSON.stringify(o));
      } catch (e) { /* 용량 초과 등은 조용히 무시 */ }
    }, 280);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    try {
      const o = {};
      for (const k of SAVE_KEYS) o[k] = state[k];
      localStorage.setItem(KEY, JSON.stringify(o));
    } catch (e) { /* noop */ }
  }

  /* ── 작은 도우미 ──────────────────────────────────── */
  function toast(msg, kind) {
    const root = $('#toastRoot');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; }, 2400);
    setTimeout(() => el.remove(), 2700);
  }

  function fmt(n) { return new Intl.NumberFormat('ko-KR').format(n || 0); }

  function download(name, text, type) {
    const blob = new Blob(['\ufeff' + text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function stampName(prefix, ext) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return prefix + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.' + ext;
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // CSV 출력: 같은 검수 결과를 스프레드시트로 넘긴다. (엑셀 한글 깨짐 방지는 download()의 BOM)
  function buildCsv() {
    if (!last) return '위험도,표현,규칙,법령,조문,제재,줄,문장,권장문구\r\n';
    const rows = [['위험도', '표현', '규칙', '법령', '조문', '제재', '줄', '문장', '권장문구']];
    last.findings.forEach(f => {
      const loc = C.locate(state.text, f.start);
      rows.push([
        (D.severities[f.severity] && D.severities[f.severity].label) || f.severity,
        f.match, f.label, f.law, f.ref, f.penalty,
        loc.line, loc.sentence, (f.fixes || []).join(' / '),
      ]);
    });
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  }

  /* ── 검수 실행 ────────────────────────────────────── */
  function scanNow() {
    last = C.scan(state.text, {
      industry: state.industry,
      includeInfo: state.includeInfo,
      sponsored: state.sponsored,
    });
    renderAll();
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanNow, 140);
  }

  function pushUndo(label) {
    undo.push({ text: state.text, label: label || '' });
    if (undo.length > MAX_UNDO) undo.shift();
    updateUndoBtn();
  }

  function updateUndoBtn() {
    const btn = $('#undoBtn');
    if (!btn) return;
    btn.disabled = undo.length === 0;
    btn.title = undo.length ? (undo[undo.length - 1].label || '이전 상태') + '로 되돌립니다' : '되돌릴 작업이 없습니다';
  }

  /* ── 렌더 ─────────────────────────────────────────── */
  function renderAll() {
    if (!last) return;
    renderScore();
    renderHighlight();
    renderFindings();
    renderCounts();
    renderIbMeta();
    renderDisclosure();
    renderChecklist();
    renderPrompt();
    renderReport();
    updateUndoBtn();
  }

  function renderIbMeta() {
    const el = $('#ibMeta');
    if (!el || !last) return;
    el.innerHTML = '<b>' + esc(last.industryName) + '</b> · ' + esc(last.industryLaw) +
      ' · 규칙 <b>' + last.scannedRules + '개</b> 적용';
  }

  function renderCounts() {
    const total = last ? last.counts.total : 0;
    const badge = $('#tabScanCount');
    if (badge) {
      badge.textContent = String(total);
      badge.hidden = total === 0;
    }
    const fc = $('#findingCount');
    if (fc) fc.textContent = String(total);
    const cc = $('#charCount');
    if (cc) cc.textContent = fmt(state.text.length) + '자';
    const sum = $('#scanSummary');
    if (sum) {
      sum.innerHTML =
        '<div class="stat ' + (last.counts.high ? 'hot' : 'ok') + '"><b>' + last.counts.high + '</b><span>고위험</span></div>' +
        '<div class="stat warn"><b>' + last.counts.warn + '</b><span>주의</span></div>' +
        '<div class="stat info"><b>' + last.counts.info + '</b><span>권고</span></div>' +
        '<div class="stat"><b>' + last.safety + '</b><span>안전도</span></div>';
    }
  }

  function renderScore() {
    const s = last;
    const num = $('#safetyNum');
    const gauge = $('#gauge');
    const grade = $('#gradeBadge');
    const label = $('#gradeLabel');
    const sub = $('#scoreSub');
    const chips = $('#sevChips');
    const groups = $('#groupChips');

    num.textContent = String(s.safety);
    const color = s.safety >= 90 ? 'var(--ok)' : s.safety >= 70 ? 'var(--low)' : s.safety >= 40 ? 'var(--mid)' : 'var(--high)';
    gauge.style.setProperty('--p', s.safety);
    gauge.style.setProperty('--gc', color);
    grade.textContent = s.grade;
    grade.className = 'badge grade ' + s.grade.toLowerCase();
    label.textContent = s.counts.total === 0
      ? '규칙 기준 위험 표현 0건'
      : s.gradeLabel;

    if (!s.chars) {
      sub.textContent = '아직 검수할 문구가 없습니다. 광고 문구를 붙여넣거나 예시를 불러오세요.';
    } else if (s.counts.total === 0) {
      if (s.disclosure.status === 'ok') {
        sub.textContent = '모든 규칙을 통과했고 대가성 표시도 첫 부분에 있습니다. 게시 전 이미지 속 문구와 근거 자료를 확인하세요.';
      } else {
        const dline = s.disclosure.status === 'none'
          ? '대가성 표시가 없습니다.'
          : s.disclosure.status === 'weak'
            ? '대가성 표시가 \'체험단\' 같은 불명확한 표현뿐입니다.'
            : '대가성 표시가 본문 뒤·중간에만 있습니다.';
        sub.textContent = '위험 표현은 없지만 ' + dline + ' 대가성·고지 탭에서 보완하세요.';
      }
    } else {
      sub.textContent = C.summaryLine(s.counts) + ' · ' + s.industryName + ' 기준 ' + s.scannedRules + '개 규칙과 대조했습니다.';
    }

    chips.innerHTML = ['high', 'warn', 'info'].map(k => {
      const n = s.counts[k];
      return '<span class="sev-chip ' + k + (n ? '' : ' zero') + '">' +
        D.severities[k].label + ' <b>' + n + '</b></span>';
    }).join('') + '<span class="sev-chip zero">글자 <b>' + fmt(s.chars) + '</b></span>';

    const entries = Object.entries(s.byGroup || {}).sort((a, b) => b[1].count - a[1].count);
    groups.innerHTML = entries.length
      ? entries.map(([name, v]) =>
        '<span class="group-chip"><i class="dot" style="background:var(--' +
        (v.severity === 'high' ? 'high' : v.severity === 'warn' ? 'mid' : 'low') + ')"></i>' +
        esc(name) + ' <b>' + v.count + '</b></span>').join('')
      : '<span class="group-chip muted">묶음 없음</span>';
  }

  function renderHighlight() {
    const box = $('#hlView');
    if (!last) return;
    if (!last.chars) {
      box.innerHTML = '<p class="hl-empty">왼쪽에 광고 문구를 붙여넣으면 위험한 표현에 색이 입혀집니다.</p>';
      return;
    }
    if (state.hlMode === 'plain') {
      box.textContent = state.text;
    } else {
      box.innerHTML = C.highlightHtml(state.text, last.findings);
    }
  }

  function sevLabel(sev) { return D.severities[sev].label; }

  function renderFindings() {
    const box = $('#findingsList');
    const empty = $('#findingsEmpty');
    const chips = $('#sevFilter');
    if (!last) return;

    const counts = last.counts;
    chips.innerHTML = [
      ['all', '전체', counts.total],
      ['high', '고위험', counts.high],
      ['warn', '주의', counts.warn],
      ['info', '권고', counts.info],
    ].map(([k, label, n]) =>
      '<button type="button" class="chip' + (state.filter === k ? ' is-on' : '') +
      '" data-filter="' + k + '">' + label + ' <b>' + n + '</b></button>'
    ).join('');

    const list = last.findings.filter(f => state.filter === 'all' || f.severity === state.filter);

    if (!last.findings.length) {
      box.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    if (!list.length) {
      box.innerHTML = '<p class="hl-empty" style="padding:10px 2px">' + sevLabel(state.filter) + ' 항목은 없습니다. 다른 심각도를 보거나 전체를 선택하세요.</p>';
      return;
    }

    box.innerHTML = list.map(f => {
      const loc = C.locate(state.text, f.start);
      const fixes = (f.fixes || []).map((fix, i) =>
        '<button type="button" class="fix-btn" data-fix="' + f.id + '" data-i="' + i + '" title="이 문구로 바꿉니다">' +
        '<span class="fx-tag">대체</span><span class="fx-txt">' + esc(fix) + '</span></button>'
      ).join('');
      const related = (f.related || []).length
        ? '<div class="f-extra">' + f.related.slice(0, 4).map(r =>
          '<span title="' + esc(r.law + ' ' + r.ref) + '">관련: ' + esc(r.label) + '</span>').join('') + '</div>'
        : '';
      return '<article class="finding sev-' + f.severity + '" id="card-' + f.id + '" data-fid="' + f.id + '">' +
        '<div class="f-head">' +
        '<span class="f-sev">' + sevLabel(f.severity) + '</span>' +
        '<span class="f-match" title="' + esc(f.match) + '">' + esc(f.match) + '</span>' +
        '<span class="f-loc">L' + loc.line + ' · ' + loc.sentence + '번째 문장</span>' +
        ((f.negated || f.relaxed)
          ? '<span class="f-note" title="' + esc(f.negated
              ? '부정 표현(' + (f.negatedBy || '없음/않음') + ')이 붙어 있어 위반으로 보지 않았습니다.'
              : '띄어쓰기가 다르지만 같은 표현으로 잡았습니다.') + '">' +
            (f.negated ? '부정문 확인' : '띄어쓰기 변형') + '</span>'
          : '') +
        '</div>' +
        '<p class="f-label">' + esc(f.label) + '</p>' +
        '<p class="f-law">' + esc(f.law) + ' ' + esc(f.ref) + '</p>' +
        '<p class="f-penalty">제재: ' + esc(f.penalty) + '</p>' +
        '<p class="f-why">' + esc(f.why) + '</p>' +
        (fixes ? '<div class="f-fixes">' + fixes + '</div>' : '') +
        related +
        '</article>';
    }).join('');
  }

  function renderDisclosure() {
    if (!last) return;
    const d = last.disclosure;
    const grid = $('#kindGrid');
    if (!grid.dataset.built) {
      grid.innerHTML = D.disclosureKinds.map(k =>
        '<label class="kind-card' + (state.kind === k.id ? ' is-on' : '') + '" data-kind="' + k.id + '">' +
        '<input type="radio" name="discKind" value="' + k.id + '"' + (state.kind === k.id ? ' checked' : '') + ' />' +
        '<span class="kc-name">' + esc(k.name) + '<span class="kc-note">' + esc(k.note) + '</span></span>' +
        '</label>'
      ).join('');
      grid.dataset.built = '1';
    }
    $$('#kindGrid .kind-card').forEach(el => {
      el.classList.toggle('is-on', el.dataset.kind === state.kind);
      const r = el.querySelector('input');
      if (r) r.checked = el.dataset.kind === state.kind;
    });

    const media = $('#mediaSel');
    if (!media.dataset.built) {
      media.innerHTML = D.mediaPlacements.map(m => '<option value="' + m.id + '">' + esc(m.name) + '</option>').join('');
      media.dataset.built = '1';
    }
    media.value = state.media;

    const kind = D.disclosureKinds.find(k => k.id === state.kind) || D.disclosureKinds[0];
    const sentence = C.buildDisclosure(state.kind, { brand: state.brand });
    const p = $('#discSentence');
    if (p) p.textContent = sentence;
    const tip = $('#discTip');
    if (tip) {
      const mp = D.mediaPlacements.find(m => m.id === state.media) || D.mediaPlacements[0];
      tip.textContent = mp.name + '은 ' + mp.where + '. ' + mp.tip + ' ' + kind.note;
    }
    const st = $('#discState');
    if (st) {
      st.textContent = last.chars
        ? '현재 본문: ' + d.label
        : '본문이 비어 있습니다.';
      st.style.color = d.needsAction ? 'var(--danger)' : 'var(--ink-4)';
    }

    const sum = $('#discSummary');
    if (sum) {
      const need = (last.checklist || []).filter(x => x.status === 'gap').length;
      sum.innerHTML =
        '<div class="stat ' + (d.status === 'ok' ? 'ok' : 'hot') + '"><b>' + (d.status === 'ok' ? '표시됨' : d.status === 'none' ? '없음' : d.status === 'weak' ? '불명확' : '위치 미흡') + '</b><span>대가성 표시</span></div>' +
        '<div class="stat ' + (need ? 'hot' : 'ok') + '"><b>' + need + '</b><span>보완 필요 고지</span></div>' +
        '<div class="stat"><b>' + last.industryName + '</b><span>업종</span></div>';
    }

    const bw = $('#badWords');
    if (bw && !bw.dataset.built) {
      const bad = ['체험단', '체험후기', '보내주셨어요', '선물', '사장님 감사합니다', '#브랜드명', '×협업', '이 글은 정보성 글'];
      bw.innerHTML = bad.map(w => '<span>' + esc(w) + '</span>').join('') +
        '<span class="ok" style="color:var(--ok);background:color-mix(in srgb,var(--ok) 7%,transparent);border-color:color-mix(in srgb,var(--ok) 22%,var(--line));text-decoration:none">광고입니다</span>' +
        '<span class="ok" style="color:var(--ok);background:color-mix(in srgb,var(--ok) 7%,transparent);border-color:color-mix(in srgb,var(--ok) 22%,var(--line));text-decoration:none">#협찬</span>' +
        '<span class="ok" style="color:var(--ok);background:color-mix(in srgb,var(--ok) 7%,transparent);border-color:color-mix(in srgb,var(--ok) 22%,var(--line));text-decoration:none">원고료 지급받음</span>';
      bw.dataset.built = '1';
    }
  }

  function renderChecklist() {
    const box = $('#checklist');
    if (!box || !last) return;
    const items = last.checklist || [];
    const gap = items.filter(i => i.status === 'gap').length;
    const pass = items.filter(i => i.status === 'pass').length;
    const sum = $('#checkSummary');
    if (sum) sum.textContent = '통과 ' + pass + ' · 보완 ' + gap + ' · 확인 ' + (items.length - pass - gap);

    const icon = st => st === 'pass' ? '✓' : st === 'gap' ? '✕' : '?';
    const stText = st => st === 'pass' ? '통과' : st === 'gap' ? '보완' : '확인';
    box.innerHTML = items.map(i =>
      '<div class="check-item ' + i.status + '">' +
      '<span class="check-icon" aria-hidden="true">' + icon(i.status) + '</span>' +
      '<div class="check-body">' +
      '<div class="check-label">' + esc(i.label) +
      '<span class="check-st">' + stText(i.status) + '</span></div>' +
      '<div class="check-src">' + esc(i.source) + '</div>' +
      '<div class="check-detail">' + esc(i.detail || i.gapHint || '') + '</div>' +
      '</div></div>'
    ).join('');
  }

  function promptText() {
    if (!last) return '';
    return C.buildPrompt({
      industry: state.industry,
      text: state.text,
      findings: last.findings,
      disclosure: last.disclosure,
      mode: state.mode,
    });
  }

  /* ── 무료 AI 맛보기 (교정) ─────────────────────────────── */
  function renderFreeLimit(res) {
    const card = $('#freeLimitCard');
    const st = $('#freeStatus');
    if (st) st.textContent = '오늘 무료 횟수를 다 썼어요';
    if (!card) return;
    const cta = (res && res.cta) || {};
    const href = cta.keyUrl || 'https://aistudio.google.com/apikey';
    card.hidden = false;
    card.innerHTML =
      '<b>무료 체험을 다 쓰셨서요</b>' +
      '<div>' + esc((res && res.message) || '내 무료 키나 구독 AI로 이어서 교정할 수 있어요.') + '</div>' +
      '<div class="free-limit-actions">' +
        '<a class="btn btn-primary btn-sm" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">내 무료 Gemini 키 연결</a>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-action="copy-prompt">프롬프트 복사해서 구독 AI로</button>' +
      '</div>';
  }

  /* 무료 체험은 짧은 교정만 받는다(Worker 12초 제한 실측). Pro/구독 AI는 전체 프롬프트. */
  function freePromptText() {
    const text = String(state.text || '').trim();
    if (!text) return '';
    const trimmed = text.length > 500 ? text.slice(0, 500) + '…' : text;
    return '너는 표시광고법 검수자다. 아래 문구에서 위반 위험이 있는 표현을 찾아 이유와 함께 3개까지 짚고, ' +
      '안전한 대체 문구를 3개 제안해라. 700자 이내.\n\n문구: ' + trimmed;
  }

  function runFreeFix() {
    if (!FA) { toast('무료 체험 엔진을 불러오지 못했어요.'); return; }
    if (freeBusy) return;
    const p = freePromptText();
    if (!p) { toast('문구를 먼저 넣고 검수하세요.'); return; }
    freeBusy = true;
    const btn = $('[data-action="free-fix"]');
    if (btn) { btn.disabled = true; btn.textContent = '무료 AI가 고치는 중…'; }
    const st = $('#freeStatus');
    if (st) st.textContent = '무료로 교정 중… (5~20초)';
    const card = $('#freeLimitCard');
    if (card) card.hidden = true;
    const done = () => { freeBusy = false; if (btn) { btn.disabled = false; btn.textContent = '무료 AI로 교정'; } };

    FA.generate({ task: 'text', prompt: p, options: { temperature: 0.3, maxTokens: 600 } }, { timeoutMs: 45000 })
      .then(res => {
        done();
        if (res && res.ok) {
          $('#aiAnswer').value = res.text;
          $('#aiAnswer').dispatchEvent(new Event('input'));
          if (st) st.textContent = '무료로 교정받았어요' + (res.provider ? ' · ' + res.provider : '');
          const rem = $('#freeRemain');
          if (rem && res.remaining !== undefined && res.remaining !== null) rem.textContent = '남은 무료 ' + res.remaining + '/' + (res.limit || 5) + '회';
          toast('교정본을 받았어요 · [이 글로 교체하고 재검수]를 누르세요.');
          return;
        }
        if (FA.isQuota(res)) { renderFreeLimit(res); return; }
        if (st) st.textContent = (res && res.message) || '무료 교정에 실패했어요.';
        toast((res && res.message) || '무료 교정에 실패했어요.');
      }, () => {
        done();
        toast('무료 체험에 연결하지 못했어요.');
      });
  }

  function renderPrompt() {
    const box = $('#promptBox');
    if (!box) return;
    const p = promptText();
    box.textContent = p || '문구를 먼저 붙여넣으세요.';
    const len = $('#promptLen');
    if (len) len.textContent = fmt(p.length) + '자';
    const sum = $('#bridgeSummary');
    if (sum) {
      sum.innerHTML =
        '<div class="stat ' + (last && last.counts.total ? 'hot' : 'ok') + '"><b>' + (last ? last.counts.total : 0) + '</b><span>넘길 위험 표현</span></div>' +
        '<div class="stat"><b>' + (last ? last.disclosure.status === 'ok' ? '표시됨' : '필요' : '—') + '</b><span>대가성</span></div>';
    }
  }

  function renderReport() {
    const box = $('#reportBox');
    if (!box || !last) return;
    const text = C.buildReport({
      industryName: last.industryName,
      chars: last.chars,
      counts: last.counts,
      safety: last.safety,
      grade: last.grade,
      gradeLabel: last.gradeLabel,
      findings: last.findings,
      disclosure: last.disclosure,
      checklist: last.checklist,
      text: state.text,
      project: state.project,
      reviewer: state.reviewer,
      now: Date.now(),
    });
    box.textContent = text;
    const meta = $('#reportMeta');
    if (meta) meta.textContent = (last.counts.total ? C.summaryLine(last.counts) : '위험 표현 0건') + ' · 안전도 ' + last.safety;
    const chars = $('#reportChars');
    if (chars) chars.textContent = fmt(text.length) + '자';
    const note = $('#reportNote');
    if (note) {
      note.innerHTML = '이 리포트는 <b>참고용 사전 점검</b>이며 법률 자문이 아닙니다. 클라이언트에게 보낼 때 이 문장을 지우지 마세요.';
    }
    const sum = $('#reportSummary');
    if (sum) {
      sum.innerHTML =
        '<div class="stat ' + (last.counts.high ? 'hot' : 'ok') + '"><b>' + last.counts.high + '</b><span>고위험</span></div>' +
        '<div class="stat warn"><b>' + last.counts.warn + '</b><span>주의</span></div>' +
        '<div class="stat info"><b>' + last.counts.info + '</b><span>권고</span></div>' +
        '<div class="stat"><b>' + last.safety + '</b><span>안전도</span></div>';
    }
  }

  /* ── 탭 ──────────────────────────────────────────── */
  function switchTab(name) {
    state.tab = name;
    $$('.tab').forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + name; });
    saveNow();
  }

  function buildIndustrySeg() {
    const seg = $('#industrySeg');
    seg.innerHTML = D.industries.map(i =>
      '<button type="button" data-ind="' + i.id + '"' + (state.industry === i.id ? ' class="is-on"' : '') + '>' +
      '<i class="ind-dot" style="--c:' + i.color + '"></i>' + esc(i.name) + '</button>'
    ).join('');
  }

  function setIndustry(id) {
    if (!D.industries.some(i => i.id === id)) return;
    const prevSample = D.samples[state.industry];
    const wasSample = state.text.trim() && state.text === prevSample;
    state.industry = id;
    if (wasSample) state.text = D.samples[id];
    $$('#industrySeg button').forEach(b => b.classList.toggle('is-on', b.dataset.ind === id));
    $('#adText').value = state.text;
    scanNow();
    saveNow();
  }

  /* ── 검수 동작 ────────────────────────────────────── */
  function doFix(fid, i) {
    if (!last) return;
    const f = last.findings.find(x => x.id === fid);
    if (!f) return;
    const fix = (f.fixes || [])[i];
    if (typeof fix !== 'string') return;
    pushUndo('"' + f.match + '" 치환');
    state.text = C.applyFix(state.text, f, fix);
    $('#adText').value = state.text;
    scanNow();
    save();
    toast('"' + f.match + '" → 대체 문구로 바꿨습니다. 되돌리기로 원복할 수 있습니다.');
  }

  function applyAllHigh() {
    if (!last) return;
    const highs = last.findings.filter(f => f.severity === 'high' && f.fixes && f.fixes.length);
    if (!highs.length) { toast('일괄 치환할 고위험 표현이 없습니다.'); return; }
    pushUndo('고위험 ' + highs.length + '건 일괄 치환');
    state.text = C.applyMany(state.text, highs, ['high']);
    $('#adText').value = state.text;
    scanNow();
    save();
    toast('고위험 ' + highs.length + '건을 대표 대체 문구로 바꿨습니다. 문맥을 확인하세요.');
  }

  function doUndo() {
    const u = undo.pop();
    if (!u) return;
    state.text = u.text;
    $('#adText').value = state.text;
    scanNow();
    save();
    updateUndoBtn();
    toast('되돌렸습니다.');
  }

  function focusFinding(fid) {
    if (state.filter !== 'all') {
      const f = last && last.findings.find(x => x.id === fid);
      if (f && f.severity !== state.filter) { state.filter = 'all'; renderFindings(); }
    }
    const card = $('#card-' + fid);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('is-focus');
    const mark = $('#hlView mark[data-fid="' + fid + '"]');
    if (mark) mark.classList.add('is-focus');
    setTimeout(() => { card.classList.remove('is-focus'); if (mark) mark.classList.remove('is-focus'); }, 1800);
  }

  /* ── 대가성 ──────────────────────────────────────── */
  function insertDisclosure() {
    const sentence = C.buildDisclosure(state.kind, { brand: state.brand });
    if (!state.text.trim()) {
      state.text = sentence;
    } else {
      pushUndo('대가성 문구 삽입');
      state.text = C.insertTop(state.text, sentence);
    }
    $('#adText').value = state.text;
    scanNow();
    save();
    toast('본문 맨 앞에 대가성 문구를 넣었습니다.');
  }

  /* ── AI 교정 ─────────────────────────────────────── */
  function renderAiResult() {
    const box = $('#aiResult');
    if (!box || !last) return;
    if (!aiApplied) {
      box.innerHTML = '<span class="muted">아직 교체한 결과가 없습니다. AI가 준 본문을 붙여넣고 적용하면 자동으로 다시 검수합니다.</span>';
      return;
    }
    if (!state.text.trim()) { box.innerHTML = ''; return; }
    if (last.passed) {
      box.innerHTML = '<div class="res-line"><span class="res-badge ok">0건 통과</span>' +
        '<span>규칙 기준 위험 표현이 없습니다. 대가성 표시 상태도 함께 확인하세요.</span></div>';
    } else {
      box.innerHTML = '<div class="res-line"><span class="res-badge bad">' + last.counts.total + '건 남음</span>' +
        '<span>' + esc(C.summaryLine(last.counts)) + ' · 프롬프트를 다시 돌려 보세요.</span></div>' +
        '<ul>' + last.findings.slice(0, 4).map(f =>
          '<li><b>"' + esc(f.match) + '"</b> — ' + esc(f.label) + '</li>').join('') + '</ul>';
    }
  }

  function applyAi() {
    const ta = $('#aiAnswer');
    const cleaned = B.cleanAnswer(ta.value);
    if (!cleaned) { toast('붙여넣은 글이 없습니다.', 'warn'); return; }
    if (preAi === null) preAi = state.text;
    pushUndo('AI 교정본 적용');
    state.text = cleaned;
    aiApplied = true;
    $('#adText').value = state.text;
    scanNow();
    save();
    $('#bridgeBadge').hidden = false;
    $('#revertAi').hidden = false;
    renderAiResult();
    if (last.passed) toast('재검수 결과 0건 통과입니다.');
    else toast('재검수 결과 ' + last.counts.total + '건이 남았습니다. 검수 탭에서 확인하세요.', 'warn');
  }

  function revertAi() {
    if (preAi === null) return;
    state.text = preAi;
    preAi = null;
    aiApplied = false;
    $('#adText').value = state.text;
    $('#aiAnswer').value = '';
    $('#revertAi').hidden = true;
    $('#bridgeBadge').hidden = true;
    scanNow();
    save();
    renderAiResult();
    toast('AI 적용 전 본문으로 돌아갔습니다.');
  }

  /* ── 가이드 모달 ─────────────────────────────────── */
  function openGuide() {
    const root = $('#modalRoot');
    root.hidden = false;
    root.innerHTML =
      '<div class="modal-backdrop" data-action="close-modal"></div>' +
      '<div class="modal" role="dialog" aria-modal="true" aria-label="사용법">' +
      '<div class="modal-head"><h2>이렇게 쓰면 3분</h2>' +
      '<button type="button" class="modal-close" data-action="close-modal" aria-label="닫기">✕</button></div>' +
      '<div class="modal-body">' +
      '<h3>1. 업종을 고르고 문구를 붙여넣습니다</h3>' +
      '<p>업종마다 적용 법령이 다릅니다. 건강기능식품은 식품표시광고법, 화장품은 화장품법, 병원은 의료법, 일반 상품·체험단은 표시광고법이 중심입니다. 공통 규칙(최상급·비교·가격)은 어느 업종에서나 함께 검사합니다.</p>' +
      '<h3>2. 색이 칠해진 표현을 봅니다</h3>' +
      '<p><b>고위험(빨강)</b>은 그 자체로 형사처벌·영업정지 조항이 걸리는 표현, <b>주의(주황)</b>는 근거 자료·심의가 있어야 하는 표현, <b>권고(파랑)</b>는 명칭·표시를 정확히 하면 되는 표현입니다. 카드마다 법 조문과 제재 금액이 붙습니다.</p>' +
      '<h3>3. 대체 문구를 누르면 바로 바뀝니다</h3>' +
      '<p>카드의 <b>대체</b> 버튼을 누르면 그 자리에서 문구가 교체됩니다. 문맥이 어색하면 <b>되돌리기</b>로 원복하세요. 여러 건을 한 번에 바꾸려면 고위험 일괄 치환을 씁니다.</p>' +
      '<h3>4. 대가성 문구와 필수 고지를 채웁니다</h3>' +
      '<p>협찬·체험단 글은 제목이나 첫 부분에 경제적 이해관계를 표시해야 합니다. 받은 내용을 고르면 지침 예시에 맞는 문구가 만들어지고, 본문 맨 앞에 바로 넣을 수 있습니다.</p>' +
      '<h3>5. AI로 다듬고 다시 검수합니다</h3>' +
      '<p>AI 교정 탭에서 프롬프트를 복사해 평소 쓰는 AI에 붙여넣고, 고친 본문을 다시 넣으면 <b>0건 통과</b>까지 확인할 수 있습니다. 사실을 새로 만들지 않도록 프롬프트에 조건을 넣어 두었습니다.</p>' +
      '<h3>6. 클라이언트에게 리포트를 보냅니다</h3>' +
      '<p>검수 리포트 탭에서 근거·제재·권장 문구·고지 상태가 담긴 1장 리포트를 복사하거나 저장합니다.</p>' +
      '<h3>이 도구가 하지 않는 것</h3>' +
      '<ul>' +
      '<li>이미지·영상 속 글자, 음성 광고는 검사하지 않습니다.</li>' +
      '<li>근거 자료의 진위, 심의 통과 여부를 판정하지 않습니다.</li>' +
      '<li>법률 자문이 아닙니다. 최종 판단은 변호사·심의기관의 확인이 필요합니다.</li>' +
      '<li>본문을 서버로 보내지 않습니다. 저장은 이 브라우저에만 됩니다.</li>' +
      '</ul>' +
      '<p class="foot-note">법령 기준일 2026-11-21. 표시광고법 제3조·제9조·제17조, 식품표시광고법 제8조·제26조·제27조, 화장품법 제13조·제14조·제37조, 의료법 제56조·제57조·제89조, 공정위 추천·보증 심사지침(2026.6.1 시행)을 기준으로 규칙을 만들었습니다.</p>' +
      '</div></div>';
  }

  function closeModal() {
    const root = $('#modalRoot');
    root.hidden = true;
    root.innerHTML = '';
  }

  /* ── 이벤트 ──────────────────────────────────────── */
  function bind() {
    // 탭
    $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

    // 테마
    $('[data-action="toggle-theme"]').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      saveNow();
    });

    // 업종
    $('#industrySeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-ind]');
      if (b) setIndustry(b.dataset.ind);
    });

    // 옵션
    $('#optInfo').addEventListener('change', e => {
      state.includeInfo = e.target.checked;
      scanNow(); saveNow();
    });
    $('#optSponsored').addEventListener('change', e => {
      state.sponsored = e.target.checked;
      scanNow(); saveNow();
    });

    // 본문
    const ta = $('#adText');
    ta.addEventListener('input', e => {
      state.text = e.target.value;
      if (aiApplied) {
        aiApplied = false;
        preAi = null;
        $('#revertAi').hidden = true;
        $('#bridgeBadge').hidden = true;
        renderAiResult();
      }
      $('#charCount').textContent = fmt(state.text.length) + '자';
      scheduleScan();
      save();
    });

    // 버튼 (정적)
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const act = el.dataset.action;
      if (act === 'go-scan') { e.preventDefault(); switchTab('scan'); }
      else if (act === 'load-sample') {
        pushUndo('예시 불러오기');
        state.text = D.samples[state.industry];
        ta.value = state.text;
        scanNow(); save();
        toast(state.industryName + ' 예시 문구를 불러왔습니다.');
      } else if (act === 'undo') doUndo();
      else if (act === 'apply-all') applyAllHigh();
      else if (act === 'open-guide') openGuide();
      else if (act === 'close-modal') closeModal();
      else if (act === 'insert-disclosure') insertDisclosure();
      else if (act === 'copy-disclosure') {
        B.copy(C.buildDisclosure(state.kind, { brand: state.brand }));
        toast('표시 문구를 복사했습니다.');
      } else if (act === 'copy-prompt') {
        B.copy(promptText());
        toast('프롬프트를 복사했습니다.');
        $('#copyState').textContent = '복사됨';
      } else if (act === 'download-prompt') {
        download(stampName('교정-프롬프트', 'txt'), promptText());
      } else if (act === 'free-fix') runFreeFix();
      else if (act === 'apply-ai') applyAi();
      else if (act === 'clear-ai') {
        $('#aiAnswer').value = '';
        $('#aiResult').innerHTML = '';
        aiApplied = false;
        $('#bridgeBadge').hidden = true;
      } else if (act === 'revert-ai') revertAi();
      else if (act === 'copy-report') {
        B.copy($('#reportBox').textContent);
        toast('검수 리포트를 복사했습니다.');
      } else if (act === 'download-report') {
        download(stampName('검수리포트', 'txt'), $('#reportBox').textContent);
      } else if (act === 'download-csv') {
        download(stampName('검수결과', 'csv'), buildCsv(), 'text/csv;charset=utf-8');
        toast('검수 결과를 CSV로 저장했습니다.');
      } else if (act === 'print-report') {
        window.print();
      }
    });

    // 이슈 카드 치환
    $('#findingsList').addEventListener('click', e => {
      const b = e.target.closest('[data-fix]');
      if (!b) return;
      doFix(b.dataset.fix, Number(b.dataset.i));
    });

    // 필터
    $('#sevFilter').addEventListener('click', e => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      state.filter = b.dataset.filter;
      renderFindings();
      saveNow();
    });

    // 하이라이트 토글
    $('#hlSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-hl]');
      if (!b) return;
      state.hlMode = b.dataset.hl;
      $$('#hlSeg button').forEach(x => x.classList.toggle('is-on', x === b));
      renderHighlight();
      saveNow();
    });

    // 하이라이트 클릭 → 카드
    $('#hlView').addEventListener('click', e => {
      const m = e.target.closest('mark[data-fid]');
      if (m) focusFinding(m.dataset.fid);
    });

    // 대가성 유형
    $('#kindGrid').addEventListener('change', e => {
      const r = e.target.closest('input[name="discKind"]');
      if (!r) return;
      state.kind = r.value;
      renderDisclosure();
      saveNow();
    });

    $('#brandName').addEventListener('input', e => {
      state.brand = e.target.value;
      $('#discSentence').textContent = C.buildDisclosure(state.kind, { brand: state.brand });
      save();
    });

    $('#mediaSel').addEventListener('change', e => {
      state.media = e.target.value;
      renderDisclosure();
      saveNow();
    });

    // AI 모드
    $('#modeSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      state.mode = b.dataset.mode;
      $$('#modeSeg button').forEach(x => x.classList.toggle('is-on', x === b));
      renderPrompt();
      saveNow();
    });

    // AI 브리지 버튼
    $('#bridgeBtns').innerHTML = B.AIS.map(ai =>
      '<button type="button" class="btn btn-ghost bridge-btn" data-ai="' + ai.id + '">' +
      '<span>' + esc(ai.name) + '</span><span class="b-tag">복사 + 새 창</span></button>'
    ).join('');
    $('#bridgeBtns').addEventListener('click', e => {
      const b = e.target.closest('[data-ai]');
      if (!b) return;
      const p = promptText();
      if (!p) { toast('먼저 문구를 입력하세요.', 'warn'); return; }
      const r = B.open(b.dataset.ai, p);
      if (!r.ok) { toast('알 수 없는 서비스입니다.', 'warn'); return; }
      toast((r.ai ? r.ai.name : 'AI') + ' 창을 열었습니다. 프롬프트가 복사되어 있으니 붙여넣으세요.');
      $('#bridgeNote').textContent = r.blocked
        ? '팝업이 차단되었습니다. 주소창의 차단 알림을 허용하거나 프롬프트 복사 후 직접 접속하세요.'
        : '프롬프트가 클립보드에 복사되었습니다. 새로 열린 창에 붙여넣으세요.';
    });

    // 리포트 입력
    $('#projectName').addEventListener('input', e => {
      state.project = e.target.value;
      renderReport();
      save();
    });
    $('#reviewerName').addEventListener('input', e => {
      state.reviewer = e.target.value;
      renderReport();
      save();
    });

    // Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#070a10' : '#ffffff');
    const btn = $('[data-action="toggle-theme"]');
    if (btn) btn.setAttribute('aria-label', state.theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환');
  }

  /* ── 시작 ────────────────────────────────────────── */
  function init() {
    const had = load();

    // 첫 방문이면 예시로 화면을 채운다 (빈 화면보다 동작이 분명하다).
    if (!had || !state.text.trim()) {
      if (!state.text.trim()) state.text = D.samples[state.industry] || D.samples.health;
    }

    applyTheme();
    buildIndustrySeg();

    $('#adText').value = state.text;
    $('#optInfo').checked = state.includeInfo;
    $('#optSponsored').checked = state.sponsored;
    $('#brandName').value = state.brand;
    $('#projectName').value = state.project;
    $('#reviewerName').value = state.reviewer;
    $('#modeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('is-on', b.dataset.mode === state.mode));
    $('#hlSeg').querySelectorAll('button').forEach(b => b.classList.toggle('is-on', b.dataset.hl === state.hlMode));

    bind();
    switchTab(state.tab || 'scan');
    scanNow();
    renderAiResult();
    updateUndoBtn();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
