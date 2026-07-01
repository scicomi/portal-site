/**
 * SciComi Portal - イベント参加投票
 *
 * 案E: 固定メンバーリスト選択式＋端末記憶（localStorage）
 * vote.html?id=ev_xxx で特定イベントの投票ページを開く。
 */

const VOTE_MEMBER_KEY = 'scicomi_vote_member';
const STATUS_LABELS = { attend: '参加', absent: '不参加', undecided: '未定' };

let currentEvent = null;
let allMembers = [];
let currentVotes = [];
let pendingStatus = null;

// ====== 起動 ======

document.addEventListener('DOMContentLoaded', () => {
  bootPage('vote', init);
});

async function init() {
  const params = new URLSearchParams(location.search);
  const eventId = params.get('id');
  if (!eventId) {
    showError('イベントIDが指定されていません。');
    return;
  }

  try {
    const [allData, votes] = await Promise.all([
      api.listAll(),
      api.getEventVotes(eventId)
    ]);

    const events = allData.events || [];
    allMembers = (allData.members || []).filter(m => m.Active !== 'false');
    currentEvent = events.find(e => e.ID === eventId);

    if (!currentEvent) {
      showError('イベントが見つかりません。');
      return;
    }

    currentVotes = votes;
    renderEventHeader();
    renderMemberSelect();
    renderVoteSummary();
    restoreMemberSelection();

    document.getElementById('vote-loading').style.display = 'none';
    document.getElementById('vote-app').style.display = '';
  } catch (e) {
    showError('データの読み込みに失敗しました: ' + humanizeApiError(e));
  }
}

// ====== イベントヘッダー描画 ======

function renderEventHeader() {
  const cat = getEventCategory(currentEvent.Category);
  const badge = document.getElementById('vote-cat-badge');
  badge.textContent = cat.short || cat.label;
  badge.style.background = cat.bg;
  badge.style.color = cat.text;

  document.getElementById('vote-event-title').textContent = currentEvent.Title || '(無題)';

  let dateStr = currentEvent.Date || '';
  if (dateStr) {
    dateStr = shortDate(dateStr) + '(' + dayOfWeekJP(dateStr) + ')';
    if (currentEvent.DateEnd && currentEvent.DateEnd !== currentEvent.Date) {
      dateStr += ' 〜 ' + shortDate(currentEvent.DateEnd) + '(' + dayOfWeekJP(currentEvent.DateEnd) + ')';
    }
  }
  if (currentEvent.TimeStart) {
    dateStr += ' ' + currentEvent.TimeStart;
    if (currentEvent.TimeEnd) dateStr += '〜' + currentEvent.TimeEnd;
  }
  document.getElementById('vote-event-date').textContent = dateStr;

  const loc = document.getElementById('vote-event-location');
  if (currentEvent.Location) {
    loc.textContent = currentEvent.Location;
  } else {
    loc.style.display = 'none';
  }

  checkDeadline();
}

function checkDeadline() {
  if (!currentEvent.Date) return;
  const eventDate = parseISODate(currentEvent.Date);
  const now = new Date();
  if (eventDate && eventDate < now) {
    const el = document.getElementById('vote-deadline');
    el.textContent = 'このイベントは終了しています。投票は締め切られました。';
    el.style.display = '';
    disableVoting();
  }
}

function disableVoting() {
  document.querySelectorAll('.vote-btn').forEach(btn => {
    btn.disabled = true;
  });
  const select = document.getElementById('vote-member');
  if (select) select.disabled = true;
}

// ====== メンバー選択 ======

function renderMemberSelect() {
  const select = document.getElementById('vote-member');
  allMembers
    .sort((a, b) => (a.Name || '').localeCompare(b.Name || '', 'ja'))
    .forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.ID;
      opt.textContent = m.Name || m.ID;
      select.appendChild(opt);
    });

  select.addEventListener('change', onMemberChange);
}

function restoreMemberSelection() {
  const saved = localStorage.getItem(VOTE_MEMBER_KEY);
  if (!saved) return;

  const select = document.getElementById('vote-member');
  const exists = Array.from(select.options).some(o => o.value === saved);
  if (exists) {
    select.value = saved;
    onMemberChange();
  }
}

function onMemberChange() {
  const select = document.getElementById('vote-member');
  const memberId = select.value;

  if (memberId) {
    localStorage.setItem(VOTE_MEMBER_KEY, memberId);
    document.getElementById('vote-buttons').style.display = '';
    document.getElementById('vote-change-btn').style.display = '';
    updateCurrentVoteDisplay(memberId);
    highlightCurrentVote(memberId);
  } else {
    document.getElementById('vote-buttons').style.display = 'none';
    document.getElementById('vote-change-btn').style.display = 'none';
    document.getElementById('vote-current').style.display = 'none';
    clearHighlight();
  }
}

function clearMemberSelection() {
  localStorage.removeItem(VOTE_MEMBER_KEY);
  const select = document.getElementById('vote-member');
  select.value = '';
  document.getElementById('vote-buttons').style.display = 'none';
  document.getElementById('vote-change-btn').style.display = 'none';
  document.getElementById('vote-current').style.display = 'none';
  clearHighlight();
}

// ====== 投票操作 ======

function onVoteClick(status) {
  const memberId = document.getElementById('vote-member').value;
  if (!memberId) return;

  const member = allMembers.find(m => m.ID === memberId);
  const name = member ? member.Name : memberId;
  const label = STATUS_LABELS[status];

  pendingStatus = status;
  document.getElementById('vote-confirm-msg').textContent =
    name + ' さんの回答を「' + label + '」で登録します。よろしいですか？';
  document.getElementById('vote-confirm-modal').style.display = '';
}

function closeConfirm() {
  pendingStatus = null;
  document.getElementById('vote-confirm-modal').style.display = 'none';
}

async function submitConfirmedVote() {
  if (!pendingStatus) return;

  const memberId = document.getElementById('vote-member').value;
  const status = pendingStatus;
  const submitBtn = document.getElementById('vote-confirm-submit');

  submitBtn.disabled = true;
  submitBtn.textContent = '送信中...';

  try {
    const result = await api.submitVote({
      eventId: currentEvent.ID,
      memberId: memberId,
      status: status
    });

    const idx = currentVotes.findIndex(v => v.memberId === memberId);
    if (idx >= 0) {
      currentVotes[idx] = result;
    } else {
      currentVotes.push(result);
    }

    renderVoteSummary();
    updateCurrentVoteDisplay(memberId);
    highlightCurrentVote(memberId);
    toast(STATUS_LABELS[status] + 'で投票しました', 'success');
  } catch (e) {
    toast('投票に失敗しました: ' + e.message, 'error');
  } finally {
    closeConfirm();
    submitBtn.disabled = false;
    submitBtn.textContent = '投票する';
  }
}

// ====== 表示更新 ======

function updateCurrentVoteDisplay(memberId) {
  const vote = currentVotes.find(v => v.memberId === memberId);
  const el = document.getElementById('vote-current');
  if (vote) {
    el.style.display = '';
    document.getElementById('vote-current-status').textContent = STATUS_LABELS[vote.status] || vote.status;
    if (vote.updatedAt) {
      const d = new Date(vote.updatedAt);
      document.getElementById('vote-current-time').textContent =
        '更新: ' + d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
  } else {
    el.style.display = 'none';
  }
}

function highlightCurrentVote(memberId) {
  clearHighlight();
  const vote = currentVotes.find(v => v.memberId === memberId);
  if (vote) {
    const btn = document.querySelector('.vote-btn[data-status="' + vote.status + '"]');
    if (btn) btn.classList.add('vote-btn-selected');
  }
}

function clearHighlight() {
  document.querySelectorAll('.vote-btn').forEach(b => b.classList.remove('vote-btn-selected'));
}

function renderVoteSummary() {
  const memberMap = {};
  allMembers.forEach(m => { memberMap[m.ID] = m.Name || m.ID; });

  const grouped = { attend: [], absent: [], undecided: [], noanswer: [] };
  const voted = new Set();

  currentVotes.forEach(v => {
    const name = memberMap[v.memberId] || v.memberId;
    if (grouped[v.status]) {
      grouped[v.status].push({ name, updatedAt: v.updatedAt });
    }
    voted.add(v.memberId);
  });

  allMembers.forEach(m => {
    if (!voted.has(m.ID)) {
      grouped.noanswer.push({ name: m.Name || m.ID });
    }
  });

  document.getElementById('vote-count-attend').textContent = grouped.attend.length;
  document.getElementById('vote-count-absent').textContent = grouped.absent.length;
  document.getElementById('vote-count-undecided').textContent = grouped.undecided.length;
  document.getElementById('vote-count-noanswer').textContent = grouped.noanswer.length;

  const allDone = grouped.noanswer.length === 0 && allMembers.length > 0;
  document.getElementById('vote-all-done').style.display = allDone ? '' : 'none';

  renderDetailList('vote-list-attend', '参加', grouped.attend, 'attend');
  renderDetailList('vote-list-absent', '不参加', grouped.absent, 'absent');
  renderDetailList('vote-list-undecided', '未定', grouped.undecided, 'undecided');
  renderDetailList('vote-list-noanswer', '未回答', grouped.noanswer, 'noanswer');
}

function renderDetailList(containerId, label, items, type) {
  const el = document.getElementById(containerId);
  if (items.length === 0) {
    el.innerHTML = '';
    return;
  }
  let html = '<h4 class="vote-detail-label vote-detail-label-' + type + '">' +
    escapeHtml(label) + ' (' + items.length + ')</h4><ul class="vote-detail-names">';
  items.forEach(it => {
    html += '<li>' + escapeHtml(it.name);
    if (it.updatedAt) {
      const d = new Date(it.updatedAt);
      html += ' <span class="vote-detail-time">' +
        (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') +
        '</span>';
    }
    html += '</li>';
  });
  html += '</ul>';
  el.innerHTML = html;
}

function toggleVoteDetail() {
  const el = document.getElementById('vote-detail');
  const btn = document.getElementById('vote-detail-btn');
  if (el.style.display === 'none') {
    el.style.display = '';
    btn.textContent = '回答一覧を隠す';
  } else {
    el.style.display = 'none';
    btn.textContent = '回答一覧を表示';
  }
}

// ====== エラー表示 ======

function showError(msg) {
  document.getElementById('vote-loading').style.display = 'none';
  document.getElementById('vote-error-msg').textContent = msg;
  document.getElementById('vote-error').style.display = '';
}
