// 🗨 Реплики — после поста отдельная модель (по умолчанию Аргон) пишет свои варианты реплик персонажей.
// Пост целиком пишет основная модель; здесь ничего не упрощается, только предлагается.
// Реплики в посте подчёркнуты пунктиром: тап → шторка с вариантами → выбранный встаёт в сообщение
// (и остаётся в истории, так что модель дальше тянется к этому голосу). Оригинал всегда можно вернуть.

const MODULE = 'repliky';
const VERSION = '0.1.0';
const STORE_KEY = 'repliky';
const STORE_MAX = 150;

const DEFAULTS = {
    enabled: true,
    auto: true,
    profile: '',
    effort: 'low',
    tokens: 6000,
    timeoutSec: 120,
    count: 3,
    ctxMsgs: 6,
    lorebook: 'Hedy Bucky Psyche',
    card: true,
    chars: {},
    aliases: '',
    note: '',
};
// пока персонажа никто не отметил — включён только Баки
const DEFAULT_ON = /bucky|баки/i;
const BUILTIN_ALIASES = [[/bucky/i, ['Баки', 'Бак', 'Джеймс', 'Барнс', 'Джимми']]];

const ctx = () => SillyTavern.getContext();
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cut = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const cutMid = (t, n) => { t = String(t ?? ''); if (t.length <= n) return t; const h = Math.floor(n / 2); return `${t.slice(0, h).trimEnd()} […] ${t.slice(-h).trimStart()}`; };
function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    return b === 1 ? one : many;
}

function toast(kind, msg, opts = {}) {
    try { window.toastr?.[kind]?.(msg, '🗨 Реплики', { timeOut: 3000, ...opts }); } catch { /* */ }
}

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE] || typeof ext[MODULE] !== 'object') ext[MODULE] = {};
    const s = ext[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = JSON.parse(JSON.stringify(v));
    if (!s.chars || typeof s.chars !== 'object') s.chars = {};
    return s;
}
const save = () => { try { ctx().saveSettingsDebounced(); } catch { /* */ } };

// ───────────── чат, персонажи ─────────────

const chat = () => ctx().chat || [];
const chatId = () => { const c = ctx(); return String(c.chatId || c.getCurrentChatId?.() || ''); };

function lastAiIndex() {
    const a = chat();
    for (let i = a.length - 1; i >= 0; i--) if (a[i] && !a[i].is_user && !a[i].is_system) return i;
    return -1;
}

function eligible(m) {
    return !!m && !m.is_user && !m.is_system && m.extra?.type !== 'comment' && String(m.mes || '').length > 40;
}

function members() {
    const c = ctx();
    const chars = c.characters || [];
    if (c.groupId) {
        const g = (c.groups || []).find(x => String(x.id) === String(c.groupId));
        return (g?.members || []).map(av => chars.find(x => x.avatar === av)).filter(Boolean);
    }
    if (c.characterId !== undefined && chars[c.characterId]) return [chars[c.characterId]];
    return [];
}

function isOn(name) {
    const s = settings();
    return s.chars[name] !== undefined ? !!s.chars[name] : DEFAULT_ON.test(name);
}

function parseAliases(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = line.split('=');
        if (m.length < 2) continue;
        const card = m[0].trim();
        if (card) out[card] = m.slice(1).join('=').split(',').map(x => x.trim()).filter(Boolean);
    }
    return out;
}

function aliasesOf(name) {
    const ext = ctx().extensionSettings || {};
    const set = new Set([name, String(name).split(/\s+/)[0]]);
    for (const t of [ext.wardrobe?.aliases, ext.life?.aliases, settings().aliases]) (parseAliases(t)[name] || []).forEach(a => set.add(a));
    for (const [re, list] of BUILTIN_ALIASES) if (re.test(name)) list.forEach(a => set.add(a));
    return [...set].filter(Boolean);
}

function targets() {
    const user = ctx().name1 || '';
    return members().filter(ch => ch.name && ch.name !== user && isOn(ch.name)).map(ch => ({ name: ch.name, card: ch, aliases: aliasesOf(ch.name) }));
}

// ───────────── хранилище: в метаданных чата, ключ — время сообщения + свайп ─────────────

function store() {
    const md = ctx().chatMetadata;
    if (!md) return {};
    if (!md[STORE_KEY] || typeof md[STORE_KEY] !== 'object') md[STORE_KEY] = {};
    return md[STORE_KEY];
}
function keyOf(m, i) { return `${m?.send_date || `#${i}`}|${m?.swipe_id ?? 0}`; }
function recOf(i) { const m = chat()[i]; return m ? store()[keyOf(m, i)] || null : null; }
function saveMeta() { try { ctx().saveMetadataDebounced?.(); } catch { /* */ } }
function trimStore() {
    const st = store();
    const keys = Object.keys(st);
    if (keys.length <= STORE_MAX) return;
    keys.sort((a, b) => (st[a]?.at || 0) - (st[b]?.at || 0)).slice(0, keys.length - STORE_MAX).forEach(k => delete st[k]);
}

// ───────────── текст ─────────────

const BLOCK_TAGS = 'think|thinking|details|art|diary|matrix|preg|compass|horae|horaeevent|hud|tracker|style|script|summary';

/** Пост без плашек, тегов и картинок — проза остаётся символ в символ. */
function plain(mes) {
    let t = String(mes || '');
    t = t.replace(new RegExp(`<(${BLOCK_TAGS})\\b[\\s\\S]*?<\\/\\1>`, 'gi'), '\n');
    t = t.replace(/<div\b[^>]*data-gc[\s\S]*?<\/div>/gi, '\n');
    t = t.replace(/<!--[\s\S]*?-->/g, '');
    t = t.replace(/<img\b[^>]*>/gi, '');
    t = t.replace(/<[^>]+>/g, '');
    return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Тот же текст той же длины, но плашки, теги и картинки забиты нулями — чтобы искать реплики только в прозе. */
function mask(mes) {
    const z = (x) => '\u0000'.repeat(x.length);
    let t = String(mes || '');
    t = t.replace(new RegExp(`<(${BLOCK_TAGS})\\b[\\s\\S]*?<\\/\\1>`, 'gi'), z);
    t = t.replace(/<div\b[^>]*data-gc[\s\S]*?<\/div>/gi, z);
    t = t.replace(/<!--[\s\S]*?-->/g, z);
    t = t.replace(/<[^>]+>/g, z);
    return t;
}

const cleanLine = (t) => String(t ?? '').replace(/^[\s—–\-«"„“]+/, '').replace(/[»"”\s]+$/, '').trim();
const mdStrip = (t) => String(t ?? '').replace(/\*\*|__|~~|[*_`]/g, '');
const normWs = (t) => String(t ?? '').replace(/[\s ]+/g, ' ').trim();
const escRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function nthIndex(hay, needle, n) {
    let pos = -1;
    for (let k = 0; k <= n; k++) { pos = hay.indexOf(needle, pos + 1); if (pos < 0) return -1; }
    return pos;
}
function countBefore(hay, needle, pos) {
    let c = 0, p = -1;
    while ((p = hay.indexOf(needle, p + 1)) >= 0 && p < pos) c++;
    return c;
}

/** Найти реплику в сыром тексте: сначала точно, потом без учёта пробелов. → {pos, text} */
function locate(mes, needle, from = 0) {
    if (!needle) return null;
    let pos = mes.indexOf(needle, from);
    if (pos < 0 && from > 0) pos = mes.indexOf(needle);
    if (pos >= 0) return { pos, text: needle };
    const re = new RegExp(escRe(normWs(needle)).replace(/ /g, '[\\s\\u00a0]+'), 'g');
    re.lastIndex = from;
    let m = re.exec(mes);
    if (!m && from > 0) { re.lastIndex = 0; m = re.exec(mes); }
    return m ? { pos: m.index, text: m[0] } : null;
}

/** Где реплика сейчас: по сохранённой позиции, по номеру вхождения, по первому вхождению. */
function findItem(mes, it) {
    const t = mask(mes);
    if (Number.isInteger(it.pos) && t.substr(it.pos, it.cur.length) === it.cur) return it.pos;
    const p = nthIndex(t, it.cur, it.occ || 0);
    return p >= 0 ? p : t.indexOf(it.cur);
}

function properNames() {
    const set = new Set();
    const c = ctx();
    if (c.name1) set.add(c.name1.split(/\s+/)[0]);
    members().forEach(ch => aliasesOf(ch.name).forEach(a => set.add(a.split(/\s+/)[0])));
    for (const t of [c.extensionSettings?.wardrobe?.aliases, c.extensionSettings?.life?.aliases]) Object.entries(parseAliases(t)).forEach(([k, v]) => [k, ...v].forEach(a => set.add(a.split(/\s+/)[0])));
    return set;
}

/** Подогнать вариант под место: концовка (запятая перед словами автора) и регистр первой буквы. */
function fit(cur, alt) {
    let a = cleanLine(alt);
    if (!a) return a;
    const endCur = (cur.match(/[.,!?…:;]+$/) || [''])[0];
    const endAlt = (a.match(/[.,!?…:;]+$/) || [''])[0];
    if (endCur.endsWith(',')) {
        if (!/[?!…]$/.test(endAlt)) a = a.replace(/[.,:;]+$/, '') + ',';
    } else if (endCur) {
        if (endAlt.endsWith(',') || endAlt.endsWith(';')) a = a.replace(/[,;]+$/, '') + '.';
        else if (!endAlt) a += /[?!…]/.test(endCur) ? endCur.slice(-1) : '.';
    }
    const c0 = cur.charAt(0), a0 = a.charAt(0);
    const word = (a.match(/^[\p{L}-]+/u) || [''])[0];
    if (c0 && c0 === c0.toLowerCase() && c0 !== c0.toUpperCase() && a0 !== a0.toLowerCase() && !properNames().has(word)) a = a0.toLowerCase() + a.slice(1);
    else if (c0 && c0 !== c0.toLowerCase() && a0 && a0 === a0.toLowerCase() && a0 !== a0.toUpperCase()) a = a0.toUpperCase() + a.slice(1);
    return a;
}

// ───────────── что знает модель ─────────────

async function loadBook(name) {
    if (!name) return null;
    const c = ctx();
    try { if (typeof c.loadWorldInfo === 'function') return await c.loadWorldInfo(name); } catch { /* */ }
    try { const wi = await import('../../../world-info.js'); return await wi.loadWorldInfo(name); } catch (e) { console.warn('[Реплики] лорбук', e); }
    return null;
}

/** Записи со ★ (ядро, голос) этого персонажа: по фильтру карточки, иначе по имени в названии. */
function voiceEntries(book, t) {
    const list = Object.values(book?.entries || {}).filter(e => e && !e.disable && /★/.test(e.comment || ''));
    const out = [];
    for (const e of list) {
        const names = e.characterFilter?.names || [];
        const byFilter = names.length && !e.characterFilter?.isExclude && names.includes(t.name);
        const byName = !names.length && t.aliases.some(a => a.length > 2 && (e.comment || '').toLowerCase().includes(a.toLowerCase()));
        if (byFilter || byName) out.push(e);
    }
    // голос — последним, он важнее всего
    return out.sort((a, b) => (/голос/i.test(a.comment) ? 1 : 0) - (/голос/i.test(b.comment) ? 1 : 0)).map(e => String(e.content || '').trim()).filter(Boolean);
}

async function charsBlock(list) {
    const s = settings();
    const book = await loadBook(s.lorebook);
    return list.map(t => {
        const d = t.card.data || {};
        const bits = [`### ${t.name}${t.aliases.length > 1 ? ` (в тексте: ${t.aliases.filter(a => a !== t.name).join(', ')})` : ''}`];
        if (s.card) {
            const desc = String(t.card.description || d.description || '').trim();
            const pers = String(t.card.personality || d.personality || '').trim();
            if (desc) bits.push(`[Карточка]\n${cut(desc, 1800)}`);
            if (pers) bits.push(`[Личность]\n${cut(pers, 800)}`);
        }
        const v = book ? voiceEntries(book, t) : [];
        if (v.length) bits.push(`[Ядро и голос]\n${v.join('\n\n')}`);
        return bits.join('\n');
    }).join('\n\n');
}

function recentBlock(i, n) {
    const out = [];
    const a = chat();
    for (let k = i - 1; k >= 0 && out.length < n; k--) {
        const m = a[k];
        if (!m || m.is_system || m.extra?.type === 'comment') continue;
        const t = plain(m.mes);
        if (t) out.unshift(`${m.name || (m.is_user ? ctx().name1 : '?')}: ${cutMid(t, 1400)}`);
    }
    return out.join('\n\n');
}

function rules(n, list) {
    const s = settings();
    const U = ctx().name1 || 'игрок';
    const names = list.map(t => t.aliases.join(' / ')).join('; ');
    return `Ты — сценарист реплик для ролевой истории на русском. Тебе дают готовый пост. Найди в нём прямую речь указанных персонажей и к каждой реплике придумай ${n} ${plural(n, 'свой вариант', 'своих варианта', 'своих вариантов')} — так, как этот человек мог бы сказать в этот момент.

Что искать:
- Только прямую речь этих персонажей: ${names}. Кто говорит — понимай по тексту (слова автора, обращения, смысл). Реплики других людей и игрока (${U}) не трогай. Мысли, внутренний голос, тексты сообщений и записок не трогай.
- orig — точная копия реплики из поста, символ в символ: без начального тире и без слов автора. Если реплика разорвана словами автора («— Ешь, — буркнул он. — Двоих кормишь.»), каждый кусок — отдельный пункт: «Ешь,» и «Двоих кормишь.».
- Порядок — как в посте.

Какими быть вариантам:
- Это НЕ перефразирование. Каждый вариант — своя реплика, другими словами и с другого захода, но в том же месте сцены: делает то же самое (шутка остаётся шуткой, уход от ответа — уходом, признание — признанием, приказ — приказом) и обращена к тому же человеку. Так текст вокруг — реакции, ответы, слова автора — остаётся верным.
- Голос — строго по ядру и правилам голоса персонажа. Образцы фраз там только для того, чтобы услышать интонацию: не повторяй их и не перекраивай.
- Живо, в характере, с его словечками и юмором; мат — если он в его голосе и к месту. Не смягчай и не выглаживай, без пафоса, красивостей и терапевтического языка.
- Варианты разные между собой: например, один короче и суше, один смешнее или наглее, один неожиданный, но всё равно его.
- Длина — примерно как у оригинала, можно короче. Если оригинал кончается запятой (дальше слова автора) — вариант тоже кончается запятой, вопросом или восклицанием. Если оригинал начинается со строчной — вариант тоже.
- Не повторяй его реплики из недавних сообщений.
- does — 2–6 слов: что реплика делает в сцене.${s.note?.trim() ? `\n\nДополнительно от игрока:\n${s.note.trim()}` : ''}`;
}

function sysAll(n, list) {
    return `${rules(n, list)}

Ответ — только JSON, без пояснений и без markdown:
{"lines":[{"who":"имя","orig":"точный текст реплики","does":"что делает","alts":[${Array.from({ length: n }, (_, k) => `"вариант ${k + 1}"`).join(',')}]}]}
Если реплик этих персонажей в посте нет — {"lines":[]}.`;
}

function sysOne(n, list) {
    return `${rules(n, list)}

Сейчас нужна ОДНА реплика: дай ещё ${n} ${plural(n, 'новый вариант', 'новых варианта', 'новых вариантов')}, не похожих на уже предложенные.
Ответ — только JSON: {"alts":[${Array.from({ length: n }, (_, k) => `"вариант ${k + 1}"`).join(',')}]}`;
}

// ───────────── запрос к модели ─────────────

function profiles() { return ctx().extensionSettings?.connectionManager?.profiles || []; }
function pickProfile() {
    const s = settings();
    const list = profiles();
    let p = list.find(x => x.name === s.profile) || list.find(x => x.id === s.profile);
    if (!p && !s.profile) {
        p = list.find(x => /argon|аргон/i.test(x.name || ''));
        if (p) { s.profile = p.name; save(); }
    }
    return p || null;
}

async function ask(messages) {
    const c = ctx();
    const s = settings();
    if (!c.ConnectionManagerRequestService?.sendRequest) throw new Error('в таверне нет Connection Manager');
    const p = pickProfile();
    if (!p) throw new Error('выбери профиль модели: Расширения → Реплики');
    const override = s.effort ? { reasoning_effort: s.effort } : {};
    const r = await Promise.race([
        c.ConnectionManagerRequestService.sendRequest(p.id, messages, Number(s.tokens) || 6000, { stream: false, extractData: true, includePreset: false, includeInstruct: false }, override),
        new Promise((_, rej) => setTimeout(() => rej(new Error('модель не ответила вовремя')), (Number(s.timeoutSec) || 120) * 1000)),
    ]);
    const text = typeof r === 'string' ? r : (r?.content ?? r?.choices?.[0]?.message?.content ?? '');
    if (!String(text).trim()) throw new Error('пустой ответ (возможно, фильтр модели)');
    return String(text);
}

function parseJson(text) {
    let t = String(text).replace(/```(?:json)?/gi, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('в ответе нет JSON');
    t = t.slice(a, b + 1);
    try { return JSON.parse(t); } catch { /* */ }
    return JSON.parse(t.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
}

// ───────────── генерация ─────────────

const busy = new Map(); // key → 'run' | 'err:…'

function postMentions(mes, list, author) {
    if (list.some(t => t.name === author)) return true;
    const low = String(mes).toLowerCase();
    return list.some(t => t.aliases.some(a => a.length > 2 && low.includes(a.toLowerCase())));
}

async function run(i, { manual = false } = {}) {
    const s = settings();
    if (!s.enabled && !manual) return;
    const m0 = chat()[i];
    if (!eligible(m0)) { if (manual) toast('info', 'В этом сообщении нечего разбирать'); return; }
    const key = keyOf(m0, i);
    if (busy.get(key) === 'run') return;
    const list = targets();
    if (!list.length) { if (manual) toast('info', 'Не выбран ни один персонаж: Расширения → Реплики'); return; }
    if (!manual && !postMentions(m0.mes, list, m0.name)) return;
    const cid = chatId();
    busy.set(key, 'run');
    paintSoon(i, 0);
    try {
        const n = Math.max(1, Math.min(6, Number(s.count) || 3));
        const user = `ПЕРСОНАЖИ (для них пишем реплики):\n${await charsBlock(list)}\n\nНЕДАВНЕЕ (контекст, не править):\n${recentBlock(i, Number(s.ctxMsgs) || 6) || '—'}\n\nПОСТ (ищи реплики здесь):\n${plain(m0.mes)}`;
        const raw = await ask([{ role: 'system', content: sysAll(n, list) }, { role: 'user', content: user }]);
        if (chatId() !== cid) return;
        const json = parseJson(raw);
        const m = chat()[i];
        if (!m || keyOf(m, i) !== key) return;
        const items = validate(m.mes, json?.lines || [], n, list);
        store()[key] = { at: Date.now(), items };
        trimStore();
        saveMeta();
        busy.delete(key);
        if (!items.length && manual) toast('info', 'Реплик выбранных персонажей в посте не нашлось');
    } catch (e) {
        console.warn('[Реплики]', e);
        busy.set(key, `err:${e?.message || e}`);
        if (manual) toast('warning', esc(e?.message || e));
    } finally {
        if (busy.get(key) === 'run') busy.delete(key);
        paintSoon(i, 0);
    }
}

function whoOk(who, list) {
    const w = String(who || '').trim().toLowerCase();
    if (!w || !list?.length) return true;
    const first = w.split(/\s+/)[0];
    return list.some(t => t.aliases.some(a => { const x = a.toLowerCase(); return x === w || x.split(/\s+/)[0] === first || w.includes(x); }));
}

function validate(mes, lines, n, list = null) {
    const items = [];
    const taken = [];
    let cursor = 0;
    const text = mask(mes);
    for (const ln of Array.isArray(lines) ? lines : []) {
        const orig = cleanLine(ln?.orig);
        if (!orig || orig.length < 2) continue;
        if (!whoOk(ln?.who, list)) continue;
        const hit = locate(text, orig, cursor);
        if (!hit) continue;
        const end = hit.pos + hit.text.length;
        if (taken.some(([a, b]) => hit.pos < b && end > a)) continue;
        const seen = new Set([normWs(hit.text).toLowerCase()]);
        const alts = [];
        for (const a of Array.isArray(ln?.alts) ? ln.alts : []) {
            const v = cleanLine(a);
            const k = normWs(v).toLowerCase();
            if (!v || seen.has(k)) continue;
            seen.add(k);
            alts.push(v);
            if (alts.length >= n + 3) break;
        }
        if (!alts.length) continue;
        taken.push([hit.pos, end]);
        cursor = end;
        items.push({ who: String(ln?.who || '').trim(), does: String(ln?.does || '').trim(), orig: hit.text, cur: hit.text, pos: hit.pos, occ: countBefore(text, hit.text, hit.pos), alts });
    }
    return items.sort((a, b) => a.pos - b.pos);
}

async function moreFor(i, idx) {
    const m = chat()[i];
    const rec = recOf(i);
    const it = rec?.items?.[idx];
    if (!m || !it) return;
    const list = targets();
    const t = list.find(x => x.name === it.who || x.aliases.some(a => a.toLowerCase() === it.who.toLowerCase())) || list[0];
    if (!t) { toast('info', 'Не выбран ни один персонаж'); return; }
    const s = settings();
    const n = Math.max(1, Math.min(6, Number(s.count) || 3));
    const user = `ПЕРСОНАЖ:\n${await charsBlock([t])}\n\nНЕДАВНЕЕ (контекст):\n${recentBlock(i, 3) || '—'}\n\nПОСТ:\n${plain(m.mes)}\n\nРЕПЛИКА: «${it.cur}»${it.cur !== it.orig ? ` (в оригинале было: «${it.orig}»)` : ''}${it.does ? `\nЧто делает: ${it.does}` : ''}\nУЖЕ ПРЕДЛАГАЛИ (не повторять):\n${it.alts.map(a => `- ${a}`).join('\n')}`;
    const raw = await ask([{ role: 'system', content: sysOne(n, [t]) }, { role: 'user', content: user }]);
    const json = parseJson(raw);
    const seen = new Set([it.orig, it.cur, ...it.alts].map(x => normWs(x).toLowerCase()));
    let added = 0;
    for (const a of json?.alts || []) {
        const v = cleanLine(a);
        const k = normWs(v).toLowerCase();
        if (!v || seen.has(k)) continue;
        seen.add(k);
        it.alts.push(v);
        added++;
    }
    if (it.alts.length > 15) it.alts.splice(0, it.alts.length - 15);
    saveMeta();
    return added;
}

// ───────────── замена реплики ─────────────

async function apply(i, idx, text, { dom = null } = {}) {
    const c = ctx();
    const m = chat()[i];
    const rec = recOf(i);
    const it = rec?.items?.[idx];
    if (!m || !it) return false;
    const pos = findItem(m.mes, it);
    if (pos < 0) { toast('warning', 'Реплику в сообщении уже поправили руками — не нашла её'); return false; }
    const next = text === it.orig ? it.orig : fit(it.orig, text);
    if (!next || next === it.cur) return true;
    const oldMes = m.mes;
    const delta = next.length - it.cur.length;
    m.mes = oldMes.slice(0, pos) + next + oldMes.slice(pos + it.cur.length);
    const sw = m.swipe_id ?? 0;
    if (Array.isArray(m.swipes) && m.swipes[sw] !== undefined) m.swipes[sw] = m.mes;
    // свой ключ хранилища не меняется (время + свайп), позиции остальных реплик сдвигаем
    for (const [k, o] of rec.items.entries()) {
        if (k === idx) continue;
        if (Number.isInteger(o.pos) && o.pos > pos) o.pos += delta;
    }
    const t = mask(m.mes);
    for (const [k, o] of rec.items.entries()) if (k !== idx && Number.isInteger(o.pos) && t.substr(o.pos, o.cur.length) === o.cur) o.occ = countBefore(t, o.cur, o.pos);
    it.cur = next;
    it.pos = pos;
    it.occ = countBefore(t, next, pos);
    // Life держит свои записи по тексту сообщения — переносим
    try { globalThis.LifeBridge?.api?.rekeyMessage?.(i, oldMes); } catch { /* */ }
    saveMeta();
    try { await c.saveChat(); } catch (e) { console.warn('[Реплики] сохранение', e); }
    const span = dom || document.querySelector(`#chat .mes[mesid="${i}"] .rp-line[data-rp-i="${idx}"]`);
    if (span && span.isConnected) {
        span.textContent = mdStrip(next);
        span.classList.toggle('changed', next !== it.orig);
        span.classList.add('flash');
        setTimeout(() => span.classList.remove('flash'), 900);
    } else {
        try {
            const upd = c.updateMessageBlock || (await import('../../../../script.js')).updateMessageBlock;
            upd?.(i, m);
            await c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, i);
        } catch (e) { console.warn('[Реплики] перерисовка', e); }
        paintSoon(i, 300);
    }
    return true;
}

// ───────────── в чате: пунктир и плашка ─────────────

const SKIP_SEL = 'details, .gca, .gc-mx, .gc-diary, .gc-preg, .cmp, .rp-chip, script, style, code, pre, [data-gc], .lf-detail, img';

function textMap(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest(SKIP_SEL) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    let str = '';
    const map = [];
    let space = true;
    for (const node of nodes) {
        const t = node.nodeValue;
        for (let k = 0; k < t.length; k++) {
            const ch = t[k];
            if (/[\s ]/.test(ch)) { if (!space) { str += ' '; map.push([node, k]); space = true; } }
            else { str += ch; map.push([node, k]); space = false; }
        }
    }
    return { str, map };
}

function wrap(root, needle, from, attrs) {
    const { str, map } = textMap(root);
    const q = normWs(mdStrip(needle));
    if (!q) return -1;
    // обёртка не меняет текст, так что индексы между репликами сохраняются; уже обёрнутое пропускаем
    const inLine = (k) => !!map[k][0].parentElement?.closest('.rp-line');
    let at = -1;
    for (const start of [from, 0]) {
        let p = str.indexOf(q, start);
        while (p >= 0 && (inLine(p) || inLine(p + q.length - 1))) p = str.indexOf(q, p + 1);
        if (p >= 0) { at = p; break; }
    }
    if (at < 0) return -1;
    const [n1, o1] = map[at];
    const [n2, o2] = map[at + q.length - 1];
    const range = document.createRange();
    range.setStart(n1, o1);
    range.setEnd(n2, o2 + 1);
    const span = document.createElement('span');
    span.className = 'rp-line';
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    try { span.appendChild(range.extractContents()); range.insertNode(span); } catch (e) { console.warn('[Реплики] обёртка', e); return -1; }
    return at;
}

function unwrapAll(root) {
    root.querySelectorAll('.rp-line').forEach(sp => { sp.replaceWith(...sp.childNodes); });
    root.normalize();
}

function chipHtml(i) {
    const m = chat()[i];
    if (!m) return '';
    const key = keyOf(m, i);
    const st = busy.get(key);
    const rec = recOf(i);
    if (st === 'run') return `<span class="rp-spin"></span>${/argon|аргон/i.test(settings().profile || '') ? 'Аргон пишет' : 'Пишу'} варианты реплик…`;
    if (st?.startsWith('err:')) return `⚠ Варианты не вышли: ${esc(cut(st.slice(4), 80))} · <b>↻ ещё раз</b>`;
    if (rec?.items?.length) return `🗨 Варианты реплик · ${rec.items.length}`;
    if (rec) return '🗨 Реплик для вариантов не нашлось · <b>↻</b>';
    return '🗨 Варианты реплик';
}

function paint(i) {
    const s = settings();
    const mesEl = document.querySelector(`#chat .mes[mesid="${i}"]`);
    const text = mesEl?.querySelector('.mes_text');
    if (!text) return;
    const m = chat()[i];
    const on = s.enabled && eligible(m);
    const rec = on ? recOf(i) : null;
    const key = m ? keyOf(m, i) : '';
    // пунктир
    const items = rec?.items || [];
    const have = [...text.querySelectorAll('.rp-line')];
    const want = painted.get(i);
    const ok = have.length === (want?.key === key ? want.n : items.length)
        && have.every(sp => sp.dataset.rpKey === key && normWs(sp.textContent) === normWs(mdStrip(items[Number(sp.dataset.rpI)]?.cur)));
    if (!ok) {
        if (have.length) unwrapAll(text);
        let from = 0;
        items.forEach((it, idx) => {
            if (findItem(m.mes, it) < 0) return;
            const at = wrap(text, it.cur, from, { 'data-rp-key': key, 'data-rp-i': String(idx) });
            if (at >= 0) from = at + normWs(mdStrip(it.cur)).length;
        });
        text.querySelectorAll('.rp-line').forEach(sp => { const it = items[Number(sp.dataset.rpI)]; if (it) sp.classList.toggle('changed', it.cur !== it.orig); });
        painted.set(i, { key, n: text.querySelectorAll('.rp-line').length });
    }
    // плашка: у последнего поста всегда, у старых — только если есть варианты или идёт работа
    const block = text.parentElement;
    let chip = block?.querySelector(':scope > .rp-chip');
    const showChip = on && (i === lastAiIndex() || rec?.items?.length || busy.has(key));
    if (!showChip) { chip?.remove(); return; }
    if (!chip) {
        chip = document.createElement('div');
        chip.className = 'rp-chip';
        text.after(chip);
    }
    chip.dataset.mes = String(i);
    chip.classList.toggle('busy', busy.get(key) === 'run');
    chip.classList.toggle('err', !!busy.get(key)?.startsWith('err:'));
    const html = chipHtml(i);
    if (chip.innerHTML !== html) chip.innerHTML = html;
}

const paintTimers = new Map();
const painted = new Map(); // i → { key, n } — сколько реплик удалось подчеркнуть в прошлый раз
function paintSoon(i, ms = 250) {
    clearTimeout(paintTimers.get(i));
    paintTimers.set(i, setTimeout(() => { paintTimers.delete(i); try { paint(i); } catch (e) { console.warn('[Реплики] отрисовка', e); } }, ms));
}
function paintAll() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => { const i = Number(el.getAttribute('mesid')); if (Number.isFinite(i)) paintSoon(i, 50); });
}

// чужие скрипты (артефакты, компас, дневник) пересобирают текст сообщения — пунктир возвращаем
let observer = null;
function watchChat() {
    const host = document.getElementById('chat');
    if (!host || observer) return !!host;
    observer = new MutationObserver((muts) => {
        const ids = new Set();
        for (const mu of muts) {
            const el = mu.target?.nodeType === 1 ? mu.target : mu.target?.parentElement;
            if (!el || el.closest?.('.rp-chip') || el.closest?.('.rp-line')) continue;
            const mes = el.closest?.('.mes[mesid]');
            if (mes) ids.add(Number(mes.getAttribute('mesid')));
        }
        for (const i of ids) {
            const rec = recOf(i);
            if (!rec?.items?.length) continue;
            const t = document.querySelector(`#chat .mes[mesid="${i}"] .mes_text`);
            const was = painted.get(i)?.n ?? rec.items.length;
            if (t && t.querySelectorAll('.rp-line').length < was) paintSoon(i, 400);
        }
    });
    observer.observe(host, { childList: true, subtree: true });
    return true;
}

// ───────────── шторка ─────────────

let sheet = null; // { i, idx|null }

function closeSheet() {
    sheet = null;
    const h = document.getElementById('rp-sheet');
    if (!h) return;
    h.classList.remove('on');
    setTimeout(() => h.remove(), 220);
}

const bare = (t) => normWs(mdStrip(t)).replace(/[.,!?…:;]+$/, '').toLowerCase();

function optionHtml(it, idx, text, label = '') {
    const cur = bare(it.cur) === bare(text);
    const shown = text === it.orig ? text : fit(it.orig, text);
    return `<button class="rp-opt${cur ? ' cur' : ''}" data-rp="pick" data-i="${idx}" data-t="${esc(text)}">${label ? `<small>${esc(label)}</small>` : ''}<span>${esc(mdStrip(shown))}</span>${cur ? '<em>✓</em>' : ''}</button>`;
}

function lineHtml(it, idx, full) {
    const opts = [
        it.cur !== it.orig ? optionHtml(it, idx, it.orig, 'оригинал') : '',
        ...it.alts.map(a => optionHtml(it, idx, a)),
    ].join('');
    return `<div class="rp-line-card${full ? ' full' : ''}">
        <div class="rp-line-head"><b>${esc(it.who || 'Реплика')}</b>${it.does ? `<span>${esc(it.does)}</span>` : ''}</div>
        <div class="rp-now">«${esc(mdStrip(it.cur))}»${it.cur !== it.orig ? '<i>изменена</i>' : ''}</div>
        <div class="rp-opts">${opts}</div>
        <button class="rp-more" data-rp="more" data-i="${idx}">↻ Ещё варианты</button>
    </div>`;
}

function renderSheet() {
    if (!sheet) return;
    const rec = recOf(sheet.i);
    if (!rec?.items?.length) { closeSheet(); return; }
    let h = document.getElementById('rp-sheet');
    if (!h) {
        h = document.createElement('div');
        h.id = 'rp-sheet';
        h.innerHTML = '<div class="rp-back" data-rp="close"></div><div class="rp-panel"><div class="rp-grab"></div><div class="rp-body"></div></div>';
        document.body.appendChild(h);
        h.addEventListener('click', onSheetClick);
        requestAnimationFrame(() => h.classList.add('on'));
    }
    const one = Number.isInteger(sheet.idx) && rec.items[sheet.idx];
    const body = h.querySelector('.rp-body');
    const top = body.scrollTop;
    body.innerHTML = one
        ? `${lineHtml(rec.items[sheet.idx], sheet.idx, true)}
           <div class="rp-foot">${rec.items.length > 1 ? `<button class="rp-link" data-rp="all">Все реплики поста · ${rec.items.length}</button>` : ''}<button class="rp-link" data-rp="close">Закрыть</button></div>`
        : `<div class="rp-title">Реплики поста</div>${rec.items.map((it, k) => lineHtml(it, k, false)).join('')}
           <div class="rp-foot"><button class="rp-link" data-rp="regen">↻ Разобрать пост заново</button><button class="rp-link" data-rp="close">Закрыть</button></div>`;
    body.scrollTop = top;
}

function openSheet(i, idx = null) {
    sheet = { i, idx };
    renderSheet();
}

async function onSheetClick(ev) {
    const el = ev.target.closest('[data-rp]');
    if (!el || !sheet) return;
    const act = el.dataset.rp;
    const i = sheet.i;
    if (act === 'close') return closeSheet();
    if (act === 'all') { sheet.idx = null; return renderSheet(); }
    if (act === 'pick') {
        const ok = await apply(i, Number(el.dataset.i), el.dataset.t);
        if (ok && Number.isInteger(sheet?.idx)) { setTimeout(closeSheet, 160); return; }
        return renderSheet();
    }
    if (act === 'more') {
        if (el.classList.contains('busy')) return;
        el.classList.add('busy');
        el.textContent = 'Думаю…';
        try {
            const n = await moreFor(i, Number(el.dataset.i));
            if (!n) toast('info', 'Новых вариантов не придумалось');
        } catch (e) { toast('warning', esc(e?.message || e)); }
        return renderSheet();
    }
    if (act === 'regen') {
        closeSheet();
        const m = chat()[i];
        if (m) { delete store()[keyOf(m, i)]; saveMeta(); }
        await run(i, { manual: true });
    }
}

function onChatClick(ev) {
    const line = ev.target.closest?.('#chat .rp-line');
    if (line) {
        const mes = line.closest('.mes[mesid]');
        const sel = window.getSelection?.();
        if (sel && String(sel).length > 0) return; // выделяют текст — не мешаем
        ev.preventDefault();
        ev.stopPropagation();
        openSheet(Number(mes.getAttribute('mesid')), Number(line.dataset.rpI));
        return;
    }
    const chip = ev.target.closest?.('#chat .rp-chip');
    if (chip) {
        ev.preventDefault();
        ev.stopPropagation();
        const i = Number(chip.dataset.mes);
        const m = chat()[i];
        if (!m) return;
        const key = keyOf(m, i);
        if (busy.get(key) === 'run') return;
        const rec = recOf(i);
        if (rec?.items?.length) return openSheet(i, null);
        busy.delete(key);
        if (rec) { delete store()[key]; saveMeta(); }
        run(i, { manual: true });
    }
}

// ───────────── настройки ─────────────

async function worldNames() {
    const c = ctx();
    if (Array.isArray(c.worldNames)) return c.worldNames;
    try { const wi = await import('../../../world-info.js'); return wi.world_names || []; } catch { return []; }
}

async function renderSettings() {
    const host = document.getElementById('extensions_settings2');
    if (!host) return;
    const s = settings();
    let box = document.getElementById('rp_settings');
    const open = box?.querySelector('.inline-drawer-content')?.style.display === 'block';
    const profs = profiles();
    pickProfile();
    const books = await worldNames();
    const mem = members().filter(ch => ch.name !== ctx().name1);
    const html = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>🗨 Реплики</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content"${open ? ' style="display:block"' : ''}>
          <label class="checkbox_label"><input type="checkbox" data-rp-set="enabled" ${s.enabled ? 'checked' : ''}> Включено</label>
          <label class="checkbox_label"><input type="checkbox" data-rp-set="auto" ${s.auto ? 'checked' : ''}> Сами после каждого поста (иначе — тап по «🗨» под постом)</label>
          <label>Модель (профиль подключения)</label>
          <select class="text_pole" data-rp-set="profile"><option value="">— выбери —</option>${profs.map(p => `<option value="${esc(p.name)}" ${p.name === s.profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          <div class="flex-container">
            <div class="flex1"><label>Вариантов на реплику</label><input class="text_pole" type="number" min="1" max="6" data-rp-set="count" value="${esc(s.count)}"></div>
            <div class="flex1"><label>Сообщений контекста</label><input class="text_pole" type="number" min="0" max="20" data-rp-set="ctxMsgs" value="${esc(s.ctxMsgs)}"></div>
          </div>
          <label>Персонажи, чьи реплики переписываем ${mem.length ? '' : '<small>(откроется список в групповом чате)</small>'}</label>
          <div class="rp-set-chars">${mem.map(ch => `<label class="checkbox_label"><input type="checkbox" data-rp-char="${esc(ch.name)}" ${isOn(ch.name) ? 'checked' : ''}> ${esc(ch.name)}</label>`).join('') || '<small>—</small>'}</div>
          <label>Лорбук голосов <small>(берутся записи со ★ этого персонажа: ядро и голос)</small></label>
          <select class="text_pole" data-rp-set="lorebook"><option value="">— без лорбука —</option>${books.map(b => `<option value="${esc(b)}" ${b === s.lorebook ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <label class="checkbox_label"><input type="checkbox" data-rp-set="card" ${s.card ? 'checked' : ''}> Карточка персонажа (описание, личность) — модели</label>
          <label>Как зовут персонажей в тексте <small>(Имя карточки = прозвища; из Life и Гардероба уже учтены)</small></label>
          <textarea class="text_pole" rows="2" data-rp-set="aliases" placeholder="Bucky Barnes = Баки, Джеймс">${esc(s.aliases)}</textarea>
          <label>Свои указания модели</label>
          <textarea class="text_pole" rows="2" data-rp-set="note" placeholder="например: больше сленга сороковых">${esc(s.note)}</textarea>
          <div class="flex-container">
            <div class="flex1"><label>Размышления</label><select class="text_pole" data-rp-set="effort">${['', 'low', 'medium', 'high'].map(v => `<option value="${v}" ${v === s.effort ? 'selected' : ''}>${v || 'не трогать'}</option>`).join('')}</select></div>
            <div class="flex1"><label>Токены</label><input class="text_pole" type="number" min="1000" max="32000" step="500" data-rp-set="tokens" value="${esc(s.tokens)}"></div>
            <div class="flex1"><label>Ждать, сек</label><input class="text_pole" type="number" min="20" max="600" data-rp-set="timeoutSec" value="${esc(s.timeoutSec)}"></div>
          </div>
          <div class="flex-container"><div class="menu_button" data-rp-btn="last">🗨 Варианты для последнего поста</div></div>
          <small>Тап по пунктиру в посте — варианты этой реплики; «🗨» под постом — все реплики. Команда <code>/repliky</code> (номер сообщения — для старого поста, <code>on</code>/<code>off</code>). Реплики v${VERSION}</small>
        </div>
      </div>`;
    if (!box) {
        box = document.createElement('div');
        box.id = 'rp_settings';
        host.appendChild(box);
        box.addEventListener('change', onSettingsChange);
        box.addEventListener('click', (ev) => { if (ev.target.closest('[data-rp-btn="last"]')) { const i = lastAiIndex(); if (i >= 0) run(i, { manual: true }); } });
    }
    box.innerHTML = html;
}

function onSettingsChange(ev) {
    const el = ev.target;
    const s = settings();
    if (el.dataset.rpChar) { s.chars[el.dataset.rpChar] = el.checked; save(); return; }
    const k = el.dataset.rpSet;
    if (!k) return;
    if (el.type === 'checkbox') s[k] = el.checked;
    else if (el.type === 'number') s[k] = Number(el.value) || DEFAULTS[k];
    else s[k] = el.value;
    save();
    if (k === 'enabled') paintAll();
}

// ───────────── команда ─────────────

function registerSlash() {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'repliky',
            callback: async (_a, v) => {
                const arg = String(v ?? '').trim();
                const s = settings();
                if (arg === 'on' || arg === 'off') { s.enabled = arg === 'on'; save(); paintAll(); renderSettings(); toast('info', s.enabled ? 'Включены' : 'Выключены'); return ''; }
                const i = arg ? Number(arg) : lastAiIndex();
                if (Number.isFinite(i) && i >= 0) await run(i, { manual: true });
                return '';
            },
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'номер сообщения | on | off', typeList: [ARGUMENT_TYPE.STRING], isRequired: false })],
            helpString: 'Реплики: варианты реплик персонажей для поста (по умолчанию — последнего).',
        }));
    } catch (e) { console.warn('[Реплики] команда', e); }
}

// ───────────── старт ─────────────

jQuery(async () => {
    settings();
    await renderSettings();
    registerSlash();
    document.addEventListener('click', onChatClick, true);
    if (!watchChat()) { let t = 0; const iv = setInterval(() => { if (watchChat() || ++t > 40) clearInterval(iv); }, 500); }
    const { eventSource, eventTypes: E } = ctx();
    const onAi = (id, type) => {
        const i = Number(id);
        if (!Number.isFinite(i)) return;
        paintSoon(i, 1200);
        paintSoon(i, 3500);
        const s = settings();
        if (!s.enabled || !s.auto || type === 'impersonate' || i !== lastAiIndex()) return;
        const m = chat()[i];
        if (!eligible(m) || recOf(i) || busy.has(keyOf(m, i))) return;
        setTimeout(() => { if (i === lastAiIndex() && !recOf(i)) run(i); }, 1500);
    };
    if (E.CHARACTER_MESSAGE_RENDERED) eventSource.on(E.CHARACTER_MESSAGE_RENDERED, onAi);
    else if (E.MESSAGE_RECEIVED) eventSource.on(E.MESSAGE_RECEIVED, onAi);
    for (const ev of [E.MESSAGE_SWIPED, E.MESSAGE_EDITED, E.MESSAGE_UPDATED]) if (ev) eventSource.on(ev, (id) => { const i = Number(id); if (Number.isFinite(i)) { paintSoon(i, 500); paintSoon(i, 1500); } });
    for (const ev of [E.MESSAGE_DELETED, E.MORE_MESSAGES_LOADED, E.USER_MESSAGE_RENDERED]) if (ev) eventSource.on(ev, () => setTimeout(paintAll, 400));
    if (E.CHAT_CHANGED) eventSource.on(E.CHAT_CHANGED, () => { closeSheet(); busy.clear(); painted.clear(); renderSettings(); setTimeout(paintAll, 700); });
    if (E.APP_READY) eventSource.on(E.APP_READY, () => { watchChat(); renderSettings(); paintAll(); });
    setTimeout(paintAll, 1500);
    console.log(`[Реплики] загружены ${VERSION}`);
});
