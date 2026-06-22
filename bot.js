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
      if (!raw) return { date: todayISO(), count: 0 };
      const d = JSON.parse(raw);
      return d.date === todayISO() ? d : { date: todayISO(), count: 0 };
    } catch { return { date: todayISO(), count: 0 }; }
  },

  increment() {
    const d = this.get();
    d.count++;
    localStorage.setItem(this._key(), JSON.stringify(d));
    renderGauge();
  },

  count() { return this.get().count; },
  limit() { return this._limit(); },
  remaining() { return Math.max(0, this._limit() - this.count()); }
};

// ====== Gemini クライアント ======

const gemini = {
  getKey() {
    return localStorage.getItem(CONFIG.GEMINI.API_KEY_STORAGE) || '';
  },
  setKey(k) { localStorage.setItem(CONFIG.GEMINI.API_KEY_STORAGE, k); },
  removeKey() { localStorage.removeItem(CONFIG.GEMINI.API_KEY_STORAGE); },
  isReady() { return !!this.getKey(); },

  systemPrompt() {
    const today = todayISO();
    const fy = currentFiscalYear();
    return `あなたはSciComi Portal（サイエンスコミュニケーターサークルのポータル）のデータ検索アシスタントです。
ユーザーの質問を分析し、JSON形式の検索クエリに変換してください。
※個人情報は一切送信されません。質問文のみが送られます。

## データスキーマ

### events（イベント）
- Date: 開催日(YYYY-MM-DD), DateEnd: 終了日
- Title: イベント名
- Category: normal(イベント), other(その他), general(全体MTG), admin(幹部MTG)
- Location: 場所, Audience: 対象者
- AdminKyoka: 許可願の担当者名（人名）
- AdminHoukoku: 報告書の担当者名（人名）
- KyokaDeadline: 許可願期限(YYYY-MM-DD), HoukokuDeadline: 報告書期限
- PartsList: 部ごとの実験・担当者リスト JSON配列
  形式: [{"partName":"一部","items":[{"name":"実験名","presenter":"担当者名"}]}]
- Positives: 良かった点, Reflections: 反省点
- Remarks: 備考, Belongings: 持ち物

### members（メンバー）
- Name: 氏名
- Category: adviser(アドバイザー), coordinator(コーディネーター), member(メンバー)
- Role: 役職（例: プロジェクトリーダー）
- StudentID: 学籍番号。先頭2文字が学年コース（例: 4C, 5C, 6C）
- Active: "true"=在籍, "false"=卒業
- FiscalYear: 登録年度
- Note: メモ

### experiments（実験ネタ）
- Name: 実験名
- Category: workshop(工作), show(実験ショー), other(その他)
- Materials: 使用物品, Preparation: 事前準備
- Flow: 発表の流れ, Notes: 注意事項
- SlidesURL: スライドURL, Active: 有効フラグ

## 今日: ${today} / 年度: ${fy}年度（${fy}年4月〜${fy + 1}年3月）

## 書類の判定ルール
「書類を書いた」= イベントのAdminKyoka or AdminHoukokuにその人の名前がある
「書類を書いていない」= どのイベントにも名前がない

## 参加の判定ルール
「イベントに参加した」= PartsList内のitemsのpresenterにその人の名前がある

## 返答JSON形式（必ずこの形式のJSONのみ返す）

{
  "intent": "find_members|find_events|find_experiments|members_docs|member_activity|upcoming|count|general|unknown",
  "params": {
    "name": "人名（部分一致検索用）",
    "grade": "学年コード（例:6C）",
    "member_category": "adviser|coordinator|member",
    "event_category": "normal|other|general|admin",
    "exp_category": "workshop|show|other",
    "date_from": "YYYY-MM-DD",
    "date_to": "YYYY-MM-DD",
    "keyword": "自由キーワード",
    "active_only": true,
    "doc_type": "kyoka|houkoku|both",
    "include_in": "parts|admin|both",
    "fiscal_year": ${fy}
  },
  "response_text": "検索内容を説明する日本語文（結果の前に表示される）"
}

paramsは必要なものだけ含めてください。不要なものは省略。

## 例

Q: 「6Cで最近書類を書いていないメンバーは？」
A: {"intent":"members_docs","params":{"grade":"6C","doc_type":"both","active_only":true},"response_text":"6Cで書類（許可願・報告書）を担当していないメンバーを検索します。"}

Q: 「来月のイベント」
A: {"intent":"find_events","params":{"date_from":"${nextMonthStart()}","date_to":"${nextMonthEnd()}"},"response_text":"来月のイベント一覧です。"}

Q: 「田中さんが参加したイベント」
A: {"intent":"member_activity","params":{"name":"田中","include_in":"both"},"response_text":"田中さんが関わったイベントを検索します。"}

Q: 「次のミーティングはいつ？」
A: {"intent":"find_events","params":{"event_category":"general","date_from":"${today}"},"response_text":"次の全体ミーティングを検索します。"}

Q: 「工作の実験ネタ」
A: {"intent":"find_experiments","params":{"exp_category":"workshop"},"response_text":"工作カテゴリの実験ネタ一覧です。"}

Q: 「こんにちは」
A: {"intent":"general","params":{},"response_text":"こんにちは！イベント・メンバー・実験に関する質問をどうぞ。\\n\\n例:\\n・来月のイベントは？\\n・6Cで書類を書いていないメンバーは？\\n・工作の実験ネタを教えて\\n・田中さんの参加イベント"}

Q: 「天気教えて」
A: {"intent":"unknown","params":{},"response_text":"すみません、サークルのデータ（イベント・メンバー・実験）に関する質問にお答えできます。"}`;
  },

  async parseIntent(message) {
    const key = this.getKey();
    if (!key) throw new Error('API_KEY_NOT_SET');
    if (usageTracker.remaining() <= 0) throw new Error('DAILY_LIMIT');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI.MODEL}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: message }] }],
        systemInstruction: { parts: [{ text: this.systemPrompt() }] },
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 400 && errBody.includes('API_KEY_INVALID')) throw new Error('API_KEY_INVALID');
      if (res.status === 429) throw new Error('RATE_LIMIT');
      throw new Error('API_ERROR_' + res.status);
    }

    usageTracker.increment();
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('EMPTY_RESPONSE');
    return JSON.parse(text);
  }
};

// ====== 日付ヘルパー ======

function currentFiscalYear() {
  const now = new Date();
  return (now.getMonth() + 1) >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

function fiscalYearRange(fy) {
  return { from: `${fy}-04-01`, to: `${fy + 1}-03-31` };
}

function nextMonthStart() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  return toISODate(d);
}

function nextMonthEnd() {
  const d = new Date();
  d.setMonth(d.getMonth() + 2, 0);
  return toISODate(d);
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
        return `<div class="bot-result-item event-item">
          <div class="bot-ri-date">${d}${dow}</div>
          <div class="bot-ri-body">
            <div class="bot-ri-main">${escapeHtml(e.Title)} <span class="bot-ri-badge" style="background:${catCfg.bg};color:${catCfg.text}">${escapeHtml(cat)}</span></div>
            <div class="bot-ri-sub">${escapeHtml(e.Location || '')}</div>
            ${adminStr}
          </div>
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
        return `<div class="bot-result-item exp-item">
          <div class="bot-ri-main">${escapeHtml(x.Name)} <span class="bot-ri-badge" style="background:${catCfg.color};color:white">${escapeHtml(cat)}</span></div>
          ${matStr}
        </div>`;
      }).join('')}</div>`;
  }
};

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

function addMessage(role, text, html) {
  chatHistory.push({ role, text, html, time: new Date() });
  renderMessages();
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
        <div class="bot-msg-time">${timeStr}</div>
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

  if (!gemini.isReady()) {
    countEl.textContent = 'APIキー未設定';
    fillEl.style.width = '0%';
  }
}

// ====== メッセージ送信 ======

async function handleSend() {
  const input = document.getElementById('bot-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  addMessage('user', text);
  showTyping();

  try {
    if (!gemini.isReady()) {
      const result = keywordSearch(text);
      hideTyping();
      addMessage('bot', result.response_text, result.html);
      return;
    }

    const query = await gemini.parseIntent(text);
    const result = queryEngine.execute(query.intent, query.params || {});

    hideTyping();
    addMessage('bot', query.response_text || '', result.html || '');
    renderGauge();

  } catch (e) {
    hideTyping();
    const errMsg = e.message || String(e);
    if (errMsg === 'API_KEY_NOT_SET') {
      addMessage('bot', 'Gemini APIキーが未設定です。⚙ボタンから設定してください。\nキーワード検索にフォールバックします。');
      const result = keywordSearch(text);
      addMessage('bot', result.response_text, result.html);
    } else if (errMsg === 'API_KEY_INVALID') {
      addMessage('bot', 'APIキーが無効です。⚙ボタンから正しいキーを設定してください。');
    } else if (errMsg === 'DAILY_LIMIT') {
      addMessage('bot', '本日のAPI使用上限（' + usageTracker.limit() + '回）に達しました。明日リセットされます。\nキーワード検索にフォールバックします。');
      const result = keywordSearch(text);
      addMessage('bot', result.response_text, result.html);
    } else if (errMsg === 'RATE_LIMIT') {
      addMessage('bot', 'レート制限に達しました。少し待ってから再度お試しください。');
    } else {
      addMessage('bot', 'エラーが発生しました: ' + escapeHtml(errMsg));
    }
  }
}

// ====== 設定モーダル ======

function openSettings() {
  const modal = document.getElementById('gemini-settings-modal');
  const input = document.getElementById('gemini-key-input');
  input.value = gemini.getKey();
  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
}

function closeSettings() {
  document.getElementById('gemini-settings-modal').classList.add('hidden');
}

function saveSettings() {
  const key = document.getElementById('gemini-key-input').value.trim();
  if (key) {
    gemini.setKey(key);
    toast('APIキーを保存しました', 'success');
  } else {
    gemini.removeKey();
    toast('APIキーを削除しました', 'info');
  }
  closeSettings();
  renderGauge();
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
  document.getElementById('gemini-settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('gemini-settings-save').addEventListener('click', saveSettings);

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

  if (!gemini.isReady()) {
    addMessage('bot', '現在キーワード検索モードです。⚙ボタンからGemini APIキーを設定すると、自然言語での質問が可能になります。');
  }

  // バックグラウンドでデータ更新
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
