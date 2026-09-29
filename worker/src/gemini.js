// Gemini 連携(gas/Code.gs の移植)。
//
// モデル名は年々変わり、いつか廃止される。コード変更なしで自己修復するため、
//   1) config の gemini_model を最優先で使う(管理画面から手動切替も可)
//   2) 空 or 廃止モデルなら、ListModels API で「今そのキーで使えるモデル」を動的取得し、軽量・新しいものを自動選択して保存
//   3) リクエストが 404(モデル廃止/未対応)になったら、その場で再検出して 1 度だけ自動リトライ

import { getConfig, setConfig, getSecret, GEMINI_MODEL, GEMINI_DAILY_LIMIT } from './config.js';
import { hmacHex } from './auth.js';
import { jstDate, jstIso, sleep } from './util.js';
import { buildBotSystemPrompt } from './botPrompt.js';

const DEPRECATED_MODELS = {
  'gemini-2.0-flash-lite': 1, 'gemini-2.0-flash': 1, 'gemini-1.5-flash': 1,
  'gemini-1.5-flash-latest': 1, 'gemini-1.5-pro': 1, 'gemini-1.0-pro': 1
};

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ---- 日次使用量 ----

export async function geminiUsageGet(env, today) {
  const row = await env.DB.prepare('SELECT Count FROM gemini_usage WHERE Date = ?').bind(today).first();
  return row ? (parseInt(row.Count, 10) || 0) : 0;
}

async function geminiUsageInc(env, today) {
  const row = await env.DB.prepare(
    'INSERT INTO gemini_usage (Date, Count) VALUES (?, 1) ON CONFLICT(Date) DO UPDATE SET Count = Count + 1 RETURNING Count'
  ).bind(today).first();
  return row ? row.Count : 1;
}

// ---- kv_cache(セッション単位の毎分制限・モデル一覧のキャッシュ) ----

async function cacheGet(env, key) {
  const row = await env.DB.prepare('SELECT V FROM kv_cache WHERE K = ? AND Exp > ?').bind(key, Math.floor(Date.now() / 1000)).first();
  return row ? row.V : null;
}

async function cachePut(env, key, value, ttlSec) {
  await env.DB.prepare('INSERT INTO kv_cache (K, V, Exp) VALUES (?, ?, ?) ON CONFLICT(K) DO UPDATE SET V = excluded.V, Exp = excluded.Exp')
    .bind(key, value, Math.floor(Date.now() / 1000) + ttlSec).run();
}

async function cacheIncr(env, key, ttlSec) {
  const row = await env.DB.prepare(
    'INSERT INTO kv_cache (K, V, Exp) VALUES (?, \'1\', ?) ON CONFLICT(K) DO UPDATE SET V = CAST(V AS INTEGER) + 1 RETURNING V'
  ).bind(key, Math.floor(Date.now() / 1000) + ttlSec).first();
  return row ? parseInt(row.V, 10) : 1;
}

export async function purgeExpiredCache(env) {
  await env.DB.prepare('DELETE FROM kv_cache WHERE Exp < ?').bind(Math.floor(Date.now() / 1000)).run();
}

// ---- 429 の解析 ----
// 「1分あたり(RPM)か / 1日あたり(RPD)か」「推奨再試行秒数」「詳細」を取り出す。

export function parseGemini429(bodyText) {
  const info = { scope: 'minute', retrySec: 0, detail: '' };
  let obj = null;
  try { obj = JSON.parse(bodyText); } catch (_) {}
  const err = obj && obj.error ? obj.error : null;
  if (err && err.message) info.detail = String(err.message);
  const details = (err && err.details) || [];
  for (const d of details) {
    const t = String((d && d['@type']) || '');
    if (t.indexOf('RetryInfo') >= 0 && d.retryDelay) {
      const sec = parseInt(String(d.retryDelay), 10);
      if (!isNaN(sec)) info.retrySec = Math.max(sec, 1);
    }
    if (t.indexOf('QuotaFailure') >= 0 && d.violations) {
      for (const v of d.violations) {
        const id = String((v && v.quotaId) || '') + ' ' + String((v && v.quotaMetric) || '');
        if (/per\s*day|PerDay/i.test(id)) info.scope = 'day';
      }
    }
  }
  if (info.scope === 'minute' && /per\s*day|daily|per day/i.test(info.detail)) info.scope = 'day';
  return info;
}

// ---- モデルの決定 ----

async function listGeminiModels(env, apiKey) {
  try {
    const cached = await cacheGet(env, 'gemini_models_cache');
    if (cached) { try { return JSON.parse(cached); } catch (_) {} }
    const res = await fetch(API_BASE + '/models?pageSize=200&key=' + encodeURIComponent(apiKey));
    if (!res.ok) return [];
    const data = await res.json();
    const models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
      .map(m => String(m.name || '').replace(/^models\//, ''));
    await cachePut(env, 'gemini_models_cache', JSON.stringify(models), 21600);
    return models;
  } catch (_) { return []; }
}

// 軽量・安価・新しいモデルを優先して 1 つ選ぶ。avoid は除外したい現行モデル。
export function pickBestGeminiModel(models, avoid) {
  if (!models || !models.length) return '';
  const usable = n => {
    n = n.toLowerCase();
    return n.indexOf('gemini') >= 0
      && n.indexOf('embedding') < 0 && n.indexOf('aqa') < 0 && n.indexOf('vision') < 0
      && n.indexOf('image') < 0 && n.indexOf('tts') < 0 && n.indexOf('audio') < 0
      && n.indexOf('preview') < 0 && n.indexOf('-exp') < 0 && n.indexOf('thinking') < 0
      && !DEPRECATED_MODELS[n];
  };
  const score = n => {
    n = n.toLowerCase();
    if (n.indexOf('flash-lite') >= 0) return 100;   // 最軽量・無料枠が一番広い
    if (n.indexOf('flash') >= 0) return 80;
    if (n.indexOf('pro') >= 0) return 40;
    return 10;
  };
  const ver = n => { const m = n.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const ranked = models.filter(usable).filter(n => n !== avoid).sort((a, b) => (score(b) - score(a)) || (ver(b) - ver(a)));
  return ranked.length ? ranked[0] : '';
}

async function resolveGeminiModel(env, apiKey) {
  const configured = ((await getConfig(env, 'gemini_model')) || '').trim();
  if (configured && !DEPRECATED_MODELS[configured]) return configured;
  const auto = pickBestGeminiModel(await listGeminiModels(env, apiKey), '');
  if (auto) { try { await setConfig(env, 'gemini_model', auto); } catch (_) {} return auto; }
  return GEMINI_MODEL;   // 最後の保険
}

// ---- 呼び出しの共有コア(意図解析プロキシ・文章生成の両方が使う) ----
// 成功: { success:true, data, model, usage, limit } / 失敗: { success:false, error, ... }
// opts: { token, systemPrompt, userText, wantJson }

export async function geminiInvoke(env, opts) {
  const apiKey = ((await getSecret(env, 'gemini_api_key')) || '').trim();
  if (!apiKey) return { success: false, error: 'gemini_key_not_configured' };

  // セッション単位の毎分レート制限(1 セッションが全体枠を使い切るのを防ぐ)
  const th = opts.token ? (await hmacHex(env, opts.token)).slice(0, 16) : 'anon';
  const minute = jstIso().slice(0, 16).replace(/[-T:]/g, '');
  const rlCount = await cacheIncr(env, 'gemini_rl_' + th + '_' + minute, 120);
  if (rlCount > 12) {
    return { success: false, error: 'RATE_LIMIT_MINUTE', scope: 'minute', retrySec: 30,
      detail: '短時間に送信が集中したため、このセッションを一時的に制限しました。' };
  }

  // 日次使用量チェック
  const today = jstDate();
  const usage = await geminiUsageGet(env, today);
  if (usage >= GEMINI_DAILY_LIMIT) {
    return { success: false, error: 'RATE_LIMIT_DAILY', scope: 'day', usage, limit: GEMINI_DAILY_LIMIT };
  }

  let model = await resolveGeminiModel(env, apiKey);
  const payload = { contents: [{ role: 'user', parts: [{ text: opts.userText }] }] };
  if (opts.wantJson) payload.generationConfig = { responseMimeType: 'application/json' };
  if (opts.systemPrompt) payload.systemInstruction = { parts: [{ text: opts.systemPrompt }] };

  const maxAttempts = 3;   // 過負荷再試行 + モデル再検出のための余裕
  let last429 = null;
  let rediscovered = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = API_BASE + '/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const code = res.status;
      if (code === 200) {
        const data = await res.json();
        const newUsage = await geminiUsageInc(env, today);
        return { success: true, data, model, usage: newUsage, limit: GEMINI_DAILY_LIMIT };
      }
      const errText = (await res.text()) || '';

      if (code === 429) {
        last429 = parseGemini429(errText);
        if (last429.scope !== 'day' && attempt < maxAttempts - 1) {
          await sleep(Math.min((last429.retrySec || 2) * 1000, 3000));
          continue;
        }
        if (last429.scope === 'day') {
          return { success: false, error: 'RATE_LIMIT_DAILY', scope: 'day', retrySec: last429.retrySec, detail: last429.detail.slice(0, 300) };
        }
        return { success: false, error: 'RATE_LIMIT_MINUTE', scope: 'minute', retrySec: last429.retrySec || 30, detail: last429.detail.slice(0, 300) };
      }

      const shortErr = errText.slice(0, 500);
      if (code === 400 && shortErr.indexOf('API_KEY_INVALID') >= 0) return { success: false, error: 'API_KEY_INVALID' };
      if (code === 403) return { success: false, error: 'API_FORBIDDEN', detail: shortErr };
      if (code === 404) {
        // モデル廃止/未対応 → 動的に別モデルを検出して 1 度だけ自動リトライ(自己修復)
        if (!rediscovered) {
          rediscovered = true;
          const alt = pickBestGeminiModel(await listGeminiModels(env, apiKey), model);
          if (alt && alt !== model) {
            model = alt;
            try { await setConfig(env, 'gemini_model', alt); } catch (_) {}
            continue;
          }
        }
        return { success: false, error: 'MODEL_NOT_FOUND', detail: 'model=' + model };
      }
      if (code === 500 || code === 502 || code === 503 || code === 504) {
        if (attempt < maxAttempts - 1) { await sleep(1500); continue; }
        return { success: false, error: 'MODEL_OVERLOADED', scope: 'minute', retrySec: 20, detail: shortErr.slice(0, 300) };
      }
      return { success: false, error: 'API_ERROR_' + code, detail: shortErr };
    } catch (e) {
      if (attempt < maxAttempts - 1) { await sleep(1500); continue; }
      return { success: false, error: 'NETWORK_ERROR', detail: String(e).slice(0, 200) };
    }
  }
  if (last429) return { success: false, error: 'RATE_LIMIT_MINUTE', scope: 'minute', retrySec: last429.retrySec || 30, detail: last429.detail.slice(0, 300) };
  return { success: false, error: 'NETWORK_ERROR' };
}

// 意図解析プロキシ(質問文 → 検索クエリ JSON)。本文の個人情報は送らない。
export async function handleGeminiProxy(env, body) {
  let message = body.message || '';
  if (!message) return { success: false, error: 'empty_message' };
  if (message.length > 2000) message = message.slice(0, 2000);   // 過大入力を切り詰め
  // システムプロンプトはサーバー側で固定生成(クライアント指定の prompt は信用しない)
  return geminiInvoke(env, { token: body.token, systemPrompt: buildBotSystemPrompt(), userText: message, wantJson: true });
}

// 文章生成(要約など)。クライアントが個人情報を除いた context(実験/イベント本文)を渡す。
export async function handleGeminiGenerate(env, body) {
  const apiKey = ((await getSecret(env, 'gemini_api_key')) || '').trim();
  if (!apiKey) return { success: false, error: 'gemini_key_not_configured' };

  const instruction = String(body.instruction || '').slice(0, 1000);
  const context = String(body.context || '').slice(0, 12000);   // コンテキスト上限(コスト・悪用対策)
  if (!context.trim()) return { success: false, error: 'empty_context' };

  const sys = 'あなたは大学のサイエンスコミュニケーターサークルの記録アシスタントです。'
    + '与えられた「資料」だけを根拠に、日本語で分かりやすく回答・要約してください。'
    + '資料に書かれていないことは推測せず、その旨を述べてください。'
    + '万一、個人名やメールアドレス等の個人情報が含まれていても、出力には含めないでください。'
    + '出力は簡潔に、必要に応じて箇条書きを使ってください(Markdown見出しは使わない)。';
  const userText = '【依頼】\n' + (instruction || 'この内容を要約してください。') + '\n\n【資料】\n' + context;

  const r = await geminiInvoke(env, { token: body.token, systemPrompt: sys, userText, wantJson: false });
  if (!r.success) return r;
  let text = '';
  try { text = (r.data.candidates[0].content.parts[0].text || '').trim(); } catch (_) { text = ''; }
  if (!text) return { success: false, error: 'EMPTY_RESPONSE' };
  return { success: true, text, usage: r.usage, limit: r.limit };
}
