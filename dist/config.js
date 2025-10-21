import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
function loadJson(path) {
    try {
        if (!existsSync(path))
            return undefined;
        const raw = readFileSync(path, { encoding: "utf8" });
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function loadSecrets(paths) {
    const out = {};
    for (const p of paths) {
        try {
            if (!existsSync(p))
                continue;
            const raw = readFileSync(p, { encoding: "utf8" });
            const lines = raw.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#"))
                    continue;
                const idx = trimmed.indexOf("=");
                if (idx <= 0)
                    continue;
                const key = trimmed.slice(0, idx).trim();
                const val = trimmed.slice(idx + 1).trim();
                if (key)
                    out[key] = val;
            }
        }
        catch {
            // ignore
        }
    }
    return out;
}
export function loadSamplerConfig() {
    // Try config.local.json, then config.json in current working directory
    const cwd = process.cwd();
    const local = join(cwd, "config.local.json");
    const base = join(cwd, "config.json");
    const secretsLocal = join(cwd, "secrets.local.txt");
    const secrets = join(cwd, "secrets.txt");
    const merged = {};
    const a = loadJson(base);
    const b = loadJson(local);
    const s = loadSecrets([secrets, secretsLocal]);
    const src = { ...(a || {}), ...(b || {}) };
    if (src.sampling)
        Object.assign(merged, src.sampling);
    // Fallback to env if missing
    if (!merged.provider) {
        if (process.env.CEREBRAS_API_KEY || s.CEREBRAS_API_KEY)
            merged.provider = "cerebras";
        else if (process.env.OPENAI_API_KEY || s.OPENAI_API_KEY)
            merged.provider = "openai";
        else
            merged.provider = "mcp";
    }
    // Secrets.txt → merged
    if (!merged.cerebrasApiKey && (s.CEREBRAS_API_KEY))
        merged.cerebrasApiKey = s.CEREBRAS_API_KEY;
    if (!merged.cerebrasModel && (s.CEREBRAS_MODEL))
        merged.cerebrasModel = s.CEREBRAS_MODEL;
    if (!merged.cerebrasBaseUrl && (s.CEREBRAS_BASE_URL))
        merged.cerebrasBaseUrl = s.CEREBRAS_BASE_URL;
    if (!merged.openaiApiKey && process.env.OPENAI_API_KEY)
        merged.openaiApiKey = process.env.OPENAI_API_KEY;
    if (!merged.openaiModel && process.env.OPENAI_MODEL)
        merged.openaiModel = process.env.OPENAI_MODEL;
    if (!merged.openaiBaseUrl && process.env.OPENAI_BASE_URL)
        merged.openaiBaseUrl = process.env.OPENAI_BASE_URL;
    if (!merged.cerebrasApiKey && process.env.CEREBRAS_API_KEY)
        merged.cerebrasApiKey = process.env.CEREBRAS_API_KEY;
    if (!merged.cerebrasModel && process.env.CEREBRAS_MODEL)
        merged.cerebrasModel = process.env.CEREBRAS_MODEL;
    if (!merged.cerebrasBaseUrl && process.env.CEREBRAS_BASE_URL)
        merged.cerebrasBaseUrl = process.env.CEREBRAS_BASE_URL;
    return merged;
}
