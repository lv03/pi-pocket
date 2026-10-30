/** Numbers, money, and times as the dashboard shows them. */

export function fmt(value) {
    const number = Number(value ?? 0);

    if (!Number.isFinite(number)) {
        return "0";
    }

    const sign = number < 0 ? "−" : "";
    const size = Math.abs(number);

    if (size >= 1_000_000) {
        return `${sign}${(size / 1_000_000).toFixed(size >= 10_000_000 ? 0 : 1)}M`;
    }

    if (size >= 10_000) {
        return `${sign}${Math.round(size / 1000)}k`;
    }

    if (size >= 1000) {
        return `${sign}${(size / 1000).toFixed(1)}k`;
    }

    return `${sign}${Math.round(size)}`;
}

export function money(value) {
    const amount = Number(value ?? 0);

    if (!Number.isFinite(amount) || amount <= 0) {
        return "$0";
    }

    if (amount < 0.01) {
        return "<$0.01";
    }

    return `$${amount.toFixed(amount >= 10 ? 0 : 2)}`;
}

export function pct(value) {
    const number = Number(value ?? 0);

    if (!Number.isFinite(number)) {
        return "0%";
    }

    return `${number < 1 ? Math.round(number * 10) / 10 : Math.round(number)}%`;
}

/** A time of day for today, a short date before that. */
export function timeOf(at) {
    if (typeof at !== "number" || !Number.isFinite(at)) {
        return "";
    }

    const date = new Date(at);
    const now = new Date();
    const sameDay =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();

    if (sameDay) {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The share of a request's prompt that the provider served from its cache. */
export function cacheRate(prompt, cacheRead) {
    if (!(prompt > 0)) {
        return null;
    }

    const rate = Math.round((cacheRead / prompt) * 100);

    return rate >= 0 && rate <= 100 ? rate : null;
}

/** A local calendar day, `YYYY-MM-DD`. */
export function dayOf(at) {
    const date = new Date(at);

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate(),
    ).padStart(2, "0")}`;
}
