// 実験・イベントの振り返り(Positives / Reflections)の JSON を、サーバーで読むための部品。
// 画面側の app.js の parseFeedbackEntries(実験)/ parseEventFeedback(イベント)と同じ読み方をする。
// 要約に使うのは本文と種類だけなので、名前・memberId・日時・イベント名は返さない(docs/14 の §4-3)。
// D1 も外部への送信も使わない(単体テストできる)。

// 実験の振り返り: JSON 配列だけを読む。それ以外(空・壊れた JSON・普通の文章)は 0 件
export function parseFeedbackEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim().startsWith('[')) return [];
  try {
    const entries = JSON.parse(raw.trim());
    return Array.isArray(entries) ? entries : [];
  } catch (_) {
    return [];
  }
}

// イベントの振り返り: JSON 配列。以前の「1 つの文章」は、名前なしの 1 件(id 'fb_legacy')として読む
export function parseEventFeedback(raw) {
  if (Array.isArray(raw)) return raw;
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const entries = JSON.parse(s);
      if (Array.isArray(entries)) return entries;
    } catch (_) { /* 「[」で始まる普通の文章。下で 1 件として扱う */ }
  }
  return [{ id: 'fb_legacy', text: s, memberId: '', name: '' }];
}

// 並べ替え用の時刻(ミリ秒)。createdAt / date が無ければ、id の 'fb_<ミリ秒>_xxxx' から読む。読めなければ 0(いちばん古い扱い)
function entryTime(e) {
  const t = Date.parse(String(e.createdAt || e.date || ''));
  if (!isNaN(t)) return t;
  const m = /^fb_(\d{10,})_/.exec(String(e.id || ''));
  return m ? Number(m[1]) : 0;
}

// 1 件の行(experiments / events)から、要約に使う振り返りを { id, kind, text } の配列で返す。新しい順。
// kind は 'positive'(良かった点 = Positives)/ 'improve'(改善点 = Reflections)。本文が空の項目は除く
export function collectReflectionEntries(targetType, row) {
  if (!row) return [];
  const parse = targetType === 'events' ? parseEventFeedback : parseFeedbackEntries;
  const list = [];
  const fields = [['Positives', 'positive'], ['Reflections', 'improve']];
  for (const [field, kind] of fields) {
    parse(row[field]).forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      const text = typeof e.text === 'string' ? e.text.trim() : '';
      if (!text) return;
      const id = String(e.id || '').trim() || (kind + '_' + i);
      list.push({ id, kind, text, t: entryTime(e), order: list.length });
    });
  }
  // 新しい順。同じ時刻なら元の並び(安定)
  list.sort((a, b) => (b.t - a.t) || (a.order - b.order));
  return list.map(({ id, kind, text }) => ({ id, kind, text }));
}
