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
      <button type="button" class="btn" ${opts.onCancel ? 'id="fe-cancel"' : 'data-close'}>${opts.onCancel ? 'Back' : 'Cancel'}</button>
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
    const cancel = dlg.querySelector('#fe-cancel');
    if (cancel) cancel.addEventListener('click', () => opts.onCancel());
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
          <button type="button" class="btn" data-action="new-recipe">+ New recipe</button>
          <button type="button" class="btn" data-action="find-online">Find online</button>
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
  // mode 'log' = add to the day's log; 'library' = find foods online to save to the library.
  const addState = { mode: 'log', query: '', meal: 'breakfast', date: null, online: null };

  function openAddFood(meal) {
    addState.mode = 'log';
    addState.meal = meal || (ui.date === todayKey() ? guessMeal() : 'breakfast');
    addState.date = ui.date;
    addState.query = '';
    addState.online = null;
    drawAddFood();
  }
  function openFindOnline() {
    addState.mode = 'library';
    addState.query = ui.foodQuery || '';
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
    if (addState.mode === 'library') {
      if (q) {
        const lib = searchFoods(q);
        if (lib.length) html += `<div class="section-label">Already in my foods</div><ul class="list">${lib.map(libraryRowHtml).join('')}</ul>`;
      }
    } else if (!q) {
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
    const logMode = addState.mode === 'log';
    const body = `
      <div class="grid-2" ${logMode ? '' : 'hidden'}>
        <label class="field"><span>Meal</span><select id="af-meal">${MEALS.map((m) =>
          `<option value="${m.key}" ${m.key === meal ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
        <div class="field"><span>Day</span><div style="min-height:44px;display:flex;align-items:center"><b>${logMode ? esc(fmtDate(addState.date, { weekday: 'short', month: 'short', day: 'numeric' })) : ''}</b></div></div>
      </div>
      <form class="searchbar" id="af-form" role="search">
        <input type="search" id="af-q" placeholder="${hasOnline ? 'Food name or barcode' : 'Search my foods'}" value="${esc(addState.query)}" autocomplete="off" aria-label="Search foods">
        ${hasOnline ? '<button type="submit" class="btn primary">Search online</button>' : ''}
      </form>
      <div id="af-results">${addResultsHtml()}</div>`;
    const foot = `<button type="button" class="btn" id="af-manual">+ Create food manually</button>`;
    const dlg = modal.open(logMode ? 'Add food' : 'Find food online', body, foot);
    bindAddFood(dlg);
  }

  /** After a food is saved from the add flow: log mode continues to the amount; library mode returns. */
  function afterFoodSaved(f, back) {
    if (addState.mode === 'library') {
      modal.close();
      toast(`Saved “${f.name}” to your library.`);
      render();
    } else {
      openPortion({ src: foodSource(f), date: addState.date, meal: addState.meal, onBack: back });
    }
  }
  function startManualFood(back) {
    const draft = newFoodDraft();
    draft.name = addState.query.trim();
    openFoodEditor(draft, {
      saveLabel: addState.mode === 'library' ? 'Save food' : 'Save & continue',
      onCancel: back,
      onSaved: (f) => afterFoodSaved(f, back),
    });
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
        if (f && addState.mode === 'library') openFoodEditor(f, { onCancel: backToSearch });
        else if (f) openPortion({ src: foodSource(f), date: addState.date, meal: addState.meal, onBack: backToSearch });
        return;
      }
      if (typeof handleOnlineClick === 'function') handleOnlineClick(ev, backToSearch);
    });
    dlg.querySelector('#af-manual').addEventListener('click', () => startManualFood(backToSearch));
    qEl.focus();
  }


  // ---------------------------------------------------------------------
  // Online lookup: Open Food Facts (primary) and USDA FoodData Central (optional)
  // ---------------------------------------------------------------------
  const OFF_BASE = 'https://world.openfoodfacts.org';
  const OFF_FIELDS = 'code,product_name,product_name_en,generic_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit,product_quantity,product_quantity_unit,nutrition_data_per';
  const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1';
  const isBarcode = (q) => /^\d{8,14}$/.test(q.replace(/[\s-]/g, ''));

  async function fetchJson(url, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('The request timed out.');
      throw new Error('Network error — check your connection.');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new Error(res.status === 429 ? 'Too many searches — the service is rate-limiting. Wait a minute and try again.' : `The service responded with an error (HTTP ${res.status}).`);
      err.status = res.status;
      throw err;
    }
    try { return await res.json(); } catch (e) { throw new Error('The service returned an unreadable response.'); }
  }

  const toNum = (v) => {
    if (isNum(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  function addServing(list, label, grams) {
    if (!isNum(grams) || grams <= 0 || !label) return;
    if (list.some((s) => s.label === label)) return;
    list.push({ label, grams });
  }

  /** Normalizes an Open Food Facts product to per-100 g values + servings. Missing values stay null. */
  function normalizeOff(p) {
    if (!isObj(p)) return null;
    const n = isObj(p.nutriments) ? p.nutriments : {};
    const v = (key) => toNum(n[key + '_100g']);
    const notes = [];
    let kcal = v('energy-kcal');
    if (kcal == null) {
      const kj = v('energy-kj') != null ? v('energy-kj') : v('energy');
      if (kj != null) { kcal = kj / KJ_PER_KCAL; notes.push('Calories were converted from kilojoules (kJ ÷ 4.184).'); }
    }
    const per100g = {
      kcal, protein: v('proteins'), carbs: v('carbohydrates'), fat: v('fat'), fiber: v('fiber'), sugar: v('sugars'),
    };
    const servings = [];
    const sq = toNum(p.serving_quantity);
    const squ = String(p.serving_quantity_unit || 'g').toLowerCase();
    if (sq && (squ === 'g' || squ === 'ml')) addServing(servings, p.serving_size ? `1 serving (${String(p.serving_size).trim()})` : '1 serving', sq);
    const pq = toNum(p.product_quantity);
    const pqu = String(p.product_quantity_unit || 'g').toLowerCase();
    if (pq && (pqu === 'g' || pqu === 'ml')) addServing(servings, `1 package (${fmtQty(pq)} ${pqu})`, pq);
    if (String(p.nutrition_data_per || '').toLowerCase() === '100ml' || squ === 'ml' || pqu === 'ml') {
      notes.push('This product is measured by volume; values are per 100 ml and are treated as per 100 g (exact for water-like liquids).');
    }
    const name = String(p.product_name || p.product_name_en || p.generic_name || '').trim();
    return {
      source: 'openfoodfacts',
      sourceId: p.code ? String(p.code) : null,
      name: name || 'Unnamed product',
      brand: String(p.brands || '').split(',')[0].trim(),
      per100g, servings, notes,
    };
  }

  async function offSearch(q) {
    const code = q.replace(/[\s-]/g, '');
    if (isBarcode(q)) {
      try {
        const j = await fetchJson(`${OFF_BASE}/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`);
        return j && j.product && (j.status === 1 || j.status === 'success') ? [normalizeOff(Object.assign({ code }, j.product))].filter(Boolean) : [];
      } catch (e) {
        if (e.status === 404) return [];
        throw e;
      }
    }
    const j = await fetchJson(`${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=24&fields=${OFF_FIELDS}`);
    return (Array.isArray(j && j.products) ? j.products : []).map(normalizeOff).filter(Boolean);
  }

  /** Normalizes a USDA FoodData Central search hit. foodNutrients in search results are per 100 g. */
  function normalizeUsda(f) {
    if (!isObj(f)) return null;
    const byNum = {};
    (Array.isArray(f.foodNutrients) ? f.foodNutrients : []).forEach((n) => {
      const key = String(n.nutrientNumber || '');
      const val = toNum(n.value);
      if (key && val != null && !(key in byNum)) byNum[key] = { value: val, unit: String(n.unitName || '').toUpperCase() };
    });
    const get = (...keys) => { for (const k of keys) if (byNum[k]) return byNum[k].value; return null; };
    const notes = [];
    let kcal = null;
    if (byNum['208'] && byNum['208'].unit === 'KCAL') kcal = byNum['208'].value;
    else if (get('958', '957') != null) { kcal = get('958', '957'); notes.push('Calories use USDA’s Atwater-factor energy value.'); }
    else if (get('268') != null) { kcal = get('268') / KJ_PER_KCAL; notes.push('Calories were converted from kilojoules (kJ ÷ 4.184).'); }
    const per100g = {
      kcal, protein: get('203'), carbs: get('205'), fat: get('204'), fiber: get('291'), sugar: get('269', '269.3'),
    };
    const servings = [];
    const unit = String(f.servingSizeUnit || '').toLowerCase();
    if (toNum(f.servingSize) && (unit === 'g' || unit === 'grm' || unit === 'ml' || unit === 'mlt')) {
      addServing(servings, f.householdServingFullText ? `1 serving (${String(f.householdServingFullText).trim()})` : '1 serving', toNum(f.servingSize));
      if (unit === 'ml' || unit === 'mlt') notes.push('Serving is measured in ml; treated as grams (exact for water-like liquids).');
    }
    (Array.isArray(f.foodMeasures) ? f.foodMeasures : []).slice(0, 10).forEach((m) => {
      const label = String(m.disseminationText || '').trim();
      if (label && !/quantity not specified/i.test(label)) addServing(servings, label, toNum(m.gramWeight));
    });
    const name = String(f.description || '').trim();
    return {
      source: 'usda',
      sourceId: f.fdcId != null ? String(f.fdcId) : null,
      name: name || 'Unnamed food',
      brand: String(f.brandName || f.brandOwner || '').trim(),
      per100g, servings, notes,
      dataType: f.dataType || '',
    };
  }

  async function usdaSearch(q) {
    const key = data.settings.usdaApiKey;
    const url = `${USDA_BASE}/foods/search?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&pageSize=25`;
    try {
      const j = await fetchJson(url);
      return (Array.isArray(j && j.foods) ? j.foods : []).map(normalizeUsda).filter(Boolean);
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw new Error('USDA rejected the API key. Check it in Settings.');
      throw e;
    }
  }

  function searchOnline(q) {
    const run = { query: q, off: { status: 'loading' }, usda: data.settings.usdaApiKey ? { status: 'loading' } : null };
    addState.online = run;
    refreshAddResults();
    const settle = (slot, promise) => promise
      .then((results) => { run[slot] = { status: 'done', results }; })
      .catch((e) => { run[slot] = { status: 'error', error: e && e.message ? e.message : String(e) }; })
      .then(() => { if (addState.online === run) refreshAddResults(); });
    settle('off', offSearch(q));
    if (run.usda) settle('usda', usdaSearch(q));
  }

  function onlineRowHtml(r, slot, i) {
    const missing = NUTR_KEYS.filter((k) => !isNum(r.per100g[k]));
    return `<li><button type="button" class="list-item" data-online="${slot}:${i}">
      <div class="title">${esc(r.name)}${missing.length ? ' <span class="badge missing">incomplete</span>' : ''}${r.notes.length ? ' <span class="badge warn">check</span>' : ''}</div>
      <div class="sub">${r.brand ? esc(r.brand) + ' · ' : ''}${r.dataType ? esc(r.dataType) + ' · ' : ''}${per100Html(r.per100g)}${r.servings.length ? ` · ${r.servings.length} serving size${r.servings.length > 1 ? 's' : ''}` : ''}</div>
    </button></li>`;
  }

  function onlineSectionHtml(slot, title) {
    const st = addState.online[slot];
    if (!st) return '';
    let inner;
    if (st.status === 'loading') inner = `<div class="list-empty">Searching…</div>`;
    else if (st.status === 'error') {
      inner = `<div class="msg error"><b>${esc(title)} lookup failed:</b> ${esc(st.error)}
        <div class="row" style="margin-top:8px"><button type="button" class="btn small" data-retry-online>Try again</button>
        <button type="button" class="btn small" data-manual-fallback>Enter food manually</button></div></div>`;
    } else if (!st.results.length) inner = `<div class="list-empty">No results. <button type="button" class="btn small" data-manual-fallback>Enter food manually</button></div>`;
    else inner = `<ul class="list">${st.results.map((r, i) => onlineRowHtml(r, slot, i)).join('')}</ul>`;
    return `<div class="section-label">${esc(title)}</div>${inner}`;
  }

  function onlineResultsHtml() {
    const q = addState.query.trim();
    const sources = 'Open Food Facts' + (data.settings.usdaApiKey ? ' and USDA' : '');
    if (!addState.online || addState.online.query !== q) {
      if (!q) return addState.mode === 'library' ? `<p class="small muted">Type a food name or a barcode number, then search ${sources}.</p>` : '';
      return `<div class="section-label">Online</div>
        <button type="button" class="btn block" data-search-online>${isBarcode(q) ? 'Look up barcode' : 'Search'} “${esc(q)}” in ${sources}</button>`;
    }
    return onlineSectionHtml('off', isBarcode(q) ? 'Open Food Facts — barcode' : 'Open Food Facts') + onlineSectionHtml('usda', 'USDA FoodData Central') +
      `<p class="small muted">Values are shown per 100 g. Results marked <span class="badge missing">incomplete</span> need missing values filled in before saving.</p>`;
  }

  function pickOnline(r, back) {
    const existing = r.sourceId && data.foods.find((f) => f.source === r.source && f.sourceId === r.sourceId);
    if (existing) {
      toast('Already in your library — using your saved version.');
      if (addState.mode === 'library') openFoodEditor(existing, { onCancel: back });
      else openPortion({ src: foodSource(existing), date: addState.date, meal: addState.meal, onBack: back });
      return;
    }
    const draft = newFoodDraft();
    Object.assign(draft, {
      name: r.name, brand: r.brand, source: r.source, sourceId: r.sourceId,
      per100g: clone(r.per100g), servings: clone(r.servings),
    });
    openFoodEditor(draft, {
      title: 'Review & save',
      saveLabel: addState.mode === 'library' ? 'Save to library' : 'Save to library & continue',
      notes: r.notes,
      onCancel: back,
      onSaved: (f) => afterFoodSaved(f, back),
    });
  }

  function handleOnlineClick(ev, back) {
    if (ev.target.closest('[data-search-online]') || ev.target.closest('[data-retry-online]')) {
      const q = addState.query.trim();
      if (q) searchOnline(q);
      return;
    }
    if (ev.target.closest('[data-manual-fallback]')) { startManualFood(back); return; }
    const btn = ev.target.closest('[data-online]');
    if (!btn || !addState.online) return;
    const [slot, i] = btn.dataset.online.split(':');
    const st = addState.online[slot];
    const r = st && st.results && st.results[Number(i)];
    if (r) pickOnline(r, back);
  }
  actions['find-online'] = openFindOnline;


  // ---------------------------------------------------------------------
  // Copy previous day / meal
  // ---------------------------------------------------------------------
  function copyEntries(fromKey, toKey, meal) {
    const src = entriesFor(fromKey).filter((e) => !meal || e.meal === meal);
    if (!src.length) return 0;
    const list = data.logs[toKey] || (data.logs[toKey] = []);
    src.forEach((e) => list.push(Object.assign(clone(e), { id: uid(), createdAt: nowIso() })));
    saveData();
    return src.length;
  }
  const prevDayPhrase = () => (ui.date === todayKey() ? 'yesterday' : fmtDate(addDays(ui.date, -1), { month: 'short', day: 'numeric' }));

  function copyMealButtonHtml(meal) {
    const n = entriesFor(addDays(ui.date, -1)).filter((e) => e.meal === meal.key).length;
    if (!n) return '';
    const label = ui.date === todayKey() ? `Copy yesterday's ${meal.label.toLowerCase()}` : `Copy ${meal.label.toLowerCase()} from ${prevDayPhrase()}`;
    return `<div style="padding:6px 8px;border-top:1px solid var(--border)"><button type="button" class="btn ghost small" data-action="copy-meal" data-meal="${meal.key}">⧉ ${esc(label)} (${n} item${n > 1 ? 's' : ''})</button></div>`;
  }
  function copyDayButtonHtml() {
    const n = entriesFor(addDays(ui.date, -1)).length;
    return `<button type="button" class="btn" data-action="copy-day" ${n ? '' : 'disabled title="Nothing logged on the previous day"'}>⧉ Copy entire previous day</button>`;
  }

  actions['copy-meal'] = (ds) => {
    const n = copyEntries(addDays(ui.date, -1), ui.date, ds.meal);
    toast(n ? `Copied ${n} item${n > 1 ? 's' : ''} to ${mealLabel(ds.meal)}.` : 'Nothing to copy.');
    render();
  };
  actions['copy-day'] = async () => {
    const from = addDays(ui.date, -1);
    const n = entriesFor(from).length;
    if (!n) { toast('Nothing logged on the previous day.'); return; }
    if (entriesFor(ui.date).length) {
      const ok = await confirmAsk('Copy previous day?', `Add all ${n} entries from ${fmtDate(from)} to this day? Entries already here are kept.`, 'Copy');
      if (!ok) return;
    }
    copyEntries(from, ui.date, null);
    toast(`Copied ${n} entr${n > 1 ? 'ies' : 'y'} from ${prevDayPhrase()}.`);
    render();
  };

  // ---------------------------------------------------------------------
  // Recipes: nutrition computed from ingredients; per 100 g of the cooked dish
  // ---------------------------------------------------------------------
  /** totals = Σ ingredient per100g × grams / 100; per100g = totals × 100 / (cooked weight or raw weight). */
  function computeRecipe(ingredients, cookedWeightG) {
    const rawWeight = ingredients.reduce((a, i) => a + i.grams, 0);
    const totals = sumNutrition(ingredients.map((i) => scaleNutrition(i.per100g, i.grams)));
    const weight = isNum(cookedWeightG) && cookedWeightG > 0 ? cookedWeightG : rawWeight;
    const per100g = {};
    NUTR_KEYS.forEach((k) => { per100g[k] = weight > 0 ? (totals[k] * 100) / weight : NaN; });
    return { rawWeight, weight, totals, per100g };
  }

  function openRecipeEditor(food) {
    const existing = !!(food && getFood(food.id));
    const f = food ? clone(food) : Object.assign(newFoodDraft(), { source: 'recipe', recipe: { ingredients: [], cookedWeightG: null, portions: null } });
    const snaps = f.recipe.ingredients; // snapshots used if an ingredient was removed from the library
    const choices = searchFoods('').filter((x) => x.id !== f.id && NUTR_KEYS.every((k) => isNum(x.per100g[k])));
    const optionsHtml = (selected, snapIdx) => {
      let html = '<option value="">Choose a food…</option>';
      if (snapIdx != null && !getFood(snaps[snapIdx].foodId)) {
        html += `<option value="snap:${snapIdx}" selected>${esc(snaps[snapIdx].name)} (no longer in library)</option>`;
      }
      html += choices.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}${c.brand ? ' — ' + esc(c.brand) : ''}</option>`).join('');
      return html;
    };
    const rowHtml = (ing, idx) => `<div class="ingredient-row">
        <label class="field"><span>Ingredient</span><select class="ig-food">${optionsHtml(ing ? ing.foodId : '', ing ? idx : null)}</select></label>
        <label class="field"><span>Grams</span><input class="ig-grams" inputmode="decimal" value="${ing ? inputVal(ing.grams) : ''}"></label>
        <button type="button" class="btn ghost icon ig-remove" aria-label="Remove ingredient">✕</button>
        <div class="mac muted ig-info"></div>
      </div>`;
    const body = `
      <label class="field"><span>Recipe name *</span><input id="rc-name" value="${esc(f.name)}" autocomplete="off"></label>
      <h3>Ingredients</h3>
      ${choices.length ? '' : '<p class="msg info">Add the ingredients to your food library first, then combine them here.</p>'}
      <div id="rc-rows">${snaps.length ? snaps.map(rowHtml).join('') : rowHtml(null, null)}</div>
      <button type="button" class="btn small" id="rc-add">+ Add ingredient</button>
      <div class="grid-2">
        <label class="field"><span>Total cooked weight (g)</span><input id="rc-cooked" inputmode="decimal" value="${inputVal(f.recipe.cookedWeightG)}">
          <span class="hint">Weigh the finished dish. Leave empty to use the raw ingredient total.</span></label>
        <label class="field"><span>Portions (optional)</span><input id="rc-portions" inputmode="decimal" value="${inputVal(f.recipe.portions)}">
          <span class="hint">Adds a “1 portion” serving size.</span></label>
      </div>
      <div class="preview" id="rc-summary"></div>
      <div id="rc-errors"></div>`;
    const foot = `${existing ? '<button type="button" class="btn danger" id="rc-delete">Delete</button><span class="grow"></span>' : ''}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" id="rc-save">Save recipe</button>`;
    const dlg = modal.open(existing ? 'Edit recipe' : 'New recipe', body, foot);
    const rowsEl = dlg.querySelector('#rc-rows');

    const sourceFor = (val) => {
      if (!val) return null;
      if (val.startsWith('snap:')) { const sn = snaps[Number(val.slice(5))]; return sn ? { foodId: sn.foodId, name: sn.name, per100g: sn.per100g } : null; }
      const lf = getFood(val);
      return lf ? { foodId: lf.id, name: lf.name, per100g: normNutr(lf.per100g, NUTR_KEYS) } : null;
    };
    const read = () => {
      const errors = [];
      const ingredients = [];
      rowsEl.querySelectorAll('.ingredient-row').forEach((row, i) => {
        const sel = row.querySelector('.ig-food');
        const gEl = row.querySelector('.ig-grams');
        const src = sourceFor(sel.value);
        const g = readNum(gEl);
        const info = row.querySelector('.ig-info');
        if (!src && g === null) { info.textContent = ''; return; }
        if (!src) { errors.push(`Ingredient #${i + 1}: choose a food.`); info.textContent = ''; return; }
        if (!isNum(g) || g <= 0) { errors.push(`Ingredient #${i + 1} (${src.name}): enter grams greater than 0.`); info.textContent = ''; return; }
        const n = scaleNutrition(src.per100g, g);
        info.innerHTML = `${fmtKcal(n.kcal)} kcal · ${macHtml(n)}`;
        ingredients.push({ foodId: src.foodId, name: src.name, grams: g, per100g: clone(src.per100g) });
      });
      const cooked = readNum(dlg.querySelector('#rc-cooked'));
      if (cooked !== null && (!isNum(cooked) || cooked <= 0)) errors.push('Cooked weight must be a number greater than 0, or empty.');
      const portions = readNum(dlg.querySelector('#rc-portions'));
      if (portions !== null && (!isNum(portions) || portions <= 0)) errors.push('Portions must be a number greater than 0, or empty.');
      return { errors, ingredients, cooked: isNum(cooked) && cooked > 0 ? cooked : null, portions: isNum(portions) && portions > 0 ? portions : null };
    };
    const summary = () => {
      const r = read();
      const box = dlg.querySelector('#rc-summary');
      if (!r.ingredients.length) { box.innerHTML = '<span class="muted">Add ingredients to see the nutrition.</span>'; return r; }
      const c = computeRecipe(r.ingredients, r.cooked);
      const ratio = r.cooked ? r.cooked / c.rawWeight : 1;
      box.innerHTML = `<div><b>Whole recipe:</b> ${fmtKcal(c.totals.kcal)} kcal · <span class="mac">${macHtml(c.totals)}</span></div>
        <div class="small muted">Raw ingredients ${fmtQty(c.rawWeight)} g${r.cooked ? ` → cooked ${fmtQty(r.cooked)} g (${Math.round(ratio * 100)}% of raw)` : ''}</div>
        <div style="margin-top:6px"><b>Per 100 g ${r.cooked ? 'cooked' : ''}:</b> ${fmtKcal(c.per100g.kcal)} kcal · <span class="mac">${macHtml(c.per100g)}</span></div>
        ${r.portions ? `<div><b>Per portion</b> (${fmtQty(c.weight / r.portions)} g): ${fmtKcal(c.totals.kcal / r.portions)} kcal · <span class="mac">${macHtml(scaleNutrition(c.per100g, c.weight / r.portions))}</span></div>` : ''}`;
      return r;
    };
    dlg.querySelector('.modal-body').addEventListener('input', summary);
    dlg.querySelector('.modal-body').addEventListener('change', summary);
    dlg.querySelector('#rc-add').addEventListener('click', () => { rowsEl.insertAdjacentHTML('beforeend', rowHtml(null, null)); summary(); });
    rowsEl.addEventListener('click', (ev) => {
      const rm = ev.target.closest('.ig-remove');
      if (rm) { rm.closest('.ingredient-row').remove(); summary(); }
    });
    const del = dlg.querySelector('#rc-delete');
    if (del) del.addEventListener('click', async () => { if (await deleteFood(f.id)) { modal.close(); render(); } });
    dlg.querySelector('#rc-save').addEventListener('click', () => {
      const r = summary();
      const name = dlg.querySelector('#rc-name').value.trim();
      const errors = r.errors.slice();
      if (!name) errors.unshift('Recipe name is required.');
      if (!r.ingredients.length) errors.push('Add at least one ingredient.');
      const box = dlg.querySelector('#rc-errors');
      if (errors.length) {
        box.innerHTML = `<div class="msg error"><b>Can't save yet:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
        return;
      }
      const c = computeRecipe(r.ingredients, r.cooked);
      f.name = name;
      f.source = 'recipe';
      f.per100g = Object.assign(c.per100g, { fiber: null, sugar: null });
      f.recipe = { ingredients: r.ingredients, cookedWeightG: r.cooked, portions: r.portions };
      f.servings = [];
      if (r.portions) f.servings.push({ label: `1 portion (1/${fmtQty(r.portions)} of recipe)`, grams: c.weight / r.portions });
      f.servings.push({ label: 'Whole recipe', grams: c.weight });
      upsertFood(f);
      modal.close();
      toast(existing ? 'Recipe updated. Past log entries keep their original values.' : 'Recipe saved.');
      render();
    });
    summary();
    if (!existing) dlg.querySelector('#rc-name').focus();
  }
  actions['new-recipe'] = () => openRecipeEditor(null);

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
        <button type="button" class="btn small primary" data-action="add-food" data-meal="${meal.key}" aria-label="Add food to ${meal.label}">+ Add</button>
      </div>
      ${list.length ? `<ul>${list.map(entryHtml).join('')}</ul>
        <div class="subtotal"><span>${meal.label} subtotal</span><span class="kcal num">${fmtKcal(sub.kcal)} kcal</span><span class="mac">${macHtml(sub)}</span></div>`
        : `<div class="empty">Nothing logged.</div>`}
      ${mealToolsHtml(meal)}
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
  // ---------------------------------------------------------------------
  // Weight tracking
  // ---------------------------------------------------------------------
  /** 7-day moving average: mean of entries dated within [d−6, d] (calendar days), per entry. */
  function weightSeries() {
    const w = data.weights;
    return w.map((e, i) => {
      const start = addDays(e.date, -6);
      let sum = 0;
      let n = 0;
      for (let j = i; j >= 0 && w[j].date >= start; j--) { sum += w[j].kg; n++; }
      return { date: e.date, kg: e.kg, ma: sum / n, maCount: n };
    });
  }
  /** The latest entry dated on or before `k`. */
  function weightOnOrBefore(k) {
    let found = null;
    for (const e of data.weights) { if (e.date <= k) found = e; else break; }
    return found;
  }

  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return ticks;
  }

  /** Chart width in CSS px so SVG text renders at its real size on phones. */
  function chartWidth(root) { return Math.max(280, Math.min(720, (root.clientWidth || 640) - 34)); }

  function weightChartSvg(series, W) {
    const H = W < 480 ? 210 : 250, L = 40, R = 10, T = 12, B = 28;
    const pts = series.map((s) => ({ date: s.date, x: daysBetween(series[0].date, s.date), y: kgToDisplay(s.kg), ma: kgToDisplay(s.ma), n: s.maCount }));
    const xMax = Math.max(1, pts[pts.length - 1].x);
    let yMin = Math.min(...pts.map((p) => Math.min(p.y, p.ma)));
    let yMax = Math.max(...pts.map((p) => Math.max(p.y, p.ma)));
    const pad = Math.max(0.5, (yMax - yMin) * 0.12);
    yMin -= pad; yMax += pad;
    const sx = (x) => L + (pts.length === 1 ? (W - L - R) / 2 : (x / xMax) * (W - L - R));
    const sy = (y) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
    const unit = weightUnit();
    let g = '';
    niceTicks(yMin, yMax, 4).forEach((v) => {
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/><text x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${fmtQty(v)}</text>`;
    });
    const xl = pts.length > 2 ? [pts[0], pts[Math.floor((pts.length - 1) / 2)], pts[pts.length - 1]] : pts.length > 1 ? [pts[0], pts[pts.length - 1]] : [pts[0]];
    [...new Set(xl)].forEach((p, i, arr) => {
      const anchor = arr.length > 1 && i === 0 ? 'start' : arr.length > 1 && i === arr.length - 1 ? 'end' : 'middle';
      g += `<text x="${sx(p.x)}" y="${H - 8}" text-anchor="${anchor}">${esc(fmtDate(p.date, { month: 'short', day: 'numeric' }))}</text>`;
    });
    const line = (key) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p[key]).toFixed(1)}`).join('');
    if (pts.length > 1) g += `<path class="raw-line" d="${line('y')}"/><path class="ma" d="${line('ma')}"/>`;
    pts.forEach((p) => {
      g += `<g><title>${esc(fmtDate(p.date))}: ${fmtG(p.y)} ${unit} · 7-day avg ${fmtG(p.ma)} ${unit} (${p.n} entr${p.n === 1 ? 'y' : 'ies'})</title>
        <circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="12" fill="transparent"/>
        <circle class="raw" cx="${sx(p.x)}" cy="${sy(p.y)}" r="4"/></g>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight chart with 7-day moving average">${g}</svg>`;
  }

  ui.weightRange = 90;
  views.weight = function (root) {
    const unit = weightUnit();
    const all = weightSeries();
    const latest = all[all.length - 1];
    const change = (ref) => (latest && ref ? fmtSigned(kgToDisplay(latest.kg) - kgToDisplay(ref.kg), fmtG) + ' ' + unit : '—');
    const first = data.weights[0];
    const ago7 = latest && weightOnOrBefore(addDays(latest.date, -7));
    const ago30 = latest && weightOnOrBefore(addDays(latest.date, -30));
    const shown = ui.weightRange && latest ? all.filter((s) => s.date > addDays(latest.date, -ui.weightRange)) : all;
    root.innerHTML = `
      <form class="card" id="weight-form" novalidate>
        <h2>Log weight</h2>
        <div class="grid-2">
          <label class="field"><span>Date</span><input type="date" id="w-date" value="${todayKey()}" max="${todayKey()}"></label>
          <label class="field"><span>Weight (${unit})</span><input id="w-kg" inputmode="decimal" autocomplete="off" placeholder="${latest ? fmtG(kgToDisplay(latest.kg)) : ''}"></label>
        </div>
        <div id="w-error"></div>
        <div class="row end"><button type="submit" class="btn primary">Save weight</button></div>
      </form>
      <div class="card">
        <h2>Progress</h2>
        <div class="stats">
          <div class="stat"><span class="label">Latest${latest ? ' · ' + esc(fmtDate(latest.date, { month: 'short', day: 'numeric' })) : ''}</span><strong>${latest ? fmtWeight(latest.kg) : '—'}</strong></div>
          <div class="stat"><span class="label">Since first entry${first ? ' (' + esc(fmtDate(first.date, { month: 'short', day: 'numeric' })) + ')' : ''}</span><strong>${change(first)}</strong></div>
          <div class="stat"><span class="label">vs. 7 days ago${ago7 ? ' (' + esc(fmtDate(ago7.date, { month: 'short', day: 'numeric' })) + ')' : ''}</span><strong>${change(ago7)}</strong></div>
          <div class="stat"><span class="label">vs. 30 days ago${ago30 ? ' (' + esc(fmtDate(ago30.date, { month: 'short', day: 'numeric' })) + ')' : ''}</span><strong>${change(ago30)}</strong></div>
        </div>
        <p class="small muted">“7/30 days ago” compares with the most recent entry on or before that date.</p>
      </div>
      <div class="card">
        <div class="card-head"><h2>Trend</h2>
          <select id="w-range" aria-label="Chart range" style="width:auto">
            ${[[30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year'], [0, 'All time']].map(([v, l]) =>
              `<option value="${v}" ${ui.weightRange === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
        ${shown.length ? weightChartSvg(shown, chartWidth(root)) + `<div class="legend"><span><i style="background:var(--accent)"></i>Daily weight</span><span><i style="background:var(--warn)"></i>7-day moving average</span></div>`
          : '<p class="muted">Log your weight to see the trend.</p>'}
      </div>
      <div class="card">
        <h2>Entries</h2>
        ${all.length ? `<div class="weight-list table-wrap"><table class="data">
          <thead><tr><th>Date</th><th>Weight (${unit})</th><th>7-day avg</th><th><span class="sr-only">Delete</span></th></tr></thead>
          <tbody>${all.slice().reverse().map((s) => `<tr><td>${esc(fmtDate(s.date))}</td><td>${fmtG(kgToDisplay(s.kg))}</td><td>${fmtG(kgToDisplay(s.ma))}</td>
            <td><button type="button" class="btn ghost small" data-action="delete-weight" data-date="${s.date}" aria-label="Delete ${esc(fmtDate(s.date))}">✕</button></td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">No entries yet.</p>'}
      </div>`;

    root.querySelector('#w-range').addEventListener('change', (ev) => { ui.weightRange = Number(ev.target.value); render(); });
    root.querySelector('#weight-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const date = root.querySelector('#w-date').value;
      const wEl = root.querySelector('#w-kg');
      const v = readNum(wEl);
      const err = root.querySelector('#w-error');
      let msg = '';
      if (!isDateKey(date)) msg = 'Pick a valid date.';
      else if (v === null) msg = 'Enter your weight.';
      else if (!isNum(v) || v <= 0) msg = 'Weight must be a number greater than 0.';
      else if (displayToKg(v) > 700) msg = 'That weight looks too large.';
      if (msg) { wEl.classList.add('invalid'); err.innerHTML = `<p class="msg error">${esc(msg)}</p>`; return; }
      await logWeight(date, displayToKg(v));
      render();
    });
  };

  async function logWeight(date, kg) {
    const existing = data.weights.find((w) => w.date === date);
    if (existing) {
      const ok = await confirmAsk('Replace entry?', `You already logged ${fmtWeight(existing.kg)} on ${fmtDate(date)}. Replace it with ${fmtWeight(kg)}?`, 'Replace');
      if (!ok) return;
      existing.kg = kg;
    } else {
      data.weights.push({ date, kg });
      data.weights.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    saveData();
    toast('Weight saved.');

    // Offer to recalculate the target when this is the newest weigh-in.
    const s = data.settings;
    const isNewest = data.weights[data.weights.length - 1].date === date;
    if (!isNewest || s.targetMode !== 'calculated' || (isNum(s.profile.weightKg) && Math.abs(s.profile.weightKg - kg) < 1e-9)) return;
    const candidate = clone(s);
    candidate.profile.weightKg = kg;
    const before = calculatedTarget(s);
    const after = calculatedTarget(candidate);
    if (!isNum(after)) return;
    const ok = await ask({
      title: 'Recalculate target?',
      message: `Update your profile weight to ${fmtWeight(kg)} and recalculate your daily target${isNum(before) ? ` (${fmtKcal(before)} → ${fmtKcal(after)} kcal)` : ` (${fmtKcal(after)} kcal)`}?`,
      buttons: [{ label: 'Not now', value: false }, { label: 'Update target', value: true, kind: 'primary' }],
    });
    if (ok) {
      s.profile.weightKg = kg;
      syncTargetHistory();
      saveData();
      toast(`Target updated to ${fmtKcal(after)} kcal.`);
    }
  }

  actions['delete-weight'] = async (ds) => {
    const w = data.weights.find((x) => x.date === ds.date);
    if (!w) return;
    if (!(await confirmAsk('Delete weight entry?', `Delete ${fmtWeight(w.kg)} on ${fmtDate(w.date)}?`, 'Delete', true))) return;
    data.weights = data.weights.filter((x) => x.date !== ds.date);
    saveData();
    render();
  };
  // ---------------------------------------------------------------------
  // History & trends
  // ---------------------------------------------------------------------
  function dayStatus(k) {
    const entries = entriesFor(k);
    if (!entries.length) return null;
    const eaten = sumNutrition(entries.map((e) => e.nutrition)).kcal;
    const target = targetForDate(k);
    return { date: k, eaten, target, over: isNum(target) ? eaten > target : null };
  }

  /** Averages over logged days in the `days`-day window ending at `endKey` (inclusive). */
  function windowStats(endKey, days) {
    const logged = [];
    for (let i = days - 1; i >= 0; i--) {
      const st = dayStatus(addDays(endKey, -i));
      if (st) logged.push(st);
    }
    const n = logged.length;
    const tdee = calcTdee(data.settings.profile);
    const withTarget = logged.filter((d) => isNum(d.target));
    const avg = (arr, f) => (arr.length ? arr.reduce((a, d) => a + f(d), 0) / arr.length : null);
    return {
      start: addDays(endKey, -(days - 1)), end: endKey, days, logged: n,
      avgEaten: avg(logged, (d) => d.eaten),
      avgTarget: avg(withTarget, (d) => d.target),
      avgVsTarget: avg(withTarget, (d) => d.eaten - d.target),
      daysOver: withTarget.filter((d) => d.over).length,
      tdee,
      avgDeficit: isNum(tdee) && n ? avg(logged, (d) => tdee - d.eaten) : null,
    };
  }

  function weekChartSvg(endKey, W) {
    const H = 220, L = 40, R = 8, T = 22, B = 30;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const k = addDays(endKey, -i);
      const st = dayStatus(k);
      days.push({ k, eaten: st ? st.eaten : null, target: targetForDate(k) });
    }
    const yMax = Math.max(500, ...days.map((d) => Math.max(d.eaten || 0, isNum(d.target) ? d.target : 0))) * 1.12;
    const sy = (v) => T + (1 - v / yMax) * (H - T - B);
    const slot = (W - L - R) / 7;
    const bw = Math.min(44, slot * 0.62);
    let g = '';
    niceTicks(0, yMax, 4).forEach((v) => {
      g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/><text x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${v >= 1000 ? fmtQty(v / 1000) + 'k' : fmtQty(v)}</text>`;
    });
    days.forEach((d, i) => {
      const cx = L + slot * i + slot / 2;
      const x = cx - bw / 2;
      const label = parseKey(d.k).toLocaleDateString(undefined, { weekday: 'short' });
      const isToday = d.k === todayKey();
      let tip = `${fmtDate(d.k, { weekday: 'short', month: 'short', day: 'numeric' })}: `;
      if (isNum(d.eaten)) {
        const over = isNum(d.target) && d.eaten > d.target;
        const top = sy(d.eaten);
        const h = Math.max(2, H - B - top);
        const r = Math.min(4, bw / 2, h);
        g += `<path class="${isNum(d.target) ? (over ? 'bar-over' : 'bar-under') : 'bar-none'}" d="M${x},${H - B}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${H - B}Z"/>`;
        const labelY = Math.min(top, isNum(d.target) ? sy(d.target) : top) - 5;
        g += `<text class="bar-label" x="${cx}" y="${labelY}" text-anchor="middle">${fmtKcal(d.eaten)}</text>`;
        tip += `${fmtKcal(d.eaten)} kcal` + (isNum(d.target) ? ` of ${fmtKcal(d.target)} target (${fmtSigned(d.eaten - d.target, fmtKcal)})` : '');
      } else {
        tip += 'nothing logged';
      }
      if (isNum(d.target)) g += `<line class="target" x1="${cx - slot * 0.45}" x2="${cx + slot * 0.45}" y1="${sy(d.target)}" y2="${sy(d.target)}"/>`;
      g += `<text x="${cx}" y="${H - 10}" text-anchor="middle" ${isToday ? 'style="font-weight:700"' : ''}>${esc(label)}</text>`;
      g += `<rect x="${cx - slot / 2}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent" data-goto="${d.k}" style="cursor:pointer"><title>${esc(tip)}</title></rect>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Calories per day for the last 7 days against target">${g}</svg>`;
  }

  function calendarHtml(monthKey) {
    const first = parseKey(monthKey);
    const y = first.getFullYear();
    const m = first.getMonth();
    const daysIn = new Date(y, m + 1, 0).getDate();
    // Monday-first grid
    const lead = (first.getDay() + 6) % 7;
    const today = todayKey();
    let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('');
    for (let i = 0; i < lead; i++) cells += '<div class="day blank"></div>';
    for (let d = 1; d <= daysIn; d++) {
      const k = dateKey(new Date(y, m, d));
      const st = dayStatus(k);
      const cls = ['day'];
      if (st && st.over === true) cls.push('over');
      else if (st && st.over === false) cls.push('under');
      if (k === today) cls.push('today');
      if (k > today) cls.push('future');
      const state = st ? (st.over === true ? 'over target' : st.over === false ? 'under target' : 'no target') : 'nothing logged';
      cells += `<button type="button" class="${cls.join(' ')}" ${k > today ? 'disabled' : `data-goto="${k}"`} aria-label="${esc(fmtDate(k))}: ${st ? fmtKcal(st.eaten) + ' kcal, ' : ''}${state}">
        <span class="d">${d}</span>${st ? `<span class="k">${fmtKcal(st.eaten)}</span>${st.over === true ? '<span class="k" aria-hidden="true">▲</span>' : st.over === false ? '<span class="k" aria-hidden="true">✓</span>' : ''}` : ''}</button>`;
    }
    return `<div class="calendar">${cells}</div>`;
  }

  ui.histMonth = null;
  ui.includeToday = false;
  views.history = function (root) {
    const today = todayKey();
    if (!ui.histMonth) ui.histMonth = today.slice(0, 8) + '01';
    const end = ui.includeToday ? today : addDays(today, -1);
    const s7 = windowStats(end, 7);
    const s30 = windowStats(end, 30);
    const range = (st) => `${fmtDate(st.start, { month: 'short', day: 'numeric' })} – ${fmtDate(st.end, { month: 'short', day: 'numeric' })}`;
    const vs = (v) => (isNum(v) ? `${fmtSigned(v, fmtKcal)} kcal` : '—');
    const row = (label, f) => `<tr><td>${label}</td><td>${f(s7)}</td><td>${f(s30)}</td></tr>`;
    const monthName = parseKey(ui.histMonth).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const thisMonth = today.slice(0, 8) + '01';
    root.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Last 7 days</h2></div>
        ${weekChartSvg(today, chartWidth(root))}
        <div class="legend"><span><i style="background:var(--good)"></i>At or under target</span><span><i style="background:var(--danger)"></i>Over target</span><span><i style="background:var(--text);height:2px"></i>Daily target</span></div>
        <p>Weekly average: <b>${s7.logged ? fmtKcal(s7.avgEaten) + ' kcal/day' : '—'}</b>${isNum(s7.avgVsTarget) ? ` <span class="muted">(${vs(s7.avgVsTarget)} vs. target)</span>` : ''}
          <br><span class="small muted">${range(s7)}, ${s7.logged} logged day${s7.logged === 1 ? '' : 's'}.</span></p>
      </div>
      <div class="card">
        <div class="card-head"><h2>Averages</h2>
          <label class="row small"><input type="checkbox" id="h-today" ${ui.includeToday ? 'checked' : ''} style="width:20px;height:20px"> Include today</label></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th></th><th>7 days<br><span class="muted">${range(s7)}</span></th><th>30 days<br><span class="muted">${range(s30)}</span></th></tr></thead>
          <tbody>
            ${row('Days logged', (st) => `${st.logged}/${st.days}`)}
            ${row('Avg calories', (st) => (st.logged ? fmtKcal(st.avgEaten) + ' kcal' : '—'))}
            ${row('Avg target', (st) => (isNum(st.avgTarget) ? fmtKcal(st.avgTarget) + ' kcal' : '—'))}
            ${row('Avg vs. target', (st) => vs(st.avgVsTarget))}
            ${row('Days over target', (st) => (isNum(st.avgTarget) ? String(st.daysOver) : '—'))}
            ${row('Avg daily deficit', (st) => (isNum(st.avgDeficit) ? fmtKcal(st.avgDeficit) + ' kcal' : '—'))}
          </tbody>
        </table></div>
        <p class="small muted">Averages use only days with at least one entry, so unlogged days don't count as zero.
          “vs. target” is negative when you ate under target. “Avg deficit” is your current TDEE${isNum(s7.tdee) ? ` (${fmtKcal(s7.tdee)} kcal)` : ' (set your profile in Settings)'} minus average intake.
          ${ui.includeToday ? '' : 'Today is excluded because it is still in progress.'}</p>
      </div>
      <div class="card">
        <div class="card-head">
          <button type="button" class="btn icon" data-action="month-prev" aria-label="Previous month">‹</button>
          <h2 style="text-align:center">${esc(monthName)}</h2>
          <button type="button" class="btn icon" data-action="month-next" aria-label="Next month" ${ui.histMonth >= thisMonth ? 'disabled' : ''}>›</button>
        </div>
        ${calendarHtml(ui.histMonth)}
        <p class="small muted">Green ✓ = at or under that day's target, red ▲ = over. Tap a day to open it.</p>
      </div>`;
    root.querySelector('#h-today').addEventListener('change', (ev) => { ui.includeToday = ev.target.checked; render(); });
    // Assigned (not added) because the view root persists across renders.
    root.onclick = (ev) => {
      const g = ev.target.closest('[data-goto]');
      if (g) { ui.date = g.getAttribute('data-goto'); setView('today'); }
    };
  };
  const shiftMonth = (n) => { const d = parseKey(ui.histMonth); d.setMonth(d.getMonth() + n, 1); ui.histMonth = dateKey(d); render(); };
  actions['month-prev'] = () => shiftMonth(-1);
  actions['month-next'] = () => shiftMonth(1);

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
    computeRecipe, normalizeOff, normalizeUsda,
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
    // Charts are sized to their container, so redraw them when the width changes.
    let resizeTimer = null;
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;
        if ((ui.view === 'weight' || ui.view === 'history') && !document.getElementById('modal').open) render();
      }, 200);
    });
    setInterval(rollover, 60000);
    window.addEventListener('hashchange', () => {
      const h = location.hash.replace('#', '');
      if (views[h] && h !== ui.view) setView(h);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
