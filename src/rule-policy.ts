import type { AutomationRuleRow } from "./db";

export type RuleOperationalState = "scheduled" | "active" | "paused" | "ended" | "problem";
export type SourceMode = "all" | "niche" | "mix" | "list";
export type NicheMixEntry = { niche: string; weight: number };

export const NICHE_OPTIONS = [
  { id: "casa_cozinha", label: "Casa e cozinha", query: "casa cozinha" },
  { id: "eletronicos", label: "Eletrônicos", query: "eletronicos celular acessorios" },
  { id: "beleza", label: "Beleza e cuidados", query: "beleza cuidados pessoais" },
  { id: "moda_feminina", label: "Moda feminina", query: "moda feminina" },
  { id: "moda_masculina", label: "Moda masculina", query: "moda masculina" },
  { id: "pet", label: "Pet", query: "produto pet" },
  { id: "infantil", label: "Infantil e bebê", query: "infantil bebe" },
  { id: "esporte", label: "Esporte e fitness", query: "esporte fitness academia" },
  { id: "automotivo", label: "Automotivo", query: "automotivo carro moto" },
  { id: "ferramentas", label: "Ferramentas", query: "ferramentas construcao" },
] as const;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function intervalMinutes(settings: Record<string, unknown>) {
  const value = Number(settings.intervalMinutes);
  return Number.isInteger(value) && value >= 5 && value <= 1440 && value % 5 === 0 ? value : 60;
}

export function clockMinutes(value: unknown, fallback: string) {
  const raw = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback;
  const [hour, minute] = raw.split(":").map(Number);
  return hour * 60 + minute;
}

export function localDateParts(date: Date, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: weekdayMap[parts.weekday] ?? 0,
  };
}

function weekdays(settings: Record<string, unknown>) {
  const raw = Array.isArray(settings.activeWeekdays) ? settings.activeWeekdays.map(Number).filter((v) => Number.isInteger(v) && v >= 0 && v <= 6) : [];
  return raw.length ? Array.from(new Set(raw)) : [0, 1, 2, 3, 4, 5, 6];
}

export function sourceMode(settings: Record<string, unknown>): SourceMode {
  const value = String(settings.sourceMode || "all");
  return ["all", "niche", "mix", "list"].includes(value) ? value as SourceMode : "all";
}

export function nicheQuery(niche: unknown) {
  const id = text(niche);
  const found = NICHE_OPTIONS.find((item) => item.id === id || item.label.toLowerCase() === id.toLowerCase());
  return found?.query || id;
}

export function nicheLabel(niche: unknown) {
  const id = text(niche);
  const found = NICHE_OPTIONS.find((item) => item.id === id || item.label.toLowerCase() === id.toLowerCase());
  return found?.label || id || "Todos os nichos";
}

export function normalizeMix(settings: Record<string, unknown>) {
  const raw = Array.isArray(settings.nicheMix) ? settings.nicheMix : [];
  const entries: NicheMixEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const niche = text((item as Record<string, unknown>).niche);
    const weight = Math.max(1, Math.min(100, Math.round(Number((item as Record<string, unknown>).weight) || 0)));
    if (niche && !entries.some((entry) => entry.niche === niche)) entries.push({ niche, weight });
  }
  return entries.slice(0, 10);
}

function smoothWeightedSequence(entries: NicheMixEntry[]) {
  if (!entries.length) return [] as string[];
  const total = entries.reduce((sum, item) => sum + item.weight, 0);
  const current = new Array(entries.length).fill(0);
  const sequence: string[] = [];
  const length = Math.min(100, total);
  for (let step = 0; step < length; step += 1) {
    let best = 0;
    for (let i = 0; i < entries.length; i += 1) {
      current[i] += entries[i].weight;
      if (current[i] > current[best]) best = i;
    }
    sequence.push(entries[best].niche);
    current[best] -= total;
  }
  return sequence;
}

export function chooseMixNiche(settings: Record<string, unknown>, slot: Date, timezone: string) {
  const entries = normalizeMix(settings);
  if (!entries.length) return null;
  const sequence = smoothWeightedSequence(entries);
  if (!sequence.length) return entries[0].niche;
  const local = localDateParts(slot, timezone);
  const start = clockMinutes(settings.windowStart, "09:00");
  const interval = intervalMinutes(settings);
  const index = Math.max(0, Math.floor(Math.max(0, local.minutes - start) / interval));
  return sequence[index % sequence.length];
}

export function mixFallbackOrder(settings: Record<string, unknown>, preferred: string | null) {
  const entries = normalizeMix(settings);
  if (!entries.length) return [] as string[];
  const sorted = [...entries].sort((a, b) => b.weight - a.weight).map((entry) => entry.niche);
  return preferred ? [preferred, ...sorted.filter((value) => value !== preferred)] : sorted;
}

export function commissionPlan(target: number | null | undefined, settings: Record<string, unknown>) {
  const desired = Number.isFinite(Number(target)) ? Math.max(0, Math.min(100, Number(target))) : 0;
  const enabled = Boolean(settings.flexCommissionEnabled) && desired > 0;
  const step = Math.max(1, Math.min(25, Math.round(Number(settings.flexCommissionStep) || 5)));
  const configuredFloor = Number(settings.flexCommissionFloor);
  const floor = enabled && Number.isFinite(configuredFloor)
    ? Math.max(0, Math.min(desired, configuredFloor))
    : desired;
  const thresholds: number[] = [];
  if (!desired) return { enabled: false, desired: 0, floor: 0, step, thresholds: [0] };
  for (let value = desired; value > floor; value -= step) thresholds.push(Math.max(floor, Math.round(value * 100) / 100));
  if (!thresholds.includes(floor)) thresholds.push(floor);
  return { enabled, desired, floor, step, thresholds };
}

export function rulePeriodAllows(rule: AutomationRuleRow, now: Date) {
  const settings = rule.settings || {};
  const timezone = rule.timezone || "America/Sao_Paulo";
  const local = localDateParts(now, timezone);
  const startDate = text(settings.activeStartDate);
  const endDate = text(settings.activeEndDate);
  if (startDate && local.dateKey < startDate) return false;
  if (endDate && local.dateKey > endDate) return false;
  if (!weekdays(settings).includes(local.weekday)) return false;
  return true;
}

export function ruleWindowAllows(rule: AutomationRuleRow, now: Date) {
  const settings = rule.settings || {};
  const timezone = rule.timezone || "America/Sao_Paulo";
  const local = localDateParts(now, timezone);
  const start = clockMinutes(settings.windowStart, "09:00");
  const end = clockMinutes(settings.windowEnd, "22:00");
  if (start <= end) return local.minutes >= start && local.minutes <= end;
  return local.minutes >= start || local.minutes <= end;
}

export function isSlotDue(rule: AutomationRuleRow, now: Date) {
  const settings = rule.settings || {};
  if (String(settings.scheduleMode || "") !== "slots") return false;
  if (!rule.enabled || !rulePeriodAllows(rule, now) || !ruleWindowAllows(rule, now)) return false;
  const timezone = rule.timezone || "America/Sao_Paulo";
  const local = localDateParts(now, timezone);
  const start = clockMinutes(settings.windowStart, "09:00");
  const interval = intervalMinutes(settings);
  let elapsed = local.minutes - start;
  if (elapsed < 0) elapsed += 1440;
  return elapsed % interval === 0;
}

export function operationalState(rule: AutomationRuleRow, now = new Date()): RuleOperationalState {
  const settings = rule.settings || {};
  const timezone = rule.timezone || "America/Sao_Paulo";
  const local = localDateParts(now, timezone);
  const startDate = text(settings.activeStartDate);
  const endDate = text(settings.activeEndDate);
  const startMinutes = clockMinutes(settings.windowStart, "09:00");
  const endMinutes = clockMinutes(settings.windowEnd, "22:00");
  const endedToday = Boolean(endDate && local.dateKey === endDate && startMinutes <= endMinutes && local.minutes > endMinutes);
  if (endDate && (local.dateKey > endDate || endedToday)) return "ended";
  if (startDate && local.dateKey < startDate) return rule.enabled ? "scheduled" : "paused";
  if (!rule.enabled) return "paused";
  return "active";
}

export function dailyCapacity(settings: Record<string, unknown>) {
  const start = clockMinutes(settings.windowStart, "09:00");
  const end = clockMinutes(settings.windowEnd, "22:00");
  const interval = intervalMinutes(settings);
  const span = start <= end ? end - start : (1440 - start) + end;
  return Math.floor(span / interval) + 1;
}
