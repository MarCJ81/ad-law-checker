/* ============================================================
   AI 교정 브리지
   프롬프트를 클립보드에 복사하고, 사용자가 평소 쓰는 AI 서비스의
   새 창을 연다. 본문을 어디로도 자동 전송하지 않는다.
   ============================================================ */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AI_BRIDGE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const AIS = [
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      base: 'https://chatgpt.com/',
      query: 'https://chatgpt.com/?q=',
      hint: '무료·유료 모두',
    },
    {
      id: 'claude',
      name: 'Claude',
      base: 'https://claude.ai/new',
      query: 'https://claude.ai/new?q=',
      hint: '프로젝트에 붙여넣기',
    },
    {
      id: 'gemini',
      name: 'Gemini',
      base: 'https://gemini.google.com/app',
      query: null,
      hint: '새 대화에 붙여넣기',
    },
  ];

  // URL 길이 한도가 서비스마다 달라, 짧을 때만 질문으로 실어 보낸다.
  const URL_LIMIT = 3200;

  function aiById(id) {
    return AIS.find(a => a.id === id) || null;
  }

  function urlFor(id, prompt) {
    const ai = aiById(id);
    if (!ai) return null;
    const p = String(prompt || '');
    if (ai.query && p.length > 0 && p.length <= URL_LIMIT) {
      return ai.query + encodeURIComponent(p);
    }
    return ai.base;
  }

  /** 클립보드 복사 — 실패하면 textarea 폴백. 성공 여부를 돌려준다. */
  function copy(text) {
    const t = String(text || '');
    try {
      const nav = root.navigator;
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(t).catch(() => fallbackCopy(t));
        return true;
      }
    } catch (e) { /* 아래 폴백 */ }
    return fallbackCopy(t);
  }

  function fallbackCopy(t) {
    try {
      const doc = root.document;
      if (!doc) return false;
      const ta = doc.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      doc.body.appendChild(ta);
      ta.select();
      const ok = doc.execCommand('copy');
      doc.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  /** 프롬프트를 복사하고 새 창을 연다. 브라우저 팝업 차단 시 null. */
  function open(id, prompt) {
    const url = urlFor(id, prompt);
    if (!url) return { ok: false, reason: 'unknown-ai', url: null };
    copy(prompt);
    let win = null;
    try {
      win = root.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) { win = null; }
    return { ok: true, blocked: !win, url, ai: aiById(id) };
  }

  /**
   * AI가 준 답에서 코드블록·머리말·따옴표를 걷어낸다.
   * 본문을 고치지는 않는다 — 형식만 정리한다.
   */
  function cleanAnswer(raw) {
    let t = String(raw || '').replace(/\r\n/g, '\n').trim();
    if (!t) return '';

    // ```lang ... ``` 전체를 벗긴다 (여러 개면 첫 블록 우선)
    const fence = t.match(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    else t = t.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();

    // 앞쪽 머리말 1~2줄 제거 (짧은 안내 문장만)
    const PRE = /^(?:물론(?:입니다|이죠)?|네[,.]?\s|알겠습니다|다음은|아래는|수정(?:된|한)?\s*(?:본문|버전|문구)|교정(?:된|한)?\s*(?:본문|버전|문구)|광고\s*문구\s*(?:수정|교정))/;
    for (let i = 0; i < 2; i++) {
      const lines = t.split('\n');
      const first = (lines[0] || '').trim();
      const rest = lines.slice(1).join('\n').trim();
      if (first && first.length <= 90 && rest.length > 20 && PRE.test(first)) {
        t = rest;
      } else break;
    }

    // 전체를 감싼 따옴표
    if (/^["'“”].*["'“”]$/s.test(t) && t.length > 40) {
      t = t.slice(1, -1).trim();
    }
    return t.trim();
  }

  return { AIS, aiById, urlFor, copy, fallbackCopy, open, cleanAnswer, URL_LIMIT };
});
