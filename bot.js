/**
 * SciComi Portal - Bot（意図解析分離型）
 *
 * 構成:
 *   1. Gemini API で質問の「意図」だけを解析（個人情報は送信しない）
 *   2. ローカルのキャッシュ済みデータに対してクエリ実行
 *   3. 結果をチャットUIに表示
 */

let allData = { events: [], members: [], experiments: [] };
let chatHistory = [];

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
    localStorage.setItem(this._key(), JSON.stringify(d));
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
      case 'general':          return { html: '' };
      case 'unknown':          return { html: '' };
      default:                 return { html: '' };
    }
  },

  // --- メンバー検索 ---
  findMembers(p) {
    let items = allData.members;
    if (p.active_only !== false) items = items.filter(m => m.Active !== 'false');
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
    if (p.fiscal_year) items = items.filter(m => String(m.FiscalYear) === String(p.fiscal_year));
    return { html: this._formatMembers(items), count: items.length };
  },

  // --- イベント検索 ---
  findEvents(p) {
    let items = allData.events;
    if (p.event_category) items = items.filter(e => e.Category === p.event_category);
    if (p.date_from) items = items.filter(e => (e.Date || '') >= p.date_from);
    if (p.date_to) items = items.filter(e => (e.Date || '') <= p.date_to);
    if (p.keyword) {
      const kw = p.keyword.toLowerCase();
      items = items.filter(e =>
        (e.Title || '').toLowerCase().includes(kw) ||
        (e.Location || '').toLowerCase().includes(kw) ||
        (e.Remarks || '').toLowerCase().includes(kw)
      );
    }
    if (p.name) {
      items = items.filter(e =>
        (e.AdminKyoka || '').includes(p.name) ||
        (e.AdminHoukoku || '').includes(p.name) ||
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
    let members = allData.members.filter(m => m.Active !== 'false' && m.Category === 'member');
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
      return inAdmin || inParts;
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
      if (p.active_only !== false) items = items.filter(m => m.Active !== 'false');
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

  // --- PartsList から担当者名を抽出 ---
  _getPresenters(event) {
    let parts = event.PartsList;
    if (!parts) return [];
    if (typeof parts === 'string') {
      try { parts = JSON.parse(parts); } catch { return []; }
    }
    if (!Array.isArray(parts)) return [];
    const names = [];
    parts.forEach(part => {
      (part.items || []).forEach(item => {
        if (item.presenter) names.push(item.presenter.trim());
      });
    });
    return names;
  },

  // --- 結果フォーマット ---
  _formatMembers(items) {
    if (items.length === 0) return '<div class="bot-empty">該当するメンバーが見つかりませんでした。</div>';
    const catLabels = { adviser: 'アドバイザー', coordinator: 'コーディネーター', member: 'メンバー' };
    return `<div class="bot-result-count">${items.length}人</div>
      <div class="bot-result-list">${items.map(m => {
        const grade = (m.StudentID || '').slice(0, 2);
        const cat = catLabels[m.Category] || m.Category;
        const role = m.Role ? ` / ${escapeHtml(m.Role)}` : '';
        const badge = m.Active === 'false' ? ' <span class="grad-badge">卒業</span>' : '';
        return `<div class="bot-result-item member-item">
          <div class="bot-ri-main">${escapeHtml(m.Name)}${badge}</div>
          <div class="bot-ri-sub">${escapeHtml(grade)} ${escapeHtml(cat)}${role}</div>
        </div>`;
      }).join('')}</div>`;
  },

  _formatEvents(items) {
    if (items.length === 0) return '<div class="bot-empty">該当するイベントが見つかりませんでした。</div>';
    const catLabels = { normal: 'イベント', other: 'その他', general: '全体MTG', admin: '幹部MTG' };
    return `<div class="bot-result-count">${items.length}件</div>
      <div class="bot-result-list">${items.map(e => {
        const d = e.Date ? shortDate(e.Date) : '未定';
        const dow = e.Date ? `(${dayOfWeekJP(e.Date)})` : '';
        const cat = catLabels[e.Category] || e.Category;
        const catCfg = getEventCategory(e.Category);
        const loc = e.Location ? ` | ${escapeHtml(e.Location)}` : '';
        const admin = [];
        if (e.AdminKyoka) admin.push(`許可願: ${escapeHtml(e.AdminKyoka)}`);
        if (e.AdminHoukoku) admin.push(`報告書: ${escapeHtml(e.AdminHoukoku)}`);
        const adminStr = admin.length ? `<div class="bot-ri-detail">${admin.join(' | ')}</div>` : '';
        return `<div class="bot-result-item event-item bot-clickable" onclick="openEventDetailFromBot('${escapeAttr(e.ID)}')" title="クリックで詳細を表示">
          <div class="bot-ri-date">${d}${dow}</div>
          <div class="bot-ri-body">
            <div class="bot-ri-main">${escapeHtml(e.Title)} <span class="bot-ri-badge" style="background:${catCfg.bg};color:${catCfg.text}">${escapeHtml(cat)}</span></div>
            <div class="bot-ri-sub">${escapeHtml(e.Location || '')}</div>
            ${adminStr}
          </div>
          <span class="bot-ri-chevron">›</span>
        </div>`;
      }).join('')}</div>`;
  },

  _formatExperiments(items) {
    if (items.length === 0) return '<div class="bot-empty">該当する実験ネタが見つかりませんでした。</div>';
    const catLabels = { workshop: '工作', show: '実験ショー', other: 'その他' };
    return `<div class="bot-result-count">${items.length}件</div>
      <div class="bot-result-list">${items.map(x => {
        const cat = catLabels[x.Category] || x.Category;
        const catCfg = getExperimentCategory(x.Category);
        const mat = x.Materials ? x.Materials.split('\n').slice(0, 3).join(', ') : '';
        const matStr = mat ? `<div class="bot-ri-sub">材料: ${escapeHtml(mat)}</div>` : '';
        return `<div class="bot-result-item exp-item bot-clickable" onclick="openExpDetailFromBot('${escapeAttr(x.ID)}')" title="クリックで詳細を表示">
          <div class="bot-ri-main">${escapeHtml(x.Name)} <span class="bot-ri-badge" style="background:${catCfg.color};color:white">${escapeHtml(cat)}</span></div>
          ${matStr}
          <span class="bot-ri-chevron">›</span>
        </div>`;
      }).join('')}</div>`;
  }
};

// ====== 詳細ポップアップ（実験ページ／イベントページと同じ内容を表示） ======

// --- 実験の詳細（experiments.js の viewExp と同じ構成） ---
function buildExpDetailBody(e) {
  const section = (title, content, isList) => {
    if (!content || !String(content).trim()) return '';
    const lines = String(content).split('\n').map(s => s.trim()).filter(Boolean);
    const inner = isList
      ? `<ul>${lines.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
      : `<div class="exp-text">${escapeHtml(content)}</div>`;
    return `<div class="exp-detail-section"><h3>${title}</h3>${inner}</div>`;
  };
  const cat = getExperimentCategory(e.Category);
  const hasReview = (e.Positives && e.Positives.trim()) || (e.Reflections && e.Reflections.trim());
  return `
    <div style="margin-bottom:12px;">
      <span class="cat-badge" style="background:${cat.color};">${escapeHtml(cat.label)}</span>
      ${e.SlidesURL ? ` &nbsp;<a class="tbl-link" href="${escapeAttr(e.SlidesURL)}" target="_blank" rel="noopener">資料を開く</a>` : ''}
    </div>
    ${section('使用物品', e.Materials, true)}
    ${section('事前準備', e.Preparation, true)}
    ${section('発表の流れ', e.Flow, true)}
    ${section('注意事項', e.Notes, true)}
    ${hasReview ? '<hr style="border:0;border-top:1px solid #eee;margin:20px 0;">' : ''}
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
  document.getElementById('bot-exp-detail-modal').classList.remove('hidden');
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

  // 部ごとの実験・担当者
  let parts = e.PartsList;
  if (typeof parts === 'string') { try { parts = JSON.parse(parts); } catch (_) { parts = []; } }
  let partsHtml = '';
  if (Array.isArray(parts)) {
    parts.forEach(p => {
      const items = (p.items || []).filter(it => it.name || it.presenter);
      if (items.length === 0) return;
      partsHtml += `<div class="part-title">【${escapeHtml(p.partName || '部なし')}】</div><div style="margin-bottom:10px;">`;
      items.forEach(it => {
        const name = it.name
          ? `<a href="experiments.html?focus=${encodeURIComponent(it.name)}" class="exp-link-inline">${escapeHtml(it.name)}</a>`
          : '(未定)';
        partsHtml += `<span class="tag tag-exp">${name} <span class="tag-presenter">(${escapeHtml(it.presenter || '未定')})</span></span>`;
      });
      partsHtml += `</div>`;
    });
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
        : `<span style="display:block;margin:2px 0;color:#999;">${name}（リンク切れ）</span>`;
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
      ${row('対象', e.Audience)}
    </div>
    ${partsHtml ? sec('実験・担当', partsHtml) : ''}
    ${docRows ? sec('書類', `<div class="bot-detail-rows">${docRows}</div>`) : ''}
    ${textSec(isMeeting ? '議題 / 備考' : '備考', e.Remarks)}
    ${textSec('持ち物', e.Belongings)}
    ${textSec('当日運営・ロジ', e.Logistics)}
    ${filesHtml ? sec('ファイル', filesHtml) : ''}
    ${(e.Positives && e.Positives.trim()) || (e.Reflections && e.Reflections.trim()) ? '<hr style="border:0;border-top:1px solid #eee;margin:20px 0;">' : ''}
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
  document.getElementById('bot-event-detail-modal').classList.remove('hidden');
}

function closeBotEventDetail() {
  document.getElementById('bot-event-detail-modal').classList.add('hidden');
}

// ====== キーワード検索（Gemini未設定時のフォールバック） ======

function keywordSearch(text) {
  const kw = text.toLowerCase().replace(/[？?。、！!]/g, '').trim();
  if (!kw) return { html: '', response_text: '質問を入力してください。' };

  const memberHits = allData.members.filter(m => m.Active !== 'false' &&
    [m.Name, m.Role, m.StudentID, m.Note, m.Affiliation].some(v => (v || '').toLowerCase().includes(kw))
  );
  const eventHits = allData.events.filter(e =>
    [e.Title, e.Location, e.Remarks, e.AdminKyoka, e.AdminHoukoku].some(v => (v || '').toLowerCase().includes(kw))
  );
  const expHits = allData.experiments.filter(x => x.Active !== 'false' &&
    [x.Name, x.Materials, x.Notes].some(v => (v || '').toLowerCase().includes(kw))
  );

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

  if (total === 0) html = '<div class="bot-empty">「' + escapeHtml(kw) + '」に一致するデータが見つかりませんでした。</div>';

  return { html, response_text: `「${kw}」でキーワード検索しました。(${total}件)` };
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
    const timeStr = msg.time.getHours().toString().padStart(2, '0') + ':' + msg.time.getMinutes().toString().padStart(2, '0');
    if (msg.role === 'user') {
      return `<div class="bot-msg bot-msg-user">
        <div class="bot-msg-bubble user-bubble">${escapeHtml(msg.text)}</div>
        <div class="bot-msg-time">${timeStr}</div>
      </div>`;
    }
    return `<div class="bot-msg bot-msg-bot">
      <div class="bot-msg-avatar">SC</div>
      <div class="bot-msg-content">
        <div class="bot-msg-bubble bot-bubble">${msg.text ? escapeHtml(msg.text).replace(/\n/g, '<br>') : ''}${msg.html || ''}</div>
        <div class="bot-msg-meta">${sourceBadge(msg.source)}<span class="bot-msg-time">${timeStr}</span></div>
      </div>
    </div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function showTyping() {
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

async function handleSend() {
  const input = document.getElementById('bot-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  addMessage('user', text);
  await processQuery(text, false);
}

// 1つの質問を Gemini で処理する。isRetry=true は1分レート制限の自動再試行時。
async function processQuery(text, isRetry) {
  showTyping();
  try {
    const query = await gemini.parseIntent(text);
    const result = queryEngine.execute(query.intent, query.params || {});
    hideTyping();
    addMessage('bot', query.response_text || '', result.html || '', 'ai');
    renderGauge();
  } catch (e) {
    hideTyping();
    await handleBotError(e, text, isRetry);
  }
}

function fallbackToKeyword(text) {
  const result = keywordSearch(text);
  addMessage('bot', result.response_text, result.html, 'keyword');
}

async function handleBotError(e, text, isRetry) {
  const errMsg = e.message || String(e);
  const detailNote = e.detail ? '\n\n（詳細: ' + e.detail + '）' : '';

  switch (errMsg) {
    case 'gemini_key_not_configured':
      addMessage('bot', 'Gemini APIキーがサーバー側で未設定です。管理者設定（⚙→管理）で設定してください。\nキーワード検索にフォールバックします。');
      fallbackToKeyword(text);
      break;

    case 'API_KEY_INVALID':
      addMessage('bot', 'APIキーが無効です。⚙→管理 から正しいキーを設定してください。');
      break;

    // キーは有効だが、API未有効化・地域制限・請求設定などでプロジェクト側が使えない状態
    case 'API_FORBIDDEN':
      addMessage('bot', 'APIキーは認識されましたが、このキーのプロジェクトで Gemini API を利用できない状態です。\n' +
        'Google AI Studio / Cloud Console で「Generative Language API」が有効か、地域・請求設定に問題がないか確認してください。' + detailNote);
      fallbackToKeyword(text);
      break;

    case 'MODEL_NOT_FOUND':
      addMessage('bot', '指定中のモデルが利用できません（廃止またはキー未対応）。⚙→管理 の「使用モデル」を別のものに切り替えてください。' + detailNote);
      fallbackToKeyword(text);
      break;

    // 1日あたりの無料枠を使い切った（再試行しても当日は回復しない）
    case 'RATE_LIMIT_DAILY':
    case 'DAILY_LIMIT': // 後方互換
      addMessage('bot', '本日の無料枠（1日あたりの上限）を使い切りました。日本時間17時ごろ（太平洋時間0時）にリセットされます。\nそれまではキーワード検索をご利用ください。' + detailNote);
      fallbackToKeyword(text);
      break;

    // 1分あたりの上限。少し待てば回復するので、一度だけ自動再試行する
    case 'RATE_LIMIT_MINUTE':
    case 'RATE_LIMIT': // 後方互換
      if (!isRetry) {
        const sec = Math.min(Math.max(parseInt(e.retrySec, 10) || 20, 5), 40);
        addMessage('bot', `アクセスが集中しています（無料枠は「1分あたりの回数」に上限があります）。${sec}秒後に自動で再試行します…`);
        await sleep(sec * 1000);
        await processQuery(text, true);
        return;
      }
      addMessage('bot', '時間をおいても混雑が解消しませんでした。少し待ってから再度お試しください。\nキーワード検索に切り替えます。' + detailNote);
      fallbackToKeyword(text);
      break;

    case 'NETWORK_ERROR':
      addMessage('bot', '通信エラーが発生しました。ネットワーク接続を確認してください。\nキーワード検索に切り替えます。');
      fallbackToKeyword(text);
      break;

    case 'BLOCKED':
      addMessage('bot', '安全フィルタにより応答がブロックされました。質問の表現を変えてお試しください。');
      break;

    case 'PARSE_ERROR':
    case 'EMPTY_RESPONSE':
      addMessage('bot', 'AIの応答を解釈できませんでした。もう一度お試しください。\nキーワード検索に切り替えます。');
      fallbackToKeyword(text);
      break;

    default:
      addMessage('bot', 'エラーが発生しました: ' + escapeHtml(errMsg) + detailNote);
      fallbackToKeyword(text);
  }
}

// ====== 設定（管理者専用 → 管理者設定モーダルへ誘導） ======

function openSettings() {
  if (api.isAdmin()) {
    showAdminSettingsModal();
  } else {
    showAdminAuthModal(() => showAdminSettingsModal());
  }
}

// ====== 起動 ======

document.addEventListener('DOMContentLoaded', () => {
  bootPage('bot', init);
});

async function init() {
  // イベントリスナー
  document.getElementById('bot-send-btn').addEventListener('click', handleSend);
  document.getElementById('bot-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) handleSend();
  });
  document.getElementById('bot-settings-btn').addEventListener('click', openSettings);

  // 詳細モーダル: オーバーレイ外側クリック / Esc で閉じる
  ['bot-exp-detail-modal', 'bot-event-detail-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', ev => { if (ev.target === el) el.classList.add('hidden'); });
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { closeBotExpDetail(); closeBotEventDetail(); }
  });

  // ゲージ初期描画
  renderGauge();

  // キャッシュからデータ読み込み
  RESOURCE_NAMES.forEach(r => {
    const cached = api.loadCache(r);
    if (cached && cached.items) allData[r] = cached.items;
  });

  const hasCache = allData.events.length + allData.members.length + allData.experiments.length > 0;
  updateSyncStatus(hasCache ? 'cached' : 'initial-loading', hasCache ? Date.now() : null);

  // ウェルカムメッセージ
  addMessage('bot', 'こんにちは！SciComi Bot です。\nイベント・メンバー・実験に関する質問をどうぞ。\n\n例:\n・来月のイベントは？\n・6Cで書類を書いていないメンバーは？\n・工作の実験ネタを教えて\n・田中さんの参加イベント');

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
    if (String(e).includes('unauthorized')) {
      api.clearToken();
      api.clearAllCache();
      showPasswordModal(() => location.reload());
      return;
    }
    updateSyncStatus('error', null, e.message);
  }
}
