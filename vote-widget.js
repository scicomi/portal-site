/**
 * SciComi Portal - 出欠投票 共通ウィジェット
 *
 * vote.html 廃止（2026-07）に伴い、3ページに分散していた出欠回答UIと
 * 対象者算出・集計ロジックをここに集約した。
 *   読み込み順: config.js → api.js → app.js → vote-widget.js → 各ページJS
 *   利用ページ: index.html（出欠一括回答）
 *               events.html（プレビューモーダル内のインライン回答・参加バッジ）
 *               event-series.html（「参加状況」タブのトグル式インライン回答・回答一覧モーダル）
 *
 * データは GAS の EventVotes シート（EventID, MemberID, Status, UpdatedAt, Note）。
 * 名前選択は localStorage（VOTE_MEMBER_KEY）で端末に記憶し、全ページで共有する。
 * 操作は全ページ共通で「タップ即送信（楽観的更新）＋失敗時ロールバック」。確認ダイアログは挟まない。
 */

const VOTE_MEMBER_KEY = 'scicomi_vote_member';
const VOTE_STATUS_LABELS = { attend: '参加', absent: '不参加', undecided: '未定' };

// ====== 名前の端末記憶 ======

function getSavedVoteMemberId() {
  return localStorage.getItem(VOTE_MEMBER_KEY) || '';
}

function setSavedVoteMemberId(id) {
  if (id) localStorage.setItem(VOTE_MEMBER_KEY, id);
  else localStorage.removeItem(VOTE_MEMBER_KEY);
}

// ====== 対象者算出（旧 vote.js / home.js / event-series.js の3重実装を統合） ======

// 出欠の回答・集計はコーディネーター・アドバイザーを対象外にする
function isVoteEligibleMember(m) {
  const r = memberRoleOf(m);
  return r !== 'アドバイザー' && r !== 'コーディネーター';
}

function voteStaffIds(members) {
  return new Set((members || []).filter(m => !isVoteEligibleMember(m)).map(m => m.ID));
}

// イベント年度に在籍する出欠対象メンバー。ev 省略時は今年度。
function voteEligibleMembers(members, ev) {
  const fyTarget = (ev && getFiscalYear(ev.Date)) || currentFiscalYear();
  return (members || []).filter(m => {
    if (!m.Name) return false;
    if (m.Active === 'false') return false;
    if (!isVoteEligibleMember(m)) return false;
    const fy = m.FiscalYear ? parseInt(m.FiscalYear) : currentFiscalYear();
    return fy === fyTarget;
  });
}

// ====== 締切 ======

// 出欠の締切日時。VoteDeadline（任意設定）が優先、無ければイベント最終日。いずれも当日23:59まで。
// イベントは GAS形（VoteDeadline/DateEnd）・UI形（Vote_Deadline/Date_End）のどちらでも受ける。
function voteDeadlineDate(ev) {
  const d = ev.VoteDeadline || ev.Vote_Deadline || ev.DateEnd || ev.Date_End || ev.Date;
  if (!d) return null;
  const dt = parseISODate(d);
  if (!dt) return null;
  dt.setHours(23, 59, 59, 999);
  return dt;
}

function voteDeadlinePassed(ev) {
  const dt = voteDeadlineDate(ev);
  return !!dt && dt < new Date();
}

// ====== 集計 ======

// 1イベント分の votes を集計する。noanswer は「対象メンバー − 回答済み」。
function voteCounts(votes, members, ev) {
  const staff = voteStaffIds(members);
  const counts = { attend: 0, absent: 0, undecided: 0 };
  const voted = new Set();
  (votes || []).forEach(v => {
    if (staff.has(v.memberId)) return;
    if (counts[v.status] !== undefined) counts[v.status]++;
    voted.add(v.memberId);
  });
  const eligible = voteEligibleMembers(members, ev);
  const noanswer = Math.max(0, eligible.length - voted.size);
  return { ...counts, noanswer, eligibleCount: eligible.length };
}

// 送信エラーを人向けの文言に変換する（vote_closed はサーバー側の締切ガード）
function voteErrorMessage(e) {
  if (String(e && e.message) === 'vote_closed') {
    return '出欠の締切を過ぎているため変更できません（変更が必要な場合は管理者に連絡してください）';
  }
  return '回答に失敗しました: ' + humanizeApiError(e);
}

// ====== インライン投票ウィジェット ======

/**
 * container に「名前選択＋参加/不参加/未定＋一言メモ」を描画する。
 * opts:
 *   event    : 対象イベント（GAS形・UI形どちらでも可）
 *   members  : メンバー配列
 *   votes    : このイベントの投票配列（ライブ参照。送信成功時に中身を書き換える）
 *   onChange : (votes) => void  送信成功・ロールバック後に呼ぶ（ホスト側の再集計用）
 */
function renderVoteWidget(container, opts) {
  if (!container) return;
  const { event: ev, members, votes } = opts;
  const memberId = getSavedVoteMemberId();
  const eligible = voteEligibleMembers(members, ev);
  const selectable = eligible;
  const memberValid = selectable.some(m => m.ID === memberId);
  const memberGroups = groupMembersByGrade(selectable);
  const closed = voteDeadlinePassed(ev);
  const canEdit = !closed || api.isAdmin();
  const mine = memberValid ? (votes || []).find(v => v.memberId === memberId) : null;

  // 締切表示
  let deadlineHtml = '';
  const explicitDl = ev.VoteDeadline || ev.Vote_Deadline || '';
  if (closed) {
    deadlineHtml = `<div class="vw-deadline vw-deadline-passed">出欠の締切を過ぎています${api.isAdmin() ? '（管理者として変更できます）' : '。変更が必要な場合は管理者に連絡してください'}</div>`;
  } else if (explicitDl) {
    deadlineHtml = `<div class="vw-deadline">出欠締切: ${shortDate(explicitDl)} まで</div>`;
  }

  const btnsHtml = memberValid && canEdit ? `
    <div class="vw-btns">
      ${Object.keys(VOTE_STATUS_LABELS).map(st =>
        `<button type="button" class="bv-btn bv-${st} ${mine && mine.status === st ? 'active' : ''}" data-status="${st}" aria-pressed="${mine && mine.status === st ? 'true' : 'false'}">${VOTE_STATUS_LABELS[st]}</button>`
      ).join('')}
    </div>
    <div class="vw-note-row">
      <input type="text" class="vw-note e1-input" maxlength="30"
        placeholder="一言メモ（任意・例: 遅れて参加）" value="${escapeAttr(mine && mine.note ? mine.note : '')}"
        title="回答と一緒に保存される短いメモ">
    </div>` : '';

  container.innerHTML = `
    <div class="vw">
      ${deadlineHtml}
      <div class="vw-member-row">
        <label class="vw-label">あなたの名前</label>
        <select class="vw-member e1-input" aria-label="出欠回答に使うあなたの名前を選択" ${!canEdit ? 'disabled' : ''}>
          <option value="">-- 名前を選択 --</option>
          ${memberGroups.map(g => `<optgroup label="${escapeAttr(g.label)}">${g.members.map(m => `<option value="${escapeAttr(m.ID)}" ${m.ID === memberId ? 'selected' : ''}>${escapeHtml(m.Name)}</option>`).join('')}</optgroup>`).join('')}
        </select>
        ${memberValid && mine ? `<span class="vw-mine">回答済み: ${VOTE_STATUS_LABELS[mine.status] || ''}${mine.updatedAt ? ' (' + voteTimeShort(mine.updatedAt) + ')' : ''}</span>` : ''}
      </div>
      ${btnsHtml}
    </div>`;

  // 名前変更 → 端末に記憶して再描画（全ページ共通キーなのでホームの一括回答等とも同期する）
  container.querySelector('.vw-member').addEventListener('change', (e2) => {
    setSavedVoteMemberId(e2.target.value);
    renderVoteWidget(container, opts);
  });

  // 参加/不参加/未定 → タップ即送信（楽観的更新）
  container.querySelectorAll('.vw-btns .bv-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const noteEl = container.querySelector('.vw-note');
      const note = noteEl ? noteEl.value.trim() : undefined;
      submitVoteOptimistic({
        event: ev, votes, memberId,
        status: btn.dataset.status,
        note,
        rerender: () => renderVoteWidget(container, opts),
        onChange: opts.onChange
      });
    });
  });

  // 一言メモの後編集 → 回答済みならステータス据え置きで保存
  const noteInput = container.querySelector('.vw-note');
  if (noteInput) {
    noteInput.addEventListener('change', () => {
      const cur = (votes || []).find(v => v.memberId === memberId);
      if (!cur) return; // 未回答ならボタンを押した時に一緒に送る
      if ((cur.note || '') === noteInput.value.trim()) return;
      submitVoteOptimistic({
        event: ev, votes, memberId,
        status: cur.status,
        note: noteInput.value.trim(),
        rerender: () => renderVoteWidget(container, opts),
        onChange: opts.onChange
      });
    });
  }
}

// 楽観的更新つきの投票送信（votes 配列を直接書き換える）
async function submitVoteOptimistic({ event: ev, votes, memberId, status, note, rerender, onChange }) {
  if (!memberId) { toast('先に名前を選択してください', 'info'); return; }

  const idx = votes.findIndex(v => v.memberId === memberId);
  const before = idx >= 0 ? { ...votes[idx] } : null;
  const optimistic = {
    eventId: ev.ID, memberId, status,
    note: note !== undefined ? note : (before ? before.note : ''),
    updatedAt: ''
  };
  if (before && before.status === optimistic.status && (before.note || '') === (optimistic.note || '')) return;
  if (idx >= 0) votes[idx] = optimistic; else votes.push(optimistic);
  if (rerender) rerender();
  if (onChange) onChange(votes);

  try {
    const saved = await api.submitVote({ eventId: ev.ID, memberId, status, note });
    const j = votes.findIndex(v => v.memberId === memberId);
    if (j >= 0) votes[j] = saved;
    if (rerender) rerender();
    if (onChange) onChange(votes);
    toast(`「${VOTE_STATUS_LABELS[status]}」で回答しました`, 'success', 2000);
  } catch (e) {
    const j = votes.findIndex(v => v.memberId === memberId);
    if (before) { if (j >= 0) votes[j] = before; }
    else if (j >= 0) votes.splice(j, 1);
    if (rerender) rerender();
    if (onChange) onChange(votes);
    toast(voteErrorMessage(e), 'error');
  }
}

// ====== 回答一覧モーダル（旧 vote.html の回答一覧＋日時表示を統合） ======

function voteTimeShort(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function showVoteListModal(ev, votes, members) {
  const staff = voteStaffIds(members);
  const nameOf = {};
  (members || []).forEach(m => { nameOf[m.ID] = m.Name || m.ID; });

  const grouped = { attend: [], absent: [], undecided: [] };
  const voted = new Set();
  (votes || []).forEach(v => {
    if (staff.has(v.memberId)) return;
    if (grouped[v.status]) {
      grouped[v.status].push({ name: nameOf[v.memberId] || v.memberId, updatedAt: v.updatedAt, note: v.note || '' });
    }
    voted.add(v.memberId);
  });
  const noanswerNames = voteEligibleMembers(members, ev)
    .filter(m => !voted.has(m.ID))
    .map(m => m.Name || m.ID)
    .sort((a, b) => a.localeCompare(b, 'ja'));

  const sections = [
    { label: '参加',   type: 'attend',    items: grouped.attend },
    { label: '不参加', type: 'absent',    items: grouped.absent },
    { label: '未定',   type: 'undecided', items: grouped.undecided },
    { label: '未回答', type: 'noanswer',  items: noanswerNames.map(n => ({ name: n })) }
  ];
  const sectionsHtml = sections.map(s => {
    if (s.items.length === 0) return '';
    const items = s.items.slice().sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    return `<div class="vote-detail-group">
      <h4 class="vote-detail-label vote-detail-label-${s.type}">${s.label} (${s.items.length})</h4>
      <ul class="vote-detail-names">${items.map(it =>
        `<li>${escapeHtml(it.name)}` +
        (it.note ? `<span class="vote-detail-note">${escapeHtml(it.note)}</span>` : '') +
        (it.updatedAt ? `<span class="vote-detail-time">${voteTimeShort(it.updatedAt)}</span>` : '') +
        '</li>').join('')}</ul>
    </div>`;
  }).join('');

  const title = ev.Title || '(無題)';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content" style="max-width:520px;" role="dialog" aria-modal="true" aria-labelledby="vote-list-modal-title">
      <h2 id="vote-list-modal-title" style="margin-top:0;">参加回答一覧</h2>
      <p class="text-muted" style="font-size:0.85rem; margin:0 0 12px;">
        ${escapeHtml(title)} — ${escapeHtml(ev.Date || '')} (${dayOfWeekJP(ev.Date)})
      </p>
      ${sectionsHtml || '<p class="text-hint">まだ回答はありません</p>'}
      <div class="action-buttons" style="margin-top:16px;">
        ${noanswerNames.length > 0 ? '<button type="button" class="btn btn-secondary" data-copy-noanswer>未回答者をコピー</button>' : ''}
        <button type="button" class="btn btn-primary-solid" style="width:auto;" data-close>閉じる</button>
      </div>
    </div>`;

  // 未回答者リストをリマインド文つきでコピー（LINE等に貼る用）
  const copyBtn = overlay.querySelector('[data-copy-noanswer]');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const url = new URL(`event-series.html?event=${encodeURIComponent(ev.ID)}&vote=1`, location.href).href;
      const text = `【${title} ${shortDate(ev.Date)}】出欠が未回答の方: ${noanswerNames.join('、')}\n回答はこちら → ${url}`;
      copyTextToClipboard(text, '未回答者リスト');
    });
  }

  const close = () => overlay.remove();
  overlay.querySelector('[data-close]').addEventListener('click', close);
  bindOverlayClose(overlay, close);
  bindModalEscape(overlay, close);
  document.body.appendChild(overlay);
  trapFocus(overlay.querySelector('.modal-content'));
}
