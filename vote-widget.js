/**
 * SciComi Site - 出欠投票 共通ウィジェット
 *
 * vote.html 廃止（2026-07）に伴い、3ページに分散していた出欠回答UIと
 * 対象者算出・集計ロジックをここに集約した。
 *   読み込み順: config.js → api.js → app.js → vote-widget.js → 各ページJS
 *   利用ページ: index.html（出欠一括回答）
 *               events.html（プレビューモーダル内のインライン回答・参加バッジ）
 *               event-series.html（「参加状況」タブのトグル式インライン回答）
 *
 * データはサーバーの event_votes テーブル（EventID, MemberID, Status, UpdatedAt, Note）。
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

// 記憶した名前が現在のメンバー一覧に存在しなければ（年度コピーで ID が変わった等）記憶を破棄して '' を返す。
// members が未取得（空）のときは判定できないので、そのまま返す。
function getValidSavedVoteMemberId(members) {
  const id = getSavedVoteMemberId();
  if (!id || !members || members.length === 0) return id;
  if (members.some(m => m.ID === id)) return id;
  setSavedVoteMemberId('');
  return '';
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
function voteDeadlineDate(ev) {
  const d = ev.VoteDeadline || ev.DateEnd || ev.Date;
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

// スタッフ（コーディネーター・アドバイザー）の投票を除き、ステータスごとに振り分ける。
// 一覧の人数バッジ・参加状況タブ・未回答バッジで同じ基準を使うための共通関数。
function groupVotesByStatus(votes, members) {
  const staffIds = voteStaffIds(members);
  const grouped = { attend: [], absent: [], undecided: [] };
  (votes || []).forEach(v => {
    if (staffIds.has(v.memberId)) return;
    if (grouped[v.status]) grouped[v.status].push(v);
  });
  return grouped;
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
 *   event    : 対象イベント（サーバー形）
 *   members  : メンバー配列
 *   votes    : このイベントの投票配列（ライブ参照。送信成功時に中身を書き換える）
 *   onChange : (votes) => void  送信成功・ロールバック後に呼ぶ（ホスト側の再集計用）
 */
function renderVoteWidget(container, opts) {
  if (!container) return;
  const { event: ev, members, votes } = opts;
  const memberId = getValidSavedVoteMemberId(members);
  const eligible = voteEligibleMembers(members, ev);
  const memberValid = eligible.some(m => m.ID === memberId);
  const memberGroups = groupMembersByGrade(eligible);
  const closed = voteDeadlinePassed(ev);
  const canEdit = !closed || api.isAdmin();
  const mine = memberValid ? (votes || []).find(v => v.memberId === memberId) : null;
  const busy = isVoteBusy(ev.ID, memberId);   // 送信中はボタンを無効化（応答順の逆転を防ぐ）

  // 締切表示
  let deadlineHtml = '';
  const explicitDl = ev.VoteDeadline || '';
  if (closed) {
    deadlineHtml = `<div class="vw-deadline vw-deadline-passed">出欠の締切を過ぎています${api.isAdmin() ? '（管理者として変更できます）' : '。変更が必要な場合は管理者に連絡してください'}</div>`;
  } else if (explicitDl) {
    deadlineHtml = `<div class="vw-deadline">出欠締切: ${shortDate(explicitDl)} まで</div>`;
  }

  const btnsHtml = memberValid && canEdit ? `
    <div class="vw-btns">
      ${Object.keys(VOTE_STATUS_LABELS).map(st =>
        `<button type="button" class="bv-btn bv-${st} ${mine && mine.status === st ? 'active' : ''}" data-status="${st}" aria-pressed="${mine && mine.status === st ? 'true' : 'false'}" ${busy ? 'disabled' : ''}>${VOTE_STATUS_LABELS[st]}</button>`
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
        onChange: opts.onChange,
        // メモの change は「次のボタンを押した瞬間の blur」で発火する。ここで同期再描画すると
        // ボタン DOM が差し替わって直後のクリックが消えるため、再描画は保存応答後に回す。
        deferRender: true
      });
    });
  }
}

// 送信中の「eventId|memberId」。値は送信中に追加で押された次のリクエスト（最新の1件だけ保持）。
const _voteBusy = new Map();

function isVoteBusy(eventId, memberId) {
  return _voteBusy.has(eventId + '|' + memberId);
}

// 楽観的更新つきの投票送信（votes 配列を直接書き換える）
// 同じ人・同じイベントの送信中に押された操作は、応答が返ってから順番に送る（応答順の逆転を防ぐ）。
async function submitVoteOptimistic(args) {
  const { event: ev, votes, memberId, status, note, rerender, onChange, deferRender } = args;
  if (!memberId) { toast('先に名前を選択してください', 'info'); return; }

  const key = ev.ID + '|' + memberId;
  if (_voteBusy.has(key)) { _voteBusy.set(key, args); return; }

  const idx = votes.findIndex(v => v.memberId === memberId);
  const before = idx >= 0 ? { ...votes[idx] } : null;
  const optimistic = {
    eventId: ev.ID, memberId, status,
    note: note !== undefined ? note : (before ? before.note : ''),
    updatedAt: ''
  };
  if (before && before.status === optimistic.status && (before.note || '') === (optimistic.note || '')) return;
  _voteBusy.set(key, null);
  if (idx >= 0) votes[idx] = optimistic; else votes.push(optimistic);
  if (rerender && !deferRender) rerender();
  if (onChange) onChange(votes);

  let saved = null, error = null;
  try {
    saved = await api.submitVote({ eventId: ev.ID, memberId, status, note });
  } catch (e) {
    error = e;
  }
  const next = _voteBusy.get(key);
  _voteBusy.delete(key);   // 再描画より先に解除する（ボタンの disabled を戻すため）

  const j = votes.findIndex(v => v.memberId === memberId);
  if (error) {
    if (before) { if (j >= 0) votes[j] = before; }
    else if (j >= 0) votes.splice(j, 1);
  } else if (j >= 0) {
    votes[j] = saved;
  }
  if (rerender) rerender();
  if (onChange) onChange(votes);
  if (error) toast(voteErrorMessage(error), 'error');
  else toast(`「${VOTE_STATUS_LABELS[status]}」で回答しました`, 'success', 2000);

  if (next) submitVoteOptimistic(next);
}

// ====== 日時表示 ======

function voteTimeShort(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + formatTimeHM(d);
}
