import { memo, useEffect, useMemo, useState } from "react";
import {
  api,
  withToken,
  type ApiSettingsResponse,
  type Asset,
  type ExportPresetInfo,
  type MarketplacePackInfo,
  type Project,
} from "./api";

// ---------- CapCut-Clean API Key, Base URL & Model Configuration Modal ----------

export const ApiSettingsModal = memo(function ApiSettingsModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ApiSettingsResponse | null;
  onClose: () => void;
  onSaved: (next: ApiSettingsResponse, msg: string) => void;
}) {
  const [preset, setPreset] = useState(initial?.providerPreset ?? "openai");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "gpt-4.1-mini");
  const [visionModel, setVisionModel] = useState(initial?.visionModel ?? "gpt-4.1-mini");
  const [falKey, setFalKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [replicateKey, setReplicateKey] = useState("");
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!initial) {
      api
        .getApiSettings()
        .then((cfg) => {
          setPreset(cfg.providerPreset);
          setBaseUrl(cfg.baseUrl);
          setModel(cfg.model);
          setVisionModel(cfg.visionModel);
        })
        .catch(() => undefined);
    }
  }, [initial]);

  const activePresetObj = useMemo(
    () => (initial?.presets ?? []).find((p) => p.id === preset),
    [initial, preset],
  );

  const allCandidateModels = useMemo(() => {
    const merged = Array.from(
      new Set([model, ...(remoteModels.length ? remoteModels : activePresetObj?.suggestedModels ?? [])].filter(Boolean)),
    );
    const q = modelFilter.trim().toLowerCase();
    return q ? merged.filter((m) => m.toLowerCase().includes(q)) : merged;
  }, [model, remoteModels, activePresetObj, modelFilter]);

  const handlePresetChange = (nextId: string) => {
    setPreset(nextId);
    const found = (initial?.presets ?? []).find((p) => p.id === nextId);
    if (found) {
      if (nextId !== "custom") setBaseUrl(found.baseUrl);
      if (found.suggestedModels[0]) {
        setModel(found.suggestedModels[0]);
        setVisionModel(found.suggestedModels[0]);
      }
      setRemoteModels([]);
    }
  };

  const handleFetchModels = async () => {
    setLoadingModels(true);
    setStatusMsg(null);
    try {
      const res = await api.fetchApiModels({
        baseUrl,
        apiKey: apiKey.trim() || undefined,
      });
      setRemoteModels(res.models);
      if (res.models.length > 0 && !res.models.includes(model)) {
        setModel(res.models[0]!);
      }
      setStatusMsg({
        ok: true,
        text: `Loaded ${res.models.length} live model(s) from ${res.baseUrl}/models`,
      });
    } catch (err) {
      setStatusMsg({
        ok: false,
        text: `Could not list /models (${(err as Error).message}) — you can still type any model ID directly below.`,
      });
    } finally {
      setLoadingModels(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setStatusMsg(null);
    try {
      const res = await api.testApiSettings({
        baseUrl,
        apiKey: apiKey.trim() || undefined,
        model,
      });
      setStatusMsg({
        ok: true,
        text: `✓ Connected in ${res.latencyMs}ms (${res.model}): "${res.reply}"`,
      });
    } catch (err) {
      setStatusMsg({
        ok: false,
        text: `Connection failed: ${(err as Error).message}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const providerKeys: Record<string, string> = {};
      if (falKey.trim()) providerKeys.FAL_KEY = falKey.trim();
      if (googleKey.trim()) providerKeys.GOOGLE_API_KEY = googleKey.trim();
      if (replicateKey.trim()) providerKeys.REPLICATE_API_TOKEN = replicateKey.trim();

      const saved = await api.saveApiSettings({
        providerPreset: preset,
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        model,
        visionModel,
        ...(Object.keys(providerKeys).length ? { providerKeys } : {}),
      });
      onSaved(saved, `API saved • ${saved.model} @ ${saved.baseUrl}`);
      onClose();
    } catch (err) {
      setStatusMsg({ ok: false, text: `Save error: ${(err as Error).message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 style={{ margin: 0, fontSize: 16, color: "var(--text)", letterSpacing: 0 }}>
              ⚙ API Key, Base URL &amp; Model Settings
            </h2>
            <div className="muted" style={{ marginTop: 2 }}>
              Connect OpenAI, OpenRouter, DeepSeek, NVIDIA NIM, Groq, Ollama/LM Studio, or any custom OpenAI-compatible API
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="form-grid-2">
            <label>
              <span>Provider Preset</span>
              <select value={preset} onChange={(e) => handlePresetChange(e.target.value)}>
                {(initial?.presets ?? [
                  { id: "openai", label: "OpenAI Official" },
                  { id: "openrouter", label: "OpenRouter (All Cloud Models)" },
                  { id: "deepseek", label: "DeepSeek API" },
                  { id: "nvidia", label: "NVIDIA NIM API" },
                  { id: "groq", label: "Groq Ultra-Fast LPU" },
                  { id: "ollama", label: "Ollama (Local PC — No Key Needed)" },
                  { id: "lmstudio", label: "LM Studio (Local PC Server)" },
                  { id: "custom", label: "Custom OpenAI-Compatible URL" },
                ]).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Base URL (OpenAI-Compatible `/v1`)</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </label>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 10 }}>
            <span style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}>
              <span>API Key (stored encrypted/locally on this PC)</span>
              {initial?.hasApiKey && (
                <span style={{ color: "#22c55e" }}>
                  Saved key active: {initial.maskedApiKey}
                </span>
              )}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  initial?.hasApiKey
                    ? `Keep saved key (${initial.maskedApiKey}) or paste a new sk-... key`
                    : "sk-..."
                }
                style={{ flex: 1 }}
              />
              {initial?.hasApiKey && (
                <button
                  type="button"
                  onClick={async () => {
                    const cleared = await api.saveApiSettings({ clearApiKey: true });
                    onSaved(cleared, "Cleared stored API key");
                    setStatusMsg({ ok: true, text: "Stored API key cleared." });
                  }}
                >
                  Clear Key
                </button>
              )}
              <button type="button" onClick={handleFetchModels} disabled={loadingModels}>
                {loadingModels ? "⏳ Fetching…" : "🔄 Fetch Models"}
              </button>
            </div>
          </label>

          {/* Searchable Model Picker + Direct Custom Model Input */}
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                Active AI Model ({allCandidateModels.length} shown — click to select or type any custom model ID)
              </span>
              <input
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                placeholder="🔍 Filter models…"
                style={{ width: 175, padding: "4px 8px", fontSize: 11.5 }}
              />
            </div>

            <div className="form-grid-2">
              <label>
                <span>Selected Model ID (Editable)</span>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gpt-4.1-mini, deepseek-chat, anthropic/claude-sonnet-4"
                />
              </label>

              <label>
                <span>Quick Pick from Fetched / Preset Models</span>
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {allCandidateModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {allCandidateModels.length > 0 && (
              <div className="chip-cloud" style={{ marginTop: 8 }}>
                {allCandidateModels.slice(0, 14).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`chip ${model === m ? "chip-active" : ""}`}
                    onClick={() => setModel(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          <details style={{ marginTop: 12 }}>
            <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
              🎬 Optional Cloud Video/Audio Generation Keys (fal.ai, Google Veo, Replicate)
            </summary>
            <div className="form-grid-2" style={{ marginTop: 8 }}>
              <label>
                <span>FAL_KEY (Veo 3.1 / Kling 3 / Flux / Wan)</span>
                <input
                  type="password"
                  value={falKey}
                  onChange={(e) => setFalKey(e.target.value)}
                  placeholder={initial?.configuredProviderKeys.includes("FAL_KEY") ? "✓ Configured" : "fal_..."}
                />
              </label>
              <label>
                <span>GOOGLE_API_KEY (Gemini &amp; Veo)</span>
                <input
                  type="password"
                  value={googleKey}
                  onChange={(e) => setGoogleKey(e.target.value)}
                  placeholder={initial?.configuredProviderKeys.includes("GOOGLE_API_KEY") ? "✓ Configured" : "AIza..."}
                />
              </label>
              <label>
                <span>REPLICATE_API_TOKEN</span>
                <input
                  type="password"
                  value={replicateKey}
                  onChange={(e) => setReplicateKey(e.target.value)}
                  placeholder={
                    initial?.configuredProviderKeys.includes("REPLICATE_API_TOKEN") ? "✓ Configured" : "r8_..."
                  }
                />
              </label>
              <label>
                <span>Vision / Frame Analysis Model</span>
                <input value={visionModel} onChange={(e) => setVisionModel(e.target.value)} placeholder="gpt-4.1-mini" />
              </label>
            </div>
          </details>

          {statusMsg && (
            <div
              style={{
                marginTop: 12,
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 12,
                background: statusMsg.ok ? "rgba(34, 197, 94, 0.14)" : "rgba(239, 68, 68, 0.14)",
                border: `1px solid ${statusMsg.ok ? "#22c55e" : "#ef4444"}`,
                color: statusMsg.ok ? "#86efac" : "#fca5a5",
              }}
            >
              {statusMsg.text}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" onClick={handleTest} disabled={testing || saving}>
            {testing ? "⏳ Testing…" : "⚡ Test Connection"}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn-accent" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "💾 Save API & Model"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

// ---------- CapCut Export & Render Drawer Modal ----------

export const ExportModal = memo(function ExportModal({
  project,
  exportPresets,
  exportPresetId,
  setExportPresetId,
  hwAccel,
  setHwAccel,
  loudnessLufs,
  setLoudnessLufs,
  busy,
  onExport,
  onBatchExport,
  onThumbnail,
  onClose,
}: {
  project: Project;
  exportPresets: ExportPresetInfo[];
  exportPresetId: string;
  setExportPresetId: (id: string) => void;
  hwAccel: string;
  setHwAccel: (hw: string) => void;
  loudnessLufs: string;
  setLoudnessLufs: (lufs: string) => void;
  busy: boolean;
  onExport: () => void;
  onBatchExport: () => void;
  onThumbnail: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 540 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 style={{ margin: 0, fontSize: 16, color: "var(--text)" }}>📤 Export Video &amp; Delivery</h2>
            <div className="muted">Hardware-accelerated FFmpeg render, multi-platform batch &amp; NLE interchange</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="form-grid-2">
            <label>
              <span>Format / Platform Preset</span>
              <select value={exportPresetId} onChange={(e) => setExportPresetId(e.target.value)}>
                {exportPresets.map((ep) => (
                  <option key={ep.id} value={ep.id}>
                    {ep.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>GPU / Hardware Encoder</span>
              <select value={hwAccel} onChange={(e) => setHwAccel(e.target.value)}>
                <option value="auto">⚡ Auto Detect GPU / CPU</option>
                <option value="nvenc">NVIDIA NVENC</option>
                <option value="amf">AMD AMF</option>
                <option value="qsv">Intel QuickSync</option>
                <option value="cpu">CPU Software x264/x265</option>
              </select>
            </label>

            <label>
              <span>Audio Loudness Master</span>
              <select value={loudnessLufs} onChange={(e) => setLoudnessLufs(e.target.value)}>
                <option value="-14">-14 LUFS (YouTube / TikTok / Spotify)</option>
                <option value="-16">-16 LUFS (Podcast / Voice)</option>
                <option value="-23">-23 LUFS (Broadcast EBU R128)</option>
                <option value="off">Original Levels (Off)</option>
              </select>
            </label>

            <label>
              <span>Pro NLE Interchange</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  style={{ flex: 1 }}
                  onClick={() => window.open(withToken(`/api/v1/projects/${project.id}/export/edl`), "_blank")}
                >
                  🎞 CMX3600 .EDL
                </button>
                <button
                  type="button"
                  style={{ flex: 1 }}
                  onClick={() => window.open(withToken(`/api/v1/projects/${project.id}/export/fcpxml`), "_blank")}
                >
                  🎬 Resolve .XML
                </button>
              </div>
            </label>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <button type="button" className="btn-accent" style={{ flex: 1 }} disabled={busy} onClick={onExport}>
              🚀 Export Video Now
            </button>
            <button type="button" disabled={busy} onClick={onBatchExport} title="YouTube 16:9 + TikTok 9:16 + WebM">
              📦 Multi-Platform Batch
            </button>
            <button type="button" disabled={busy} onClick={onThumbnail}>
              🖼 Best Thumbnail
            </button>
          </div>

          {project.jobs.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="muted" style={{ marginBottom: 6, fontWeight: 600 }}>
                Recent Render &amp; AI Jobs ({project.jobs.length})
              </div>
              <ul className="job-list" style={{ maxHeight: 190, overflow: "auto" }}>
                {[...project.jobs].reverse().slice(0, 8).map((job) => (
                  <li key={job.id} className={`job job-${job.status}`}>
                    <div className="job-row">
                      <span className="job-type">{job.type}</span>
                      <span className="muted">
                        {job.status} • {Math.round(job.progress)}%
                      </span>
                    </div>
                    <div className="job-bar">
                      <div className="job-fill" style={{ width: `${job.progress}%` }} />
                    </div>
                    {job.status === "done" && job.type === "render" && (
                      <a className="job-dl" href={withToken(`/api/v1/jobs/${job.id}/output`)} target="_blank" rel="noreferrer">
                        ⬇ Download Rendered Video
                      </a>
                    )}
                    {job.error && <div style={{ color: "#f87171", marginTop: 4 }}>{job.error}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// ---------- CapCut Searchable Effects, LUTs, Transitions & Quick-Actions Browser ----------

export interface CatalogItem {
  id: string;
  section: "effects" | "transitions" | "text" | "audio" | "ai";
  badge: string;
  title: string;
  subtitle: string;
  gradient: string;
  run: () => void;
}

export const CapCutCatalogBrowser = memo(function CapCutCatalogBrowser({
  title,
  query,
  items,
  matchingAssets,
  matchingPacks,
  onQuickAddAsset,
  onApplyTemplate,
}: {
  title: string;
  query: string;
  items: CatalogItem[];
  matchingAssets: Asset[];
  matchingPacks: MarketplacePackInfo[];
  onQuickAddAsset: (a: Asset) => void;
  onApplyTemplate: (id: string) => void;
}) {
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return items;
    return items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        it.subtitle.toLowerCase().includes(q) ||
        it.badge.toLowerCase().includes(q) ||
        it.section.toLowerCase().includes(q),
    );
  }, [items, q]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="muted">{filtered.length} presets</span>
      </div>

      {q && matchingAssets.length > 0 && (
        <div>
          <div className="muted" style={{ marginBottom: 5 }}>
            Matching Media ({matchingAssets.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {matchingAssets.map((a) => (
              <div key={a.id} className="asset">
                <span className={`badge badge-${a.kind}`}>{a.kind}</span>
                <span className="asset-name">{a.name}</span>
                <button type="button" className="btn-accent" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => onQuickAddAsset(a)}>
                  + Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="capcut-card-grid">
        {filtered.map((item) => (
          <button
            key={item.id}
            type="button"
            className="capcut-card"
            onClick={item.run}
            title={`${item.title} — ${item.subtitle}`}
          >
            <div className="capcut-card-thumb" style={{ background: item.gradient }}>
              <span className="capcut-card-badge">{item.badge}</span>
              <span className="capcut-card-plus">+</span>
            </div>
            <div className="capcut-card-title">{item.title}</div>
            <div className="capcut-card-sub">{item.subtitle}</div>
          </button>
        ))}
      </div>

      {q && matchingPacks.length > 0 && (
        <div>
          <div className="muted" style={{ marginBottom: 5 }}>
            Matching Templates &amp; Plugins ({matchingPacks.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {matchingPacks.map((pk) => (
              <div key={pk.id} className="asset">
                <span className="asset-name">{pk.name}</span>
                <button type="button" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => onApplyTemplate(pk.id)}>
                  Apply
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 && matchingAssets.length === 0 && matchingPacks.length === 0 && (
        <div className="preview-empty" style={{ padding: "24px 8px", textAlign: "center" }}>
          No matching items for &ldquo;{query}&rdquo;
        </div>
      )}
    </div>
  );
});
