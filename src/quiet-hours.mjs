/**
 * quiet-hours.mjs — 工作日静默时段（免打扰）。
 *
 * 规则（config.json 的 quietHours 可改）：
 *   · 时区固定 UTC+8，不看机器时区；
 *   · 工作日（周一至周五，且非法定节假日；调休补班日算工作日）的 09:00–12:00、14:00–18:00 静默；
 *   · 周末与法定节假日全天正常；
 *   · 静默期只允许「管理员 @ / 引用」这一种例外，回完即停；
 *   · 临时覆盖（15 分钟 / 跳过一个窗口 / 当天 / 取消）：覆盖期间是**被动模式**——
 *     任何人 @ 都回，但依然不主动、不等待、不设唤醒。
 *
 * 这个模块只管「现在该是什么状态」，不做任何副作用；桥接负责按状态执行。
 */
import fs from 'node:fs';
import path from 'node:path';

const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8
const DEFAULT_WINDOWS = [['09:00', '12:00'], ['14:00', '18:00']];
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5]; // 1=周一 … 7=周日
const HOLIDAY_API = (year) => `https://timor.tech/api/holiday/year/${year}`;
const HOLIDAY_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 最多半天拉一次

const pad = (n) => String(n).padStart(2, '0');

/** "09:30" → 570 */
export function parseHm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 只读一次就够：把 JSON 读成对象，坏文件当作不存在。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

export class QuietHours {
  /**
   * @param {object} options
   * @param {object} [options.config] config.json 的 quietHours 段
   * @param {string} options.stateDir 状态目录（缓存节假日与覆盖状态）
   * @param {(msg: string) => void} [options.log]
   * @param {typeof fetch} [options.fetchImpl]
   */
  constructor({ config = {}, stateDir, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.stateDir = stateDir || '.';
    this.holidayFile = path.join(this.stateDir, 'holidays-cn.json');
    this.overrideFile = path.join(this.stateDir, 'quiet-override.json');
    this.holidays = new Map();   // 'YYYY-MM-DD' → { off:boolean, name:string }
    this.holidayRanges = [];     // 已经拉到过哪些年份
    this.lastHolidayFetchAt = 0;
    this.holidayFetchInFlight = null;
    this.ownerException = new Map(); // key → 到期时间戳
    this.suppressed = 0;
    this.configure(config);
    this.loadCache();
    this.loadOverride();
  }

  configure(config) {
    const raw = config && typeof config === 'object' ? config : {};
    this.enabled = raw.enabled !== false;
    const windows = Array.isArray(raw.windows) ? raw.windows : DEFAULT_WINDOWS;
    const parsed = [];
    for (const item of windows) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const start = parseHm(item[0]);
      const end = parseHm(item[1]);
      if (start == null || end == null || end <= start) continue;
      parsed.push([start, end]);
    }
    this.windows = parsed.length ? parsed.sort((a, b) => a[0] - b[0]) : DEFAULT_WINDOWS.map(([s, e]) => [parseHm(s), parseHm(e)]);
    const weekdays = Array.isArray(raw.weekdays) ? raw.weekdays.map(Number) : DEFAULT_WEEKDAYS;
    this.weekdays = new Set(weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7));
    if (!this.weekdays.size) for (const d of DEFAULT_WEEKDAYS) this.weekdays.add(d);
    this.holidaysMode = raw.holidays === 'none' ? 'none' : 'cn';
  }

  // ── 节假日缓存 ────────────────────────────────────────────────────────────
  loadCache() {
    const cached = readJson(this.holidayFile);
    if (!cached || typeof cached !== 'object') return;
    for (const [date, entry] of Object.entries(cached.days ?? {})) {
      if (entry && typeof entry === 'object') {
        this.holidays.set(date, { off: entry.off === true, name: String(entry.name ?? '') });
      }
    }
    this.holidayRanges = Array.isArray(cached.years) ? cached.years.map(Number) : [];
    this.lastHolidayFetchAt = Number(cached.fetchedAt) || 0;
  }

  saveCache() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      writeJsonAtomic(this.holidayFile, {
        fetchedAt: this.lastHolidayFetchAt,
        years: this.holidayRanges,
        days: Object.fromEntries(this.holidays),
      });
    } catch (error) {
      this.log(`[quiet] 节假日缓存写入失败：${error?.message ?? error}`);
    }
  }

  /**
   * 每天最多拉一次当年的节假日（含调休补班）。失败不抛：用缓存 / 周末规则兜底。
   * 返回是否成功更新。
   */
  async refreshHolidays(now = Date.now()) {
    if (this.holidaysMode === 'none') return false;
    const year = this.utc8Parts(now).year;
    const stale = now - this.lastHolidayFetchAt > HOLIDAY_MIN_INTERVAL_MS;
    if (!stale && this.holidayRanges.includes(year)) return false;
    if (this.holidayFetchInFlight) return this.holidayFetchInFlight;
    this.holidayFetchInFlight = (async () => {
      try {
        const response = await this.fetchImpl(HOLIDAY_API(year), { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const holiday = payload?.holiday;
        if (!holiday || typeof holiday !== 'object') throw new Error('返回格式不符合预期');
        let added = 0;
        for (const [mmdd, entry] of Object.entries(holiday)) {
          if (!entry || typeof entry !== 'object') continue;
          const date = /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date ?? '')) ? String(entry.date) : `${year}-${mmdd}`;
          this.holidays.set(date, { off: entry.holiday === true, name: String(entry.name ?? '') });
          added += 1;
        }
        this.lastHolidayFetchAt = now;
        if (!this.holidayRanges.includes(year)) this.holidayRanges.push(year);
        this.saveCache();
        this.log(`[quiet] 已更新 ${year} 年节假日日历（${added} 天，含调休补班）`);
        return true;
      } catch (error) {
        this.log(`[quiet] 拉取 ${year} 年节假日失败（继续用缓存/周末规则）：${error?.message ?? error}`);
        return false;
      } finally {
        this.holidayFetchInFlight = null;
      }
    })();
    return this.holidayFetchInFlight;
  }

  // ── 时间换算（固定 UTC+8） ────────────────────────────────────────────────
  utc8Parts(now = Date.now()) {
    const shifted = new Date(now + TZ_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth() + 1;
    const day = shifted.getUTCDate();
    const jsDow = shifted.getUTCDay(); // 0=周日
    return {
      year,
      month,
      day,
      date: `${year}-${pad(month)}-${pad(day)}`,
      isoDow: jsDow === 0 ? 7 : jsDow,
      minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
      seconds: shifted.getUTCSeconds(),
    };
  }

  /** 这一天算不算工作日（含调休补班日）。 */
  isWorkday(parts) {
    const entry = this.holidays.get(parts.date);
    if (entry) return entry.off !== true;
    return this.weekdays.has(parts.isoDow);
  }

  /** 这一天是法定假日吗（用于状态展示）。 */
  holidayName(parts) {
    const entry = this.holidays.get(parts.date);
    return entry?.off ? entry.name || '法定节假日' : '';
  }

  activeWindow(parts) {
    for (const [start, end] of this.windows) {
      if (parts.minutes >= start && parts.minutes < end) return [start, end];
    }
    return null;
  }

  nextWindowStart(parts) {
    for (const [start] of this.windows) {
      if (parts.minutes < start) return start;
    }
    return null;
  }

  // ── 覆盖状态 ──────────────────────────────────────────────────────────────
  loadOverride() {
    const saved = readJson(this.overrideFile);
    if (!saved || typeof saved !== 'object') {
      this.override = null;
      return;
    }
    const until = Number(saved.until);
    if (!Number.isFinite(until) || until <= Date.now()) {
      this.override = null;
      return;
    }
    this.override = { kind: String(saved.kind ?? 'minutes'), until };
  }

  saveOverride() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      if (this.override) writeJsonAtomic(this.overrideFile, this.override);
      else fs.rmSync(this.overrideFile, { force: true });
    } catch (error) {
      this.log(`[quiet] 覆盖状态写入失败：${error?.message ?? error}`);
    }
  }

  /**
   * 设置临时覆盖。
   * @param {'minutes'|'window'|'day'} kind
   * @param {number} [minutes] kind=minutes 时的时长（默认 15）
   */
  setOverride(kind, minutes = 15, now = Date.now()) {
    const parts = this.utc8Parts(now);
    let until;
    if (kind === 'window') {
      const active = this.activeWindow(parts);
      const endMinutes = active ? active[1] : (this.nextWindowStart(parts) ?? parts.minutes + 60);
      until = now + Math.max(60 * 1000, (endMinutes - parts.minutes) * 60 * 1000);
    } else if (kind === 'day') {
      const endOfDay = new Date(now + TZ_OFFSET_MS);
      endOfDay.setUTCHours(23, 59, 59, 999);
      until = endOfDay.getTime() - TZ_OFFSET_MS;
    } else {
      const span = Math.min(240, Math.max(1, Number(minutes) || 15));
      until = now + span * 60 * 1000;
    }
    this.override = { kind, until };
    this.saveOverride();
    this.log(`[quiet] 临时覆盖：${kind}，到 ${new Date(until).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    return this.override;
  }

  clearOverride() {
    const had = Boolean(this.override);
    this.override = null;
    this.saveOverride();
    if (had) this.log('[quiet] 临时覆盖已取消');
    return had;
  }

  /** 只读判断，不在这里清状态：状态由 ticker 调 pruneExpired 统一回收。 */
  activeOverride(now = Date.now()) {
    if (!this.override) return null;
    if (this.override.until <= now) return null;
    return this.override;
  }

  /** 清掉已过期的覆盖（返回是否清掉了）。 */
  pruneExpired(now = Date.now()) {
    if (!this.override) return false;
    if (this.override.until > now) return false;
    this.override = null;
    this.saveOverride();
    return true;
  }

  /**
   * 当前状态：
   *   normal   —— 正常，全部行为放开；
   *   override —— 临时覆盖：任何人 @ 都回，但不主动、不等待；
   *   quiet    —— 静默：只有管理员 @ / 引用才回，回完即停。
   */
  state(now = Date.now()) {
    const override = this.activeOverride(now);
    if (override) {
      return { state: 'override', override, enabled: this.enabled, parts: this.utc8Parts(now) };
    }
    if (!this.enabled) return { state: 'normal', enabled: this.enabled, parts: this.utc8Parts(now) };
    const parts = this.utc8Parts(now);
    if (!this.isWorkday(parts)) return { state: 'normal', reason: 'holiday', parts, enabled: this.enabled };
    const window = this.activeWindow(parts);
    if (!window) return { state: 'normal', parts, enabled: this.enabled };
    const until = now + (window[1] - parts.minutes) * 60 * 1000 - parts.seconds * 1000;
    return { state: 'quiet', reason: 'window', window, until, parts, enabled: this.enabled };
  }

  isQuiet(now = Date.now()) {
    return this.state(now).state === 'quiet';
  }

  /** 静默期或覆盖期：都不许主动发起。 */
  blocksProactive(now = Date.now()) {
    return this.state(now).state !== 'normal';
  }

  /**
   * 这条入站消息能不能投递给 agent。
   * @param {{isOwner:boolean, mentioned:boolean, now?:number}} input
   */
  allowsInbound({ isOwner, mentioned, now = Date.now() }) {
    const current = this.state(now).state;
    if (current === 'normal') return true;
    if (current === 'override') return mentioned === true;
    return isOwner === true && mentioned === true;
  }

  /** 静默例外回合：标记这个会话正在跑「回完即停」的一次性回合。 */
  markOwnerException(key, ttlMs = 180000, now = Date.now()) {
    if (!key) return;
    this.ownerException.set(String(key), now + ttlMs);
  }

  isOwnerException(key, now = Date.now()) {
    const until = this.ownerException.get(String(key));
    if (!until) return false;
    if (until <= now) {
      this.ownerException.delete(String(key));
      return false;
    }
    return true;
  }

  clearOwnerException(key) {
    this.ownerException.delete(String(key));
  }

  noteSuppressed(count = 1) {
    this.suppressed += count;
  }

  /** 给控制台/日志用的一份快照。 */
  status(now = Date.now()) {
    const current = this.state(now);
    const parts = current.parts ?? this.utc8Parts(now);
    const window = current.window ?? null;
    return {
      state: current.state,
      enabled: this.enabled,
      reason: current.reason ?? null,
      window: window ? window.map((m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`).join('-') : null,
      until: current.until ?? current.override?.until ?? null,
      override: this.activeOverride(now),
      workday: this.isWorkday(parts),
      holiday: this.holidayName(parts),
      date: parts.date,
      localTime: `${pad(Math.floor(parts.minutes / 60))}:${pad(parts.minutes % 60)}`,
      windows: this.windows.map(([s, e]) => [`${pad(Math.floor(s / 60))}:${pad(s % 60)}`, `${pad(Math.floor(e / 60))}:${pad(e % 60)}`]),
      weekdays: [...this.weekdays],
      holidays: this.holidaysMode,
      suppressed: this.suppressed,
      holidaysLoaded: this.holidayRanges.slice().sort(),
    };
  }
}
