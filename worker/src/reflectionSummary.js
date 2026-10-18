// 振り返りの要約: 保存・読み出し・自動更新の目印と取り出し・「再生成」ボタン。設計は docs/14_reflection_summary_roadmap.md の §4。
//
// - Gemini に送るのは、氏名・連絡先を置き換えた本文と種類だけ(feedback.js → redact.js → reflectionPrompt.js)
// - 全体の非常停止は env.GEMINI_ENABLED("true" 以外なら送らない。geminiInvoke でも見る)。自動更新だけは設定 reflection_summary_auto で止められる
// - 自動更新は、定期実行 1 回につき 1 件・1 日 AUTO_DAILY_LIMIT 件まで。「再生成」ボタンは 1 件 1 日 1 回(自動とは別枠)

import { geminiInvoke } from './gemini.js';
import { getConfig } from './config.js';
import { cacheIncr } from './cache.js';
import { appendAuditLog } from './data.js';
import { jstIso, sha256Hex } from './util.js';
import { collectReflectionEntries } from './feedback.js';
import { createRedactor } from './redact.js';
import { buildReflectionPrompt, parseReflectionResponse, REFLECTION_RESPONSE_SCHEMA } from './reflectionPrompt.js';

export const SUMMARY_TARGETS = ['experiments', 'events'];
export const MIN_ENTRIES = 3;           // これより少なければ要約を作らない(出さない)
export const REGEN_GROWTH = 3;          // 前回より、これだけ増えたら自動で作り直す
export const SUMMARY_DELAY_SEC = 600;   // 最後の保存から自動更新まで(この間の保存し直しは 1 回にまとめる)
export const AUTO_DAILY_LIMIT = 20;     // 自動更新の 1 日の上限(Google の無料枠の確認結果しだいで下げる)
const RETRY_DELAYS_SEC = [60, 300, 1800, 3600];   // 自動更新に失敗したときの再試行の間隔(使い切ったら 'failed')
const CLAIM_SEC = 120;                  // 取り出し中の行を、ほかの実行が拾わないようにする時間
const NOT_READY_DELAY_SEC = 3600;       // キーが未設定・停止中のときに、次に見に来るまで

const nowSec = () => Math.floor(Date.now() / 1000);
const JST_OFFSET_SEC = 9 * 3600;

// 日本時間の今日の 0 時(UNIX 秒)
function jstDayStart(t) {
  return Math.floor((t + JST_OFFSET_SEC) / 86400) * 86400 - JST_OFFSET_SEC;
}
// 日次の上限に当たったときの次の時刻: 翌日の 00:10(日本時間)
function nextDayDue(t) {
  return jstDayStart(t) + 86400 + 600;
}

export function geminiEnabled(env) {
  return !!env && env.GEMINI_ENABLED === 'true';
}

// 保存から自動更新までの待ち。ローカルの結合テストだけ SUMMARY_DELAY_SEC で縮める(本番では設定しない)
function delaySec(env) {
  const n = parseInt(env.SUMMARY_DELAY_SEC, 10);
  return n >= 0 ? n : SUMMARY_DELAY_SEC;
}

// 自動更新の 1 日の上限。ローカルの結合テストだけ SUMMARY_AUTO_DAILY_LIMIT で変える(何度も試すと既定の 20 件に当たるため。本番では設定しない)
function autoDailyLimit(env) {
  const n = parseInt(env.SUMMARY_AUTO_DAILY_LIMIT, 10);
  return n >= 0 ? n : AUTO_DAILY_LIMIT;
}

async function autoEnabled(env) {
  return (await getConfig(env, 'reflection_summary_auto')) !== 'false';
}

// ---- 読み出し ----

async function loadTarget(env, type, id) {
  if (SUMMARY_TARGETS.indexOf(type) < 0) return null;
  return env.DB.prepare('SELECT ID, Positives, Reflections FROM ' + type + ' WHERE ID = ?').bind(id).first();
}

async function getRow(env, type, id) {
  return env.DB.prepare('SELECT * FROM reflection_summaries WHERE TargetType = ? AND TargetID = ?').bind(type, id).first();
}

// メンバーの氏名(置き換えにだけ使う。Gemini にも画面にも返さない)
async function loadMemberNames(env) {
  const rows = (await env.DB.prepare('SELECT Name FROM members').all()).results || [];
  return rows.map(r => r.Name);
}

// 振り返りの中身(id・種類・本文)の指紋。並び順も含める
export async function entriesHash(entries) {
  return sha256Hex(JSON.stringify(entries.map(e => [e.id, e.kind, e.text])));
}

function parseSummary(s) {
  if (!s) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (_) { return null; }
}

// 自動更新で何をするか: 'clear' 要約を消す / 'skip' 何もしない / 'generate' 作る(作り直す) / 'stale' 作らない(画面で「古い」と出す)
export function summaryAction(row, entryCount, hash) {
  const has = !!(row && row.Summary);
  if (entryCount < MIN_ENTRIES) return has ? 'clear' : 'skip';
  if (has && row.InputHash === hash) return 'skip';
  if (!has) return 'generate';
  return entryCount >= (row.EntryCount || 0) + REGEN_GROWTH ? 'generate' : 'stale';
}

// ---- 生成(Gemini を 1 回呼ぶ) ----
// 成功: { success: true, summary, model, used } / 失敗: { success: false, error, ... }(geminiInvoke のエラーか、出力の検証の失敗)
async function generate(env, entries, caller, token) {
  const redact = createRedactor(await loadMemberNames(env));
  const p = buildReflectionPrompt(entries, redact);
  if (!p.used) return { success: false, error: 'not_enough_entries' };
  const r = await geminiInvoke(env, {
    caller, token, systemPrompt: p.systemPrompt, userText: p.userText, wantJson: true, responseSchema: REFLECTION_RESPONSE_SCHEMA
  });
  if (!r.success) return r;
  const v = parseReflectionResponse(r.data, p.refs);
  if (!v.ok) return { success: false, error: 'invalid_output', detail: v.error, called: true };
  // 入力で取りこぼした名前をモデルが書き写した場合の保険に、出力にも同じ置き換えをかける
  const s = v.summary;
  const summary = {
    positive: redact(s.positive), improve: redact(s.improve),
    topics: s.topics.map(t => Object.assign({}, t, { label: redact(t.label) }))
  };
  return { success: true, summary, model: r.model || '', used: p.used };
}

async function saveResult(env, type, id, g, hash, entryCount) {
  await env.DB.prepare(
    "INSERT INTO reflection_summaries (TargetType, TargetID, Summary, InputHash, SourceCount, EntryCount, Model, GeneratedAt, State, DueAt, Attempts) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, 0) ON CONFLICT(TargetType, TargetID) DO UPDATE SET "
    + "Summary = excluded.Summary, InputHash = excluded.InputHash, SourceCount = excluded.SourceCount, EntryCount = excluded.EntryCount, "
    + "Model = excluded.Model, GeneratedAt = excluded.GeneratedAt, State = 'idle', DueAt = 0, Attempts = 0"
  ).bind(type, id, JSON.stringify(g.summary), hash, g.used, entryCount, g.model, jstIso()).run();
}

async function clearResult(env, type, id) {
  await env.DB.prepare(
    "UPDATE reflection_summaries SET Summary = '', InputHash = '', SourceCount = 0, EntryCount = 0, Model = '', GeneratedAt = '', State = 'idle', DueAt = 0, Attempts = 0 "
    + 'WHERE TargetType = ? AND TargetID = ?'
  ).bind(type, id).run();
}

// ---- 保存のあとの目印 ----
// index.js の save のあとに呼ぶ。続けて保存されたら取り出す時刻を後ろにずらす(早めはしない。日次の上限で翌日に回したものもそのまま)
export async function markSummaryDirty(env, type, id) {
  if (!geminiEnabled(env) || SUMMARY_TARGETS.indexOf(type) < 0 || !id) return false;
  const due = nowSec() + delaySec(env);
  await env.DB.prepare(
    "INSERT INTO reflection_summaries (TargetType, TargetID, State, DueAt, Attempts) VALUES (?, ?, 'dirty', ?, 0) "
    + 'ON CONFLICT(TargetType, TargetID) DO UPDATE SET '
    + "DueAt = CASE WHEN reflection_summaries.State = 'dirty' THEN MAX(reflection_summaries.DueAt, excluded.DueAt) ELSE excluded.DueAt END, "
    + "Attempts = CASE WHEN reflection_summaries.State = 'dirty' THEN reflection_summaries.Attempts ELSE 0 END, "
    + "State = 'dirty'"
  ).bind(type, id, due).run();
  return true;
}

// ---- 自動更新(1 分ごとの定期実行) ----
// 期限が来た目印を limit 件まで見て、必要なものだけ作る。作った件数を返す
export async function drainSummaries(env, limit) {
  if (!geminiEnabled(env)) return 0;   // 全体の非常停止。D1 も読まない
  if (!(await autoEnabled(env))) return 0;
  const t = nowSec();
  const rows = (await env.DB.prepare("SELECT * FROM reflection_summaries WHERE State = 'dirty' AND DueAt <= ? ORDER BY DueAt LIMIT ?")
    .bind(t, limit || 1).all()).results || [];
  let made = 0;
  for (const row of rows) {
    const type = row.TargetType, id = row.TargetID;
    // 重なって動いた実行が同じ行を取らないよう、先に期限を後ろにずらして確保する
    const claim = await env.DB.prepare("UPDATE reflection_summaries SET DueAt = ? WHERE TargetType = ? AND TargetID = ? AND State = 'dirty' AND DueAt <= ?")
      .bind(t + CLAIM_SEC, type, id, t).run();
    if (!claim.meta || claim.meta.changes !== 1) continue;
    const target = await loadTarget(env, type, id);
    if (!target) { await env.DB.prepare('DELETE FROM reflection_summaries WHERE TargetType = ? AND TargetID = ?').bind(type, id).run(); continue; }
    const entries = collectReflectionEntries(type, target);
    const hash = await entriesHash(entries);
    const action = summaryAction(row, entries.length, hash);
    if (action === 'clear') { await clearResult(env, type, id); continue; }
    if (action !== 'generate') {
      await env.DB.prepare("UPDATE reflection_summaries SET State = 'idle', DueAt = 0, Attempts = 0 WHERE TargetType = ? AND TargetID = ?").bind(type, id).run();
      continue;
    }
    // 自動更新の 1 日の上限(呼ぶ前に数える。失敗しても 1 回と数える)
    const n = await cacheIncr(env, 'summary_auto_' + jstDayStart(t), 2 * 86400);
    if (n > autoDailyLimit(env)) {
      await env.DB.prepare('UPDATE reflection_summaries SET DueAt = ? WHERE TargetType = ? AND TargetID = ?').bind(nextDayDue(t), type, id).run();
      continue;
    }
    const g = await generate(env, entries, 'cron');
    if (g.success) { await saveResult(env, type, id, g, hash, entries.length); made++; continue; }
    await deferAfterFailure(env, type, id, row.Attempts || 0, g, t);
  }
  return made;
}

async function deferAfterFailure(env, type, id, prevAttempts, g, t) {
  const where = ' WHERE TargetType = ? AND TargetID = ?';
  // こちらの準備が整っていない(キーが未設定・停止中): 失敗に数えず、しばらくしてから見る
  if (g.error === 'feature_disabled' || g.error === 'gemini_key_not_configured') {
    await env.DB.prepare('UPDATE reflection_summaries SET DueAt = ?' + where).bind(t + NOT_READY_DELAY_SEC, type, id).run();
    return;
  }
  // 1 日の上限(Google 側・こちらの gemini_usage): 失敗に数えず、翌日に回す
  if (g.error === 'RATE_LIMIT_DAILY') {
    await env.DB.prepare('UPDATE reflection_summaries SET DueAt = ?' + where).bind(nextDayDue(t), type, id).run();
    return;
  }
  const attempts = prevAttempts + 1;
  if (attempts > RETRY_DELAYS_SEC.length) {
    await env.DB.prepare("UPDATE reflection_summaries SET State = 'failed', Attempts = ?" + where).bind(attempts, type, id).run();
  } else {
    await env.DB.prepare('UPDATE reflection_summaries SET DueAt = ?, Attempts = ?' + where).bind(t + RETRY_DELAYS_SEC[attempts - 1], attempts, type, id).run();
  }
  // エラーのコードだけを残す(本文・氏名は残さない)
  await appendAuditLog(env, 'summary_fail', type + ':' + id + ':auto: ' + g.error + (g.detail ? '/' + String(g.detail).slice(0, 40) : '') + ' (' + attempts + ')', '', 'system');
}

export async function drainSummariesSafe(env, limit) {
  try { return await drainSummaries(env, limit); } catch (e) { console.error('drainSummaries failed: ' + (e && e.stack || e)); return 0; }
}

// ---- 画面の action ----

function statusOf(row, entries, hash, t) {
  const summary = entries.length >= MIN_ENTRIES ? parseSummary(row && row.Summary) : null;
  return {
    success: true,
    enabled: true,
    minEntries: MIN_ENTRIES,
    entryCount: entries.length,
    summary,
    sourceCount: summary ? (row.SourceCount || 0) : 0,
    generatedAt: summary ? (row.GeneratedAt || '') : '',
    stale: !!summary && row.InputHash !== hash,
    state: row ? row.State : 'none',
    canRegenerate: entries.length >= MIN_ENTRIES && !(row && (row.ManualAt || 0) >= jstDayStart(t))
  };
}

// 要約と、その状態を返す。Gemini は呼ばない。停止中は { success: true, enabled: false }(画面はカードを出さない)
export async function getReflectionSummary(env, type, id) {
  if (!geminiEnabled(env)) return { success: true, enabled: false };
  const target = await loadTarget(env, type, id);
  if (!target) return { success: false, error: 'not_found' };
  const entries = collectReflectionEntries(type, target);
  const hash = await entriesHash(entries);
  const out = statusOf(await getRow(env, type, id), entries, hash, nowSec());
  out.autoEnabled = await autoEnabled(env);
  return out;
}

// 「再生成」ボタン: 1 件 1 日 1 回。その場で作って保存し、getReflectionSummary と同じ形で返す
export async function regenerateReflectionSummary(env, type, id, token) {
  if (!geminiEnabled(env)) return { success: false, error: 'feature_disabled' };
  const target = await loadTarget(env, type, id);
  if (!target) return { success: false, error: 'not_found' };
  const entries = collectReflectionEntries(type, target);
  if (entries.length < MIN_ENTRIES) return { success: false, error: 'not_enough_entries' };
  const hash = await entriesHash(entries);
  const t = nowSec();

  // 今日の 1 回を確保する(同時に 2 回押されても 1 回だけ通る)
  const claim = await env.DB.prepare(
    "INSERT INTO reflection_summaries (TargetType, TargetID, State, ManualAt) VALUES (?, ?, 'idle', ?) "
    + 'ON CONFLICT(TargetType, TargetID) DO UPDATE SET ManualAt = excluded.ManualAt WHERE reflection_summaries.ManualAt < ?'
  ).bind(type, id, t, jstDayStart(t)).run();
  if (!claim.meta || claim.meta.changes !== 1) return { success: false, error: 'regenerate_limit' };
  const refundManual = async () => {   // Gemini に届かなかった失敗のときは、今日の 1 回を返す
    await env.DB.prepare('UPDATE reflection_summaries SET ManualAt = 0 WHERE TargetType = ? AND TargetID = ? AND ManualAt = ?').bind(type, id, t).run();
  };

  const row = await getRow(env, type, id);
  if (row && row.Summary && row.InputHash === hash) {
    await refundManual();   // 振り返りが変わっていなければ、作り直さない(Gemini を呼ばない)
    const out = statusOf(await getRow(env, type, id), entries, hash, t);
    out.unchanged = true;
    return out;
  }
  let g;
  try {
    g = await generate(env, entries, 'user', token);
  } catch (e) {
    await refundManual();
    throw e;
  }
  if (!g.success) {
    if (!g.called) await refundManual();   // 出力の検証で落ちたもの(Gemini は使った)は、今日の 1 回を使ったことにする
    return { success: false, error: g.error, retrySec: g.retrySec || undefined };
  }
  await saveResult(env, type, id, g, hash, entries.length);
  const out = statusOf(await getRow(env, type, id), entries, hash, t);
  out.autoEnabled = await autoEnabled(env);
  return out;
}
