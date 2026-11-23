/* ============================================================
   광고 문구 법률 검수기 · core.js
   검사 엔진 + 치환 + 대가성 판정 + 리포트 + AI 프롬프트.
   DOM을 쓰지 않는다. node에서 require('./core.js')로 그대로 테스트한다.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CORE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const DATA = (typeof module === 'object' && module.exports)
    ? require('./data.js')
    : root.AD_DATA;

  const num = new Intl.NumberFormat('ko-KR');
  const cache = new Map();

  /* 한국어 어절·조사 엔진(engines/korean-text.js). 없으면 기존 정규식만 쓴다. */
  const KT = (function () {
    const g = typeof globalThis !== 'undefined' ? globalThis : root;
    if (g && g.KoreanText) return g.KoreanText;
    if (typeof require === 'function') {
      try { return require('./engines/korean-text.js'); } catch (e) { /* noop */ }
    }
    return null;
  })();

  const GW = { high: 9, warn: 4, info: 1 };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function ruleById(id) {
    return DATA.rules.find(r => r.id === id) || null;
  }
  function industryById(id) {
    return DATA.industries.find(i => i.id === id) || null;
  }

  /** 규칙 하나를 정규식으로 컴파일한다 (규칙 id별 1회). */
  function compile(rule) {
    if (cache.has(rule.id)) return cache.get(rule.id);
    let re;
    if (rule.regex) {
      re = new RegExp(rule.regex, rule.flags || 'g');
    } else {
      const alts = (rule.terms || []).slice().sort((a, b) => b.length - a.length).map(escRe);
      re = new RegExp('(?:' + alts.join('|') + ')', 'gi');
    }
    cache.set(rule.id, re);
    return re;
  }

  /**
   * 한 규칙의 모든 일치를 찾는다.
   * onlyIfNear: 일치 지점 앞뒤 nearWindow 안에 해당 단어가 있어야 채택.
   * unlessNear: 그 안에 있으면 제외.
   */
  function findMatches(text, rule) {
    if (!text) return [];
    const re = compile(rule);
    re.lastIndex = 0;
    const out = [];
    const win = rule.nearWindow || 14;
    let m;
    let guard = 0;

    /* nearby 조건(onlyIfNear/unlessNear/unlessAfter)을 한곳에서 판정한다. */
    function accepted(start, end) {
      if (rule.onlyIfNear && rule.onlyIfNear.length) {
        const around = text.slice(Math.max(0, start - win), Math.min(text.length, end + win));
        if (!rule.onlyIfNear.some(t => around.includes(t))) return false;
      }
      if (rule.unlessNear && rule.unlessNear.length) {
        const around = text.slice(Math.max(0, start - win), Math.min(text.length, end + win));
        if (rule.unlessNear.some(t => around.includes(t))) return false;
      }
      if (rule.unlessAfter && rule.unlessAfter.length) {
        const after = text.slice(end, end + 24);
        if (rule.unlessAfter.some(t => after.startsWith(t))) return false;
      }
      return true;
    }

    while ((m = re.exec(text)) !== null && guard++ < 500) {
      if (m[0] === '') { re.lastIndex++; continue; }
      const start = m.index;
      const end = start + m[0].length;
      if (!accepted(start, end)) continue;
      out.push({ start, end, match: m[0] });
    }

    /*
     * 띄어쓰기 변형 보완: 규칙 용어가 "부작용 없음"인데 글에 "부작용없음"이나
     * "부작용 이 없습니다"처럼 적힌 경우를 잡는다. 형태소 엔진이 있을 때만.
     */
    if (KT && rule.terms && !rule.regex) {
      rule.terms.forEach(function (term) {
        if (!/[\s]/.test(String(term))) return;
        const hits = KT.phraseMatch(text, term, { gap: 1 });
        hits.forEach(function (p) {
          const start = p.index;
          const end = p.index + p.length;
          if (!accepted(start, end)) return;
          if (out.some(function (o) { return start < o.end && end > o.start; })) return;
          out.push({ start: start, end: end, match: text.slice(start, end), relaxed: true });
        });
      });
      out.sort(function (a, b) { return a.start - b.start; });
    }
    return out;
  }

  function activeRules(industry) {
    return DATA.rules.filter(r =>
      r.industries.includes('common') || r.industries.includes(industry)
    );
  }

  /**
   * 본문 스캔.
   * opts: { industry, includeInfo=true, sponsored=true }
   */
  function scan(text, opts) {
    const o = Object.assign({ industry: 'commerce', includeInfo: true, sponsored: true }, opts || {});
    const body = typeof text === 'string' ? text : '';
    const ind = industryById(o.industry) || DATA.industries[0];

    const cands = [];
    for (const rule of activeRules(o.industry)) {
      if (rule.severity === 'info' && !o.includeInfo) continue;
      for (const m of findMatches(body, rule)) {
        /* 부정문 판정: "치료 효과가 없습니다"처럼 부정하는 문장은 위반이 아니다.
           다만 규칙 용어 자체가 "부작용 없음"인 경우는 match 안에 부정어가 있어
           여기서 잡히지 않는다(그건 그대로 위반). */
        const negBy = (KT && rule.severity !== 'info')
          ? KT.negationKind(body, m.start, m.end - m.start)
          : '';
        const severity = negBy ? 'info' : rule.severity;
        cands.push({
          ruleId: rule.id,
          severity: severity,
          baseSeverity: rule.severity,
          negated: !!negBy,
          negatedBy: negBy,
          relaxed: !!m.relaxed,
          group: rule.group,
          label: rule.label,
          start: m.start,
          end: m.end,
          match: m.match,
          law: rule.law,
          ref: rule.ref,
          penalty: rule.penalty,
          why: rule.why,
          fixes: rule.fixes || [],
          evidence: !!rule.evidence,
          weight: GW[severity] || 1,
        });
      }
    }

    // 겹치는 일치는 하나의 묶음으로 모으고, 그중 가장 위험한 규칙을 대표로 삼는다.
    // 나머지는 related로 붙여 카드에 "관련 규칙"으로 함께 보여 준다. 정보를 버리지 않기 위함.
    cands.sort((a, b) =>
      a.start - b.start ||
      b.weight - a.weight ||
      (b.end - b.start) - (a.end - a.start) ||
      a.ruleId.localeCompare(b.ruleId)
    );
    const clusters = [];
    for (const c of cands) {
      const last = clusters[clusters.length - 1];
      if (last && c.start < last.end) {
        last.items.push(c);
        last.end = Math.max(last.end, c.end);
      } else {
        clusters.push({ start: c.start, end: c.end, items: [c] });
      }
    }
    const accepted = [];
    for (const cl of clusters) {
      const items = cl.items.slice().sort((a, b) =>
        b.weight - a.weight ||
        (b.end - b.start) - (a.end - a.start) ||
        a.ruleId.localeCompare(b.ruleId)
      );
      const primary = Object.assign({}, items[0]);
      primary.related = items.slice(1).map(x => ({
        ruleId: x.ruleId, label: x.label, severity: x.severity, fixes: x.fixes, law: x.law, ref: x.ref,
      }));
      primary.clusterStart = cl.start;
      primary.clusterEnd = cl.end;
      accepted.push(primary);
    }
    accepted.sort((a, b) => a.start - b.start);
    accepted.forEach((f, i) => { f.id = 'f' + i; });

    const counts = { high: 0, warn: 0, info: 0, total: accepted.length };
    for (const f of accepted) counts[f.severity]++;

    const disclosure = checkDisclosure(body, o);

    let safety = 100 -
      counts.high * DATA.severities.high.deduct -
      counts.warn * DATA.severities.warn.deduct -
      counts.info * DATA.severities.info.deduct;
    if (o.sponsored && body.trim().length > 0) {
      if (disclosure.status === 'none') safety -= 12;
      else if (disclosure.status === 'weak' || disclosure.status === 'late') safety -= 7;
    }
    safety = Math.max(0, Math.min(100, Math.round(safety)));

    const grade = safety >= 90 ? 'A' : safety >= 70 ? 'B' : safety >= 40 ? 'C' : 'D';
    const gradeLabel = {
      A: '게시 전 최종 확인 권장',
      B: '일부 표현 보완 권장',
      C: '수정 후 게시 권장',
      D: '게시 보류 · 전면 수정',
    }[grade];

    const byGroup = {};
    for (const f of accepted) {
      byGroup[f.group] = byGroup[f.group] || { count: 0, severity: f.severity };
      byGroup[f.group].count++;
      if (GW[f.severity] > GW[byGroup[f.group].severity]) byGroup[f.group].severity = f.severity;
    }

    const checklist = buildChecklist(body, { industry: o.industry, findings: accepted, disclosure, sponsored: o.sponsored });

    return {
      text: body,
      industry: o.industry,
      industryName: ind.name,
      industryLaw: ind.law,
      includeInfo: o.includeInfo,
      sponsored: o.sponsored,
      findings: accepted,
      counts,
      safety,
      grade,
      gradeLabel,
      passed: accepted.length === 0,
      disclosure,
      checklist,
      byGroup,
      chars: body.length,
      charsNoSpace: body.replace(/\s/g, '').length,
      sentences: body.split(/[.!?。\n]+/).filter(s => s.trim()).length,
      scannedRules: activeRules(o.industry).length,
    };
  }

  /* ── 대가성 표시 판정 ─────────────────────────────────── */

  const STRONG_PATTERNS = [
    { re: /#\s*(?:유료\s*광고|광고|협찬)/g, kind: '해시태그 광고' },
    { re: /#\s*(?:ad|sponsored)\b/gi, kind: '해시태그 광고' },
    { re: /(?:유료\s*광고|대가성\s*광고|광고\s*콘텐츠|광고입니다|광고\s*포함|협찬\s*광고|유료\s*광고\s*포함)/g, kind: '광고 표시' },
    { re: /(?:협찬|광고)\s*(?:을\s*)?받(?:았|아|음|습니다)/g, kind: '협찬 표시' },
    { re: /(?:원고료|광고료|수수료|사례금|경제적\s*대가|금전)[^.\n]{0,14}(?:지급|제공|지원|할인|받)/g, kind: '금전 대가' },
    { re: /(?:제품|상품|서비스|이용권|제품권|상품권|식사|숙박|시술)[^.\n]{0,14}(?:무상|무료)?\s*(?:제공|지급|할인)\s*받/g, kind: '현물 대가' },
    { re: /(?:무상|무료)로?\s*(?:제공|지급)\s*받/g, kind: '무상 제공' },
    { re: /지급받(?:아|고|음)\s*작성/g, kind: '대가 지급 후 작성' },
  ];

  const WEAK_PATTERNS = [
    { re: /(?:체험단|체험\s*후기|체험후기|서포터즈|앰버서더|공동구매|공구)/g, kind: '체험단·서포터즈' },
    { re: /(?:보내주셨어요|보내주셨|감사합니다|선물|덕분에\s*받)/g, kind: '호의로 읽히는 표현' },
    { re: /(?:이\s*글은\s*정보|홍보성\s*글|홍보\s*문구가\s*포함)/g, kind: '모호한 안내' },
    { re: /(?:협업|콜라보|collab|partnership)/gi, kind: '모호한 협업 표기' },
  ];

  function collect(text, patterns) {
    const out = [];
    for (const p of patterns) {
      const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
      let m; let guard = 0;
      while ((m = re.exec(text)) !== null && guard++ < 100) {
        if (m[0] === '') { re.lastIndex++; continue; }
        out.push({ text: m[0], index: m.index, kind: p.kind });
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /**
   * 대가성 표시 위치·명확성 판정.
   * status: ok | late | weak | none
   */
  function checkDisclosure(text, opts) {
    const o = opts || {};
    const t = typeof text === 'string' ? text : '';
    const strong = collect(t, STRONG_PATTERNS);
    const weak = collect(t, WEAK_PATTERNS);
    const headLimit = Math.min(400, Math.max(80, Math.ceil(t.length * 0.15)));
    const head = t.slice(0, headLimit);

    const strongInHead = strong.filter(s => s.index < headLimit);
    const first = strong[0] || null;
    let status, label;

    if (strongInHead.length) {
      status = 'ok';
      label = '제목·첫 부분에 표시됨';
    } else if (first && first.index >= Math.max(120, t.length * 0.5)) {
      status = 'late';
      label = '본문 뒤쪽에만 표시됨';
    } else if (first) {
      status = 'late';
      label = '본문 중간에만 표시됨';
    } else if (weak.length) {
      status = 'weak';
      label = '"체험단" 등 불명확한 표현만 있음';
    } else {
      status = 'none';
      label = '대가성 표시 없음';
    }

    return {
      status,
      label,
      headLimit,
      headText: head,
      strong,
      weak,
      firstStrongIndex: first ? first.index : -1,
      ok: status === 'ok',
      needsAction: o.sponsored === false ? false : status !== 'ok',
    };
  }

  function buildDisclosure(kindId, opts) {
    const o = opts || {};
    const kind = DATA.disclosureKinds.find(k => k.id === kindId) || DATA.disclosureKinds[0];
    const brand = (o.brand || '').trim() || '해당 업체';
    return kind.template.replace(/\{brand\}/g, brand);
  }

  function insertTop(text, sentence) {
    const body = String(text || '').replace(/^\s+/, '');
    if (!body) return sentence;
    if (body.startsWith(sentence)) return body;
    return sentence + '\n\n' + body;
  }

  /* ── 치환 ─────────────────────────────────────────────── */

  function applyFix(text, finding, fix) {
    if (!finding || typeof fix !== 'string') return text;
    return String(text).slice(0, finding.start) + fix + String(text).slice(finding.end);
  }

  /** 여러 이슈에 첫 번째 대체 문구를 뒤에서부터 적용한다(위치 밀림 방지). */
  function applyMany(text, findings, sevFilter) {
    const list = (findings || [])
      .filter(f => !sevFilter || sevFilter.includes(f.severity))
      .slice()
      .sort((a, b) => b.start - a.start);
    let out = String(text);
    for (const f of list) {
      if (f.fixes && f.fixes.length) out = out.slice(0, f.start) + f.fixes[0] + out.slice(f.end);
    }
    return out;
  }

  /* ── 위치 표시 ────────────────────────────────────────── */

  function locate(text, index) {
    const before = String(text).slice(0, Math.max(0, index));
    const line = before.split('\n').length;
    const delims = (before.match(/[.!?。\n]+/g) || []).length;
    const sentence = delims + 1;
    return { line, sentence };
  }

  /* ── 하이라이트 HTML ─────────────────────────────────── */

  function highlightHtml(text, findings) {
    const t = String(text || '');
    const list = (findings || []).slice().sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const f of list) {
      if (f.start < pos) continue;
      out += esc(t.slice(pos, f.start));
      out += '<mark class="hl sev-' + f.severity + '" data-fid="' + f.id + '" title="' + esc(f.label) + '">' +
        esc(t.slice(f.start, f.end)) + '</mark>';
      pos = f.end;
    }
    out += esc(t.slice(pos));
    return out;
  }

  /* ── 필수 고지 체크리스트 ─────────────────────────────── */

  function buildChecklist(text, ctx) {
    const t = String(text || '');
    const findings = ctx.findings || [];
    const ids = new Set(findings.map(f => f.ruleId));
    const has = re => re.test(t);
    const out = [];

    for (const rule of DATA.checklistRules) {
      const applies = rule.industries === 'all' || rule.industries.includes(ctx.industry);
      if (!applies) continue;
      let status = 'check';
      let detail = '';

      switch (rule.id) {
        case 'disclosure': {
          if (ctx.sponsored === false) {
            status = 'check';
            detail = '대가를 받지 않았다면 표시 의무가 없습니다. 대가를 받았다면 첫 줄에 표시하세요.';
          } else if (ctx.disclosure.status === 'ok') {
            status = 'pass';
            detail = '첫 부분에 표시가 있습니다. 본문과 구분되는지 눈으로 확인하세요.';
          } else if (ctx.disclosure.status === 'none') {
            status = 'gap';
            detail = '표시가 없습니다. 제목 또는 첫 부분에 넣으세요. 댓글·더보기 뒤는 인정되지 않습니다.';
          } else {
            status = 'gap';
            detail = ctx.disclosure.status === 'weak'
              ? '"체험단", "보내주셨어요" 같은 표현은 표시로 인정되지 않습니다. 받은 내용을 명확히 쓰세요.'
              : '본문 뒤쪽·중간에만 있습니다. 제목 또는 첫 부분으로 옮기세요.';
          }
          break;
        }
        case 'evidence': {
          const need = ['c-number', 'c-superlative', 'm-superlative', 'b-concentration', 'c-compare', 'commerce-fake-price']
            .some(id => ids.has(id));
          if (!need) { status = 'pass'; detail = '출처가 필요한 수치·최상급 표현이 발견되지 않았습니다.'; }
          else if (has(/출처|기준|조사|기관|시험|20\d\d|년\s*\d|랭킹|집계/)) {
            status = 'pass';
            detail = '출처·기준으로 보이는 표현이 있습니다. 실제 자료가 있는지 확인하세요.';
          } else {
            status = 'gap';
            detail = '수치·최상급 표현에 출처와 기준이 없습니다. 기관·기간·대상·집계 기준을 함께 적으세요.';
          }
          break;
        }
        case 'sideeffect': {
          if (/(?:부작용|후유증)[^.\n]{0,14}(?:있을 수|가능성|우려|주의)|개인차/.test(t)) {
            status = 'pass';
            detail = '부작용·개인차 안내 문구가 있습니다.';
          } else {
            status = 'gap';
            detail = '부작용·개인차 안내가 없습니다. 심각한 부작용 누락은 그 자체로 위반입니다.';
          }
          break;
        }
        case 'drugNotice': {
          if (has(/의약품이 아닙|의약품이 아님|의약품이 아닌|질병의 예방 및 치료를 위한 의약품/)) {
            status = 'pass';
            detail = '"의약품이 아닙니다" 고지가 있습니다.';
          } else {
            status = 'gap';
            detail = '"이 제품은 질병의 예방 및 치료를 위한 의약품이 아닙니다"를 함께 표시하세요.';
          }
          break;
        }
        case 'functionalScope': {
          const need = ['h-function', 'h-weight-word', 'b-functional', 'b-hair', 'b-disease'].some(id => ids.has(id));
          if (!need) { status = 'pass'; detail = '기능성·심사 범위를 묻는 표현이 없습니다.'; }
          else if (has(/인정|심사|보고|기능성\s*화장품/)) {
            status = 'pass';
            detail = '인정·심사 범위를 언급하고 있습니다. 인정서의 문구와 글자 단위로 대조하세요.';
          } else {
            status = 'gap';
            detail = '인정(심사·보고)받은 문구인지 확인할 수 없습니다. 원료별 인정 문구를 그대로 쓰세요.';
          }
          break;
        }
        case 'preReview': {
          status = 'check';
          detail = '일평균 이용자 10만 명 이상 매체(플랫폼 전체 기준)는 사전심의 대상입니다. 심의 유효기간은 3년입니다.';
          break;
        }
        case 'refund': {
          if (has(/청약철회|환불|교환|반품/)) {
            status = 'pass';
            detail = '청약철회·환불 관련 문구가 있습니다. 제한 사유가 법정 사유인지 확인하세요.';
          } else {
            status = 'check';
            detail = '환불·청약철회 조건이 본문에 없습니다. 상세페이지에 조건을 표시했는지 확인하세요.';
          }
          break;
        }
        case 'aiPerson': {
          status = 'check';
          detail = 'AI로 만든 모델·전문가 이미지를 썼다면 그 사실을 표시해야 합니다.';
          break;
        }
        default:
          status = 'check';
          detail = '';
      }
      out.push({ id: rule.id, label: rule.label, source: rule.source, gapHint: rule.gapHint, status, detail });
    }
    return out;
  }

  /* ── AI 프롬프트 ─────────────────────────────────────── */

  function buildPrompt(ctx) {
    const c = ctx || {};
    const industry = industryById(c.industry) || DATA.industries[0];
    const findings = c.findings || [];
    const text = String(c.text || '');
    const mode = c.mode || 'fix';

    const lines = [];
    lines.push('당신은 한국 광고 문구의 법률 검수를 돕는 카피 교정자입니다.');
    lines.push('아래 광고 문구를 ' + (mode === 'rewrite' ? '처음부터 다시 쓰되 ' : '') + '위법 소지가 없는 표현으로 고쳐 주세요.');
    lines.push('');
    lines.push('[업종] ' + industry.name + ' (적용 법령: ' + industry.law + ')');
    lines.push('');
    lines.push('[반드시 지킬 것]');
    lines.push('1. 원문의 사실(성분·용량·가격·기간·조건·주소)을 바꾸거나 새로 만들지 마세요.');
    lines.push('2. 확인할 수 없는 수치·순위·인증은 지어내지 말고 삭제하거나 "[확인 필요]"로 표시하세요.');
    lines.push('3. 아래 걸린 표현은 반드시 다른 표현으로 바꾸세요. 위험한 단어를 그대로 남기지 마세요.');
    lines.push('4. 질병·치료·완치·부작용 없음·100% 같은 단정은 남기지 마세요.');
    lines.push('5. 대가성 표시가 없으면 첫 줄에 "광고입니다" 또는 "소정의 원고료를 지급받고 작성했습니다"를 넣으세요.');
    lines.push('6. 문장 수와 말투는 원문과 비슷하게, 자연스러운 한국어 구어체로 쓰세요.');
    lines.push('');
    if (findings.length) {
      lines.push('[걸린 표현 ' + findings.length + '건]');
      const seen = new Set();
      for (const f of findings) {
        const key = f.ruleId + '|' + f.match;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push('- "' + f.match + '" (' + f.label + ', ' + f.law + ' ' + f.ref + ')');
        if (f.fixes && f.fixes.length) lines.push('  → 권장: ' + f.fixes.slice(0, 2).join(' / '));
      }
      lines.push('');
    } else {
      lines.push('[걸린 표현] 규칙 기준으로 발견되지 않았습니다. 표현을 더 자연스럽게 다듬는 데 집중하세요.');
      lines.push('');
    }
    if (c.disclosure) {
      lines.push('[대가성 표시] ' + c.disclosure.label +
        (c.disclosure.status === 'ok' ? '' : ' → 첫 부분에 표시 문구를 넣으세요.'));
      lines.push('');
    }
    lines.push('[원문]');
    lines.push(text.trim() || '(비어 있음)');
    lines.push('');
    lines.push('[출력] 교정한 본문만 출력하세요. 설명, 머리말, 코드블록, 인사말은 쓰지 마세요.');
    return lines.join('\n');
  }

  /* ── 검수 리포트 ─────────────────────────────────────── */

  const SEV_ORDER = ['high', 'warn', 'info'];

  function pad(n, w) { return String(n).padStart(w, ' '); }

  function buildReport(ctx) {
    const c = ctx || {};
    const now = c.now ? new Date(c.now) : new Date();
    const stamp = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');

    const counts = c.counts || { high: 0, warn: 0, info: 0, total: 0 };
    const findings = c.findings || [];
    const L = [];
    L.push('════════════════════════════════════');
    L.push('광고 문구 사전 검수 리포트 (참고용)');
    L.push('════════════════════════════════════');
    if (c.project) L.push('프로젝트: ' + c.project);
    if (c.reviewer) L.push('검수자: ' + c.reviewer);
    L.push('검수일: ' + stamp);
    L.push('업종: ' + (c.industryName || '') + '  ·  글자 수: ' + num.format(c.chars || 0) + '자');
    L.push('안전도: ' + (c.safety != null ? c.safety : 100) + '/100 · ' + (c.grade || 'A') + ' · ' + (c.gradeLabel || ''));
    L.push('요약: 고위험 ' + (counts.high || 0) + '건 · 주의 ' + (counts.warn || 0) + '건 · 권고 ' + (counts.info || 0) + '건');
    L.push('');

    if (!findings.length) {
      L.push('[결과] 규칙 기준 위험 표현 0건.');
      L.push('  · 다만 이 결과는 아래 검수 한계를 함께 읽어 주세요.');
      L.push('');
    } else {
      for (const sev of SEV_ORDER) {
        const group = findings.filter(f => f.severity === sev);
        if (!group.length) continue;
        L.push('[' + DATA.severities[sev].label + ' ' + group.length + '건]');
        group.forEach((f, i) => {
          const loc = locate(c.text || '', f.start);
          L.push(' ' + pad(i + 1, 2) + '. "' + f.match + '"  (L' + loc.line + ' · ' + loc.sentence + '번째 문장)');
          L.push('     근거: ' + f.law + ' ' + f.ref);
          L.push('     제재: ' + f.penalty);
          L.push('     사유: ' + f.why);
          if (f.fixes && f.fixes.length) {
            L.push('     권장: "' + f.fixes[0] + '"' + (f.fixes[1] ? ' / "' + f.fixes[1] + '"' : ''));
          }
          L.push('');
        });
      }
    }

    if (c.disclosure) {
      L.push('[대가성 표시]');
      L.push('  상태: ' + c.disclosure.label);
      if (c.disclosure.needsAction) {
        L.push('  조치: 추천·보증 심사지침상 제목 또는 첫 부분에 표시해야 합니다.');
        L.push('        예) "소정의 원고료를 지급받고 작성한 광고 콘텐츠입니다."');
      }
      L.push('  근거: 공정거래위원회 「추천·보증 등에 관한 표시·광고 심사지침」 Ⅴ.6');
      L.push('');
    }

    const cl = c.checklist || [];
    if (cl.length) {
      L.push('[필수 고지 체크]');
      for (const item of cl) {
        const mark = item.status === 'pass' ? '✓' : item.status === 'gap' ? '✕' : '?';
        L.push('  ' + mark + ' ' + item.label + (item.status === 'check' ? ' (직접 확인)' : ''));
        if (item.status !== 'pass' && item.detail) L.push('      ' + item.detail);
      }
      L.push('');
    }

    L.push('[검수 한계]');
    L.push('  · 이 리포트는 문구 패턴을 미리 정한 규칙과 대조한 참고용 사전 점검입니다.');
    L.push('  · 광고의 전체 맥락, 실제 근거 자료, 이미지·영상 속 문구, 매체별 규정은 반영되지 않습니다.');
    L.push('  · 최종 판단은 변호사 또는 해당 심의기관의 확인이 필요합니다.');
    L.push('  · 생성: 광고 문구 법률 검수기 (브라우저 로컬 실행 · 본문 외부 전송 없음)');
    return L.join('\n');
  }

  function gradeOf(safety) {
    return safety >= 90 ? 'A' : safety >= 70 ? 'B' : safety >= 40 ? 'C' : 'D';
  }

  function summaryLine(counts) {
    if (!counts || !counts.total) return '규칙 기준 위험 표현 0건';
    return '고위험 ' + counts.high + ' · 주의 ' + counts.warn + ' · 권고 ' + counts.info;
  }

  return {
    DATA: DATA,
    version: DATA.version,
    ruleById,
    industryById,
    findMatches,
    scan,
    checkDisclosure,
    buildDisclosure,
    insertTop,
    applyFix,
    applyMany,
    locate,
    highlightHtml,
    buildChecklist,
    buildPrompt,
    buildReport,
    gradeOf,
    summaryLine,
    esc,
    escRe,
    SEV_ORDER,
  };
});
