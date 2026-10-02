/* Food Tracker — vanilla JS, no build step.
 *
 * Accuracy rules followed throughout:
 *  - Nutrition is stored per 100 g and entry nutrition is per100g × grams / 100.
 *  - Raw values are stored unrounded; rounding happens only in fmt* display helpers.
 *  - Totals sum unrounded values and are rounded once, at display time.
 *  - Log entries keep a snapshot of the food's nutrition at logging time.
 */
'use strict';

(function () {
  // =====================================================================
  // Constants
  // =====================================================================
  const STORAGE_KEY = 'foodTracker.v1';
  const SCHEMA_VERSION = 1;
  const G_PER_OZ = 28.3495;
  const KG_PER_LB = 0.45359237;
  const CM_PER_IN = 2.54;
  const KJ_PER_KCAL = 4.184;
  const RECENT_LIMIT = 15;
  const BACKUP_REMINDER_DAYS = 7;

  const MEALS = [
    { key: 'breakfast', label: 'Breakfast' },
    { key: 'lunch', label: 'Lunch' },
    { key: 'dinner', label: 'Dinner' },
    { key: 'snacks', label: 'Snacks' },
  ];
  const MEAL_KEYS = MEALS.map((m) => m.key);

  const ACTIVITY = {
    sedentary: { label: 'Sedentary (little or no exercise)', factor: 1.2 },
    light: { label: 'Light (1–3 days/week)', factor: 1.375 },
    moderate: { label: 'Moderate (3–5 days/week)', factor: 1.55 },
    very: { label: 'Very active (6–7 days/week)', factor: 1.725 },
    extra: { label: 'Extra active (physical job + training)', factor: 1.9 },
  };

  const SOURCES = ['manual', 'openfoodfacts', 'usda', 'recipe'];
  const SOURCE_LABELS = { manual: 'Manual', openfoodfacts: 'Open Food Facts', usda: 'USDA', recipe: 'Recipe' };
  const NUTR_KEYS = ['kcal', 'protein', 'carbs', 'fat'];
  const FOOD_NUTR_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar'];
  const NUTR_LABELS = { kcal: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat', fiber: 'Fiber', sugar: 'Sugar' };
  const MIN_TARGET = { female: 1200, male: 1500 };

  // =====================================================================
  // Small utilities
  // =====================================================================
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const numOrNull = (v) => (isNum(v) ? v : null);
  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
  const nowIso = () => new Date().toISOString();
  const clone = (v) => JSON.parse(JSON.stringify(v));

  function uid() {
    try {
      if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Parse a user-typed number. Returns {empty, value, valid}. Accepts "1,5" as 1.5. */
  function parseNum(input) {
    const s = String(input == null ? '' : input).trim().replace(',', '.');
    if (s === '') return { empty: true, value: null, valid: false };
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return { empty: false, value: null, valid: false };
    const v = Number(s);
    return { empty: false, value: v, valid: Number.isFinite(v) };
  }

  // ---------- Dates (always local time, never UTC) ----------
  const pad = (n) => String(n).padStart(2, '0');
  function dateKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayKey() { return dateKey(new Date()); }
  function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function isDateKey(k) { return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && dateKey(parseKey(k)) === k; }
  function addDays(k, n) { const d = parseKey(k); d.setDate(d.getDate() + n); return dateKey(d); }
  /** Whole days from a to b (DST-safe). */
  function daysBetween(a, b) { return Math.round((parseKey(b) - parseKey(a)) / 86400000); }
  function fmtDate(k, opts) { return parseKey(k).toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric', year: 'numeric' }); }
  function relativeDayName(k) {
    const diff = daysBetween(todayKey(), k);
    if (diff === 0) return 'Today';
    if (diff === -1) return 'Yesterday';
    if (diff === 1) return 'Tomorrow';
    return parseKey(k).toLocaleDateString(undefined, { weekday: 'long' });
  }

  // ---------- Display formatting (the ONLY place rounding happens) ----------
  function fmtKcal(v) {
    if (!isNum(v)) return '—';
    const r = Math.round(v);
    return (r === 0 ? 0 : r).toLocaleString();
  }
  function fmtG(v) {
    if (!isNum(v)) return '—';
    const r = Math.round(v * 10) / 10;
    return (r === 0 ? 0 : r).toFixed(1);
  }
  /** Quantities (servings, grams typed by the user): up to 2 decimals, trailing zeros trimmed. */
  function fmtQty(v) {
    if (!isNum(v)) return '—';
    const r = Math.round(v * 100) / 100;
    return String(r === 0 ? 0 : r);
  }
  /** Value for an <input>: show the stored number without float noise but without display rounding. */
  function inputVal(v) {
    if (!isNum(v)) return '';
    return String(Number(v.toPrecision(12)));
  }

  // =====================================================================
  // Nutrition math
  // =====================================================================
  /** Entry nutrition = per100g × grams / 100 (unrounded). */
  function scaleNutrition(per100g, grams) {
    const out = {};
    NUTR_KEYS.forEach((k) => { out[k] = isNum(per100g[k]) ? (per100g[k] * grams) / 100 : NaN; });
    return out;
  }
  /** Sums unrounded nutrition objects. */
  function sumNutrition(list) {
    const out = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    list.forEach((n) => NUTR_KEYS.forEach((k) => { out[k] += n[k]; }));
    return out;
  }

  /** Validates a per-100 g nutrition object. Errors block saving; warnings do not. */
  function checkPer100g(p) {
    const errors = [];
    const warnings = [];
    NUTR_KEYS.forEach((k) => {
      if (!isNum(p[k])) errors.push(`${NUTR_LABELS[k]} per 100 g is required.`);
      else if (p[k] < 0) errors.push(`${NUTR_LABELS[k]} can't be negative.`);
    });
    ['fiber', 'sugar'].forEach((k) => {
      if (p[k] != null && (!isNum(p[k]) || p[k] < 0)) errors.push(`${NUTR_LABELS[k]} must be a number ≥ 0 or left empty.`);
    });
    if (errors.length) return { errors, warnings };

    if (p.kcal > 900) warnings.push(`${fmtKcal(p.kcal)} kcal per 100 g is unusually high (pure fat is ~900). Double-check the value.`);
    const macroGrams = p.protein + p.carbs + p.fat;
    if (macroGrams > 100.5) warnings.push(`Protein + carbs + fat add up to ${fmtG(macroGrams)} g per 100 g, which is more than 100 g.`);
    if (isNum(p.sugar) && p.sugar > p.carbs + 0.05) warnings.push('Sugar is higher than total carbs.');
    const macroKcal = 4 * p.protein + 4 * p.carbs + 9 * p.fat;
    const diff = Math.abs(macroKcal - p.kcal);
    const base = Math.max(macroKcal, p.kcal);
    if (base > 0 && diff > 10 && diff / base > 0.2) {
      warnings.push(`Macros imply about ${fmtKcal(macroKcal)} kcal (4/4/9 kcal per g) but calories are listed as ${fmtKcal(p.kcal)} — a ${Math.round((diff / base) * 100)}% difference. Check the label.`);
    }
    return { errors, warnings };
  }

  // =====================================================================
  // Calorie target (Mifflin-St Jeor)
  // =====================================================================
  function calcBmr(profile) {
    const { sex, age, heightCm, weightKg } = profile;
    if ((sex !== 'male' && sex !== 'female') || !isNum(age) || !isNum(heightCm) || !isNum(weightKg)) return null;
    return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'male' ? 5 : -161);
  }
  function calcTdee(profile) {
    const bmr = calcBmr(profile);
    const act = ACTIVITY[profile.activityLevel];
    return bmr == null || !act ? null : bmr * act.factor;
  }
  function calculatedTarget(settings) {
    const tdee = calcTdee(settings.profile);
    return tdee == null || !isNum(settings.deficit) ? null : tdee - settings.deficit;
  }
  /** The active daily target: manual override if selected, otherwise calculated. */
  function currentTarget(settings) {
    if (settings.targetMode === 'manual' && isNum(settings.manualTarget)) return settings.manualTarget;
    return calculatedTarget(settings);
  }
  function minimumFor(sex) { return sex === 'male' ? MIN_TARGET.male : MIN_TARGET.female; }

  // =====================================================================
  // Data model
  // =====================================================================
  function defaultData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        units: { weight: 'lb', height: 'in' },
        profile: { sex: null, age: null, heightCm: null, weightKg: null, activityLevel: 'sedentary' },
        deficit: 500,
        targetMode: 'calculated',
        manualTarget: null,
        macroTargets: { protein: null, carbs: null, fat: null },
        usdaApiKey: '',
        lastBackup: null,
      },
      foods: [],
      logs: {},
      weights: [],
      // [{ from: 'YYYY-MM-DD', kcal }] — the target in effect from each date, so history compares
      // each day against the target that applied then.
      targetHistory: [],
    };
  }

  function normNutr(p, keys) {
    const out = {};
    keys.forEach((k) => { out[k] = numOrNull(p && p[k]); });
    return out;
  }
  function normServings(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => isObj(s) && typeof s.label === 'string' && s.label.trim() && isNum(s.grams) && s.grams > 0)
      .map((s) => ({ label: s.label, grams: s.grams }));
  }
  function normRecipe(r) {
    if (!isObj(r) || !Array.isArray(r.ingredients)) return null;
    return {
      ingredients: r.ingredients
        .filter((i) => isObj(i) && isNum(i.grams) && i.grams >= 0)
        .map((i) => ({
          foodId: typeof i.foodId === 'string' ? i.foodId : null,
          name: str(i.name),
          grams: i.grams,
          per100g: normNutr(i.per100g, NUTR_KEYS),
        })),
      cookedWeightG: isNum(r.cookedWeightG) && r.cookedWeightG > 0 ? r.cookedWeightG : null,
      portions: isNum(r.portions) && r.portions > 0 ? r.portions : null,
    };
  }
  function normFood(f) {
    if (!isObj(f) || typeof f.id !== 'string' || typeof f.name !== 'string') return null;
    const created = str(f.createdAt, nowIso());
    return {
      id: f.id,
      name: f.name,
      brand: str(f.brand),
      source: SOURCES.includes(f.source) ? f.source : 'manual',
      sourceId: f.sourceId == null ? null : String(f.sourceId),
      per100g: normNutr(f.per100g, FOOD_NUTR_KEYS),
      servings: normServings(f.servings),
      recipe: normRecipe(f.recipe),
      createdAt: created,
      updatedAt: str(f.updatedAt, created),
    };
  }
  function normEntry(e) {
    if (!isObj(e) || typeof e.id !== 'string' || !isNum(e.grams) || e.grams < 0) return null;
    const per100g = normNutr(e.per100g, NUTR_KEYS);
    let nutrition = normNutr(e.nutrition, NUTR_KEYS);
    if (NUTR_KEYS.some((k) => nutrition[k] == null) && NUTR_KEYS.every((k) => per100g[k] != null)) {
      nutrition = scaleNutrition(per100g, e.grams);
    }
    return {
      id: e.id,
      meal: MEAL_KEYS.includes(e.meal) ? e.meal : 'snacks',
      foodId: typeof e.foodId === 'string' ? e.foodId : null,
      name: str(e.name, 'Food'),
      brand: str(e.brand),
      grams: e.grams,
      unitLabel: str(e.unitLabel, 'g'),
      unitQty: isNum(e.unitQty) ? e.unitQty : e.grams,
      per100g,
      servings: normServings(e.servings),
      nutrition,
      createdAt: str(e.createdAt, nowIso()),
    };
  }

  /** Coerces any parsed object into a well-formed data object, filling defaults. */
  function normalize(raw) {
    const d = defaultData();
    if (!isObj(raw)) return d;
    const s = isObj(raw.settings) ? raw.settings : {};
    const ds = d.settings;
    const units = isObj(s.units) ? s.units : {};
    ds.units.weight = units.weight === 'kg' ? 'kg' : 'lb';
    ds.units.height = units.height === 'cm' ? 'cm' : 'in';
    const p = isObj(s.profile) ? s.profile : {};
    ds.profile = {
      sex: p.sex === 'male' || p.sex === 'female' ? p.sex : null,
      age: numOrNull(p.age),
      heightCm: numOrNull(p.heightCm),
      weightKg: numOrNull(p.weightKg),
      activityLevel: ACTIVITY[p.activityLevel] ? p.activityLevel : 'sedentary',
    };
    ds.deficit = isNum(s.deficit) ? s.deficit : 500;
    ds.targetMode = s.targetMode === 'manual' ? 'manual' : 'calculated';
    ds.manualTarget = numOrNull(s.manualTarget);
    const mt = isObj(s.macroTargets) ? s.macroTargets : {};
    ds.macroTargets = { protein: numOrNull(mt.protein), carbs: numOrNull(mt.carbs), fat: numOrNull(mt.fat) };
    ds.usdaApiKey = str(s.usdaApiKey);
    ds.lastBackup = typeof s.lastBackup === 'string' ? s.lastBackup : null;

    d.foods = (Array.isArray(raw.foods) ? raw.foods : []).map(normFood).filter(Boolean);

    if (isObj(raw.logs)) {
      Object.keys(raw.logs).sort().forEach((k) => {
        if (!isDateKey(k) || !Array.isArray(raw.logs[k])) return;
        const entries = raw.logs[k].map(normEntry).filter(Boolean);
        if (entries.length) d.logs[k] = entries;
      });
    }

    const byDate = new Map();
    (Array.isArray(raw.weights) ? raw.weights : []).forEach((w) => {
      if (isObj(w) && isDateKey(w.date) && isNum(w.kg) && w.kg > 0) byDate.set(w.date, { date: w.date, kg: w.kg });
    });
    d.weights = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

    const th = new Map();
    (Array.isArray(raw.targetHistory) ? raw.targetHistory : []).forEach((t) => {
      if (isObj(t) && isDateKey(t.from) && isNum(t.kcal)) th.set(t.from, { from: t.from, kcal: t.kcal });
    });
    d.targetHistory = [...th.values()].sort((a, b) => (a.from < b.from ? -1 : 1));
    return d;
  }

  /** Future schema upgrades go here, keyed by the version being upgraded from. */
  const MIGRATIONS = {
    // 1: (d) => { ...; d.schemaVersion = 2; return d; },
  };
  function migrate(raw) {
    let d = raw;
    while (isNum(d.schemaVersion) && d.schemaVersion < SCHEMA_VERSION && MIGRATIONS[d.schemaVersion]) {
      d = MIGRATIONS[d.schemaVersion](d);
    }
    return d;
  }

  /** Strict validation for imported backups. Returns a list of human-readable problems. */
  function validateBackup(raw) {
    const errors = [];
    const add = (msg) => { if (errors.length < 12) errors.push(msg); };
    if (!isObj(raw)) return ['The file does not contain a Food Tracker backup (expected a JSON object).'];
    if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) add('Missing or invalid "schemaVersion".');
    else if (raw.schemaVersion > SCHEMA_VERSION) add(`This backup was made by a newer version of the app (schema ${raw.schemaVersion}; this app supports ${SCHEMA_VERSION}).`);
    if (!isObj(raw.settings)) add('Missing "settings" object.');
    if (!Array.isArray(raw.foods)) add('Missing "foods" list.');
    if (!isObj(raw.logs)) add('Missing "logs" object.');
    if (!Array.isArray(raw.weights)) add('Missing "weights" list.');
    if (errors.length) return errors;

    raw.foods.forEach((f, i) => {
      const where = `Food #${i + 1}`;
      if (!isObj(f)) return add(`${where} is not an object.`);
      if (typeof f.id !== 'string' || !f.id) add(`${where} has no id.`);
      if (typeof f.name !== 'string' || !f.name.trim()) add(`${where} has no name.`);
      if (!isObj(f.per100g)) return add(`${where} (${f.name}) has no per-100 g nutrition.`);
      NUTR_KEYS.forEach((k) => {
        if (!isNum(f.per100g[k]) || f.per100g[k] < 0) add(`${where} (${f.name}) has an invalid ${k} value.`);
      });
    });
    Object.keys(raw.logs).forEach((k) => {
      if (!isDateKey(k)) return add(`Log date "${k}" is not a valid YYYY-MM-DD date.`);
      if (!Array.isArray(raw.logs[k])) return add(`Log for ${k} is not a list.`);
      raw.logs[k].forEach((e, i) => {
        const where = `Log ${k} entry #${i + 1}`;
        if (!isObj(e)) return add(`${where} is not an object.`);
        if (typeof e.id !== 'string' || !e.id) add(`${where} has no id.`);
        if (!isNum(e.grams) || e.grams < 0) add(`${where} has an invalid gram amount.`);
        if (!isObj(e.nutrition) || NUTR_KEYS.some((n) => !isNum(e.nutrition[n]))) add(`${where} has invalid nutrition values.`);
      });
    });
    raw.weights.forEach((w, i) => {
      if (!isObj(w) || !isDateKey(w.date) || !isNum(w.kg) || w.kg <= 0) add(`Weight entry #${i + 1} is invalid.`);
    });
    if (raw.targetHistory != null && !Array.isArray(raw.targetHistory)) add('"targetHistory" must be a list.');
    return errors;
  }

  /** Merge an imported backup into current data, de-duplicating by id (weights by date). */
  function mergeData(current, incoming) {
    const out = clone(current);
    const stats = { foods: 0, foodsUpdated: 0, entries: 0, weights: 0 };

    const foodIdx = new Map(out.foods.map((f, i) => [f.id, i]));
    incoming.foods.forEach((f) => {
      if (!foodIdx.has(f.id)) { out.foods.push(f); stats.foods++; return; }
      const i = foodIdx.get(f.id);
      if (f.updatedAt > out.foods[i].updatedAt) { out.foods[i] = f; stats.foodsUpdated++; }
    });

    Object.keys(incoming.logs).forEach((k) => {
      const list = out.logs[k] || (out.logs[k] = []);
      const ids = new Set(list.map((e) => e.id));
      incoming.logs[k].forEach((e) => { if (!ids.has(e.id)) { list.push(e); stats.entries++; } });
    });

    const wDates = new Set(out.weights.map((w) => w.date));
    incoming.weights.forEach((w) => { if (!wDates.has(w.date)) { out.weights.push(w); stats.weights++; } });
    out.weights.sort((a, b) => (a.date < b.date ? -1 : 1));

    const tDates = new Set(out.targetHistory.map((t) => t.from));
    incoming.targetHistory.forEach((t) => { if (!tDates.has(t.from)) out.targetHistory.push(t); });
    out.targetHistory.sort((a, b) => (a.from < b.from ? -1 : 1));
    return { data: normalize(out), stats };
  }

  // =====================================================================
  // Storage (every read and write wrapped in try/catch)
  // =====================================================================
  let data = defaultData();
  let storageAvailable = true;

  function loadData() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageAvailable = false;
      notice('Browser storage is unavailable (private mode or blocked site data). The app works, but nothing will be saved — export a backup before closing.', 'error');
      return defaultData();
    }
    if (raw == null) {
      notice('No saved data found — starting fresh. Set your calorie target in Settings to get started.', 'info');
      return defaultData();
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isObj(parsed)) throw new Error('Stored value is not an object');
      if (isNum(parsed.schemaVersion) && parsed.schemaVersion > SCHEMA_VERSION) {
        notice('Saved data was created by a newer version of this app. Some data may not display correctly.', 'warn');
      }
      return normalize(migrate(parsed));
    } catch (e) {
      const copyKey = STORAGE_KEY + '.corrupt-' + Date.now();
      let kept = false;
      try { localStorage.setItem(copyKey, raw); kept = true; } catch (e2) { /* quota or blocked */ }
      notice('Saved data could not be read, so the app started fresh.' +
        (kept ? ` The unreadable data was kept in localStorage under "${copyKey}".` : ''), 'warn');
      return defaultData();
    }
  }

  function saveData() {
    if (!storageAvailable) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      notice('Could not save your data: ' + (e && e.message ? e.message : e) + '. Export a backup to avoid losing changes.', 'error');
      return false;
    }
  }

  /** Records the active target for today so past days keep the target that applied then. */
  function syncTargetHistory() {
    const t = currentTarget(data.settings);
    if (!isNum(t)) return;
    const h = data.targetHistory;
    const today = todayKey();
    const last = h[h.length - 1];
    if (last && last.kcal === t) return;
    if (last && last.from === today) {
      last.kcal = t;
      const prev = h[h.length - 2];
      if (prev && prev.kcal === t) h.pop();
    } else {
      h.push({ from: today, kcal: t });
    }
  }
  function targetForDate(k) {
    const h = data.targetHistory;
    if (!h.length) return currentTarget(data.settings);
    let t = h[0].kcal;
    for (const e of h) { if (e.from <= k) t = e.kcal; else break; }
    return t;
  }

  // =====================================================================
  // Backup: export / import
  // =====================================================================
  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    data.settings.lastBackup = nowIso();
    saveData();
    const payload = Object.assign({ app: 'food-tracker', exportedAt: data.settings.lastBackup }, clone(data));
    downloadFile(`food-tracker-backup-${todayKey()}.json`, JSON.stringify(payload, null, 2), 'application/json');
    toast('Backup downloaded.');
    render();
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /** CSV numbers: 4 decimals removes float noise without display-style rounding. */
  const csvNum = (v) => (isNum(v) ? String(Math.round(v * 10000) / 10000) : '');

  function exportCsv() {
    const rows = [['date', 'meal', 'food', 'brand', 'quantity', 'unit', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g']];
    Object.keys(data.logs).sort().forEach((k) => {
      const entries = data.logs[k].slice().sort((a, b) => MEAL_KEYS.indexOf(a.meal) - MEAL_KEYS.indexOf(b.meal));
      entries.forEach((e) => {
        rows.push([k, e.meal, e.name, e.brand, csvNum(e.unitQty), e.unitLabel, csvNum(e.grams),
          csvNum(e.nutrition.kcal), csvNum(e.nutrition.protein), csvNum(e.nutrition.carbs), csvNum(e.nutrition.fat)]);
      });
    });
    if (rows.length === 1) { toast('Nothing logged yet.'); return; }
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    downloadFile(`food-tracker-log-${todayKey()}.csv`, csv, 'text/csv');
    toast('Food log CSV downloaded.');
  }

  async function importJsonFile(file) {
    let text;
    try {
      text = await file.text();
    } catch (e) {
      await ask({ title: 'Import failed', message: 'The file could not be read.', buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }] });
      return;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      await ask({ title: 'Import failed', message: 'That file is not valid JSON.', buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }] });
      return;
    }
    const errors = validateBackup(raw);
    if (errors.length) {
      await ask({
        title: 'Backup not valid',
        html: '<p>Nothing was imported. Problems found:</p><ul>' + errors.map((m) => `<li>${esc(m)}</li>`).join('') + '</ul>',
        buttons: [{ label: 'OK', value: 'ok', kind: 'primary' }],
      });
      return;
    }
    const incoming = normalize(migrate(raw));
    const dayCount = Object.keys(incoming.logs).length;
    const when = typeof raw.exportedAt === 'string' ? new Date(raw.exportedAt).toLocaleString() : 'unknown date';
    const choice = await ask({
      title: 'Import backup',
      html: `<p>Backup from <b>${esc(when)}</b>: ${incoming.foods.length} foods, ${dayCount} logged days, ${incoming.weights.length} weight entries.</p>
        <p><b>Replace all</b> discards everything currently in the app and restores the backup exactly.</p>
        <p><b>Merge</b> adds foods, log entries and weights that aren't already here (matched by ID; weights by date) and keeps your current settings.</p>`,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Merge', value: 'merge' },
        { label: 'Replace all', value: 'replace', kind: 'primary' },
      ],
    });
    if (choice === 'replace') {
      data = incoming;
      saveData();
      toast('Backup restored.');
    } else if (choice === 'merge') {
      const { data: merged, stats } = mergeData(data, incoming);
      data = merged;
      saveData();
      toast(`Merged: ${stats.foods} new foods, ${stats.foodsUpdated} updated, ${stats.entries} log entries, ${stats.weights} weights.`);
    } else {
      return;
    }
    render();
  }

  // =====================================================================
  // UI helpers: notices, toast, dialogs
  // =====================================================================
  function notice(message, kind) {
    const box = document.getElementById('notices');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'notice ' + (kind || 'info');
    div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    div.innerHTML = `<p>${esc(message)}</p><button type="button" class="btn ghost small" aria-label="Dismiss">✕</button>`;
    div.querySelector('button').addEventListener('click', () => div.remove());
    box.appendChild(div);
  }

  let toastTimer = null;
  function toast(message) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /** Small promise-based dialog. Resolves with the clicked button's value, or null on dismiss. */
  function ask({ title, message, html, buttons }) {
    const dlg = document.getElementById('ask');
    return new Promise((resolve) => {
      dlg.innerHTML = `<div class="ask-body"><h2 id="ask-title">${esc(title)}</h2>${html || `<p>${esc(message)}</p>`}</div>
        <div class="ask-actions">${buttons.map((b, i) =>
          `<button type="button" class="btn ${b.kind || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
      let result = null;
      dlg.querySelectorAll('[data-i]').forEach((btn) => {
        btn.addEventListener('click', () => { result = buttons[Number(btn.dataset.i)].value; dlg.close(); });
      });
      dlg.addEventListener('close', function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(result);
      });
      dlg.showModal();
      const primary = dlg.querySelector('.btn.primary');
      if (primary) primary.focus();
    });
  }
  const confirmAsk = (title, message, okLabel, danger) => ask({
    title, message,
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel || 'OK', value: true, kind: danger ? 'danger' : 'primary' }],
  }).then((v) => v === true);

  const modal = {
    el: null,
    onClose: null,
    open(title, bodyHtml, footHtml) {
      const dlg = document.getElementById('modal');
      dlg.innerHTML = `<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2>
          <button type="button" class="btn ghost icon" data-close aria-label="Close">✕</button></div>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}`;
      dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => modal.close()));
      if (!dlg.open) dlg.showModal();
      dlg.querySelector('.modal-body').scrollTop = 0;
      this.el = dlg;
      return dlg;
    },
    close() {
      const dlg = document.getElementById('modal');
      if (dlg.open) dlg.close();
    },
  };

  /** Reads a number input; returns null for empty, NaN for invalid. */
  function readNum(el) {
    const p = parseNum(el.value);
    if (p.empty) return null;
    return p.valid ? p.value : NaN;
  }

  // =====================================================================
  // Views
  // =====================================================================
  const ui = { view: 'today', date: todayKey() };
  const views = {};
  const actions = {};

  function placeholder(name) {
    return (root) => { root.innerHTML = `<div class="card"><h2>${esc(name)}</h2><p class="muted">Coming soon.</p></div>`; };
  }
  // ---------------------------------------------------------------------
  // Shared nutrition display snippets
  // ---------------------------------------------------------------------
  function macHtml(n) {
    return `<span class="p">P <b>${fmtG(n.protein)}</b> g</span><span class="c">C <b>${fmtG(n.carbs)}</b> g</span><span class="f">F <b>${fmtG(n.fat)}</b> g</span>`;
  }
  /** Per-100 g summary; missing values are flagged instead of shown as 0. */
  function per100Html(p) {
    const part = (k, label, fmt, unit) => (isNum(p[k])
      ? `${label}${fmt(p[k])}${unit}`
      : `<span class="badge missing">${esc(NUTR_LABELS[k])} missing</span>`);
    return `${part('kcal', '', fmtKcal, ' kcal')} · ${part('protein', 'P ', fmtG, ' g')} · ${part('carbs', 'C ', fmtG, ' g')} · ${part('fat', 'F ', fmtG, ' g')} <span class="muted">per 100 g</span>`;
  }
  function sourceBadge(f) {
    return f.source && f.source !== 'manual' ? ` <span class="badge">${esc(SOURCE_LABELS[f.source])}</span>` : '';
  }

  // ---------------------------------------------------------------------
  // Food library
  // ---------------------------------------------------------------------
  function getFood(id) { return data.foods.find((f) => f.id === id) || null; }

  function searchFoods(query) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = data.foods.filter((f) => {
      const hay = (f.name + ' ' + f.brand).toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
    return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  function upsertFood(food) {
    const i = data.foods.findIndex((f) => f.id === food.id);
    food.updatedAt = nowIso();
    if (i >= 0) data.foods[i] = food;
    else data.foods.push(food);
    saveData();
    return food;
  }

  async function deleteFood(id) {
    const f = getFood(id);
    if (!f) return false;
    const ok = await confirmAsk(`Delete “${f.name}”?`, 'It will be removed from your library. Days you already logged keep their calories (each entry stores its own snapshot).', 'Delete', true);
    if (!ok) return false;
    data.foods = data.foods.filter((x) => x.id !== id);
    saveData();
    toast('Food deleted.');
    return true;
  }

  function newFoodDraft() {
    return {
      id: uid(), name: '', brand: '', source: 'manual', sourceId: null,
      per100g: { kcal: null, protein: null, carbs: null, fat: null, fiber: null, sugar: null },
      servings: [], recipe: null, createdAt: nowIso(), updatedAt: nowIso(),
    };
  }

  function servingRowHtml(s) {
    return `<div class="serving-row">
      <label class="field"><span>Serving name</span><input class="sv-label" value="${esc(s ? s.label : '')}" placeholder="e.g. 1 slice"></label>
      <label class="field"><span>Grams</span><input class="sv-grams" inputmode="decimal" value="${s ? inputVal(s.grams) : ''}" placeholder="g"></label>
      <button type="button" class="btn ghost icon sv-remove" aria-label="Remove serving">✕</button>
    </div>`;
  }

  /**
   * Food editor. `food` may be a library food, a new draft, or an online result draft.
   * opts: { title, saveLabel, notes: [], onSaved(food) }
   */
  function openFoodEditor(food, opts = {}) {
    if (food && food.recipe && typeof openRecipeEditor === 'function') { openRecipeEditor(food); return; }
    const f = food ? clone(food) : newFoodDraft();
    const existing = !!getFood(f.id);
    const missingKeys = existing ? [] : NUTR_KEYS.filter((k) => !isNum(f.per100g[k]) && f.source !== 'manual');
    const nutrField = (k, required) => {
      const miss = missingKeys.includes(k);
      return `<label class="field"><span>${NUTR_LABELS[k]}${k === 'kcal' ? ' (kcal)' : ' (g)'}${required ? ' *' : ''}</span>
        <input id="fe-${k}" inputmode="decimal" value="${inputVal(f.per100g[k])}" class="${miss ? 'missing' : ''}" ${miss ? 'placeholder="Missing — enter value"' : ''}>
        ${miss ? '<span class="hint" style="color:var(--danger)">Not provided by the source</span>' : ''}</label>`;
    };
    const notes = (opts.notes || []).slice();
    if (missingKeys.length) notes.unshift(`This result is missing ${missingKeys.map((k) => NUTR_LABELS[k].toLowerCase()).join(', ')}. Fill in the value from the label before saving — missing values are never treated as 0.`);

    const body = `
      ${notes.length ? `<div class="msg warn"><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
      ${f.source !== 'manual' ? `<p class="small muted">Source: ${esc(SOURCE_LABELS[f.source])}${f.sourceId ? ` (${esc(f.sourceId)})` : ''}. Values remain editable.</p>` : ''}
      <label class="field"><span>Name *</span><input id="fe-name" value="${esc(f.name)}" autocomplete="off"></label>
      <label class="field"><span>Brand</span><input id="fe-brand" value="${esc(f.brand)}" autocomplete="off"></label>
      <h3>Nutrition per 100 g</h3>
      <div class="grid-4">${NUTR_KEYS.map((k) => nutrField(k, true)).join('')}</div>
      <div class="grid-2">${nutrField('fiber', false)}${nutrField('sugar', false)}</div>
      <div id="fe-checks"></div>
      <h3>Serving sizes</h3>
      <p class="small muted">Named portions with their weight, e.g. “1 slice” = 28 g or “1 cup” = 240 g.</p>
      <div id="fe-servings">${f.servings.map(servingRowHtml).join('')}</div>
      <button type="button" class="btn small" id="fe-add-serving">+ Add serving size</button>
      <div id="fe-errors"></div>`;
    const foot = `${existing ? '<button type="button" class="btn danger" id="fe-delete">Delete</button><span class="grow"></span>' : ''}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" id="fe-save">${esc(opts.saveLabel || 'Save food')}</button>`;
    const dlg = modal.open(opts.title || (existing ? 'Edit food' : 'New food'), body, foot);

    const readPer100 = () => {
      const p = {};
      FOOD_NUTR_KEYS.forEach((k) => { p[k] = readNum(dlg.querySelector('#fe-' + k)); });
      return p;
    };
    const showChecks = () => {
      const p = readPer100();
      const filled = NUTR_KEYS.every((k) => p[k] !== null);
      const { errors, warnings } = checkPer100g(p);
      const box = dlg.querySelector('#fe-checks');
      // Only surface errors once the user has filled the required fields, to avoid noise while typing.
      const shownErrors = filled ? errors : errors.filter((e) => !/required/.test(e));
      box.innerHTML = (shownErrors.length ? `<div class="msg error"><ul>${shownErrors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : '') +
        (warnings.length ? `<div class="msg warn"><b>Check these values:</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '');
    };
    dlg.querySelector('.modal-body').addEventListener('input', (ev) => {
      if (ev.target.id && ev.target.id.startsWith('fe-')) {
        ev.target.classList.remove('invalid');
        if (ev.target.classList.contains('missing') && ev.target.value.trim()) ev.target.classList.remove('missing');
        showChecks();
      }
    });
    dlg.querySelector('#fe-add-serving').addEventListener('click', () => {
      dlg.querySelector('#fe-servings').insertAdjacentHTML('beforeend', servingRowHtml(null));
      const rows = dlg.querySelectorAll('.serving-row');
      rows[rows.length - 1].querySelector('.sv-label').focus();
    });
    dlg.querySelector('#fe-servings').addEventListener('click', (ev) => {
      const rm = ev.target.closest('.sv-remove');
      if (rm) rm.closest('.serving-row').remove();
    });
    const del = dlg.querySelector('#fe-delete');
    if (del) del.addEventListener('click', async () => {
      if (await deleteFood(f.id)) { modal.close(); render(); }
    });
    dlg.querySelector('#fe-save').addEventListener('click', () => {
      const errors = [];
      const nameEl = dlg.querySelector('#fe-name');
      const name = nameEl.value.trim();
      nameEl.classList.toggle('invalid', !name);
      if (!name) errors.push('Name is required.');
      const p = readPer100();
      FOOD_NUTR_KEYS.forEach((k) => {
        const el = dlg.querySelector('#fe-' + k);
        const required = NUTR_KEYS.includes(k);
        el.classList.toggle('invalid', Number.isNaN(p[k]) || (isNum(p[k]) && p[k] < 0) || (required && p[k] === null));
      });
      errors.push(...checkPer100g(p).errors);
      const servings = [];
      dlg.querySelectorAll('.serving-row').forEach((row, i) => {
        const lEl = row.querySelector('.sv-label');
        const gEl = row.querySelector('.sv-grams');
        const label = lEl.value.trim();
        const grams = readNum(gEl);
        if (!label && grams === null) return; // blank row: ignore
        let bad = false;
        if (!label) { errors.push(`Serving #${i + 1} needs a name.`); lEl.classList.add('invalid'); bad = true; }
        if (!isNum(grams) || grams <= 0) { errors.push(`Serving #${i + 1} needs a gram weight greater than 0.`); gEl.classList.add('invalid'); bad = true; }
        if (!bad) servings.push({ label, grams });
      });
      const box = dlg.querySelector('#fe-errors');
      if (errors.length) {
        box.innerHTML = `<div class="msg error"><b>Can't save yet:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
        box.scrollIntoView({ block: 'nearest' });
        return;
      }
      f.name = name;
      f.brand = dlg.querySelector('#fe-brand').value.trim();
      f.per100g = p;
      f.servings = servings;
      const saved = upsertFood(f);
      if (opts.onSaved) opts.onSaved(saved);
      else { modal.close(); toast(existing ? 'Food updated.' : 'Food saved to library.'); render(); }
    });
    showChecks();
    if (!existing && !f.name) dlg.querySelector('#fe-name').focus();
  }

  function foodListItemHtml(f) {
    const extra = f.servings.length ? ` · ${f.servings.length} serving size${f.servings.length > 1 ? 's' : ''}` : '';
    return `<li><button type="button" class="list-item" data-action="edit-food" data-id="${esc(f.id)}">
      <div class="title">${esc(f.name)}${sourceBadge(f)}</div>
      <div class="sub">${f.brand ? esc(f.brand) + ' · ' : ''}${per100Html(f.per100g)}${extra}</div>
    </button></li>`;
  }

  ui.foodQuery = '';
  views.foods = function (root) {
    root.innerHTML = `<div class="card">
        <div class="card-head"><h2>My foods</h2><span class="muted small">${data.foods.length} saved</span></div>
        <div class="searchbar"><input type="search" id="food-search" placeholder="Search my foods" value="${esc(ui.foodQuery)}" autocomplete="off" aria-label="Search my foods"></div>
        <div class="row" id="food-tools">
          <button type="button" class="btn primary" data-action="new-food">+ New food</button>
        </div>
      </div>
      <div id="food-list"></div>`;
    const listEl = root.querySelector('#food-list');
    const draw = () => {
      const list = searchFoods(ui.foodQuery);
      listEl.innerHTML = list.length
        ? `<ul class="list">${list.map(foodListItemHtml).join('')}</ul>`
        : `<div class="card list-empty">${data.foods.length ? 'No foods match your search.' : 'Your library is empty. Add foods manually, or find them online when logging.'}</div>`;
    };
    root.querySelector('#food-search').addEventListener('input', (ev) => { ui.foodQuery = ev.target.value; draw(); });
    draw();
  };
  actions['new-food'] = () => openFoodEditor(null);
  actions['edit-food'] = (ds) => { const f = getFood(ds.id); if (f) openFoodEditor(f); };

  // ---------------------------------------------------------------------
  // Log entries
  // ---------------------------------------------------------------------
  const mealLabel = (k) => (MEALS.find((m) => m.key === k) || MEALS[3]).label;
  function entriesFor(k) { return data.logs[k] || []; }
  function dayTotals(k) { return sumNutrition(entriesFor(k).map((e) => e.nutrition)); }

  function unitOptions(servings) {
    return [{ key: 'g', label: 'g', grams: 1 }, { key: 'oz', label: 'oz', grams: G_PER_OZ }]
      .concat((servings || []).map((s, i) => ({ key: 's' + i, label: s.label, grams: s.grams })));
  }
  function amountText(e) {
    if (e.unitLabel === 'g') return `${fmtQty(e.grams)} g`;
    if (e.unitLabel === 'oz') return `${fmtQty(e.unitQty)} oz (${fmtQty(e.grams)} g)`;
    return `${fmtQty(e.unitQty)} × ${e.unitLabel} (${fmtQty(e.grams)} g)`;
  }
  function guessMeal() {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    if (h < 10.5) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 21) return 'dinner';
    return 'snacks';
  }
  /** What gets snapshotted into an entry: identity, per-100 g core nutrition and servings. */
  function foodSource(f) {
    return { foodId: f.id, name: f.name, brand: f.brand, per100g: normNutr(f.per100g, NUTR_KEYS), servings: clone(f.servings) };
  }
  function makeEntry(src, grams, unitLabel, unitQty, meal) {
    return {
      id: uid(), meal, foodId: src.foodId || null, name: src.name, brand: src.brand || '',
      grams, unitLabel, unitQty,
      per100g: clone(src.per100g), servings: clone(src.servings || []),
      nutrition: scaleNutrition(src.per100g, grams),
      createdAt: nowIso(),
    };
  }
  function addEntry(k, entry) {
    (data.logs[k] || (data.logs[k] = [])).push(entry);
    saveData();
  }
  function findEntry(k, id) { return entriesFor(k).find((e) => e.id === id) || null; }
  function removeEntry(k, id) {
    if (!data.logs[k]) return;
    data.logs[k] = data.logs[k].filter((e) => e.id !== id);
    if (!data.logs[k].length) delete data.logs[k];
    saveData();
  }

  /** Most recently logged distinct foods, newest first. */
  function recentEntries() {
    const all = [];
    Object.keys(data.logs).forEach((k) => data.logs[k].forEach((e) => all.push(e)));
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const seen = new Set();
    const out = [];
    for (const e of all) {
      const key = e.foodId && getFood(e.foodId) ? 'id:' + e.foodId : 'n:' + e.name + '|' + e.brand;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  }
  /** Re-add source for a recent entry: current library values when the food still exists, else the snapshot. */
  function recentSource(e) {
    const f = e.foodId && getFood(e.foodId);
    return f ? foodSource(f) : { foodId: e.foodId, name: e.name, brand: e.brand, per100g: clone(e.per100g), servings: clone(e.servings) };
  }
  /** Resolve a previous amount against a (possibly updated) source: same unit and quantity. */
  function resolveAmount(src, unitLabel, unitQty, grams) {
    const opt = unitOptions(src.servings).find((o) => o.label === unitLabel);
    if (opt) return { unit: opt, qty: unitQty, grams: unitQty * opt.grams };
    return { unit: unitOptions([])[0], qty: grams, grams };
  }
  function quickReAdd(e, meal, k) {
    const src = recentSource(e);
    if (NUTR_KEYS.some((n) => !isNum(src.per100g[n]))) { toast('This food has incomplete nutrition. Edit it first.'); return; }
    const a = resolveAmount(src, e.unitLabel, e.unitQty, e.grams);
    addEntry(k, makeEntry(src, a.grams, a.unit.label, a.qty, meal));
    toast(`Added ${src.name} (${amountText({ grams: a.grams, unitLabel: a.unit.label, unitQty: a.qty })}) to ${mealLabel(meal)}.`);
  }

  // ---------------------------------------------------------------------
  // Portion entry (amount → grams, live preview)
  // ---------------------------------------------------------------------
  /**
   * opts: { src, date, meal, entry (when editing), preset: {unitLabel, unitQty, grams}, onBack }
   */
  function openPortion(opts) {
    const { src, date } = opts;
    const editing = opts.entry || null;
    const options = unitOptions(src.servings);
    let unit = options[0];
    let qty = 100;
    const preset = editing || opts.preset;
    if (preset) {
      const a = resolveAmount(src, preset.unitLabel, preset.unitQty, preset.grams);
      unit = a.unit; qty = a.qty;
    } else if (options.length > 2) {
      unit = options[2]; qty = 1;
    }
    const meal = editing ? editing.meal : opts.meal || guessMeal();
    const body = `
      <div>
        <div class="title"><b>${esc(src.name)}</b>${src.brand ? ` <span class="muted">· ${esc(src.brand)}</span>` : ''}</div>
        <div class="small muted">${per100Html(src.per100g)}</div>
        ${editing ? '<p class="small muted">Uses the nutrition saved when this entry was logged, so library edits never change past days.</p>' : ''}
      </div>
      <div class="grid-2">
        <label class="field"><span>Amount</span><input id="pt-qty" inputmode="decimal" value="${inputVal(qty)}" autocomplete="off"></label>
        <label class="field"><span>Unit</span><select id="pt-unit">${options.map((o) =>
          `<option value="${o.key}" ${o.key === unit.key ? 'selected' : ''}>${esc(o.key === 'g' ? 'grams (g)' : o.key === 'oz' ? 'ounces (oz)' : `${o.label} (${fmtQty(o.grams)} g)`)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Meal</span><select id="pt-meal">${MEALS.map((m) =>
        `<option value="${m.key}" ${m.key === meal ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
      <div class="preview" id="pt-preview" aria-live="polite"></div>`;
    const foot = `${editing ? '<button type="button" class="btn danger" id="pt-delete">Delete</button><span class="grow"></span>' : ''}
      ${opts.onBack ? '<button type="button" class="btn" id="pt-back">Back</button>' : '<button type="button" class="btn" data-close>Cancel</button>'}
      <button type="button" class="btn primary" id="pt-save">${editing ? 'Save' : 'Add'}</button>`;
    const dlg = modal.open(editing ? 'Edit entry' : 'Add to log', body, foot);
    const qtyEl = dlg.querySelector('#pt-qty');
    const unitEl = dlg.querySelector('#pt-unit');

    const compute = () => {
      const q = readNum(qtyEl);
      const u = options.find((o) => o.key === unitEl.value);
      if (!isNum(q) || q <= 0) return { error: q === null ? 'Enter an amount.' : 'Amount must be a number greater than 0.' };
      const grams = q * u.grams;
      return { q, u, grams, n: scaleNutrition(src.per100g, grams) };
    };
    const preview = () => {
      const r = compute();
      const box = dlg.querySelector('#pt-preview');
      qtyEl.classList.toggle('invalid', !!r.error && qtyEl.value.trim() !== '');
      if (r.error) { box.innerHTML = `<span class="muted">${esc(r.error)}</span>`; return; }
      const gramsLine = r.u.key === 'g' ? `${fmtQty(r.grams)} g` : `${fmtQty(r.q)} × ${esc(r.u.key === 'oz' ? '1 oz' : r.u.label)} = <b>${fmtQty(r.grams)} g</b>`;
      box.innerHTML = `<div class="small muted">${gramsLine}</div>
        <div><span class="big">${fmtKcal(r.n.kcal)}</span> kcal</div>
        <div class="mac">${macHtml(r.n)}</div>`;
    };
    qtyEl.addEventListener('input', preview);
    unitEl.addEventListener('change', preview);
    preview();
    qtyEl.focus();
    qtyEl.select();

    const save = () => {
      const r = compute();
      if (r.error) { qtyEl.classList.add('invalid'); qtyEl.focus(); return; }
      const m = dlg.querySelector('#pt-meal').value;
      if (editing) {
        const e = findEntry(date, editing.id);
        if (!e) { modal.close(); render(); return; }
        e.grams = r.grams;
        e.unitLabel = r.u.label;
        e.unitQty = r.q;
        e.meal = m;
        e.nutrition = scaleNutrition(e.per100g, r.grams);
        saveData();
        toast('Entry updated.');
      } else {
        addEntry(date, makeEntry(src, r.grams, r.u.label, r.q, m));
        toast(`Added to ${mealLabel(m)}.`);
      }
      modal.close();
      render();
    };
    dlg.querySelector('#pt-save').addEventListener('click', save);
    qtyEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
    const back = dlg.querySelector('#pt-back');
    if (back) back.addEventListener('click', () => opts.onBack(dlg.querySelector('#pt-meal').value));
    const del = dlg.querySelector('#pt-delete');
    if (del) del.addEventListener('click', async () => {
      if (!(await confirmAsk('Delete entry?', `Remove ${editing.name} (${amountText(editing)}) from ${mealLabel(editing.meal)}?`, 'Delete', true))) return;
      removeEntry(date, editing.id);
      modal.close();
      toast('Entry deleted.');
      render();
    });
  }

  // ---------------------------------------------------------------------
  // Add-food flow: search library, recents and online sources
  // ---------------------------------------------------------------------
  const addState = { query: '', meal: 'breakfast', date: null, online: null };

  function openAddFood(meal) {
    addState.meal = meal || (ui.date === todayKey() ? guessMeal() : 'breakfast');
    addState.date = ui.date;
    addState.query = '';
    addState.online = null;
    drawAddFood();
  }

  function recentRowHtml(e) {
    const src = recentSource(e);
    const a = resolveAmount(src, e.unitLabel, e.unitQty, e.grams);
    const n = scaleNutrition(src.per100g, a.grams);
    const amt = amountText({ grams: a.grams, unitLabel: a.unit.label, unitQty: a.qty });
    return `<li class="list-row">
      <button type="button" class="list-item" data-recent="${esc(e.id)}">
        <div class="title">${esc(e.name)}</div>
        <div class="sub">${esc(amt)} · ${fmtKcal(n.kcal)} kcal</div>
      </button>
      <button type="button" class="quick" data-quick="${esc(e.id)}" aria-label="Add ${esc(e.name)}, ${esc(amt)}">+</button>
    </li>`;
  }
  function libraryRowHtml(f) {
    return `<li><button type="button" class="list-item" data-pick-food="${esc(f.id)}">
      <div class="title">${esc(f.name)}${sourceBadge(f)}</div>
      <div class="sub">${f.brand ? esc(f.brand) + ' · ' : ''}${per100Html(f.per100g)}</div>
    </button></li>`;
  }

  function addResultsHtml() {
    const q = addState.query.trim();
    let html = '';
    if (!q) {
      const rec = recentEntries();
      html += `<div class="section-label">Recent foods</div>` + (rec.length
        ? `<ul class="list">${rec.map(recentRowHtml).join('')}</ul><p class="small muted">Tap + to re-add the same amount in one tap.</p>`
        : `<div class="list-empty">Foods you log will show up here for quick re-adding.</div>`);
      const lib = searchFoods('');
      if (lib.length) html += `<div class="section-label">My foods</div><ul class="list">${lib.map(libraryRowHtml).join('')}</ul>`;
    } else {
      const lib = searchFoods(q);
      html += `<div class="section-label">My foods</div>` + (lib.length
        ? `<ul class="list">${lib.map(libraryRowHtml).join('')}</ul>`
        : `<div class="list-empty">No saved foods match “${esc(q)}”.</div>`);
    }
    if (typeof onlineResultsHtml === 'function') html += onlineResultsHtml();
    return html;
  }

  function drawAddFood() {
    const meal = addState.meal;
    const hasOnline = typeof searchOnline === 'function';
    const body = `
      <div class="grid-2">
        <label class="field"><span>Meal</span><select id="af-meal">${MEALS.map((m) =>
          `<option value="${m.key}" ${m.key === meal ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
        <div class="field"><span>Day</span><div style="min-height:44px;display:flex;align-items:center"><b>${esc(fmtDate(addState.date, { weekday: 'short', month: 'short', day: 'numeric' }))}</b></div></div>
      </div>
      <form class="searchbar" id="af-form" role="search">
        <input type="search" id="af-q" placeholder="${hasOnline ? 'Search foods or enter a barcode' : 'Search my foods'}" value="${esc(addState.query)}" autocomplete="off" aria-label="Search foods">
        ${hasOnline ? '<button type="submit" class="btn primary">Search online</button>' : ''}
      </form>
      <div id="af-results">${addResultsHtml()}</div>`;
    const foot = `<button type="button" class="btn" id="af-manual">+ Create food manually</button>`;
    const dlg = modal.open('Add food', body, foot);
    bindAddFood(dlg);
  }

  function refreshAddResults() {
    const box = document.querySelector('#af-results');
    if (box) box.innerHTML = addResultsHtml();
  }

  function bindAddFood(dlg) {
    const qEl = dlg.querySelector('#af-q');
    dlg.querySelector('#af-meal').addEventListener('change', (ev) => { addState.meal = ev.target.value; });
    qEl.addEventListener('input', () => { addState.query = qEl.value; addState.online = null; refreshAddResults(); });
    dlg.querySelector('#af-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      addState.query = qEl.value;
      if (typeof searchOnline === 'function' && addState.query.trim()) searchOnline(addState.query.trim());
    });
    const backToSearch = (m) => { if (m) addState.meal = m; drawAddFood(); };
    dlg.querySelector('#af-results').addEventListener('click', (ev) => {
      const quick = ev.target.closest('[data-quick]');
      if (quick) {
        const e = recentEntries().find((x) => x.id === quick.dataset.quick);
        if (e) { quickReAdd(e, addState.meal, addState.date); modal.close(); render(); }
        return;
      }
      const rec = ev.target.closest('[data-recent]');
      if (rec) {
        const e = recentEntries().find((x) => x.id === rec.dataset.recent);
        if (e) openPortion({ src: recentSource(e), date: addState.date, meal: addState.meal, preset: e, onBack: backToSearch });
        return;
      }
      const pick = ev.target.closest('[data-pick-food]');
      if (pick) {
        const f = getFood(pick.dataset.pickFood);
        if (f) openPortion({ src: foodSource(f), date: addState.date, meal: addState.meal, onBack: backToSearch });
        return;
      }
      if (typeof handleOnlineClick === 'function') handleOnlineClick(ev, backToSearch);
    });
    dlg.querySelector('#af-manual').addEventListener('click', () => {
      const draft = newFoodDraft();
      draft.name = addState.query.trim();
      openFoodEditor(draft, {
        saveLabel: 'Save & continue',
        onSaved: (f) => openPortion({ src: foodSource(f), date: addState.date, meal: addState.meal, onBack: backToSearch }),
      });
    });
    qEl.focus();
  }

  // ---------------------------------------------------------------------
  // Today view
  // ---------------------------------------------------------------------
  function budgetHtml(k) {
    const target = targetForDate(k);
    const eaten = dayTotals(k);
    let top;
    if (isNum(target)) {
      const remaining = target - eaten.kcal;
      const over = remaining < 0;
      const pct = target > 0 ? Math.min(100, (eaten.kcal / target) * 100) : 100;
      top = `<div class="budget-nums">
          <div><span class="label">Target</span><strong>${fmtKcal(target)}</strong></div>
          <div><span class="label">Eaten</span><strong>${fmtKcal(eaten.kcal)}</strong></div>
          <div class="${over ? 'over' : 'under'}"><span class="label">${over ? 'Over' : 'Remaining'}</span><strong>${fmtKcal(Math.abs(remaining))}</strong></div>
        </div>
        <div class="bar ${over ? 'over' : ''}" role="progressbar" aria-label="Calories eaten" aria-valuemin="0" aria-valuemax="${Math.round(target)}" aria-valuenow="${Math.round(eaten.kcal)}"><div style="width:${pct}%"></div></div>`;
    } else {
      top = `<div class="budget-nums">
          <div><span class="label">Target</span><strong>—</strong></div>
          <div><span class="label">Eaten</span><strong>${fmtKcal(eaten.kcal)}</strong></div>
          <div><span class="label">Remaining</span><strong>—</strong></div>
        </div>
        <p class="small muted">No calorie target yet. <a href="#settings">Set one up in Settings.</a></p>`;
    }
    const mt = data.settings.macroTargets;
    const macro = (key, label) => {
      const t = mt[key];
      const v = eaten[key];
      const has = isNum(t) && t > 0;
      const over = has && v > t;
      return `<div class="macro ${key}">
        <div class="macro-label"><b>${label}</b><span class="num">${fmtG(v)}${has ? ` / ${fmtG(t)}` : ''} g</span></div>
        ${has ? `<div class="bar thin ${over ? 'over' : ''}"><div style="width:${Math.min(100, (v / t) * 100)}%"></div></div>` : ''}
      </div>`;
    };
    return `<div class="card">${top}<div class="macros">${macro('protein', 'Protein')}${macro('carbs', 'Carbs')}${macro('fat', 'Fat')}</div></div>`;
  }

  function entryHtml(e) {
    return `<li><button type="button" class="entry" data-action="edit-entry" data-id="${esc(e.id)}">
      <span><span class="name">${esc(e.name)}</span><br><span class="amount">${esc(amountText(e))}</span></span>
      <span class="kcal num">${fmtKcal(e.nutrition.kcal)} kcal</span>
      <span class="mac">${macHtml(e.nutrition)}</span>
    </button></li>`;
  }

  function mealToolsHtml(meal) {
    return typeof copyMealButtonHtml === 'function' ? copyMealButtonHtml(meal) : '';
  }

  function mealHtml(k, meal) {
    const list = entriesFor(k).filter((e) => e.meal === meal.key);
    const sub = sumNutrition(list.map((e) => e.nutrition));
    return `<section class="card meal" aria-label="${meal.label}">
      <div class="meal-head">
        <h2>${meal.label}</h2>
        <span class="kcal num">${fmtKcal(sub.kcal)} kcal</span>
        ${mealToolsHtml(meal)}
        <button type="button" class="btn small primary" data-action="add-food" data-meal="${meal.key}" aria-label="Add food to ${meal.label}">+ Add</button>
      </div>
      ${list.length ? `<ul>${list.map(entryHtml).join('')}</ul>
        <div class="subtotal"><span>${meal.label} subtotal</span><span class="kcal num">${fmtKcal(sub.kcal)} kcal</span><span class="mac">${macHtml(sub)}</span></div>`
        : `<div class="empty">Nothing logged.</div>`}
    </section>`;
  }

  views.today = function (root) {
    const k = ui.date;
    const isToday = k === todayKey();
    const total = dayTotals(k);
    root.innerHTML = `
      <div class="daynav">
        <button type="button" class="btn icon" data-action="day-prev" aria-label="Previous day">‹</button>
        <label class="datepick">
          <strong>${esc(relativeDayName(k))}</strong>
          <span class="small muted">${esc(fmtDate(k))}</span>
          <input type="date" id="day-input" value="${k}" aria-label="Pick a date">
        </label>
        <button type="button" class="btn icon" data-action="day-next" aria-label="Next day">›</button>
        ${isToday ? '' : '<button type="button" class="btn small" data-action="day-today">Today</button>'}
      </div>
      ${budgetHtml(k)}
      <div class="actions-bar">
        <button type="button" class="btn primary" data-action="add-food">+ Add food</button>
        ${typeof copyDayButtonHtml === 'function' ? copyDayButtonHtml() : ''}
      </div>
      ${MEALS.map((m) => mealHtml(k, m)).join('')}
      <div class="card daytotal">
        <h2>Day total</h2>
        <span class="kcal num">${fmtKcal(total.kcal)} kcal</span>
        <span class="mac">${macHtml(total)}</span>
      </div>`;
    root.querySelector('#day-input').addEventListener('change', (ev) => {
      if (isDateKey(ev.target.value)) { ui.date = ev.target.value; render(); }
    });
  };

  Object.assign(actions, {
    'day-prev': () => { ui.date = addDays(ui.date, -1); render(); },
    'day-next': () => { ui.date = addDays(ui.date, 1); render(); },
    'day-today': () => { ui.date = todayKey(); render(); },
    'add-food': (ds) => openAddFood(ds.meal),
    'edit-entry': (ds) => {
      const e = findEntry(ui.date, ds.id);
      if (e) openPortion({ src: { foodId: e.foodId, name: e.name, brand: e.brand, per100g: e.per100g, servings: e.servings }, date: ui.date, entry: e });
    },
  });
  views.weight = placeholder('Weight');
  views.history = placeholder('History');

  // ---------------------------------------------------------------------
  // Settings view
  // ---------------------------------------------------------------------
  function backupStatusHtml() {
    const lb = data.settings.lastBackup;
    const hasData = data.foods.length || Object.keys(data.logs).length || data.weights.length;
    if (!lb) {
      return `<p>Last backup: <b>never</b></p>` +
        (hasData ? `<p class="msg warn">You haven't backed up yet. Your data lives only in this browser — export a backup now and then.</p>` : '');
    }
    const days = daysBetween(dateKey(new Date(lb)), todayKey());
    const when = new Date(lb).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const ago = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    return `<p>Last backup: <b>${esc(when)}</b> <span class="muted">(${ago})</span></p>` +
      (days > BACKUP_REMINDER_DAYS && hasData ? `<p class="msg warn">It's been more than ${BACKUP_REMINDER_DAYS} days since your last backup. Consider exporting a fresh one.</p>` : '');
  }

  function renderBackupCard() {
    return `<div class="card" id="backup-card">
      <h2>Backup</h2>
      ${backupStatusHtml()}
      <div class="row">
        <button type="button" class="btn primary" data-action="export-json">Export backup (JSON)</button>
        <button type="button" class="btn" data-action="export-csv">Export food log (CSV)</button>
        <label class="btn">Import backup…<input type="file" accept="application/json,.json" id="import-file" hidden></label>
      </div>
      <p class="small muted">Exports include settings, food library, logs and weights. Import validates the file and then asks whether to replace everything or merge.</p>
    </div>`;
  }

  // ---------- Unit conversion helpers for display ----------
  const kgToDisplay = (kg) => (data.settings.units.weight === 'lb' ? kg / KG_PER_LB : kg);
  const displayToKg = (v) => (data.settings.units.weight === 'lb' ? v * KG_PER_LB : v);
  const weightUnit = () => data.settings.units.weight;
  function fmtWeight(kg) { return isNum(kg) ? fmtG(kgToDisplay(kg)) + ' ' + weightUnit() : '—'; }

  function fmtSigned(v, fmt) {
    if (!isNum(v)) return '—';
    const s = fmt(Math.abs(v));
    if (Number(s.replace(/,/g, '')) === 0) return fmt(0);
    return (v > 0 ? '+' : '−') + s;
  }

  function targetBreakdownHtml(settings) {
    const p = settings.profile;
    const bmr = calcBmr(p);
    const act = ACTIVITY[p.activityLevel];
    const tdee = calcTdee(p);
    const calc = calculatedTarget(settings);
    const active = currentTarget(settings);
    let html = '';
    if (bmr == null) {
      html += `<p class="msg info">Enter sex, age, height and current weight to calculate your target.</p>`;
    } else {
      const sexTerm = p.sex === 'male' ? '+ 5' : '− 161';
      html += `<table class="breakdown">
        <tr><td>BMR (Mifflin-St Jeor)<br><span class="small muted">10 × ${fmtQty(p.weightKg)} kg + 6.25 × ${fmtQty(p.heightCm)} cm − 5 × ${fmtQty(p.age)} ${sexTerm}</span></td><td>${fmtKcal(bmr)} kcal</td></tr>
        <tr><td>TDEE<br><span class="small muted">BMR × ${act.factor} (${esc(act.label.split(' (')[0])})</span></td><td>${fmtKcal(tdee)} kcal</td></tr>
        <tr><td>Daily deficit</td><td>− ${isNum(settings.deficit) ? fmtKcal(settings.deficit) : '—'} kcal</td></tr>
        <tr class="${settings.targetMode === 'calculated' ? 'total' : ''}"><td>Calculated target</td><td>${fmtKcal(calc)} kcal</td></tr>
      </table>`;
    }
    if (settings.targetMode === 'manual') {
      html += `<table class="breakdown"><tr class="total"><td>Manual target <span class="badge">override</span></td><td>${fmtKcal(settings.manualTarget)} kcal</td></tr></table>`;
    }
    if (isNum(active)) {
      const min = minimumFor(p.sex);
      if (active < min) {
        html += `<p class="msg warn">A target of ${fmtKcal(active)} kcal is below the commonly cited minimum of about ${min.toLocaleString()} kcal/day${p.sex ? ` for ${p.sex === 'male' ? 'men' : 'women'}` : ''}. Consider checking with a doctor or registered dietitian.</p>`;
      }
    }
    return html;
  }

  function settingsFormHtml() {
    const s = data.settings;
    const p = s.profile;
    const u = s.units;
    let heightFields;
    if (u.height === 'in') {
      const totalIn = isNum(p.heightCm) ? p.heightCm / CM_PER_IN : null;
      const ft = totalIn == null ? '' : Math.floor(totalIn / 12 + 1e-9);
      const inch = totalIn == null ? '' : inputVal(totalIn - ft * 12);
      heightFields = `<div class="grid-2">
        <label class="field"><span>Height (ft)</span><input id="s-height-ft" inputmode="numeric" value="${ft}" data-height></label>
        <label class="field"><span>(in)</span><input id="s-height-in" inputmode="decimal" value="${inch}" data-height></label></div>`;
    } else {
      heightFields = `<label class="field"><span>Height (cm)</span><input id="s-height-cm" inputmode="decimal" value="${inputVal(p.heightCm)}" data-height></label>`;
    }
    const weightVal = isNum(p.weightKg) ? inputVal(kgToDisplay(p.weightKg)) : '';
    return `<form class="card" id="settings-form" novalidate>
      <div class="card-head"><h2>Profile &amp; calorie target</h2></div>
      <div class="row">
        <span class="small muted">Weight</span>
        <div class="segmented" role="radiogroup" aria-label="Weight unit">
          <label><input type="radio" name="u-weight" value="lb" ${u.weight === 'lb' ? 'checked' : ''}><span>lb</span></label>
          <label><input type="radio" name="u-weight" value="kg" ${u.weight === 'kg' ? 'checked' : ''}><span>kg</span></label>
        </div>
        <span class="small muted">Height</span>
        <div class="segmented" role="radiogroup" aria-label="Height unit">
          <label><input type="radio" name="u-height" value="in" ${u.height === 'in' ? 'checked' : ''}><span>ft/in</span></label>
          <label><input type="radio" name="u-height" value="cm" ${u.height === 'cm' ? 'checked' : ''}><span>cm</span></label>
        </div>
      </div>
      <div class="grid-2">
        <label class="field"><span>Sex (for BMR formula)</span>
          <select id="s-sex"><option value="">Select…</option>
            <option value="female" ${p.sex === 'female' ? 'selected' : ''}>Female</option>
            <option value="male" ${p.sex === 'male' ? 'selected' : ''}>Male</option></select></label>
        <label class="field"><span>Age (years)</span><input id="s-age" inputmode="numeric" value="${inputVal(p.age)}"></label>
      </div>
      ${heightFields}
      <div class="grid-2">
        <label class="field"><span>Current weight (${u.weight})</span><input id="s-weight" inputmode="decimal" value="${weightVal}"></label>
        <label class="field"><span>Daily deficit (kcal)</span><input id="s-deficit" inputmode="numeric" value="${inputVal(s.deficit)}"></label>
      </div>
      <label class="field"><span>Activity level</span>
        <select id="s-activity">${Object.keys(ACTIVITY).map((k) =>
          `<option value="${k}" ${p.activityLevel === k ? 'selected' : ''}>${esc(ACTIVITY[k].label)} — × ${ACTIVITY[k].factor}</option>`).join('')}</select></label>

      <div class="field">
        <span>Daily target</span>
        <div class="segmented" role="radiogroup" aria-label="Target mode">
          <label><input type="radio" name="t-mode" value="calculated" ${s.targetMode === 'calculated' ? 'checked' : ''}><span>Calculated</span></label>
          <label><input type="radio" name="t-mode" value="manual" ${s.targetMode === 'manual' ? 'checked' : ''}><span>Manual override</span></label>
        </div>
      </div>
      <label class="field" id="manual-wrap" ${s.targetMode === 'manual' ? '' : 'hidden'}><span>Manual target (kcal/day)</span>
        <input id="s-manual" inputmode="numeric" value="${inputVal(s.manualTarget)}">
        <span class="hint">Replaces the calculated target. Switch back to “Calculated” any time — your profile is kept.</span></label>

      <div id="breakdown">${targetBreakdownHtml(s)}</div>
      <p class="small muted">The target is a fixed daily budget — exercise does not add calories back.</p>

      <h3>Macro targets (optional, grams per day)</h3>
      <div class="grid-3">
        <label class="field"><span>Protein (g)</span><input id="s-mp" inputmode="decimal" value="${inputVal(s.macroTargets.protein)}"></label>
        <label class="field"><span>Carbs (g)</span><input id="s-mc" inputmode="decimal" value="${inputVal(s.macroTargets.carbs)}"></label>
        <label class="field"><span>Fat (g)</span><input id="s-mf" inputmode="decimal" value="${inputVal(s.macroTargets.fat)}"></label>
      </div>
      <p class="small muted" id="macro-kcal"></p>
      <div id="settings-errors"></div>
      <div class="row end"><button type="submit" class="btn primary">Save settings</button></div>
    </form>`;
  }

  /** Reads the settings form into a candidate settings object. Returns {settings, errors}. */
  function readSettingsForm(form) {
    const s = clone(data.settings);
    const errors = [];
    const q = (sel) => form.querySelector(sel);
    const mark = (el, bad) => el && el.classList.toggle('invalid', !!bad);
    const field = (el, label, { required = false, min = 0, max = Infinity, integer = false } = {}) => {
      const v = readNum(el);
      let bad = false;
      if (v === null) { if (required) { errors.push(`${label} is required.`); bad = true; } }
      else if (Number.isNaN(v)) { errors.push(`${label} must be a number.`); bad = true; }
      else if (v < min) { errors.push(`${label} can't be ${min === 0 ? 'negative' : 'less than ' + min}.`); bad = true; }
      else if (v > max) { errors.push(`${label} looks too large.`); bad = true; }
      else if (integer && !Number.isInteger(v)) { errors.push(`${label} must be a whole number.`); bad = true; }
      mark(el, bad);
      return bad ? undefined : v;
    };

    s.profile.sex = q('#s-sex').value || null;
    const age = field(q('#s-age'), 'Age', { min: 1, max: 120 });
    if (age !== undefined) s.profile.age = age;

    // Only recompute stored height/weight if the user edited them (avoids unit round-trip drift).
    if (form.dataset.heightDirty === '1') {
      if (q('#s-height-cm')) {
        const cm = field(q('#s-height-cm'), 'Height', { min: 30, max: 272 });
        if (cm !== undefined) s.profile.heightCm = cm;
      } else {
        const ftEl = q('#s-height-ft');
        const inEl = q('#s-height-in');
        const ft = field(ftEl, 'Height (ft)', { max: 8 });
        const inch = field(inEl, 'Height (in)', { max: 120 });
        if (ft !== undefined && inch !== undefined) {
          if (ft === null && inch === null) s.profile.heightCm = null;
          else {
            const totalIn = (ft || 0) * 12 + (inch || 0);
            if (totalIn < 12) { errors.push('Height looks too small.'); mark(ftEl, true); }
            else s.profile.heightCm = totalIn * CM_PER_IN;
          }
        }
      }
    }
    if (form.dataset.weightDirty === '1') {
      const w = field(q('#s-weight'), 'Current weight', { min: 0.1, max: 1500 });
      if (w !== undefined) s.profile.weightKg = w === null ? null : displayToKg(w);
    }
    s.profile.activityLevel = q('#s-activity').value;
    const def = field(q('#s-deficit'), 'Daily deficit', { required: true, max: 5000 });
    if (def !== undefined) s.deficit = def;

    s.targetMode = form.querySelector('input[name="t-mode"]:checked').value;
    const manualRequired = s.targetMode === 'manual';
    const mt = field(q('#s-manual'), 'Manual target', { required: manualRequired, min: manualRequired ? 1 : 0, max: 20000 });
    if (mt !== undefined) s.manualTarget = mt;

    const mp = field(q('#s-mp'), 'Protein target', { max: 1000 });
    const mc = field(q('#s-mc'), 'Carbs target', { max: 2000 });
    const mf = field(q('#s-mf'), 'Fat target', { max: 1000 });
    if (mp !== undefined) s.macroTargets.protein = mp;
    if (mc !== undefined) s.macroTargets.carbs = mc;
    if (mf !== undefined) s.macroTargets.fat = mf;
    return { settings: s, errors };
  }

  function macroKcalNote(settings) {
    const m = settings.macroTargets;
    if (!isNum(m.protein) || !isNum(m.carbs) || !isNum(m.fat)) return '';
    const kcal = 4 * m.protein + 4 * m.carbs + 9 * m.fat;
    const t = currentTarget(settings);
    return `Macro targets add up to ${fmtKcal(kcal)} kcal (4/4/9)` + (isNum(t) ? ` vs. a ${fmtKcal(t)} kcal target.` : '.');
  }

  function renderApiCard() {
    return `<form class="card" id="api-form">
      <h2>Online lookup</h2>
      <p class="small muted">Open Food Facts is always available (no key needed). To also search USDA FoodData Central, paste a free API key from <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener">fdc.nal.usda.gov</a>.</p>
      <label class="field"><span>USDA FoodData Central API key</span>
        <input id="s-usda" type="password" autocomplete="off" spellcheck="false" value="${esc(data.settings.usdaApiKey)}" placeholder="Not set — USDA search hidden"></label>
      <div class="row end">
        ${data.settings.usdaApiKey ? '<button type="button" class="btn" id="usda-clear">Remove key</button>' : ''}
        <button type="submit" class="btn primary">Save key</button>
      </div>
    </form>`;
  }

  views.settings = function (root) {
    root.innerHTML = `${settingsFormHtml()}
      ${renderApiCard()}
      ${renderBackupCard()}
      <div class="card">
        <h2>Erase data</h2>
        <p class="small muted">Removes everything stored by this app in this browser.</p>
        <button type="button" class="btn danger" data-action="erase-all">Erase all data…</button>
      </div>`;
    bindSettingsCommon(root);

    const form = root.querySelector('#settings-form');
    const live = () => {
      const { settings } = readSettingsForm(form);
      form.querySelector('#breakdown').innerHTML = targetBreakdownHtml(settings);
      form.querySelector('#macro-kcal').textContent = macroKcalNote(settings);
      form.querySelector('#manual-wrap').hidden = settings.targetMode !== 'manual';
    };
    form.addEventListener('input', (ev) => {
      if (ev.target.matches('[data-height]')) form.dataset.heightDirty = '1';
      if (ev.target.id === 's-weight') form.dataset.weightDirty = '1';
      if (ev.target.name === 'u-weight' || ev.target.name === 'u-height') return;
      live();
    });
    form.addEventListener('change', (ev) => {
      // Unit switches apply immediately; stored values are metric so nothing is converted.
      if (ev.target.name === 'u-weight' || ev.target.name === 'u-height') {
        const key = ev.target.name === 'u-weight' ? 'weight' : 'height';
        data.settings.units[key] = ev.target.value;
        saveData();
        render();
      } else {
        live();
      }
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const { settings, errors } = readSettingsForm(form);
      const errBox = form.querySelector('#settings-errors');
      if (errors.length) {
        errBox.innerHTML = `<div class="msg error"><b>Not saved:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
        return;
      }
      data.settings = settings;
      syncTargetHistory();
      saveData();
      toast('Settings saved.');
      render();
    });
    form.querySelector('#macro-kcal').textContent = macroKcalNote(data.settings);

    const api = root.querySelector('#api-form');
    api.addEventListener('submit', (ev) => {
      ev.preventDefault();
      data.settings.usdaApiKey = api.querySelector('#s-usda').value.trim();
      saveData();
      toast(data.settings.usdaApiKey ? 'USDA key saved — USDA results will appear in search.' : 'USDA key removed.');
      render();
    });
    const clear = api.querySelector('#usda-clear');
    if (clear) clear.addEventListener('click', () => {
      data.settings.usdaApiKey = '';
      saveData();
      toast('USDA key removed.');
      render();
    });
  };

  function bindSettingsCommon(root) {
    const file = root.querySelector('#import-file');
    if (file) {
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        file.value = '';
        if (f) importJsonFile(f);
      });
    }
  }

  // =====================================================================
  // Global actions (event delegation on data-action)
  // =====================================================================
  Object.assign(actions, {
    'export-json': exportJson,
    'export-csv': exportCsv,
    'erase-all': async () => {
      const ok = await confirmAsk('Erase all data?', 'This deletes your settings, food library, logs and weights from this browser. Export a backup first if you might want them back.', 'Erase everything', true);
      if (!ok) return;
      data = defaultData();
      saveData();
      toast('All data erased.');
      render();
    },
  });

  document.addEventListener('click', (ev) => {
    const nav = ev.target.closest('[data-nav]');
    if (nav) { setView(nav.dataset.nav); return; }
    const btn = ev.target.closest('[data-action]');
    if (btn && actions[btn.dataset.action]) {
      ev.preventDefault();
      actions[btn.dataset.action](btn.dataset, btn, ev);
    }
  });

  // =====================================================================
  // Rendering / routing
  // =====================================================================
  function setView(name) {
    if (!views[name]) name = 'today';
    ui.view = name;
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    document.querySelectorAll('.view').forEach((v) => {
      const active = v.dataset.view === ui.view;
      v.hidden = !active;
      if (active) views[ui.view](v);
    });
    document.querySelectorAll('[data-nav]').forEach((b) => {
      if (b.dataset.nav === ui.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  // =====================================================================
  // Boot
  // =====================================================================
  // Exposed for tests.html and console verification.
  window.FoodTracker = {
    constants: { STORAGE_KEY, SCHEMA_VERSION, G_PER_OZ, KG_PER_LB, CM_PER_IN, ACTIVITY },
    scaleNutrition, sumNutrition, checkPer100g, calcBmr, calcTdee, calculatedTarget, currentTarget,
    defaultData, normalize, validateBackup, mergeData, parseNum, fmtKcal, fmtG, dateKey, addDays,
    getData: () => data,
  };

  function boot() {
    if (!document.getElementById('app')) return; // loaded by tests.html
    data = loadData();
    const hash = location.hash.replace('#', '');
    ui.view = views[hash] ? hash : 'today';
    render();
    // If the app stays open past midnight, follow "today" when the user was viewing it.
    let lastToday = todayKey();
    const rollover = () => {
      const t = todayKey();
      if (t === lastToday) return;
      if (ui.date === lastToday) ui.date = t;
      lastToday = t;
      render();
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) rollover(); });
    setInterval(rollover, 60000);
    window.addEventListener('hashchange', () => {
      const h = location.hash.replace('#', '');
      if (views[h] && h !== ui.view) setView(h);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
