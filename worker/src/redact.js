// 振り返りの本文を Gemini に送る前の、個人情報の置き換え(docs/14 の §4-3)。D1 も外部への送信も使わない。
//
// - メンバーの氏名: フルネーム(空白あり・なし)と、姓・名 + 敬称(「田中さん」「太郎くん」など)を 〈メンバー〉 にする
// - 姓だけ・名だけ(敬称なし)は置き換えない。普通の語を壊すため(「光」「愛」など)。つまり取りこぼしがある。
//   これは入力欄の「個人名を書かない」注意書きで補う(docs/13 で決定)
// - メールアドレス・URL・電話番号は 〈連絡先〉 にする
// - 置き換えた件数はどこにも残さない(件数も手がかりになり得るため)

export const MEMBER_MASK = '〈メンバー〉';
export const CONTACT_MASK = '〈連絡先〉';

const HONORIFICS = ['さん', 'サン', 'くん', 'クン', '君', 'ちゃん', 'チャン', '先輩', 'せんぱい', '先生', 'せんせい', '様', 'さま', '氏'];

// 空白で区切られていない名前は、この長さ以上のときだけ、敬称なしでも置き換える(短い名前は普通の語と重なりやすい)
const MIN_BARE_NAME_LEN = 3;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'、。」』）)]+/gi;
// 0 か +81 で始まり、区切り(- か空白)を挟んでもよい数字の並び。数字の数で電話番号かを確かめる(日付などを壊さないため)
const PHONE_RE = /(?<!\d)(?:\+81[-\s]?|0)\d{1,4}(?:[-\s]?\d{1,4}){1,2}(?!\d)/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 英字で始まる/終わる名前は、英単語の途中で当たらないように前後に英数字が無いことを求める
function guard(pattern, token) {
  const pre = /^[A-Za-z0-9]/.test(token) ? '(?<![A-Za-z0-9])' : '';
  const post = /[A-Za-z0-9]$/.test(token) ? '(?![A-Za-z0-9])' : '';
  return pre + pattern + post;
}

function normalize(s) {
  // 全角英数字・全角空白・半角カナを揃える(名前の一覧と本文で、書き方の違いをなくす)
  return String(s == null ? '' : s).normalize('NFKC');
}

// 名前の一覧から、置き換えの正規表現を 1 つ作る。長い候補を先に試す(「田中太郎」を「田中」より先に)
function buildNameRegex(names) {
  const items = new Map();   // 長さで並べるための見本の文字列 → 正規表現の断片
  const hon = '(?:' + HONORIFICS.map(escapeRe).join('|') + ')';
  for (const raw of names || []) {
    const name = normalize(raw).trim();
    if (!name) continue;
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      // フルネーム: 間の空白はあってもなくてもよい
      const full = parts.map(escapeRe).join('\\s*');
      items.set(parts.join(' '), guard(full, name));
    } else if (name.length >= MIN_BARE_NAME_LEN) {
      items.set(name, guard(escapeRe(name), name));
    }
    // 姓・名(または区切りの無い名前)+ 敬称
    for (const p of parts) {
      items.set(p + 'さん', guard(escapeRe(p), p) + hon);
    }
  }
  if (!items.size) return null;
  const sorted = [...items.entries()].sort((a, b) => b[0].length - a[0].length).map(e => e[1]);
  return new RegExp(sorted.join('|'), 'giu');
}

function maskContacts(text) {
  return text
    .replace(EMAIL_RE, CONTACT_MASK)
    .replace(URL_RE, CONTACT_MASK)
    .replace(PHONE_RE, m => {
      const digits = m.replace(/\D/g, '');
      const n = m.startsWith('+81') ? digits.length - 2 + 1 : digits.length;   // +81 は先頭の 0 に読み替えて数える
      return n >= 10 && n <= 11 ? CONTACT_MASK : m;
    });
}

// 名前の一覧を先に渡して、本文を置き換える関数を作る(1 回の要約で何十件も置き換えるので、正規表現は 1 回だけ作る)
export function createRedactor(names) {
  const nameRe = buildNameRegex(names);
  return function redact(text) {
    let s = normalize(text);
    s = maskContacts(s);   // メールアドレスの中の名前(tanaka@…)より先に、連絡先として丸ごと置き換える
    if (nameRe) s = s.replace(nameRe, MEMBER_MASK);
    return s;
  };
}

export function redactText(text, names) {
  return createRedactor(names)(text);
}
