/**
 * ガイドの目視確認の補助スクリプト（ブラウザの開発者ツールのコンソール、またはブラウザ自動操作の javascript_tool に貼って使う）。
 * 本番では使わない。ローカルの API につないだ guide.html（?api=http://127.0.0.1:8787）を、管理者でログインして開いた状態で実行する。
 *
 *   await guideQaCheck()  →  { roundTrip, contrast } を返す
 *
 * - roundTrip: 開いているページの本文を、画面から保存形式にした結果（editor.save）と、保存済みの本文（Body）が同じか。
 *              違えば、保存時に何かが消えている（改行・太字・リンクなど）。違うブロックの番号を返す。
 * - contrast:  画面にあるすべての文字（開いているメニュー・ツールバーを含む）の、文字色と背景色のコントラストが 3 未満のもの。
 *              ダークとライトの両方で実行する（ブラウザの配色の切り替えで）。メニューやツールバーは、開いた状態で実行しないと対象にならない。
 *              Editor.js のプラグインは固定の明るい色を持つので、新しいブロックやプラグインを足したときに特に確かめる。
 */
async function guideQaCheck() {
  const strip = b => (b || []).map(x => {
    const c = Object.assign({}, x); delete c.id;
    if (c.data && Array.isArray(c.data.blocks)) c.data = Object.assign({}, c.data, { blocks: strip(c.data.blocks) });
    return c;
  });
  const out = {};
  const page = gdCurrentId ? gdById(gdCurrentId) : null;
  if (page && gdEditor) {
    await gdEditor.isReady; await gdNestedIdle();
    const live = strip((await gdEditor.save()).blocks);
    const stored = strip(JSON.parse(page.Body || '{"blocks":[]}').blocks);
    const diff = [];
    for (let i = 0; i < Math.max(live.length, stored.length); i++) if (JSON.stringify(live[i]) !== JSON.stringify(stored[i])) diff.push(i);
    out.roundTrip = diff.length ? { differentBlocks: diff } : 'same';
  }
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const base = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255 };
  const bgOf = el => { while (el) { const c = parse(getComputedStyle(el).backgroundColor); if (c && c.a > 0.9) return c; el = el.parentElement; } return base; };
  const bad = [], seen = new Set();
  document.querySelectorAll('#gd-content *, .ce-popover *, .ce-inline-toolbar *, .ce-toolbar *, .tc-popover *, .gd-menu *, .gd-icon-menu *').forEach(el => {
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
    const fg = parse(getComputedStyle(el).color); if (!fg) return;
    const bg = bgOf(el);
    const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    if (ratio < 3) {
      const k = el.className + '|' + Math.round(ratio * 10);
      if (!seen.has(k)) { seen.add(k); bad.push({ cls: String(el.className).slice(0, 50), tag: el.tagName, text: (el.textContent || '').trim().slice(0, 15), ratio: Math.round(ratio * 10) / 10 }); }
    }
  });
  out.contrast = bad.length ? bad : 'ok';
  return out;
}
