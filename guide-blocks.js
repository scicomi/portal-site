/**
 * ガイド用の自作ブロック（Editor.js のブロックツールの規約に沿ったもの）。
 *   Callout   … 絵文字つきの囲み（補足・注意・禁止など）。アイコンをクリックすると切り替わる
 *   Toggle    … クリックで開閉するブロック（見出し＋本文）
 *   PageLink  … 別のガイドページへのカード型リンク
 *   FileBlock … 添付ファイル（資料・テンプレートなど）
 *
 * どれも Editor.js 本体(vendor/editorjs/)とは独立した、このリポジトリ自前のコード。
 * 設定は tools[名前].config で受け取る（getPages: () => ページ一覧 / upload: file => {url, name}）。
 */
(function (root) {
  'use strict';

  // 保存時に残してよいインライン書式（Editor.js の sanitizer 設定）
  const INLINE = { b: true, i: true, u: true, mark: { class: true }, code: { class: true }, a: { href: true, target: true, rel: true }, br: true };

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  const escText = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- Callout ----------
  // 囲みは「色つきの丸ポチ＋背景色」。色は丸ポチのクリック、またはブロックのメニューから選ぶ。
  const CALLOUT_COLORS = [
    { color: 'gray',   label: 'グレー', dot: '#9b9a97' },
    { color: 'blue',   label: '青',     dot: '#2f80ed' },
    { color: 'green',  label: '緑',     dot: '#27ae60' },
    { color: 'yellow', label: '黄',     dot: '#f2b01e' },
    { color: 'red',    label: '赤',     dot: '#e5484d' },
    { color: 'purple', label: '紫',     dot: '#8e6bd8' },
  ];
  // 旧データ（絵文字アイコン）の色への読み替え
  const LEGACY_ICON_COLOR = { '💡': 'blue', '✅': 'green', '⚠️': 'yellow', '🚫': 'red', '📌': 'purple', '❓': 'gray' };
  const colorOf = c => CALLOUT_COLORS.find(x => x.color === c) || CALLOUT_COLORS[1];
  const dotSvg = hex => '<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5" fill="' + hex + '"/></svg>';

  class Callout {
    static get toolbox() { return { title: '囲み（色つき）', icon: dotSvg('#2f80ed') }; }
    static get isReadOnlySupported() { return true; }
    static get enableLineBreaks() { return true; }
    static get sanitize() { return { color: false, icon: false, text: INLINE }; }
    constructor({ data, readOnly, block }) {
      const d = data || {};
      this.data = { color: d.color || LEGACY_ICON_COLOR[d.icon] || 'blue', text: d.text || '' };
      this.readOnly = readOnly;
      this.block = block;
    }
    render() {
      this.wrap = el('div', 'gd-callout gd-callout-' + colorOf(this.data.color).color);
      this.dotEl = el('button', 'gd-callout-dot');
      this.dotEl.type = 'button';
      this.dotEl.title = 'クリックで色を変える';
      this.dotEl.style.background = colorOf(this.data.color).dot;
      this.textEl = el('div', 'gd-callout-text', this.data.text);
      this.textEl.contentEditable = this.readOnly ? 'false' : 'true';
      this.textEl.dataset.placeholder = '内容を入力';
      if (!this.readOnly) {
        this.dotEl.addEventListener('click', () => {
          const i = CALLOUT_COLORS.findIndex(k => k.color === this.data.color);
          this.setColor(CALLOUT_COLORS[(i + 1) % CALLOUT_COLORS.length].color);
        });
      } else { this.dotEl.disabled = true; }
      this.wrap.append(this.dotEl, this.textEl);
      return this.wrap;
    }
    setColor(color) {
      this.data.color = color;
      const c = colorOf(color);
      this.dotEl.style.background = c.dot;
      this.wrap.className = 'gd-callout gd-callout-' + c.color;
      if (this.block && this.block.dispatchChange) this.block.dispatchChange();
    }
    renderSettings() {
      return CALLOUT_COLORS.map(c => ({ icon: dotSvg(c.dot), label: c.label, onActivate: () => this.setColor(c.color) }));
    }
    save() { return { color: this.data.color, text: this.textEl.innerHTML }; }
    validate(d) { return !!(d.text && d.text.replace(/<br\s*\/?>|&nbsp;|\s/g, '')); }
  }

  // ---------- Toggle ----------
  class Toggle {
    static get toolbox() { return { title: 'トグル（開閉）', icon: '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M7 5l6 5-6 5z" fill="currentColor"/></svg>' }; }
    static get isReadOnlySupported() { return true; }
    static get sanitize() { return { title: INLINE, text: INLINE }; }
    constructor({ data, readOnly }) {
      this.data = { title: (data && data.title) || '', text: (data && data.text) || '' };
      this.readOnly = readOnly;
    }
    render() {
      const open = !this.readOnly;     // 閲覧時は閉じておく。編集時は開いておく
      this.wrap = el('div', 'gd-tg' + (open ? ' open' : ''));
      const head = el('div', 'gd-tg-head');
      this.caret = el('button', 'gd-tg-caret', '▸');
      this.caret.type = 'button';
      this.caret.setAttribute('aria-expanded', String(open));
      this.titleEl = el('div', 'gd-tg-title', this.data.title);
      this.titleEl.contentEditable = this.readOnly ? 'false' : 'true';
      this.titleEl.dataset.placeholder = 'トグルの見出し';
      head.append(this.caret, this.titleEl);
      this.bodyEl = el('div', 'gd-tg-body', this.data.text);
      this.bodyEl.contentEditable = this.readOnly ? 'false' : 'true';
      this.bodyEl.dataset.placeholder = '中に隠す内容（Enter で改行）';
      const toggle = () => {
        const now = this.wrap.classList.toggle('open');
        this.caret.setAttribute('aria-expanded', String(now));
      };
      this.caret.addEventListener('click', toggle);
      if (this.readOnly) this.titleEl.addEventListener('click', toggle);
      // 本文の Enter は、新しいブロックではなく改行にする
      this.bodyEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); document.execCommand('insertLineBreak'); }
      });
      this.wrap.append(head, this.bodyEl);
      return this.wrap;
    }
    save() { return { title: this.titleEl.innerHTML, text: this.bodyEl.innerHTML }; }
    validate(d) { return !!(d.title && d.title.replace(/<br\s*\/?>|&nbsp;|\s/g, '')); }
  }

  // ---------- PageLink ----------
  // 別のガイドへのリンク。「〇〇ページへ ↗」の 1 行だけを出す（枠やカードは付けない）。
  // 最初だけ行き先を選ぶ。変えるときはブロックのメニュー（⋮⋮）の「リンク先を変える」。
  class PageLink {
    static get toolbox() { return { title: '別のガイドへのリンク', icon: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14L14 6M7.5 6H14v6.5"/></svg>' }; }
    static get isReadOnlySupported() { return true; }
    static get sanitize() { return { pageId: false }; }
    constructor({ data, readOnly, config, block }) {
      this.data = { pageId: (data && data.pageId) || '' };
      this.readOnly = readOnly;
      this.config = config || {};
      this.block = block;
    }
    pages() { return (this.config.getPages && this.config.getPages()) || []; }
    changed() { if (this.block && this.block.dispatchChange) this.block.dispatchChange(); }
    draw() {
      this.wrap.innerHTML = '';
      const page = this.data.pageId ? this.pages().find(x => x.ID === this.data.pageId) : null;
      if (page) {
        const a = el('a', 'gd-pagelink');
        a.href = 'guide.html?p=' + encodeURIComponent(page.ID);
        a.dataset.gdPage = page.ID;
        a.innerHTML = escText((page.Title || '無題') + 'ページへ') + '<span class="gd-pagelink-arrow" aria-hidden="true">↗</span>';
        this.wrap.append(a);
        return;
      }
      if (this.data.pageId) { this.wrap.append(el('span', 'gd-pagelink gd-pagelink-missing', 'リンク先のページが見つかりません')); return; }
      if (this.readOnly) return;
      const sel = el('select', 'gd-pl-select');
      sel.innerHTML = '<option value="">リンクするページを選ぶ</option>' +
        this.pages().map(p => '<option value="' + escText(p.ID) + '">' + escText(p.Title || '無題') + '</option>').join('');
      sel.addEventListener('change', () => { this.data.pageId = sel.value; this.draw(); this.changed(); });
      this.wrap.append(sel);
    }
    render() { this.wrap = el('div', 'gd-pl'); this.draw(); return this.wrap; }
    renderSettings() {
      if (this.readOnly) return [];
      return [{ icon: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 10h10M10 5v10"/></svg>', label: 'リンク先を変える', onActivate: () => { this.data.pageId = ''; this.draw(); this.changed(); } }];
    }
    save() { return { pageId: this.data.pageId }; }
    validate(d) { return !!d.pageId; }
  }

  // ---------- FileBlock ----------
  class FileBlock {
    static get toolbox() { return { title: 'ファイル（資料）', icon: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9l-5.5 5.5a3 3 0 01-4.2-4.2L11 4.6a2 2 0 013 3L8.5 13a1 1 0 01-1.5-1.5L12 6.5"/></svg>' }; }
    static get isReadOnlySupported() { return true; }
    static get sanitize() { return { url: false, name: false, size: false }; }
    constructor({ data, readOnly, config, block }) {
      this.data = { url: (data && data.url) || '', name: (data && data.name) || '', size: (data && data.size) || 0 };
      this.readOnly = readOnly;
      this.config = config || {};
      this.block = block;
    }
    sizeText() {
      const n = this.data.size;
      if (!n) return '';
      return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
    }
    draw() {
      this.wrap.innerHTML = '';
      if (this.data.url && /^https?:\/\//i.test(this.data.url)) {
        const a = el('a', 'gd-file');
        a.href = this.data.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.innerHTML = '<span class="gd-file-icon">▤</span><span class="gd-file-name">' + escText(this.data.name || 'ファイル') + '</span><span class="gd-file-size">' + escText(this.sizeText()) + '</span>';
        this.wrap.append(a);
        return;
      }
      if (this.readOnly) return;
      const btn = el('button', 'gd-file-pick', '📎 ファイルを選ぶ（PDF・Word・Excel・画像など）');
      btn.type = 'button';
      const input = el('input');
      input.type = 'file'; input.style.display = 'none';
      btn.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return;
        btn.disabled = true; btn.textContent = 'アップロード中…';
        try {
          const up = await this.config.upload(f);
          this.data = { url: up.url, name: f.name, size: f.size };
          this.draw();
          if (this.block && this.block.dispatchChange) this.block.dispatchChange();
        } catch (e) {
          btn.disabled = false; btn.textContent = '📎 ファイルを選ぶ';
          if (this.config.onError) this.config.onError(e);
        }
      });
      this.wrap.append(btn, input);
    }
    render() { this.wrap = el('div', 'gd-fileblock'); this.draw(); return this.wrap; }
    save() { return { url: this.data.url, name: this.data.name, size: this.data.size }; }
    validate(d) { return !!d.url; }
  }

  root.GuideBlocks = { Callout, Toggle, PageLink, FileBlock, COLORS: CALLOUT_COLORS };
})(window);
