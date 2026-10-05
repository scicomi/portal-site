/**
 * SciComi Site - Bot（意図解析分離型）
 *
 * 構成:
 *   1. Gemini API で質問の「意図」だけを解析（この段階で送るのは質問文のみ）
 *   2. ローカルのキャッシュ済みデータに対してクエリ実行
 *   3. 結果をチャットUIに表示
 */

let allData = { events: [], members: [], experiments: [] };
let chatHistory = [];
// 送信〜応答完了（自動再試行の待機を含む）まで true。多重送信と typing 表示の重複を防ぐ。
let isProcessing = false;

// 検索結果一覧の最大表示件数（チャットバブル内に数百件並ぶのを防ぐ）
const BOT_MAX_LIST_ITEMS = 50;

// ====== 使用量トラッカー ======

const usageTracker = {
  _key() { return CONFIG.GEMINI.USAGE_KEY; },
  _limit() { return CONFIG.GEMINI.DAILY_LIMIT; },

  get() {
    try {
      const raw = localStorage.getItem(this._key());
      if (!raw) return { date: todayISO(), count: 0, limit: this._limit() };
      const d = JSON.parse(raw);
      return d.date === todayISO() ? d : { date: todayISO(), count: 0, limit: this._limit() };
    } catch { return { date: todayISO(), count: 0, limit: this._limit() }; }
  },

  setFromServer(count, limit) {
    const d = { date: todayISO(), count: count || 0, limit: limit || this._limit() };
    try { localStorage.setItem(this._key(), JSON.stringify(d)); } catch (_) { /* 保存できなくてもゲージ表示は続ける */ }
    renderGauge();
  },

  count() { return this.get().count; },
  limit() { return this.get().limit || this._limit(); },
  remaining() { return Math.max(0, this.limit() - this.count()); }
};

// ====== Gemini クライアント（サーバープロキシ経由） ======

const gemini = {

  async parseIntent(message) {
    // システムプロンプトはサーバー側で生成・固定される（APIキー悪用防止）
    const result = await api.geminiProxy(message);

    if (result.usage !== undefined) {
      usageTracker.setFromServer(result.usage, result.limit);
    }

    const data = result.data;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(data.promptFeedback?.blockReason ? 'BLOCKED' : 'EMPTY_RESPONSE');
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error('PARSE_ERROR');
    }
  }
};

// ====== 日付ヘルパー ======
// 年度範囲のみ使用（旧 systemPrompt 用の currentFiscalYear / nextMonth* はサーバー移管に伴い削除）

function fiscalYearRange(fy) {
  return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
}

// ====== クエリエンジン ======

const queryEngine = {

  execute(intent, params) {
    switch (intent) {
      case 'find_members':     return this.findMembers(params);
      case 'find_events':      return this.findEvents(params);
      case 'find_experiments':  return this.findExperiments(params);
      case 'members_docs':     return this.membersWithoutDocs(params);
      case 'member_activity':  return this.memberActivity(params);
      case 'upcoming':         return this.findEvents({ date_from: todayISO(), ...params });
      case 'count':            return this.countItems(params);
      default:                 return { html: '' };
    }
  },

  // --- メンバー検索 ---
  findMembers(p) {
    let items = allData.members;
    if (p.fiscal_year) {
      items = items.filter(m => String(m.FiscalYear) === String(p.fiscal_year));
    } else if (p.active_only !== false) {
      const curFY = currentFiscalYear();
      items = items.filter(m => parseInt(m.FiscalYear || curFY) === curFY);
    }
    if (p.grade) items = items.filter(m => (m.StudentID || '').toUpperCase().startsWith(p.grade.toUpperCase()));
    if (p.member_category) items = items.filter(m => m.Category === p.member_category);
    if (p.name) items = items.filter(m => (m.Name || '').includes(p.name));
    if (p.keyword) {
      const kw = p.keyword.toLowerCase();
      items = items.filter(m =>
        (m.Name || '').toLowerCase().includes(kw) ||
        (m.Role || '').toLowerCase().includes(kw) ||
        (m.Note || '').toLowerCase().includes(kw) ||
        (m.Affiliation || '').toLowerCase().includes(kw)
      );
    }
    return { html: this._formatMembers(items), count: items.length };
  },

  // --- イベント検索 ---
  findEvents(p) {
    let items = allData.events.slice();   // 下で sort するので、キャッシュ本体の並びは変えない
    if (p.event_category) items = items.filter(e => e.Category === p.event_category);
    if (p.date_from) items = items.filter(e => (e.Date || '') >= p.date_from);
    if (p.date_to) items = items.filter(e => (e.Date || '') <= p.date_to);
    if (p.keyword) {
      const kw = p.keyword.toLowerCase();
      items = items.filter(e =>
        (e.Title || '').toLowerCase().includes(kw) ||
        (e.Location || '').toLowerCase().includes(kw) ||
        (e.Remarks || '').toLowerCase().includes(kw) ||
        (e.TransportMethod || '').toLowerCase().includes(kw)
      );
    }
    if (p.name) {
      items = items.filter(e =>
        (e.AdminKyoka || '').includes(p.name) ||
        (e.AdminHoukoku || '').includes(p.name) ||
        [e.PlanLeader, e.TransportDriver, e.TransportPassengers].some(v => (v || '').includes(p.name)) ||
        this._getPresenters(e).some(n => n.includes(p.name))
      );
    }
    items.sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
    return { html: this._formatEvents(items), count: items.length };
  },

  // --- 実験検索 ---
  findExperiments(p) {
    let items = allData.experiments;
    if (p.active_only !== false) items = items.filter(x => x.Active !== 'false');
    if (p.exp_category) items = items.filter(x => x.Category === p.exp_category);
    if (p.keyword) {
      const kw = p.keyword.toLowerCase();
      items = items.filter(x =>
        (x.Name || '').toLowerCase().includes(kw) ||
        (x.Materials || '').toLowerCase().includes(kw) ||
        (x.Notes || '').toLowerCase().includes(kw)
      );
    }
    return { html: this._formatExperiments(items), count: items.length };
  },

  // --- 書類未担当メンバー ---
  membersWithoutDocs(p) {
    const curFY = currentFiscalYear();
    const targetFY = p.fiscal_year ? parseInt(p.fiscal_year) : curFY;
    let members = allData.members.filter(m => parseInt(m.FiscalYear || curFY) === targetFY && (m.Category || 'member') === 'member');
    if (p.grade) members = members.filter(m => (m.StudentID || '').toUpperCase().startsWith(p.grade.toUpperCase()));

    let events = allData.events.filter(e => e.Category === 'normal' || e.Category === 'other');
    if (p.fiscal_year) {
      const r = fiscalYearRange(p.fiscal_year);
      events = events.filter(e => (e.Date || '') >= r.from && (e.Date || '') <= r.to);
    } else if (p.date_from || p.date_to) {
      if (p.date_from) events = events.filter(e => (e.Date || '') >= p.date_from);
      if (p.date_to) events = events.filter(e => (e.Date || '') <= p.date_to);
    }

    const docNames = new Set();
    events.forEach(e => {
      if (p.doc_type === 'kyoka' || p.doc_type === 'both' || !p.doc_type) {
        if (e.AdminKyoka) docNames.add(e.AdminKyoka.trim());
      }
      if (p.doc_type === 'houkoku' || p.doc_type === 'both' || !p.doc_type) {
        if (e.AdminHoukoku) docNames.add(e.AdminHoukoku.trim());
      }
    });

    const result = members.filter(m => !docNames.has((m.Name || '').trim()));

    let html = this._formatMembers(result);
    if (events.length === 0) {
      html = '<div class="bot-note">対象期間のイベントが見つかりませんでした。</div>' + html;
    } else {
      html = `<div class="bot-note">対象イベント ${events.length}件中、書類担当として名前があるメンバー ${docNames.size}人</div>` + html;
    }
    return { html, count: result.length };
  },

  // --- メンバーの活動 ---
  memberActivity(p) {
    if (!p.name) return { html: '<div class="bot-note">メンバー名を指定してください。</div>', count: 0 };

    const matchedMembers = allData.members.filter(m => (m.Name || '').includes(p.name));
    let events = allData.events;
    if (p.date_from) events = events.filter(e => (e.Date || '') >= p.date_from);
    if (p.date_to) events = events.filter(e => (e.Date || '') <= p.date_to);

    const result = events.filter(e => {
      const inAdmin = (p.include_in === 'admin' || p.include_in === 'both' || !p.include_in) &&
        ((e.AdminKyoka || '').includes(p.name) || (e.AdminHoukoku || '').includes(p.name));
      const inParts = (p.include_in === 'parts' || p.include_in === 'both' || !p.include_in) &&
        this._getPresenters(e).some(n => n.includes(p.name));
      // 企画担当者・運転者・同乗者も「担当した」に含める（担当を絞らない質問のとき）
      const inPlan = (p.include_in === 'both' || !p.include_in) &&
        [e.PlanLeader, e.TransportDriver, e.TransportPassengers].some(v => (v || '').includes(p.name));
      return inAdmin || inParts || inPlan;
    });

    result.sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));

    let html = '';
    if (matchedMembers.length > 0) {
      html += '<div class="bot-note">メンバー情報:</div>' + this._formatMembers(matchedMembers);
      html += '<div class="bot-note" style="margin-top:12px;">関連イベント:</div>';
    }
    html += this._formatEvents(result);
    return { html, count: result.length };
  },

  // --- カウント ---
  countItems(p) {
    const r = p.resource || 'events';
    let items = allData[r] || [];
    if (r === 'members') {
      if (p.fiscal_year) {
        items = items.filter(m => String(m.FiscalYear) === String(p.fiscal_year));
      } else if (p.active_only !== false) {
        const curFY = currentFiscalYear();
        items = items.filter(m => parseInt(m.FiscalYear || curFY) === curFY);
      }
      if (p.grade) items = items.filter(m => (m.StudentID || '').toUpperCase().startsWith(p.grade.toUpperCase()));
      if (p.member_category) items = items.filter(m => m.Category === p.member_category);
    }
    if (r === 'events') {
      if (p.event_category) items = items.filter(e => e.Category === p.event_category);
      if (p.date_from) items = items.filter(e => (e.Date || '') >= p.date_from);
      if (p.date_to) items = items.filter(e => (e.Date || '') <= p.date_to);
    }
    return { html: `<div class="bot-count">${items.length}<span>件</span></div>`, count: items.length };
  },

  // --- PartsList から担当者名を抽出（新旧フォーマット両対応） ---
  _getPresenters(event) {
    const names = [];
    normalizeParts(event.PartsList).forEach(it => {
      it.presenters.forEach(p => { if (p) names.push(String(p).trim()); });
    });
    return names;
  },

  // --- 結果フォーマット ---
  _moreNote(total) {
    if (total <= BOT_MAX_LIST_ITEMS) return '';
    return `<div class="bot-note">件数が多いため先頭${BOT_MAX_LIST_ITEMS}件のみ表示しています。期間やカテゴリで絞り込むか、各ページで確認してください。</div>`;
  },

  _formatMembers(items) {
    if (items.length === 0) return '<div class="bot-empty">該当するメンバーが見つかりませんでした。</div>';
    return `<div class="bot-result-count">${items.length}人</div>
      <div class="bot-result-list">${items.slice(0, BOT_MAX_LIST_ITEMS).map(m => {
        const grade = (m.StudentID || '').slice(0, 2);
        const role = memberRoleOf(m);
        const roleStr = role ? ` / ${escapeHtml(role)}` : '';
        const fy = m.FiscalYear ? ` (${m.FiscalYear}年度)` : '';
        return `<div class="bot-result-item member-item">
          <div class="bot-ri-main">${escapeHtml(m.Name)}</div>
          <div class="bot-ri-sub">${escapeHtml(grade)}${roleStr}${fy}</div>
        </div>`;
      }).join('')}</div>` + this._moreNote(items.length);
  },

  _formatEvents(items) {
    if (items.length === 0) return '<div class="bot-empty">該当するイベントが見つかりませんでした。</div>';
    return `<div class="bot-result-count">${items.length}件</div>
      <div class="bot-result-list">${items.slice(0, BOT_MAX_LIST_ITEMS).map(e => {
        const d = e.Date ? shortDate(e.Date) : '未定';
        const catCfg = getEventCategory(e.Category);
        const cat = catCfg.short;
        const admin = [];
        if (e.AdminKyoka) admin.push(`許可願: ${escapeHtml(e.AdminKyoka)}`);
        if (e.AdminHoukoku) admin.push(`報告書: ${escapeHtml(e.AdminHoukoku)}`);
        const adminStr = admin.length ? `<div class="bot-ri-detail">${admin.join(' | ')}</div>` : '';
        return `<div class="bot-result-item event-item bot-clickable" data-bot-open="event" data-id="${escapeAttr(e.ID)}" role="button" tabindex="0" title="クリックで詳細を表示">
          <div class="bot-ri-date">${d}</div>
          <div class="bot-ri-body">
            <div class="bot-ri-main">${escapeHtml(e.Title)} <span class="bot-ri-badge" style="background:${catCfg.bg};color:${catCfg.text}">${escapeHtml(cat)}</span></div>
            <div class="bot-ri-sub">${escapeHtml(e.Location || '')}</div>
            ${adminStr}
          </div>
          <span class="bot-ri-chevron">›</span>
        </div>`;
      }).join('')}</div>` + this._moreNote(items.length);
  },

  _formatExperiments(items) {
    if (items.length === 0) return '<div class="bot-empty">該当する実験ネタが見つかりませんでした。</div>';
    return `<div class="bot-result-count">${items.length}件</div>
      <div class="bot-result-list">${items.slice(0, BOT_MAX_LIST_ITEMS).map(x => {
        const catCfg = getExperimentCategory(x.Category);
        const cat = catCfg.label;
        const mat = x.Materials ? x.Materials.split('\n').slice(0, 3).join(', ') : '';
        const matStr = mat ? `<div class="bot-ri-sub">材料: ${escapeHtml(mat)}</div>` : '';
        return `<div class="bot-result-item exp-item bot-clickable" data-bot-open="exp" data-id="${escapeAttr(x.ID)}" role="button" tabindex="0" title="クリックで詳細を表示">
          <div class="bot-ri-main">${escapeHtml(x.Name)} <span class="bot-ri-badge" style="background:${catCfg.color};color:white">${escapeHtml(cat)}</span></div>
          ${matStr}
          <span class="bot-ri-chevron">›</span>
        </div>`;
      }).join('')}</div>` + this._moreNote(items.length);
  }
};

// ====== 詳細ポップアップ（実験ページ／イベントページと同じ内容を表示） ======

// --- 実験の詳細（experiments.js の viewExp と同じ構成） ---
function buildExpDetailBody(e) {
  const section = (title, content, isList) => {
    if (!content || !String(content).trim()) return '';
    const inner = isList
      ? `<ul>${String(content).split('\n').map(s => s.trim()).filter(Boolean).map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
      : `<div class="exp-text">${escapeHtml(content)}</div>`;
    return `<div class="exp-detail-section"><h3>${title}</h3>${inner}</div>`;
  };
  const cat = getExperimentCategory(e.Category);
  const hasReview = (e.Positives && e.Positives.trim()) || (e.Reflections && e.Reflections.trim());
  const safeSlides = safeHttpUrl(e.SlidesURL);
  return `
    <div style="margin-bottom:12px;">
      <span class="cat-badge" style="background:${cat.color};">${escapeHtml(cat.label)}</span>
      ${safeSlides ? ` &nbsp;<a class="tbl-link" href="${escapeAttr(safeSlides)}" target="_blank" rel="noopener">資料を開く</a>` : ''}
    </div>
    ${section('使用物品', e.Materials, true)}
    ${section('事前準備', e.Preparation, true)}
    ${section('発表の流れ', e.Flow, true)}
    ${section('注意事項', e.Notes, true)}
    ${hasReview ? '<hr class="divider">' : ''}
    ${section('良かった点', e.Positives, false)}
    ${section('反省点', e.Reflections, false)}
  `;
}

function openExpDetailFromBot(id) {
  const e = allData.experiments.find(x => x.ID === id);
  if (!e) return;
  document.getElementById('bot-exp-detail-title').textContent = e.Name || '(無題)';
  document.getElementById('bot-exp-detail-body').innerHTML = buildExpDetailBody(e);
  const link = document.getElementById('bot-exp-detail-link');
  if (link) link.href = 'experiments.html?focus=' + encodeURIComponent(e.Name || '');
  const modal = document.getElementById('bot-exp-detail-modal');
  modal.classList.remove('hidden');
  bindModalEscape(modal, closeBotExpDetail);
  if (!modal._trapBound) { trapFocus(modal.querySelector('.modal-content')); modal._trapBound = true; }
}

function closeBotExpDetail() {
  document.getElementById('bot-exp-detail-modal').classList.add('hidden');
}

// --- イベントの詳細（events ページの閲覧モーダルと同等の内容） ---
function buildEventDetailBody(e) {
  const cat = getEventCategory(e.Category);
  const isMeeting = !!cat.isMeeting;

  const row = (label, value) => (value && String(value).trim())
    ? `<div class="bot-detail-row"><span class="bot-detail-label">${label}</span><span class="bot-detail-value">${escapeHtml(value)}</span></div>`
    : '';
  const textSec = (title, content) => (content && String(content).trim())
    ? `<div class="exp-detail-section"><h3>${title}</h3><div class="exp-text">${escapeHtml(content)}</div></div>`
    : '';
  const sec = (title, inner) => inner ? `<div class="exp-detail-section"><h3>${title}</h3>${inner}</div>` : '';

  let dateStr = e.Date ? `${e.Date} (${dayOfWeekJP(e.Date)})` : '未定';
  if (e.DateEnd && e.DateEnd !== e.Date) dateStr += ` 〜 ${e.DateEnd} (${dayOfWeekJP(e.DateEnd)})`;
  const timeStr = (e.TimeStart && e.TimeEnd) ? `${e.TimeStart} - ${e.TimeEnd}` : (e.TimeStart || '');

  // 実験・担当者（新旧フォーマット両対応。新形式は部の概念が無いためフラットに表示）
  let partsHtml = '';
  const normParts = normalizeParts(e.PartsList).filter(it => it.name || it.presenters.length);
  if (normParts.length) {
    partsHtml += `<div style="margin-bottom:10px;">`;
    normParts.forEach(it => {
      const name = it.name
        ? `<a href="experiments.html?focus=${encodeURIComponent(it.name)}" class="exp-link-inline">${escapeHtml(it.name)}</a>`
        : '(未定)';
      const pres = it.presenters.length ? it.presenters.map(escapeHtml).join(', ') : '未定';
      partsHtml += `<span class="tag tag-exp">${name} <span class="tag-presenter">(${pres})</span></span>`;
    });
    partsHtml += `</div>`;
  }

  // 書類（担当・期限）
  const docRows = [
    row('許可願 担当', e.AdminKyoka),
    row('許可願 期限', e.KyokaDeadline),
    row('報告書 担当', e.AdminHoukoku),
    row('報告書 期限', e.HoukokuDeadline)
  ].join('');

  // ファイル
  const files = Array.isArray(e.Files) ? e.Files : [];
  let filesHtml = '';
  if (files.length) {
    filesHtml = files.map((f, i) => {
      const url = (f && f.url) || (typeof f === 'string' ? f : '');
      const name = escapeHtml((f && f.name) || ('ファイル ' + (i + 1)));
      return /^https?:\/\//i.test(url)
        ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" class="tbl-link" style="display:block;margin:2px 0;">${name}</a>`
        : `<span class="text-hint" style="display:block;margin:2px 0;">${name}（リンク切れ）</span>`;
    }).join('');
  }

  return `
    <div style="margin-bottom:12px;">
      <span class="cat-badge" style="background:${cat.bg};color:${cat.text};">${escapeHtml(cat.label)}</span>
    </div>
    <div class="bot-detail-rows">
      ${row('日程', dateStr)}
      ${timeStr ? row('時間', timeStr) : ''}
      ${isMeeting && e.MeetingNumber ? row('回数', '第' + e.MeetingNumber + '回') : ''}
      ${row('場所', e.Location)}
      ${isMeeting ? '' : row('対象', e.Audience)}
      ${isMeeting ? '' : row('企画担当者', e.PlanLeader)}
      ${isMeeting ? '' : row('荷物運搬方法', [e.TransportMethod, e.TransportDriver && '運転者: ' + e.TransportDriver, e.TransportPassengers && '同乗者: ' + e.TransportPassengers].filter(Boolean).join(' ／ '))}
    </div>
    ${partsHtml ? sec('実験・担当', partsHtml) : ''}
    ${docRows ? sec('書類', `<div class="bot-detail-rows">${docRows}</div>`) : ''}
    ${textSec(isMeeting ? '議題' : '備考', [e.Remarks, e.Belongings].filter(s => s && String(s).trim()).join('\n'))}
    ${filesHtml ? sec('ファイル', filesHtml) : ''}
    ${(e.Positives && e.Positives.trim()) || (e.Reflections && e.Reflections.trim()) ? '<hr class="divider">' : ''}
    ${textSec('良かった点', e.Positives)}
    ${textSec('反省点', e.Reflections)}
  `;
}

function openEventDetailFromBot(id) {
  const e = allData.events.find(x => x.ID === id);
  if (!e) return;
  const cat = getEventCategory(e.Category);
  let title = e.Title || '(無題)';
  if (cat.isMeeting && e.MeetingNumber) title = `第${e.MeetingNumber}回 ${title}`;
  document.getElementById('bot-event-detail-title').textContent = title;
  document.getElementById('bot-event-detail-body').innerHTML = buildEventDetailBody(e);
  // リンク先は一覧ではなくこのイベントの詳細ページへ（ラベル「詳細ページで開く」と一致させる）
  document.getElementById('bot-event-detail-link').href = 'events.html?event=' + encodeURIComponent(e.ID);
  const modal = document.getElementById('bot-event-detail-modal');
  modal.classList.remove('hidden');
  bindModalEscape(modal, closeBotEventDetail);
  if (!modal._trapBound) { trapFocus(modal.querySelector('.modal-content')); modal._trapBound = true; }
}

function closeBotEventDetail() {
  document.getElementById('bot-event-detail-modal').classList.add('hidden');
}

// クリック/キー操作された要素が結果アイテム（data-bot-open）なら詳細を開く。開いたら true。
function openFromResultItem(target) {
  const el = target.closest ? target.closest('[data-bot-open]') : null;
  if (!el) return false;
  if (el.dataset.botOpen === 'event') openEventDetailFromBot(el.dataset.id);
  else openExpDetailFromBot(el.dataset.id);
  return true;
}

// ====== キーワード検索（Gemini未設定時のフォールバック） ======
// 質問文をそのまま部分一致させても「6Cで書類を…」のような文はヒットしないので、
// 助詞・句読点で検索語に分け、語ごとにフィールドへの一致でスコアを付けて上位から並べる。
// 比較は searchNormalize（全角半角・大文字小文字・カタカナ/ひらがなを揃える）で行う。

// 助詞・依頼表現・句読点・空白で区切る（元の文字列に対して行うので、カタカナ語は助詞と誤って割れない）
const KEYWORD_SPLIT_RE = /[\s　、。，．,.？?！!「」『』（）()［］\[\]・：:；;]+|について|に関して|を教えて|教えて|ください|知りたい|探して|一覧|[のをはがにでともやへ]/;
// どのデータにも当てはまる汎用語（検索語としては絞り込みに役立たない）
const KEYWORD_STOPWORDS = new Set(['メンバー', 'イベント', '実験', 'ネタ', '検索', '誰', 'いつ', '何'].map(searchNormalize));

// tokens は比較用（正規化済み）、labels は表示用（入力どおりの表記）。
function keywordTokens(text) {
  const raw = String(text).replace(/[？?。、！!]/g, ' ').trim();
  const whole = searchNormalize(raw);
  const tokens = [], labels = [];
  raw.split(KEYWORD_SPLIT_RE).forEach(part => {
    const t = searchNormalize(part);
    if (!t || KEYWORD_STOPWORDS.has(t) || tokens.includes(t)) return;
    tokens.push(t);
    labels.push(part.trim());
  });
  if (!tokens.length && whole) { tokens.push(whole); labels.push(raw); }   // 汎用語だけの質問は、質問文そのままで探す
  return { whole, tokens, labels };
}

// fields: [{ text, weight }]。語が含まれるフィールドの最大重みを語ごとに加点し、質問文全体が含まれれば加点する。
function keywordScore(fields, tokens, whole) {
  const hay = fields.map(f => ({ t: searchNormalize(f.text), w: f.weight }));
  let score = 0, matched = 0;
  tokens.forEach(tok => {
    const hits = hay.filter(h => h.t.includes(tok));
    if (hits.length) { matched++; score += Math.max(...hits.map(h => h.w)); }
  });
  if (whole && hay.some(h => h.t.includes(whole))) score += 5;
  return { score, matched };
}

function keywordRank(items, fieldsOf, tokens, whole) {
  return items
    .map(it => Object.assign({ it }, keywordScore(fieldsOf(it), tokens, whole)))
    .filter(r => r.matched > 0)
    .sort((a, b) => b.score - a.score)
    .map(r => r.it);
}

function keywordSearch(text) {
  const { whole, tokens, labels } = keywordTokens(text);
  if (!tokens.length) return { html: '', response_text: '質問を入力してください。' };

  const memberHits = keywordRank(allData.members, m => [
    { text: m.Name, weight: 3 }, { text: m.Role, weight: 2 }, { text: m.StudentID, weight: 2 },
    { text: m.Note, weight: 1 }, { text: m.Affiliation, weight: 1 }
  ], tokens, whole);
  const eventHits = keywordRank(allData.events, e => [
    { text: e.Title, weight: 3 }, { text: e.Location, weight: 2 },
    { text: e.AdminKyoka, weight: 2 }, { text: e.AdminHoukoku, weight: 2 },
    { text: e.PlanLeader, weight: 2 }, { text: e.TransportDriver, weight: 1 }, { text: e.TransportPassengers, weight: 1 },
    { text: e.TransportMethod, weight: 1 },
    { text: queryEngine._getPresenters(e).join(' '), weight: 2 },
    { text: eventExperimentNames(e).join(' '), weight: 2 },
    { text: e.Remarks, weight: 1 }
  ], tokens, whole);
  const expHits = keywordRank(allData.experiments.filter(x => x.Active !== 'false'), x => [
    { text: x.Name, weight: 3 }, { text: x.Materials, weight: 1 }, { text: x.Notes, weight: 1 }
  ], tokens, whole);

  let html = '';
  let total = 0;
  if (memberHits.length) {
    html += '<div class="bot-note">メンバー:</div>' + queryEngine._formatMembers(memberHits);
    total += memberHits.length;
  }
  if (eventHits.length) {
    html += '<div class="bot-note" style="margin-top:8px;">イベント:</div>' + queryEngine._formatEvents(eventHits);
    total += eventHits.length;
  }
  if (expHits.length) {
    html += '<div class="bot-note" style="margin-top:8px;">実験ネタ:</div>' + queryEngine._formatExperiments(expHits);
    total += expHits.length;
  }

  const shown = labels.join(' / ');
  if (total === 0) html = '<div class="bot-empty">「' + escapeHtml(shown) + '」に一致するデータが見つかりませんでした。</div>';

  return { html, response_text: `「${shown}」でキーワード検索しました。(${total}件)` };
}

// ====== チャットUI ======

// source: 'ai'（Gemini AIで解析）/ 'keyword'（キーワード検索）/ null（案内・エラー等）
function addMessage(role, text, html, source) {
  chatHistory.push({ role, text, html, source: source || null, time: new Date() });
  renderMessages();
}

function sourceBadge(source) {
  if (source === 'ai') return '<span class="bot-source-badge src-ai">🤖 AI回答</span>';
  if (source === 'keyword') return '<span class="bot-source-badge src-keyword">🔍 キーワード検索</span>';
  return '';
}

function renderMessages() {
  const container = document.getElementById('bot-messages');
  container.innerHTML = chatHistory.map((msg, i) => {
    const timeStr = formatTimeHM(msg.time);
    if (msg.role === 'user') {
      return `<div class="bot-msg bot-msg-user">
        <div class="bot-msg-bubble user-bubble">${escapeHtml(msg.text).replace(/\n/g, '<br>')}</div>
        <div class="bot-msg-time">${timeStr}</div>
      </div>`;
    }
    return `<div class="bot-msg bot-msg-bot">
      <div class="bot-msg-avatar">SC</div>
      <div class="bot-msg-content">
        <div class="bot-msg-bubble bot-bubble">${msg.text ? escapeHtml(msg.text).replace(/\n/g, '<br>') : ''}${msg.html || ''}</div>
        <div class="bot-msg-meta">
          ${sourceBadge(msg.source)}
          <span class="bot-msg-time">${timeStr}</span>
          <button class="bot-copy-btn" data-idx="${i}" title="コピー" aria-label="回答をコピー">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3a1.5 1.5 0 011.5-1.5H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  }).join('');

  // クリック処理は init のイベント委譲（#bot-messages）で一括して行う

  container.scrollTop = container.scrollHeight;
}

function copyBotMessage(idx) {
  const msg = chatHistory[idx];
  if (!msg) return;
  let text = msg.text || '';
  if (msg.html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = msg.html;
    const htmlText = tmp.textContent || tmp.innerText || '';
    if (htmlText.trim()) text = text ? text + '\n' + htmlText : htmlText;
  }
  navigator.clipboard.writeText(text).then(() => {
    toast('コピーしました', 'success', 1500);
  }).catch(() => {
    toast('コピーに失敗しました', 'error');
  });
}

function showTyping() {
  hideTyping(); // 二重表示を防ぐ（同じ id の要素が複数できると hideTyping で消えなくなる）
  const container = document.getElementById('bot-messages');
  const el = document.createElement('div');
  el.id = 'bot-typing';
  el.className = 'bot-msg bot-msg-bot';
  el.innerHTML = `<div class="bot-msg-avatar">SC</div>
    <div class="bot-msg-content"><div class="bot-msg-bubble bot-bubble bot-typing-dots"><span></span><span></span><span></span></div></div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('bot-typing');
  if (el) el.remove();
}

function renderGauge() {
  const count = usageTracker.count();
  const limit = usageTracker.limit();
  const pct = Math.min(100, (count / limit) * 100);

  const countEl = document.getElementById('bot-gauge-count');
  const fillEl = document.getElementById('bot-gauge-fill');
  if (!countEl || !fillEl) return;

  countEl.textContent = `${count.toLocaleString()} / ${limit.toLocaleString()}`;
  fillEl.style.width = pct + '%';

  if (pct >= 90) fillEl.className = 'bot-gauge-fill gauge-danger';
  else if (pct >= 60) fillEl.className = 'bot-gauge-fill gauge-warn';
  else fillEl.className = 'bot-gauge-fill gauge-ok';
}

// ====== メッセージ送信 ======

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 送信ボタンの活性状態と処理中フラグを同期させる
function setProcessing(on) {
  isProcessing = on;
  const btn = document.getElementById('bot-send-btn');
  if (btn) btn.disabled = on;
}

async function handleSend() {
  if (isProcessing) return; // 応答待ち・自動再試行中の多重送信を防ぐ
  const input = document.getElementById('bot-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  addMessage('user', text);
  setProcessing(true);
  try {
    await processQuery(text, false);
  } finally {
    setProcessing(false);
  }
}

// 1つの質問を Gemini で処理する。isRetry=true は1分レート制限の自動再試行時。
async function processQuery(text, isRetry) {
  showTyping();
  try {
    const query = await gemini.parseIntent(text);

    // 要約・文章生成は、対象本文をサーバーへ送って文章を生成する別ルート。
    if (query.intent === 'summarize') {
      const out = await runSummarize(query.params || {});
      hideTyping();
      // out.intro は「見つかりませんでした」等の案内のみに使う。
      // 生成成功時（out.html あり）は見出しに同じ内容が入るため、response_text と二重に出さない。
      addMessage('bot', out.intro, out.html || '', 'ai');
      renderGauge();
      return;
    }

    const result = queryEngine.execute(query.intent, query.params || {});
    hideTyping();
    addMessage('bot', query.response_text || '', result.html || '', 'ai');
    renderGauge();
  } catch (e) {
    hideTyping();
    await handleBotError(e, text, isRetry);
  }
}

// ====== 要約・文章生成 ======
// 対象（実験/イベント）をローカルキャッシュから特定し、個人情報を除いた本文を
// サーバー(geminiGenerate)へ送って文章を生成する。
// 「商工祭り」のように毎年開催されるイベントは同名の行が年度分だけ存在するため、
// 名前が一致する行は1件目だけでなく全件集めて文脈に渡す（過去のある年度だけを見て
// 要約してしまう見当違いを防ぐ）。
async function runSummarize(params) {
  const target = params.target === 'event' ? 'event' : 'experiment';

  if (target === 'event') {
    const evs = findEventsForSummary(params);
    if (!evs.length) return { intro: '要約対象のイベントが見つかりませんでした。イベント名を含めてお試しください。' };
    const title = (evs.find(e => e.Title) || {}).Title || '(無題)';
    const context = buildCombinedContext(evs, buildEventContext, true);
    const note = buildFetchNote(evs, title, false);
    return await generateSummary(params, context, `「${title}」の要約`, note, evs.length);
  }

  const exps = findExperimentsForSummary(params);
  if (!exps.length) return { intro: '要約対象の実験が見つかりませんでした。実験名を含めてお試しください。' };
  const title = (exps.find(e => e.Name) || {}).Name || '(無題)';
  const context = buildCombinedContext(exps, buildExperimentContext, false);
  const note = buildFetchNote(exps, title, true);
  return await generateSummary(params, context, `「${title}」の要約`, note, exps.length);
}

// 複数件を「---」区切りで結合。イベントは年度ラベルを付け、AIが別々の開催として扱えるようにする。
function buildCombinedContext(items, buildFn, withFiscalYear) {
  if (items.length === 1) return buildFn(items[0]);
  return items.map(item => {
    const label = withFiscalYear ? fiscalYearLabel(item.Date) : '';
    return (label ? `【${label}】\n` : '') + buildFn(item);
  }).join('\n\n---\n\n');
}

function fiscalYearLabel(dateStr) {
  const fy = getFiscalYear(dateStr);
  return fy !== null ? `${fy}年度` : '';
}

// 「何年度から何年度の・何件を取得したか」をユーザーに明示するための一文。
function buildFetchNote(items, title, isExperiment) {
  const count = items.length;
  if (isExperiment) {
    return count > 1 ? `「${title}」に関する実験ネタを${count}件取得しました。` : '';
  }
  const fys = items.map(e => getFiscalYear(e.Date)).filter(y => y !== null);
  if (!fys.length) return `「${title}」を${count}件取得しました。`;
  const minFy = Math.min(...fys), maxFy = Math.max(...fys);
  const range = minFy === maxFy ? `${minFy}年度` : `${minFy}年度から${maxFy}年度`;
  return `${range}の「${title}」を${count}件取得しました。`;
}

async function generateSummary(params, context, heading, note, itemCount) {
  // チャット欄に収まる分量にするため、常に「Markdown記法を使わない・簡潔に」を指示する。
  // 複数年度分を渡す場合は、共通点・変化点に触れつつ全体の文字数を抑えるよう追加で指示する
  // （指示なしだと見出し付きの長い構造化回答になりがちなため）。
  const styleNote = '\n\n（出力は「##」「**」「-」などのMarkdown記法を使わず、自然な文章のみで簡潔に。）';
  const multiNote = itemCount > 1
    ? '\n\n（複数年度・複数件分の資料です。共通点と年度ごとの変化点に触れつつ、全体で250字程度に収めてください。）'
    : '';
  const instruction = (params.instruction || '次の内容を分かりやすく要約してください。') + multiNote + styleNote;
  // Gemini呼び出しのエラー（レート制限・キー未設定など）はここで握りつぶさず、
  // 呼び出し元(processQuery)の catch → handleBotError に渡して適切な案内・再試行をさせる。
  const res = await api.geminiGenerate(instruction, context);
  if (res.usage !== undefined) usageTracker.setFromServer(res.usage, res.limit);
  const noteHtml = note ? `<div class="bot-note">${escapeHtml(note)}</div>` : '';
  const html = `<div class="bot-generated">${noteHtml}<div class="bot-generated-head">${escapeHtml(heading)}</div>${formatGeneratedText(res.text)}</div>`;
  return { intro: '', html };
}

// 実験名にマッチする全件を返す（正規化・カタカナ折りたたみ込みの searchNormalize を使用）。
function findExperimentsForSummary(p) {
  const items = (allData.experiments || []).filter(x => x.Active !== 'false');
  const probe = searchNormalize(p.name || p.keyword || '');
  if (!probe) return [];
  const byName = items.filter(x => searchNormalize(x.Name || '').includes(probe));
  if (byName.length) return byName;
  return items.filter(x => searchNormalize(x.Materials || '').includes(probe));
}

// イベント名にマッチする全件を返す（毎年開催される同名イベントも年度をまたいで全て集める）。
function findEventsForSummary(p) {
  let items = (allData.events || []).slice();
  if (p.date_from) items = items.filter(e => (e.Date || '') >= p.date_from);
  if (p.date_to) items = items.filter(e => (e.Date || '') <= p.date_to);
  const probe = searchNormalize(p.name || p.keyword || '');
  if (probe) {
    const hits = items.filter(e => searchNormalize(e.Title || '').includes(probe));
    return hits.sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
  }
  // 名前指定が無く日付範囲のみなら、最新の1件を対象にする
  if (items.length) {
    return [items.sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))[0]];
  }
  return [];
}

// 実験の本文（個人情報なし）。振り返りはテキストのみ抽出して送る。
function buildExperimentContext(exp) {
  const lines = [];
  lines.push('実験名: ' + (exp.Name || ''));
  lines.push('種類: ' + getExperimentCategory(exp.Category).label);
  if (exp.Materials)    lines.push('使用物品:\n' + exp.Materials);
  if (exp.Preparation)  lines.push('事前準備:\n' + exp.Preparation);
  if (exp.Flow)         lines.push('発表の流れ:\n' + exp.Flow);
  if (exp.Notes)        lines.push('注意事項:\n' + exp.Notes);
  const pos = parseFeedbackEntries(exp.Positives).map(f => '・' + (f.text || '')).filter(s => s.length > 1).join('\n');
  const ref = parseFeedbackEntries(exp.Reflections).map(f => '・' + (f.text || '')).filter(s => s.length > 1).join('\n');
  if (pos) lines.push('振り返り（良かった点）:\n' + pos);
  if (ref) lines.push('振り返り（改善点）:\n' + ref);
  return lines.join('\n\n');
}

// イベントの本文（担当者など個人名は含めない）。
function buildEventContext(ev) {
  const lines = [];
  lines.push('イベント名: ' + (ev.Title || ''));
  if (ev.Date) lines.push('日程: ' + ev.Date + (ev.DateEnd && ev.DateEnd !== ev.Date ? ' 〜 ' + ev.DateEnd : ''));
  if (ev.Location) lines.push('場所: ' + ev.Location);
  if (ev.Audience && !isMeetingCategory(ev.Category)) lines.push('対象: ' + ev.Audience);
  const expNames = eventExperimentNames(ev);
  if (expNames.length) lines.push('実施した実験: ' + expNames.join(', '));
  if (ev.Remarks)   lines.push('備考:\n' + ev.Remarks);
  if ((ev.Positives || '').trim())   lines.push('振り返り（良かった点）:\n' + ev.Positives);
  if ((ev.Reflections || '').trim()) lines.push('振り返り（改善点）:\n' + ev.Reflections);
  return lines.join('\n\n');
}

// PartsList から実験名だけ抽出（担当者名は除外。新旧フォーマット両対応）
function eventExperimentNames(ev) {
  return normalizeParts(ev.PartsList).map(it => it.name).filter(Boolean);
}

// 生成テキストを安全にHTML化（XSS対策のうえ改行を反映）
// 指示にもかかわらずGeminiがMarkdown記法で返してきた場合の保険。
// 見出し記号・太字記号を除去し、行頭の箇条書き記号は「・」に統一する。
function stripMarkdown(text) {
  return String(text || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^[*\-]\s+/gm, '・')
    .replace(/\n{3,}/g, '\n\n');
}

function formatGeneratedText(text) {
  return '<div class="exp-text">' + escapeHtml(stripMarkdown(text)).replace(/\n/g, '<br>') + '</div>';
}

function fallbackToKeyword(text) {
  const result = keywordSearch(text);
  addMessage('bot', result.response_text, result.html, 'keyword');
}

// エラーコード → 案内。msg: 表示文 / detail: 詳細（e.detail）を付ける / fallback: キーワード検索に切り替える /
// retry: 一度だけ自動再試行する（待ち秒数は e.retrySec を min〜max に丸める）。retry.msg は再試行前の案内、msg は再試行しても直らなかったとき。
const BOT_ERRORS = {
  gemini_key_not_configured: { fallback: true,
    msg: 'Gemini APIキーがサーバー側で未設定です。管理者設定（⚙→管理）で設定してください。\nキーワード検索にフォールバックします。' },
  API_KEY_INVALID: { fallback: true,
    msg: 'APIキーが無効です。⚙→管理 から正しいキーを設定してください。\nキーワード検索に切り替えます。' },
  // キーは有効だが、API未有効化・地域制限・請求設定などでプロジェクト側が使えない状態
  API_FORBIDDEN: { fallback: true, detail: true,
    msg: 'APIキーは認識されましたが、このキーのプロジェクトで Gemini API を利用できない状態です。\n' +
      'Google AI Studio / Cloud Console で「Generative Language API」が有効か、地域・請求設定に問題がないか確認してください。' },
  MODEL_NOT_FOUND: { fallback: true, detail: true,
    msg: '指定中のモデルが利用できません（廃止またはキー未対応）。⚙→管理 の「使用モデル」を別のものに切り替えてください。' },
  // モデルの一時的な過負荷（503/500）。少し待てば回復するので一度だけ自動再試行。
  MODEL_OVERLOADED: { fallback: true, detail: true,
    retry: { def: 15, min: 5, max: 30, msg: s => `AIモデルが一時的に混雑しています。${s}秒後に自動で再試行します…` },
    msg: 'AIモデルの混雑が解消しませんでした（しばらくすると回復します）。\nキーワード検索に切り替えます。' },
  // サーバーが HTML を返した（API_URL の誤り／サーバー障害など）。キャッシュでキーワード検索は可能。
  HTML_RESPONSE: { fallback: true,
    msg: 'サーバーに接続できません。管理者は config.js の API_URL とサーバー（Cloudflare Workers）の状態を確認してください。\nキャッシュ済みデータでキーワード検索に切り替えます。' },
  NETWORK_UNREACHABLE: { fallback: true,
    msg: 'ネットワークに接続できません。通信環境を確認してください。\nキャッシュ済みデータでキーワード検索に切り替えます。' },
  // 1日あたりの上限（再試行しても当日は回復しない）。サーバー側の上限は日本時間0時にリセットされる。
  RATE_LIMIT_DAILY: { fallback: true, detail: true,
    msg: '本日の利用上限に達しました。サーバー側の上限は日本時間の0時にリセットされます（Google側の無料枠が原因の場合は日本時間17時ごろ）。\nそれまではキーワード検索をご利用ください。' },
  // 1分あたりの上限。少し待てば回復するので、一度だけ自動再試行する
  RATE_LIMIT_MINUTE: { fallback: true, detail: true,
    retry: { def: 20, min: 5, max: 40, msg: s => `アクセスが集中しています（無料枠は「1分あたりの回数」に上限があります）。${s}秒後に自動で再試行します…` },
    msg: '時間をおいても混雑が解消しませんでした。少し待ってから再度お試しください。\nキーワード検索に切り替えます。' },
  NETWORK_ERROR: { fallback: true,
    msg: '通信エラーが発生しました。ネットワーク接続を確認してください。\nキーワード検索に切り替えます。' },
  BLOCKED: { fallback: false,
    msg: '安全フィルタにより応答がブロックされました。質問の表現を変えてお試しください。' },
  PARSE_ERROR: { fallback: true,
    msg: 'AIの応答を解釈できませんでした。もう一度お試しください。\nキーワード検索に切り替えます。' }
};
BOT_ERRORS.EMPTY_RESPONSE = BOT_ERRORS.PARSE_ERROR;

async function handleBotError(e, text, isRetry) {
  // 認証切れは api.js がログイン画面を出してリロードする（e.handled）。ここで二重にエラーを出さない。
  if (e && (e.handled || e.code === 'unauthorized')) return;

  const errMsg = e.message || String(e);
  const detailNote = e.detail ? '\n\n（詳細: ' + e.detail + '）' : '';
  // 未知のコードの本文は renderMessages 側で escapeHtml されるため、ここでエスケープしない（二重になる）
  const entry = BOT_ERRORS[errMsg] || { fallback: true, detail: true, msg: 'エラーが発生しました: ' + errMsg };

  if (entry.retry && !isRetry) {
    const r = entry.retry;
    const wsec = Math.min(Math.max(parseInt(e.retrySec, 10) || r.def, r.min), r.max);
    addMessage('bot', r.msg(wsec));
    await sleep(wsec * 1000);
    await processQuery(text, true);
    return;
  }
  addMessage('bot', entry.msg + (entry.detail ? detailNote : ''));
  if (entry.fallback) fallbackToKeyword(text);
}

// ====== 起動 ======

document.addEventListener('DOMContentLoaded', () => {
  // 停止中(config.js の FEATURES.BOT)。URL 直打ちはホームへ戻す。実際の遮断はサーバー側の GEMINI_ENABLED。
  if (!(CONFIG.FEATURES && CONFIG.FEATURES.BOT)) {
    location.replace('index.html');
    return;
  }
  bootPage('bot', init);
});

async function init() {
  // イベントリスナー
  document.getElementById('bot-send-btn').addEventListener('click', handleSend);

  const botInput = document.getElementById('bot-input');
  botInput.addEventListener('keydown', e => {
    // keyCode 229 は IME 変換確定の Enter（Safari 等は isComposing が false になるため併用）
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      if (e.shiftKey || e.altKey) {
        return; // Shift+Enter / Alt(Option)+Enter → 改行（デフォルト動作）
      }
      e.preventDefault();
      handleSend();
    }
  });
  botInput.addEventListener('input', () => {
    botInput.style.height = 'auto';
    botInput.style.height = Math.min(botInput.scrollHeight, 120) + 'px';
  });

  // 結果リスト・コピー・例チップのクリックを一括処理する。
  // （インライン onclick を使わないことで、ID・文字列由来のスクリプト混入を構造的に防ぐ）
  const messagesEl = document.getElementById('bot-messages');
  messagesEl.addEventListener('click', e => {
    const chip = e.target.closest('[data-bot-example]');
    if (chip) {
      if (isProcessing) return;
      botInput.value = chip.dataset.botExample;
      handleSend();
      return;
    }
    const copyBtn = e.target.closest('.bot-copy-btn');
    if (copyBtn) {
      copyBotMessage(parseInt(copyBtn.dataset.idx, 10));
      return;
    }
    openFromResultItem(e.target);
  });
  // 結果アイテムはキーボードでも開けるようにする（tabindex 付与済み）
  messagesEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (openFromResultItem(e.target)) e.preventDefault();
  });

  // ヘルプボタン
  document.getElementById('bot-help-btn').addEventListener('click', () => {
    const modal = document.getElementById('bot-help-modal');
    modal.classList.remove('hidden');
    bindModalEscape(modal, () => modal.classList.add('hidden'));
    // Tab がモーダル外へ抜けないよう閉じ込める（静的モーダルなので一度だけ束縛）
    if (!modal._trapBound) { trapFocus(modal.querySelector('.modal-content')); modal._trapBound = true; }
  });
  bindOverlayClose(document.getElementById('bot-help-modal'), () => document.getElementById('bot-help-modal').classList.add('hidden'));

  bindOverlayClose(document.getElementById('bot-exp-detail-modal'), closeBotExpDetail);
  bindOverlayClose(document.getElementById('bot-event-detail-modal'), closeBotEventDetail);

  // ゲージ初期描画
  renderGauge();

  // サーバーの実使用量・上限を取得してゲージを正確に表示する（サイト全体・本日分。
  // localStorage は各ブラウザ個別のキャッシュに過ぎず、このブラウザでまだ一度も送信していない場合
  // 他ユーザーの使用で上限に達していても 0 のまま表示されてしまうため、毎回サーバーから取得する）
  api.geminiUsage().then(function(res) {
    if (res && res.success) usageTracker.setFromServer(res.usage, res.limit);
  }).catch(function() {});  // 取得失敗は無視（ローカルの値で継続）

  // キャッシュからデータ読み込み
  RESOURCE_NAMES.forEach(r => {
    const cached = api.loadCache(r);
    if (cached && cached.items) allData[r] = cached.items;
  });

  const hasCache = allData.events.length + allData.members.length + allData.experiments.length > 0;
  updateSyncStatus(hasCache ? 'cached' : 'initial-loading', hasCache ? Date.now() : null);

  // ウェルカムメッセージ（例はタップでそのまま送信できるチップにする）
  const examples = [
    '来月のイベントは？',
    '6Cで書類を書いていないメンバーは？',
    '工作の実験ネタを教えて',
    '田中さんの参加イベント',
    'スライムの実験の振り返りを要約して'
  ];
  const chipsHtml = '<div class="bot-chips">'
    + examples.map(q => `<button type="button" class="bot-chip" data-bot-example="${escapeAttr(q)}">${escapeHtml(q)}</button>`).join('')
    + '</div>';
  addMessage('bot', 'こんにちは！SciComi Bot です。\nイベント・メンバー・実験に関する質問や、振り返りの要約ができます。\n\n例（タップでそのまま質問できます）:', chipsHtml);

  // デスクトップでは入力欄へ自動フォーカス（モバイルはキーボードが開いてしまうため除外）
  if (!window.matchMedia('(pointer: coarse)').matches) botInput.focus();

  // APIキー未設定時のメッセージはサーバー応答で判定するため、ここでは出さない

  // バックグラウンドでデータ更新
  await refreshData();
}

// 同期ステータスのクリック（ヘッダー）からも呼ばれる。最新データを取得して allData を更新する。
async function refreshData(isManual = false) {
  updateSyncStatus(isManual ? 'syncing' : 'syncing-bg');
  try {
    const fresh = await api.listAll();
    RESOURCE_NAMES.forEach(r => {
      allData[r] = fresh[r] || [];
      api.saveCache(r, allData[r]);
    });
    updateSyncStatus('fresh', Date.now());
  } catch (e) {
    if (e.handled) return;
    updateSyncStatus('error', null, e.message);
    // キャッシュも無い＝検索対象データが空のままだと、何を聞いても「0件」になってしまう。
    // ヘッダーの同期ドットだけでは気づけないため、チャット内でも知らせる。
    const hasData = allData.events.length + allData.members.length + allData.experiments.length > 0;
    if (!hasData) {
      addMessage('bot', 'イベント・メンバー・実験データを読み込めませんでした。\n'
        + humanizeApiError(e)
        + '\nこのままでは検索結果が常に0件になります。通信環境を確認して、ページを再読み込みしてください。');
    }
  }
}
