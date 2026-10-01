// SciComi Portal API(Cloudflare Workers)
//
// gas/Code.gs の doGet / doPost の置き換え。クライアント(api.js)との互換のため、
// 「単一のエンドポイントに action を POST する」方式と JSON の形・エラーコードをそのまま維持する。

import { CODE_VERSION, corsHeaders, jsonResponse, jstDate, ApiError } from './util.js';
import { getResource } from './tables.js';
import {
  checkAuth, checkAdmin, generateToken, verifyPassword,
  clientIp, beginAuthAttempt, delayAfterAuthFail, resetAuthFail
} from './auth.js';
import { publicConfig, adminConfig, adminSetConfig, GEMINI_DAILY_LIMIT } from './config.js';
import {
  listResource, listAllData, saveResource, deleteResource, ConflictError,
  listAllVotes, listEventVotes, voteDeadlinePassed, upsertVote, appendAuditLog
} from './data.js';
import { handleGeminiProxy, handleGeminiGenerate, geminiUsageGet } from './gemini.js';
import { notifyNewEvent } from './line.js';
import { uploadFile, deleteFile, serveFile } from './files.js';
import { runMaintenance } from './maintenance.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      if (url.pathname.startsWith('/files/') && (request.method === 'GET' || request.method === 'HEAD')) {
        return await serveFile(env, request);
      }
      // API は POST のみ(本文の JSON で action を受け取る)。トークンを URL に載せる GET は受け付けない
      if (request.method === 'POST') {
        let body = {};
        try { body = JSON.parse(await request.text()) || {}; } catch (_) { body = {}; }
        return jsonResponse(await handlePost(env, ctx, request, body), request, env);
      }
      return new Response('Method Not Allowed', { status: 405, headers: Object.assign({ Allow: 'POST, OPTIONS' }, corsHeaders(request, env)) });
    } catch (err) {
      // 内部の例外(SQL・設定の内容を含み得る)はクライアントに返さず、ログにだけ残す
      console.error('unhandled: ' + (err && err.stack || err));
      return jsonResponse({ success: false, error: 'internal_error' }, request, env, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  }
};

const versionInfo = () => ({ success: true, version: CODE_VERSION, serverTime: new Date().toISOString() });

// ---- POST ----

async function handlePost(env, ctx, request, body) {
  const token = body.token || '';
  const action = body.action || '';
  const resource = body.resource || 'events';
  const ip = clientIp(request);

  try {
    if (action === 'version') return versionInfo();

    // ログイン試行は、パスワードを検証する前に記録して上限を判定する(auth.js の beginAuthAttempt)

    // --- 認証(パスワード) ---
    if (action === 'auth') {
      if (!(await beginAuthAttempt(env, 'member', ip)).allowed) return { success: false, error: 'rate_limited' };
      if (!(await verifyPassword(env, 'password', body.password))) {
        await appendAuditLog(env, 'auth_fail', '', token);
        await delayAfterAuthFail(env, 'member', ip);
        return { success: false };
      }
      await resetAuthFail(env, 'member', ip);
      const newToken = await generateToken(env, 'member');
      await appendAuditLog(env, 'auth_success', '', newToken, 'member');
      return { success: true, token: newToken };
    }

    // --- 管理者認証 ---
    if (action === 'adminAuth') {
      if (!(await beginAuthAttempt(env, 'admin', ip)).allowed) return { success: false, error: 'rate_limited' };
      const ok = await verifyPassword(env, 'admin_password', body.admin_password);
      await appendAuditLog(env, ok ? 'adminAuth_success' : 'adminAuth_fail', '', token);
      if (!ok) { await delayAfterAuthFail(env, 'admin', ip); return { success: false }; }
      await resetAuthFail(env, 'admin', ip);
      return { success: true, adminToken: await generateToken(env, 'admin') };
    }

    // --- 統合ログイン(最初の 1 回でロールを判別) ---
    // 幹部パスワードと一致すれば管理者トークンも同時に発行(幹部はメンバーを兼ねる)。一般パスワードならメンバーのみ。
    if (action === 'login') {
      const inputPw = String(body.password || '').trim();
      if (!(await beginAuthAttempt(env, 'member', ip)).allowed) return { success: false, error: 'rate_limited' };
      if (inputPw === '') {
        await appendAuditLog(env, 'login_fail', '', '');
        await delayAfterAuthFail(env, 'member', ip);
        return { success: false };
      }
      // 幹部パスワードを先に判定(一般と同一に設定された場合でも挙動を確定させる)
      if (await verifyPassword(env, 'admin_password', inputPw)) {
        await resetAuthFail(env, 'member', ip);
        const adminMemberToken = await generateToken(env, 'member');
        const adminToken = await generateToken(env, 'admin');
        await appendAuditLog(env, 'login_admin', '', adminToken, 'admin');
        return { success: true, role: 'admin', token: adminMemberToken, adminToken };
      }
      if (await verifyPassword(env, 'password', inputPw)) {
        await resetAuthFail(env, 'member', ip);
        const memberToken = await generateToken(env, 'member');
        await appendAuditLog(env, 'login_member', '', memberToken, 'member');
        return { success: true, role: 'member', token: memberToken };
      }
      await appendAuditLog(env, 'login_fail', '', '');
      await delayAfterAuthFail(env, 'member', ip);
      return { success: false };
    }

    // --- 以下は認証必須 ---
    if (!(await checkAuth(env, token))) return { success: false, error: 'unauthorized' };

    // --- 一覧 ---
    if (action === 'list') {
      const res = getResource(resource);
      if (!res) return { success: false, error: 'unknown resource: ' + resource };
      // パスワード一覧など機密リソースは管理者トークン必須
      if (res.adminOnly && !(await checkAdmin(env, body.adminToken))) return { success: false, error: 'admin_required' };
      return { success: true, items: await listResource(env, resource) };
    }
    if (action === 'listAll') {
      // votes も同梱して、フロントの listVotes / getEventVotes の追加往復を無くす
      return Object.assign({ success: true }, await listAllData(env));
    }

    // --- 保存 ---
    if (action === 'save') {
      const res = getResource(resource);
      if (!res) return { success: false, error: 'unknown resource: ' + resource };
      // adminOnly: 閲覧も管理者のみ(パスワード一覧) / adminWrite: 閲覧はメンバーも可で、書き込みだけ管理者のみ(ガイド)
      if ((res.adminOnly || res.adminWrite) && !(await checkAdmin(env, body.adminToken))) return { success: false, error: 'admin_required' };
      let saved;
      try {
        saved = await saveResource(env, resource, body.item || {}, { isAdmin: !!(await checkAdmin(env, body.adminToken)) });
      } catch (err) {
        if (err instanceof ConflictError) return { success: false, error: 'conflict' };
        throw err;
      }
      const byAdmin = !!(res.adminOnly || res.adminWrite);
      await appendAuditLog(env, saved.created ? 'create' : 'update', resource + ':' + saved.item.ID, byAdmin ? body.adminToken : token, byAdmin ? 'admin' : 'member');
      // 通知は真の新規作成だけ。削除の Undo による再作成は、元の CreatedAt を持って来るので通知しない
      const isRestore = !!(body.item && body.item.CreatedAt);
      if (saved.created && resource === 'events' && !isRestore) ctx.waitUntil(notifyNewEvent(env, saved.item));
      return { success: true, item: saved.item };
    }

    // --- 削除: 管理者権限必須 ---
    if (action === 'delete') {
      if (!(await checkAdmin(env, body.adminToken))) return { success: false, error: 'admin_required' };
      const id = body.id;
      await appendAuditLog(env, 'delete', resource + ':' + id, body.adminToken, 'admin');
      return { success: await deleteResource(env, resource, id) };
    }

    // --- ファイル ---
    if (action === 'uploadFile') {
      const result = await uploadFile(env, request, body.file || {});
      await appendAuditLog(env, 'uploadFile', (result.name || '') + ' (' + (result.driveId || '') + ')', token, 'member');
      return { success: true, file: result };
    }
    if (action === 'deleteFile') {
      if (!(await checkAdmin(env, body.adminToken))) return { success: false, error: 'admin_required' };
      await appendAuditLog(env, 'deleteFile', body.driveId || '', body.adminToken, 'admin');
      return { success: await deleteFile(env, body.driveId || '') };
    }

    // --- Gemini ---
    // 停止中は、キーの有無にかかわらず Gemini へ送らない(再開: wrangler.toml の GEMINI_ENABLED)
    if (String(action).indexOf('gemini') === 0 && env.GEMINI_ENABLED !== 'true') return { success: false, error: 'feature_disabled' };
    if (action === 'geminiProxy') return handleGeminiProxy(env, Object.assign({}, body, { token }));
    if (action === 'geminiGenerate') return handleGeminiGenerate(env, Object.assign({}, body, { token }));
    if (action === 'geminiUsage') {
      return { success: true, usage: await geminiUsageGet(env, jstDate()), limit: GEMINI_DAILY_LIMIT };
    }

    // --- 設定 ---
    // 公開設定(メンバーも可・表示系のみ。機密値は含めない)
    if (action === 'getPublicConfig') return { success: true, config: await publicConfig(env) };
    if (action === 'adminGetConfig') {
      if (!(await checkAdmin(env, body.adminToken))) return { success: false, error: 'admin_required' };
      return { success: true, config: await adminConfig(env) };
    }
    if (action === 'adminSetConfig') {
      if (!(await checkAdmin(env, body.adminToken))) return { success: false, error: 'admin_required' };
      const key = body.key || '';
      const r = await adminSetConfig(env, key, body.value);
      if (r.success) await appendAuditLog(env, 'adminSetConfig', key, body.adminToken, 'admin');
      return r;
    }

    // --- 出欠投票 ---
    if (action === 'getEventVotes') {
      const eventId = body.eventId || '';
      if (!eventId) return { success: false, error: 'missing eventId' };
      return { success: true, votes: await listEventVotes(env, eventId) };
    }
    if (action === 'listVotes') return { success: true, votes: await listAllVotes(env) };
    if (action === 'submitVote') {
      const v = body.vote || {};
      if (!v.eventId || !v.memberId || !v.status) return { success: false, error: 'missing fields' };
      if (['attend', 'absent', 'undecided'].indexOf(v.status) < 0) return { success: false, error: 'invalid status' };
      // 出欠締切(VoteDeadline、未設定ならイベント最終日)を過ぎたら管理者のみ変更可
      const passed = await voteDeadlinePassed(env, v.eventId);
      if (passed === null) return { success: false, error: 'event not found' };
      if (passed && !(await checkAdmin(env, body.adminToken))) return { success: false, error: 'vote_closed' };
      const result = await upsertVote(env, v);
      await appendAuditLog(env, 'vote', v.eventId + ':' + v.memberId + ':' + v.status, token, 'member');
      return { success: true, vote: result };
    }

    return { success: false, error: 'unknown action: ' + action };
  } catch (err) {
    // 既知のエラー(invalid_id / file_too_large など)はコードと説明を返す。それ以外は内部情報を出さない
    if (err instanceof ApiError) return { success: false, error: err.code, detail: err.detail || undefined };
    if (err instanceof ConflictError) return { success: false, error: 'conflict' };
    console.error('action ' + action + ' failed: ' + (err && err.stack || err));
    return { success: false, error: 'internal_error' };
  }
}
